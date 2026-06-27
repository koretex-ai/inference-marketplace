// Customer identity for METERED inference (M4). A customer is a Solana wallet (the same wallet
// that buys credits). To call the OpenAI-compatible gateway they mint a wallet-bound API key:
// the gateway resolves key → wallet and debits that wallet's credit balance per request. This
// mirrors the provider-side node-token store (P2): connect your wallet once, get a revocable key.
//
// The wallet's secret never touches us — minting is gated by a signed message (see the dispatcher).

import { randomBytes } from "node:crypto";

/** A customer key, masked for display (we never re-show the full secret after minting). */
export interface CustomerKeyInfo {
  /** Masked form, e.g. "sk-cust-…a1b2". The full key is shown only once, at mint time. */
  masked: string;
  label: string | null;
  createdAt: number;
}

export interface CustomerStore {
  init?(): Promise<void>;
  /** Mint a revocable API key bound to a wallet. Returns the full secret (shown once). */
  mintKey(wallet: string, label?: string): Promise<string>;
  /** Resolve an API key to its wallet, or null if unknown/revoked. */
  resolveKey(key: string): Promise<string | null>;
  /** A wallet's keys (masked) for display. */
  keysFor(wallet: string): Promise<CustomerKeyInfo[]>;
  /** Revoke a key. */
  revokeKey(key: string): Promise<void>;
}

/** Opaque customer API key. `sk-cust-` prefix matches the existing customer-key convention. */
export function newCustomerKey(): string {
  return "sk-cust-" + randomBytes(24).toString("base64url");
}

/** Mask a key for display: keep the prefix and the last 4 chars. */
export function maskKey(key: string): string {
  return key.length > 12 ? key.slice(0, 8) + "…" + key.slice(-4) : "sk-cust-…";
}

export class InMemoryCustomerStore implements CustomerStore {
  private keys = new Map<string, { wallet: string; label: string | null; createdAt: number; revoked: boolean }>();
  private clock = 0;

  async mintKey(wallet: string, label?: string): Promise<string> {
    const key = newCustomerKey();
    this.keys.set(key, { wallet, label: label ?? null, createdAt: ++this.clock, revoked: false });
    return key;
  }
  async resolveKey(key: string): Promise<string | null> {
    const e = this.keys.get(key);
    return e && !e.revoked ? e.wallet : null;
  }
  async keysFor(wallet: string): Promise<CustomerKeyInfo[]> {
    const out: CustomerKeyInfo[] = [];
    for (const [key, e] of this.keys)
      if (e.wallet === wallet && !e.revoked) out.push({ masked: maskKey(key), label: e.label, createdAt: e.createdAt });
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
  async revokeKey(key: string): Promise<void> {
    const e = this.keys.get(key);
    if (e) e.revoked = true;
  }
}
