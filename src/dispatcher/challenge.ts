// Short-lived, single-use nonces for wallet sign-in (the dashboard). The dispatcher issues a
// nonce, the wallet signs a message containing it, and the nonce is consumed on verify — so a
// captured signature can't be replayed. In-memory is fine: nonces are ephemeral by design.

import { randomBytes } from "node:crypto";

const TTL_MS = 5 * 60_000;

export class Challenges {
  private live = new Map<string, number>(); // nonce -> expiry (ms)

  /** Issue a fresh nonce. `now` injected for testability. */
  issue(now: number): string {
    for (const [n, exp] of this.live) if (exp < now) this.live.delete(n); // gc
    const nonce = randomBytes(16).toString("hex");
    this.live.set(nonce, now + TTL_MS);
    return nonce;
  }

  /** Validate + consume a nonce (single use). Returns false if unknown/expired. */
  consume(nonce: string, now: number): boolean {
    const exp = this.live.get(nonce);
    if (exp == null || exp < now) return false;
    this.live.delete(nonce);
    return true;
  }
}
