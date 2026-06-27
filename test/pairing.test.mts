// Drives the full pairing handshake with a simulated Phantom wallet (no browser needed).
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Pairing } from "../src/dispatcher/pairing.ts";
import { InMemoryProviderStore } from "../src/shared/provider-store.ts";

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

// A stable clock for the test (Date.now() is unavailable to keep things deterministic anyway).
let clock = 1_000_000;

const store = new InMemoryProviderStore();
const pairing = new Pairing(store);

// Simulate the provider's wallet (a Solana keypair).
const wallet = nacl.sign.keyPair();
const address = bs58.encode(wallet.publicKey);

// 1. Agent initiates pairing.
const { pairingCode, claimSecret } = pairing.init(clock);
check(pairingCode.startsWith("PAIR-"), "init returns a pairing code");

// Agent polls before the human signs -> still pending.
check(pairing.poll(pairingCode, claimSecret).status === "pending", "poll is pending before wallet signs");

// 2+3. The web page asks for the message, the wallet signs it, the page confirms.
const message = pairing.messageFor(pairingCode)!;
const sigB64 = Buffer.from(
  nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey),
).toString("base64");

// A confirm with a *wrong* signature must be rejected.
const badConfirm = await pairing.confirm(pairingCode, address, Buffer.from(new Uint8Array(64)).toString("base64"));
check(badConfirm.ok === false, "confirm with an invalid signature is rejected");

const confirm = await pairing.confirm(pairingCode, address, sigB64);
check(confirm.ok === true && confirm.address === address, "confirm with a valid signature succeeds");

// 4. Agent polls again -> gets its token, bound to the wallet.
const ready = pairing.poll(pairingCode, claimSecret);
check(ready.status === "ready", "poll returns ready after confirm");
let token = "";
if (ready.status === "ready") {
  token = ready.token;
  check(ready.address === address, "token is bound to the provider's wallet address");
}

// The token resolves back to the wallet, and is single-use to claim.
check((await store.resolveToken(token)) === address, "token resolves to the wallet pubkey");
check(pairing.poll(pairingCode, claimSecret).status === "error", "pairing code is single-use (claimed)");

// A stranger guessing the code but not the claimSecret can't steal the token.
const { pairingCode: code2 } = pairing.init(clock);
const msg2 = pairing.messageFor(code2)!;
const sig2 = Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg2), wallet.secretKey)).toString("base64");
await pairing.confirm(code2, address, sig2);
check(pairing.poll(code2, "wrong-secret").status === "error", "claim requires the correct claimSecret");

// Revocation logs the node out.
await store.revokeToken(token);
check((await store.resolveToken(token)) === null, "revoked token no longer resolves");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\npairing handshake: all checks passed");
