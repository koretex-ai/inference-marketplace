// Settlement seam. Phase 1 records usage to an in-memory ledger only.
// Later: implement SolanaUsdcSettlement against your own on-chain contracts
// (Nosana-equivalent functionality: escrow, accrue, batched payout — no NOS token).
// The data path NEVER calls on-chain directly; it only appends ledger entries.

import type { JobId, NodeId, TokenUsage } from "../vendor/koretex-node/src/protocol.js";

export interface LedgerEntry {
  jobId: JobId;
  customerKey: string;
  nodeId: NodeId;
  /** Provider wallet (Solana address) that gets paid for this job. The node's identity. */
  owner: string;
  usage: TokenUsage;
  /** Set by the caller (Node runtime) — kept out of the pure logic for testability. */
  at: number;
}

export interface Summary {
  jobs: number;
  byNode: Record<NodeId, number>;
  byCustomer: Record<string, number>;
  /** Tokens credited per provider wallet — the basis for USDC payouts (M4). */
  byOwner: Record<string, number>;
}

/** One provider's earnings, for their dashboard. Metadata ONLY — never prompt/response content. */
export interface ProviderStats {
  owner: string;
  jobs: number;
  completionTokens: number;
  byModel: { model: string; jobs: number; completionTokens: number }[];
  /** Most recent jobs this provider served. No customer identity, no payload — just what + when. */
  recent: { at: number; model: string | null; completionTokens: number }[];
}

/** A raw ledger row for the admin view. */
export interface LedgerRow {
  jobId: string;
  at: number;
  owner: string | null;
  model: string | null;
  completionTokens: number;
  customerKey: string;
  nodeId: string;
}

export interface SettlementProvider {
  /** Optional one-time setup (e.g. create tables). Awaited at dispatcher startup. */
  init?(): Promise<void>;
  /** Called once per completed job. Must be cheap + non-blocking on the hot path. */
  record(entry: LedgerEntry): void;
  /** Debit a customer's prepaid balance / credit a provider. Off-chain for now. */
  summary(): Promise<Summary>;
  /** One provider's stats for their wallet-gated dashboard (metadata only). */
  providerStats(owner: string): Promise<ProviderStats>;
  /** Most recent raw rows for the admin view. */
  recent(limit: number): Promise<LedgerRow[]>;
  /** Network-wide demand per model since `sinceMs` (jobs + completion tokens). Powers the Demand
   *  tab and demand-driven pricing — unlike providerStats, this spans the WHOLE fleet. */
  demandByModel(sinceMs: number): Promise<ModelDemand[]>;
}

/** Network-wide demand for one model over a time window. */
export interface ModelDemand {
  model: string;
  jobs: number;
  completionTokens: number;
}

/** Phase 1: in-memory, double-entry-ish counters. Swap for Postgres, then Solana. */
export class InMemorySettlement implements SettlementProvider {
  private entries: LedgerEntry[] = [];

  record(entry: LedgerEntry): void {
    this.entries.push(entry);
  }

  async summary(): Promise<Summary> {
    const byNode: Record<NodeId, number> = {};
    const byCustomer: Record<string, number> = {};
    const byOwner: Record<string, number> = {};
    for (const e of this.entries) {
      const ct = e.usage.completionTokens ?? 0;
      byNode[e.nodeId] = (byNode[e.nodeId] ?? 0) + ct;
      byCustomer[e.customerKey] = (byCustomer[e.customerKey] ?? 0) + ct;
      if (e.owner) byOwner[e.owner] = (byOwner[e.owner] ?? 0) + ct;
    }
    return { jobs: this.entries.length, byNode, byCustomer, byOwner };
  }

  async providerStats(owner: string): Promise<ProviderStats> {
    const mine = this.entries.filter((e) => e.owner === owner);
    const byModel = new Map<string, { model: string; jobs: number; completionTokens: number }>();
    let completionTokens = 0;
    for (const e of mine) {
      const ct = e.usage.completionTokens ?? 0;
      completionTokens += ct;
      const model = e.usage.model ?? "unknown";
      const m = byModel.get(model) ?? { model, jobs: 0, completionTokens: 0 };
      m.jobs++;
      m.completionTokens += ct;
      byModel.set(model, m);
    }
    const recent = mine
      .slice(-50)
      .reverse()
      .map((e) => ({ at: e.at, model: e.usage.model ?? null, completionTokens: e.usage.completionTokens ?? 0 }));
    return { owner, jobs: mine.length, completionTokens, byModel: [...byModel.values()], recent };
  }

  async recent(limit: number): Promise<LedgerRow[]> {
    return this.entries
      .slice(-limit)
      .reverse()
      .map((e) => ({
        jobId: e.jobId,
        at: e.at,
        owner: e.owner ?? null,
        model: e.usage.model ?? null,
        completionTokens: e.usage.completionTokens ?? 0,
        customerKey: e.customerKey,
        nodeId: e.nodeId,
      }));
  }

  async demandByModel(sinceMs: number): Promise<ModelDemand[]> {
    const byModel = new Map<string, ModelDemand>();
    for (const e of this.entries) {
      if (e.at < sinceMs) continue;
      const model = (e.usage.model ?? "unknown").toLowerCase();
      const m = byModel.get(model) ?? { model, jobs: 0, completionTokens: 0 };
      m.jobs++;
      m.completionTokens += e.usage.completionTokens ?? 0;
      byModel.set(model, m);
    }
    return [...byModel.values()].sort((a, b) => b.completionTokens - a.completionTokens);
  }
}
