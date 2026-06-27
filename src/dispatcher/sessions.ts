// Short-lived wallet sessions for the credits page. A wallet signs ONE challenge to open a
// session; the resulting bearer token then authenticates subsequent read/mint calls for the
// TTL, so the user isn't prompted to sign on every action (balance, refresh, create key).
//
// In-memory by design, like Challenges: if the dispatcher restarts the worst case is the user
// signs once more to re-open a session. Tokens carry no authority beyond proving the holder
// proved wallet ownership recently — they gate low-sensitivity reads + minting an API key
// (whose secret is still only shown once, at mint time).

import { randomBytes } from "node:crypto";

const TTL_MS = 30 * 60_000; // 30 minutes

export class Sessions {
  private live = new Map<string, { wallet: string; exp: number }>(); // token -> { wallet, expiry ms }

  /** Open a session for a wallet. `now` injected for testability. Returns the token + expiry. */
  issue(wallet: string, now: number): { token: string; expiresAt: number } {
    for (const [t, s] of this.live) if (s.exp < now) this.live.delete(t); // gc expired
    const token = "cs_" + randomBytes(24).toString("base64url");
    const expiresAt = now + TTL_MS;
    this.live.set(token, { wallet, exp: expiresAt });
    return { token, expiresAt };
  }

  /** Resolve a live session token to its wallet, or null if unknown/expired. */
  resolve(token: string, now: number): string | null {
    const s = this.live.get(token);
    if (!s || s.exp < now) {
      if (s) this.live.delete(token);
      return null;
    }
    return s.wallet;
  }

  /** Revoke a session (e.g. on explicit wallet disconnect). */
  revoke(token: string): void {
    this.live.delete(token);
  }
}
