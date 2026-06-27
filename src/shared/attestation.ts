// Hardware attestation seam (R3). The no-staking sybil tax leans on this: bind each node identity
// to ONE genuine physical device so an attacker can't cheaply mint a fleet of fake identities to
// farm points. On Apple Silicon that means DCAppAttest — the Secure Enclave signs an assertion
// the dispatcher can verify against Apple's App Attest roots.
//
// This file is the SEAM, not the full crypto. `OpenAttestation` (dev/current network) accepts
// everything so the live fleet keeps working; `AppleAppAttestVerifier` is the production stub with
// the real steps documented. Which one is used + whether attestation is REQUIRED is wired in the
// dispatcher (REQUIRE_ATTESTATION). Verification returns a stable device key on success — that key,
// not the self-declared nodeId, is the thing the network should treat as the unique device.

import type { NodeAttestation } from "../vendor/koretex-node/src/protocol.js";

export interface AttestationInput {
  nodeId: string;
  owner: string;
  attestation?: NodeAttestation;
}

export interface AttestationVerifier {
  /** Verify the attestation proves a genuine device. Returns a stable device key id, or null if
   *  it can't be verified (which, under REQUIRE_ATTESTATION, blocks registration). */
  verify(input: AttestationInput): Promise<string | null>;
}

/** Dev / transitional: accept everything. Uses the supplied keyId (or nodeId) as the device key so
 *  the rest of the pipeline behaves identically to the attested path. NOT a security boundary. */
export class OpenAttestation implements AttestationVerifier {
  async verify({ nodeId, attestation }: AttestationInput): Promise<string | null> {
    return attestation?.keyId ?? nodeId;
  }
}

/**
 * Production Apple App Attest verifier — STUB. Fails closed until the agent ships the Swift side.
 *
 * Real implementation (R3 follow-up):
 *   1. Agent: DCAppAttestService.generateKey() once, store keyId; on register, attestKey(keyId,
 *      clientDataHash=hash(dispatcher nonce)) for the first attestation, then generateAssertion()
 *      for subsequent reconnects. Ship { keyId, blob } as NodeAttestation.
 *   2. Dispatcher (here): on first attestation, parse the CBOR attestation object, validate the
 *      x5c certificate chain up to Apple's App Attest Root CA, check the nonce matches the
 *      challenge we issued, verify the app id (RP ID hash) and that the key is bound to keyId, then
 *      persist the credential public key. On later assertions, verify the signature with that
 *      stored public key and check the monotonic counter to stop replay.
 *   3. Return keyId as the device identity; persist it so one device = one identity across reconnects.
 */
export class AppleAppAttestVerifier implements AttestationVerifier {
  async verify(_input: AttestationInput): Promise<string | null> {
    // TODO(R3): implement the App Attest certificate-chain + assertion verification above.
    return null; // fail closed — under REQUIRE_ATTESTATION this blocks until real verification ships
  }
}

/** Select a verifier from config. `apple` is the (stub) production path; anything else is dev-open. */
export function makeAttestationVerifier(mode: string | undefined): AttestationVerifier {
  return mode === "apple" ? new AppleAppAttestVerifier() : new OpenAttestation();
}
