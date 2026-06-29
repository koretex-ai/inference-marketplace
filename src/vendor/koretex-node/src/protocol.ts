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
 *  deanonymizes the provider's machine beyond what scheduling/inventory actually needs.
 *
 *  Hardware-agnostic by design: a node may be an Apple Silicon Mac (unified memory), an NVIDIA
 *  box (dedicated VRAM), or CPU-only. The fields below describe ALL of them; the one the
 *  scheduler gates model-fit on is `acceleratorMemGb` (NOT `ramGb` — system RAM only equals GPU
 *  memory on Apple Silicon; on an NVIDIA card the real ceiling is VRAM). */
export interface NodeHardware {
  /** CPU/chip brand, e.g. "Apple M2 Pro" or "AMD Ryzen 9 7950X". */
  chip?: string;
  /** CPU architecture, e.g. "arm64" or "x64". */
  arch?: string;
  /** OS family: "macos" | "linux" | "windows". */
  os?: "macos" | "linux" | "windows" | string;
  /** Logical CPU cores. */
  cpuCores?: number;
  /** Total system memory in whole GiB. On Apple Silicon this is also the GPU's (unified) memory. */
  ramGb?: number;
  /** Accelerator family the inference engine runs on:
   *   - "apple"  — Apple Silicon GPU, addresses (most of) unified memory
   *   - "nvidia" — discrete GPU, bounded by dedicated VRAM
   *   - "cpu"    — no GPU offload; allowed but slow, the router measures it and routes demand away
   *  Absent on older agents. Drives cross-platform model-fit and display. */
  gpuKind?: "apple" | "nvidia" | "cpu" | string;
  /** Human accelerator name, e.g. "Apple M2 Pro" or "NVIDIA GeForce RTX 4090". */
  gpuName?: string;
  /** Dedicated video memory in whole GiB (NVIDIA, summed across cards). Undefined on Apple Silicon
   *  (memory is unified) and CPU-only nodes. */
  vramGb?: number;
  /** Memory actually usable by the inference engine, in whole GiB — THE number model-fit gates on.
   *  Apple Silicon: (most of) unified memory · NVIDIA: total VRAM · CPU-only: a fraction of system
   *  RAM. The cross-platform replacement for the old "gate on ramGb" (which only held when system
   *  RAM == GPU memory, i.e. on a Mac). */
  acceleratorMemGb?: number;
  /** macOS product version, e.g. "14.5". Mac only. */
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
