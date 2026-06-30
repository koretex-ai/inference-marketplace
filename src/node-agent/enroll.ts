// `koretex enroll` — HEADLESS, self-custody enrollment. The unattended counterpart to `pair`.
//
// `pair` needs a human to sign in Phantom in a browser; `enroll` needs nobody: it generates a local
// wallet (see wallet-keypair.ts) and uses it to drive the SAME signed handshakes the website uses —
//   1. node token  : GET /provider/challenge?for=enroll → sign → POST /provider/enroll  → nt_… token
//   2. customer key : GET /provider/challenge?for=credits → sign → POST /customer/key   → sk-cust-… key
// Both bind to the same wallet, so this machine EARNS credits (serving) and SPENDS them (its own
// inference) under one identity — the loop the Hermes provider skill relies on. The token lands in
// ~/.koretex/node.json (used by the agent); the customer key in ~/.koretex/customer.json (read by
// whatever does the machine's own inference, e.g. Hermes).
//
// Idempotent: re-running reuses the existing node token unless FORCE=1, and tops up a missing
// customer key. Safe to call from an installer or a skill setup script every time.

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadIdentity, saveIdentity } from "./identity.js";
import { loadOrCreateWallet, type LocalWallet } from "./wallet-keypair.js";

const DIR = path.join(os.homedir(), ".koretex");
const CUSTOMER_PATH = path.join(DIR, "customer.json");

// Prefer the HTTPS dispatcher the `koretex` wrapper injects; else derive from the agent's WS URL
// (ws→http, wss→https), like pair.ts; else local dev.
const httpBase = (
  process.env.KORETEX_DISPATCHER ??
  (process.env.DISPATCHER_URL ?? "ws://127.0.0.1:8787").replace(/^ws/, "http")
).replace(/\/$/, "");

interface CustomerIdentity {
  /** Wallet-bound API key (sk-cust-…) for THIS machine's own metered inference. */
  key: string;
  /** The wallet it bills (== the node's earning wallet). */
  address: string;
}

export function loadCustomerKey(): CustomerIdentity | null {
  try {
    const c = JSON.parse(readFileSync(CUSTOMER_PATH, "utf8")) as CustomerIdentity;
    return c?.key ? c : null;
  } catch {
    return null;
  }
}

function saveCustomerKey(c: CustomerIdentity): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CUSTOMER_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
}

/** Fetch a single-use challenge for `purpose` and return the exact message string to sign. */
async function challenge(purpose: string): Promise<{ nonce: string; message: string }> {
  const r = await fetch(`${httpBase}/provider/challenge?for=${encodeURIComponent(purpose)}`);
  if (!r.ok) throw new Error(`challenge(${purpose}) failed: HTTP ${r.status} from ${httpBase}`);
  return (await r.json()) as { nonce: string; message: string };
}

/** Mint a wallet-bound node token (the earning identity). Reuses an existing one unless force. */
async function enrollNode(wallet: LocalWallet, force: boolean): Promise<string> {
  const existing = loadIdentity();
  if (existing?.token && existing.address === wallet.address && !force) return existing.token;

  const { nonce, message } = await challenge("enroll");
  const res = await fetch(`${httpBase}/provider/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: wallet.address, nonce, signature: wallet.signMessage(message) }),
  });
  if (!res.ok) throw new Error(`enroll failed: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
  const { token, address } = (await res.json()) as { token: string; address: string };
  saveIdentity({ token, address, nodeId: existing?.nodeId });
  return token;
}

/** Mint a wallet-bound customer API key (the spending identity). Reuses an existing one unless force. */
async function mintCustomerKey(wallet: LocalWallet, force: boolean): Promise<string> {
  const existing = loadCustomerKey();
  if (existing?.key && existing.address === wallet.address && !force) return existing.key;

  const { nonce, message } = await challenge("credits");
  const res = await fetch(`${httpBase}/customer/key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: wallet.address, nonce, signature: wallet.signMessage(message) }),
  });
  if (!res.ok) throw new Error(`customer key mint failed: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
  const { key } = (await res.json()) as { key: string };
  saveCustomerKey({ key, address: wallet.address });
  return key;
}

async function main(): Promise<void> {
  const force = process.env.FORCE === "1";
  const jsonOut = process.argv.includes("--json");
  const wallet = loadOrCreateWallet();

  const token = await enrollNode(wallet, force);
  let customerKey: string | null = null;
  let customerError: string | null = null;
  try {
    customerKey = await mintCustomerKey(wallet, force);
  } catch (e: any) {
    // Enrollment (earning) is the critical half; a customer-key hiccup shouldn't fail the install.
    customerError = e?.message ?? String(e);
  }

  if (jsonOut) {
    // Machine-readable for skills/installers. Never print the secrets themselves — only their paths.
    console.log(
      JSON.stringify({
        address: wallet.address,
        enrolled: !!token,
        nodePath: path.join(DIR, "node.json"),
        customerKey: !!customerKey,
        customerPath: CUSTOMER_PATH,
        customerError,
        dispatcher: httpBase,
      }),
    );
    return;
  }

  console.log(`\n  Enrolled this machine (self-custody wallet)`);
  console.log("  ───────────────────────────────────────────");
  console.log(`  Wallet:        ${wallet.address}`);
  console.log(`  Node token:    saved to ${path.join(DIR, "node.json")}`);
  console.log(
    customerKey
      ? `  Customer key:  saved to ${CUSTOMER_PATH} (for this machine's own inference)`
      : `  Customer key:  NOT minted — ${customerError} (retry: koretex enroll)`,
  );
  console.log(`  Dashboard:     ${httpBase}/dashboard\n`);
  console.log(`  Next: pick a model to serve →  koretex autoserve\n`);
}

/** Entry point for `koretex enroll [--json]`. */
export async function runEnroll(): Promise<void> {
  try {
    await main();
  } catch (e: any) {
    console.error(`\n  Enrollment failed: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}
