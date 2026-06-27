// Postgres-backed CustomerStore (M4). Durable so a redeploy doesn't invalidate customers' API
// keys. Mirrors PostgresProviderStore.

import pg from "pg";
import { newCustomerKey, maskKey, type CustomerKeyInfo, type CustomerStore } from "./customer-store.js";

const { Pool } = pg;
const NOW_MS = `(extract(epoch from now()) * 1000)::bigint`;

export class PostgresCustomerStore implements CustomerStore {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
    this.pool.on("error", (e) => console.error("[customers] pg pool error:", e.message));
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS customer_keys (
        api_key    TEXT PRIMARY KEY,
        wallet     TEXT NOT NULL,
        label      TEXT,
        revoked    BOOLEAN NOT NULL DEFAULT false,
        created_at BIGINT NOT NULL DEFAULT ${NOW_MS}
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS customer_keys_wallet_idx ON customer_keys (wallet);`);
    console.log("[customers] postgres store ready");
  }

  async mintKey(wallet: string, label?: string): Promise<string> {
    const key = newCustomerKey();
    await this.pool.query(
      `INSERT INTO customer_keys (api_key, wallet, label) VALUES ($1, $2, $3)`,
      [key, wallet, label ?? null],
    );
    return key;
  }

  async resolveKey(key: string): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT wallet FROM customer_keys WHERE api_key = $1 AND revoked = false`,
      [key],
    );
    return r.rows[0]?.wallet ?? null;
  }

  async keysFor(wallet: string): Promise<CustomerKeyInfo[]> {
    const r = await this.pool.query(
      `SELECT api_key, label, created_at FROM customer_keys
         WHERE wallet = $1 AND revoked = false ORDER BY created_at DESC`,
      [wallet],
    );
    return r.rows.map((x) => ({ masked: maskKey(x.api_key), label: x.label, createdAt: Number(x.created_at) }));
  }

  async revokeKey(key: string): Promise<void> {
    await this.pool.query(`UPDATE customer_keys SET revoked = true WHERE api_key = $1`, [key]);
  }
}
