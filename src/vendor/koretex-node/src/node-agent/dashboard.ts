// `koretex dashboard` — open the web dashboard authenticated as THIS machine's self-custody wallet,
// with no Google/Phantom login. The node already holds the keypair (wallet-keypair.ts), so it can
// sign the same dashboard challenge the website signs. We exchange that signature for a short-lived
// session token and open the browser to `<dispatcher>/dashboard#kx=<base64>` — the SPA reads the
// session from the URL hash and renders this wallet's dashboard directly.
//
// The token rides in the URL *fragment* (after #), which browsers never send to the server, so it
// stays out of server/proxy logs. It's short-lived (the session TTL) and single-wallet-scoped.

import os from "node:os";
import { spawn } from "node:child_process";
import { loadOrCreateWallet } from "./wallet-keypair.js";

const httpBase = (
  process.env.KORETEX_DISPATCHER ??
  (process.env.DISPATCHER_URL ?? "ws://127.0.0.1:8787").replace(/^ws/, "http")
).replace(/\/$/, "");

/** Fetch a single-use dashboard challenge and return the exact message string to sign. */
async function challenge(): Promise<{ nonce: string; message: string }> {
  const r = await fetch(`${httpBase}/provider/challenge?for=dashboard`);
  if (!r.ok) throw new Error(`dashboard challenge failed: HTTP ${r.status} from ${httpBase}`);
  return (await r.json()) as { nonce: string; message: string };
}

function base64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Best-effort open a URL in the default browser, cross-platform. Never throws. */
function openBrowser(url: string): void {
  try {
    const plat = os.platform();
    const [cmd, args] =
      plat === "darwin" ? ["open", [url]]
      : plat === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
    spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* headless / no browser — the printed URL is the fallback */
  }
}

async function main(): Promise<void> {
  const wallet = loadOrCreateWallet();
  const { nonce, message } = await challenge();
  const res = await fetch(`${httpBase}/provider/stats`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: wallet.address, nonce, signature: wallet.signMessage(message) }),
  });
  if (!res.ok) throw new Error(`dashboard sign-in failed: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
  const d = (await res.json()) as { session?: string; sessionExpiresAt?: number };
  if (!d.session) throw new Error("dispatcher did not return a session token");

  const payload = base64url(JSON.stringify({ pubkey: wallet.address, session: d.session, exp: d.sessionExpiresAt ?? 0 }));
  const url = `${httpBase}/dashboard#kx=${payload}`;

  console.log(`\n  Opening your Koretex dashboard (wallet ${wallet.address})…`);
  console.log(`  If it doesn't open automatically, paste this into your browser:\n  ${url}\n`);
  openBrowser(url);
}

/** Entry point for `koretex dashboard`. */
export async function runDashboard(): Promise<void> {
  try {
    await main();
  } catch (e: any) {
    console.error(`\n  Couldn't open the dashboard: ${e?.message ?? e}\n  (Is this machine enrolled? Try \`koretex enroll\` first.)\n`);
    process.exit(1);
  }
}
