// LIVE integration check (skipped unless SOLANA_RPC_URL is set): proves the RPC + ATA-derivation
// + parsing path works against a real cluster. Run:
//   SOLANA_RPC_URL=... ADMIN_FEE_WALLET=... npx tsx test/solana-live.test.mts
import { SolanaVerifier } from "../src/shared/solana.ts";

const rpc = process.env.SOLANA_RPC_URL;
const admin = process.env.ADMIN_FEE_WALLET; // set ADMIN_FEE_WALLET to your fee wallet to run the live check
if (!admin) { console.log("SKIP: set ADMIN_FEE_WALLET to run the live check"); process.exit(0); }
if (!rpc) {
  console.log("SKIP: set SOLANA_RPC_URL to run the live check");
  process.exit(0);
}

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

const v = new SolanaVerifier({ rpcUrl: rpc, adminWallet: admin, commitment: process.env.SOLANA_COMMITMENT });

const ata = v.adminUsdcAccount();
console.log(`  admin USDC account: ${ata}`);
check(typeof ata === "string" && ata.length >= 32, "derives the fee wallet's USDC token account");

const sigs = await v.incomingDeposits(5);
console.log(`  recent incoming deposit signatures: ${sigs.length}`);
check(Array.isArray(sigs), "lists recent incoming deposits over RPC");

if (sigs.length) {
  const r = await v.verifyDeposit(sigs[0]);
  console.log(`  verifyDeposit(latest): ${JSON.stringify(r)}`);
  check("ok" in r, "verifyDeposit returns a result for a real deposit");
} else {
  console.log("  (no deposits to this wallet yet — verifyDeposit not exercised)");
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nlive Solana path: all checks passed");
