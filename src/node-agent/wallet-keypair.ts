// Self-custody wallet for HEADLESS enrollment (e.g. the Hermes provider skill, or any unattended
// install). The interactive `pair` flow keeps the wallet secret in Phantom and never touches the
// Mac; this flow is the opposite trade-off: we GENERATE a Solana (ed25519) keypair locally and
// keep the secret on disk, so the machine can enroll + mint a customer key with NO human in the
// loop. The dispatcher can't tell the difference — it only ever verifies an ed25519 signature over
// its challenge message (see shared/wallet.ts: verifyWalletSignature), exactly what we produce here.
//
// Zero new dependencies: Node's built-in `crypto` does ed25519 keygen + detached signing. The
// secret is stored as a PKCS8 PEM (the robust, no-guesswork way to round-trip a KeyObject); the
// only thing we add is base58 (Solana addresses are base58 of the 32-byte public key), a dozen
// lines below. The PEM lives in ~/.koretex/wallet.json (0600) — treat it like any wallet key:
// whoever holds it controls the credits this machine earns.

import { createPublicKey, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".koretex");
export const WALLET_PATH = path.join(DIR, "wallet.json");

// On-disk form: the PKCS8 PEM is the full private key; the cached base58 address is for display.
interface StoredWallet {
  /** PKCS8 PEM of the ed25519 private key. */
  pem: string;
  /** base58 Solana address (the 32-byte public key). */
  address: string;
}

const BS58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58-encode raw bytes (Bitcoin/Solana alphabet). */
function base58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte === 0) out += "1";
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) out += BS58_ALPHABET[digits[i]];
  return out;
}

/** The base58 Solana address for a private key (raw public key via JWK `x`, base64url). */
function addressOf(priv: KeyObject): string {
  const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x: string };
  return base58(new Uint8Array(Buffer.from(jwk.x, "base64url")));
}

export interface LocalWallet {
  /** base58 Solana address — this is the `pubkey` the dispatcher attributes earnings + spend to. */
  address: string;
  /** Sign a UTF-8 message, returning a base64 ed25519 signature (what the dispatcher verifies). */
  signMessage(message: string): string;
}

function open(priv: KeyObject, address: string): LocalWallet {
  return {
    address,
    // ed25519 is "pure" — pass null as the digest algorithm; output is the 64-byte detached sig.
    signMessage: (message: string) => sign(null, Buffer.from(message, "utf8"), priv).toString("base64"),
  };
}

/** Load the machine's self-custody wallet, creating + persisting one on first use. Idempotent. */
export function loadOrCreateWallet(): LocalWallet {
  const existing = loadWallet();
  if (existing) return existing;
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const address = addressOf(privateKey);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(WALLET_PATH, JSON.stringify({ pem, address } satisfies StoredWallet, null, 2), { mode: 0o600 });
  return open(privateKey, address);
}

/** Load an existing wallet, or null if this machine has never created one. */
export function loadWallet(): LocalWallet | null {
  try {
    const w = JSON.parse(readFileSync(WALLET_PATH, "utf8")) as StoredWallet;
    if (!w?.pem || !w?.address) return null;
    return open(createPrivateKey(w.pem), w.address);
  } catch {
    return null;
  }
}
