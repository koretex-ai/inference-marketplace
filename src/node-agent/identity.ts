// Where a paired node keeps its wallet-bound token. Written once by `npm run pair`,
// read on every agent start. The token (not the wallet secret — there is none here) is
// what the node presents to register; revoking it server-side logs this node out.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".koretex");
export const IDENTITY_PATH = path.join(DIR, "node.json");

export interface NodeIdentity {
  /** Opaque node token (`nt_…`) bound to the provider's wallet. */
  token: string;
  /** The provider's Solana wallet address (for display; earnings + payouts go here). */
  address: string;
  /** Stable per-machine node id, pinned on first run so a node keeps ONE identity across restarts,
   *  reinstalls, and hostname changes (no random suffix → no duplicate ghost nodes). */
  nodeId?: string;
}

export function loadIdentity(): NodeIdentity | null {
  try {
    const id = JSON.parse(readFileSync(IDENTITY_PATH, "utf8"));
    return typeof id?.token === "string" ? id : null;
  } catch {
    return null;
  }
}

export function saveIdentity(id: NodeIdentity): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(IDENTITY_PATH, JSON.stringify(id, null, 2), { mode: 0o600 });
}
