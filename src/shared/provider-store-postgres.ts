// Postgres-backed ProviderStore (P2). Durable so a dispatcher redeploy doesn't invalidate
// every provider's node token. Mirrors PostgresSettlement: in-memory for local/e2e, this for prod.

import pg from "pg";
import { newToken, type ProviderStore } from "./provider-store.js";

const { Pool } = pg;
const NOW_MS = `(extract(epoch from now()) * 1000)::bigint`;

export class PostgresProviderStore implements ProviderStore {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
    this.pool.on("error", (e) => console.error("[providers] pg pool error:", e.message));
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS providers (
        pubkey     TEXT PRIMARY KEY,
        created_at BIGINT NOT NULL DEFAULT ${NOW_MS}
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS node_tokens (
        token      TEXT PRIMARY KEY,
        pubkey     TEXT NOT NULL,
        label      TEXT,
        revoked    BOOLEAN NOT NULL DEFAULT false,
        created_at BIGINT NOT NULL DEFAULT ${NOW_MS}
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS node_tokens_pubkey_idx ON node_tokens (pubkey);`);
    console.log("[providers] postgres store ready");
  }

  async upsertProvider(pubkey: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO providers (pubkey) VALUES ($1) ON CONFLICT (pubkey) DO NOTHING`,
      [pubkey],
    );
  }

  async mintToken(pubkey: string, label?: string): Promise<string> {
    const token = newToken();
    await this.pool.query(
      `INSERT INTO node_tokens (token, pubkey, label) VALUES ($1, $2, $3)`,
      [token, pubkey, label ?? null],
    );
    return token;
  }

  async resolveToken(token: string): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT pubkey FROM node_tokens WHERE token = $1 AND revoked = false`,
      [token],
    );
    return r.rows[0]?.pubkey ?? null;
  }

  async revokeToken(token: string): Promise<void> {
    await this.pool.query(`UPDATE node_tokens SET revoked = true WHERE token = $1`, [token]);
  }
}
