// AEO/SEO review records. One row per (wallet, site): a free-tier wallet only ever has one row
// (the route layer refuses a second site), while unlimited wallets (AEO_UNLIMITED_WALLETS /
// ADMIN_WALLET) accumulate one per site they review — so every generated report keeps a stable
// public share link. Re-running a site the wallet already reviewed overwrites that row. Mirrors
// the CreditStore seam: in-memory for local/e2e, Postgres for prod (selected by DATABASE_URL).

export interface AeoReviewRecord {
  /** Wallet that generated the report (half of the primary key). */
  wallet: string;
  /** Hostname the wallet's free report is locked to (e.g. "example.com"). */
  site: string;
  /** Full URL that was reviewed. */
  url: string;
  /** The generated report, as returned by the model (JSON). */
  report: unknown;
  /** Model that produced it (for the report footer / audit). */
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface AeoStore {
  /** Optional one-time setup (create tables). Awaited at dispatcher startup. */
  init?(): Promise<void>;
  /** The wallet's most recently updated record, or null if it hasn't reviewed anything yet.
   *  For free-tier wallets (at most one row) this IS their report — the route layer uses it to
   *  enforce the one-site lock. */
  forWallet(wallet: string): Promise<AeoReviewRecord | null>;
  /** The report for a site host (e.g. "example.com") — the PUBLIC share-link read path
   *  (/aeo-seo-review/<site>). If several wallets reviewed the same site, the freshest wins. */
  bySite(site: string): Promise<AeoReviewRecord | null>;
  /** Upsert the (wallet, site) record. */
  save(rec: AeoReviewRecord): Promise<void>;
}

export class MemoryAeoStore implements AeoStore {
  private rows = new Map<string, AeoReviewRecord>(); // "wallet|site" → record
  async forWallet(wallet: string): Promise<AeoReviewRecord | null> {
    let best: AeoReviewRecord | null = null;
    for (const r of this.rows.values()) if (r.wallet === wallet && (!best || r.updatedAt > best.updatedAt)) best = r;
    return best;
  }
  async bySite(site: string): Promise<AeoReviewRecord | null> {
    let best: AeoReviewRecord | null = null;
    for (const r of this.rows.values()) if (r.site === site && (!best || r.updatedAt > best.updatedAt)) best = r;
    return best;
  }
  async save(rec: AeoReviewRecord): Promise<void> {
    // Match the Postgres upsert: created_at is set once and survives re-runs.
    const key = rec.wallet + "|" + rec.site;
    const prev = this.rows.get(key);
    this.rows.set(key, prev ? { ...rec, createdAt: prev.createdAt } : rec);
  }
}
