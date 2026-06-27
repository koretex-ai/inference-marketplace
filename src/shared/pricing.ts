// Inference pricing (M4): turn a completed job's token count into an integer credit cost.
// A per-model price book gives credits-per-1,000,000-tokens; unlisted models fall back to a
// default. Cost is charged 1:1 — the caller is debited and the supplier credited the SAME amount
// (no platform fee on inference; the platform's margin lives in the buy/encash spread instead).
//
// Granularity: with the credit peg at 10,000 credits = 1 USDC (1 credit = $0.0001), a rate of
// e.g. 4000 credits / 1M tokens == $0.40 / 1M tokens, and typical requests cost whole credits.
// Costs are ceil()'d so a request is never billed as 0 credits.

export interface PriceBook {
  /** Credits per 1,000,000 tokens for models not listed below. */
  default: number;
  /** Per-model overrides: model tag → credits per 1,000,000 tokens. */
  models: Record<string, number>;
}

export class Pricing {
  /** Price book keyed by LOWERCASED model id, so lookups are case-insensitive. This matters for
   *  Ollama-from-HuggingFace tags: providers pull a case-sensitive HF path (…Ornith-1.0-9B-GGUF…)
   *  but Ollama reports — and bills against — the lowercased id (…ornith-1.0-9b-gguf…). Lowercasing
   *  both the book and the query keeps the catalog's displayed price and the live billed price equal.
   *  Mirrors modelWeight(), which also lowercases before parsing. */
  private models: Record<string, number>;
  private fallback: number;
  /** Admin-set runtime overrides (persisted in the model-pricing store, loaded at boot). These win
   *  over the static prices.json book, so the operator can re-price a model — including one only ever
   *  billed at `default` — without a redeploy. Also lowercased for case-insensitive lookup. */
  private overrides: Record<string, number> = {};
  constructor(book: PriceBook) {
    this.fallback = book.default;
    this.models = {};
    for (const [k, v] of Object.entries(book.models ?? {})) this.models[k.toLowerCase()] = v;
  }

  /** Credits per 1,000,000 tokens for a model (case-insensitive). Override > book > default. */
  rate(model: string | undefined): number {
    const k = model?.toLowerCase();
    if (k && k in this.overrides) return this.overrides[k];
    if (k && k in this.models) return this.models[k];
    return this.fallback;
  }

  /** True iff this model has an explicit price (admin override or prices.json) — i.e. NOT just the
   *  default fallback. Lets callers distinguish "really priced at X" from "unpriced, billed default". */
  isPriced(model: string | undefined): boolean {
    const k = model?.toLowerCase();
    return !!k && (k in this.overrides || k in this.models);
  }

  /** Set/replace an admin override (credits per 1M tokens). */
  setOverride(model: string, creditsPerMTok: number): void {
    this.overrides[model.toLowerCase()] = creditsPerMTok;
  }

  /** Drop an admin override, falling back to prices.json / default. */
  clearOverride(model: string): void {
    delete this.overrides[model.toLowerCase()];
  }

  /** The default (fallback) rate — for showing "what an unpriced model currently earns". */
  get defaultRate(): number {
    return this.fallback;
  }

  /** Integer credits to charge for `tokens` total tokens of `model` (ceil; 0 if no tokens). */
  cost(model: string | undefined, tokens: number): number {
    if (!(tokens > 0)) return 0;
    return Math.ceil((tokens * this.rate(model)) / 1_000_000);
  }
}
