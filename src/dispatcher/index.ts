// Dispatcher = control + data plane. Runs in the cloud (or locally for the e2e test).
//   - WS server: nodes connect outbound, register capabilities, pull jobs.
//   - HTTP server: OpenAI-compatible /v1/chat/completions + /v1/models for customers.
// A request is matched to a connected node by the scheduler, forwarded over the node's
// socket, and the node's raw engine response is relayed back to the customer verbatim.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import {
  WS_NODE_PATH,
  type NodeMessage,
  type DispatcherMessage,
  type NodeCapabilities,
  type JobId,
} from "../vendor/koretex-node/src/protocol.js";
import { InMemorySettlement, type SettlementProvider } from "../shared/settlement.js";
import { PostgresSettlement } from "../shared/settlement-postgres.js";
import { InMemoryProviderStore, type ProviderStore } from "../shared/provider-store.js";
import { PostgresProviderStore } from "../shared/provider-store-postgres.js";
import { InMemoryCreditStore, type CreditStore } from "../shared/credits.js";
import { PostgresCreditStore } from "../shared/credits-postgres.js";
import { InMemoryCustomerStore, type CustomerStore } from "../shared/customer-store.js";
import { PostgresCustomerStore } from "../shared/customer-store-postgres.js";
import { InMemoryPointsStore, newEvent, epochOf, modelWeight, FORMULA_PARAMS, UPTIME_SAMPLE_MS, type PointsStore } from "../shared/points.js";
import { PostgresPointsStore } from "../shared/points-postgres.js";
import { FingerprintRegistry } from "../shared/fingerprint.js";
import { Prober } from "./prober.js";
import { makeAttestationVerifier, type AttestationVerifier } from "../shared/attestation.js";
import { InMemoryBlacklist, type BlacklistStore } from "../shared/blacklist.js";
import { InMemoryModelPricing, type ModelPricingStore } from "../shared/model-pricing.js";
import { PostgresModelPricing } from "../shared/model-pricing-postgres.js";
import { Pricing, type PriceBook } from "../shared/pricing.js";
import { SolanaVerifier, USDC_MINT_MAINNET } from "../shared/solana.js";
import { Pairing } from "./pairing.js";
import { Challenges } from "./challenge.js";
import { Sessions } from "./sessions.js";
import {
  buildAdminMessage,
  buildCreditsMessage,
  buildDashboardMessage,
  buildEnrollMessage,
  buildRevokeMessage,
  verifyWalletSignature,
  isValidSolanaAddress,
} from "../shared/wallet.js";

const HTTP_PORT = Number(process.env.PORT ?? 8787);
// Comma-separated customer API keys. Demo default; override in prod.
const CUSTOMER_KEYS = new Set(
  (process.env.CUSTOMER_KEYS ?? "sk-cust-demo").split(",").map((s) => s.trim()),
);
// Shared secret a node must present to register. Empty = open (local dev only).
const NODE_TOKEN = process.env.NODE_TOKEN ?? "";
// How often a live wallet-bound node's token is re-checked against the store (revoke/purge).
const AUTH_RECHECK_MS = 60_000;
// Throughput-measurement guards. A probe must generate at least this many tokens for tok/s to be
// meaningful (a near-empty reply can't be timed), and tok/s is capped at a physically-plausible
// ceiling — vision/odd models (e.g. moondream) batch-return their tokens so firstByte→done collapses
// and tok/s explodes to absurd values that would inflate the hardware score.
const MIN_TPS_TOKENS = 8;
const MAX_PLAUSIBLE_TPS = 500;
// Bearer for the raw /admin/ledger* JSON endpoints (scripts/cron). Closed-by-default if unset.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
// Operator's Solana wallet — the only wallet allowed into the /admin console (wallet sign-in).
const ADMIN_WALLET = process.env.ADMIN_WALLET ?? "";
// Phantom embedded-wallet app id (from phantom.com/portal). Public client identifier — ships to the
// browser. Powers Google login; the redirect URL (origin + /auth/callback) must be allow-listed in
// the Portal. Default is the Koretex app id; override per-env with PHANTOM_APP_ID.
const PHANTOM_APP_ID = process.env.PHANTOM_APP_ID ?? "0c2d3faa-7bdc-420a-a27b-2fb3c5f1b4d1";
const HEARTBEAT_TIMEOUT_MS = 30_000;

// ---- Credits / payments (M4 money-in) -------------------------------------------------------
// Customers buy credits by sending USDC to ADMIN_FEE_WALLET; we verify the transfer on-chain via
// SOLANA_RPC_URL and credit them. Defaults are public (mainnet); the RPC url (which carries an
// API key) belongs in the secrets env, never in code.
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
// The USDC receiving wallet. No in-code default (kept out of the repo) — set ADMIN_FEE_WALLET in the
// environment. Empty = credit purchases are disabled (inference still works on legacy/unmetered keys).
const ADMIN_FEE_WALLET = process.env.ADMIN_FEE_WALLET ?? "";
const USDC_MINT = process.env.USDC_MINT ?? USDC_MINT_MAINNET;
// Peg: how many credits one USDC buys. 10000 → 1 credit = $0.0001, fine-grained enough to bill
// per-token inference in whole credits (see pricing.ts).
const CREDITS_PER_USDC = Number(process.env.CREDITS_PER_USDC ?? 10000);
// One-off welcome credits granted to every wallet (idempotent) so newcomers can test inference.
const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS ?? 1000);
// Commitment used when reading deposits. 'finalized' (default) cannot roll back; 'confirmed' is faster.
const SOLANA_COMMITMENT = process.env.SOLANA_COMMITMENT ?? "finalized";
// JSON-RPC methods the browser may proxy through us (so the Helius key stays server-side).
const RPC_PROXY_METHODS = new Set([
  "getLatestBlockhash", "getAccountInfo", "getMultipleAccounts", "getTokenAccountBalance",
  "getTokenAccountsByOwner", "sendTransaction", "getSignatureStatuses",
  "getFeeForMessage", "getMinimumBalanceForRentExemption", "getParsedTransaction",
]);

/** Credits issued for a USDC amount (base units, 6 decimals), floored. */
function creditsFor(usdcRaw: number): number {
  return Math.floor((usdcRaw * CREDITS_PER_USDC) / 1e6);
}

interface ConnectedNode {
  ws: WebSocket;
  caps: NodeCapabilities;
  /** Provider wallet this node pays out to. Its identity for the ledger. */
  owner: string;
  /** The node token it registered with — so the owner can revoke this specific node. */
  token: string;
  inflight: number;
  lastSeen: number;
  /** Whether the node's engine is currently serving — true on connect, set by probe/job outcomes.
   *  Drives the availability sweep: connected-but-not-serving counts as downtime. */
  serving: boolean;
  /** Last time this node's wallet token was re-checked against the store (throttle). */
  lastAuthAt?: number;
  /** Consecutive failed re-checks (token didn't resolve to the same wallet). Only disconnect after
   *  a couple in a row, so a transient store blip never kicks a healthy, heart-beating node. */
  authFails?: number;
  /** Verified device key from attestation (R3), or null if unattested. */
  deviceKey?: string | null;
  /** Active inference backend the node reported ("llama.cpp" / "mlx" / "unknown"). */
  backend: string;
}

type LiveNode = { nodeId: string; models: string[]; inflight: number; hw?: NodeCapabilities["hw"]; backend: string };

// The currently-connected nodes owned by a wallet — "what you're serving right now" (P3).
function liveNodesFor(owner: string): LiveNode[] {
  const out: LiveNode[] = [];
  for (const [id, n] of nodes) if (n.owner === owner) out.push({ nodeId: id, models: n.caps.models, inflight: n.inflight, hw: n.caps.hw, backend: n.backend });
  return out;
}

// Every connected node across the network, with its owner + hardware — the operator fleet view.
function fleet(): (LiveNode & { owner: string })[] {
  const out: (LiveNode & { owner: string })[] = [];
  for (const [id, n] of nodes) out.push({ nodeId: id, owner: n.owner, models: n.caps.models, inflight: n.inflight, hw: n.caps.hw, backend: n.backend });
  return out.sort((a, b) => (b.hw?.ramGb ?? 0) - (a.hw?.ramGb ?? 0) || a.nodeId.localeCompare(b.nodeId));
}

// Count connected nodes by backend — a quick read on MLX vs llama.cpp adoption across the network.
function backendCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of nodes.values()) out[n.backend] = (out[n.backend] ?? 0) + 1;
  return out;
}

// Models currently served across the whole network, with how many nodes serve each, its price, and
// its points weight (the v2 model-size multiplier — so providers can see which models pay best).
// Unlike /v1/models (which dedupes to a bare list), this keeps the node count and joins pricing.
function liveModels(): { id: string; nodes: number; creditsPerMTok: number; usdPerMTok: number; pointsWeight: number }[] {
  const counts = new Map<string, number>();
  for (const n of nodes.values())
    for (const m of n.caps.models) counts.set(m, (counts.get(m) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, nodeCount]) => {
      const creditsPerMTok = pricing.rate(id);
      return { id, nodes: nodeCount, creditsPerMTok, usdPerMTok: creditsPerMTok / CREDITS_PER_USDC, pointsWeight: modelWeight(id) };
    })
    .sort((a, b) => b.nodes - a.nodes || a.id.localeCompare(b.id));
}

// Resolve a node's registration to the wallet it pays out to (its "owner"), or null to reject.
//  - wallet token (`nt_…`) → the bound Solana wallet address (the real P2 path)
//  - legacy shared NODE_TOKEN → the node's self-declared id (transitional fallback)
//  - open mode (no NODE_TOKEN configured) → self-declared id (local dev / e2e)
async function authenticateNode(reg: { token?: string; nodeId?: string }): Promise<string | null> {
  const token = reg.token ?? "";
  if (token.startsWith("nt_")) return providerStore.resolveToken(token); // null if unknown/revoked
  if (NODE_TOKEN) return token === NODE_TOKEN ? reg.nodeId || "legacy" : null;
  return reg.nodeId || "anon"; // open mode
}

const nodes = new Map<string, ConnectedNode>();
// First time we saw each node id connect THIS process — drives the uptime warmup grace so a node
// isn't penalised for the unavoidable churn (model pull, service reload) during its own install.
// Process-local on purpose: a node only earns the grace once, not on every flap/reconnect.
const nodeFirstConnect = new Map<string, number>();
// Durable ledger when DATABASE_URL is set (prod); in-memory otherwise (local/e2e).
const settlement: SettlementProvider = process.env.DATABASE_URL
  ? new PostgresSettlement(process.env.DATABASE_URL)
  : new InMemorySettlement();

// Provider identity (P2): "connect your wallet once" → revocable, wallet-bound node token.
// Durable token store when DATABASE_URL is set (survives redeploys); in-memory otherwise.
const providerStore: ProviderStore = process.env.DATABASE_URL
  ? new PostgresProviderStore(process.env.DATABASE_URL)
  : new InMemoryProviderStore();
const pairing = new Pairing(providerStore);

// Credit purchases (M4 money-in). Durable when DATABASE_URL is set; in-memory otherwise.
const creditStore: CreditStore = process.env.DATABASE_URL
  ? new PostgresCreditStore(process.env.DATABASE_URL)
  : new InMemoryCreditStore();
// Verifies USDC deposits to the fee wallet on-chain (the source of truth for crediting).
const verifier = new SolanaVerifier({
  rpcUrl: SOLANA_RPC_URL,
  adminWallet: ADMIN_FEE_WALLET,
  usdcMint: USDC_MINT,
  commitment: SOLANA_COMMITMENT,
});

// Wallet-bound customer API keys (metered inference). Durable when DATABASE_URL is set.
const customerStore: CustomerStore = process.env.DATABASE_URL
  ? new PostgresCustomerStore(process.env.DATABASE_URL)
  : new InMemoryCustomerStore();

// Points & reputation event log (R0). Durable when DATABASE_URL is set. Records the same job
// completions the ledger does (demand signal) plus, later, synthetic-challenge results (R1).
const points: PointsStore = process.env.DATABASE_URL
  ? new PostgresPointsStore(process.env.DATABASE_URL)
  : new InMemoryPointsStore();

// Anti-sybil (R3). Attestation binds a node to a real device; REQUIRE_ATTESTATION gates whether an
// unattested node may register (default off so the current live fleet keeps working). The blacklist
// bans wallets caught cheating; the penalty config escalates repeated authenticity failures to a ban.
const attestation: AttestationVerifier = makeAttestationVerifier(process.env.ATTESTATION_MODE);
const REQUIRE_ATTESTATION = process.env.REQUIRE_ATTESTATION === "1";
const blacklist: BlacklistStore = new InMemoryBlacklist();

// Demand-driven pricing control plane (admin overrides + provider proposals). Durable when
// DATABASE_URL is set; in-memory otherwise. Overrides are loaded into `pricing` at boot.
const modelPricing: ModelPricingStore = process.env.DATABASE_URL
  ? new PostgresModelPricing(process.env.DATABASE_URL)
  : new InMemoryModelPricing();
const PENALTY_UNITS = Number(process.env.PENALTY_UNITS ?? 5000); // score magnitude per fake-model catch
const BLACKLIST_STRIKES = Number(process.env.BLACKLIST_STRIKES ?? 5); // failures before an auto-ban
const authFailStrikes = new Map<string, number>(); // owner -> consecutive authenticity failures

// Challenge prober (R1): periodically probes connected nodes with jobs indistinguishable from
// real traffic, recording `challenge` events (reachability + throughput + model authenticity).
// Only nodes whose owner is a real wallet are probed — legacy/dev nodes don't earn points.
const fingerprints = new FingerprintRegistry(Number(process.env.PROBE_QUORUM ?? 2));
const prober = new Prober(
  {
    listTargets: () =>
      [...nodes.values()]
        .filter((n) => isValidSolanaAddress(n.owner) && n.caps.models.length > 0 && !blacklist.has(n.owner))
        .map((n) => ({
          nodeId: n.caps.nodeId,
          owner: n.owner,
          models: n.caps.models,
          backend: n.backend,
          run: (body, timeoutMs) => runInternalJob(n, body, timeoutMs),
        })),
    points,
    fingerprints,
    now: () => Date.now(),
    // R3 escalation: a confirmed fake-model serve records a `penalty` (erodes score) and, after
    // BLACKLIST_STRIKES consecutive catches, bans the wallet. A clean verification resets the streak.
    onOutcome: (o) => {
      // Record whether the engine actually served this probe — the availability sweep reads this to
      // tell "connected and working" from "connected but engine down/erroring" (both count uptime).
      const live = nodes.get(o.target.nodeId);
      if (live) live.serving = o.result.ok;
      if (o.modelVerified === false) {
        const at = Date.now();
        points.record(
          newEvent({ nodeId: o.target.nodeId, owner: o.target.owner, kind: "penalty", at, model: o.model, units: PENALTY_UNITS, detail: { reason: "model_authenticity", promptId: o.promptId } }),
        );
        const strikes = (authFailStrikes.get(o.target.owner) ?? 0) + 1;
        authFailStrikes.set(o.target.owner, strikes);
        console.log(`[penalty] ${o.target.owner.slice(0, 6)}… failed authenticity on ${o.model} (strike ${strikes}/${BLACKLIST_STRIKES})`);
        if (strikes >= BLACKLIST_STRIKES && !blacklist.has(o.target.owner)) {
          blacklist.add(o.target.owner, `auto: ${strikes} authenticity failures`, at);
          console.log(`[blacklist] banned ${o.target.owner.slice(0, 6)}… (repeated fake-model serves)`);
          disconnectOwner(o.target.owner);
        }
      } else if (o.modelVerified === true) {
        authFailStrikes.delete(o.target.owner);
      }
    },
  },
  {
    intervalMs: Number(process.env.PROBE_INTERVAL_MS ?? 60_000),
    perTick: Number(process.env.PROBE_PER_TICK ?? 3),
    timeoutMs: Number(process.env.PROBE_TIMEOUT_MS ?? 30_000),
    maxTokens: Number(process.env.PROBE_MAX_TOKENS ?? 64),
  },
);

/** Force-disconnect every live node owned by a wallet (used when it's banned). */
function disconnectOwner(owner: string): void {
  for (const [id, n] of nodes) {
    if (n.owner === owner) {
      try { n.ws.close(4403, "blacklisted"); } catch {}
      nodes.delete(id);
    }
  }
}

// Single-use nonces for wallet sign-in to the provider dashboard (P4) + credits page (M4).
const challenges = new Challenges();
// Wallet sessions for the credits page: sign once, reuse a bearer token for the TTL so reads
// and key-minting don't re-prompt. In-memory (a restart just costs one more signature).
const sessions = new Sessions();

// Authenticate a gated credits request as a wallet. Accepts EITHER a live session token
// (the common path — no signing) OR a freshly-signed single-use nonce (opens the session,
// or a direct one-off). Returns the wallet pubkey, or null after writing an error response.
function authCreditsWallet(res: http.ServerResponse, b: any): string | null {
  const pubkey = String(b.pubkey ?? "");
  if (!isValidSolanaAddress(pubkey)) {
    json(res, 400, { error: { message: "invalid account address" } });
    return null;
  }
  const session = String(b.session ?? "");
  if (session) {
    const wallet = sessions.resolve(session, Date.now());
    if (wallet && wallet === pubkey) return wallet;
    json(res, 401, { error: { message: "session expired — reconnect your account" } });
    return null;
  }
  // Fallback: a one-off signed nonce (also how older clients call these endpoints).
  const nonce = String(b.nonce ?? "");
  const signature = String(b.signature ?? "");
  if (!challenges.consume(nonce, Date.now())) {
    json(res, 401, { error: { message: "challenge expired — reload and try again" } });
    return null;
  }
  if (!verifyWalletSignature(pubkey, buildCreditsMessage(nonce), signature)) {
    json(res, 401, { error: { message: "signature verification failed" } });
    return null;
  }
  return pubkey;
}

// Idempotently grant a wallet its one-off welcome credits (keyed on `welcome:<wallet>`, so it only
// ever lands once). Called on a wallet's first authenticated touch so new sign-ups can test.
async function ensureWelcomeCredits(wallet: string): Promise<void> {
  if (!WELCOME_CREDITS || !isValidSolanaAddress(wallet)) return;
  try {
    await creditStore.recordPurchase({ signature: "welcome:" + wallet, wallet, usdcRaw: 0, credits: WELCOME_CREDITS, slot: 0, blockTime: null, at: Date.now() });
  } catch (e) {
    console.error("[credits] welcome grant failed:", (e as Error).message);
  }
}

// Static assets served same-origin for the installer (P1), wallet connect (P2), dashboard (P4).
// The unified app — one tabbed page that replaces the standalone dashboard/credits/models/
// leaderboard/points/provider pages. It picks the active tab from the path/hash.
const APP_HTML = readFileSync(new URL("./app.html", import.meta.url), "utf8");
const APP_PATHS = new Set(["/", "/dashboard", "/credits", "/models", "/demand", "/leaderboard", "/points", "/provider"]);
const CONNECT_HTML = readFileSync(new URL("./connect.html", import.meta.url), "utf8");
const ADMIN_HTML = readFileSync(new URL("./admin.html", import.meta.url), "utf8");
const AUTH_CALLBACK_HTML = readFileSync(new URL("./auth-callback.html", import.meta.url), "utf8");
const FAVICON_SVG = readFileSync(new URL("./koretex-favicon.svg", import.meta.url), "utf8");
function readMaybe(rel: string): string | null {
  try {
    return readFileSync(new URL(rel, import.meta.url), "utf8");
  } catch {
    return null; // built/copied into the image; serve 404 if absent rather than crash
  }
}
const INSTALL_SH = readMaybe("../../src/vendor/koretex-node/deploy/install.sh");
const PREFLIGHT_SH = readMaybe("../../src/vendor/koretex-node/deploy/preflight.sh");
const AGENT_BUNDLE = readMaybe("../../dist/koretex-agent.cjs");
// Browser bundle of the Phantom wallet wrapper (built via `npm run wallet:bundle`). Absent until
// built; the /wallet.js route 404s rather than crashing, same as the agent bundle.
const WALLET_BUNDLE = readMaybe("../../dist/wallet.js");

// Curated model catalog (which models a provider can serve). Filtered by the installer/preflight.
interface CatalogModel { tag: string; name: string; sizeGb: number; minRamGb: number; type?: string; tags?: string[]; desc?: string; primary?: boolean }
const MODELS: CatalogModel[] = (() => {
  try {
    return JSON.parse(readMaybe("../../deploy/models.json") ?? "{}").models ?? [];
  } catch {
    return [];
  }
})();

// Vision / embedding models are excluded from what a node may SERVE — they go through other
// endpoints/engines and can't be measured as text throughput (e.g. moondream batch-returns its
// tokens, spiking tok/s). Drop them from a node's reported models: by catalog type, or by name for
// ones a node has installed locally that aren't in the catalog.
const NON_SERVABLE_TAGS = new Set(MODELS.filter((m) => m.type === "vision" || m.type === "embedding" || m.type === "embed").map((m) => m.tag));
const NON_SERVABLE_RE = /moondream|llava|bakllava|minicpm-?v|cogvlm|vision|embed|nomic|mxbai|bge[-_]|arctic-embed/i;
function servableModels(models: string[]): string[] {
  return models.filter((m) => !NON_SERVABLE_TAGS.has(m) && !NON_SERVABLE_RE.test(m));
}

// Inference price book (credits per 1M tokens, per model + default). Powers metered billing.
const PRICE_BOOK: PriceBook = (() => {
  try {
    const b = JSON.parse(readMaybe("../../deploy/prices.json") ?? "{}");
    return { default: Number(b.default ?? 4000), models: b.models ?? {} };
  } catch {
    return { default: 4000, models: {} };
  }
})();
const pricing = new Pricing(PRICE_BOOK);

// jobId -> live customer HTTP response we're streaming bytes into.
interface PendingJob {
  /** Customer job: stream the engine response straight back here. Absent for internal jobs. */
  res?: http.ServerResponse;
  /** Internal job (the prober): buffer the response + resolve a promise instead of streaming. */
  internal?: InternalJobCtx;
  nodeId: string;
  owner: string;
  customerKey: string;
  /** Caller's wallet when this is a metered (wallet-bound key) request; null for legacy keys. */
  customerWallet: string | null;
  /** The requested model, for pricing on completion. */
  model: string;
  headWritten: boolean;
}

/** Result of an internal job the dispatcher ran itself (a challenge probe). */
export interface InternalJobResult {
  ok: boolean;
  status: number;
  /** Full response body, buffered. */
  body: string;
  /** Wall-clock from dispatch to completion (ms). */
  latencyMs: number;
  /** Time to first response byte (ms) — the time-to-first-token proxy. */
  firstByteMs?: number;
  /** Completion tokens, from the node's reported usage or parsed from the body. */
  completionTokens?: number;
  /** Measured generation throughput (completion tokens / generation time). */
  tokensPerSec?: number;
  model?: string;
  error?: string;
}

interface InternalJobCtx {
  startedAt: number;
  firstByteAt?: number;
  status: number;
  body: string;
  settled: boolean;
  resolve: (r: InternalJobResult) => void;
  timer: NodeJS.Timeout;
}

const jobs = new Map<JobId, PendingJob>();

/** Settle an internal job exactly once: clear its timeout, free the node slot, resolve the promise. */
function settleInternal(jobId: JobId, job: PendingJob, result: InternalJobResult): void {
  const ctx = job.internal!;
  if (ctx.settled) return;
  ctx.settled = true;
  clearTimeout(ctx.timer);
  jobs.delete(jobId);
  const n = nodes.get(job.nodeId);
  if (n) n.inflight = Math.max(0, n.inflight - 1);
  ctx.resolve(result);
}

/**
 * Run a job the dispatcher originates itself (not a customer request) against a specific node, and
 * collect the full response. This is what the challenge prober (R1) uses — to the node it is byte-
 * for-byte identical to a real customer job, so it can't be gamed by "serve probes well, real
 * traffic badly". Buffers the body; never touches an HTTP response.
 */
function runInternalJob(node: ConnectedNode, body: unknown, timeoutMs = 30_000): Promise<InternalJobResult> {
  return new Promise((resolve) => {
    const jobId = randomUUID();
    const startedAt = Date.now();
    node.inflight++;
    const timer = setTimeout(() => {
      const job = jobs.get(jobId);
      if (job?.internal)
        settleInternal(jobId, job, { ok: false, status: 0, body: "", latencyMs: Date.now() - startedAt, error: "timeout" });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    jobs.set(jobId, {
      internal: { startedAt, status: 0, body: "", settled: false, resolve, timer },
      nodeId: node.caps.nodeId,
      owner: node.owner,
      customerKey: "__internal__",
      customerWallet: null,
      model: typeof (body as any)?.model === "string" ? (body as any).model : "",
      headWritten: false,
    });
    send(node.ws, { t: "job", jobId, body });
  });
}

const send = (ws: WebSocket, msg: DispatcherMessage) => ws.send(JSON.stringify(msg));

// ---- Reputation cache (R2): nodeId -> current points score, refreshed periodically from the
// points store. Routing reads this hot, so we don't hit the DB per request.
const reputationByNode = new Map<string, number>();
const REP_REFRESH_MS = Number(process.env.REP_REFRESH_MS ?? 30_000);
// Exploration floor: brand-new nodes (reputation ~0) still get traffic so they can build history
// — otherwise reputation routing would starve newcomers and they could never earn their first job.
const REP_BASE = Number(process.env.REP_BASE ?? 10);

async function refreshReputation(): Promise<void> {
  try {
    const scores = await points.nodeScores({ now: Date.now() });
    reputationByNode.clear();
    for (const s of scores) reputationByNode.set(s.nodeId, s.points);
  } catch (e) {
    console.error("[reputation] refresh failed:", (e as Error)?.message ?? e);
  }
}

// ---- Scheduler: pick a node for a model. Reputation-weighted (R2): prefer high-reputation nodes,
// balanced against current load. weight = (reputation + base) / (inflight + 1). The base lets idle
// newcomers win when proven nodes are busy, so good hardware earns more traffic without starving
// new supply. (Price/latency/region weighting still to layer in — M2.)
function pickNode(model: string): ConnectedNode | null {
  let best: ConnectedNode | null = null;
  let bestWeight = -1;
  for (const n of nodes.values()) {
    if (!n.caps.models.includes(model)) continue;
    const rep = reputationByNode.get(n.caps.nodeId) ?? 0;
    const weight = (rep + REP_BASE) / (n.inflight + 1);
    if (weight > bestWeight) {
      best = n;
      bestWeight = weight;
    }
  }
  return best;
}

// ---------------------------------------------------------------- WS (node) plane
const httpServer = http.createServer(handleHttp);
const wss = new WebSocketServer({ server: httpServer, path: WS_NODE_PATH });

wss.on("connection", (ws) => {
  let nodeId: string | null = null;

  ws.on("message", (raw) => {
    let msg: NodeMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.t) {
      case "register": {
        const reg = msg; // capture the typed message for the async closure
        void (async () => {
          const owner = await authenticateNode(reg);
          if (!owner) {
            console.log(`[node] rejected registration (auth) for ${reg.nodeId}`);
            try { ws.close(4401, "unauthorized"); } catch {}
            return;
          }
          // R3: banned wallets can't come back.
          if (blacklist.has(owner)) {
            console.log(`[node] rejected registration (blacklisted) for ${owner.slice(0, 8)}…`);
            try { ws.close(4403, "blacklisted"); } catch {}
            return;
          }
          // R3: hardware attestation. When required, an unverifiable device can't register at all
          // (so it never appears on the leaderboard); otherwise it's recorded but not enforced.
          const deviceKey = await attestation.verify({ nodeId: reg.nodeId, owner, attestation: reg.attestation });
          if (REQUIRE_ATTESTATION && !deviceKey) {
            console.log(`[node] rejected registration (attestation) for ${owner.slice(0, 8)}…`);
            try { ws.close(4401, "attestation required"); } catch {}
            return;
          }
          nodeId = reg.nodeId || randomUUID();
          const backend = reg.backend ?? "unknown";
          const models = servableModels(reg.models); // drop vision/embedding models the node reported
          nodes.set(nodeId, { ws, caps: { ...reg, nodeId, models }, owner, token: reg.token ?? "", inflight: 0, lastSeen: Date.now(), serving: true, deviceKey, backend });
          if (!nodeFirstConnect.has(nodeId)) nodeFirstConnect.set(nodeId, Date.now());
          send(ws, { t: "registered", ok: true, assignedId: nodeId });
          const hw = reg.hw;
          console.log(
            `[node] registered ${nodeId} owner=${owner.slice(0, 8)}…` +
              (hw ? ` hw=[${hw.chip ?? "?"}, ${hw.ramGb ?? "?"}GB, macOS ${hw.macosVersion ?? "?"}]` : "") +
              ` backend=${backend} models=[${models.join(", ")}]${deviceKey ? " attested" : ""}`,
          );
        })();
        break;
      }
      case "heartbeat": {
        const id = nodeId;
        const n = id ? nodes.get(id) : undefined;
        if (!n || !id) break;
        const now = Date.now();
        n.lastSeen = now;
        // Re-validate wallet-bound nodes against the store. The owner is pinned in memory at
        // register time, so a token that's later revoked or wiped (e.g. a DB purge for a clean
        // start) would otherwise keep earning forever on the still-open socket. Re-resolve it
        // periodically and drop the node if its token no longer maps to the same wallet.
        if (n.token.startsWith("nt_") && now - (n.lastAuthAt ?? 0) > AUTH_RECHECK_MS) {
          n.lastAuthAt = now;
          void providerStore.resolveToken(n.token).then((owner) => {
            if (nodes.get(id) !== n) return; // node already replaced/gone
            if (owner === n.owner) { n.authFails = 0; return; } // still valid — reset
            // Token didn't resolve to the same wallet. Require TWO consecutive misses (~2 min) before
            // dropping, so a one-off store hiccup or read-lag never kicks a healthy node.
            n.authFails = (n.authFails ?? 0) + 1;
            if (n.authFails >= 2) {
              console.log(`[node] ${id} token no longer valid (${n.authFails} checks) — disconnecting`);
              try { n.ws.close(4401, "token revoked"); } catch {}
              nodes.delete(id);
            }
          }).catch(() => {}); // a transient store error shouldn't kick a live node
        }
        break;
      }
      case "head": {
        const job = jobs.get(msg.jobId);
        if (!job || job.headWritten) break;
        job.headWritten = true;
        if (job.internal) job.internal.status = msg.status;
        else job.res!.writeHead(msg.status, { "content-type": msg.contentType });
        break;
      }
      case "chunk": {
        const job = jobs.get(msg.jobId);
        if (!job) break;
        if (job.internal) {
          if (job.internal.firstByteAt === undefined) job.internal.firstByteAt = Date.now();
          job.internal.body += msg.data;
        } else job.res!.write(msg.data);
        break;
      }
      case "done": {
        const job = jobs.get(msg.jobId);
        if (job?.internal) {
          const ctx = job.internal;
          const now = Date.now();
          const usage = msg.usage ?? {};
          // Prefer the node's reported completion tokens; fall back to parsing the OpenAI body.
          const completionTokens = usage.completionTokens ?? parseCompletionTokens(ctx.body);
          const genMs = Math.max(1, now - (ctx.firstByteAt ?? ctx.startedAt));
          // Only trust tok/s on a response long enough to time, and cap it so a batch-returned reply
          // (genMs≈0) can't report an impossible rate.
          const tokensPerSec =
            completionTokens != null && completionTokens >= MIN_TPS_TOKENS
              ? Math.min(MAX_PLAUSIBLE_TPS, (completionTokens * 1000) / genMs)
              : undefined;
          settleInternal(msg.jobId, job, {
            ok: ctx.status > 0 && ctx.status < 400,
            status: ctx.status,
            body: ctx.body,
            latencyMs: now - ctx.startedAt,
            firstByteMs: ctx.firstByteAt ? ctx.firstByteAt - ctx.startedAt : undefined,
            completionTokens,
            tokensPerSec,
            model: usage.model ?? job.model,
          });
          break;
        }
        if (job) {
          const usage = msg.usage ?? {};
          const at = Date.now();
          // A completed real job proves the engine is serving — keep the availability flag fresh
          // between probes so a busy node never looks like downtime.
          const ln = nodes.get(job.nodeId);
          if (ln) ln.serving = true;
          settlement.record({
            jobId: msg.jobId,
            customerKey: job.customerKey,
            nodeId: job.nodeId,
            owner: job.owner,
            usage,
            at,
          });
          // Points (R0): a completed real job is the demand signal. Append-only, fire-and-forget,
          // idempotent on the event id. Only attribute to a real provider wallet (not legacy ids).
          if (isValidSolanaAddress(job.owner)) {
            points.record(
              newEvent({
                nodeId: job.nodeId,
                owner: job.owner,
                kind: "job",
                at,
                ok: true,
                synthetic: false,
                model: usage.model ?? job.model,
                units: usage.completionTokens ?? 0,
              }),
            );
          }
          // Bill credits: debit caller, credit supplier by the SAME amount. Only for metered
          // (wallet-bound) callers served by a real wallet provider. Idempotent on jobId.
          if (job.customerWallet && isValidSolanaAddress(job.owner) && job.customerWallet !== job.owner) {
            const tokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
            const credits = pricing.cost(usage.model ?? job.model, tokens);
            if (credits > 0) {
              creditStore
                .recordInferenceCharge({ jobId: msg.jobId, customerWallet: job.customerWallet, providerWallet: job.owner, credits, at: Date.now() })
                .catch((e) => console.error(`[credits] charge failed for ${msg.jobId}:`, e?.message ?? e));
              console.log(`[bill] ${msg.jobId} ${credits} credits  ${job.customerWallet.slice(0, 6)}… → ${job.owner.slice(0, 6)}…`);
            }
          }
          job.res!.end();
          jobs.delete(msg.jobId);
          const n = nodes.get(job.nodeId);
          if (n) n.inflight = Math.max(0, n.inflight - 1);
        }
        break;
      }
      case "error": {
        const job = jobs.get(msg.jobId);
        if (job?.internal) {
          settleInternal(msg.jobId, job, {
            ok: false,
            status: job.internal.status,
            body: job.internal.body,
            latencyMs: Date.now() - job.internal.startedAt,
            error: msg.message,
          });
          break;
        }
        if (job) {
          if (!job.headWritten) job.res!.writeHead(502, { "content-type": "application/json" });
          job.res!.end(JSON.stringify({ error: { message: msg.message } }));
          jobs.delete(msg.jobId);
          const n = nodes.get(job.nodeId);
          if (n) n.inflight = Math.max(0, n.inflight - 1);
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    if (nodeId) {
      nodes.delete(nodeId);
      console.log(`[node] disconnected ${nodeId}`);
    }
  });
});

// Reap dead nodes that stopped heart-beating.
setInterval(() => {
  const now = Date.now();
  for (const [id, n] of nodes) {
    if (now - n.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      try { n.ws.terminate(); } catch {}
      nodes.delete(id);
      console.log(`[node] reaped ${id} (no heartbeat)`);
    }
  }
}, HEARTBEAT_TIMEOUT_MS).unref();

// Availability sampling (R1): once a minute, record whether each known node is UP AND SERVING, so
// uptime reflects the share of time a node was actually available — not just a pass rate among the
// nodes that happened to be online. "Up" = a live socket whose engine is currently serving; "down"
// = offline (stopped/unreachable), OR connected but failing probes. Offline nodes that were genuinely
// active recently are sampled as down for a retention window (so stopping a node degrades it), then
// age off the board. The window is keyed on real activity, so down-samples can't keep a dead node
// alive forever.
// UPTIME_SAMPLE_MS is imported from the points module so the sweep cadence and the scoring's
// samples-per-epoch always agree (changing one without the other would skew every node's points).
const UPTIME_RETAIN_MS = Number(process.env.UPTIME_RETAIN_MS ?? 2 * 24 * 60 * 60 * 1000); // ~2 epochs
// Grace window after a node's FIRST connect: downtime in this window isn't counted, so the install
// churn (model pull, launchd service reload, first cold model load) doesn't tank a brand-new node's
// uptime. A node that's still setting up reads ~100%, as a fresh provider expects.
const UPTIME_WARMUP_MS = Number(process.env.UPTIME_WARMUP_MS ?? 10 * 60_000);

async function uptimeSweep(): Promise<void> {
  const now = Date.now();
  const warming = (id: string): boolean => {
    const t = nodeFirstConnect.get(id);
    return t !== undefined && now - t < UPTIME_WARMUP_MS;
  };
  const sampled = new Set<string>();
  // 1. Currently-connected wallet nodes: up iff the engine is serving — but during warmup, count up
  //    regardless (a node still loading its first model shouldn't read as downtime).
  for (const [id, n] of nodes) {
    if (!isValidSolanaAddress(n.owner)) continue; // only wallet-bound nodes accrue points
    sampled.add(id);
    points.record(newEvent({ nodeId: id, owner: n.owner, kind: "uptime", at: now, ok: n.serving || warming(id) }));
  }
  // 2. Recently-active but now-offline nodes: sample as DOWN so a stopped node loses uptime — unless
  //    it's a brand-new node still inside its warmup grace (skip entirely, don't punish setup churn).
  try {
    const recent = await points.recentlyActiveNodes(now - UPTIME_RETAIN_MS);
    for (const r of recent) {
      if (sampled.has(r.nodeId) || !isValidSolanaAddress(r.owner) || warming(r.nodeId)) continue;
      points.record(newEvent({ nodeId: r.nodeId, owner: r.owner, kind: "uptime", at: now, ok: false }));
    }
  } catch (e) {
    console.error("[uptime] sweep failed:", (e as Error).message);
  }
}

// ---------------------------------------------------------------- HTTP (customer) plane
function handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true, nodes: nodes.size, jobs: jobs.size, backends: backendCounts() });
  }
  if (req.method === "GET" && url.pathname === "/admin/ledger") {
    if (!isAdmin(req)) return json(res, 401, { error: { message: "admin auth required" } });
    settlement
      .summary()
      .then((s) => json(res, 200, s))
      .catch((e) => json(res, 500, { error: { message: String(e?.message ?? e) } }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/admin/ledger/recent") {
    if (!isAdmin(req)) return json(res, 401, { error: { message: "admin auth required" } });
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    settlement
      .recent(limit)
      .then((rows) => json(res, 200, { rows }))
      .catch((e) => json(res, 500, { error: { message: String(e?.message ?? e) } }));
    return;
  }
  // Admin blacklist (R3): list bans, or add/remove one. add() also force-disconnects the wallet's
  // live nodes. Gated by ADMIN_TOKEN like the other /admin JSON endpoints.
  if (req.method === "GET" && url.pathname === "/admin/blacklist") {
    if (!isAdmin(req)) return json(res, 401, { error: { message: "admin auth required" } });
    return json(res, 200, { banned: blacklist.list() });
  }
  if (req.method === "POST" && url.pathname === "/admin/blacklist") {
    if (!isAdmin(req)) return json(res, 401, { error: { message: "admin auth required" } });
    return readJson(req, res, async (b) => {
      const owner = String(b.owner ?? "");
      const action = String(b.action ?? "add");
      if (!isValidSolanaAddress(owner)) return json(res, 400, { error: { message: "invalid account address" } });
      if (action === "remove") {
        blacklist.remove(owner);
        authFailStrikes.delete(owner);
      } else {
        blacklist.add(owner, String(b.reason ?? "manual"), Date.now());
        disconnectOwner(owner);
      }
      return json(res, 200, { ok: true, banned: blacklist.list() });
    });
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    const models = new Map<string, { id: string; owned_by: string }>();
    for (const n of nodes.values())
      for (const m of n.caps.models) models.set(m, { id: m, owned_by: "koretex" });
    return json(res, 200, { object: "list", data: [...models.values()] });
  }
  // Network-wide live models with per-model node count + price (powers the public /models page).
  if (req.method === "GET" && url.pathname === "/models/live") {
    return json(res, 200, { models: liveModels(), nodes: nodes.size, creditsPerUsdc: CREDITS_PER_USDC });
  }
  // What a given model pays (Tier 2): the rate the system WOULD bill/credit for any tag — including
  // an off-catalog one (falls back to the default). Lets `koretex models` show earnings before a pull.
  if (req.method === "GET" && url.pathname === "/models/rate") {
    const tag = url.searchParams.get("tag") ?? "";
    if (!tag) return json(res, 400, { error: { message: "tag required" } });
    const creditsPerMTok = pricing.rate(tag);
    return json(res, 200, {
      tag,
      creditsPerMTok,
      usdPerMTok: creditsPerMTok / CREDITS_PER_USDC,
      pointsWeight: modelWeight(tag),
      priced: pricing.isPriced(tag), // false → currently billed at the default rate
      defaultCreditsPerMTok: pricing.defaultRate,
      creditsPerUsdc: CREDITS_PER_USDC,
    });
  }
  // Network-wide demand per model (powers the public Demand tab). Merges realized demand (jobs +
  // tokens from the ledger over a window) with live supply (nodes serving), the current price, and
  // any provider-proposed prices. ?days=N (1–90, default 7).
  if (req.method === "GET" && url.pathname === "/models/demand") {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 7));
    const since = Date.now() - days * 86_400_000;
    Promise.all([settlement.demandByModel(since), modelPricing.proposals()])
      .then(([demand, proposals]) => {
        const supply = new Map<string, number>();
        for (const n of nodes.values())
          for (const m of n.caps.models) { const k = m.toLowerCase(); supply.set(k, (supply.get(k) ?? 0) + 1); }
        const dMap = new Map(demand.map((d) => [d.model, d]));
        const pMap = new Map(proposals.map((p) => [p.model, p]));
        const catMeta = new Map(MODELS.map((m) => [m.tag.toLowerCase(), m]));
        const ids = new Set<string>([...dMap.keys(), ...supply.keys(), ...pMap.keys()]);
        const models = [...ids]
          .map((id) => {
            const d = dMap.get(id);
            const p = pMap.get(id);
            const cat = catMeta.get(id);
            const credits = pricing.rate(id);
            return {
              model: id,
              name: cat?.name ?? id,
              curated: !!cat, // in our shortlist vs. community-served
              jobs: d?.jobs ?? 0,
              completionTokens: d?.completionTokens ?? 0,
              nodes: supply.get(id) ?? 0,
              creditsPerMTok: credits,
              usdPerMTok: credits / CREDITS_PER_USDC,
              priced: pricing.isPriced(id),
              pointsWeight: modelWeight(id),
              proposedCreditsAvg: p?.avgCreditsPerMTok ?? null,
              proposedUsdAvg: p ? p.avgCreditsPerMTok / CREDITS_PER_USDC : null,
              proposals: p?.count ?? 0,
            };
          })
          .sort((a, b) => b.completionTokens - a.completionTokens || b.nodes - a.nodes || a.model.localeCompare(b.model));
        json(res, 200, { windowDays: days, creditsPerUsdc: CREDITS_PER_USDC, models });
      })
      .catch((e) => json(res, 500, { error: { message: String(e?.message ?? e) } }));
    return;
  }
  // A provider suggests a price for a model they serve (advisory only — the model keeps earning its
  // current/default rate until an admin sets it). Shows up as "requested price" on the Demand tab.
  if (req.method === "POST" && url.pathname === "/models/propose-price") {
    return readJson(req, res, async (b) => {
      const model = String(b.model ?? "").trim();
      const creditsPerMTok = Math.round(Number(b.creditsPerMTok));
      const wallet = String(b.wallet ?? "").trim();
      if (!model) return json(res, 400, { error: { message: "model required" } });
      if (!(creditsPerMTok > 0) || creditsPerMTok > 10_000_000)
        return json(res, 400, { error: { message: "creditsPerMTok must be a positive integer (credits per 1M tokens)" } });
      await modelPricing.addProposal(model, creditsPerMTok, wallet, Date.now());
      console.log(`[model-pricing] proposal ${model} = ${creditsPerMTok} credits/1M${wallet ? ` by ${wallet.slice(0, 8)}…` : ""}`);
      return json(res, 200, { ok: true, model: model.toLowerCase(), creditsPerMTok, note: "advisory — billed at current/default rate until an operator sets it" });
    });
  }
  // Unified tabbed app — serves every user-facing surface (dashboard, credits, models, leaderboard,
  // points, run-a-node). The app selects the tab from the path/hash. JSON + machine routes
  // (/leaderboard/data, /models/live, /connect, /admin) are exact-matched separately below.
  if (req.method === "GET" && APP_PATHS.has(url.pathname)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(APP_HTML);
  }
  // Leaderboard JSON (aggregated to the wallet). ?epoch=N for a single epoch (default: all-time
  // rolling window), ?limit=N (default 100).
  // The live scoring constants — powers the in-app points estimator so it never drifts from the
  // real formula. Public + cacheable.
  if (req.method === "GET" && url.pathname === "/points/params") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" });
    return res.end(JSON.stringify(FORMULA_PARAMS));
  }
  if (req.method === "GET" && url.pathname === "/leaderboard/data") {
    const epochParam = url.searchParams.get("epoch");
    const epoch = epochParam == null ? undefined : Number(epochParam);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const now = Date.now();
    points
      // Over-fetch then drop banned wallets (R3), so a ban removes them from the public board.
      .leaderboard({ epoch, limit: limit + 50, now })
      .then((rows) => {
        const visible = rows.filter((r) => !blacklist.has(r.owner)).slice(0, limit);
        visible.forEach((r, i) => (r.rank = i + 1));
        json(res, 200, { epoch: epoch ?? null, currentEpoch: epochOf(now), rows: visible });
      })
      .catch((e) => json(res, 500, { error: { message: String(e?.message ?? e) } }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    return handleChat(req, res);
  }

  // ---- Provider pairing (P2): "connect your wallet once" ----------------------
  // Agent starts a pairing; gets a code (for the human) + claimSecret (kept private).
  if (req.method === "POST" && url.pathname === "/provider/pair/init") {
    const { pairingCode, claimSecret } = pairing.init(Date.now());
    const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
    const connectUrl = `${proto}://${req.headers.host}/connect?code=${pairingCode}`;
    return json(res, 200, { pairingCode, claimSecret, connectUrl });
  }
  // The Phantom-connect web page.
  if (req.method === "GET" && url.pathname === "/connect") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(CONNECT_HTML);
  }
  // Operator admin console — page is public HTML; the data behind it needs the ADMIN_WALLET.
  if (req.method === "GET" && url.pathname === "/admin") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(ADMIN_HTML);
  }
  // Admin data, gated by a signature from ADMIN_WALLET (network-wide ledger + recent rows).
  if (req.method === "POST" && url.pathname === "/admin/data") {
    return readJson(req, res, async (b) => {
      const pubkey = String(b.pubkey ?? "");
      const nonce = String(b.nonce ?? "");
      const signature = String(b.signature ?? "");
      if (!ADMIN_WALLET) return json(res, 403, { error: { message: "admin console not configured (set ADMIN_WALLET)" } });
      if (!challenges.consume(nonce, Date.now()))
        return json(res, 401, { error: { message: "challenge expired — reload and try again" } });
      if (!verifyWalletSignature(pubkey, buildAdminMessage(nonce), signature))
        return json(res, 401, { error: { message: "signature verification failed" } });
      if (pubkey !== ADMIN_WALLET)
        return json(res, 403, { error: { message: "this account is not the operator" } });
      const now = Date.now();
      const liveSet = new Set(nodes.keys());
      const inventory = (await points.nodeInventory(now)).map((r) => ({
        ...r,
        live: liveSet.has(r.nodeId),
        idleDays: epochOf(now) - r.lastEpoch,
      }));
      return json(res, 200, {
        summary: await settlement.summary(),
        recent: await settlement.recent(100),
        fleet: fleet(),
        inventory,
        currentEpoch: epochOf(now),
      });
    });
  }
  // Operator action: scrub a node's points/reputation data (a ghost/duplicate identity). Force-
  // disconnects it first if live. Gated by an ADMIN_WALLET signature, exactly like /admin/data.
  if (req.method === "POST" && url.pathname === "/admin/remove-node") {
    return readJson(req, res, async (b) => {
      const pubkey = String(b.pubkey ?? "");
      const nonce = String(b.nonce ?? "");
      const signature = String(b.signature ?? "");
      const nodeId = String(b.nodeId ?? "");
      if (!ADMIN_WALLET) return json(res, 403, { error: { message: "admin console not configured (set ADMIN_WALLET)" } });
      if (!challenges.consume(nonce, Date.now()))
        return json(res, 401, { error: { message: "challenge expired — reload and try again" } });
      if (!verifyWalletSignature(pubkey, buildAdminMessage(nonce), signature))
        return json(res, 401, { error: { message: "signature verification failed" } });
      if (pubkey !== ADMIN_WALLET)
        return json(res, 403, { error: { message: "this account is not the operator" } });
      if (!nodeId) return json(res, 400, { error: { message: "nodeId required" } });
      // Drop the live socket first so it can't re-register mid-scrub.
      const live = nodes.get(nodeId);
      if (live) { try { live.ws.close(); } catch {} nodes.delete(nodeId); }
      const removed = await points.removeNode(nodeId);
      console.log(`[admin] scrubbed node ${nodeId} (${removed} summary row(s)${live ? ", was live" : ""})`);
      return json(res, 200, { ok: true, nodeId, removed });
    });
  }
  // Operator: set (or clear) a model's price. Persisted AND applied live to the Pricing book, so it
  // takes effect immediately — no redeploy. Send creditsPerMTok > 0 to set; null/0 to clear (model
  // falls back to prices.json / default). Gated by an ADMIN_WALLET signature like the others.
  if (req.method === "POST" && url.pathname === "/admin/price") {
    return readJson(req, res, async (b) => {
      const pubkey = String(b.pubkey ?? "");
      const nonce = String(b.nonce ?? "");
      const signature = String(b.signature ?? "");
      const model = String(b.model ?? "").trim();
      const raw = b.creditsPerMTok;
      if (!ADMIN_WALLET) return json(res, 403, { error: { message: "admin console not configured (set ADMIN_WALLET)" } });
      if (!challenges.consume(nonce, Date.now()))
        return json(res, 401, { error: { message: "challenge expired — reload and try again" } });
      if (!verifyWalletSignature(pubkey, buildAdminMessage(nonce), signature))
        return json(res, 401, { error: { message: "signature verification failed" } });
      if (pubkey !== ADMIN_WALLET)
        return json(res, 403, { error: { message: "this account is not the operator" } });
      if (!model) return json(res, 400, { error: { message: "model required" } });
      const clearing = raw == null || Number(raw) === 0;
      if (clearing) {
        await modelPricing.clearOverride(model);
        pricing.clearOverride(model);
        console.log(`[admin] cleared price override for ${model}`);
        return json(res, 200, { ok: true, model: model.toLowerCase(), creditsPerMTok: pricing.rate(model), cleared: true });
      }
      const creditsPerMTok = Math.round(Number(raw));
      if (!(creditsPerMTok > 0) || creditsPerMTok > 10_000_000)
        return json(res, 400, { error: { message: "creditsPerMTok must be a positive integer (credits per 1M tokens), or null to clear" } });
      await modelPricing.setOverride(model, creditsPerMTok, pubkey, Date.now());
      pricing.setOverride(model, creditsPerMTok);
      console.log(`[admin] set price ${model} = ${creditsPerMTok} credits/1M`);
      return json(res, 200, { ok: true, model: model.toLowerCase(), creditsPerMTok });
    });
  }
  // Operator-only revoke: kill a LIVE node's token and drop its socket so it can't reconnect until
  // the owner re-installs. (Moved off the provider dashboard — too easy to misfire there.) Targets a
  // connected node because the token to revoke is only known from the live socket.
  if (req.method === "POST" && url.pathname === "/admin/revoke-node") {
    return readJson(req, res, async (b) => {
      const pubkey = String(b.pubkey ?? "");
      const nonce = String(b.nonce ?? "");
      const signature = String(b.signature ?? "");
      const nodeId = String(b.nodeId ?? "");
      if (!ADMIN_WALLET) return json(res, 403, { error: { message: "admin console not configured (set ADMIN_WALLET)" } });
      if (!challenges.consume(nonce, Date.now()))
        return json(res, 401, { error: { message: "challenge expired — reload and try again" } });
      if (!verifyWalletSignature(pubkey, buildAdminMessage(nonce), signature))
        return json(res, 401, { error: { message: "signature verification failed" } });
      if (pubkey !== ADMIN_WALLET)
        return json(res, 403, { error: { message: "this account is not the operator" } });
      if (!nodeId) return json(res, 400, { error: { message: "nodeId required" } });
      const node = nodes.get(nodeId);
      if (!node) return json(res, 404, { error: { message: "no such live node (revoke targets a connected node)" } });
      if (node.token) await providerStore.revokeToken(node.token); // dead token — can't reconnect
      try { node.ws.close(4403, "revoked"); } catch {}
      nodes.delete(nodeId);
      console.log(`[admin] revoked node ${nodeId} (owner ${node.owner.slice(0, 8)}…)`);
      return json(res, 200, { ok: true, nodeId });
    });
  }
  // Issue a single-use nonce. `?for=enroll` mints a node token; `?for=admin` opens the console;
  // default = view dashboard.
  if (req.method === "GET" && url.pathname === "/provider/challenge") {
    const nonce = challenges.issue(Date.now());
    const purpose = url.searchParams.get("for");
    const message =
      purpose === "enroll"
        ? buildEnrollMessage(nonce)
        : purpose === "admin"
          ? buildAdminMessage(nonce)
          : purpose === "revoke"
            ? buildRevokeMessage(nonce, url.searchParams.get("node") ?? "")
            : purpose === "credits"
              ? buildCreditsMessage(nonce)
              : buildDashboardMessage(nonce);
    return json(res, 200, { nonce, message });
  }
  // Website-first enrollment: verify the signed nonce, mint a wallet-bound node token.
  if (req.method === "POST" && url.pathname === "/provider/enroll") {
    return readJson(req, res, async (b) => {
      const pubkey = String(b.pubkey ?? "");
      const nonce = String(b.nonce ?? "");
      const signature = String(b.signature ?? "");
      if (!isValidSolanaAddress(pubkey))
        return json(res, 400, { error: { message: "invalid account address" } });
      if (!challenges.consume(nonce, Date.now()))
        return json(res, 401, { error: { message: "challenge expired — reload and try again" } });
      if (!verifyWalletSignature(pubkey, buildEnrollMessage(nonce), signature))
        return json(res, 401, { error: { message: "signature verification failed" } });
      await providerStore.upsertProvider(pubkey);
      const token = await providerStore.mintToken(pubkey, "website");
      return json(res, 200, { token, address: pubkey });
    });
  }
  // Verify the signed nonce, then return that wallet's stats (metadata only, never payload).
  if (req.method === "POST" && url.pathname === "/provider/stats") {
    return readJson(req, res, async (b) => {
      const pubkey = String(b.pubkey ?? "");
      const nonce = String(b.nonce ?? "");
      const signature = String(b.signature ?? "");
      if (!isValidSolanaAddress(pubkey))
        return json(res, 400, { error: { message: "invalid account address" } });
      if (!challenges.consume(nonce, Date.now()))
        return json(res, 401, { error: { message: "challenge expired — reload and try again" } });
      if (!verifyWalletSignature(pubkey, buildDashboardMessage(nonce), signature))
        return json(res, 401, { error: { message: "signature verification failed" } });
      await ensureWelcomeCredits(pubkey); // node operators get welcome credits too (to test inference)
      const stats = await settlement.providerStats(pubkey);
      // Include the wallet's points (R2) in the same signed response — no extra signature prompt.
      const pts = await points.pointsFor(pubkey, { now: Date.now() });
      const creditsEarned = await creditStore.earned(pubkey); // realised credits from serving inference
      // Open a session so the dashboard can poll /points/live for real-time updates WITHOUT
      // prompting another signature on each refresh.
      const { token: session, expiresAt } = sessions.issue(pubkey, Date.now());
      return json(res, 200, { ...stats, creditsEarned, liveNodes: liveNodesFor(pubkey), points: pts, session, sessionExpiresAt: expiresAt });
    });
  }
  // Real-time personal points (R2): poll-friendly, session-gated (no per-poll signature), returns
  // ONLY this wallet's data — a single-owner query, so watching your own points is cheap and private.
  if (req.method === "POST" && url.pathname === "/points/live") {
    return readJson(req, res, async (b) => {
      const pubkey = String(b.pubkey ?? "");
      const session = String(b.session ?? "");
      if (sessions.resolve(session, Date.now()) !== pubkey)
        return json(res, 401, { error: { message: "session expired — reload to sign in again" } });
      const pts = await points.pointsFor(pubkey, { now: Date.now() });
      return json(res, 200, { points: pts, liveNodes: liveNodesFor(pubkey), at: Date.now() });
    });
  }
  // One wallet's points + per-node breakdown (R0), wallet-gated like /provider/stats. Metadata only.
  if (req.method === "POST" && url.pathname === "/points/stats") {
    return readJson(req, res, async (b) => {
      const pubkey = String(b.pubkey ?? "");
      const nonce = String(b.nonce ?? "");
      const signature = String(b.signature ?? "");
      const epoch = b.epoch == null ? undefined : Number(b.epoch);
      if (!isValidSolanaAddress(pubkey))
        return json(res, 400, { error: { message: "invalid account address" } });
      if (!challenges.consume(nonce, Date.now()))
        return json(res, 401, { error: { message: "challenge expired — reload and try again" } });
      if (!verifyWalletSignature(pubkey, buildDashboardMessage(nonce), signature))
        return json(res, 401, { error: { message: "signature verification failed" } });
      const stats = await points.pointsFor(pubkey, { epoch, now: Date.now() });
      return json(res, 200, stats);
    });
  }
  // Revoke (deactivate) one of the wallet's live nodes: invalidate its token + disconnect it.
  if (req.method === "POST" && url.pathname === "/provider/revoke") {
    return readJson(req, res, async (b) => {
      const pubkey = String(b.pubkey ?? "");
      const nonce = String(b.nonce ?? "");
      const nodeId = String(b.nodeId ?? "");
      const signature = String(b.signature ?? "");
      if (!isValidSolanaAddress(pubkey))
        return json(res, 400, { error: { message: "invalid account address" } });
      if (!challenges.consume(nonce, Date.now()))
        return json(res, 401, { error: { message: "challenge expired — reload and try again" } });
      if (!verifyWalletSignature(pubkey, buildRevokeMessage(nonce, nodeId), signature))
        return json(res, 401, { error: { message: "signature verification failed" } });
      const node = nodes.get(nodeId);
      if (!node || node.owner !== pubkey)
        return json(res, 404, { error: { message: "no such live node for this account" } });
      if (node.token) await providerStore.revokeToken(node.token); // can't reconnect
      try { node.ws.close(4403, "revoked"); } catch {}
      nodes.delete(nodeId);
      console.log(`[node] revoked ${nodeId} by owner ${pubkey.slice(0, 8)}…`);
      return json(res, 200, { ok: true });
    });
  }
  // ---- Credits / payments (M4 money-in) ---------------------------------------------------
  // What the buy page needs to build a USDC transfer (all public values).
  if (req.method === "GET" && url.pathname === "/credits/config") {
    return json(res, 200, {
      adminWallet: ADMIN_FEE_WALLET,
      usdcMint: USDC_MINT,
      creditsPerUsdc: CREDITS_PER_USDC,
      rpc: "/solana/rpc",
    });
  }
  // Fast path: the customer just sent USDC and hands us the tx signature. We verify it on-chain
  // (the signature, not the browser's word, is the proof) and credit — idempotently. No signed
  // message needed: the deposit must come FROM this wallet, which only its owner could have signed.
  if (req.method === "POST" && url.pathname === "/credits/verify") {
    return readJson(req, res, async (b) => {
      const pubkey = String(b.pubkey ?? "");
      const signature = String(b.signature ?? "");
      if (!isValidSolanaAddress(pubkey))
        return json(res, 400, { error: { message: "invalid account address" } });
      if (!signature) return json(res, 400, { error: { message: "signature required" } });
      const v = await verifier.verifyDeposit(signature);
      if (!v.ok) return json(res, 400, { error: { message: v.reason } });
      // Credit the payer only. Guards against claiming someone else's deposit.
      if (v.from !== pubkey)
        return json(res, 400, {
          error: { message: "this payment was not sent from your account (or isn't attributable yet — try Refresh in a moment)" },
        });
      const credits = creditsFor(v.usdcRaw);
      const credited = await creditStore.recordPurchase({
        signature, wallet: pubkey, usdcRaw: v.usdcRaw, credits, slot: v.slot, blockTime: v.blockTime, at: Date.now(),
      });
      const balance = await creditStore.balance(pubkey);
      return json(res, 200, { credited, alreadyRecorded: !credited, credits, usdc: v.usdcRaw / 1e6, balance });
    });
  }
  // Backstop: re-scan the fee wallet's recent USDC deposits and credit any of THIS wallet's that
  // we haven't recorded yet (heals a fast-path write lost to a network blip). Wallet-gated so a
  // wallet can only sweep + see its own deposits. Idempotent via the signature key.
  // Open a wallet session: sign one challenge → bearer token reused for the TTL (so the
  // balance/refresh/key endpoints below don't re-prompt for a signature on every call).
  if (req.method === "POST" && url.pathname === "/credits/session") {
    return readJson(req, res, async (b) => {
      const pubkey = String(b.pubkey ?? "");
      const nonce = String(b.nonce ?? "");
      const signature = String(b.signature ?? "");
      if (!isValidSolanaAddress(pubkey))
        return json(res, 400, { error: { message: "invalid account address" } });
      if (!challenges.consume(nonce, Date.now()))
        return json(res, 401, { error: { message: "challenge expired — reload and try again" } });
      if (!verifyWalletSignature(pubkey, buildCreditsMessage(nonce), signature))
        return json(res, 401, { error: { message: "signature verification failed" } });
      await ensureWelcomeCredits(pubkey); // first credits/playground touch — seed welcome credits
      const { token, expiresAt } = sessions.issue(pubkey, Date.now());
      return json(res, 200, { token, expiresAt });
    });
  }
  if (req.method === "POST" && url.pathname === "/credits/refresh") {
    return readJson(req, res, async (b) => {
      const pubkey = authCreditsWallet(res, b);
      if (!pubkey) return;
      let found = 0;
      try {
        const sigs = await verifier.incomingDeposits(50);
        for (const sig of sigs) {
          if (await creditStore.has(sig)) continue; // already credited — skip the RPC round-trip
          const v = await verifier.verifyDeposit(sig);
          if (!v.ok || v.from !== pubkey) continue; // not this wallet's deposit
          const credits = creditsFor(v.usdcRaw);
          if (credits <= 0) continue;
          if (await creditStore.recordPurchase({
            signature: sig, wallet: pubkey, usdcRaw: v.usdcRaw, credits, slot: v.slot, blockTime: v.blockTime, at: Date.now(),
          })) found++;
        }
      } catch (e: any) {
        return json(res, 502, { error: { message: `could not reach the payment network: ${e?.message ?? e}` } });
      }
      const balance = await creditStore.balance(pubkey);
      const purchases = await creditStore.purchases(pubkey, 25);
      const keys = await customerStore.keysFor(pubkey);
      return json(res, 200, { found, balance, purchases, keys });
    });
  }
  // A wallet's current balance + recent purchases (wallet-gated).
  if (req.method === "POST" && url.pathname === "/credits/balance") {
    return readJson(req, res, async (b) => {
      const pubkey = authCreditsWallet(res, b);
      if (!pubkey) return;
      await ensureWelcomeCredits(pubkey); // ensure the welcome grant is applied before we read it
      const balance = await creditStore.balance(pubkey);
      const purchases = await creditStore.purchases(pubkey, 25);
      const keys = await customerStore.keysFor(pubkey);
      return json(res, 200, { balance, purchases, keys });
    });
  }
  // Mint a wallet-bound inference API key (shown once). Wallet-gated via the credits session.
  if (req.method === "POST" && url.pathname === "/customer/key") {
    return readJson(req, res, async (b) => {
      const pubkey = authCreditsWallet(res, b);
      if (!pubkey) return;
      const key = await customerStore.mintKey(pubkey, "web");
      return json(res, 200, { key });
    });
  }
  // RPC proxy: lets the browser build/submit transactions without ever seeing the Helius API key.
  // Only a whitelist of read/submit methods is forwarded.
  if (req.method === "POST" && url.pathname === "/solana/rpc") {
    return readJson(req, res, async (b) => {
      const method = String(b?.method ?? "");
      if (!RPC_PROXY_METHODS.has(method))
        return json(res, 403, { error: { message: `RPC method '${method}' not allowed` } });
      const r = await fetch(SOLANA_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b),
      });
      const text = await r.text();
      res.writeHead(r.status, { "content-type": "application/json" });
      return res.end(text);
    });
  }

  // Model catalog. Plain JSON for the web; ?format=text&ram=&disk= → fitting models for the installer.
  if (req.method === "GET" && url.pathname === "/models/catalog") {
    const ram = Number(url.searchParams.get("ram"));
    const disk = Number(url.searchParams.get("disk"));
    let models = MODELS;
    if (ram) models = models.filter((m) => m.minRamGb <= ram);
    if (disk) models = models.filter((m) => m.sizeGb + 10 <= disk); // headroom for context + a 2nd model
    // primary first, then grouped by type (text → vision → code), then smallest-to-largest
    const typeRank: Record<string, number> = { text: 0, vision: 1, code: 2 };
    models = [...models].sort(
      (a, b) =>
        (b.primary ? 1 : 0) - (a.primary ? 1 : 0) ||
        (typeRank[a.type ?? "text"] ?? 9) - (typeRank[b.type ?? "text"] ?? 9) ||
        a.sizeGb - b.sizeGb,
    );
    // Join each model with its points weight (v2 size multiplier) + price, so the installer, the CLI,
    // and the web estimator all show "which models pay best" from one source of truth.
    const priced = models.map((m) => ({
      ...m,
      pointsWeight: modelWeight(m.tag),
      creditsPerMTok: pricing.rate(m.tag),
      usdPerMTok: pricing.rate(m.tag) / CREDITS_PER_USDC,
    }));
    if (url.searchParams.get("format") === "text") {
      // Pipe-delimited rows: tag|name|sizeGb|type|minRamGb|caps|pointsWeight|creditsPerMTok
      // (caps = comma-joined badges). Consumed by install.sh and `koretex models`; append fields at
      // the end, never reorder.
      const body = priced
        .map((m) => `${m.tag}|${m.name}|${m.sizeGb}|${m.type ?? "text"}|${m.minRamGb}|${(m.tags ?? []).join(",")}|${m.pointsWeight.toFixed(2)}|${m.creditsPerMTok}`)
        .join("\n");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(body ? body + "\n" : "");
    }
    return json(res, 200, { models: priced, creditsPerUsdc: CREDITS_PER_USDC });
  }
  // One-command installer + its pieces (served same-origin; no extra hosting).
  if (req.method === "GET" && url.pathname === "/install") {
    return serveText(res, INSTALL_SH, "text/x-shellscript; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/preflight") {
    return serveText(res, PREFLIGHT_SH, "text/x-shellscript; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/agent.js") {
    return serveText(res, AGENT_BUNDLE, "application/javascript; charset=utf-8");
  }
  // Phantom wallet bundle + its public config. The bundle is the same for every page; pages import
  // it and drive window.KoretexWallet. The config carries only the public app id.
  if (req.method === "GET" && url.pathname === "/wallet.js") {
    return serveText(res, WALLET_BUNDLE, "application/javascript; charset=utf-8");
  }
  // Brand icon (Koretex logo) — used as the favicon + nav mark across the app.
  if (req.method === "GET" && (url.pathname === "/koretex-favicon.svg" || url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg")) {
    res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" });
    return res.end(FAVICON_SVG);
  }
  if (req.method === "GET" && url.pathname === "/wallet/config") {
    return json(res, 200, { appId: PHANTOM_APP_ID });
  }
  // OAuth landing page for Google login. The embedded SDK finishes the handshake here (autoConnect
  // reads the redirect params), then we bounce the user back to wherever they started.
  if (req.method === "GET" && url.pathname === "/auth/callback") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(AUTH_CALLBACK_HTML);
  }
  // The page fetches the exact message the wallet must sign for this code.
  if (req.method === "GET" && url.pathname === "/provider/pair/message") {
    const message = pairing.messageFor(url.searchParams.get("code") ?? "");
    if (!message) return json(res, 404, { error: { message: "unknown or expired pairing code" } });
    return json(res, 200, { message });
  }
  // The page submits the wallet's signature; we verify it and mint a token.
  if (req.method === "POST" && url.pathname === "/provider/pair/confirm") {
    return readJson(req, res, async (b) => {
      const r = await pairing.confirm(
        String(b.pairingCode ?? b.code ?? ""),
        String(b.pubkey ?? ""),
        String(b.signature ?? ""),
      );
      return json(res, r.ok ? 200 : 400, r);
    });
  }
  // The agent polls (with its claimSecret) until the token is ready.
  if (req.method === "GET" && url.pathname === "/provider/pair/poll") {
    return json(
      res,
      200,
      pairing.poll(url.searchParams.get("code") ?? "", url.searchParams.get("secret") ?? ""),
    );
  }

  return json(res, 404, { error: { message: "not found" } });
}

function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  const auth = req.headers["authorization"] ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    // Identity: a static CUSTOMER_KEYS entry is a legacy/unmetered key (kept for the e2e + demo);
    // otherwise resolve a wallet-bound customer key → the wallet we'll bill. Unknown key → 401.
    let customerWallet: string | null = null;
    if (!CUSTOMER_KEYS.has(key)) {
      customerWallet = key ? await customerStore.resolveKey(key) : null;
      if (!customerWallet) return json(res, 401, { error: { message: "invalid api key" } });
    }

    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(res, 400, { error: { message: "invalid json" } });
    }
    const model = parsed?.model;
    if (typeof model !== "string")
      return json(res, 400, { error: { message: "model required" } });

    // Metered callers must have credits. Pre-admission check (final cost is trued-up on completion;
    // a single large request can run a balance slightly negative — acceptable for the pilot).
    if (customerWallet) {
      const bal = await creditStore.balance(customerWallet);
      if (bal <= 0)
        return json(res, 402, { error: { message: "insufficient credits — top up at /credits", type: "insufficient_credits" } });
    }

    const node = pickNode(model);
    if (!node)
      return json(res, 503, { error: { message: `no node available for model '${model}'` } });

    const jobId = randomUUID();
    node.inflight++;
    jobs.set(jobId, { res, nodeId: node.caps.nodeId, owner: node.owner, customerKey: key, customerWallet, model, headWritten: false });

    // If the customer disconnects, free the slot.
    res.on("close", () => {
      if (jobs.delete(jobId)) node.inflight = Math.max(0, node.inflight - 1);
    });

    send(node.ws, { t: "job", jobId, body: parsed });
    console.log(`[job] ${jobId} -> ${node.caps.nodeId} model=${model}${customerWallet ? ` metered(${customerWallet.slice(0, 6)}…)` : ""}`);
  });
}

/** Best-effort completion-token count from an OpenAI response body (used when a node's `done`
 *  message omits usage — e.g. some non-streaming paths). Returns undefined if not parseable. */
function parseCompletionTokens(body: string): number | undefined {
  try {
    const u = JSON.parse(body)?.usage;
    const ct = u?.completion_tokens ?? u?.completionTokens;
    return typeof ct === "number" ? ct : undefined;
  } catch {
    return undefined;
  }
}

function json(res: http.ServerResponse, status: number, obj: unknown) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(s);
}

// Closed by default: /admin/* (which exposes customer keys) is denied unless ADMIN_TOKEN is
// set AND presented. Forgetting to configure it fails safe (locked), not open.
function isAdmin(req: http.IncomingMessage): boolean {
  if (!ADMIN_TOKEN) return false;
  return (req.headers["authorization"] ?? "") === `Bearer ${ADMIN_TOKEN}`;
}

// Serve a static text asset, or 404 if it wasn't built/copied into the image.
function serveText(res: http.ServerResponse, body: string | null, contentType: string) {
  if (body == null) return json(res, 404, { error: { message: "not available" } });
  res.writeHead(200, { "content-type": contentType });
  res.end(body);
}

// Read a JSON request body, then hand it to `cb`. Errors → 400/500, never an unhandled throw.
function readJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cb: (body: any) => unknown,
) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed: any;
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      return json(res, 400, { error: { message: "invalid json" } });
    }
    Promise.resolve(cb(parsed)).catch((e) =>
      json(res, 500, { error: { message: String(e?.message ?? e) } }),
    );
  });
}

async function start() {
  // Create tables before accepting traffic so the first job/pairing can be recorded.
  if (settlement.init) await settlement.init();
  if (providerStore.init) await providerStore.init();
  if (creditStore.init) await creditStore.init();
  if (customerStore.init) await customerStore.init();
  if (points.init) await points.init();
  if (modelPricing.init) await modelPricing.init();
  // Load admin price overrides into the live Pricing book so they apply without a redeploy.
  try {
    const ov = await modelPricing.overrides();
    for (const o of ov) pricing.setOverride(o.model, o.creditsPerMTok);
    if (ov.length) console.log(`[model-pricing] loaded ${ov.length} admin price override(s)`);
  } catch (e) {
    console.error("[model-pricing] override load failed:", (e as Error).message);
  }
  // One-off: seed welcome credits for every wallet already known. Idempotent — safe on every boot.
  if (WELCOME_CREDITS && creditStore.seedWelcomeGrants) {
    try {
      const n = await creditStore.seedWelcomeGrants(WELCOME_CREDITS, Date.now());
      if (n > 0) console.log(`[credits] seeded ${WELCOME_CREDITS} welcome credits to ${n} existing wallet(s)`);
    } catch (e) {
      console.error("[credits] welcome seed failed:", (e as Error).message);
    }
  }
  await refreshReputation();
  setInterval(() => void refreshReputation(), REP_REFRESH_MS).unref();
  // Prune the raw points audit log on a TTL — the summary read model keeps the aggregates, so this
  // only frees storage. Default 30 days; set RAW_RETENTION_DAYS=0 to keep everything.
  const RAW_RETENTION_DAYS = Number(process.env.RAW_RETENTION_DAYS ?? 30);
  if (points.prune && RAW_RETENTION_DAYS > 0) {
    const pruneOnce = () =>
      points
        .prune!(Date.now() - RAW_RETENTION_DAYS * 86_400_000)
        .then((n) => n > 0 && console.log(`[points] pruned ${n} audit row(s) older than ${RAW_RETENTION_DAYS}d`))
        .catch((e) => console.error("[points] prune failed:", e?.message ?? e));
    void pruneOnce();
    setInterval(pruneOnce, 6 * 60 * 60 * 1000).unref(); // every 6h
  }
  if (process.env.PROBE_DISABLED !== "1") prober.start();
  // Availability sampling: feeds the uptime gate in the points calc (offline/idle nodes degrade).
  if (process.env.UPTIME_DISABLED !== "1") {
    setInterval(() => void uptimeSweep(), UPTIME_SAMPLE_MS).unref();
    console.log(`[uptime] availability sweep every ${UPTIME_SAMPLE_MS}ms`);
  }
  httpServer.listen(HTTP_PORT, () => {
    console.log(`dispatcher: HTTP+WS on :${HTTP_PORT}  (ws path ${WS_NODE_PATH})`);
    console.log(`customer keys (legacy/unmetered): ${[...CUSTOMER_KEYS].join(", ")}`);
    console.log(`ledger: ${process.env.DATABASE_URL ? "postgres" : "in-memory"}`);
    console.log(`credits: fee wallet ${ADMIN_FEE_WALLET ? ADMIN_FEE_WALLET.slice(0, 8) + "…" : "(unset — credit purchases disabled)"} @ ${CREDITS_PER_USDC} credits/USDC, commitment=${SOLANA_COMMITMENT}`);
    console.log(`pricing: default ${PRICE_BOOK.default} credits/1M tokens, ${Object.keys(PRICE_BOOK.models).length} model override(s)`);
  });
}

start().catch((e) => {
  console.error("fatal: failed to start dispatcher:", e);
  process.exit(1);
});
