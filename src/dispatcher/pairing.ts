// Pairing: the "connect your wallet once" handshake (P2).
//
//   1. agent  -> init()     : gets a pairingCode (shown to the human) + claimSecret (kept private)
//   2. human  -> /connect    : opens the web page, signs the auth message in Phantom
//   3. page   -> confirm()   : submits {pairingCode, walletAddress, signature}; we verify + mint a token
//   4. agent  -> poll()      : with its claimSecret, collects the minted token, stores it, connects
//
// Pending sessions are short-lived and in-memory (a restart mid-pairing just makes the agent
// re-init). The minted *token* is what must be durable — that lives in the ProviderStore.

import { randomBytes } from "node:crypto";
import { buildAuthMessage, verifyWalletSignature, isValidSolanaAddress } from "../shared/wallet.js";
import type { ProviderStore } from "../shared/provider-store.js";

const PAIR_TTL_MS = 10 * 60_000; // a human has 10 minutes to complete the wallet signature

interface PendingPair {
  nonce: string;
  claimSecret: string;
  createdAt: number;
  result?: { token: string; address: string };
}

export type ConfirmResult = { ok: true; address: string } | { ok: false; error: string };
export type PollResult =
  | { status: "pending" }
  | { status: "ready"; token: string; address: string }
  | { status: "error"; error: string };

export class Pairing {
  private pending = new Map<string, PendingPair>(); // pairingCode -> session
  constructor(private store: ProviderStore) {}

  private gc(now: number): void {
    for (const [code, p] of this.pending)
      if (now - p.createdAt > PAIR_TTL_MS) this.pending.delete(code);
  }

  /** Step 1 — agent starts pairing. `now` is injected so the logic stays pure/testable. */
  init(now: number): { pairingCode: string; claimSecret: string } {
    this.gc(now);
    const pairingCode = "PAIR-" + randomBytes(4).toString("hex").toUpperCase();
    const nonce = randomBytes(16).toString("hex");
    const claimSecret = randomBytes(24).toString("base64url");
    this.pending.set(pairingCode, { nonce, claimSecret, createdAt: now });
    return { pairingCode, claimSecret };
  }

  /** The exact message the web page must have the wallet sign for this code. */
  messageFor(pairingCode: string): string | null {
    const p = this.pending.get(pairingCode);
    return p ? buildAuthMessage(pairingCode, p.nonce) : null;
  }

  /** Step 3 — web page submits the signature. Verify against the wallet, then mint a token. */
  async confirm(pairingCode: string, pubkey: string, signatureB64: string): Promise<ConfirmResult> {
    const p = this.pending.get(pairingCode);
    if (!p) return { ok: false, error: "unknown or expired pairing code" };
    if (!isValidSolanaAddress(pubkey)) return { ok: false, error: "invalid wallet address" };
    const message = buildAuthMessage(pairingCode, p.nonce);
    if (!verifyWalletSignature(pubkey, message, signatureB64))
      return { ok: false, error: "signature verification failed" };

    await this.store.upsertProvider(pubkey);
    const token = await this.store.mintToken(pubkey);
    p.result = { token, address: pubkey };
    return { ok: true, address: pubkey };
  }

  /** Step 4 — agent collects its token (once), proving it owns the session via claimSecret. */
  poll(pairingCode: string, claimSecret: string): PollResult {
    const p = this.pending.get(pairingCode);
    if (!p) return { status: "error", error: "unknown or expired pairing code" };
    if (p.claimSecret !== claimSecret) return { status: "error", error: "bad claim secret" };
    if (!p.result) return { status: "pending" };
    this.pending.delete(pairingCode); // single-use claim
    return { status: "ready", token: p.result.token, address: p.result.address };
  }
}
