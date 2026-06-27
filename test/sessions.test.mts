// Wallet sessions: sign once, reuse a bearer token for the TTL. Proves a token resolves to its
// wallet while live, expires on the dot, is single-wallet, and that revoke/gc behave.
import { Sessions } from "../src/dispatcher/sessions.ts";

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

const TTL = 30 * 60_000;
const t0 = 1_000_000; // fixed clock; the store takes `now` so tests are deterministic

const s = new Sessions();
const { token, expiresAt } = s.issue("WALLET_A", t0);

check(typeof token === "string" && token.startsWith("cs_"), "issues an opaque cs_ token");
check(expiresAt === t0 + TTL, "expiry is now + TTL");
check(s.resolve(token, t0) === "WALLET_A", "a live token resolves to its wallet");
check(s.resolve(token, t0 + TTL) === "WALLET_A", "valid through its expiresAt (matches Challenges semantics)");
check(s.resolve(token, t0 + TTL + 1) === null, "expired once the clock passes expiresAt");
check(s.resolve(token, t0) === null, "resolving an expired token also evicts it (no resurrection)");
check(s.resolve("cs_does-not-exist", t0) === null, "unknown token resolves to null, not throw");

// Tokens are per-issue and per-wallet — one wallet's token never resolves to another's.
const a = s.issue("WALLET_A", t0).token;
const b = s.issue("WALLET_B", t0).token;
check(s.resolve(a, t0) === "WALLET_A" && s.resolve(b, t0) === "WALLET_B", "two wallets get distinct, correctly-scoped tokens");
check(a !== b, "each issue mints a unique token");

// Revoke logs a session out immediately, before its TTL.
const c = s.issue("WALLET_C", t0).token;
s.revoke(c);
check(s.resolve(c, t0) === null, "revoked token no longer resolves");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nwallet sessions: all checks passed");
