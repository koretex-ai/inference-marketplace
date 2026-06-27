// Admin console wallet-gating: only the ADMIN_WALLET may read network data.
// The dispatcher must be started with ADMIN_WALLET = the address of the fixed seed below.
import nacl from "tweetnacl";
import bs58 from "bs58";

const PORT = process.env.PORT ?? "8792";
const HTTP = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

// The operator wallet the dispatcher was configured with (deterministic seed).
const admin = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const adminAddr = bs58.encode(admin.publicKey);

async function fetchData(signer: nacl.SignKeyPair, asAddress: string) {
  const ch = await (await fetch(`${HTTP}/provider/challenge?for=admin`)).json();
  const sig = Buffer.from(
    nacl.sign.detached(new TextEncoder().encode(ch.message), signer.secretKey),
  ).toString("base64");
  return fetch(`${HTTP}/admin/data`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: asAddress, nonce: ch.nonce, signature: sig }),
  });
}

// Page is public HTML.
check((await fetch(`${HTTP}/admin`)).status === 200, "GET /admin serves the console page");

// Operator wallet → data.
const ok = await fetchData(admin, adminAddr);
const body = await ok.json();
check(ok.status === 200 && body.summary && Array.isArray(body.recent), "operator wallet gets network data");

// A different wallet, validly signing its OWN message → 403 (not the operator).
const intruder = nacl.sign.keyPair();
const denied = await fetchData(intruder, bs58.encode(intruder.publicKey));
check(denied.status === 403, "a non-operator wallet is rejected (403)");

// Claiming to be the admin but signing with the intruder's key → signature fails (401).
const spoof = await fetchData(intruder, adminAddr);
check(spoof.status === 401, "spoofing the operator address without its key fails (401)");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nadmin wallet-gating: all checks passed");
