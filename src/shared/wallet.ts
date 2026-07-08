// Solana wallet identity helpers (P2). A provider's wallet IS their node identity and
// their USDC payout address. To pair a node, the provider signs an "authorize this node"
// message with their wallet (Phantom's signMessage); the dispatcher verifies the signature
// against the wallet's public key. No transaction, no secret ever leaves the wallet.
//
// A Solana keypair is an ed25519 keypair; the address is the base58 of the 32-byte pubkey.
// Phantom's signMessage produces a 64-byte ed25519 detached signature over the raw message
// bytes — exactly what `nacl.sign.detached.verify` checks here.

import nacl from "tweetnacl";
import bs58 from "bs58";

/** Message a provider signs to revoke (deactivate) one of their nodes. Scoped to the node id. */
export function buildRevokeMessage(nonce: string, nodeId: string): string {
  return [
    "Koretex — revoke (deactivate) a node.",
    `Node: ${nodeId}`,
    `Nonce: ${nonce}`,
    "",
    "This disconnects the node and invalidates its token. No transaction.",
  ].join("\n");
}

/** Message the operator signs to open the admin console (only the ADMIN_WALLET is let in). */
export function buildAdminMessage(nonce: string): string {
  return [
    "Koretex — open the operator admin console.",
    `Nonce: ${nonce}`,
    "",
    "Signing only proves you own this wallet. No transaction.",
  ].join("\n");
}

/** Message a provider signs on the website to enroll a new node under their wallet. */
export function buildEnrollMessage(nonce: string): string {
  return [
    "Koretex — authorize a new provider node under your wallet.",
    `Nonce: ${nonce}`,
    "",
    "This mints an install token for your node. No transaction, no transfer; your secret stays in your wallet.",
  ].join("\n");
}

/** Message a provider signs to view their dashboard (proves wallet ownership; no transaction). */
export function buildDashboardMessage(nonce: string): string {
  return [
    "Koretex — view your provider dashboard.",
    `Nonce: ${nonce}`,
    "",
    "Signing only proves you own this wallet so we can show your earnings. No transaction.",
  ].join("\n");
}

/** Message a customer signs to view / refresh their credit balance (proves wallet ownership). */
export function buildCreditsMessage(nonce: string): string {
  return [
    "Koretex — view and refresh your credit balance.",
    `Nonce: ${nonce}`,
    "",
    "Signing only proves you own this wallet. No transaction, no transfer.",
  ].join("\n");
}

/**
 * The human-readable message a provider signs to link a machine to their wallet.
 * `nodeLabel` (hostname + hardware, self-reported at pair/init) is baked into the signed
 * text so the approver sees WHICH machine they're authorizing — in Phantom, the embedded
 * wallet, or the Seeker app's approval sheet.
 */
export function buildAuthMessage(pairingCode: string, nonce: string, nodeLabel?: string): string {
  return [
    "Koretex — authorize this machine to provide inference under your wallet.",
    ...(nodeLabel ? [`Node: ${nodeLabel}`] : []),
    `Pairing code: ${pairingCode}`,
    `Nonce: ${nonce}`,
    "",
    "This only links the node to your wallet. It does NOT authorize any transaction or transfer.",
  ].join("\n");
}

/**
 * Message signed on a PHONE to open the dashboard on another device (QR sign-in).
 * The code is displayed on both screens so the user can match them.
 */
export function buildQrLoginMessage(loginCode: string, nonce: string): string {
  return [
    "Koretex — sign in to your dashboard on another device.",
    `Login code: ${loginCode}`,
    `Nonce: ${nonce}`,
    "",
    "Signing only proves you own this wallet so the other screen can show your stats. No transaction.",
  ].join("\n");
}

/**
 * Verify a Phantom-style signMessage signature.
 * @param pubkeyBase58   the wallet address (base58), as Phantom returns it
 * @param message        the exact UTF-8 string that was signed
 * @param signatureBase64 the signature bytes, base64 (browser-native `btoa` transport)
 */
export function verifyWalletSignature(
  pubkeyBase58: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const pub = bs58.decode(pubkeyBase58);
    const sig = new Uint8Array(Buffer.from(signatureBase64, "base64"));
    const msg = new TextEncoder().encode(message);
    if (pub.length !== 32 || sig.length !== 64) return false;
    return nacl.sign.detached.verify(msg, sig, pub);
  } catch {
    return false;
  }
}

/** Basic shape check for a Solana address (32 bytes, valid base58). Cheap pre-filter. */
export function isValidSolanaAddress(pubkeyBase58: string): boolean {
  try {
    return bs58.decode(pubkeyBase58).length === 32;
  } catch {
    return false;
  }
}
