// Synthetic challenge prober (R1) — the keystone of the points system.
//
// Periodically the dispatcher sends a node a job that is byte-for-byte indistinguishable from a
// real customer request (same WS `job` frame, normal-looking prompt). The node can't tell probe
// from paying traffic, so its only winning move is to serve everyone well. One probe measures, in
// a single shot, all three reward dimensions:
//   - reachability + correctness  -> `ok`            (the availability gate)
//   - throughput                  -> `tokensPerSec`  (measured hardware capability — unfakeable)
//   - model authenticity          -> `modelVerified` (quorum fingerprint: is it the claimed model?)
// Each probe appends one immutable `challenge` event to the points log. Nothing self-reported is
// trusted. Prompts use temperature 0 + a fixed seed so the greedy output is a stable fingerprint.

import { newEvent, type PointsStore } from "../shared/points.js";
import { FingerprintRegistry } from "../shared/fingerprint.js";
import type { InternalJobResult } from "./index.js";

/** Deterministic, open-ended prompts. Open-ended (not "what's 2+2") so different models/quants
 *  diverge — that divergence is what makes the output a usable fingerprint. */
export const CHALLENGE_PROMPTS: { id: string; text: string }[] = [
  { id: "lighthouse-v1", text: "In exactly two sentences and no preamble, continue: In the year 2140, the last lighthouse keeper switched off the lamp and" },
  { id: "primes-v1", text: "Output only a comma-separated list of the first six prime numbers above 100. No words." },
  { id: "haiku-v1", text: "Write a single haiku about a copper kettle. Output only the haiku." },
];

/** A node the prober can challenge. `run` is a closure bound to that node's socket (provided by the
 *  dispatcher) so the prober needs no knowledge of the WS/job machinery. */
export interface ProbeTarget {
  nodeId: string;
  owner: string;
  models: string[];
  /** Active inference backend ("llama.cpp"/"mlx"/…) — scopes authenticity fingerprints per backend. */
  backend: string;
  run: (body: unknown, timeoutMs?: number) => Promise<InternalJobResult>;
}

export interface ProbeOutcome {
  target: ProbeTarget;
  model: string;
  promptId: string;
  result: InternalJobResult;
  modelVerified?: boolean;
}

export interface ProberOptions {
  intervalMs?: number; // how often a tick fires
  perTick?: number; // how many nodes to probe per tick
  timeoutMs?: number; // per-probe deadline
  maxTokens?: number; // generation cap (keep probes cheap)
  seed?: number;
}

export interface ProberDeps {
  listTargets: () => ProbeTarget[];
  points: PointsStore;
  fingerprints: FingerprintRegistry;
  now: () => number;
  /** Optional hook fired after each probe (R3 uses it for penalties/blacklist escalation). */
  onOutcome?: (o: ProbeOutcome) => void;
}

export class Prober {
  private timer?: NodeJS.Timeout;
  private cursor = 0; // round-robins which nodes get probed across ticks
  private tickCount = 0;
  private readonly opts: Required<ProberOptions>;

  constructor(private deps: ProberDeps, opts: ProberOptions = {}) {
    this.opts = {
      intervalMs: opts.intervalMs ?? 60_000,
      perTick: opts.perTick ?? 3,
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxTokens: opts.maxTokens ?? 64,
      seed: opts.seed ?? 7,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => console.error("[prober] tick:", e?.message ?? e)), this.opts.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    console.log(`[prober] started — every ${this.opts.intervalMs}ms, ${this.opts.perTick} node(s)/tick`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One round: probe up to `perTick` nodes, round-robined so every node is covered over time. All
   * nodes in a tick get the SAME prompt so they are cross-checked against each other for that
   * prompt — that overlap is what lets the quorum fingerprint form (and catches a faker). Keep
   * perTick ≥ 2 so at least two nodes are compared per prompt per tick.
   */
  async tick(): Promise<ProbeOutcome[]> {
    const targets = this.deps.listTargets();
    if (targets.length === 0) return [];
    const prompt = CHALLENGE_PROMPTS[this.tickCount++ % CHALLENGE_PROMPTS.length];
    const out: ProbeOutcome[] = [];
    const n = Math.min(this.opts.perTick, targets.length);
    for (let i = 0; i < n; i++) {
      const t = targets[this.cursor % targets.length];
      this.cursor++;
      out.push(await this.probe(t, prompt));
    }
    return out;
  }

  /** Challenge one node on one of its models with a given prompt and record the `challenge` event. */
  async probe(target: ProbeTarget, prompt = CHALLENGE_PROMPTS[0]): Promise<ProbeOutcome> {
    const model = target.models[Math.abs(this.cursor) % Math.max(1, target.models.length)] ?? "";
    const body = {
      model,
      messages: [{ role: "user", content: prompt.text }],
      temperature: 0,
      max_tokens: this.opts.maxTokens,
      // Stream the probe: tokens arrive incrementally so the dispatcher can measure REAL generation
      // throughput (firstByte→done) instead of seeing the whole reply land at once — a non-streaming
      // reply made genMs ≈ 0 and tokens/sec explode to absurd values (e.g. 24000). Greedy (temp 0 +
      // fixed seed) keeps the concatenated output a stable fingerprint, same as before.
      stream: true,
      seed: this.opts.seed,
    };

    const result = await target.run(body, this.opts.timeoutMs);
    const at = this.deps.now();

    let modelVerified: boolean | undefined;
    if (result.ok) {
      const text = extractText(result.body);
      if (text) modelVerified = this.deps.fingerprints.observe(model, prompt.id, text, target.backend).verified;
    }

    this.deps.points.record(
      newEvent({
        nodeId: target.nodeId,
        owner: target.owner,
        kind: "challenge",
        at,
        ok: result.ok,
        synthetic: true,
        model,
        modelVerified,
        latencyMs: result.latencyMs,
        tokensPerSec: result.tokensPerSec,
        detail: { promptId: prompt.id, backend: target.backend, firstByteMs: result.firstByteMs, status: result.status, error: result.error },
      }),
    );

    const outcome: ProbeOutcome = { target, model, promptId: prompt.id, result, modelVerified };
    this.deps.onOutcome?.(outcome);
    return outcome;
  }
}

/** Pull the assistant text out of an OpenAI chat-completion response body. Handles BOTH a streamed
 *  SSE body (concatenate the `delta.content` tokens across `data:` lines) and a single non-streaming
 *  JSON object, so probes can stream (for throughput timing) without breaking the fingerprint. */
export function extractText(body: string): string {
  if (body.includes("data:")) {
    let text = "";
    for (const line of body.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const d = JSON.parse(payload)?.choices?.[0]?.delta;
        if (d?.content) text += d.content;
      } catch { /* skip keepalive / malformed lines */ }
    }
    if (text) return text;
  }
  try {
    const j = JSON.parse(body);
    const c = j?.choices?.[0];
    return String(c?.message?.content ?? c?.text ?? "");
  } catch {
    return "";
  }
}
