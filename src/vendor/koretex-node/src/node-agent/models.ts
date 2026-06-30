// `koretex models` — let a provider add or remove models to serve, AFTER the first install.
//
//   koretex models            interactive picker: shows what fits this machine, pull the ones you want
//   koretex models ls         list installed models + what else this machine can run
//   koretex models add <tag…> pull one or more models — ANY Ollama tag or hf.co/* GGUF, not just
//                             our catalog. After a pull we show what it earns and (if it isn't
//                             priced yet) let you suggest a price for the operator.
//   koretex models rm  <tag…> delete one or more models
//
// Pulls go through the SAME managed engine the agent serves from (POST /api/pull), so a model is
// live the moment it finishes. After any change we kick the launchd agent so it re-registers its
// new model list with the dispatcher (registration only sends `models` on connect — see index.ts).

import { execSync } from "node:child_process";
import os from "node:os";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadIdentity } from "./identity.js";

const ENGINE_URL = process.env.ENGINE_URL ?? "http://127.0.0.1:11434";
// HTTPS dispatcher (the `koretex` wrapper sets KORETEX_DISPATCHER; fall back to prod).
const DISPATCHER = (process.env.KORETEX_DISPATCHER ?? "https://dispatcher.koretex.ai").replace(/\/$/, "");
const AGENT_LABEL = "com.koretex.node-agent";
const CREDITS_PER_USDC = 10000; // peg for showing $/1M (display only — billing uses the dispatcher's live peg)

interface CatalogRow {
  tag: string; name: string; sizeGb: number; type: string; minRamGb: number; caps: string[];
  pointsWeight: number; // v2 points multiplier (heavier models earn more per token)
  creditsPerMTok: number; // customer price you earn from
}

/** Usable ACCELERATOR memory + free disk for this machine, to flag what fits. Mirrors the agent's
 *  collectHardware(): Apple Silicon → unified memory · NVIDIA → total VRAM · CPU-only → capped RAM.
 *  (Using system RAM on an NVIDIA box would wrongly offer models that don't fit in VRAM.) */
function hardware(): { accelGb: number; freeGb: number; kind: string } {
  const ramGb = Math.round(os.totalmem() / 1024 ** 3) || 0;
  // Free disk on $HOME, portable across macOS/Linux (POSIX `df -Pk` → 1024-blocks; col 4 = available).
  let freeGb = 0;
  try {
    const out = execSync(`df -Pk "${os.homedir()}"`, { encoding: "utf8" }).trim().split("\n").pop() ?? "";
    freeGb = Math.floor((Number(out.trim().split(/\s+/)[3]) || 0) / 1048576);
  } catch {
    /* best-effort */
  }
  // NVIDIA VRAM via nvidia-smi (any OS), summed across cards. Try absolute paths too — WSL2 puts
  // nvidia-smi under /usr/lib/wsl/lib, off the default PATH.
  let vramGb = 0;
  for (const smi of ["nvidia-smi", "/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi"]) {
    try {
      const out = execSync(`${smi} --query-gpu=memory.total --format=csv,noheader,nounits`, { encoding: "utf8", timeout: 3000 });
      const mib = out.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0).reduce((a, b) => a + b, 0);
      if (mib > 0) { vramGb = Math.round(mib / 1024); break; }
    } catch {
      /* try next location */
    }
  }
  if (os.platform() === "darwin" && os.arch() === "arm64") return { accelGb: ramGb, freeGb, kind: "apple" };
  if (vramGb > 0) return { accelGb: vramGb, freeGb, kind: "nvidia" };
  return { accelGb: Math.round(ramGb * 0.7), freeGb, kind: "cpu" };
}

/** Does a model physically fit? Mirrors the dispatcher's filter (`minRamGb` against usable
 *  accelerator memory; 10GB disk headroom for context + a 2nd model). */
function fits(m: CatalogRow, hw: { accelGb: number; freeGb: number }): boolean {
  return m.minRamGb <= hw.accelGb && m.sizeGb + 10 <= hw.freeGb;
}

/** The full curated catalog (unfiltered) as parsed rows. */
async function fetchCatalog(): Promise<CatalogRow[]> {
  const r = await fetch(`${DISPATCHER}/models/catalog?format=text`);
  if (!r.ok) throw new Error(`catalog ${r.status}`);
  const text = await r.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [tag, name, size, type, minram, caps, weight, credits] = l.split("|");
      return {
        tag,
        name: name || tag,
        sizeGb: Number(size) || 0,
        type: type || "text",
        minRamGb: Number(minram) || 0,
        caps: (caps ?? "").split(",").filter(Boolean),
        pointsWeight: Number(weight) || 1,
        creditsPerMTok: Number(credits) || 0,
      };
    });
}

/** Models the local engine currently has (these are exactly what the node serves). */
async function installedModels(): Promise<string[]> {
  try {
    const j: any = await (await fetch(`${ENGINE_URL}/v1/models`)).json();
    return (j?.data ?? []).map((m: any) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

interface Rate {
  creditsPerMTok: number;
  usdPerMTok: number;
  pointsWeight: number;
  priced: boolean; // false → currently billed at the default rate
  defaultCreditsPerMTok: number;
  creditsPerUsdc: number;
}

/** What a model pays right now (works for ANY tag, incl. off-catalog — the dispatcher falls back to
 *  the default rate). Lets a provider see earnings before/after pulling a model that isn't listed. */
async function rateFor(tag: string): Promise<Rate | null> {
  try {
    const r = await fetch(`${DISPATCHER}/models/rate?tag=${encodeURIComponent(tag)}`);
    if (!r.ok) return null;
    return (await r.json()) as Rate;
  } catch {
    return null;
  }
}

/** Send the operator a suggested price for a model (advisory — it keeps earning the current/default
 *  rate until an admin sets it; the suggestion shows up on the network's Demand tab). */
async function proposePrice(tag: string, creditsPerMTok: number): Promise<boolean> {
  try {
    const wallet = loadIdentity()?.address ?? "";
    const r = await fetch(`${DISPATCHER}/models/propose-price`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: tag, creditsPerMTok, wallet }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** After pulling a model, show what it earns and — if it has no set price yet — let the provider
 *  suggest one (only when we have a terminal to prompt on). */
async function afterAdd(tag: string, canPrompt: boolean): Promise<void> {
  const rate = await rateFor(tag);
  if (!rate) return;
  const usd = (c: number) => `$${(c / rate.creditsPerUsdc).toFixed(2)}/1M`;
  stdout.write(
    `  💰 ${tag} earns ${usd(rate.creditsPerMTok)} · ×${rate.pointsWeight.toFixed(2)} pts` +
      (rate.priced ? " (set price)\n" : ` (default rate — no set price yet)\n`),
  );
  if (rate.priced || !canPrompt) return;
  // Unpriced → offer to suggest a price. Purely advisory.
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(
    `     Suggest a price per 1M tokens? Enter a $ amount (e.g. 0.80), or press Enter to skip: `,
  )).trim();
  rl.close();
  if (!ans) return;
  const dollars = Number(ans.replace(/^\$/, ""));
  if (!(dollars > 0)) {
    stdout.write("     (not a number — skipped)\n");
    return;
  }
  const credits = Math.round(dollars * rate.creditsPerUsdc);
  const ok = await proposePrice(tag, credits);
  stdout.write(
    ok
      ? `     ✓ Suggested $${dollars.toFixed(2)}/1M. It earns the default until an operator sets it; your request shows on the Demand page.\n`
      : `     ✗ Couldn't send the suggestion (network?). You can retry later.\n`,
  );
}

const pays = (m: CatalogRow) =>
  `×${m.pointsWeight.toFixed(2)} pts` + (m.creditsPerMTok ? ` · $${(m.creditsPerMTok / CREDITS_PER_USDC).toFixed(2)}/1M` : "");

const fmtRow = (m: CatalogRow) =>
  `${m.name.padEnd(28)} [${m.type.padEnd(4)}] ~${m.sizeGb}GB` +
  (m.caps.length ? `  ·  ${m.caps.join(", ")}` : "") +
  `  ·  ${pays(m)}  (needs ${m.minRamGb}GB)`;

/** Stream a pull through the managed engine, rendering one updating progress line. */
async function pull(tag: string): Promise<boolean> {
  stdout.write(`\n⬇️  Pulling ${tag} …\n`);
  let res: Response;
  try {
    res = await fetch(`${ENGINE_URL}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: tag, stream: true }),
    });
  } catch (e: any) {
    stdout.write(`  ✗ engine not reachable (${e?.message ?? e}). Is the node running?  koretex status\n`);
    return false;
  }
  if (!res.ok || !res.body) {
    stdout.write(`  ✗ pull failed (HTTP ${res.status}). Check the tag is a real Ollama model.\n`);
    return false;
  }
  let buf = "";
  let lastPct = -1;
  let ok = false;
  for await (const chunk of res.body as any) {
    buf += Buffer.from(chunk).toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.error) {
        stdout.write(`\n  ✗ ${ev.error}\n`);
        return false;
      }
      if (ev.total && ev.completed != null) {
        const pct = Math.floor((ev.completed / ev.total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          const gb = (ev.total / 1024 ** 3).toFixed(1);
          stdout.write(`\r  ${String(pct).padStart(3)}%  of ${gb}GB  (${ev.status ?? "downloading"})        `);
        }
      } else if (ev.status) {
        stdout.write(`\r  ${ev.status}                                   `);
      }
      if (ev.status === "success") ok = true;
    }
  }
  stdout.write(ok ? `\r  ✓ ${tag} ready.                                   \n` : `\r  (pull ended without success)\n`);
  return ok;
}

/** Remove a model from the engine. */
async function remove(tag: string): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/api/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: tag }),
    });
    if (res.ok) {
      stdout.write(`  ✓ removed ${tag}\n`);
      return true;
    }
    stdout.write(`  ✗ couldn't remove ${tag} (HTTP ${res.status}) — is it installed?\n`);
    return false;
  } catch (e: any) {
    stdout.write(`  ✗ engine not reachable (${e?.message ?? e})\n`);
    return false;
  }
}

/** Kick the running agent so it reconnects and re-registers its new model list. No-op if stopped. */
function nudgeAgent(): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  try {
    execSync(`launchctl kickstart -k gui/${uid}/${AGENT_LABEL}`, { stdio: "ignore" });
    stdout.write("  ↻ told the node to re-register its models with the network.\n");
  } catch {
    stdout.write("  (node is stopped — your new models register next time you run `koretex start`.)\n");
  }
}

async function listAll(): Promise<void> {
  const hw = hardware();
  const [catalog, installed] = await Promise.all([fetchCatalog().catch(() => [] as CatalogRow[]), installedModels()]);
  // Engine ids come back lowercased (Ollama normalizes, incl. hf.co/* tags) — compare case-insensitively.
  const have = new Set(installed.map((t) => t.toLowerCase()));
  stdout.write(`\nYour machine:  ${hw.accelGb}GB usable (${hw.kind}) · ${hw.freeGb}GB free disk\n`);
  stdout.write(`\nServing now (${installed.length}):\n`);
  stdout.write(installed.length ? installed.map((t) => `  ✓ ${t}`).join("\n") + "\n" : "  (none yet)\n");
  const addable = catalog.filter((m) => !have.has(m.tag.toLowerCase()) && fits(m, hw));
  const tooBig = catalog.filter((m) => !have.has(m.tag.toLowerCase()) && !fits(m, hw));
  if (addable.length) {
    stdout.write(`\nAlso runnable on this machine — add with \`koretex models add <tag>\` (higher ×pts / $ = prioritize):\n`);
    addable.sort((a, b) => b.pointsWeight - a.pointsWeight); // highest-paying first
    addable.forEach((m) => stdout.write(`  + ${m.tag.padEnd(22)} ${fmtRow(m)}\n`));
  }
  if (tooBig.length) {
    stdout.write(`\nIn the catalog but need more accelerator memory:\n`);
    tooBig.forEach((m) => stdout.write(`  · ${m.tag.padEnd(22)} needs ${m.minRamGb}GB / ${m.sizeGb + 10}GB free\n`));
  }
  stdout.write(`\nThe list above is just our suggestions — you can serve ANY model:\n`);
  stdout.write(`  koretex models add <ollama-tag>            e.g. koretex models add llama3.2:1b\n`);
  stdout.write(`  koretex models add hf.co/<org>/<repo>:<QUANT>   (any HuggingFace GGUF)\n`);
  stdout.write(`We'll show what it earns, and you can suggest a price if it isn't priced yet.\n\n`);
}

async function addTags(tags: string[]): Promise<void> {
  let changed = false;
  const canPrompt = !!stdin.isTTY;
  for (const t of tags) {
    if (await pull(t)) {
      changed = true;
      await afterAdd(t, canPrompt); // show earnings; offer to suggest a price if unpriced
    }
  }
  if (changed) nudgeAgent();
}

async function rmTags(tags: string[]): Promise<void> {
  let changed = false;
  for (const t of tags) if (await remove(t)) changed = true;
  if (changed) nudgeAgent();
}

async function interactive(): Promise<void> {
  const hw = hardware();
  const [catalog, installed] = await Promise.all([fetchCatalog().catch(() => [] as CatalogRow[]), installedModels()]);
  const have = new Set(installed.map((t) => t.toLowerCase())); // engine ids are lowercased
  const choices = catalog.filter((m) => !have.has(m.tag.toLowerCase()) && fits(m, hw));
  stdout.write(`\nYour machine:  ${hw.accelGb}GB usable (${hw.kind}) · ${hw.freeGb}GB free disk\n`);
  stdout.write(`Serving now: ${installed.length ? installed.join(", ") : "(none)"}\n`);
  if (!choices.length) {
    stdout.write("\nNothing more this machine can add right now (everything that fits is already installed).\n");
    return;
  }
  stdout.write(`\nModels you can add (coding · reasoning · agentic tool calling):\n`);
  stdout.write(`  ×pts = points multiplier · $/1M = what you earn — higher = prioritize.\n`);
  choices.sort((a, b) => b.pointsWeight - a.pointsWeight); // highest-paying first
  choices.forEach((m, i) => stdout.write(`  ${String(i + 1).padStart(2)}) ${fmtRow(m)}\n`));
  stdout.write(`\n  You're not limited to this list — you can serve ANY model. Type its Ollama tag\n`);
  stdout.write(`  (e.g. \`llama3.2:1b\`) or a HuggingFace GGUF (\`hf.co/<org>/<repo>:<QUANT>\`).\n`);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question("\nAdd which? (numbers like `1,3`, and/or any model tag — Enter to cancel): ")).trim();
  rl.close();
  if (!ans) {
    stdout.write("Cancelled — nothing changed.\n");
    return;
  }
  // Each token is either a list number (catalog pick) or a literal model tag (bring-your-own).
  const picks = ans
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((tok) => {
      const n = Number(tok);
      return Number.isInteger(n) && n >= 1 && n <= choices.length ? choices[n - 1].tag : tok;
    });
  if (!picks.length) {
    stdout.write("Nothing to add.\n");
    return;
  }
  await addTags(picks);
}

interface DemandRow {
  model: string; // lowercased model id (Ollama normalizes), match catalog case-insensitively
  completionTokens: number; // network-wide tokens served in the window — the "demand" signal
  nodes: number; // how many nodes currently serve it — the "supply" signal
  creditsPerMTok: number;
  pointsWeight: number;
}

/** Network demand per model over the last `days`. Used to pick what's most worth serving. */
async function fetchDemand(days: number): Promise<DemandRow[]> {
  try {
    const r = await fetch(`${DISPATCHER}/models/demand?days=${days}`);
    if (!r.ok) return [];
    const j: any = await r.json();
    return (j?.models ?? []) as DemandRow[];
  } catch {
    return [];
  }
}

/** `koretex autoserve [--days N] [--dry-run]` — pick the highest-UNMET-demand model that fits this
 *  machine and start serving it, no human input. "Unmet" = demand discounted by existing supply
 *  (tokens ÷ nodes-already-serving), so we avoid piling onto a model that's already oversupplied and
 *  instead serve where our capacity is most likely to win jobs. On a cold network (no demand yet)
 *  this falls back to the best-paying model that fits. Idempotent: a no-op if the pick is already
 *  installed. This is what the unattended install + the Hermes provider skill call. */
export async function autoserve(argv: string[]): Promise<void> {
  const days = Math.max(1, Math.min(90, Number(argv[argv.indexOf("--days") + 1]) || 7));
  const dryRun = argv.includes("--dry-run");
  const hw = hardware();
  const [catalog, demand, installed] = await Promise.all([
    fetchCatalog().catch(() => [] as CatalogRow[]),
    fetchDemand(days),
    installedModels(),
  ]);

  const fitting = catalog.filter((m) => fits(m, hw));
  if (!fitting.length) {
    stdout.write(
      `\nNothing in the catalog fits this machine (${hw.accelGb}GB usable / ${hw.freeGb}GB free).\n` +
        `Add one by hand with a smaller tag:  koretex models add <tag>\n\n`,
    );
    return;
  }

  const dMap = new Map(demand.map((d) => [d.model.toLowerCase(), d]));
  // Unmet demand per node (tokens ÷ supply+1); tie-break by earnings (price × points weight), then
  // prefer the smaller model (cheaper to run, faster to pull, leaves room for a 2nd).
  const score = (m: CatalogRow) => {
    const d = dMap.get(m.tag.toLowerCase());
    const unmet = d ? d.completionTokens / (d.nodes + 1) : 0;
    return { unmet, pay: m.creditsPerMTok * m.pointsWeight, size: m.sizeGb };
  };
  const ranked = [...fitting].sort((a, b) => {
    const sa = score(a), sb = score(b);
    return sb.unmet - sa.unmet || sb.pay - sa.pay || sa.size - sb.size;
  });
  const pick = ranked[0];
  const d = dMap.get(pick.tag.toLowerCase());

  stdout.write(`\nMachine:  ${hw.accelGb}GB usable (${hw.kind}) · ${hw.freeGb}GB free disk\n`);
  stdout.write(
    `Best fit: ${pick.name} (${pick.tag})\n` +
      `          demand ${d?.completionTokens?.toLocaleString() ?? 0} tok/${days}d · ${d?.nodes ?? 0} node(s) serving · ` +
      `${pays(pick)}\n`,
  );
  // Show the next couple of runners-up so the choice is legible / auditable.
  ranked.slice(1, 3).forEach((m) => {
    const dd = dMap.get(m.tag.toLowerCase());
    stdout.write(`  runner-up: ${m.tag.padEnd(22)} demand ${dd?.completionTokens ?? 0} · ${dd?.nodes ?? 0} node(s) · ${pays(m)}\n`);
  });

  const have = new Set(installed.map((t) => t.toLowerCase()));
  if (have.has(pick.tag.toLowerCase())) {
    stdout.write(`\n✓ Already serving ${pick.tag}. Nothing to do.\n\n`);
    return;
  }
  if (dryRun) {
    stdout.write(`\n(dry run — would pull and serve ${pick.tag})\n\n`);
    return;
  }
  if (await pull(pick.tag)) nudgeAgent();
}

/** `koretex recommend [--json]` — print the best model for this machine to CONSUME its own inference
 *  from (distinct from what it SERVES). The machine serves a small model it can host; for its own
 *  work it should route through the network to the most capable agentic model someone is serving.
 *  Picks: the largest agentic/tool-capable catalog model with at least one node serving it; falls
 *  back to any served model, then to a model this machine hosts locally (the always-free floor).
 *  Used by the Hermes provider skill to set the agent's primary model + local fallback. */
export async function recommend(argv: string[]): Promise<void> {
  const jsonOut = argv.includes("--json");
  const [catalog, demand, installed] = await Promise.all([
    fetchCatalog().catch(() => [] as CatalogRow[]),
    fetchDemand(30),
    installedModels(),
  ]);
  const supply = new Map(demand.map((d) => [d.model.toLowerCase(), d.nodes]));
  const served = (m: CatalogRow) => (supply.get(m.tag.toLowerCase()) ?? 0) > 0;
  const agentic = (m: CatalogRow) => m.caps.some((c) => ["agentic", "tools", "reasoning", "code"].includes(c));
  const byCapability = (a: CatalogRow, b: CatalogRow) => b.sizeGb - a.sizeGb; // bigger ≈ more capable

  const consume =
    catalog.filter((m) => served(m) && agentic(m)).sort(byCapability)[0] ??
    catalog.filter((m) => served(m)).sort(byCapability)[0] ??
    null;
  // The model this machine hosts itself — the free, always-available fallback for the agent.
  const local = installed[0] ?? null;

  if (jsonOut) {
    console.log(
      JSON.stringify({
        consume: consume?.tag ?? local ?? null, // what to point the agent at (network), else local
        consumeName: consume?.name ?? null,
        local, // local Ollama tag for the fallback provider (free)
        engineUrl: ENGINE_URL,
        dispatcher: DISPATCHER,
        openaiBase: `${DISPATCHER}/v1`,
      }),
    );
    return;
  }
  stdout.write(`\nRecommended for THIS machine's own inference (via the network):\n`);
  stdout.write(consume ? `  primary:  ${consume.tag} (${consume.name})\n` : `  primary:  (none served on the network yet)\n`);
  stdout.write(local ? `  fallback: ${local} (served locally — free, always available)\n\n` : `  fallback: (none — this machine isn't serving a model yet; run koretex autoserve)\n\n`);
}

/** Entry point for `koretex models [ls|add|rm] …`. */
export async function manageModels(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  try {
    if (!sub) return await interactive();
    if (sub === "ls" || sub === "list") return await listAll();
    if (sub === "add" || sub === "pull") {
      if (!rest.length) return stdout.write("Usage: koretex models add <tag> [<tag>…]\n"), void 0;
      return await addTags(rest);
    }
    if (sub === "rm" || sub === "remove" || sub === "delete") {
      if (!rest.length) return stdout.write("Usage: koretex models rm <tag> [<tag>…]\n"), void 0;
      return await rmTags(rest);
    }
    stdout.write(`Unknown: koretex models ${sub}\n  Try: koretex models | koretex models ls | koretex models add <tag> | koretex models rm <tag>\n`);
  } catch (e: any) {
    stdout.write(`models: ${e?.message ?? e}\n`);
  }
}
