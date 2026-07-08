// QR sign-in: open the web dashboard as a wallet that lives on a PHONE (Seeker app).
// Mirror of Pairing, but what gets minted is a short-lived dashboard SESSION, not a node token:
//
//   1. browser -> init()    : gets a loginCode (shown under the QR) + claimSecret (kept in-page)
//   2. phone   -> scans QR  : the Koretex wallet app opens /connect?login=<code>, fetches the
//                             message, shows a "sign in on your computer?" sheet, signs
//   3. app     -> approve() : {loginCode, pubkey, signature}; we verify and issue a session
//   4. browser -> poll()    : with its claimSecret, collects {pubkey, session} and boots the
//                             dashboard via the existing #kx= session bootstrap
//
// Sessions are the same read-only, TTL'd dashboard sessions `koretex dashboard` uses.

import { randomBytes } from "node:crypto";
import { buildQrLoginMessage, verifyWalletSignature, isValidSolanaAddress } from "../shared/wallet.js";

const LOGIN_TTL_MS = 5 * 60_000; // a QR left on screen shouldn't be approvable forever

interface PendingLogin {
  nonce: string;
  claimSecret: string;
  createdAt: number;
  result?: { pubkey: string; session: string; expiresAt: number };
}

export type LoginPollResult =
  | { status: "pending" }
  | { status: "ready"; pubkey: string; session: string; expiresAt: number }
  | { status: "error"; error: string };

export class QrLogin {
  private pending = new Map<string, PendingLogin>(); // loginCode -> session
  /** `issueSession` is the dispatcher's Sessions.issue — injected to avoid a store dependency. */
  constructor(private issueSession: (pubkey: string, now: number) => { token: string; expiresAt: number }) {}

  private gc(now: number): void {
    for (const [code, p] of this.pending)
      if (now - p.createdAt > LOGIN_TTL_MS) this.pending.delete(code);
  }

  init(now: number): { loginCode: string; claimSecret: string } {
    this.gc(now);
    const loginCode = "LOGIN-" + randomBytes(4).toString("hex").toUpperCase();
    this.pending.set(loginCode, {
      nonce: randomBytes(16).toString("hex"),
      claimSecret: randomBytes(24).toString("base64url"),
      createdAt: now,
    });
    const p = this.pending.get(loginCode)!;
    return { loginCode, claimSecret: p.claimSecret };
  }

  /** The exact message the phone's wallet must sign for this code. */
  messageFor(loginCode: string): string | null {
    const p = this.pending.get(loginCode);
    return p ? buildQrLoginMessage(loginCode, p.nonce) : null;
  }

  approve(loginCode: string, pubkey: string, signatureB64: string, now: number): { ok: true } | { ok: false; error: string } {
    const p = this.pending.get(loginCode);
    if (!p) return { ok: false, error: "unknown or expired login code" };
    if (!isValidSolanaAddress(pubkey)) return { ok: false, error: "invalid wallet address" };
    if (!verifyWalletSignature(pubkey, buildQrLoginMessage(loginCode, p.nonce), signatureB64))
      return { ok: false, error: "signature verification failed" };
    const s = this.issueSession(pubkey, now);
    p.result = { pubkey, session: s.token, expiresAt: s.expiresAt };
    return { ok: true };
  }

  /** Browser collects the session (once), proving it owns the QR via claimSecret. */
  poll(loginCode: string, claimSecret: string): LoginPollResult {
    const p = this.pending.get(loginCode);
    if (!p) return { status: "error", error: "unknown or expired login code" };
    if (p.claimSecret !== claimSecret) return { status: "error", error: "bad claim secret" };
    if (!p.result) return { status: "pending" };
    this.pending.delete(loginCode); // single-use
    return { status: "ready", ...p.result };
  }
}
