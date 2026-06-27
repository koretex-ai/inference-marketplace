// Node-agent: runs on each provider Mac. Outbound-only — no inbound ports, no frp.
//   1. Dials the dispatcher over WS and registers its local models.
//   2. Pulls jobs, calls the LOCAL engine (Ollama/MLX, OpenAI-compatible), and pipes
//      the raw HTTP response back over the socket.
// The engine stays bound to 127.0.0.1; the only way traffic reaches it is this agent.

import { execFileSync } from "node:child_process";
import os from "node:os";
import { WebSocket } from "ws";
import {
  WS_NODE_PATH,
  type DispatcherMessage,
  type NodeHardware,
  type NodeMessage,
} from "../protocol.js";
import { loadIdentity, saveIdentity } from "./identity.js";

const AGENT_VERSION = "0.1.0";

const DISPATCHER_URL = process.env.DISPATCHER_URL ?? "ws://127.0.0.1:8787";
const ENGINE_URL = process.env.ENGINE_URL ?? "http://127.0.0.1:11434"; // Ollama default
const NODE_ID = resolveNodeId();
const PRICE = process.env.PRICE_PER_MTOK ? Number(process.env.PRICE_PER_MTOK) : 0.5;
const REGION = process.env.REGION ?? "local";
// Active inference backend, reported on register. The installer sets KORETEX_BACKEND to what it
// configured ("llama.cpp" for managed Ollama today; "mlx" once MLX is enabled). We can't reliably
// detect MLX-vs-llama.cpp from the OpenAI API (Ollama falls back silently), so we trust the
// installer's value and default to "unknown" for hand-rolled setups.
const BACKEND = process.env.KORETEX_BACKEND ?? "unknown";
// Auth precedence: a wallet-paired token (from `npm run pair`) wins; else a legacy/explicit
// NODE_TOKEN; else empty (open mode — local dev / e2e against an open dispatcher).
const identity = loadIdentity();
const NODE_TOKEN = identity?.token ?? process.env.NODE_TOKEN ?? "";

const send = (ws: WebSocket, msg: NodeMessage) => ws.send(JSON.stringify(msg));

/** Run a command, return trimmed stdout, or undefined on any failure. */
function probe(cmd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", timeout: 3000 }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** This Mac's stable node id — ONE identity per physical machine, for the life of the machine.
 *  Precedence: explicit NODE_ID env → previously-pinned id → derived from the hardware UUID. The
 *  hardware UUID (IOPlatformUUID) is fixed per machine, so restarts, reinstalls, and hostname
 *  changes all resolve to the same id. (The old `mac-<hostname>-<randomUUID>` minted a brand-new
 *  id on every launch, so a single Mac spawned a fresh ghost node each restart.) The friendly
 *  hostname still travels separately as `label` for display. */
function resolveNodeId(): string {
  if (process.env.NODE_ID) return process.env.NODE_ID;
  const id = loadIdentity();
  if (id?.nodeId) return id.nodeId;
  const ioreg = probe("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  const hwUuid = ioreg?.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/)?.[1];
  // Non-Mac / probe failure: fall back to the hostname — still deterministic, no random suffix.
  const stable = hwUuid ? `mac-${hwUuid.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}` : `mac-${os.hostname()}`;
  if (id) saveIdentity({ ...id, nodeId: stable }); // pin it so it can never drift on a later boot
  return stable;
}

/** Detect this machine's hardware once, at startup. Best-effort: every field is optional and
 *  falls back to Node's `os` when a `sysctl`/`sw_vers` probe isn't available (e.g. non-Mac).
 *  Absolute paths on purpose — the installed launchd service runs with a PATH that omits
 *  /usr/sbin (where sysctl lives), so a bare "sysctl" would silently ENOENT. */
function collectHardware(): NodeHardware {
  const ramGb = Math.round(os.totalmem() / 1024 ** 3) || undefined;
  return {
    // sysctl gives the marketing name ("Apple M2 Pro"); os.cpus() is the fallback.
    chip: probe("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]) ?? os.cpus()?.[0]?.model,
    arch: os.arch(),
    cpuCores: os.cpus()?.length || undefined,
    ramGb,
    macosVersion: probe("/usr/bin/sw_vers", ["-productVersion"]),
    agentVersion: AGENT_VERSION,
  };
}

async function listModels(): Promise<string[]> {
  try {
    const r = await fetch(`${ENGINE_URL}/v1/models`);
    const j: any = await r.json();
    return (j?.data ?? []).map((m: any) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

async function runJob(ws: WebSocket, jobId: string, body: any) {
  try {
    // Token counts are the billing basis. OpenAI-compatible engines only emit a usage
    // block on streamed responses if asked, so force it on. (No effect on non-stream.)
    if (body?.stream) body.stream_options = { ...body.stream_options, include_usage: true };

    const upstream = await fetch(`${ENGINE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    send(ws, {
      t: "head",
      jobId,
      status: upstream.status,
      contentType: upstream.headers.get("content-type") ?? "application/json",
    });

    if (!upstream.body) {
      send(ws, { t: "done", jobId });
      return;
    }

    // Stream the engine's response straight through, capturing usage as it flies by.
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let usageModel = body?.model as string | undefined;
    let completionTokens: number | undefined;
    let promptTokens: number | undefined;
    let tail = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      send(ws, { t: "chunk", jobId, data: text });

      // Best-effort usage scrape (Ollama emits a usage block at the end of the stream,
      // or a full body for non-stream requests).
      tail = (tail + text).slice(-4000);
      const u = tail.match(/"completion_tokens"\s*:\s*(\d+)/);
      const p = tail.match(/"prompt_tokens"\s*:\s*(\d+)/);
      if (u) completionTokens = Number(u[1]);
      if (p) promptTokens = Number(p[1]);
    }

    send(ws, {
      t: "done",
      jobId,
      usage: { completionTokens, promptTokens, model: usageModel },
    });
    console.log(`[job] ${jobId} done (completion_tokens=${completionTokens ?? "?"})`);
  } catch (e: any) {
    send(ws, { t: "error", jobId, message: String(e?.message ?? e) });
    console.log(`[job] ${jobId} error: ${e?.message ?? e}`);
  }
}

function connect() {
  const wsUrl = DISPATCHER_URL.replace(/\/$/, "") + WS_NODE_PATH;
  const ws = new WebSocket(wsUrl);
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  ws.on("open", async () => {
    const models = await listModels();
    const hw = collectHardware();
    send(ws, {
      t: "register",
      token: NODE_TOKEN,
      nodeId: NODE_ID,
      label: os.hostname(),
      models,
      pricePerMTokOut: PRICE,
      region: REGION,
      hw,
      backend: BACKEND,
    });
    console.log(
      `connected to ${wsUrl} as ${NODE_ID}` +
        (identity ? ` (wallet ${identity.address})` : "") +
        `; hw=[${hw.chip ?? "?"}, ${hw.ramGb ?? "?"}GB, macOS ${hw.macosVersion ?? "?"}]` +
        `; models=[${models.join(", ")}]`,
    );
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) send(ws, { t: "heartbeat" });
    }, 10_000);
  });

  ws.on("message", (raw) => {
    let msg: DispatcherMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === "job") runJob(ws, msg.jobId, msg.body);
  });

  const reconnect = (code?: number) => {
    if (heartbeat) clearInterval(heartbeat);
    // 4401/4403 = the dispatcher refused our token (revoked, or wiped by a server-side reset).
    // Reconnecting won't help until the wallet is re-linked, so say so loudly instead of looping
    // silently — the node keeps retrying in case it was transient, but the operator sees why.
    if (code === 4401 || code === 4403) {
      console.log(
        "✗ this node's wallet link is no longer valid (token revoked or reset on the server).\n" +
          "  Re-link it by re-running the install command from your dashboard's “Run a node” tab.\n" +
          "  Retrying in 30s in case this was temporary…",
      );
      setTimeout(connect, 30_000);
      return;
    }
    console.log("disconnected; reconnecting in 3s…");
    setTimeout(connect, 3000);
  };
  ws.on("close", (code) => reconnect(code));
  ws.on("error", (e) => console.log(`ws error: ${(e as Error).message}`));
}

/** Start serving: dial the dispatcher and hold the connection open. Called by the CLI. */
export function startAgent() {
  connect();
}
