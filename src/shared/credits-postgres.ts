// Postgres-backed CreditStore (M4 money-in). Durable so a dispatcher redeploy never loses a
// recorded purchase. The signature PRIMARY KEY makes crediting idempotent at the DB layer:
// ON CONFLICT DO NOTHING means a replay (fast path) or a rediscovery (refresh sweep) of the same
// deposit is a no-op. Mirrors PostgresSettlement / PostgresProviderStore.

import pg from "pg";
import type { CreditPurchase, CreditStore, InferenceCharge } from "./credits.js";

const { Pool } = pg;

export class PostgresCreditStore implements CreditStore {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
    this.pool.on("error", (e) => console.error("[credits] pg pool error:", e.message));
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS credit_purchases (
        signature   TEXT PRIMARY KEY,
        wallet      TEXT NOT NULL,
        usdc_raw    BIGINT NOT NULL,
        credits     BIGINT NOT NULL,
        slot        BIGINT NOT NULL DEFAULT 0,
        block_time  BIGINT,
        at          BIGINT NOT NULL
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS credit_purchases_wallet_idx ON credit_purchases (wallet);`);
    // Signed credit movements from inference charges. Two rows per job (caller −, supplier +),
    // distinguished by wallet. PK (job_id, wallet) makes re-applying a job a no-op (idempotent).
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS credit_movements (
        job_id  TEXT NOT NULL,
        wallet  TEXT NOT NULL,
        delta   BIGINT NOT NULL,
        kind    TEXT NOT NULL,
        at      BIGINT NOT NULL,
        PRIMARY KEY (job_id, wallet)
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS credit_movements_wallet_idx ON credit_movements (wallet);`);
    // Materialised running total per wallet — the source of truth for fast balance reads. Kept in
    // sync inside the SAME transaction as every purchase/charge below; the two append-only tables
    // above remain the immutable audit trail it's derived from.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS credit_balances (
        wallet     TEXT PRIMARY KEY,
        balance    BIGINT NOT NULL DEFAULT 0,
        earned     BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL DEFAULT 0
      );
    `);
    await this.backfillBalancesIfEmpty();
    console.log("[credits] postgres store ready");
  }

  /** One-time: if the balances table is empty but the ledger has history, fold the existing
   *  purchases + movements into per-wallet running totals. After this, balances are maintained
   *  incrementally and never re-summed. */
  private async backfillBalancesIfEmpty(): Promise<void> {
    const have = await this.pool.query(`SELECT 1 FROM credit_balances LIMIT 1`);
    if ((have.rowCount ?? 0) > 0) return;
    const ledger = await this.pool.query(`SELECT 1 FROM credit_purchases LIMIT 1`);
    const moves = await this.pool.query(`SELECT 1 FROM credit_movements LIMIT 1`);
    if ((ledger.rowCount ?? 0) === 0 && (moves.rowCount ?? 0) === 0) return;
    console.log("[credits] backfilling credit_balances from the ledger…");
    await this.pool.query(
      `INSERT INTO credit_balances (wallet, balance, earned, updated_at)
       SELECT wallet, sum(c)::bigint, sum(e)::bigint, $1
       FROM (
         SELECT wallet, credits AS c, 0 AS e FROM credit_purchases
         UNION ALL
         SELECT wallet, delta AS c, CASE WHEN kind = 'earn' THEN delta ELSE 0 END AS e FROM credit_movements
       ) x GROUP BY wallet
       ON CONFLICT (wallet) DO NOTHING`,
      [Date.now()],
    );
  }

  // Idempotent: the signature primary key turns a duplicate deposit into a no-op. rowCount tells
  // us whether THIS call was the one that credited it (true) or it was already there (false).
  async recordPurchase(p: CreditPurchase): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `INSERT INTO credit_purchases (signature, wallet, usdc_raw, credits, slot, block_time, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (signature) DO NOTHING`,
        [p.signature, p.wallet, p.usdcRaw, p.credits, p.slot, p.blockTime, p.at],
      );
      const isNew = (r.rowCount ?? 0) > 0;
      // Only move the running total when the purchase was actually recorded (idempotent on replays).
      if (isNew) await this.bump(client, p.wallet, p.credits, 0, p.at);
      await client.query("COMMIT");
      return isNew;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Apply a signed delta to a wallet's running balance (and earned), creating the row if needed.
   *  Runs on the caller's transaction so the materialised total can never diverge from the ledger. */
  private async bump(client: pg.PoolClient, wallet: string, balanceDelta: number, earnedDelta: number, at: number): Promise<void> {
    await client.query(
      `INSERT INTO credit_balances (wallet, balance, earned, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (wallet) DO UPDATE SET
         balance = credit_balances.balance + EXCLUDED.balance,
         earned  = credit_balances.earned  + EXCLUDED.earned,
         updated_at = EXCLUDED.updated_at`,
      [wallet, balanceDelta, earnedDelta, at],
    );
  }

  // Both legs in one transaction so the caller's debit and supplier's credit always move together
  // (or not at all). The (job_id, wallet) primary key makes a replayed `done` a no-op.
  async recordInferenceCharge(c: InferenceCharge): Promise<void> {
    if (c.credits <= 0 || c.customerWallet === c.providerWallet) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO credit_movements (job_id, wallet, delta, kind, at) VALUES ($1, $2, $3, 'spend', $4)
         ON CONFLICT (job_id, wallet) DO NOTHING`,
        [c.jobId, c.customerWallet, -c.credits, c.at],
      );
      await client.query(
        `INSERT INTO credit_movements (job_id, wallet, delta, kind, at) VALUES ($1, $2, $3, 'earn', $4)
         ON CONFLICT (job_id, wallet) DO NOTHING`,
        [c.jobId, c.providerWallet, c.credits, c.at],
      );
      // Both legs are written together, so the spend-leg insert tells us whether this is a fresh
      // charge; only then move the running totals (caller −credits, provider +credits and +earned).
      if ((ins.rowCount ?? 0) > 0) {
        await this.bump(client, c.customerWallet, -c.credits, 0, c.at);
        await this.bump(client, c.providerWallet, c.credits, c.credits, c.at);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // Single-row read of the maintained running total (no re-summing the ledger).
  async balance(wallet: string): Promise<number> {
    const r = await this.pool.query(`SELECT balance FROM credit_balances WHERE wallet = $1`, [wallet]);
    return r.rows[0] ? Number(r.rows[0].balance) : 0;
  }

  // Realised provider income — the maintained 'earned' total (credits received for serving).
  async earned(wallet: string): Promise<number> {
    const r = await this.pool.query(`SELECT earned FROM credit_balances WHERE wallet = $1`, [wallet]);
    return r.rows[0] ? Number(r.rows[0].earned) : 0;
  }

  async purchases(wallet: string, limit: number): Promise<CreditPurchase[]> {
    const r = await this.pool.query(
      `SELECT signature, wallet, usdc_raw, credits, slot, block_time, at
         FROM credit_purchases WHERE wallet = $1 ORDER BY at DESC LIMIT $2`,
      [wallet, limit],
    );
    return r.rows.map((x) => ({
      signature: x.signature,
      wallet: x.wallet,
      usdcRaw: Number(x.usdc_raw),
      credits: Number(x.credits),
      slot: Number(x.slot),
      blockTime: x.block_time == null ? null : Number(x.block_time),
      at: Number(x.at),
    }));
  }

  async has(signature: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM credit_purchases WHERE signature = $1`, [signature]);
    return (r.rowCount ?? 0) > 0;
  }

  // One-off seed: grant welcome credits to every wallet already known across the system (customers,
  // node operators, earners). One idempotent statement — re-running never double-grants (the
  // `welcome:<wallet>` signature is the credit_purchases primary key). Reaches across tables in the
  // same database on purpose; this is a seed, not a hot path.
  async seedWelcomeGrants(creditsEach: number, now: number): Promise<number> {
    // Insert the welcome purchases AND fold them into the running balances in one atomic statement —
    // only the rows that were actually new (RETURNING from the ON CONFLICT insert) bump a balance.
    const r = await this.pool.query(
      `WITH ins AS (
         INSERT INTO credit_purchases (signature, wallet, usdc_raw, credits, slot, block_time, at)
         SELECT 'welcome:' || w, w, 0, $1, 0, NULL, $2
         FROM (
           SELECT wallet AS w FROM credit_purchases
           UNION SELECT wallet FROM customer_keys
           UNION SELECT pubkey FROM providers
           UNION SELECT owner FROM node_summary
         ) d
         WHERE w IS NOT NULL AND w <> ''
         ON CONFLICT (signature) DO NOTHING
         RETURNING wallet, credits
       )
       INSERT INTO credit_balances (wallet, balance, earned, updated_at)
       SELECT wallet, credits, 0, $2 FROM ins
       ON CONFLICT (wallet) DO UPDATE SET
         balance = credit_balances.balance + EXCLUDED.balance,
         updated_at = EXCLUDED.updated_at`,
      [creditsEach, now],
    );
    return r.rowCount ?? 0;
  }
}
