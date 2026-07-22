// AEO/SEO site review (free-with-login, one site per wallet — see /aeo/* routes in index.ts).
//
// Two-stage design: (1) crawl the site OURSELVES and extract the objective signals
// deterministically (does a canonical exist, is GPTBot blocked, how many images lack alt…) —
// LLMs are unreliable at "did this tag exist"; (2) hand those FACTS to one OpenRouter call that
// does the judgment: scores, findings, prioritized recommendations, returned as strict JSON via
// structured outputs. The OpenRouter key stays server-side, same as the Helius key (/solana/rpc).
//
// The crawler fetches arbitrary user-supplied URLs, so every hop is SSRF-guarded: http(s) only,
// hostname must resolve to a public IP, redirects re-validated per hop, per-page byte cap, and
// a hard wall-clock budget for the whole crawl.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ---- crawl limits ----------------------------------------------------------------------------
// Sized so a typical small/mid site (≤ ~100 pages) gets a FULL crawl; pages are fetched
// CONCURRENTLY so even the cap fits well inside the budget. Bigger sites get sampled and the
// report says so. Both knobs are env-tunable without a deploy.
const MAX_PAGES = Math.max(1, Number(process.env.AEO_MAX_PAGES ?? 100));
const PAGE_BYTE_CAP = 1_500_000;   // per-page HTML cap — enough for any real page's <head>+body
const FETCH_TIMEOUT_MS = 12_000;   // per-request
const CRAWL_BUDGET_MS = Math.max(30_000, Number(process.env.AEO_CRAWL_BUDGET_MS ?? 180_000));
const CRAWL_CONCURRENCY = 6;       // parallel page fetches (polite but fast: ~60 pages in ~20s)
const MAX_REDIRECTS = 5;

export interface PageSignals {
  url: string;
  status: number;
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  canonical: string | null;
  metaRobots: string | null;
  lang: string | null;
  hasViewport: boolean;
  ogTags: string[];               // og:* property names present
  twitterTags: string[];          // twitter:* names present
  h1Count: number;
  h1Text: string[];
  headingOutline: string[];       // e.g. ["h1: Pricing", "h2: Plans", …] (capped)
  questionHeadings: number;       // headings phrased as questions — answer-engine gold
  jsonLdTypes: string[];          // schema.org @type values found in ld+json blocks
  imgCount: number;
  imgMissingAlt: number;
  internalLinks: number;
  externalLinks: number;
  wordCount: number;              // visible-text words (scripts/styles stripped)
  hreflangCount: number;
  hasFaqMarkup: boolean;          // FAQPage/Question schema or <details> Q&A pattern
  /** Site-side local-SEO signals — what Google Maps / Business Profile ranking feeds on. */
  local: {
    mapsLink: boolean;            // link or <iframe> embed pointing at Google Maps
    telLinks: number;             // tel: links (click-to-call — a NAP signal)
    addressInSchema: boolean;     // "address" anywhere in this page's JSON-LD
    geoInSchema: boolean;         // "geo" coordinates in JSON-LD
    openingHoursInSchema: boolean;
    telephoneInSchema: boolean;
  };
  fetchedAtMs: number;
}

/** Outcome of the Google Maps / Business Profile lookup (Places API). `checked` false means we
 *  could not ask Google (no key, or the API errored) — distinct from "asked and found nothing". */
export interface PlacesResult {
  checked: boolean;
  query?: string;
  found: boolean;
  /** Matching is strict: a candidate counts only if its listed website is the audited domain. */
  name?: string;
  rating?: number;
  reviews?: number;
  address?: string;
  businessStatus?: string;
  mapsUrl?: string;
  /** Listings with a similar name that do NOT link the audited domain (0 = none at all). */
  nearMisses?: number;
  error?: string;
}

export interface SiteSignals {
  inputUrl: string;
  finalUrl: string;               // after redirects (www/https normalization)
  host: string;
  https: boolean;
  /** Business/site name as the site presents it (og:site_name → schema.org → <title>). */
  siteName: string | null;
  /** Google Maps listing lookup — filled in by the caller when a Places API key is configured. */
  googlePlaces: PlacesResult;
  robotsTxt: {
    found: boolean;
    sitemapUrls: string[];
    blocksAllBots: boolean;
    aiCrawlers: Record<string, "allowed" | "blocked" | "unspecified">;
  };
  sitemap: { found: boolean; urlCount: number };
  llmsTxt: { found: boolean; bytes: number };
  pages: PageSignals[];
  crawl: { pagesFetched: number; errors: string[]; truncated: boolean; ms: number };
}

// AI/answer-engine crawlers whose robots.txt treatment we report on. Blocking these is the #1
// self-inflicted AEO wound; surfacing each by name makes the finding actionable.
const AI_CRAWLERS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-Web", "anthropic-ai",
  "PerplexityBot", "Google-Extended", "CCBot", "Bytespider", "Amazonbot", "meta-externalagent",
];

// ---- SSRF guard -------------------------------------------------------------------------------

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const low = ip.toLowerCase();
    return low === "::1" || low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")
      || low.startsWith("::ffff:") && isPrivateIp(low.slice(7));
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // unparseable → refuse
  return p[0] === 10 || p[0] === 127 || p[0] === 0
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168)
    || (p[0] === 169 && p[1] === 254)          // link-local / cloud metadata
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127); // CGNAT
}

/** Throws unless the URL is http(s) on a default-ish port and its host resolves to a public IP. */
async function assertPublicUrl(u: URL): Promise<void> {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are supported");
  if (u.username || u.password) throw new Error("URLs with credentials are not supported");
  const host = u.hostname;
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error("that address is not reachable from here");
    return;
  }
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("that address is not reachable from here");
  }
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`could not resolve ${host}`);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("that address is not reachable from here");
}

/** Fetch with per-hop SSRF validation, manual redirects, timeout, and a byte cap. */
async function safeFetch(url: string, opts?: { maxBytes?: number }): Promise<{ status: number; finalUrl: string; text: string; contentType: string }> {
  const maxBytes = opts?.maxBytes ?? PAGE_BYTE_CAP;
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let r: Response;
    try {
      r = await fetch(current, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "user-agent": "KoretexReviewBot/1.0 (+https://koretex.ai; SEO/AEO site review)",
          "accept": "text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.5",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return { status: r.status, finalUrl: current.href, text: "", contentType: "" };
      r.body?.cancel().catch(() => {});
      current = new URL(loc, current);
      continue;
    }
    // Stream with a byte cap so a giant page can't balloon memory.
    let text = "";
    if (r.body) {
      const reader = r.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (bytes >= maxBytes) { reader.cancel().catch(() => {}); break; }
      }
    }
    return { status: r.status, finalUrl: current.href, text, contentType: r.headers.get("content-type") ?? "" };
  }
  throw new Error("too many redirects");
}

// ---- HTML signal extraction (regex-based on purpose: zero deps, and we only need <head> facts
// and coarse body stats — not a DOM) -----------------------------------------------------------

const strip = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : null;
}

function metaContent(html: string, key: "name" | "property", value: string): string | null {
  const re = new RegExp(`<meta\\b[^>]*\\b${key}\\s*=\\s*["']?${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?[^>]*>`, "i");
  const m = html.match(re);
  return m ? attr(m[0], "content") : null;
}

export function extractPageSignals(url: string, status: number, html: string): PageSignals {
  const head = html.slice(0, 300_000); // meta lives early; don't regex-scan megabytes for it
  const titleM = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decode(strip(titleM[1])) || null : null;
  const metaDescription = metaContent(head, "name", "description");
  const canonicalM = head.match(/<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/i);
  const canonical = canonicalM ? attr(canonicalM[0], "href") : null;
  const metaRobots = metaContent(head, "name", "robots");
  const langM = html.match(/<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]+)/);
  const ogTags = [...head.matchAll(/<meta\b[^>]*\bproperty\s*=\s*["']?(og:[\w:.-]+)/gi)].map((m) => m[1].toLowerCase());
  const twitterTags = [...head.matchAll(/<meta\b[^>]*\bname\s*=\s*["']?(twitter:[\w:.-]+)/gi)].map((m) => m[1].toLowerCase());
  const hreflangCount = (head.match(/<link\b[^>]*\bhreflang\s*=/gi) ?? []).length;

  const headings = [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => ({ level: Number(m[1]), text: decode(strip(m[2])).slice(0, 120) }))
    .filter((h) => h.text);
  const h1s = headings.filter((h) => h.level === 1);
  const questionHeadings = headings.filter((h) => /\?\s*$|^(how|what|why|when|where|which|who|can|does|is|are|should)\b/i.test(h.text)).length;

  const jsonLdTypes: string[] = [];
  const ldKeys = new Set<string>(); // every key seen anywhere in this page's JSON-LD (deep)
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const collect = (node: any) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(collect);
        const t = node["@type"];
        if (typeof t === "string") jsonLdTypes.push(t);
        else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && jsonLdTypes.push(x));
        for (const k of Object.keys(node)) { ldKeys.add(k.toLowerCase()); collect(node[k]); }
      };
      collect(JSON.parse(m[1].trim()));
    } catch { /* malformed ld+json is itself a (minor) finding the model can infer from absence */ }
  }

  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imgMissingAlt = imgs.filter((t) => { const a = attr(t, "alt"); return a === null || a.trim() === ""; }).length;

  let internalLinks = 0, externalLinks = 0, telLinks = 0;
  const MAPS_RE = /(?:google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl)/i;
  let mapsLink = false;
  const origin = new URL(url).origin;
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const href = m[2] ?? m[3] ?? "";
    if (href.startsWith("tel:")) { telLinks++; continue; }
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) continue;
    if (MAPS_RE.test(href)) mapsLink = true;
    try { (new URL(href, url).origin === origin ? internalLinks++ : externalLinks++); } catch {}
  }
  // An embedded map counts the same as a link out to one.
  if (!mapsLink && /<iframe\b[^>]*src\s*=\s*["'][^"']*(?:google\.[a-z.]+\/maps|maps\.google\.)/i.test(html)) mapsLink = true;

  const bodyText = strip(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " "));
  const hasFaqMarkup = jsonLdTypes.some((t) => /faqpage|question/i.test(t)) || /<details\b[^>]*>[\s\S]*?<summary\b/i.test(html);

  return {
    url, status,
    title, titleLength: title?.length ?? 0,
    metaDescription, metaDescriptionLength: metaDescription?.length ?? 0,
    canonical, metaRobots,
    lang: langM ? langM[1] : null,
    hasViewport: /<meta\b[^>]*\bname\s*=\s*["']?viewport/i.test(head),
    ogTags: [...new Set(ogTags)], twitterTags: [...new Set(twitterTags)],
    h1Count: h1s.length, h1Text: h1s.slice(0, 3).map((h) => h.text),
    headingOutline: headings.slice(0, 25).map((h) => `h${h.level}: ${h.text}`),
    questionHeadings,
    jsonLdTypes: [...new Set(jsonLdTypes)],
    imgCount: imgs.length, imgMissingAlt,
    internalLinks, externalLinks,
    wordCount: bodyText ? bodyText.split(" ").length : 0,
    hreflangCount, hasFaqMarkup,
    local: {
      mapsLink, telLinks,
      addressInSchema: ldKeys.has("address"),
      geoInSchema: ldKeys.has("geo"),
      openingHoursInSchema: ldKeys.has("openinghours") || ldKeys.has("openinghoursspecification"),
      telephoneInSchema: ldKeys.has("telephone"),
    },
    fetchedAtMs: Date.now(),
  };
}

/** The business/site name as the site itself declares it — used as the Google Maps search query. */
function extractSiteName(html: string, host: string): string | null {
  const head = html.slice(0, 300_000);
  const og = metaContent(head, "property", "og:site_name");
  if (og) return og;
  // schema.org Organization / LocalBusiness-ish name (crude but dependency-free).
  const ld = html.match(/"@type"\s*:\s*"(?:Organization|Corporation|LocalBusiness[^"]*|Store|Restaurant|ProfessionalService)"[^{}]*?"name"\s*:\s*"([^"]+)"/);
  if (ld?.[1]) return decode(ld[1]);
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    // "Page — Brand" / "Brand | tagline": take the segment that isn't generic page words.
    const parts = decode(strip(title[1])).split(/\s*[|–—·/\\-]\s+/).filter(Boolean);
    if (parts.length) return parts.length > 1 ? parts[parts.length - 1] : parts[0];
  }
  return host.replace(/^www\./, "").split(".")[0] || null;
}

// ---- Google Maps / Business Profile lookup (Places API "New" text search) ---------------------
// One POST per review. Matching is strict: a candidate only counts as THE business if the
// website on its listing points at the audited domain — a name-only match could be a different
// company, and mis-attributing a listing is worse than saying "not found". Failures degrade to
// checked:false so a Places outage can never sink a report.

export async function lookupGooglePlaces(siteName: string | null, host: string, apiKey: string): Promise<PlacesResult> {
  if (!apiKey) return { checked: false, found: false };
  const query = siteName || host;
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
        "x-goog-fieldmask": "places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.businessStatus,places.websiteUri,places.googleMapsUri",
      },
      body: JSON.stringify({ textQuery: query, pageSize: 10 }),
    });
    const d: any = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error?.message ?? `Places API returned HTTP ${r.status}`);
    const places: any[] = d?.places ?? [];
    const norm = (h: string) => h.toLowerCase().replace(/^www\./, "");
    const target = norm(host);
    const linksTarget = (p: any) => {
      try {
        const h = norm(new URL(p.websiteUri).hostname);
        return h === target || h.endsWith("." + target);
      } catch { return false; }
    };
    const match = places.find(linksTarget);
    if (!match) return { checked: true, query, found: false, nearMisses: places.length };
    return {
      checked: true, query, found: true,
      name: match.displayName?.text,
      rating: match.rating,
      reviews: match.userRatingCount,
      address: match.formattedAddress,
      businessStatus: match.businessStatus,
      mapsUrl: match.googleMapsUri,
      nearMisses: places.length - 1,
    };
  } catch (e: any) {
    return { checked: false, found: false, query, error: String(e?.message ?? e) };
  }
}

// ---- robots.txt -------------------------------------------------------------------------------

function parseRobots(text: string): SiteSignals["robotsTxt"] {
  const sitemapUrls = [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  // Group rules per user-agent block; a crawler is "blocked" if its best-matching block (its own
  // name, else *) contains `Disallow: /` with no overriding Allow.
  const blocks: { agents: string[]; disallowAll: boolean; allowRoot: boolean }[] = [];
  let cur: { agents: string[]; disallowAll: boolean; allowRoot: boolean } | null = null;
  let expectingAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const v = rest.join(":").trim();
    const key = k.trim().toLowerCase();
    if (key === "user-agent") {
      if (!expectingAgents || !cur) { cur = { agents: [], disallowAll: false, allowRoot: false }; blocks.push(cur); }
      cur.agents.push(v.toLowerCase());
      expectingAgents = true;
    } else {
      expectingAgents = false;
      if (!cur) continue;
      if (key === "disallow" && (v === "/" || v === "/*")) cur.disallowAll = true;
      if (key === "allow" && v === "/") cur.allowRoot = true;
    }
  }
  const verdictFor = (agent: string): "allowed" | "blocked" | "unspecified" => {
    const own = blocks.find((b) => b.agents.includes(agent.toLowerCase()));
    if (own) return own.disallowAll && !own.allowRoot ? "blocked" : "allowed";
    const star = blocks.find((b) => b.agents.includes("*"));
    if (star) return star.disallowAll && !star.allowRoot ? "blocked" : "allowed";
    return "unspecified";
  };
  const star = blocks.find((b) => b.agents.includes("*"));
  const aiCrawlers: Record<string, "allowed" | "blocked" | "unspecified"> = {};
  for (const c of AI_CRAWLERS) aiCrawlers[c] = verdictFor(c);
  return { found: true, sitemapUrls, blocksAllBots: !!star && star.disallowAll && !star.allowRoot, aiCrawlers };
}

// ---- crawl ------------------------------------------------------------------------------------

export function normalizeSiteUrl(input: string): URL {
  let s = String(input ?? "").trim();
  if (!s) throw new Error("enter a website URL");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try { u = new URL(s); } catch { throw new Error("that doesn't look like a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) sites can be reviewed");
  if (!u.hostname.includes(".") && u.hostname !== "localhost") throw new Error("enter a full domain, e.g. example.com");
  u.hash = "";
  return u;
}

export async function crawlSite(inputUrl: string, onProgress?: (phase: string, pagesFetched: number) => void): Promise<SiteSignals> {
  const started = Date.now();
  const budgetLeft = () => CRAWL_BUDGET_MS - (Date.now() - started);
  const errors: string[] = [];
  const progress = (phase: string, n: number) => { try { onProgress?.(phase, n); } catch {} };

  const seed = normalizeSiteUrl(inputUrl);
  progress("fetching homepage", 0);
  const home = await safeFetch(seed.href); // throws on unreachable/SSRF — surfaced to the user
  if (home.status >= 400) throw new Error(`the site responded with HTTP ${home.status}`);
  const finalUrl = new URL(home.finalUrl);
  const origin = finalUrl.origin;

  progress("reading robots.txt & sitemap", 1);
  let robotsTxt: SiteSignals["robotsTxt"] = { found: false, sitemapUrls: [], blocksAllBots: false, aiCrawlers: {} };
  try {
    const r = await safeFetch(origin + "/robots.txt", { maxBytes: 200_000 });
    if (r.status === 200 && !/<html/i.test(r.text.slice(0, 500))) robotsTxt = parseRobots(r.text);
  } catch (e: any) { errors.push("robots.txt: " + e.message); }

  let llmsTxt = { found: false, bytes: 0 };
  try {
    const r = await safeFetch(origin + "/llms.txt", { maxBytes: 200_000 });
    if (r.status === 200 && r.text.trim() && !/<html/i.test(r.text.slice(0, 500))) llmsTxt = { found: true, bytes: r.text.length };
  } catch { /* absence is the common case */ }

  // Discover crawlable URLs: sitemap first (author-curated), homepage links as fallback.
  const sitemapCandidates: string[] = [];
  let sitemap = { found: false, urlCount: 0 };
  for (const smUrl of (robotsTxt.sitemapUrls.length ? robotsTxt.sitemapUrls : [origin + "/sitemap.xml"]).slice(0, 3)) {
    try {
      let r = await safeFetch(smUrl, { maxBytes: PAGE_BYTE_CAP });
      if (r.status !== 200) continue;
      // Sitemap-index? Descend one level into the first child sitemap.
      if (/<sitemapindex/i.test(r.text)) {
        const child = r.text.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1];
        if (child) r = await safeFetch(child, { maxBytes: PAGE_BYTE_CAP });
      }
      const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]));
      if (locs.length) {
        sitemap = { found: true, urlCount: locs.length };
        sitemapCandidates.push(...locs);
        break;
      }
    } catch (e: any) { errors.push("sitemap: " + e.message); }
  }

  const homeSignals = extractPageSignals(home.finalUrl, home.status, home.text);
  const pages: PageSignals[] = [homeSignals];

  const homeLinks = [...home.text.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi)]
    .map((m) => m[2] ?? m[3] ?? "")
    .map((h) => { try { return new URL(h, home.finalUrl).href; } catch { return ""; } });

  const seen = new Set<string>([home.finalUrl.replace(/\/$/, ""), seed.href.replace(/\/$/, "")]);
  const queue: string[] = [];
  const skipExt = /\.(png|jpe?g|gif|svg|webp|ico|css|js|json|xml|pdf|zip|mp4|webm|mp3|woff2?)($|\?)/i;
  for (const cand of [...sitemapCandidates, ...homeLinks]) {
    if (queue.length >= MAX_PAGES * 3) break; // headroom for fetch failures
    try {
      const u = new URL(cand);
      if (u.origin !== origin || skipExt.test(u.pathname)) continue;
      u.hash = "";
      const key = u.href.replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(u.href);
    } catch {}
  }

  // Fetch the queue with a small worker pool — wall clock ≈ pages/CONCURRENCY, not pages.
  let truncated = false;
  let budgetHit = false;
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (pages.length >= MAX_PAGES) { if (next < queue.length) truncated = true; return; }
      if (budgetLeft() < FETCH_TIMEOUT_MS) { truncated = true; budgetHit = true; return; }
      const i = next++;
      if (i >= queue.length) return;
      progress("crawling pages", pages.length);
      try {
        const r = await safeFetch(queue[i]);
        if (!/text\/html|application\/xhtml/.test(r.contentType) && r.contentType) continue;
        if (pages.length < MAX_PAGES) pages.push(extractPageSignals(r.finalUrl, r.status, r.text));
        else truncated = true;
      } catch (e: any) {
        errors.push(`${queue[i]}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CRAWL_CONCURRENCY, queue.length) }, worker));
  if (budgetHit) errors.push("crawl time budget reached");
  progress("crawl complete", pages.length);

  return {
    inputUrl: seed.href, finalUrl: home.finalUrl, host: finalUrl.hostname,
    https: finalUrl.protocol === "https:",
    siteName: extractSiteName(home.text, finalUrl.hostname),
    googlePlaces: { checked: false, found: false }, // caller fills this in when a key is configured
    robotsTxt, sitemap, llmsTxt, pages,
    crawl: { pagesFetched: pages.length, errors: errors.slice(0, 10), truncated, ms: Date.now() - started },
  };
}

// ---- report generation (OpenRouter, structured output) ----------------------------------------

export interface AeoReport {
  site: string;
  summary: string;
  seoScore: number;
  aeoScore: number;
  categories: {
    id: string;
    title: string;
    score: number;
    findings: { status: "pass" | "warn" | "fail"; title: string; detail: string; recommendation?: string }[];
  }[];
  topRecommendations: { priority: number; title: string; detail: string; impact: "high" | "medium" | "low" }[];
}

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "seoScore", "aeoScore", "categories", "topRecommendations"],
  properties: {
    summary: { type: "string", description: "3-5 sentence executive summary of the site's SEO and AEO posture" },
    seoScore: { type: "integer", minimum: 0, maximum: 100 },
    aeoScore: { type: "integer", minimum: 0, maximum: 100 },
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "score", "findings"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          score: { type: "integer", minimum: 0, maximum: 100 },
          findings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["status", "title", "detail"],
              properties: {
                status: { type: "string", enum: ["pass", "warn", "fail"] },
                title: { type: "string" },
                detail: { type: "string" },
                recommendation: { type: "string" },
              },
            },
          },
        },
      },
    },
    topRecommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "title", "detail", "impact"],
        properties: {
          priority: { type: "integer", minimum: 1 },
          title: { type: "string" },
          detail: { type: "string" },
          impact: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
} as const;

const REPORT_PROMPT = `You are an expert technical SEO and AEO (Answer Engine Optimization) auditor. You are given machine-extracted signals from a crawl of a website: robots.txt AI-crawler policy, sitemap/llms.txt presence, and per-page facts (titles, meta descriptions, canonicals, headings, schema.org types, alt coverage, link and word counts).

Produce an exhaustive but well-structured audit report. Score 0-100 for classic SEO and separately for AEO (how well AI assistants like ChatGPT, Claude, Perplexity and Google AI Overviews can crawl, understand, cite and recommend this site).

Use EXACTLY these categories, in this order:
- crawlability ("Crawlability & Indexing"): robots.txt, sitemap, canonicals, meta robots, HTTP status/HTTPS.
- ai-access ("AI Crawler Access"): per-crawler robots.txt verdicts, llms.txt. Blocked AI crawlers are a high-impact AEO failure.
- metadata ("Titles, Metadata & Social"): title/description quality and lengths (titles ~50-60 chars, descriptions ~140-160), OG/Twitter cards, lang attribute.
- content ("Content & Heading Structure"): H1 hygiene, heading outline quality, word counts, thin pages, question-shaped headings, answer-first structure.
- structured-data ("Structured Data"): schema.org coverage (Organization, Article, FAQPage, Product, BreadcrumbList…), FAQ markup.
- aeo-readiness ("Answer Engine Readiness"): citability (dates/authors evident in schema), FAQ/Q&A coverage, content likely accessible without JS (low word counts on pages suggest JS-rendered content), hreflang/internationalization.
- local-presence ("Local Presence & Google Maps"): Google Maps is a major traffic channel for businesses with a physical or service presence. Two evidence sources: (a) each page's "local" signals — LocalBusiness (or subtype) schema with address, geo coordinates, telephone and opening hours; a Google Maps link or embed; tel: click-to-call links; and (b) "googlePlaces" — the result of an actual Google Maps lookup for this business. If googlePlaces.checked is true, lead the category with the listing outcome: found=true → report the listing's name, rating, review count, address and businessStatus as facts (low review counts or CLOSED statuses deserve warn findings with recommendations); found=false → this is a HIGH-impact fail ("your business is not findable on Google Maps under a listing that links {host}") with a "create/claim a Google Business Profile and add your website to it" recommendation — mention nearMisses if listings with a similar name exist but none link this domain. If googlePlaces.checked is false, say listing status could not be verified this run and fall back to site-side readiness. If the site is clearly online-only (no physical presence implied anywhere), say exactly that in one pass finding, score the category 100, and do not pad it with irrelevant failures.

Rules:
- Ground every finding in the provided signals; cite concrete numbers and page URLs from the data. Never invent facts about the site.
- Each category needs 3-8 findings, each pass/warn/fail with a one-to-three-sentence detail; add a recommendation for every warn/fail.
- topRecommendations: the 5-8 highest-impact actions, ordered by priority (1 = do first), deduplicated across categories.
- If the crawl was partial (truncated/errors), say so in the summary and don't penalize what you couldn't see.
- Write for a smart site owner, plain language, no filler.`;

export async function generateAeoReport(
  signals: SiteSignals,
  cfg: { apiKey: string; model: string; referer?: string },
): Promise<{ report: AeoReport; model: string; tokens?: { prompt: number; completion: number } }> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
      // OpenRouter attribution headers (optional but polite; shows in their dashboard).
      "http-referer": cfg.referer ?? "https://koretex.ai",
      "x-title": "Koretex AEO/SEO Review",
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      max_tokens: 8000,
      messages: [
        { role: "system", content: REPORT_PROMPT },
        { role: "user", content: "Crawl signals:\n" + JSON.stringify(signals) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "aeo_seo_report", strict: true, schema: REPORT_SCHEMA },
      },
    }),
  });
  const body: any = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = body?.error?.message ?? `OpenRouter returned HTTP ${r.status}`;
    throw new Error(`report generation failed: ${msg}`);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error("report generation failed: empty model response");
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Some providers wrap JSON in a fence despite strict mode — salvage before failing.
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) throw new Error("report generation failed: model returned non-JSON");
    parsed = JSON.parse(m[0]);
  }
  const report: AeoReport = { site: signals.host, ...parsed };
  const usage = body?.usage;
  return {
    report,
    model: body?.model ?? cfg.model,
    tokens: usage ? { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0 } : undefined,
  };
}
