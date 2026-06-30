// `npm run pair` — link this Mac to a Solana wallet (P2, agent-first flow).
//   1. ask the dispatcher to start a pairing → get a connect link
//   2. open it; the human connects Phantom and signs (proves wallet ownership)
//   3. poll until the wallet-bound token is minted, save it, done
// After this, `npm run agent` registers under that wallet. No wallet secret ever touches the Mac.

import { spawn } from "node:child_process";
import { saveIdentity, IDENTITY_PATH, loadIdentity } from "./identity.js";

const DISPATCHER_URL = process.env.DISPATCHER_URL ?? "ws://127.0.0.1:8787";
// ws://→http://, wss://→https:// (the pairing API shares the dispatcher's HTTP port).
const httpBase = DISPATCHER_URL.replace(/^ws/, "http").replace(/\/$/, "");
const POLL_MS = 2000;
const TIMEOUT_MS = 10 * 60_000;

async function main() {
  const existing = loadIdentity();
  if (existing && process.env.FORCE !== "1") {
    console.log(`\n  This machine is already linked to wallet ${existing.address}.`);
    console.log(`  Re-pair with a different wallet:  FORCE=1 npm run pair\n`);
    return;
  }

  const initRes = await fetch(`${httpBase}/provider/pair/init`, { method: "POST" });
  if (!initRes.ok) throw new Error(`pair/init failed: HTTP ${initRes.status} from ${httpBase}`);
  const init = (await initRes.json()) as { pairingCode: string; claimSecret: string; connectUrl: string };

  console.log("\n  Link this machine to your wallet");
  console.log("  ───────────────────────────");
  console.log("  Open this link in a browser with Phantom and connect your wallet:\n");
  console.log(`    ${init.connectUrl}\n`);
  console.log(`  (pairing code ${init.pairingCode})`);
  console.log("  Waiting for you to sign…  Ctrl-C to cancel.\n");

  // Best-effort auto-open of the link (the link is printed above, so headless boxes just open it
  // on another device): macOS `open`, Linux `xdg-open`, Windows `start`. Harmless if it fails.
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { spawn(opener, [init.connectUrl], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); } catch {}

  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the wallet signature");
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await fetch(
      `${httpBase}/provider/pair/poll?code=${encodeURIComponent(init.pairingCode)}&secret=${encodeURIComponent(init.claimSecret)}`,
    );
    const poll = (await res.json()) as
      | { status: "pending" }
      | { status: "ready"; token: string; address: string }
      | { status: "error"; error: string };

    if (poll.status === "ready") {
      saveIdentity({ token: poll.token, address: poll.address });
      console.log(`  ✅ Linked to wallet ${poll.address}`);
      console.log(`  Token saved to ${IDENTITY_PATH}`);
      console.log(`  Start serving:  npm run agent\n`);
      return;
    }
    if (poll.status === "error") throw new Error(poll.error);
  }
}

/** Run the pairing handshake. Called by the CLI for `koretex-agent pair`. */
export async function runPair() {
  try {
    await main();
  } catch (e: any) {
    console.error(`\n  Pairing failed: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}
