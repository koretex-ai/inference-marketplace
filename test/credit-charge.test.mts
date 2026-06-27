// An inference charge must move credits caller → supplier by the SAME amount, be idempotent per
// job (a replayed `done` can't double-bill), and conserve total credits.
import { InMemoryCreditStore } from "../src/shared/credits.ts";

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

const s = new InMemoryCreditStore();
// Fund the caller with a purchase first.
await s.recordPurchase({ signature: "buy1", wallet: "CALLER", usdcRaw: 1_000_000, credits: 10000, slot: 1, blockTime: null, at: 1 });
check(await s.balance("CALLER") === 10000, "caller starts with purchased credits");
check(await s.balance("SUPPLIER") === 0, "supplier starts at 0");

await s.recordInferenceCharge({ jobId: "j1", customerWallet: "CALLER", providerWallet: "SUPPLIER", credits: 250, at: 2 });
check(await s.balance("CALLER") === 9750, "caller debited by the charge");
check(await s.balance("SUPPLIER") === 250, "supplier credited the same amount");

// Idempotent: replaying the same job changes nothing.
await s.recordInferenceCharge({ jobId: "j1", customerWallet: "CALLER", providerWallet: "SUPPLIER", credits: 250, at: 3 });
check(await s.balance("CALLER") === 9750 && await s.balance("SUPPLIER") === 250, "replayed job does not double-bill");

// Conservation: caller loss == supplier gain.
check((10000 - await s.balance("CALLER")) === await s.balance("SUPPLIER"), "credits are conserved (debit == credit)");

// Self-deal (same wallet both sides) is a no-op.
await s.recordInferenceCharge({ jobId: "j2", customerWallet: "SUPPLIER", providerWallet: "SUPPLIER", credits: 100, at: 4 });
check(await s.balance("SUPPLIER") === 250, "charge where caller == supplier is a no-op");

// Zero/negative cost is a no-op.
await s.recordInferenceCharge({ jobId: "j3", customerWallet: "CALLER", providerWallet: "SUPPLIER", credits: 0, at: 5 });
check(await s.balance("CALLER") === 9750, "zero-credit charge does nothing");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ninference charge double-entry: all checks passed");
