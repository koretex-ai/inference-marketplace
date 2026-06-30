// Stripe (card) money-in — the fiat counterpart to the on-chain USDC flow in ./solana.ts.
// A customer pays by card on Stripe's HOSTED Checkout page (no Stripe.js / card fields ever
// touch our frontend, so we carry no PCI scope). Two halves:
//   - createCheckoutSession(): the buy page asks for a hosted payment URL and redirects there.
//   - constructEvent():        Stripe calls our webhook when the payment completes; we verify the
//                              signature (the proof — never the browser's word) and the dispatcher
//                              credits the wallet via the SAME CreditStore.recordPurchase() the
//                              USDC path uses, keyed on "stripe:<session id>" so it's idempotent.
//
// Optional, like the rest of money-in: with no STRIPE_SECRET_KEY the helper is disabled
// (isEnabled() === false), /credits/config reports it off, and the card button stays hidden.

import Stripe from "stripe";

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

export interface CheckoutParams {
  /** Solana wallet to credit once the payment completes (carried in metadata + client_reference_id). */
  wallet: string;
  /** Amount in whole USD the customer chose to top up. */
  usd: number;
  /** Site origin (scheme + host) the customer came from — where Stripe returns them. */
  origin: string;
}

/** Thin wrapper around the Stripe SDK. Constructed once at startup; a no-op shell when disabled. */
export class StripePayments {
  private readonly client: Stripe | null;
  private readonly webhookSecret: string;

  constructor(cfg: Partial<StripeConfig>) {
    const secret = cfg.secretKey ?? "";
    this.webhookSecret = cfg.webhookSecret ?? "";
    // API version is pinned by the installed SDK major (stripe@^22) — no override needed.
    this.client = secret ? new Stripe(secret) : null;
  }

  /** True when a secret key is configured — card purchases are available. */
  isEnabled(): boolean {
    return this.client !== null;
  }

  /** Create a hosted Checkout Session and return the URL to redirect the customer to. */
  async createCheckoutSession(p: CheckoutParams): Promise<string> {
    if (!this.client) throw new Error("card payments are not enabled");
    const session = await this.client.checkout.sessions.create({
      mode: "payment",
      client_reference_id: p.wallet,
      metadata: { wallet: p.wallet },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            // Stripe amounts are in the currency's minor unit (cents).
            unit_amount: Math.round(p.usd * 100),
            product_data: { name: "Koretex credits" },
          },
        },
      ],
      success_url: `${p.origin}/app#credits?stripe=success`,
      cancel_url: `${p.origin}/app#credits?stripe=cancel`,
    });
    if (!session.url) throw new Error("stripe did not return a checkout url");
    return session.url;
  }

  /** Verify a webhook payload's signature and return the parsed event. Throws if the signature
   *  (computed with STRIPE_WEBHOOK_SECRET over the RAW body) doesn't match — the spoof guard. */
  constructEvent(rawBody: string, sigHeader: string): Stripe.Event {
    if (!this.client) throw new Error("card payments are not enabled");
    if (!this.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
    return this.client.webhooks.constructEvent(rawBody, sigHeader, this.webhookSecret);
  }
}
