// Earnings must aggregate by provider wallet (owner) — the basis for USDC payouts.
import { InMemorySettlement } from "../src/shared/settlement.ts";

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

const s = new InMemorySettlement();
s.record({ jobId: "j1", customerKey: "c1", nodeId: "n1", owner: "WALLET_A", usage: { completionTokens: 10 }, at: 1 });
s.record({ jobId: "j2", customerKey: "c1", nodeId: "n1", owner: "WALLET_A", usage: { completionTokens: 5 }, at: 2 });
s.record({ jobId: "j3", customerKey: "c2", nodeId: "n2", owner: "WALLET_B", usage: { completionTokens: 7 }, at: 3 });

const sum = await s.summary();
check(sum.jobs === 3, "counts all jobs");
check(sum.byOwner.WALLET_A === 15, "wallet A earns 15 (two jobs summed)");
check(sum.byOwner.WALLET_B === 7, "wallet B earns 7");

// Per-provider dashboard stats — scoped to one wallet, metadata only.
const statsA = await s.providerStats("WALLET_A");
check(statsA.jobs === 2 && statsA.completionTokens === 15, "providerStats scopes to the wallet");
check(statsA.recent.length === 2, "recent lists the wallet's jobs");
check(!("customerKey" in (statsA.recent[0] as object)), "provider's recent rows expose no customer identity");
check(JSON.stringify(statsA).indexOf("WALLET_B") === -1, "one wallet's stats never leak another's");

// Admin recent rows — newest first, full detail.
const rows = await s.recent(10);
check(rows.length === 3 && rows[0].jobId === "j3", "admin recent returns rows newest-first");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nledger attribution + dashboard stats: all checks passed");
