// Verifies WS registration auth against a running dispatcher: a node with a valid
// wallet-bound token registers; a node with a bogus token is rejected (4401).
import nacl from "tweetnacl";
import bs58 from "bs58";
import { WebSocket } from "ws";

const PORT = process.env.PORT ?? "8798";
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/node`;

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

// Mint a real wallet-bound token via the pairing flow (simulating Phantom).
const init = await (await fetch(`${HTTP}/provider/pair/init`, { method: "POST" })).json();
const { message } = await (await fetch(`${HTTP}/provider/pair/message?code=${init.pairingCode}`)).json();
const wallet = nacl.sign.keyPair();
const address = bs58.encode(wallet.publicKey);
const signature = Buffer.from(
  nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey),
).toString("base64");
await fetch(`${HTTP}/provider/pair/confirm`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pairingCode: init.pairingCode, pubkey: address, signature }),
});
const { token } = await (await fetch(
  `${HTTP}/provider/pair/poll?code=${init.pairingCode}&secret=${encodeURIComponent(init.claimSecret)}`,
)).json();

function register(tok: string, nodeId: string): Promise<{ ok: boolean; closed?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS);
    let settled = false;
    ws.on("open", () =>
      ws.send(JSON.stringify({ t: "register", token: tok, nodeId, label: "t", models: ["m"] })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "registered") { settled = true; ws.close(); resolve({ ok: true }); }
    });
    ws.on("close", (code) => { if (!settled) resolve({ ok: false, closed: code }); });
    ws.on("error", () => {});
  });
}

check((await register(token, "node-good")).ok === true, "node registers with a valid wallet token");
const bad = await register("nt_bogus_token", "node-bad");
check(bad.ok === false && bad.closed === 4401, "node with an invalid wallet token is rejected (4401)");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nWS token auth: all checks passed");
