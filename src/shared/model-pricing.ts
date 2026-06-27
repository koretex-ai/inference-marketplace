// Model pricing control plane (demand-driven pricing). Two things live here, both keyed by the
// LOWERCASED model id (so they line up with Pricing + the engine's lowercased ids):
//
//   - OVERRIDES: an admin-set credits-per-1M price for a model. Loaded into Pricing at boot and on
//     every change, so it wins over the static prices.json book WITHOUT a redeploy. This is how the
//     operator re-prices a model in response to demand / provider requests.
//   - PROPOSALS: a provider's *suggested* price for a model they serve (from `koretex models`). Purely
//     advisory — the model keeps earning its current rate (default if unpriced) until an admin acts.
//     Surfaced (aggregated) on the public Demand tab and in the admin console as "requested price".
//
// In-memory for local/e2e; the Postgres twin (model-pricing-postgres.ts) makes both durable in prod.

/** An admin-set price override. */
export interface PriceOverride {
  model: string;
  creditsPerMTok: number;
  by: string; // admin wallet that set it
  at: number;
}

/** A provider's suggested price for a model (advisory). */
export interface PriceProposal {
  model: string;
  creditsPerMTok: number;
  proposer: string; // provider wallet (may be "" if unknown)
  at: number;
}

/** Per-model aggregation of proposals, for display. */
export interface ProposalSummary {
  model: string;
  count: number; // distinct proposers
  avgCreditsPerMTok: number;
  latestCreditsPerMTok: number;
  latestAt: number;
}

export interface ModelPricingStore {
  init?(): Promise<void>;
  /** All admin overrides — loaded into Pricing at boot. */
  overrides(): Promise<PriceOverride[]>;
  /** Set/replace an admin override (credits per 1M tokens). */
  setOverride(model: string, creditsPerMTok: number, by: string, at: number): Promise<void>;
  /** Remove an admin override (model falls back to prices.json / default). */
  clearOverride(model: string): Promise<void>;
  /** Record a provider's advisory price suggestion. */
  addProposal(model: string, creditsPerMTok: number, proposer: string, at: number): Promise<void>;
  /** Proposals aggregated per model (distinct proposers, average, and most recent). */
  proposals(): Promise<ProposalSummary[]>;
}

/** Aggregate raw proposals into one row per model (latest proposer per wallet wins). */
export function summarizeProposals(rows: PriceProposal[]): ProposalSummary[] {
  const byModel = new Map<string, PriceProposal[]>();
  for (const r of rows) {
    const k = r.model.toLowerCase();
    (byModel.get(k) ?? byModel.set(k, []).get(k)!).push(r);
  }
  const out: ProposalSummary[] = [];
  for (const [model, rs] of byModel) {
    // Keep one (latest) suggestion per proposer so a single provider can't skew the average.
    const latestByProposer = new Map<string, PriceProposal>();
    for (const r of rs) {
      const prev = latestByProposer.get(r.proposer);
      if (!prev || r.at > prev.at) latestByProposer.set(r.proposer, r);
    }
    const uniq = [...latestByProposer.values()];
    const sum = uniq.reduce((a, r) => a + r.creditsPerMTok, 0);
    const newest = uniq.reduce((a, r) => (r.at > a.at ? r : a));
    out.push({
      model,
      count: uniq.length,
      avgCreditsPerMTok: Math.round(sum / uniq.length),
      latestCreditsPerMTok: newest.creditsPerMTok,
      latestAt: newest.at,
    });
  }
  return out.sort((a, b) => b.latestAt - a.latestAt);
}

export class InMemoryModelPricing implements ModelPricingStore {
  private over = new Map<string, PriceOverride>();
  private props: PriceProposal[] = [];

  async overrides(): Promise<PriceOverride[]> {
    return [...this.over.values()];
  }
  async setOverride(model: string, creditsPerMTok: number, by: string, at: number): Promise<void> {
    this.over.set(model.toLowerCase(), { model: model.toLowerCase(), creditsPerMTok, by, at });
  }
  async clearOverride(model: string): Promise<void> {
    this.over.delete(model.toLowerCase());
  }
  async addProposal(model: string, creditsPerMTok: number, proposer: string, at: number): Promise<void> {
    this.props.push({ model: model.toLowerCase(), creditsPerMTok, proposer, at });
  }
  async proposals(): Promise<ProposalSummary[]> {
    return summarizeProposals(this.props);
  }
}
