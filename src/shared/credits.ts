// Credit purchases (M4, money-IN). A customer buys credits by sending USDC to the admin fee
// wallet on Solana; once that transfer is verified on-chain (see ./solana.ts), we record a
// purchase here and the wallet's credit balance goes up. Credits are the internal spend unit
// (1 credit = $0.01 at the default 100-credits-per-USDC peg).
//
// Scope: this is ONLY the purchase + balance side. Debiting credits for inference spend, and
// encashing credits back to USDC, come later — see the roadmap (M4 payout half / encash).
//
// The on-chain transfer is the source of truth; this table is an idempotent INDEX of it, keyed
// on the transaction signature. A deposit is credited AT MOST ONCE no matter how many times it's
// submitted (fast path) or rediscovered (refresh sweep). Mirrors the SettlementProvider seam:
// in-memory for local/e2e, Postgres-backed for prod (selected by DATABASE_URL).

export interface CreditPurchase {
  /** Solana transaction signature of the USDC transfer. The idempotency anchor (primary key). */
  signature: string;
  /** Wallet that paid — and is credited. */
  wallet: string;
  /** USDC that actually landed in the admin wallet, in base units (6 decimals). */
  usdcRaw: number;
  /** Credits issued = floor(usdcRaw * creditsPerUsdc / 1e6). Computed by the caller (knows the peg). */
  credits: number;
  /** Solana slot + block time of the transfer, for audit/reconciliation. */
  slot: number;
  blockTime: number | null;
  /** When we recorded it (ms since epoch). Set by the caller, kept out of the store for testability. */
  at: number;
}

/** A double-entry charge for one completed inference job: debit the caller, credit the supplier
 *  by the SAME amount. Applied atomically and idempotently (keyed on jobId). */
export interface InferenceCharge {
  jobId: string;
  /** Wallet billed for the call (loses `credits`). */
  customerWallet: string;
  /** Provider wallet that served the call (gains `credits`). */
  providerWallet: string;
  /** Credits moved from caller → supplier (always ≥ 1; computed by the pricing engine). */
  credits: number;
  at: number;
}

export interface CreditStore {
  /** Optional one-time setup (create tables). Awaited at dispatcher startup. */
  init?(): Promise<void>;
  /** Idempotently record a verified purchase. Returns true if newly credited, false if the
   *  signature was already recorded (a no-op — NEVER double-credits). */
  recordPurchase(p: CreditPurchase): Promise<boolean>;
  /** Apply an inference charge: debit caller, credit supplier, atomically. Idempotent on jobId —
   *  a duplicate/replayed `done` never bills twice. No-op if the two wallets are the same. */
  recordInferenceCharge(c: InferenceCharge): Promise<void>;
  /** A wallet's credit balance = purchases + earnings − spend (all credits move through here). */
  balance(wallet: string): Promise<number>;
  /** Credits a wallet has EARNED by serving inference (sum of positive movements) — the provider's
   *  realised income, excluding purchases/grants and spend. */
  earned(wallet: string): Promise<number>;
  /** A wallet's recent purchases, newest first (buy page / history). */
  purchases(wallet: string, limit: number): Promise<CreditPurchase[]>;
  /** Whether a signature has already been credited — a cheap skip-check during the refresh sweep. */
  has(signature: string): Promise<boolean>;
  /** One-off seed: grant `creditsEach` welcome credits to every wallet the system already knows
   *  (idempotent on the `welcome:<wallet>` signature, so re-running never double-grants). Returns
   *  how many wallets were newly granted. Optional — only the Postgres store implements the full
   *  cross-table scan. */
  seedWelcomeGrants?(creditsEach: number, now: number): Promise<number>;
}

/** Local/e2e: in-memory, keyed by signature so a replay is a no-op. */
export class InMemoryCreditStore implements CreditStore {
  private bySig = new Map<string, CreditPurchase>();
  // Signed movements from inference charges: customer −credits, provider +credits per job.
  private movements: { wallet: string; delta: number }[] = [];
  private chargedJobs = new Set<string>();

  async recordPurchase(p: CreditPurchase): Promise<boolean> {
    if (this.bySig.has(p.signature)) return false;
    this.bySig.set(p.signature, p);
    return true;
  }

  async recordInferenceCharge(c: InferenceCharge): Promise<void> {
    if (c.credits <= 0 || c.customerWallet === c.providerWallet) return; // nothing to move
    if (this.chargedJobs.has(c.jobId)) return; // idempotent
    this.chargedJobs.add(c.jobId);
    this.movements.push({ wallet: c.customerWallet, delta: -c.credits });
    this.movements.push({ wallet: c.providerWallet, delta: +c.credits });
  }

  async balance(wallet: string): Promise<number> {
    let sum = 0;
    for (const p of this.bySig.values()) if (p.wallet === wallet) sum += p.credits;
    for (const m of this.movements) if (m.wallet === wallet) sum += m.delta;
    return sum;
  }

  async earned(wallet: string): Promise<number> {
    let sum = 0;
    for (const m of this.movements) if (m.wallet === wallet && m.delta > 0) sum += m.delta;
    return sum;
  }

  async purchases(wallet: string, limit: number): Promise<CreditPurchase[]> {
    return [...this.bySig.values()]
      .filter((p) => p.wallet === wallet)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  async has(signature: string): Promise<boolean> {
    return this.bySig.has(signature);
  }

  async seedWelcomeGrants(creditsEach: number, now: number): Promise<number> {
    const wallets = new Set<string>();
    for (const p of this.bySig.values()) wallets.add(p.wallet);
    for (const m of this.movements) wallets.add(m.wallet);
    let granted = 0;
    for (const w of wallets) {
      if (await this.recordPurchase({ signature: "welcome:" + w, wallet: w, usdcRaw: 0, credits: creditsEach, slot: 0, blockTime: null, at: now })) granted++;
    }
    return granted;
  }
}
