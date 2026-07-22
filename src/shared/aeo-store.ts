// AEO/SEO review records + the contact book behind them. No login: a report belongs to the
// EMAIL the visitor gives us in the contact modal (self-reported — good enough for a free tool
// and for outreach, not an authenticated identity). One row per (owner-email, site): free-tier
// emails only ever have one row (the route layer refuses a second site), unlimited emails
// (AEO_UNLIMITED_EMAILS) accumulate one per site so every report keeps a stable share link.
// Contacts are stored separately so we can reach out even before a report finishes.
// Mirrors the CreditStore seam: in-memory for local/e2e, Postgres for prod (DATABASE_URL).

export interface AeoReviewRecord {
  /** Email the report belongs to (half of the primary key). Lowercased. */
  owner: string;
  /** Hostname the report covers (e.g. "example.com") — the other half of the key. */
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

export interface AeoContact {
  /** Lowercased email — the primary key. */
  email: string;
  /** Optional phone number, as typed. */
  phone: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface AeoStore {
  /** Optional one-time setup (create tables). Awaited at dispatcher startup. */
  init?(): Promise<void>;
  /** The email's most recently updated record, or null if it hasn't reviewed anything yet.
   *  For free-tier emails (at most one row) this IS their report — the route layer uses it to
   *  enforce the one-site lock. */
  forOwner(owner: string): Promise<AeoReviewRecord | null>;
  /** The report for a site host (e.g. "example.com") — the PUBLIC share-link read path
   *  (/aeo-seo-review/<site>). If several people reviewed the same site, the freshest wins. */
  bySite(site: string): Promise<AeoReviewRecord | null>;
  /** Upsert the (owner, site) record. */
  save(rec: AeoReviewRecord): Promise<void>;
  /** Upsert a contact (first-seen is preserved; phone/last-seen refresh). */
  saveContact(c: AeoContact): Promise<void>;
}

export class MemoryAeoStore implements AeoStore {
  private rows = new Map<string, AeoReviewRecord>(); // "owner|site" → record
  private contacts = new Map<string, AeoContact>();
  async forOwner(owner: string): Promise<AeoReviewRecord | null> {
    let best: AeoReviewRecord | null = null;
    for (const r of this.rows.values()) if (r.owner === owner && (!best || r.updatedAt > best.updatedAt)) best = r;
    return best;
  }
  async bySite(site: string): Promise<AeoReviewRecord | null> {
    let best: AeoReviewRecord | null = null;
    for (const r of this.rows.values()) if (r.site === site && (!best || r.updatedAt > best.updatedAt)) best = r;
    return best;
  }
  async save(rec: AeoReviewRecord): Promise<void> {
    // Match the Postgres upsert: created_at is set once and survives re-runs.
    const key = rec.owner + "|" + rec.site;
    const prev = this.rows.get(key);
    this.rows.set(key, prev ? { ...rec, createdAt: prev.createdAt } : rec);
  }
  async saveContact(c: AeoContact): Promise<void> {
    const prev = this.contacts.get(c.email);
    this.contacts.set(c.email, prev
      ? { ...c, firstSeenAt: prev.firstSeenAt, phone: c.phone || prev.phone }
      : c);
  }
}
