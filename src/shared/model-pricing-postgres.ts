// Postgres-backed model pricing (durable twin of InMemoryModelPricing). Two tables:
//   model_price_overrides — admin-set price per model (one row per model, upserted).
//   model_price_proposals — append-only provider suggestions (advisory).
// Same contract as the in-memory version; survives dispatcher restarts/redeploys.

import pg from "pg";
import {
  summarizeProposals,
  type ModelPricingStore,
  type PriceOverride,
  type PriceProposal,
  type ProposalSummary,
} from "./model-pricing.js";

const { Pool } = pg;

export class PostgresModelPricing implements ModelPricingStore {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
    this.pool.on("error", (e) => console.error("[model-pricing] pg pool error:", e.message));
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS model_price_overrides (
        model             TEXT PRIMARY KEY,
        credits_per_mtok  INTEGER NOT NULL,
        set_by            TEXT,
        at                BIGINT NOT NULL
      );`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS model_price_proposals (
        id                BIGSERIAL PRIMARY KEY,
        model             TEXT NOT NULL,
        credits_per_mtok  INTEGER NOT NULL,
        proposer          TEXT NOT NULL DEFAULT '',
        at                BIGINT NOT NULL
      );`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS mpp_model_idx ON model_price_proposals (model);`);
    console.log("[model-pricing] postgres ready");
  }

  async overrides(): Promise<PriceOverride[]> {
    const r = await this.pool.query(`SELECT model, credits_per_mtok, set_by, at FROM model_price_overrides`);
    return r.rows.map((x) => ({ model: x.model, creditsPerMTok: x.credits_per_mtok, by: x.set_by ?? "", at: Number(x.at) }));
  }

  async setOverride(model: string, creditsPerMTok: number, by: string, at: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_price_overrides (model, credits_per_mtok, set_by, at)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (model) DO UPDATE SET credits_per_mtok = $2, set_by = $3, at = $4`,
      [model.toLowerCase(), creditsPerMTok, by, at],
    );
  }

  async clearOverride(model: string): Promise<void> {
    await this.pool.query(`DELETE FROM model_price_overrides WHERE model = $1`, [model.toLowerCase()]);
  }

  async addProposal(model: string, creditsPerMTok: number, proposer: string, at: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_price_proposals (model, credits_per_mtok, proposer, at) VALUES ($1, $2, $3, $4)`,
      [model.toLowerCase(), creditsPerMTok, proposer ?? "", at],
    );
  }

  async proposals(): Promise<ProposalSummary[]> {
    // Aggregate in JS via the shared summarizer so in-mem and pg agree on the "latest per proposer"
    // dedup rule. Proposal volume is tiny (one row per provider suggestion), so this is cheap.
    const r = await this.pool.query(`SELECT model, credits_per_mtok, proposer, at FROM model_price_proposals`);
    const rows: PriceProposal[] = r.rows.map((x) => ({
      model: x.model,
      creditsPerMTok: x.credits_per_mtok,
      proposer: x.proposer ?? "",
      at: Number(x.at),
    }));
    return summarizeProposals(rows);
  }
}
