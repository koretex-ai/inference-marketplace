// Website-first enrollment over HTTP: connect wallet → mint token → token works as a node
// credential. Also checks admin endpoints are closed-by-default. Wallet is simulated.
import nacl from "tweetnacl";
import bs58 from "bs58";
import { WebSocket } from "ws";

const PORT = process.env.PORT ?? "8793";
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/node`;
const ADMIN = process.env.ADMIN_TOKEN ?? "test-admin";

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

// Pages.
const page = await fetch(`${HTTP}/provider`);
check(page.status === 200 && (await page.text()).includes("Earn from your Mac"), "GET /provider serves the page");
check((await fetch(`${HTTP}/`)).status === 200, "GET / serves the provider front door");

// Enroll.
const wallet = nacl.sign.keyPair();
const address = bs58.encode(wallet.publicKey);
const ch = await (await fetch(`${HTTP}/provider/challenge?for=enroll`)).json();
check(ch.message.includes("authorize a new provider node"), "enroll challenge uses the enroll message");
const sig = Buffer.from(
  nacl.sign.detached(new TextEncoder().encode(ch.message), wallet.secretKey),
).toString("base64");
const enroll = await (await fetch(`${HTTP}/provider/enroll`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pubkey: address, nonce: ch.nonce, signature: sig }),
})).json();
check(typeof enroll.token === "string" && enroll.token.startsWith("nt_") && enroll.address === address,
  "enroll mints a wallet-bound node token");

// The website-minted token works as a node credential.
function register(tok: string, nodeId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS);
    let ok = false;
    ws.on("open", () => ws.send(JSON.stringify({ t: "register", token: tok, nodeId, models: ["m"] })));
    ws.on("message", (r) => { if (JSON.parse(r.toString()).t === "registered") { ok = true; ws.close(); resolve(true); } });
    ws.on("close", () => { if (!ok) resolve(false); });
    ws.on("error", () => {});
  });
}
check(await register(enroll.token, "web-node"), "website-minted token registers a node");

// Bad signature rejected.
const ch2 = await (await fetch(`${HTTP}/provider/challenge?for=enroll`)).json();
const bad = await fetch(`${HTTP}/provider/enroll`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pubkey: address, nonce: ch2.nonce, signature: Buffer.from(new Uint8Array(64)).toString("base64") }),
});
check(bad.status === 401, "enroll rejects an invalid signature");

// Admin closed-by-default.
check((await fetch(`${HTTP}/admin/ledger`)).status === 401, "/admin/ledger denied without token (closed-by-default)");
check((await fetch(`${HTTP}/admin/ledger`, { headers: { authorization: `Bearer ${ADMIN}` } })).status === 200,
  "/admin/ledger allowed with the ADMIN_TOKEN bearer");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nwebsite-first enrollment + admin gating: all checks passed");
