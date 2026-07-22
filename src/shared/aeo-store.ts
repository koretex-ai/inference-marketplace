// AEO/SEO review records — the "one free site per login" ledger. Each wallet gets exactly one
// row (wallet is the primary key); the first completed report locks the wallet to that site's
// host. Re-running the SAME host overwrites (regenerate is fine — it's still one site); a
// different host is refused at the route layer. Mirrors the CreditStore seam: in-memory for
// local/e2e, Postgres for prod (selected by DATABASE_URL).

export interface AeoReviewRecord {
  /** Wallet that owns the free report (primary key — enforces one site per login). */
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
  /** The wallet's record, or null if it hasn't used its free report yet. */
  forWallet(wallet: string): Promise<AeoReviewRecord | null>;
  /** The report for a site host (e.g. "example.com") — the PUBLIC share-link read path
   *  (/aeo-seo-review/<site>). If several wallets reviewed the same site, the freshest wins. */
  bySite(site: string): Promise<AeoReviewRecord | null>;
  /** Upsert the wallet's record (first save locks the site; later saves refresh the report). */
  save(rec: AeoReviewRecord): Promise<void>;
}

export class MemoryAeoStore implements AeoStore {
  private rows = new Map<string, AeoReviewRecord>();
  async forWallet(wallet: string): Promise<AeoReviewRecord | null> {
    return this.rows.get(wallet) ?? null;
  }
  async bySite(site: string): Promise<AeoReviewRecord | null> {
    let best: AeoReviewRecord | null = null;
    for (const r of this.rows.values()) if (r.site === site && (!best || r.updatedAt > best.updatedAt)) best = r;
    return best;
  }
  async save(rec: AeoReviewRecord): Promise<void> {
    this.rows.set(rec.wallet, rec);
  }
}
