// Points & reputation foundation (R-track, R0). The honest ledger under a growth leaderboard.
//
// Two ideas live here:
//  1) An APPEND-ONLY EVENT LOG. Every measurable thing a node does — a real job served, a
//     synthetic challenge result, an uptime sample, a benchmark, a penalty — is one immutable
//     row carrying the RAW measurement (not a derived score). Keeping raw signals means the
//     scoring formula can be re-run and re-tuned over all history later (R4 / "formula tuning"),
//     and a future retroactive token airdrop can be computed from the same log and defended.
//  2) A PURE, VERSIONED SCORING FUNCTION (`scoreNode`). Given a node's aggregated signals it
//     returns a transparent, explainable score. It is deliberately provisional: the constants
//     are tunable knobs, and FORMULA_VERSION is bumped whenever they change so historical
//     scores remain reproducible.
//
// Mirrors the SettlementProvider seam: an interface + in-memory impl (local/e2e) + a Postgres
// impl (prod). The data path only APPENDS events; scores are derived on read.
//
// IMPORTANT framing: nothing here promises payouts. Publicly this is ranks/tiers/badges. The
// ledger underneath is built as if real value will one day settle on it — because it might.

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------- epochs
// Points accrue per epoch so we can snapshot a fixed reward pool and reward *sustained* (not
// one-shot) contribution. Genesis is fixed so epoch indices are stable forever; pure callers
// pass `at` in (no Date.now here) to keep epochOf testable.
export const EPOCH_GENESIS_MS = 1735689600000; // 2025-01-01T00:00:00Z
export const EPOCH_MS = 24 * 60 * 60 * 1000; // 1 day

// Hide-after-grace: in the rolling all-time view (dashboard + leaderboard), a node is shown only
// while it has had activity within this many epochs of "now". Past that, a stopped or unreachable
// node drops off the board — instead of lingering forever AND letting its age-ramped score keep
// climbing while it contributes nothing. 1 epoch ⇒ ~24–48h grace, so a brief outage or the daily
// epoch rollover never flickers an online node (the prober probes it ~1/min) off the board.
export const ACTIVE_GRACE_EPOCHS = 1;

/** The epoch index a timestamp (ms) falls in. Monotonic from genesis. */
export function epochOf(atMs: number): number {
  return Math.floor((atMs - EPOCH_GENESIS_MS) / EPOCH_MS);
}

// ---------------------------------------------------------------- the event log
export type NodeEventKind =
  | "job" // a real customer job completed — the demand signal
  | "challenge" // a synthetic, indistinguishable-from-real probe result (R1 prober)
  | "uptime" // a reachability sample (R1)
  | "benchmark" // a sealed perf benchmark result (R1)
  | "penalty"; // a deduction — failed authenticity / fraud / manual slash (R3)

/**
 * One immutable measurement about a node at a point in time. All signal fields are optional and
 * kind-dependent; store RAW measurements, never derived points. Add fields, don't repurpose them.
 */
export interface NodeEvent {
  eventId: string;
  nodeId: string;
  /** Provider wallet (Solana address) — the identity that earns. Matches the ledger's `owner`. */
  owner: string;
  kind: NodeEventKind;
  /** ms since epoch — set by the caller (Node runtime), kept out of pure logic for testability. */
  at: number;

  /** Did the job/challenge succeed? (job/challenge/uptime) */
  ok?: boolean;
  /** true = a probe we injected; false/undefined = a real customer job. Only real jobs are demand. */
  synthetic?: boolean;
  /** Model exercised (job/challenge/benchmark). */
  model?: string;
  /** Did the output fingerprint match the reference model? (challenge authenticity check) */
  modelVerified?: boolean;
  /** Time-to-first-token / response latency, ms (job/challenge/benchmark). */
  latencyMs?: number;
  /** Measured throughput — a hardware capability signal you can't fake (challenge/benchmark). */
  tokensPerSec?: number;
  /** Work amount — completion tokens for a job, penalty magnitude for a penalty. */
  units?: number;
  /** Anything else, as JSON. Never prompt/response content (privacy invariant). */
  detail?: Record<string, unknown>;
  /** Prober signature over the canonical event (R4). null while the central oracle is trusted. */
  sig?: string | null;
}

/** Build an event with a fresh id; `at` supplied by the caller (the runtime layer). */
export function newEvent(ev: Omit<NodeEvent, "eventId">): NodeEvent {
  return { eventId: randomUUID(), ...ev };
}

// ---------------------------------------------------------------- aggregated signals → score
/** Per-node signals aggregated over an epoch (or rolling window) — the scorer's only input. */
export interface NodeSignals {
  nodeId: string;
  owner: string;
  /** Real customer jobs served (synthetic=false). */
  jobs: number;
  /** Total real work units served (sum of completion tokens) — the raw demand, shown as-is. */
  units: number;
  /** Σ(completion tokens × modelWeight(model)) — demand weighted by model size (v2). The scorer
   *  prefers this over `units`; 0/absent on un-backfilled rows, where it falls back to `units`. */
  weightedUnits?: number;
  /** Distinct models served with real demand — the diversity bonus. */
  uniqueModels: number;
  /** Synthetic challenges received / passed — the availability + correctness gate. */
  challenges: number;
  challengePasses: number;
  /** Fraction of authenticity-checked events whose output matched the reference model (0..1). */
  modelVerifiedRate: number;
  /** Mean measured throughput across challenges/benchmarks — the hardware capability signal. */
  avgTokensPerSec: number;
  /** Uptime samples taken / found reachable. */
  uptimeSamples: number;
  uptimeUp: number;
  /** Sum of penalty magnitudes applied this window. */
  penalties: number;
  /** Earliest event ms for this node — drives the trust ramp (node age). */
  firstSeen: number;
  /** Reference time (ms) for the age calc — supplied by the caller so scoring stays pure. */
  now: number;
  /** Pre-summed cumulative points, with trust LOCKED per epoch at the time credits were earned (so
   *  an offline node's banked points never re-scale as it ages). Set by the stores via
   *  signalsFromEpochs; when present, scoreNode uses it verbatim instead of the aggregate fallback. */
  cumulativePoints?: number;
}

/** A scored node, with a transparent breakdown so any rank can be explained / audited. */
export interface NodeScore {
  nodeId: string;
  owner: string;
  points: number;
  uptimeFactor: number; // [0,1] multiplicative availability gate
  hardwareCapability: number; // sqrt-curved measured throughput
  modelValue: number; // demand × diversity, gated by authenticity
  trustRamp: number; // [floor,1] node-age sybil tax (no-staking defense)
  /** Mean measured throughput (tokens/sec) — the raw signal behind hardwareCapability, surfaced
   *  for display ("live tok/s"). 0 until the prober has measured this node. */
  tokensPerSec: number;
  formulaVersion: number;
}

// --- tunable knobs (R-track: these get retuned in shadow mode before anything settles) ---------
export const FORMULA_VERSION = 3; // v3: penalties are capped per epoch to a fraction of that epoch's gross (a mistaken authenticity flag can no longer zero an honest node); v2: demand weighted by model size
const TRUST_RAMP_DAYS = 14; // a fresh identity ramps to full weight over ~2 weeks
const TRUST_FLOOR = 0.1; // brand-new nodes still earn a little (so they start climbing)
const HARDWARE_WEIGHT = 1.0; // scales sqrt(tokens/sec) into the additive term
const DIVERSITY_BONUS = 0.1; // per extra distinct model served with demand
const AUTH_FAIL_FLOOR = 0.05; // a node failing authenticity checks keeps almost no model value
const UPTIME_RATE = 1000; // points banked per full epoch of uptime, before the hardware bonus
const DEMAND_WEIGHT_ANCHOR_B = 12; // the primary model's size (B params) — model weight is 1.0 here
// Penalties bite, but proportionally: within one epoch they can erase at most this fraction of what
// the node HONESTLY earned that epoch. So a penalty scales with the node's own contribution (a big
// earner can lose more absolute points than a small one) and, crucially, a single false authenticity
// flag can never drive an epoch — or the cumulative total — to zero. Real fakers still bleed here AND
// get their model value crushed by the auth gate AND get blacklisted after repeated strikes.
const PENALTY_MAX_FRACTION = 0.5;

/** Cap penalties at PENALTY_MAX_FRACTION of the gross earned in the same window, then subtract. Shared
 *  by the aggregate and per-epoch scorers so the cap math lives in one place. */
function applyPenalty(gross: number, penalties: number): number {
  return gross - Math.min(Math.max(0, penalties), gross * PENALTY_MAX_FRACTION);
}

// The availability sweep records one uptime sample per node per this interval (must match the
// dispatcher's UPTIME_SAMPLE_MS). A full epoch of continuous uptime ⇒ this many "up" samples,
// which we treat as one "uptime credit" — the unit points accrue against.
export const UPTIME_SAMPLE_MS = 60_000;
export const UPTIME_SAMPLES_PER_EPOCH = EPOCH_MS / UPTIME_SAMPLE_MS;

/** The tunable scoring constants, exposed as data so the dispatcher can serve them (GET
 *  /points/params) and the in-app points estimator stays in sync as they're retuned — no magic
 *  numbers duplicated in the UI. */
export const FORMULA_PARAMS = {
  formulaVersion: FORMULA_VERSION,
  epochMs: EPOCH_MS,
  trustRampDays: TRUST_RAMP_DAYS,
  trustFloor: TRUST_FLOOR,
  hardwareWeight: HARDWARE_WEIGHT,
  diversityBonus: DIVERSITY_BONUS,
  authFailFloor: AUTH_FAIL_FLOOR,
  uptimeRate: UPTIME_RATE,
  demandWeightAnchorB: DEMAND_WEIGHT_ANCHOR_B,
  penaltyMaxFraction: PENALTY_MAX_FRACTION,
};

/**
 * Demand weight by model size (R-track, v2). A token served on a HEAVIER model is worth more points
 * than a token on a light one — heavy models are scarcer, demand far more unified memory, and run
 * slower, so the network must reward the providers who carry them. We read the headline parameter
 * count straight off the Ollama tag (":32b" → 32, "qwen3:235b-a22b" → 235 TOTAL params — the
 * memory/quality driver for an MoE, not its active params), normalize to the ~12B primary, and
 * sqrt-curve so the spread stays sane (3B ≈ 0.5×, 8B ≈ 0.8×, 32B ≈ 1.6×, 70B ≈ 2.4×, 120B ≈ 3.2×,
 * 235B ≈ 4.4×) instead of letting one 70B dwarf everything. Floored at 0.5 / capped at 6. A tag with
 * no parsable size (or no model on the event) → 1.0, so nothing is ever penalised for being unknown.
 */
export function modelWeight(model?: string): number {
  if (!model) return 1;
  const m = model.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/);
  const params = m ? Number(m[1]) : 0;
  if (!(params > 0)) return 1;
  return clamp(Math.sqrt(params / DEMAND_WEIGHT_ANCHOR_B), 0.5, 6);
}

/**
 * Provisional scoring (FORMULA_VERSION 1). Uptime ACCRUES points; it no longer gates/deducts them:
 *
 *   points = trustRamp × ( uptimeCredits × (UPTIME_RATE + hardwareCapability) + modelValue ) − penalties
 *
 *  - uptimeCredits = uptimeUp / samples-per-epoch — full-epoch-equivalents of "up & serving" the
 *    node has banked. It's built from the COUNT of up-samples, which only ever grows, so points
 *    accumulate: a higher uptime% banks credits faster, a lower uptime% slower, and an OUTAGE never
 *    subtracts points already earned (it just stops adding). This is the core v0→v1 change — v0
 *    multiplied the whole score by the uptime *ratio*, so a dip in lifetime uptime clawed points
 *    back; v1 does not.
 *  - hardwareCapability rewards MEASURED throughput (sqrt-curved); it's a per-credit bonus, so good
 *    hardware earns faster per unit of uptime.
 *  - modelValue rewards realized DEMAND (sqrt of units), diversity-bonused and authenticity-gated;
 *    additive and monotonic (units only accrue while serving).
 *  - trustRamp is the no-staking sybil tax: new identities earn at a floor and ramp with age.
 *  - penalties (fraud / fake-model serves) are still subtracted — deliberate and unrelated to
 *    downtime — but capped per epoch at PENALTY_MAX_FRACTION of that epoch's gross, so they scale with
 *    what the node earned and a single mistaken authenticity flag can't zero an honest node.
 */
export function scoreNode(s: NodeSignals): NodeScore {
  // Measured hardware capability (diminishing returns).
  const hardwareCapability = HARDWARE_WEIGHT * Math.sqrt(Math.max(0, s.avgTokensPerSec));

  // Demand × diversity, gated by authenticity. Additive: realized work the node has banked (only
  // earned while up & serving), so it never shrinks on downtime. Demand is model-size-weighted (v2):
  // `weightedUnits` is Σ(tokens × modelWeight). `||` (not `??`) falls back to raw units when the
  // weighted column is 0 — which, since modelWeight ≥ 0.5, happens only when units is 0 too, OR on a
  // pre-v2 row not yet carrying the weighted sum. So old rows score as weight-1.0, never as zero.
  const demand = Math.sqrt(Math.max(0, s.weightedUnits || s.units));
  const diversity = 1 + DIVERSITY_BONUS * Math.max(0, s.uniqueModels - 1);
  // modelVerifiedRate is 1 when nothing's been checked yet (innocent until probed); once checks
  // exist, a low pass rate crushes the value toward the floor.
  const authGate = s.modelVerifiedRate >= 0 ? lerp(AUTH_FAIL_FLOOR, 1, clamp01(s.modelVerifiedRate)) : 1;
  const modelValue = demand * diversity * authGate;

  // No-staking sybil tax: ramp weight in with node age.
  const ageDays = Math.max(0, (s.now - s.firstSeen) / EPOCH_MS);
  const trustRamp = clamp(TRUST_FLOOR + (1 - TRUST_FLOOR) * (ageDays / TRUST_RAMP_DAYS), TRUST_FLOOR, 1);

  // v1 — uptime ACCRUES points, it does NOT gate/deduct them. Prefer the per-epoch cumulative total
  // (trust locked at earning time, so an offline node's banked points never re-scale); fall back to
  // an aggregate single-period estimate when epochs weren't supplied. `uptimeCredits` is how many
  // full epochs' worth of "up & serving" the node has banked, from the COUNT of up-samples (which
  // only ever increases — downtime stops adding, never subtracts).
  const uptimeCredits = s.uptimeUp / UPTIME_SAMPLES_PER_EPOCH;
  const gross = trustRamp * (uptimeCredits * (UPTIME_RATE + hardwareCapability) + modelValue);
  const points = s.cumulativePoints !== undefined ? s.cumulativePoints : applyPenalty(gross, s.penalties);

  // Display-only: the share of sampled time the node was actually up (informational %, can move
  // down as a stat, but no longer pulls points down with it).
  const uptimeFactor = s.uptimeSamples > 0 ? clamp01(s.uptimeUp / s.uptimeSamples) : 1;

  return {
    nodeId: s.nodeId,
    owner: s.owner,
    points: Math.max(0, points), // penalties already folded into both branches above
    uptimeFactor,
    hardwareCapability,
    modelValue,
    trustRamp,
    tokensPerSec: Math.max(0, s.avgTokensPerSec),
    formulaVersion: FORMULA_VERSION,
  };
}

// Per-operator diminishing returns (R3): a wallet's nodes are summed best-first with a geometric
// decay, so the 1st node counts full, the 2nd ×DECAY, the 3rd ×DECAY², … This curbs a single
// operator stacking many nodes to dominate the board (a no-staking whale/sybil tax) while still
// rewarding running more good hardware — just sub-linearly.
export const OWNER_NODE_DECAY = 0.85;

/** Sum a wallet's node scores with best-first geometric diminishing returns. */
export function aggregateOwnerPoints(nodeScores: NodeScore[]): number {
  return [...nodeScores]
    .sort((a, b) => b.points - a.points)
    .reduce((sum, n, i) => sum + n.points * Math.pow(OWNER_NODE_DECAY, i), 0);
}

/** Score per-node signals, aggregate to wallets (with diminishing returns), rank, and trim.
 *  Shared by both PointsStore impls so the leaderboard math lives in exactly one place. */
export function rankOwners(sigs: NodeSignals[], limit: number): LeaderboardRow[] {
  const byOwner = new Map<string, { scores: NodeScore[]; jobs: number; units: number; tps: number }>();
  for (const s of sigs) {
    if (!s.owner) continue;
    const g = byOwner.get(s.owner) ?? { scores: [], jobs: 0, units: 0, tps: 0 };
    g.scores.push(scoreNode(s));
    g.jobs += s.jobs;
    g.units += s.units;
    g.tps += s.avgTokensPerSec; // total measured throughput across the wallet's nodes
    byOwner.set(s.owner, g);
  }
  const rows: LeaderboardRow[] = [...byOwner.entries()].map(([owner, g]) => ({
    owner,
    points: aggregateOwnerPoints(g.scores),
    nodes: g.scores.length,
    jobs: g.jobs,
    units: g.units,
    tokensPerSec: g.tps,
    rank: 0,
  }));
  rows.sort((a, b) => b.points - a.points);
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows.slice(0, limit);
}

// ---------------------------------------------------------------- read shapes
/** One row of the public leaderboard — aggregated to the wallet (the reward + ranking unit). */
export interface LeaderboardRow {
  owner: string;
  points: number;
  nodes: number;
  jobs: number;
  units: number;
  /** Total measured throughput (tokens/sec) across the wallet's nodes — live hardware signal. */
  tokensPerSec: number;
  rank: number;
}

/** One node as the operator console sees it — EVERY node the ledger knows, including stale ghosts
 *  hidden from the public board, so they can be found and scrubbed. */
export interface NodeInventoryRow {
  nodeId: string;
  owner: string;
  points: number;
  /** Most recent epoch with any activity — `epochOf(now) − lastEpoch` is how many days idle. */
  lastEpoch: number;
}

/** One wallet's points for their dashboard: the total plus a per-node, explainable breakdown. */
export interface OwnerPoints {
  owner: string;
  epoch: number | null; // null = rolling all-time window
  points: number;
  jobs: number;
  units: number;
  nodes: NodeScore[];
  formulaVersion: number;
}

// ---------------------------------------------------------------- summary read model (two-table)
// The raw event log answers "what happened" but is expensive to read in aggregate as it grows.
// So reads go through a SUMMARY: running counters per node per epoch, updated incrementally on
// every event. Crucially we store INGREDIENTS (counts + sums), not a precomputed score — because
// the score is nonlinear (averages, ratios) and depends on the CURRENT clock (the trust ramp grows
// with node age), so a frozen score would be stale the next second. We keep the cheap additive
// tallies and re-derive the score from them on read. See docs/POINTS-ARCHITECTURE.md.

/** Running, incrementally-maintainable counters for one node within one epoch. Every field is a
 *  plain sum/count so it composes by addition — the whole point of the read model. */
export interface SummaryCounters {
  owner: string;
  jobs: number; // real jobs served
  units: number; // sum of completion tokens (raw demand)
  weightedUnits: number; // Σ(completion tokens × modelWeight(model)) — model-size-weighted demand (v2)
  challenges: number;
  challengePasses: number;
  uptimeSamples: number;
  uptimeUp: number;
  authChecked: number; // events with a model-authenticity verdict
  authPassed: number;
  tpsSum: number; // Σ tokens/sec — divide by tpsCount for the average
  tpsCount: number;
  penalties: number; // Σ penalty magnitudes
  firstSeen: number; // min event time (ms) — drives the trust ramp
}

export function emptyCounters(): SummaryCounters {
  return { owner: "", jobs: 0, units: 0, weightedUnits: 0, challenges: 0, challengePasses: 0, uptimeSamples: 0, uptimeUp: 0, authChecked: 0, authPassed: 0, tpsSum: 0, tpsCount: 0, penalties: 0, firstSeen: Infinity };
}

/**
 * The counter increments (and the diversity `model`) for ONE event. Single source of truth for how
 * an event mutates the summary — both stores use it (the Postgres UPSERT passes these as params),
 * so the incremental math lives in one tested place and can't drift between impls.
 */
export function eventDeltas(ev: NodeEvent): { delta: SummaryCounters; model: string | null } {
  const d = emptyCounters();
  d.owner = ev.owner;
  d.firstSeen = ev.at;
  let model: string | null = null;
  if (ev.kind === "job" && !ev.synthetic) {
    d.jobs = 1;
    d.units = ev.units ?? 0;
    d.weightedUnits = (ev.units ?? 0) * modelWeight(ev.model); // size-weighted demand (v2)
    if (ev.model) model = ev.model;
  } else if (ev.kind === "challenge") {
    d.challenges = 1;
    if (ev.ok) d.challengePasses = 1;
  } else if (ev.kind === "uptime") {
    d.uptimeSamples = 1;
    if (ev.ok) d.uptimeUp = 1;
  } else if (ev.kind === "penalty") {
    d.penalties = ev.units ?? 0;
  }
  if (ev.tokensPerSec != null) {
    d.tpsSum = ev.tokensPerSec;
    d.tpsCount = 1;
  }
  if (ev.modelVerified != null) {
    d.authChecked = 1;
    if (ev.modelVerified) d.authPassed = 1;
  }
  return { delta: d, model };
}

/** Fold one counter set into an accumulator (mutates + returns it). Sums add; firstSeen is a min. */
export function addCounters(acc: SummaryCounters, d: SummaryCounters): SummaryCounters {
  acc.owner = d.owner || acc.owner;
  acc.jobs += d.jobs;
  acc.units += d.units;
  acc.weightedUnits += d.weightedUnits;
  acc.challenges += d.challenges;
  acc.challengePasses += d.challengePasses;
  acc.uptimeSamples += d.uptimeSamples;
  acc.uptimeUp += d.uptimeUp;
  acc.authChecked += d.authChecked;
  acc.authPassed += d.authPassed;
  acc.tpsSum += d.tpsSum;
  acc.tpsCount += d.tpsCount;
  acc.penalties += d.penalties;
  acc.firstSeen = Math.min(acc.firstSeen, d.firstSeen);
  return acc;
}

/** Re-derive the (nonlinear) scoring signals from accumulated counters at read time. */
export function summaryToSignals(nodeId: string, c: SummaryCounters, uniqueModels: number, now: number): NodeSignals {
  return {
    nodeId,
    owner: c.owner,
    jobs: c.jobs,
    units: c.units,
    weightedUnits: c.weightedUnits,
    uniqueModels,
    challenges: c.challenges,
    challengePasses: c.challengePasses,
    modelVerifiedRate: c.authChecked === 0 ? 1 : c.authPassed / c.authChecked,
    avgTokensPerSec: c.tpsCount === 0 ? 0 : c.tpsSum / c.tpsCount,
    uptimeSamples: c.uptimeSamples,
    uptimeUp: c.uptimeUp,
    penalties: c.penalties,
    firstSeen: c.firstSeen === Infinity ? now : c.firstSeen,
    now,
  };
}

/** Points EARNED in one epoch, with the trust ramp locked at that epoch's age — so the value a
 *  node banked is frozen and never re-scales as it later ages or sits idle. This is the unit the
 *  cumulative total sums over; downtime simply means fewer uptime credits that epoch, never a
 *  subtraction from other epochs. Penalties for that epoch are folded in but capped at
 *  PENALTY_MAX_FRACTION of the epoch's gross, so an epoch's contribution never goes negative and a
 *  stray authenticity flag can't erase points banked in other epochs. */
export function epochContribution(c: SummaryCounters, uniqueModels: number, epoch: number, firstSeenMs: number): number {
  const epochStartMs = EPOCH_GENESIS_MS + epoch * EPOCH_MS;
  const ageDays = Math.max(0, (epochStartMs - firstSeenMs) / EPOCH_MS);
  const trust = clamp(TRUST_FLOOR + (1 - TRUST_FLOOR) * (ageDays / TRUST_RAMP_DAYS), TRUST_FLOOR, 1);
  const hardware = HARDWARE_WEIGHT * Math.sqrt(Math.max(0, c.tpsCount === 0 ? 0 : c.tpsSum / c.tpsCount));
  const demand = Math.sqrt(Math.max(0, c.weightedUnits || c.units)); // v2: model-size-weighted demand
  const diversity = 1 + DIVERSITY_BONUS * Math.max(0, uniqueModels - 1);
  const authGate = c.authChecked === 0 ? 1 : lerp(AUTH_FAIL_FLOOR, 1, clamp01(c.authPassed / c.authChecked));
  const modelValue = demand * diversity * authGate;
  const uptimeCredits = c.uptimeUp / UPTIME_SAMPLES_PER_EPOCH;
  const gross = trust * (uptimeCredits * (UPTIME_RATE + hardware) + modelValue);
  return applyPenalty(gross, c.penalties);
}

/** Build a node's NodeSignals from its per-epoch counter rows: aggregate counters drive the display
 *  fields, while `cumulativePoints` sums each epoch's trust-locked contribution (the v1 accrual). */
export function signalsFromEpochs(
  nodeId: string,
  rows: { epoch: number; counters: SummaryCounters; uniqueModels: number }[],
  totalUniqueModels: number,
  now: number,
): NodeSignals {
  const firstSeen = Math.min(...rows.map((r) => r.counters.firstSeen), Infinity);
  const agg = emptyCounters();
  let cumulative = 0;
  for (const r of rows) {
    addCounters(agg, r.counters);
    cumulative += epochContribution(r.counters, r.uniqueModels, r.epoch, firstSeen === Infinity ? now : firstSeen);
  }
  const sig = summaryToSignals(nodeId, agg, totalUniqueModels, now);
  sig.cumulativePoints = Math.max(0, cumulative);
  return sig;
}

// ---------------------------------------------------------------- the store seam
export interface PointsStore {
  /** Optional one-time setup (create tables). Awaited at dispatcher startup. */
  init?(): Promise<void>;
  /** Append one immutable event AND update the summary read model. Cheap + non-blocking. */
  record(ev: NodeEvent): void;
  /** Ranked wallet leaderboard for an epoch (default: current rolling window). */
  leaderboard(opts?: { epoch?: number; limit?: number; now?: number }): Promise<LeaderboardRow[]>;
  /** One wallet's points + per-node breakdown for their dashboard. */
  pointsFor(owner: string, opts?: { epoch?: number; now?: number }): Promise<OwnerPoints>;
  /** Every node's current score — drives reputation-weighted routing (M2). */
  nodeScores(opts?: { epoch?: number; now?: number }): Promise<NodeScore[]>;
  /** Nodes with REAL (non-uptime) activity at or after `sinceMs` — i.e. genuinely connected/served
   *  recently. Drives the availability sweep's down-sampling of offline nodes, bounded so a retired
   *  node eventually stops being sampled (down-samples themselves don't keep a node in this set). */
  recentlyActiveNodes(sinceMs: number): Promise<{ nodeId: string; owner: string }[]>;
  /** Operator console: EVERY node the ledger knows (no recency filter), so stale ghosts surface
   *  and can be scrubbed. */
  nodeInventory(now: number): Promise<NodeInventoryRow[]>;
  /** Operator action: permanently delete ALL points data for a node (summary + models + raw
   *  events) — scrubs a ghost/duplicate identity off the board. Returns summary rows removed. */
  removeNode(nodeId: string): Promise<number>;
  /** Prune raw audit events older than `beforeMs`. The summary is unaffected (already aggregated).
   *  Returns the number of rows removed. Optional — in-memory keeps it trivial. */
  prune?(beforeMs: number): Promise<number>;
}

// ---------------------------------------------------------------- in-memory impl (local / e2e)
// Mirrors the two-table Postgres design: a raw `events` audit log (prunable) plus an incrementally
// maintained summary keyed by node→epoch, with a separate model set per node→epoch for diversity.
// Reads go through the summary, exercising the SAME eventDeltas/addCounters logic the Postgres
// UPSERT uses — so unit tests here validate the incremental math both stores rely on.
export class InMemoryPointsStore implements PointsStore {
  private events: NodeEvent[] = []; // raw audit log (prunable)
  private seen = new Set<string>(); // event ids — dedup, mirroring Postgres' ON CONFLICT (event_id)
  private summary = new Map<string, Map<number, SummaryCounters>>(); // nodeId -> epoch -> counters
  private models = new Map<string, Map<number, Set<string>>>(); // nodeId -> epoch -> distinct models

  record(ev: NodeEvent): void {
    if (this.seen.has(ev.eventId)) return; // duplicate delivery — no double count
    this.seen.add(ev.eventId);
    this.events.push(ev);
    const epoch = epochOf(ev.at);
    const { delta, model } = eventDeltas(ev);
    const byEpoch = this.summary.get(ev.nodeId) ?? new Map<number, SummaryCounters>();
    addCounters(byEpoch.get(epoch) ?? byEpoch.set(epoch, emptyCounters()).get(epoch)!, delta);
    this.summary.set(ev.nodeId, byEpoch);
    if (model) {
      const m = this.models.get(ev.nodeId) ?? new Map<number, Set<string>>();
      (m.get(epoch) ?? m.set(epoch, new Set()).get(epoch)!).add(model);
      this.models.set(ev.nodeId, m);
    }
  }

  /** Fold the summary across epochs (or one epoch) into per-node signals — reads never touch the
   *  raw log, so cost scales with nodes×epochs, not total event volume. */
  private signals(now: number, epoch?: number): NodeSignals[] {
    const out: NodeSignals[] = [];
    const activeCutoff = epochOf(now) - ACTIVE_GRACE_EPOCHS;
    for (const [nodeId, byEpoch] of this.summary) {
      if (epoch !== undefined && !byEpoch.has(epoch)) continue;
      // Rolling view: drop nodes that have gone quiet past the grace window (hide-after-grace).
      if (epoch === undefined && Math.max(...byEpoch.keys()) < activeCutoff) continue;
      const rows: { epoch: number; counters: SummaryCounters; uniqueModels: number }[] = [];
      const modelSet = new Set<string>();
      for (const [ep, c] of byEpoch) {
        if (epoch !== undefined && ep !== epoch) continue;
        const ms = this.models.get(nodeId)?.get(ep);
        if (ms) for (const m of ms) modelSet.add(m);
        rows.push({ epoch: ep, counters: c, uniqueModels: ms ? ms.size : 0 });
      }
      out.push(signalsFromEpochs(nodeId, rows, modelSet.size, now));
    }
    return out;
  }

  async leaderboard(opts: { epoch?: number; limit?: number; now?: number } = {}): Promise<LeaderboardRow[]> {
    const now = opts.now ?? Date.now();
    return rankOwners(this.signals(now, opts.epoch), opts.limit ?? 100);
  }

  async pointsFor(owner: string, opts: { epoch?: number; now?: number } = {}): Promise<OwnerPoints> {
    const now = opts.now ?? Date.now();
    const sigs = this.signals(now, opts.epoch).filter((s) => s.owner === owner);
    const nodes = sigs.map(scoreNode);
    return {
      owner,
      epoch: opts.epoch ?? null,
      points: aggregateOwnerPoints(nodes),
      jobs: sigs.reduce((a, s) => a + s.jobs, 0),
      units: sigs.reduce((a, s) => a + s.units, 0),
      nodes,
      formulaVersion: FORMULA_VERSION,
    };
  }

  async nodeScores(opts: { epoch?: number; now?: number } = {}): Promise<NodeScore[]> {
    return this.signals(opts.now ?? Date.now(), opts.epoch).map(scoreNode);
  }

  async recentlyActiveNodes(sinceMs: number): Promise<{ nodeId: string; owner: string }[]> {
    const byNode = new Map<string, string>(); // nodeId -> owner (latest wins)
    for (const e of this.events) if (e.kind !== "uptime" && e.at >= sinceMs) byNode.set(e.nodeId, e.owner);
    return [...byNode].map(([nodeId, owner]) => ({ nodeId, owner }));
  }

  async nodeInventory(now: number): Promise<NodeInventoryRow[]> {
    const rows: NodeInventoryRow[] = [];
    for (const [nodeId, byEpoch] of this.summary) {
      const erows: { epoch: number; counters: SummaryCounters; uniqueModels: number }[] = [];
      const modelSet = new Set<string>();
      let lastEpoch = -Infinity;
      for (const [ep, c] of byEpoch) {
        if (ep > lastEpoch) lastEpoch = ep;
        const ms = this.models.get(nodeId)?.get(ep);
        if (ms) for (const m of ms) modelSet.add(m);
        erows.push({ epoch: ep, counters: c, uniqueModels: ms ? ms.size : 0 });
      }
      const sig = signalsFromEpochs(nodeId, erows, modelSet.size, now);
      const score = scoreNode(sig);
      rows.push({ nodeId, owner: sig.owner, points: score.points, lastEpoch });
    }
    return rows.sort((a, b) => b.lastEpoch - a.lastEpoch || b.points - a.points);
  }

  async removeNode(nodeId: string): Promise<number> {
    const rows = this.summary.get(nodeId)?.size ?? 0;
    this.summary.delete(nodeId);
    this.models.delete(nodeId);
    this.events = this.events.filter((e) => e.nodeId !== nodeId);
    return rows;
  }

  async prune(beforeMs: number): Promise<number> {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.at >= beforeMs); // summary/models retained
    return before - this.events.length;
  }
}

// ---------------------------------------------------------------- small math helpers
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
function clamp01(x: number): number {
  return clamp(x, 0, 1);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
