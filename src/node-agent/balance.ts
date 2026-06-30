// `koretex balance` — show this machine's Koretex credit balance (earnings + purchases − spend).
//
// The self-custody wallet (wallet-keypair.ts) signs the same "view balance" challenge the website
// uses, so the dispatcher returns the wallet's balance with no browser. This is how the Hermes
// provider skill (and a human) check "how many credits do I have" for a headless node, since the
// self-custody wallet never appears in the Phantom-login web dashboard.

import { loadWallet } from "./wallet-keypair.js";

const httpBase = (
  process.env.KORETEX_DISPATCHER ??
  (process.env.DISPATCHER_URL ?? "ws://127.0.0.1:8787").replace(/^ws/, "http")
).replace(/\/$/, "");

const CREDITS_PER_USDC = 10000; // peg (display only): 1 credit = $0.0001

async function challenge(purpose: string): Promise<{ nonce: string; message: string }> {
  const r = await fetch(`${httpBase}/provider/challenge?for=${encodeURIComponent(purpose)}`);
  if (!r.ok) throw new Error(`challenge(${purpose}) failed: HTTP ${r.status} from ${httpBase}`);
  return (await r.json()) as { nonce: string; message: string };
}

interface BalanceResult {
  address: string;
  balance: number; // credits
  usd: number; // balance / peg
}

/** Fetch the wallet's balance (signed). Returns null if this machine has no wallet yet. */
export async function fetchBalance(): Promise<BalanceResult | null> {
  const w = loadWallet();
  if (!w) return null;
  const { nonce, message } = await challenge("credits");
  const res = await fetch(`${httpBase}/credits/balance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: w.address, nonce, signature: w.signMessage(message) }),
  });
  if (!res.ok) throw new Error(`balance failed: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { balance?: number };
  const balance = Number(j.balance ?? 0);
  return { address: w.address, balance, usd: balance / CREDITS_PER_USDC };
}

/** Entry point for `koretex balance [--json]`. */
export async function runBalance(): Promise<void> {
  try {
    const b = await fetchBalance();
    if (!b) {
      console.error("\n  No wallet on this machine yet. Run:  koretex enroll\n");
      process.exit(1);
    }
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(b));
      return;
    }
    console.log(`\n  Wallet:  ${b.address}`);
    console.log(`  Balance: ${b.balance.toLocaleString()} credits  (≈ $${b.usd.toFixed(4)})`);
    console.log(`  Dashboard: ${httpBase}/dashboard\n`);
  } catch (e: any) {
    console.error(`\n  Couldn't fetch balance: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}
