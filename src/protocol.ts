// Wire protocol between the dispatcher (control plane, cloud) and node-agents (Macs).
//
// Design notes:
// - Nodes connect OUTBOUND to the dispatcher and hold the socket open. No inbound
//   ports on the node, NAT/firewall friendly. This replaces frp.
// - A request is a "job". The dispatcher forwards the OpenAI request body to a chosen
//   node; the node calls its LOCAL engine (Ollama/MLX) and pipes the raw HTTP response
//   back over the socket. The dispatcher relays those bytes to the customer verbatim.
//   => model-agnostic, streaming or non-streaming, nothing to re-serialize.

export type NodeId = string;
export type JobId = string;

/** What machine a node runs on. Detected at startup; advertised on register. All optional so
 *  older agents (and non-Mac nodes) still register cleanly. No serials/MACs — nothing that
 *  deanonymizes the provider's machine beyond what scheduling/inventory actually needs. */
export interface NodeHardware {
  /** CPU/chip brand, e.g. "Apple M2 Pro". */
  chip?: string;
  /** CPU architecture, e.g. "arm64". */
  arch?: string;
  /** Logical CPU cores. */
  cpuCores?: number;
  /** Total (unified) memory in whole GiB. */
  ramGb?: number;
  /** macOS product version, e.g. "14.5". */
  macosVersion?: string;
  /** Node-agent build, for fleet ops. */
  agentVersion?: string;
}

/** A hardware-attestation assertion a node presents to prove it's a genuine physical device (R3).
 *  On Apple Silicon this carries a DCAppAttest key id + attestation/assertion blob. Optional so
 *  older agents still register; gating on it is controlled by REQUIRE_ATTESTATION on the dispatcher. */
export interface NodeAttestation {
  /** Stable per-device key id from DCAppAttestService.generateKey(). The device identity. */
  keyId: string;
  /** Base64 attestation (first time) or assertion (subsequent) blob produced by App Attest. */
  blob: string;
}

/** Capabilities a node advertises when it registers. */
export interface NodeCapabilities {
  nodeId: NodeId;
  label?: string;
  models: string[];
  /** Provider's asking price, USD per 1M output tokens. Used by the scheduler later. */
  pricePerMTokOut?: number;
  /** Coarse region hint for latency routing, e.g. "us-west". */
  region?: string;
  /** The machine this node runs on (chip, RAM, macOS). */
  hw?: NodeHardware;
  /** Hardware attestation proving a genuine device (R3). Absent on older/non-Apple agents. */
  attestation?: NodeAttestation;
  /** Active inference backend, e.g. "llama.cpp" or "mlx" (Apple Silicon). Reported by the agent so
   *  the dispatcher can (a) group authenticity fingerprints per backend — different backends produce
   *  different greedy output for the same model tag — and (b) track MLX adoption. "unknown" if the
   *  agent can't tell. Absent on older agents. */
  backend?: string;
}

/** Messages a node sends to the dispatcher. */
export type NodeMessage =
  // `token` is a shared secret gating node registration (set NODE_TOKEN on both ends).
  | ({ t: "register"; token?: string } & NodeCapabilities)
  | { t: "heartbeat" }
  // Streaming response framing for a job (transparent proxy of the engine's HTTP response):
  | { t: "head"; jobId: JobId; status: number; contentType: string }
  | { t: "chunk"; jobId: JobId; data: string } // utf8 body bytes
  | { t: "done"; jobId: JobId; usage?: TokenUsage }
  | { t: "error"; jobId: JobId; message: string };

/** Messages the dispatcher sends to a node. */
export type DispatcherMessage =
  | { t: "registered"; ok: true; assignedId: NodeId }
  | { t: "job"; jobId: JobId; body: unknown } // OpenAI chat-completions request body
  | { t: "ping" };

/** Token accounting the node reports back; the basis for billing + provider payout. */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
}

export const WS_NODE_PATH = "/node";
