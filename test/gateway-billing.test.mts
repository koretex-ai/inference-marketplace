// Metered gateway over HTTP against a running dispatcher (wallet simulated). Checks identity
// resolution + the credit gate: wallet-bound keys are metered (402 with no balance), unknown keys
// are rejected, and legacy static keys stay unmetered. Run after starting a dispatcher on $PORT.
import nacl from "tweetnacl";
import bs58 from "bs58";

const PORT = process.env.PORT ?? "8795";
const HTTP = `http://127.0.0.1:${PORT}`;
const LEGACY_KEY = process.env.CUSTOMER_KEY ?? "sk-cust-demo";

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

const wallet = nacl.sign.keyPair();
const address = bs58.encode(wallet.publicKey);
const sign = (msg: string) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), wallet.secretKey)).toString("base64");

async function signedCredits() {
  const ch = await (await fetch(`${HTTP}/provider/challenge?for=credits`)).json();
  check(ch.message.includes("credit balance"), "credits challenge uses the credits message");
  return { nonce: ch.nonce, signature: sign(ch.message) };
}

// Mint a wallet-bound API key.
const mint = await (await fetch(`${HTTP}/customer/key`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pubkey: address, ...(await signedCredits()) }),
})).json();
check(typeof mint.key === "string" && mint.key.startsWith("sk-cust-"), "mints a wallet-bound customer key");

// It shows up (masked) in the wallet's balance view, and starts at 0 credits.
const bal = await (await fetch(`${HTTP}/credits/balance`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pubkey: address, ...(await signedCredits()) }),
})).json();
check(bal.balance === 0, "new wallet has 0 credits");
check(Array.isArray(bal.keys) && bal.keys.length === 1 && bal.keys[0].masked.includes("…"), "balance lists the wallet's key, masked");
check(JSON.stringify(bal.keys).indexOf(mint.key) === -1, "the full key is never returned again");

const chat = (key: string) => fetch(`${HTTP}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: "gemma:2b", messages: [{ role: "user", content: "hi" }] }),
});

// Metered key with no balance → 402 Payment Required.
const broke = await chat(mint.key);
check(broke.status === 402, "metered key with no credits is rejected with 402");

// Unknown key → 401.
check((await chat("sk-bogus-nope")).status === 401, "unknown key is rejected with 401");

// Legacy static key → unmetered: passes auth, fails only because no node is connected (503).
check((await chat(LEGACY_KEY)).status === 503, "legacy static key is unmetered (503 no-node, not 401/402)");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nmetered gateway (identity + credit gate): all checks passed");
