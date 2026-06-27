// Provider + node-token store (P2). A "provider" is a Solana wallet. A wallet can run
// several Macs, each holding a long-lived, revocable node token bound to that wallet.
// The node presents its token on every reconnect; the dispatcher resolves token -> wallet
// and attributes earnings (and payouts) to that wallet. Mirrors the SettlementProvider
// seam: in-memory now, Postgres-backed next (so a redeploy doesn't log every provider out).

import { randomBytes } from "node:crypto";

export interface ProviderStore {
  init?(): Promise<void>;
  /** Record a provider wallet (no-op if already known). */
  upsertProvider(pubkey: string): Promise<void>;
  /** Mint a durable, revocable node token bound to a wallet. Returns the opaque token. */
  mintToken(pubkey: string, label?: string): Promise<string>;
  /** Resolve a node token to its wallet pubkey, or null if unknown/revoked. */
  resolveToken(token: string): Promise<string | null>;
  /** Revoke a token (log a node out without touching the wallet's other nodes). */
  revokeToken(token: string): Promise<void>;
}

/** Opaque, URL-safe node token. The `nt_` prefix makes it greppable in logs/config. */
export function newToken(): string {
  return "nt_" + randomBytes(24).toString("base64url");
}

export class InMemoryProviderStore implements ProviderStore {
  private providers = new Set<string>();
  private tokens = new Map<string, string>(); // token -> wallet pubkey

  async upsertProvider(pubkey: string): Promise<void> {
    this.providers.add(pubkey);
  }
  async mintToken(pubkey: string): Promise<string> {
    const t = newToken();
    this.tokens.set(t, pubkey);
    return t;
  }
  async resolveToken(token: string): Promise<string | null> {
    return this.tokens.get(token) ?? null;
  }
  async revokeToken(token: string): Promise<void> {
    this.tokens.delete(token);
  }
}
