// Postgres-backed PointsStore — two-table read model (event log + materialized summary).
// Mirrors PostgresSettlement: in-memory for local/e2e, this for prod. Selected by DATABASE_URL.
//
// Tables:
//   node_events   — append-only AUDIT log of every probe/job/penalty. Prunable on a TTL (the
//                   summary already holds the aggregates), so it doesn't grow without bound.
//   node_summary  — the READ MODEL: running counters per (node, epoch), updated incrementally in
//                   the SAME statement as each event insert. All reads hit this, so read cost
//                   scales with nodes×epochs, not total event volume.
//   node_models   — distinct (node, epoch, model) for the diversity bonus (a count(DISTINCT) can't
//                   be kept as a running scalar, so we keep the small set).
//
// We deliberately store INGREDIENTS (counts + sums), not a precomputed score: the score is
// nonlinear and time-dependent (the trust ramp grows with node age), so it's derived fresh on read
// via summaryToSignals → scoreNode. See docs/POINTS-ARCHITECTURE.md.

import pg from "pg";
import {
  ACTIVE_GRACE_EPOCHS,
  EPOCH_GENESIS_MS,
  EPOCH_MS,
  FORMULA_VERSION,
  aggregateOwnerPoints,
  epochOf,
  eventDeltas,
  rankOwners,
  scoreNode,
  signalsFromEpochs,
  type LeaderboardRow,
  type NodeEvent,
  type NodeInventoryRow,
  type NodeScore,
  type NodeSignals,
  type OwnerPoints,
  type SummaryCounters,
  type PointsStore,
} from "./points.js";

const { Pool } = pg;

/** Map a raw node_summary row to typed SummaryCounters (per-epoch). */
function rowToCounters(x: any): SummaryCounters {
  return {
    owner: x.owner,
    jobs: Number(x.jobs), units: Number(x.units), weightedUnits: Number(x.weighted_units ?? 0),
    challenges: Number(x.challenges), challengePasses: Number(x.challenge_passes),
    uptimeSamples: Number(x.uptime_samples), uptimeUp: Number(x.uptime_up),
    authChecked: Number(x.auth_checked), authPassed: Number(x.auth_passed),
    tpsSum: Number(x.tps_sum), tpsCount: Number(x.tps_count),
    penalties: Number(x.penalties),
    firstSeen: x.first_seen == null ? Infinity : Number(x.first_seen),
  };
}

/** Group node_summary rows by node_id (each node keeps all its per-epoch rows). */
function groupByNode(rows: any[]): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const r of rows) (m.get(r.node_id) ?? m.set(r.node_id, []).get(r.node_id)!).push(r);
  return m;
}

export class PostgresPointsStore implements PointsStore {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
    this.pool.on("error", (e) => console.error("[points] pg pool error:", e.message));
  }

  /** Idempotent — safe on every boot. Creates all three tables and, on first upgrade, backfills the
   *  summary from any pre-existing raw events so historical points aren't lost. */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS node_events (
        event_id        TEXT PRIMARY KEY,
        node_id         TEXT NOT NULL,
        owner           TEXT NOT NULL,
        kind            TEXT NOT NULL,
        epoch           INTEGER NOT NULL,
        at              BIGINT NOT NULL,
        ok              BOOLEAN,
        synthetic       BOOLEAN,
        model           TEXT,
        model_verified  BOOLEAN,
        latency_ms      INTEGER,
        tokens_per_sec  REAL,
        units           INTEGER,
        detail          JSONB,
        sig             TEXT
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS node_events_owner_idx ON node_events (owner);`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS node_events_at_idx ON node_events (at);`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS node_summary (
        node_id          TEXT    NOT NULL,
        epoch            INTEGER NOT NULL,
        owner            TEXT    NOT NULL,
        jobs             BIGINT  NOT NULL DEFAULT 0,
        units            BIGINT  NOT NULL DEFAULT 0,
        weighted_units   BIGINT  NOT NULL DEFAULT 0,
        challenges       BIGINT  NOT NULL DEFAULT 0,
        challenge_passes BIGINT  NOT NULL DEFAULT 0,
        uptime_samples   BIGINT  NOT NULL DEFAULT 0,
        uptime_up        BIGINT  NOT NULL DEFAULT 0,
        auth_checked     BIGINT  NOT NULL DEFAULT 0,
        auth_passed      BIGINT  NOT NULL DEFAULT 0,
        tps_sum          DOUBLE PRECISION NOT NULL DEFAULT 0,
        tps_count        BIGINT  NOT NULL DEFAULT 0,
        penalties        BIGINT  NOT NULL DEFAULT 0,
        first_seen       BIGINT  NOT NULL,
        PRIMARY KEY (node_id, epoch)
      );
    `);
    // v2 migration: add the model-size-weighted demand column to pre-existing summaries. New rows
    // populate it via the UPSERT below; old rows stay 0 and the scorer falls back to raw `units`
    // (weight 1.0) — see the `||` in points.ts scoreNode/epochContribution. No data backfill needed.
    await this.pool.query(`ALTER TABLE node_summary ADD COLUMN IF NOT EXISTS weighted_units BIGINT NOT NULL DEFAULT 0;`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS node_summary_owner_idx ON node_summary (owner);`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS node_summary_epoch_idx ON node_summary (epoch);`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS node_models (
        node_id TEXT    NOT NULL,
        epoch   INTEGER NOT NULL,
        model   TEXT    NOT NULL,
        PRIMARY KEY (node_id, epoch, model)
      );
    `);

    await this.backfillSummaryIfEmpty();
    console.log("[points] postgres read model ready (events + summary + models)");
  }

  /** One-time: if the summary is empty but raw events exist (upgrade from the single-table version),
   *  rebuild the summary + model sets from the raw log so no history is lost. */
  private async backfillSummaryIfEmpty(): Promise<void> {
    const empty = await this.pool.query(`SELECT 1 FROM node_summary LIMIT 1`);
    if ((empty.rowCount ?? 0) > 0) return;
    const have = await this.pool.query(`SELECT 1 FROM node_events LIMIT 1`);
    if ((have.rowCount ?? 0) === 0) return;
    console.log("[points] backfilling summary from existing event log…");
    await this.pool.query(`
      INSERT INTO node_summary
        (node_id, epoch, owner, jobs, units, challenges, challenge_passes, uptime_samples, uptime_up, auth_checked, auth_passed, tps_sum, tps_count, penalties, first_seen)
      SELECT node_id, epoch, max(owner),
        count(*) FILTER (WHERE kind='job' AND coalesce(synthetic,false)=false),
        coalesce(sum(units) FILTER (WHERE kind='job' AND coalesce(synthetic,false)=false),0),
        count(*) FILTER (WHERE kind='challenge'),
        count(*) FILTER (WHERE kind='challenge' AND ok=true),
        count(*) FILTER (WHERE kind='uptime'),
        count(*) FILTER (WHERE kind='uptime' AND ok=true),
        count(*) FILTER (WHERE model_verified IS NOT NULL),
        count(*) FILTER (WHERE model_verified=true),
        coalesce(sum(tokens_per_sec) FILTER (WHERE tokens_per_sec IS NOT NULL),0),
        count(*) FILTER (WHERE tokens_per_sec IS NOT NULL),
        coalesce(sum(units) FILTER (WHERE kind='penalty'),0),
        min(at)
      FROM node_events GROUP BY node_id, epoch
      ON CONFLICT (node_id, epoch) DO NOTHING;
    `);
    await this.pool.query(`
      INSERT INTO node_models (node_id, epoch, model)
      SELECT DISTINCT node_id, epoch, model FROM node_events
      WHERE kind='job' AND coalesce(synthetic,false)=false AND model IS NOT NULL
      ON CONFLICT DO NOTHING;
    `);
  }

  // Hot path: fire-and-forget so the job-completion handler never blocks. One statement appends the
  // audit event AND updates the summary atomically; the summary update is gated on the event insert
  // actually happening (RETURNING + WHERE EXISTS), so a duplicate event id never double-counts.
  record(ev: NodeEvent): void {
    const epoch = epochOf(ev.at);
    const { delta, model } = eventDeltas(ev);
    this.pool
      .query(
        `WITH ins AS (
           INSERT INTO node_events
             (event_id, node_id, owner, kind, epoch, at, ok, synthetic, model, model_verified, latency_ms, tokens_per_sec, units, detail, sig)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (event_id) DO NOTHING
           RETURNING 1
         )
         INSERT INTO node_summary
           (node_id, epoch, owner, jobs, units, weighted_units, challenges, challenge_passes, uptime_samples, uptime_up, auth_checked, auth_passed, tps_sum, tps_count, penalties, first_seen)
         SELECT $2,$5,$3,$16,$17,$27,$18,$19,$20,$21,$22,$23,$24,$25,$26,$6
         WHERE EXISTS (SELECT 1 FROM ins)
         ON CONFLICT (node_id, epoch) DO UPDATE SET
           owner = EXCLUDED.owner,
           jobs = node_summary.jobs + EXCLUDED.jobs,
           units = node_summary.units + EXCLUDED.units,
           weighted_units = node_summary.weighted_units + EXCLUDED.weighted_units,
           challenges = node_summary.challenges + EXCLUDED.challenges,
           challenge_passes = node_summary.challenge_passes + EXCLUDED.challenge_passes,
           uptime_samples = node_summary.uptime_samples + EXCLUDED.uptime_samples,
           uptime_up = node_summary.uptime_up + EXCLUDED.uptime_up,
           auth_checked = node_summary.auth_checked + EXCLUDED.auth_checked,
           auth_passed = node_summary.auth_passed + EXCLUDED.auth_passed,
           tps_sum = node_summary.tps_sum + EXCLUDED.tps_sum,
           tps_count = node_summary.tps_count + EXCLUDED.tps_count,
           penalties = node_summary.penalties + EXCLUDED.penalties,
           first_seen = LEAST(node_summary.first_seen, EXCLUDED.first_seen)`,
        [
          ev.eventId, ev.nodeId, ev.owner, ev.kind, epoch, ev.at,
          ev.ok ?? null, ev.synthetic ?? null, ev.model ?? null, ev.modelVerified ?? null,
          ev.latencyMs ?? null, ev.tokensPerSec ?? null, ev.units ?? null,
          ev.detail ? JSON.stringify(ev.detail) : null, ev.sig ?? null,
          delta.jobs, delta.units, delta.challenges, delta.challengePasses,
          delta.uptimeSamples, delta.uptimeUp, delta.authChecked, delta.authPassed,
          delta.tpsSum, delta.tpsCount, delta.penalties,
          delta.weightedUnits, // $27 — model-size-weighted demand (v2)
        ],
      )
      .catch((e) => console.error(`[points] failed to record ${ev.eventId}:`, e.message));
    // Diversity set — idempotent on its PK, so safe even if the event was a duplicate.
    if (model) {
      this.pool
        .query(`INSERT INTO node_models (node_id, epoch, model) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ev.nodeId, epoch, model])
        .catch((e) => console.error(`[points] failed to record model for ${ev.eventId}:`, e.message));
    }
  }

  /** Read the summary (NOT the raw log) at per-(node,epoch) granularity, so points can lock the
   *  trust ramp per epoch (v1 accrual). Folds each node's epoch rows into one NodeSignals with a
   *  trust-locked cumulative total. Touches nodes×epochs rows, independent of event volume. */
  private async signals(now: number, epoch?: number): Promise<NodeSignals[]> {
    const rolling = epoch === undefined;
    const where = rolling ? "" : "WHERE epoch = $1";
    const params = rolling ? [] : [epoch];
    const [sums, perEpochModels, totalModels] = await Promise.all([
      this.pool.query(`SELECT * FROM node_summary ${where}`, params),
      this.pool.query(`SELECT node_id, epoch, count(DISTINCT model)::int AS um FROM node_models ${where} GROUP BY node_id, epoch`, params),
      this.pool.query(`SELECT node_id, count(DISTINCT model)::int AS um FROM node_models ${where} GROUP BY node_id`, params),
    ]);
    const epUm = new Map<string, number>(perEpochModels.rows.map((m) => [`${m.node_id}|${m.epoch}`, Number(m.um)]));
    const totUm = new Map<string, number>(totalModels.rows.map((m) => [m.node_id, Number(m.um)]));
    const byNode = groupByNode(sums.rows);
    const cutoff = epochOf(now) - ACTIVE_GRACE_EPOCHS;
    const out: NodeSignals[] = [];
    for (const [nodeId, rows] of byNode) {
      // Rolling view: drop nodes quiet past the grace window (hide-after-grace).
      if (rolling && Math.max(...rows.map((r) => Number(r.epoch))) < cutoff) continue;
      const erows = rows.map((r) => ({ epoch: Number(r.epoch), counters: rowToCounters(r), uniqueModels: epUm.get(`${nodeId}|${r.epoch}`) ?? 0 }));
      out.push(signalsFromEpochs(nodeId, erows, totUm.get(nodeId) ?? 0, now));
    }
    return out;
  }

  async leaderboard(opts: { epoch?: number; limit?: number; now?: number } = {}): Promise<LeaderboardRow[]> {
    const sigs = await this.signals(opts.now ?? Date.now(), opts.epoch);
    return rankOwners(sigs, opts.limit ?? 100);
  }

  async pointsFor(owner: string, opts: { epoch?: number; now?: number } = {}): Promise<OwnerPoints> {
    const now = opts.now ?? Date.now();
    const sigs = (await this.signals(now, opts.epoch)).filter((s) => s.owner === owner);
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
    return (await this.signals(opts.now ?? Date.now(), opts.epoch)).map(scoreNode);
  }

  /** Nodes with real (non-uptime) activity since `sinceMs`. Uptime down-samples are excluded so an
   *  offline node can't keep itself in this set — it ages out once its last genuine event passes. */
  async recentlyActiveNodes(sinceMs: number): Promise<{ nodeId: string; owner: string }[]> {
    const r = await this.pool.query(
      `SELECT node_id, max(owner) AS owner FROM node_events
       WHERE kind <> 'uptime' AND at >= $1 GROUP BY node_id`,
      [sinceMs],
    );
    return r.rows.map((x) => ({ nodeId: x.node_id, owner: x.owner }));
  }

  /** Operator console: every node in the summary (NO recency filter), with its score + most-recent
   *  active epoch, so stale ghosts hidden from the public board still surface for scrubbing. */
  async nodeInventory(now: number): Promise<NodeInventoryRow[]> {
    const [sums, perEpochModels, totalModels] = await Promise.all([
      this.pool.query(`SELECT * FROM node_summary`),
      this.pool.query(`SELECT node_id, epoch, count(DISTINCT model)::int AS um FROM node_models GROUP BY node_id, epoch`),
      this.pool.query(`SELECT node_id, count(DISTINCT model)::int AS um FROM node_models GROUP BY node_id`),
    ]);
    const epUm = new Map<string, number>(perEpochModels.rows.map((m) => [`${m.node_id}|${m.epoch}`, Number(m.um)]));
    const totUm = new Map<string, number>(totalModels.rows.map((m) => [m.node_id, Number(m.um)]));
    const byNode = groupByNode(sums.rows);
    const rows: NodeInventoryRow[] = [];
    for (const [nodeId, r] of byNode) {
      const lastEpoch = Math.max(...r.map((x) => Number(x.epoch)));
      const erows = r.map((x) => ({ epoch: Number(x.epoch), counters: rowToCounters(x), uniqueModels: epUm.get(`${nodeId}|${x.epoch}`) ?? 0 }));
      const sig = signalsFromEpochs(nodeId, erows, totUm.get(nodeId) ?? 0, now);
      const score = scoreNode(sig);
      rows.push({ nodeId, owner: sig.owner, points: score.points, lastEpoch });
    }
    return rows.sort((a, b) => b.lastEpoch - a.lastEpoch || b.points - a.points);
  }

  /** Operator action: permanently delete every trace of a node — summary, model sets, and raw
   *  events. Used to scrub ghost/duplicate node identities. Returns summary rows removed. */
  async removeNode(nodeId: string): Promise<number> {
    await this.pool.query(`DELETE FROM node_models WHERE node_id = $1`, [nodeId]);
    await this.pool.query(`DELETE FROM node_events WHERE node_id = $1`, [nodeId]);
    const r = await this.pool.query(`DELETE FROM node_summary WHERE node_id = $1`, [nodeId]);
    return r.rowCount ?? 0;
  }

  /** Delete raw audit events older than `beforeMs`. The summary + model sets are kept (they already
   *  hold the aggregates), so pruning frees storage without affecting any score. */
  async prune(beforeMs: number): Promise<number> {
    const r = await this.pool.query(`DELETE FROM node_events WHERE at < $1`, [beforeMs]);
    return r.rowCount ?? 0;
  }
}

// Re-export so the dispatcher can show "current epoch N (resets in …)" without recomputing genesis.
export { EPOCH_GENESIS_MS, EPOCH_MS };
