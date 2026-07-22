// Postgres-backed AeoStore. Durable so a redeploy never re-grants a second free site review
// and never loses a contact. (owner, site) PRIMARY KEY + upsert = one row per email per site,
// same contract as MemoryAeoStore. Mirrors PostgresCreditStore.

import pg from "pg";
import type { AeoContact, AeoReviewRecord, AeoStore } from "./aeo-store.js";

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
        owner      TEXT NOT NULL,
        site       TEXT NOT NULL,
        url        TEXT NOT NULL,
        report     JSONB NOT NULL,
        model      TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (owner, site)
      );
    `);
    // Migration from the earlier wallet-identity schema: the column was `wallet`. Rename keeps
    // any existing rows addressable (their owner is a wallet pubkey — harmless orphans).
    await this.pool.query(`ALTER TABLE aeo_reviews RENAME COLUMN wallet TO owner;`).catch(() => {});
    await this.pool.query(`ALTER TABLE aeo_reviews DROP CONSTRAINT IF EXISTS aeo_reviews_pkey;`).catch(() => {});
    await this.pool.query(`ALTER TABLE aeo_reviews ADD PRIMARY KEY (owner, site);`).catch(() => {});
    // Public share links look up by site host (/aeo-seo-review/<site>) — index it.
    await this.pool.query(`CREATE INDEX IF NOT EXISTS aeo_reviews_site_idx ON aeo_reviews (site);`);
    // The contact book — who to reach out to. Independent of reports so a contact survives a
    // failed/abandoned review.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS aeo_contacts (
        email         TEXT PRIMARY KEY,
        phone         TEXT NOT NULL DEFAULT '',
        first_seen_at BIGINT NOT NULL,
        last_seen_at  BIGINT NOT NULL
      );
    `);
    console.log("[aeo] postgres store ready");
  }

  private rowToRec(row: any): AeoReviewRecord {
    return {
      owner: row.owner, site: row.site, url: row.url, report: row.report,
      model: row.model, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }

  async forOwner(owner: string): Promise<AeoReviewRecord | null> {
    const r = await this.pool.query(`SELECT * FROM aeo_reviews WHERE owner = $1 ORDER BY updated_at DESC LIMIT 1`, [owner]);
    return r.rows[0] ? this.rowToRec(r.rows[0]) : null;
  }

  async bySite(site: string): Promise<AeoReviewRecord | null> {
    if (!site) return null;
    const r = await this.pool.query(`SELECT * FROM aeo_reviews WHERE site = $1 ORDER BY updated_at DESC LIMIT 1`, [site]);
    return r.rows[0] ? this.rowToRec(r.rows[0]) : null;
  }

  async save(rec: AeoReviewRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO aeo_reviews (owner, site, url, report, model, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (owner, site) DO UPDATE SET
         url = EXCLUDED.url, report = EXCLUDED.report,
         model = EXCLUDED.model, updated_at = EXCLUDED.updated_at`,
      [rec.owner, rec.site, rec.url, JSON.stringify(rec.report), rec.model, rec.createdAt, rec.updatedAt],
    );
  }

  async saveContact(c: AeoContact): Promise<void> {
    await this.pool.query(
      `INSERT INTO aeo_contacts (email, phone, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET
         phone = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE aeo_contacts.phone END,
         last_seen_at = EXCLUDED.last_seen_at`,
      [c.email, c.phone, c.firstSeenAt, c.lastSeenAt],
    );
  }
}
