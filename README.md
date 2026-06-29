# Koretex Inference Marketplace

**An OpenRouter-style API backed by a fleet of rented consumer machines — hardware-agnostic: Apple Silicon Macs, NVIDIA GPUs, and more.**

A customer sends a normal OpenAI-compatible request to one endpoint. Behind that endpoint
is not a datacenter — it's a fleet of people's machines (Apple Silicon Macs, NVIDIA GPU rigs,
and even CPU-only boxes) that each self-select which models to run, connect outbound to our
cloud, and get paid per token they serve. We handle routing, metering, auth, and (eventually)
USDC settlement.

**We don't favor any hardware.** A node earns demand purely by being **faster, cheaper, or
better** for a given request — never because of what it is. Apple Silicon and NVIDIA compete
head-to-head through the same scheduler; each simply wins the work it's genuinely best at (see
[§2.5 Better / faster / cheaper](#25-how-routing-works--better--faster--cheaper)).

> Reference deployment: `https://dispatcher.koretex.ai`

---

## 1. What we're building (and what we're not)

| | OpenRouter | Nosana / io.net | **This project** |
|---|---|---|---|
| Owns the supply? | No — aggregates other APIs | Renters run **arbitrary containers** | Providers run **curated models** they pick |
| Customer surface | OpenAI-compatible API | Raw compute / jobs | OpenAI-compatible API |
| Hard problem | Billing/routing | Untrusted-code isolation | **Verifying honest inference** |
| Hardware | n/a | NVIDIA containers; Apple poorly supported | **Hardware-agnostic** — Apple Silicon, NVIDIA, CPU, all served natively |

The key design decision: **providers only expose API access to models they themselves chose
to run — never arbitrary code execution.** That sidesteps the untrusted-container isolation
problem that plagues generic-compute marketplaces, and it's also what lets us be truly
hardware-agnostic: we serve models *natively* through a managed engine (Ollama/llama.cpp/MLX)
rather than in GPU containers, so a Mac's unified-memory GPU and an NVIDIA card are both
first-class — no containerized GPU required on either.

**Positioning:** not "cheaper H100s." We're building **permissionless AI access** from idle
consumer hardware. Different machines are good at different things, and the marketplace routes
each request to whichever node serves it best — high-throughput NVIDIA cards for fast,
latency-sensitive, high-concurrency work; big-memory Apple Silicon for the large models a
24GB card can't hold and latency-tolerant batch jobs. We sell what datacenter GPUs are
*wasteful* at: the long tail of models, low-concurrency big-memory inference, and
privacy/single-tenant workloads — supplied by hardware that's *already idle*.

---

## 2. Architecture at a glance

```
                       ┌──────────────────── CLOUD (Coolify / Hetzner) ────────────────────┐
                       │                                                                    │
  Customer             │   ┌─────────┐    ┌──────────┐    ┌────────────┐   ┌────────────┐   │
 (OpenAI SDK) ─HTTPS──▶│──▶│ Gateway │──▶ │ Metering │──▶ │ Dispatcher │──▶│   Node     │   │
   Bearer key          │   │  /auth  │◀── │ /ledger  │◀── │ /scheduler │   │  registry  │   │
       ▲               │   └─────────┘    └──────────┘    └─────┬──────┘   └────────────┘   │
       │  streamed     │        ▲                               │ enqueue job               │
       │  tokens       │        └───────────────────────────────┼───────────────────────────┘
       └───────────────┼────────────────────────────────────────┤  persistent OUTBOUND WSS
                       │                                         ▼  (heartbeat + pull)
                       │                          ┌──────────────────────────┐
                       │                          │  NODE-AGENT               │  ← no inbound ports
                       │                          │  (Mac · NVIDIA · CPU)     │     hardware-agnostic
                       │                          │  registers models + hw    │
                       │                          │  pulls jobs, streams back │
                       │                          └─────────────┬─────────────┘
                       │                                        │ 127.0.0.1:11435
                       │                          ┌─────────────▼─────────────┐
                       │                          │  Managed engine            │  Ollama / llama.cpp
                       │                          │  (Metal · CUDA · CPU)      │  / MLX — native, no
                       │                          └────────────────────────────┘  GPU container

                       │   ┌─────────────────────────────────────────────────────────────┐ │
                       │   │  SETTLEMENT (pluggable seam) — in-memory now → Postgres →     │ │
                       │   │  Solana/USDC contracts (escrow, accrue, batched payout)       │ │
                       │   └─────────────────────────────────────────────────────────────┘ │
                       └────────────────────────────────────────────────────────────────────┘
```

**The core transport decision:** nodes are consumer machines behind NAT/firewalls, so they
**cannot accept inbound connections.** Instead each node holds a *persistent outbound*
WebSocket to the dispatcher and **pulls** jobs. This is NAT-friendly, needs no per-node public
address, and — unlike a reverse-tunnel (frp) approach — lets the dispatcher make every routing
decision centrally (price, load, latency, reputation). The dispatcher is effectively a
**transparent reverse proxy over that WebSocket**: it relays the engine's raw HTTP response
back to the customer verbatim, so it's model-agnostic and works for streaming and
non-streaming alike.

---

## 2.5 How routing works — better / faster / cheaper

The marketplace is **merit-based and hardware-blind**. The scheduler never asks "is this a
Mac or a GPU?" — it asks "which connected node serves *this* request best, by what *this*
customer is optimizing for?" A node wins demand only by being better, faster, or cheaper for
the job at hand. Three inputs drive it:

1. **Supply describes (and we measure) its real capability.** Each node advertises the models
   it serves plus its hardware — crucially `acceleratorMemGb`, the memory the engine can
   actually use (unified memory on Apple Silicon, **VRAM** on NVIDIA, capped RAM on CPU). That's
   what model-fit gates on, so a node is only offered models it can genuinely hold. Advertised
   specs set *eligibility*; the prober's **measured** throughput/latency sets *ranking* — you
   can't win traffic by lying about your hardware.
2. **Demand declares what it values.** Stays fully OpenAI-compatible: a per-API-key default
   profile (so vanilla OpenAI clients route sensibly with zero changes), optionally overridden
   per request via an `X-Koretex-Optimize: fast | economy | best | balanced` header or a
   `model@profile` suffix — never a breaking change to the request body.
3. **The router scores each eligible node** on throughput, latency (incl. region), and quality
   (reputation/authenticity), weighted by the request's profile, with anti-starvation so new
   nodes still earn probe traffic. *(Per-provider price is platform-set for now, so "cheaper"
   currently varies across models, not across providers serving the same model; the seam is
   built for per-provider pricing later.)*

### Which hardware tends to win what

This split is **emergent, not coded** — it falls out of capability + measurement:

| Hardware | Memory model | Strengths | Naturally wins |
|---|---|---|---|
| **Apple Silicon** (unified memory) | Whole RAM pool is GPU-addressable → can hold **very large models** (70B–235B on 96–512GB Macs) | High capacity, moderate throughput (memory-bandwidth bound), great at low concurrency | Big models a consumer GPU can't fit; latency-tolerant / batch jobs; single-tenant privacy workloads |
| **NVIDIA** (dedicated VRAM) | Capped by **VRAM** (e.g. 24GB on a 4090); spilling to system RAM kills speed | High throughput, strong concurrency/batching | Small–mid models served **fast**; latency-sensitive, interactive, high-QPS traffic |
| **CPU-only** | Fraction of system RAM | Last resort | Little — allowed permissionlessly, but measured throughput steers demand away |

A 4090 wins a 3B chat request on latency; a 128GB Mac Studio wins a 70B request the 4090
literally can't load. Same scheduler, no favoritism — the work flows to genuine fit.

---

## 3. Components

| Component | Where it runs | Responsibility |
|---|---|---|
| **Gateway** | cloud | OpenAI-compatible surface (`/v1/chat/completions`, `/v1/models`); customer API-key auth; streams the response back. |
| **Dispatcher / Scheduler** | cloud | The brain. Matches each request to a connected node by merit — measured throughput, latency/region, and reputation, weighted by what the request optimizes for (better/faster/cheaper). Hardware-blind. Owns the job lifecycle. |
| **Node registry** | cloud | Live index of online nodes, their advertised models, hardware (`acceleratorMemGb`, `gpuKind`), region, and health (heartbeat). |
| **Metering / Ledger** | cloud | Per-job token accounting → debit customer, credit provider. The basis for billing and payouts. |
| **Node-agent** | each provider machine (Mac · NVIDIA · CPU) | Outbound-only. Detects hardware, advertises local models, pulls jobs, calls the local engine, streams tokens back, reports usage. Auto-starts via `launchd` (macOS) / `systemd` (Linux) / a service (Windows). |
| **Engine** | each provider machine | Managed Ollama / llama.cpp / MLX — native acceleration per platform (Metal on Apple Silicon, CUDA on NVIDIA, CPU fallback). Stays bound to `127.0.0.1`; the agent is the only path in. |
| **Settlement** | cloud | Pluggable seam. In-memory counters now; later your own Solana/USDC contracts (Nosana-style escrow + batched payout, **no NOS token**). |

---

## 4. Request lifecycle

1. Customer `POST /v1/chat/completions` with `Authorization: Bearer <customer-key>`.
2. **Gateway** validates the key, parses the body, reads the requested `model`.
3. **Scheduler** picks the best connected node serving that model — by measured throughput,
   latency, and reputation, weighted by what the request optimizes for (header/profile).
4. Dispatcher sends a `job` message down that node's WebSocket and marks it in-flight.
5. **Node-agent** calls its local engine (`127.0.0.1:11435`) and pipes the raw HTTP response
   back over the socket, frame by frame.
6. Dispatcher relays those bytes to the customer's HTTP response (SSE for streaming).
7. On completion the agent reports `usage`; the **ledger** records tokens (credit node /
   debit customer) and the node's in-flight count is decremented.

---

## 5. Security & trust model

- **Customer auth:** Bearer API keys at the gateway (`CUSTOMER_KEYS`).
- **Node auth:** a shared `NODE_TOKEN` gates registration — a rogue machine can't join the
  fleet and siphon traffic.
- **Engine isolation:** the model server never listens on a public interface; only the
  outbound agent can reach it.
- **Transport:** HTTPS/WSS terminated at the cloud proxy (Coolify/Traefik).
- **Honest-inference verification (the real moat, Phase 3):** consumer nodes are untrusted —
  a provider could return a cheaper model or garbage. Planned defenses: canary spot-checks,
  redundant sampling + comparison, model fingerprinting, and reputation with stake-slashing.
- **Availability & DDoS:** the public endpoint carries both customer traffic and the supply
  fleet's connections — see [docs/RESILIENCE.md](docs/RESILIENCE.md) for the layered defense
  (edge absorption, control/data-plane separation, graceful degradation, horizontal scale).

---

## 6. Repository layout

```
src/
  dispatcher/index.ts     Control + data plane: WS node server + OpenAI gateway + scheduler
  node-agent/index.ts     Provider node: outbound WSS client wrapping the local engine
  shared/
    protocol.ts           Wire contract between dispatcher and nodes
    settlement.ts         Pluggable settlement seam (in-memory → Postgres → Solana/USDC)
deploy/
  install-agent.sh        Install the node-agent as a macOS launchd service
  uninstall-agent.sh      Remove it
  deploy-dispatcher.sh    Provision the dispatcher on a bare VPS (systemd) — alternative to Coolify
  dispatcher.service      systemd unit
  dispatcher.env.example  Env template
  COOLIFY.md              Deploy the dispatcher on Coolify (current production path)
test/
  e2e.sh                  Full data path on one machine (customer → dispatcher → agent → engine)
Dockerfile                Dispatcher container image (used by Coolify)
docs/
  ROADMAP.md              Phased plan from MVP to decentralized marketplace
```

---

## 7. Current status

✅ **Phase 1 is live.** Dispatcher deployed on Coolify at `dispatcher.koretex.ai`; one Mac
(M3 Pro) serving `gemma3:12b-it-qat` over WSS under `launchd`. The full path — customer →
HTTPS → dispatcher → WSS → Mac → Ollama → streamed tokens back — works end-to-end, with
API-key auth, node-token registration, and token-metered billing.

See [docs/ROADMAP.md](docs/ROADMAP.md) for what's next (persistence, multi-node scheduling,
verification, settlement).

---

## 8. Quickstart

### Run a provider node (Mac, NVIDIA, or CPU)

The one-command installer detects your hardware (Apple Silicon / NVIDIA / CPU), picks a fitting
model, and registers the node:
```bash
curl -fsSL https://dispatcher.koretex.ai/install | bash
```

Or wire it up manually against a locally-running engine:
```bash
# 1. serve a model locally (native acceleration: Metal on Mac, CUDA on NVIDIA)
ollama serve &                     # or launch Ollama.app
ollama pull gemma3:12b-it-qat

# 2. install deps + register this machine with the dispatcher
cd marketplace && npm install
NODE_TOKEN=<token> DISPATCHER_URL=wss://dispatcher.koretex.ai ./deploy/install-agent.sh
```

### Call the marketplace (as a customer)
```bash
curl -s https://dispatcher.koretex.ai/v1/chat/completions \
  -H "Authorization: Bearer <customer-key>" -H "Content-Type: application/json" \
  -d '{"model":"gemma3:12b-it-qat","messages":[{"role":"user","content":"hi"}]}'
```

### Run the whole thing locally (no cloud)
```bash
cd marketplace && npm install
MODEL=gemma:2b npm run e2e
```

### Deploy the dispatcher
See [deploy/COOLIFY.md](deploy/COOLIFY.md) (production) or `deploy/deploy-dispatcher.sh` (bare VPS).

---

## 9. Tech

TypeScript (Node 22) end-to-end · `ws` for the control plane · native engines on nodes
(Ollama / llama.cpp / MLX, with Metal · CUDA · CPU acceleration per platform) ·
Docker + Coolify for the dispatcher · Solana/USDC for settlement (planned, behind a seam).
Stateless dispatcher today (single replica) — moves to Postgres/Redis in Phase 2.
