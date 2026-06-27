// Revoke-a-node end to end: enroll → connect a node → owner revokes it (signed) →
// node is disconnected and its token can no longer reconnect. Non-owner can't revoke.
import nacl from "tweetnacl";
import bs58 from "bs58";
import { WebSocket } from "ws";

const PORT = process.env.PORT ?? "8786";
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/node`;
let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const wallet = nacl.sign.keyPair();
const address = bs58.encode(wallet.publicKey);
const sign = (msg: string) =>
  Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), wallet.secretKey)).toString("base64");

// Enroll → token.
const ench = await (await fetch(`${HTTP}/provider/challenge?for=enroll`)).json();
const enroll = await (await fetch(`${HTTP}/provider/enroll`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pubkey: address, nonce: ench.nonce, signature: sign(ench.message) }),
})).json();
const token = enroll.token;

// Connect a node and keep it open; track close code.
function connectHold(tok: string, nodeId: string) {
  return new Promise<{ registered: boolean; ws: WebSocket; closed: () => number | null }>((resolve) => {
    const ws = new WebSocket(WS);
    let closed: number | null = null;
    ws.on("close", (c) => { closed = c; });
    ws.on("open", () => ws.send(JSON.stringify({ t: "register", token: tok, nodeId, models: ["m"] })));
    ws.on("message", (r) => { if (JSON.parse(r.toString()).t === "registered") resolve({ registered: true, ws, closed: () => closed }); });
    ws.on("error", () => {});
    setTimeout(() => resolve({ registered: false, ws, closed: () => closed }), 2500);
  });
}

const node = await connectHold(token, "rev-1");
check(node.registered, "node connected with its token");

// A different wallet cannot revoke it.
const intruder = nacl.sign.keyPair();
const ich = await (await fetch(`${HTTP}/provider/challenge?for=revoke&node=rev-1`)).json();
const isig = Buffer.from(nacl.sign.detached(new TextEncoder().encode(ich.message), intruder.secretKey)).toString("base64");
const intruderTry = await fetch(`${HTTP}/provider/revoke`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pubkey: bs58.encode(intruder.publicKey), nonce: ich.nonce, nodeId: "rev-1", signature: isig }),
});
check(intruderTry.status === 404, "a different wallet can't revoke your node");

// Owner revokes it.
const rch = await (await fetch(`${HTTP}/provider/challenge?for=revoke&node=rev-1`)).json();
const rev = await fetch(`${HTTP}/provider/revoke`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pubkey: address, nonce: rch.nonce, nodeId: "rev-1", signature: sign(rch.message) }),
});
check(rev.status === 200, "owner revokes the node");
await sleep(400);
check(node.closed() === 4403, "revoked node is disconnected (close 4403)");

// The revoked token can no longer reconnect.
const again = await connectHold(token, "rev-2");
check(!again.registered, "revoked token can't reconnect");
try { again.ws.close(); } catch {}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nrevoke-a-node: all checks passed");
