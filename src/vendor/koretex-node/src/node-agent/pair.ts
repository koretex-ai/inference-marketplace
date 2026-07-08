// `npm run pair` — link this machine to a Solana wallet (P2, agent-first flow).
//   1. ask the dispatcher to start a pairing → get a connect link (sent with this machine's
//      hostname/hardware so the approver can recognize it)
//   2. approve it on another device: scan the QR with a phone — on a Seeker the Koretex wallet
//      app opens with an approval sheet; any other phone/browser gets the Phantom/Google page
//   3. poll until the wallet-bound token is minted, save it, done
// After this, `npm run agent` registers under that wallet. No wallet secret ever touches this box.

import { spawn, execFileSync } from "node:child_process";
import os from "node:os";
import qrcode from "qrcode-terminal";
import { saveIdentity, IDENTITY_PATH, loadIdentity } from "./identity.js";

const DISPATCHER_URL = process.env.DISPATCHER_URL ?? "ws://127.0.0.1:8787";
// ws://→http://, wss://→https:// (the pairing API shares the dispatcher's HTTP port).
const httpBase = DISPATCHER_URL.replace(/^ws/, "http").replace(/\/$/, "");
const POLL_MS = 2000;
const TIMEOUT_MS = 10 * 60_000;

/** One-line hardware summary for the approval sheet (chip + memory + OS). Best-effort. */
function hardwareSummary(): string {
  const ramGb = Math.round(os.totalmem() / 1024 ** 3);
  const osName = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  let chip = os.cpus()?.[0]?.model ?? "";
  if (process.platform === "darwin") {
    try {
      chip = execFileSync("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim() || chip;
    } catch {}
  }
  return [chip, ramGb ? `${ramGb}GB` : "", osName].filter(Boolean).join(", ");
}

async function main() {
  const existing = loadIdentity();
  if (existing && process.env.FORCE !== "1") {
    console.log(`\n  This machine is already linked to wallet ${existing.address}.`);
    console.log(`  Re-pair with a different wallet:  FORCE=1 npm run pair\n`);
    return;
  }

  const initRes = await fetch(`${httpBase}/provider/pair/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: os.hostname(), hardware: hardwareSummary() }),
  });
  if (!initRes.ok) throw new Error(`pair/init failed: HTTP ${initRes.status} from ${httpBase}`);
  const init = (await initRes.json()) as { pairingCode: string; claimSecret: string; connectUrl: string };

  console.log("\n  Link this machine to your wallet");
  console.log("  ───────────────────────────");
  console.log("  Scan with your phone (Koretex wallet app or camera), or open in a browser:\n");
  // small=true halves the QR height with half-block characters — fits a normal terminal.
  qrcode.generate(init.connectUrl, { small: true }, (q: string) => {
    console.log(q.replace(/^/gm, "    "));
  });
  console.log(`    ${init.connectUrl}\n`);
  console.log(`  (pairing code ${init.pairingCode})`);
  console.log("  Waiting for approval…  Ctrl-C to cancel.\n");

  // Best-effort auto-open of the link (the QR + link cover other devices): macOS `open`,
  // Linux `xdg-open`, Windows `start`. Harmless if it fails.
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
