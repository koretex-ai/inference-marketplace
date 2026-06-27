// Credit purchases must be idempotent (a deposit credited at most once) and balance must sum a
// wallet's purchases. The signature is the idempotency anchor.
import { InMemoryCreditStore } from "../src/shared/credits.ts";

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

const s = new InMemoryCreditStore();
const p = (sig: string, wallet: string, usdcRaw: number, credits: number, at: number) =>
  ({ signature: sig, wallet, usdcRaw, credits, slot: 1, blockTime: null, at });

check(await s.recordPurchase(p("sigA", "WALLET_A", 10_000_000, 1000, 1)) === true, "first record credits");
check(await s.recordPurchase(p("sigA", "WALLET_A", 10_000_000, 1000, 2)) === false, "same signature is a no-op (idempotent)");
check(await s.balance("WALLET_A") === 1000, "balance counts the deposit once, not twice");

await s.recordPurchase(p("sigB", "WALLET_A", 5_000_000, 500, 3));
check(await s.balance("WALLET_A") === 1500, "balance sums a wallet's purchases");

await s.recordPurchase(p("sigC", "WALLET_B", 2_000_000, 200, 4));
check(await s.balance("WALLET_B") === 200, "balances are per-wallet");
check(await s.balance("WALLET_A") === 1500, "one wallet's deposit never touches another's balance");

check(await s.has("sigA") === true && await s.has("sigZ") === false, "has() reports whether a signature was credited");

const recent = await s.purchases("WALLET_A", 25);
check(recent.length === 2 && recent[0].signature === "sigB", "purchases are newest-first, scoped to the wallet");
check(JSON.stringify(await s.purchases("WALLET_A", 25)).indexOf("WALLET_B") === -1, "a wallet's history never leaks another's");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ncredit store idempotency + balances: all checks passed");
