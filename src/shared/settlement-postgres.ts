// Postgres-backed settlement. Durable replacement for InMemorySettlement so the ledger
// survives dispatcher restarts/redeploys (M1). One INSERT per completed job.
// The data path NEVER calls on-chain directly; it only appends ledger rows here — the
// same contract the in-memory version honours. Solana payout reads from this table later.

import pg from "pg";
import type {
  LedgerEntry,
  LedgerRow,
  ModelDemand,
  ProviderStats,
  SettlementProvider,
  Summary,
} from "./settlement.js";

const { Pool } = pg;

export class PostgresSettlement implements SettlementProvider {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
    // A pool-level error (e.g. backend dropped the connection) must not crash the process.
    this.pool.on("error", (e) => console.error("[settlement] pg pool error:", e.message));
  }

  /** Idempotent — safe to call on every boot. Creates the ledger table if missing. */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ledger (
        job_id            TEXT PRIMARY KEY,
        customer_key      TEXT NOT NULL,
        node_id           TEXT NOT NULL,
        owner             TEXT,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_tokens     INTEGER NOT NULL DEFAULT 0,
        model             TEXT,
        at                BIGINT NOT NULL
      );
    `);
    // `owner` (provider wallet) was added after the first ledger shipped — backfill the column.
    await this.pool.query(`ALTER TABLE ledger ADD COLUMN IF NOT EXISTS owner TEXT;`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ledger_node_idx ON ledger (node_id);`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ledger_customer_idx ON ledger (customer_key);`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ledger_owner_idx ON ledger (owner);`);
    console.log("[settlement] postgres ledger ready");
  }

  // Hot path: fire-and-forget so we never block the job-completion handler. The primary key
  // on job_id makes a duplicate `done` a no-op rather than a double-charge.
  record(entry: LedgerEntry): void {
    const { jobId, customerKey, nodeId, owner, usage, at } = entry;
    this.pool
      .query(
        `INSERT INTO ledger (job_id, customer_key, node_id, owner, completion_tokens, prompt_tokens, model, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (job_id) DO NOTHING`,
        [
          jobId,
          customerKey,
          nodeId,
          owner ?? null,
          usage.completionTokens ?? 0,
          usage.promptTokens ?? 0,
          usage.model ?? null,
          at,
        ],
      )
      .catch((e) => console.error(`[settlement] failed to record ${jobId}:`, e.message));
  }

  async summary(): Promise<Summary> {
    const [total, byNodeRows, byCustomerRows, byOwnerRows] = await Promise.all([
      this.pool.query(`SELECT count(*)::int AS jobs FROM ledger`),
      this.pool.query(
        `SELECT node_id, sum(completion_tokens)::int AS ct FROM ledger GROUP BY node_id`,
      ),
      this.pool.query(
        `SELECT customer_key, sum(completion_tokens)::int AS ct FROM ledger GROUP BY customer_key`,
      ),
      this.pool.query(
        `SELECT owner, sum(completion_tokens)::int AS ct FROM ledger WHERE owner IS NOT NULL GROUP BY owner`,
      ),
    ]);
    const byNode: Record<string, number> = {};
    for (const r of byNodeRows.rows) byNode[r.node_id] = r.ct;
    const byCustomer: Record<string, number> = {};
    for (const r of byCustomerRows.rows) byCustomer[r.customer_key] = r.ct;
    const byOwner: Record<string, number> = {};
    for (const r of byOwnerRows.rows) byOwner[r.owner] = r.ct;
    return { jobs: total.rows[0].jobs, byNode, byCustomer, byOwner };
  }

  async providerStats(owner: string): Promise<ProviderStats> {
    const [totals, byModel, recent] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS jobs, coalesce(sum(completion_tokens),0)::int AS ct
           FROM ledger WHERE owner = $1`,
        [owner],
      ),
      this.pool.query(
        `SELECT coalesce(model,'unknown') AS model, count(*)::int AS jobs, sum(completion_tokens)::int AS ct
           FROM ledger WHERE owner = $1 GROUP BY model ORDER BY ct DESC`,
        [owner],
      ),
      this.pool.query(
        `SELECT at, model, completion_tokens::int AS ct
           FROM ledger WHERE owner = $1 ORDER BY at DESC LIMIT 50`,
        [owner],
      ),
    ]);
    return {
      owner,
      jobs: totals.rows[0].jobs,
      completionTokens: totals.rows[0].ct,
      byModel: byModel.rows.map((r) => ({ model: r.model, jobs: r.jobs, completionTokens: r.ct })),
      recent: recent.rows.map((r) => ({ at: Number(r.at), model: r.model, completionTokens: r.ct })),
    };
  }

  async recent(limit: number): Promise<LedgerRow[]> {
    const r = await this.pool.query(
      `SELECT job_id, at, owner, model, completion_tokens::int AS ct, customer_key, node_id
         FROM ledger ORDER BY at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({
      jobId: x.job_id,
      at: Number(x.at),
      owner: x.owner,
      model: x.model,
      completionTokens: x.ct,
      customerKey: x.customer_key,
      nodeId: x.node_id,
    }));
  }

  async demandByModel(sinceMs: number): Promise<ModelDemand[]> {
    const r = await this.pool.query(
      `SELECT lower(coalesce(model,'unknown')) AS model,
              count(*)::int                    AS jobs,
              coalesce(sum(completion_tokens),0)::int AS ct
         FROM ledger WHERE at >= $1
         GROUP BY 1 ORDER BY ct DESC`,
      [sinceMs],
    );
    return r.rows.map((x) => ({ model: x.model, jobs: x.jobs, completionTokens: x.ct }));
  }
}
