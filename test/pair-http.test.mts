// End-to-end pairing over real HTTP against a running dispatcher. Simulates the wallet
// (the one thing a browser+Phantom would do) with a tweetnacl keypair; exercises every
// dispatcher endpoint the connect page uses.
import nacl from "tweetnacl";
import bs58 from "bs58";

const BASE = process.env.BASE ?? "http://127.0.0.1:8797";
let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

// 1. Agent starts a pairing.
const init = await (await fetch(`${BASE}/provider/pair/init`, { method: "POST" })).json();
check(typeof init.pairingCode === "string" && init.pairingCode.startsWith("PAIR-"), "init returns a pairing code");
check(init.connectUrl.includes(`/connect?code=${init.pairingCode}`), "init returns a same-origin connect URL");

// 2. The connect page is served on the dispatcher domain.
const page = await fetch(`${BASE}/connect?code=${init.pairingCode}`);
const html = await page.text();
check(page.status === 200 && html.includes("Link this Mac to your wallet"), "GET /connect serves the page");

// 3. The page fetches the message to sign.
const { message } = await (await fetch(`${BASE}/provider/pair/message?code=${init.pairingCode}`)).json();
check(message.includes(init.pairingCode), "message to sign includes the pairing code");

// 4. The wallet signs it (this is the Phantom step, simulated).
const wallet = nacl.sign.keyPair();
const address = bs58.encode(wallet.publicKey);
const signature = Buffer.from(
  nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey),
).toString("base64");

// 5. The page confirms; dispatcher verifies + mints the token.
const confirm = await (await fetch(`${BASE}/provider/pair/confirm`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pairingCode: init.pairingCode, pubkey: address, signature }),
})).json();
check(confirm.ok === true && confirm.address === address, "confirm verifies the signature and links the wallet");

// 6. The agent polls and collects its token.
const poll = await (await fetch(`${BASE}/provider/pair/poll?code=${init.pairingCode}&secret=${encodeURIComponent(init.claimSecret)}`)).json();
check(poll.status === "ready" && typeof poll.token === "string" && poll.token.startsWith("nt_"), "agent polls and receives its node token");
check(poll.address === address, "token is bound to the wallet address");

// 7. A tampered signature is rejected end-to-end.
const init2 = await (await fetch(`${BASE}/provider/pair/init`, { method: "POST" })).json();
const { message: m2 } = await (await fetch(`${BASE}/provider/pair/message?code=${init2.pairingCode}`)).json();
const badSig = Buffer.from(new Uint8Array(64)).toString("base64");
const badConfirm = await fetch(`${BASE}/provider/pair/confirm`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pairingCode: init2.pairingCode, pubkey: address, signature: badSig }),
});
check(badConfirm.status === 400, "an invalid signature is rejected over HTTP");
void m2;

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\npairing over HTTP: all checks passed");
