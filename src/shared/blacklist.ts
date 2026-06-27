// Blacklist (R3). A wallet caught serving fake models / repeatedly failing challenges is banned:
// rejected at registration and hidden from the leaderboard + routing. Paired with `penalty` events
// (which erode score continuously), this is the hard stop for proven-bad actors — the no-staking
// equivalent of slashing. Because device identity is attestation-bound (R3), a ban actually costs
// the operator that machine's standing rather than being a free reset.
//
// In-memory for now (a restart clears it); the seam matches the other stores so a Postgres-backed
// version drops in later when bans must survive redeploys.

export interface BlacklistEntry {
  owner: string;
  reason: string;
  at: number;
}

export interface BlacklistStore {
  init?(): Promise<void>;
  has(owner: string): boolean;
  add(owner: string, reason: string, at: number): void;
  remove(owner: string): void;
  list(): BlacklistEntry[];
}

export class InMemoryBlacklist implements BlacklistStore {
  private banned = new Map<string, BlacklistEntry>();

  has(owner: string): boolean {
    return this.banned.has(owner);
  }
  add(owner: string, reason: string, at: number): void {
    if (!this.banned.has(owner)) this.banned.set(owner, { owner, reason, at });
  }
  remove(owner: string): void {
    this.banned.delete(owner);
  }
  list(): BlacklistEntry[] {
    return [...this.banned.values()].sort((a, b) => b.at - a.at);
  }
}
