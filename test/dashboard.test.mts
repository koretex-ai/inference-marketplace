// Dashboard wallet sign-in over HTTP against a running dispatcher (wallet simulated).
import nacl from "tweetnacl";
import bs58 from "bs58";

const PORT = process.env.PORT ?? "8794";
const HTTP = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

// The dashboard page is served.
const page = await fetch(`${HTTP}/dashboard`);
check(page.status === 200 && (await page.text()).includes("Provider dashboard"), "GET /dashboard serves the page");

const wallet = nacl.sign.keyPair();
const address = bs58.encode(wallet.publicKey);

async function statsWith(sign: (msg: string) => string, mutateNonce?: (n: string) => string) {
  const ch = await (await fetch(`${HTTP}/provider/challenge`)).json();
  const nonce = mutateNonce ? mutateNonce(ch.nonce) : ch.nonce;
  const res = await fetch(`${HTTP}/provider/stats`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: address, nonce, signature: sign(ch.message) }),
  });
  return res;
}
const goodSign = (msg: string) =>
  Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), wallet.secretKey)).toString("base64");

// Valid signature → stats for that wallet.
const ok = await statsWith(goodSign);
const okBody = await ok.json();
check(ok.status === 200 && okBody.owner === address, "valid signature returns this wallet's stats");
check(typeof okBody.jobs === "number" && Array.isArray(okBody.recent), "stats have the expected shape");
check(Array.isArray(okBody.liveNodes), "stats include the wallet's live nodes");
check(JSON.stringify(okBody).toLowerCase().indexOf("content") === -1, "stats expose no prompt/response content");

// Wrong signature → 401.
const bad = await statsWith(() => Buffer.from(new Uint8Array(64)).toString("base64"));
check(bad.status === 401, "invalid signature is rejected");

// Replayed/garbage nonce → 401 (single-use challenge).
const replay = await statsWith(goodSign, () => "deadbeef".repeat(4));
check(replay.status === 401, "unknown/expired nonce is rejected");
// (admin endpoint gating is covered in enroll.test.mts)

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ndashboard wallet sign-in: all checks passed");
