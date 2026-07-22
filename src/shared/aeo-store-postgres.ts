// Postgres-backed AeoStore. Durable so a redeploy never re-grants a wallet a second free site
// review. wallet PRIMARY KEY + upsert = one row per wallet, same contract as MemoryAeoStore.
// Mirrors PostgresCreditStore.

import pg from "pg";
import type { AeoReviewRecord, AeoStore } from "./aeo-store.js";

const { Pool } = pg;

export class PostgresAeoStore implements AeoStore {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 3 });
    this.pool.on("error", (e) => console.error("[aeo] pg pool error:", e.message));
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS aeo_reviews (
        wallet     TEXT NOT NULL,
        site       TEXT NOT NULL,
        url        TEXT NOT NULL,
        report     JSONB NOT NULL,
        model      TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (wallet, site)
      );
    `);
    // Migration from the original wallet-only PK (one row per wallet): widen to (wallet, site)
    // so unlimited wallets can hold one report per site. Safe on both shapes — the ADD fails
    // harmlessly when the composite key is already in place.
    await this.pool.query(`ALTER TABLE aeo_reviews DROP CONSTRAINT IF EXISTS aeo_reviews_pkey;`)
      .catch(() => {});
    await this.pool.query(`ALTER TABLE aeo_reviews ADD PRIMARY KEY (wallet, site);`)
      .catch(() => {});
    // Public share links look up by site host (/aeo-seo-review/<site>) — index it.
    await this.pool.query(`CREATE INDEX IF NOT EXISTS aeo_reviews_site_idx ON aeo_reviews (site);`);
    console.log("[aeo] postgres store ready");
  }

  private rowToRec(row: any): AeoReviewRecord {
    return {
      wallet: row.wallet, site: row.site, url: row.url, report: row.report,
      model: row.model, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }

  async forWallet(wallet: string): Promise<AeoReviewRecord | null> {
    const r = await this.pool.query(`SELECT * FROM aeo_reviews WHERE wallet = $1 ORDER BY updated_at DESC LIMIT 1`, [wallet]);
    return r.rows[0] ? this.rowToRec(r.rows[0]) : null;
  }

  async bySite(site: string): Promise<AeoReviewRecord | null> {
    if (!site) return null;
    const r = await this.pool.query(`SELECT * FROM aeo_reviews WHERE site = $1 ORDER BY updated_at DESC LIMIT 1`, [site]);
    return r.rows[0] ? this.rowToRec(r.rows[0]) : null;
  }

  async save(rec: AeoReviewRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO aeo_reviews (wallet, site, url, report, model, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (wallet, site) DO UPDATE SET
         url = EXCLUDED.url, report = EXCLUDED.report,
         model = EXCLUDED.model, updated_at = EXCLUDED.updated_at`,
      [rec.wallet, rec.site, rec.url, JSON.stringify(rec.report), rec.model, rec.createdAt, rec.updatedAt],
    );
  }
}
