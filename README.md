# Mac Inference Marketplace

**An OpenRouter-style API backed by a fleet of rented consumer machines — Apple Silicon Macs first-class.**

A customer sends a normal OpenAI-compatible request to one endpoint. Behind that endpoint
is not a datacenter — it's a fleet of people's Macs (and, later, other GPUs) that each
self-select which models to run, connect outbound to our cloud, and get paid per token they
serve. We handle routing, metering, auth, and (eventually) USDC settlement.

> Reference deployment: `https://dispatcher.koretex.ai`

---

## 1. What we're building (and what we're not)

| | OpenRouter | Nosana / io.net | **This project** |
|---|---|---|---|
| Owns the supply? | No — aggregates other APIs | Renters run **arbitrary containers** | Providers run **curated models** they pick |
| Customer surface | OpenAI-compatible API | Raw compute / jobs | OpenAI-compatible API |
| Hard problem | Billing/routing | Untrusted-code isolation | **Verifying honest inference** |
| Apple Silicon | n/a | Poorly supported (no GPU containers) | **First-class** (served natively via Ollama/MLX) |

The key design decision: **providers only expose API access to models they themselves chose
to run — never arbitrary code execution.** That sidesteps the untrusted-container isolation
problem that plagues generic-compute marketplaces, and it's also what makes Macs viable (you
can't containerize the GPU on a Mac, so you must serve models natively).

**Positioning:** not "cheaper H100s." We sell what datacenter GPUs are *wasteful* at —
big-memory models at low concurrency, the long tail of small/fine-tuned models,
latency-tolerant batch/embeddings, and privacy/single-tenant workloads — supplied by Macs
that are *already idle*.

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
                       │                          │  NODE-AGENT (a Mac)       │  ← no inbound ports
                       │                          │  registers models + price │
                       │                          │  pulls jobs, streams back │
                       │                          └─────────────┬─────────────┘
                       │                                        │ 127.0.0.1:11434
                       │                                 ┌──────▼──────┐
                       │                                 │ Ollama / MLX │  Gemma QAT, etc.
                       │                                 └─────────────┘
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

## 3. Components

| Component | Where it runs | Responsibility |
|---|---|---|
| **Gateway** | cloud | OpenAI-compatible surface (`/v1/chat/completions`, `/v1/models`); customer API-key auth; streams the response back. |
| **Dispatcher / Scheduler** | cloud | The brain. Matches each request to a connected node (Phase 1: least-inflight; later: price/latency/region/reputation). Owns the job lifecycle. |
| **Node registry** | cloud | Live index of online nodes, their advertised models, price, region, and health (heartbeat). |
| **Metering / Ledger** | cloud | Per-job token accounting → debit customer, credit provider. The basis for billing and payouts. |
| **Node-agent** | each Mac | Outbound-only. Advertises local models, pulls jobs, calls the local engine, streams tokens back, reports usage. Runs under `launchd` (auto-start, auto-respawn). |
| **Engine** | each Mac | Ollama (default, native Metal) or MLX. Stays bound to `127.0.0.1`; the agent is the only path in. |
| **Settlement** | cloud | Pluggable seam. In-memory counters now; later your own Solana/USDC contracts (Nosana-style escrow + batched payout, **no NOS token**). |

---

## 4. Request lifecycle

1. Customer `POST /v1/chat/completions` with `Authorization: Bearer <customer-key>`.
2. **Gateway** validates the key, parses the body, reads the requested `model`.
3. **Scheduler** picks a connected node advertising that model.
4. Dispatcher sends a `job` message down that node's WebSocket and marks it in-flight.
5. **Node-agent** calls its local engine (`127.0.0.1:11434`) and pipes the raw HTTP response
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

### Run a provider node (on a Mac)
```bash
# 1. serve a model locally
ollama serve &                     # or launch Ollama.app
ollama pull gemma3:12b-it-qat

# 2. install deps + register this Mac with the dispatcher
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

TypeScript (Node 22) end-to-end · `ws` for the control plane · Ollama/MLX engines on nodes ·
Docker + Coolify for the dispatcher · Solana/USDC for settlement (planned, behind a seam).
Stateless dispatcher today (single replica) — moves to Postgres/Redis in Phase 2.
