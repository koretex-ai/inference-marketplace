// Proves our server-side verification matches what a Solana wallet (Phantom) produces.
// Phantom's signMessage = ed25519 detached signature over the raw UTF-8 message bytes,
// which is exactly what we simulate here with tweetnacl.
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildAuthMessage, verifyWalletSignature, isValidSolanaAddress } from "../src/shared/wallet.ts";

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

// Simulate a provider's wallet.
const wallet = nacl.sign.keyPair();
const address = bs58.encode(wallet.publicKey);
const message = buildAuthMessage("PAIR-7F3K", "nonce-abc123");

// Sign exactly like Phantom: detached signature over the UTF-8 bytes, transported as base64.
const sigBytes = nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey);
const signatureB64 = Buffer.from(sigBytes).toString("base64");

check(isValidSolanaAddress(address), "wallet address is a valid Solana address");
check(verifyWalletSignature(address, message, signatureB64) === true, "valid signature verifies");
check(verifyWalletSignature(address, message + " tampered", signatureB64) === false, "tampered message is rejected");

const attacker = bs58.encode(nacl.sign.keyPair().publicKey);
check(verifyWalletSignature(attacker, message, signatureB64) === false, "signature does not verify for a different wallet");
check(verifyWalletSignature(address, message, "garbage!!") === false, "malformed signature is rejected, not thrown");
check(isValidSolanaAddress("not-a-real-address") === false, "junk address rejected");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nwallet signature verification: all checks passed");
