# Roadmap

From a working data path to a fully functional, paid, decentralized marketplace. Each
milestone is shippable and de-risks the next. Phases 0–1 are done; M1–M7 are what remain.

---

## Done

### Phase 0 — Inference quality ✅
- Ollama + `gemma3:12b-it-qat` (int4 QAT) serving natively on Apple Silicon.

### Phase 1 — Working marketplace data path ✅
One customer, one node, real transport + metering — live at `dispatcher.koretex.ai`.
- [x] Pull-based dispatcher (WS) + OpenAI gateway on Coolify.
- [x] Outbound-only node-agent wrapping Ollama, under `launchd`.
- [x] Customer API-key auth + `NODE_TOKEN` registration auth.
- [x] Token-metered in-memory ledger (`/admin/ledger`) + e2e test.

---

## Near-term to-do (actionable backlog)

Concrete next tasks pulled out of the milestones below — small, high-value, and mostly
independent. Roughly priority-ordered. Check off as we go.

**Resilience quick wins** (cheap, do before scaling — see [RESILIENCE.md](RESILIENCE.md)):
- [ ] Put **Cloudflare** in front of `koretex.ai` and **lock the Hetzner firewall to Cloudflare IP ranges** (hide origin, absorb volumetric DDoS). *(M6, highest leverage)*
- [ ] Move the node WSS control plane to its own hostname (`nodes.koretex.ai`), separate from the customer API. *(M6 — plane separation)*
- [ ] Add **exponential backoff + jitter** to the node-agent reconnect loop (currently fixed 3s → reconnection-storm risk). *(M6 — ~10-line fix)*
- [ ] Add per-API-key **rate + concurrency limits** at the gateway. *(M6 / M3)*

**Foundation** (unblocks money + scale):
- [x] **Postgres-backed ledger** — `PostgresSettlement` behind the existing seam; durable across redeploys, selected by `DATABASE_URL`. *(M1, ledger half)*
- [ ] Stand up **Redis**; move the **node registry** out of dispatcher memory (rebuilds on reconnect today, but blocks >1 replica). *(M1, registry half)*
- [ ] Add richer **node telemetry** (in-flight, tokens/sec, model-warm, free RAM) and a weighted scheduler that prefers idle, model-warm nodes. *(M2)*
- [ ] Mid-request **failover** to another node on disconnect; bounded queue when all busy. *(M2)*

**Multi-tenant + money (start of the paid loop):**
- [ ] Customer accounts + self-serve API keys + quotas. *(M3)*
- [ ] Per-node provider enrollment to replace the single shared `NODE_TOKEN`. *(M3 / P2)*
- [ ] Price book + per-request cost calculation wired into the ledger. *(M3 → M4)*

**Points & reputation (reward uptime/hardware/model quality — see the R-track below):**
- [x] **Event log + scoring foundation** — append-only `node_events` + versioned pure scorer + `/leaderboard` and `/points/stats`; job completions feed it. *(R0)*
- [x] **Synthetic challenge prober** — internal-job runner + prober inject jobs indistinguishable from real ones; record reachability + throughput + quorum model-authenticity. *(R1)*
- [x] **Shadow leaderboard + provider points UI + reputation routing** — public `/leaderboard` page, dashboard points view, reputation-weighted `pickNode`. *(R2)*
- [x] **Anti-sybil hardening** — attestation seam + `REQUIRE_ATTESTATION` gate, per-operator diminishing returns, penalty events + auto-blacklist + admin endpoint. *(R3)*
- [ ] **Real Apple App Attest verification** — implement the cert-chain/assertion crypto behind the R3 stub (needs the agent's DCAppAttest Swift side). *(R3 follow-up)*

**Provider onboarding (frictionless 3rd-party supply — see the P-track below):**
- [x] **Hardware preflight check** — `deploy/preflight.sh`: no-install, read-only check of chip/RAM/disk/macOS that prints yes/no + the recommended model tier. *(P0)*
- [x] **One-line installer** — `curl -fsSL https://dispatcher.koretex.ai/install | bash`: preflight → Ollama + model → self-contained agent bundle (no repo clone, no npm) → wallet pairing → launchd. Served same-origin off the dispatcher. *(P1)*
- [ ] **Provider lifecycle CLI** — `status / pause / resume / stop` with graceful drain. *(P3)*

---

## Remaining milestones

Ordered roughly by dependency. Critical path is **M1 → M3 → M4** (durable state → accounts →
money); **M2** runs alongside M1; **M5–M7** harden and grow what works.

### M1 — Durable foundation
*Today a redeploy wipes all state; nothing real can sit on memory.*
- Postgres: ✅ ledger (done); still to come — accounts, nodes, models, API keys, payouts.
- Redis: live node presence, in-flight counts, job queue, rate-limit counters.
- Move the registry + ledger out of dispatcher memory. *(ledger done; registry pending)*
- **Definition of done:** the dispatcher restarts with zero data loss. *(ledger: proven — a row survived a fresh process against the live DB.)*

### M2 — Smart load balancing → route to idle nodes
*Scheduler is "least in-flight" today; real routing needs richer signals.*
- Node telemetry: in-flight, queue depth, tokens/sec, **model-warm-in-RAM**, free memory, latency.
- Weighted scheduler: prefer idle + model-already-loaded + region + acceptable price.
- Queue + backpressure when all capable nodes are busy (bounded, not infinite).
- Mid-request failover/retry to another node on disconnect.
- Health gating: auto-drop slow/flaky nodes.
- **Definition of done:** a request provably lands on an idle, model-warm node; all-busy yields a bounded queue, not a crash; a node dying mid-stream retries elsewhere.

### M3 — Accounts, keys & metering (multi-tenant)
- Customers: self-serve signup, API-key management, quotas, rate limits.
- Providers: per-node identity/enrollment (replace the single shared `NODE_TOKEN`), declare models + price.
- Metering: per-request cost from a price book, durable usage records.
- **Definition of done:** a new customer self-serves a rate-limited API key; a new provider node enrolls with its own credentials.

### M4 — Payments & USDC settlement (the money loop)
**Design (simplified, locked):** a **credits** model. Customers buy credits with USDC (money-in);
providers earn credits; both tracked in the DB. USDC only ever flows **in**, to one **admin fee
wallet**. The hard money-out half (batched on-chain payouts, escrow contracts) is deferred to an
**"encash credits"** feature later — until then float stays fully backed in the fee wallet.

- [x] **Credit purchases (money-in), Design 1 — done.** Customer sends USDC to the fee wallet
  (`9wPKJm8r…`); the dispatcher **verifies the transfer on-chain** via Helius RPC (the tx signature,
  not the browser, is the proof) and credits the wallet. **Idempotent on the tx signature** — a
  deposit is credited at most once. **User-triggered Refresh** re-scans the fee wallet's recent
  deposits and credits anything the fast path missed (heals a lost write from a network blip).
  Peg: `CREDITS_PER_USDC` (default 100 → 1 credit = $0.01). Files: `shared/credits.ts` (+ `-postgres`),
  `shared/solana.ts` (verifier + pure balance-delta parser), `dispatcher/credits.html` (buy page),
  routes `/credits`, `/credits/config|verify|refresh|balance`, `/solana/rpc` (key-hiding proxy).
  RPC URL (carries the Helius key) lives in `deploy/.secrets.env`, never in code.
- [x] **Pricing engine — done.** Per-model price book (`deploy/prices.json`, credits per 1M tokens,
  default fallback) → integer credit cost per job (`shared/pricing.ts`). Inference is billed **1:1**
  (caller debited == supplier credited; no platform fee — margin lives in the buy/encash spread).
  Peg raised to **10000 credits/USDC** (1 credit = $0.0001) so per-token costs are whole credits.
- [x] **Debit credits for inference spend — done.** Customers get **wallet-bound API keys**
  (`shared/customer-store.ts`, mint on `/credits` → `/customer/key`); the gateway resolves key →
  wallet, **enforces balance at admission (402 if empty)**, and on completion applies a **double-entry
  charge** (debit caller, credit supplier, atomic + idempotent on jobId) via `credit_movements`.
  Balance = purchases + earnings − spend. Legacy static `CUSTOMER_KEYS` stay unmetered (e2e/demo).
- [ ] **Encash credits (money-out)** — provider/customer redeems credits → batched USDC payout.
  This is where escrow/idempotent-payout/reconciliation/regulatory weight return (see M4.5 below).
- **Definition of done (full):** a customer funds USDC, spends it on calls, and a provider receives a
  batched USDC payout fully reconciled against the ledger. *(Money-in slice: done.)*

### M5 — Trust & verification (the moat — hardest)
*Consumer nodes are untrusted; a provider could return a cheaper model or garbage.*
- Canary/spot-check prompts, model fingerprinting, redundant sampling + comparison.
- Reputation scoring; stake + slashing — feeding back into scheduling (M2) and payouts (M4).
- **Definition of done:** a node returning wrong/garbage output is detected and deranked/slashed automatically.
- **The mechanism for all of this is the points & reputation R-track below** (R0–R4): the synthetic
  challenge prober *is* the spot-check, the event log *is* the evidence trail, and the reputation
  score feeds scheduling + payouts. **R-track = the build-out of M5.** *(Decision: no staking for
  the growth phase — the no-staking sybil tax is hardware attestation + a node-age trust ramp; see R3.)*

### M6 — Reliability, security & ops
- **Availability & DDoS resilience — see [RESILIENCE.md](RESILIENCE.md).** (Edge absorption, control/data-plane separation, horizontal scale of the stateful WS dispatcher, graceful degradation.)
- Observability (metrics/logs/traces/alerts); status page.
- Abuse + content moderation, rate protection, audit logs.
- Node-agent auto-update + remote model management.
- **Definition of done:** loss of any single dispatcher instance — or a volumetric attack — does not take the marketplace down.

### M7 — Product & go-to-market
- Model catalog + pricing page + playground.
- Customer and provider dashboards; docs; onboarding flows. **Provider side = the P0–P5 track above.**
- Recruit 5–10 trusted Mac owners + first paying customers.
- **Definition of done:** a provider and a customer can each self-onboard through a dashboard without manual help.

### M8 — Multi-modality (beyond text chat)
*Text/chat first — build all the surrounding functionality on it — then generalize. The
transport (outbound WS, pull-based jobs, byte-streaming), identity, and ledger are already
modality-agnostic; only the customer route, the agent's forward path, and metering are chat-specific.*
- **Generalize the job**: carry a `kind`/endpoint (chat / embeddings / image); nodes advertise
  **capabilities per kind**; the agent forwards to the right local engine/endpoint; metering is unit-aware.
- **Embeddings** *(small — same Ollama engine)*: add `/v1/embeddings` route + agent forward;
  bill on input tokens.
- **Image generation** *(larger)*: different engine (Stable Diffusion / ComfyUI / MLX, not Ollama);
  capability advertising + routing; **per-image billing** (not tokens); larger binary payloads.
- Catalog already carries `type` (text/vision/code today) to grow into this.
- **Definition of done:** a provider can serve an embeddings or image model through the same
  onboarding + identity + ledger, and a customer can call it.

---

## Provider onboarding track (P0–P5) — frictionless 3rd-party supply

Goal: a **non-technical Mac owner** can check eligibility, install in **one command**, start/stop
whenever they want, and see their **earnings + jobs done — metadata only, never the payload.**
This is a UX track that cross-cuts the milestones: **P2 = the provider half of M3**, real money
in the earnings view needs **M4**, and the web dashboard lands with **M7**. Until M4, "earnings"
are ledger credits, not USDC.

**Privacy invariant (applies across P4/P5):** the marketplace stores + exposes only *metadata*
(job id, model, token counts, timestamps, earnings) — never prompt/response content.
*Honest caveat:* this holds for **our** surfaces; the provider's own Mac inherently processes
the plaintext to run inference, so a malicious provider could sniff their own process. Closing
that is the **M5** trust problem (confidential inference) — out of scope here; don't over-promise.

### P0 — Eligibility & preflight ✅ *(done — `deploy/preflight.sh`)*
- [x] **Minimum spec** defined: Apple Silicon, macOS 13+, 16 GB sweet spot, disk = model size + 10 GB headroom.
- [x] **Model→RAM table**: <16GB → 3B (limited demand) · 16–36GB → gemma3:12b-it-qat (network primary) · 48–64GB → 32B · 96GB+ → 70B.
- [x] No-install, read-only check of chip / total+free RAM / free disk / macOS / Ollama, prints a clear verdict + recommended model. Pure bash + macOS built-ins (curl-pipeable); color auto-disables when piped.
- **Definition of done:** ✅ a stranger runs one command and learns yes/no + which model to serve. *(Verified on an M3 Pro / 18 GB; tier + no-tty output tested.)*

### P1 — One-command, noob-friendly install ✅ *(built; live-test pending)*
- [x] **Agent bundled to one file** (`npm run bundle` → `dist/koretex-agent.cjs`, esbuild, ~141KB)
  so providers don't clone the repo or run `npm install`. Caveat: still needs a **Node runtime** —
  the installer detects/installs it (via Homebrew). A zero-dependency **notarized binary** removes
  even that; deferred to P5.
- [x] **Installer** `curl -fsSL https://dispatcher.koretex.ai/install | bash` (`deploy/install.sh`):
  preflight → Node → Ollama + model → download agent bundle → **wallet pairing (P2)** → launchd.
- [x] **Served same-origin off the dispatcher** — `/install`, `/preflight`, `/agent.js` (bundle built
  in the Docker image). No new hosting/infra; matches the `/connect` approach.
- [x] **Website-first funnel** — `/provider` landing (and site front door `/`): connect Phantom →
  get a personalized one-liner with the node token baked in (`KORETEX_TOKEN=…`), so the install
  runs with no second signing step. The discovery path that turns a visitor into a node.
- [x] **Hardware-aware model picker** — curated catalog (`deploy/models.json`) served at
  `/models/catalog`; preflight lists the models this Mac can run, and the installer filters by
  actual RAM + free disk and lets the provider **choose** which to serve (or `KORETEX_MODEL=…`).
  Eligibility + model choice happen on-device (a browser can't read the hardware).
- [x] **Managed inference engine** — installer downloads a **pinned, checksum-verified Ollama**
  into `~/.koretex/engine` and runs it as its own launchd service (port 11435); the agent points
  at it. A provider's own Ollama (broken / missing / wrong version) can't break them. Surfaced by
  a real provider whose stock Ollama 0.30.10 returned empty completions; a clean managed copy of
  the same version works. *(Still needs Node for the agent — the standalone binary that drops
  even that is the P5 item below.)*
- **Definition of done:** from a clean Mac, one pasted command → node online and serving, no dev
  tools. *(Components verified: preflight, bundle-as-agent, pairing, serving. Remaining: deploy +
  one full run on a real Mac. Ollama/Node auto-install is best-effort via Homebrew in v1.)*

### P2 — Provider identity = Solana wallet *(= M3 provider half; prerequisite for P4 + M4)*
Approach (decided): **"connect your wallet once."** The provider signs a one-time *authorize this
node* message in Phantom; the dispatcher verifies it and mints a **revocable node token** bound to
the wallet. The node presents that token on every reconnect — the wallet's secret never touches the
Mac. The wallet is both the identity and the USDC payout address. (A node-generated bootstrap wallet
was considered and rejected in favour of using the provider's real wallet from day one.)
- [x] **Signature verification core** (`shared/wallet.ts`) — verifies Phantom `signMessage`
  signatures; tested against a simulated wallet (valid / tampered / wrong-wallet / garbage).
- [x] **Token store** (`shared/provider-store.ts`) — mint/resolve/revoke wallet-bound node tokens
  (in-memory now; Postgres-backed next, same seam as settlement).
- [x] **Pairing handshake** (`dispatcher/pairing.ts`) — init → confirm → poll, with single-use
  codes + a `claimSecret` so only the originating agent can collect the token. Fully tested.
- [x] **HTTP endpoints + `/connect` web page** — Phantom connect UI + init/message/confirm/poll routes, served same-origin on the dispatcher (no subdomain/CORS). Tested end-to-end over HTTP with a simulated wallet.
- [x] **WS token auth** — `nt_…` token → wallet resolution on register (legacy `NODE_TOKEN` + open
  mode kept as fallbacks); ledger now attributes earnings to the wallet (`byOwner`). Tested.
- [x] **Agent pairing flow** — `npm run pair` prints/opens the connect link, polls, stores the
  wallet token in `~/.koretex/node.json`; `npm run agent` then registers under that wallet.
- [x] **Postgres-backed token store** — `provider-store-postgres.ts`, selected by `DATABASE_URL`.
  Verified live: deploy healthcheck only passes after `providerStore.init()` migrates the DB.
- **Definition of done:** ✅✅ **Verified in production** on `dispatcher.koretex.ai`: a provider
  connects their Phantom wallet once (real wallet `3ARuBgtp…`), the node gets a revocable
  Postgres-backed token, registers under that wallet (`nodes: 1`), and earnings attribute to it.

### P3 — Lifecycle control: see / start / stop / revoke *(in progress)*
- [x] **See what you're serving** — the dashboard's "Your nodes (live)" shows the wallet's
  connected nodes (models, in-flight) from the registry, alongside historical earnings.
- [x] **Easy local control** — the installer drops a `koretex` command on the Mac:
  `status / stop / start` (pause + resume serving via launchd, no hand-editing).
- [x] **Revoke a node** — a "Revoke" button on each live node in the dashboard; the owner signs,
  the node's token is invalidated and it's disconnected (close 4403) and can't reconnect. Tested
  incl. non-owner rejection. *(Note: targets currently-connected nodes; offline-token cleanup later.)*
- [ ] **Graceful drain** — stop accepting new jobs, finish in-flight, then disconnect (vs. abrupt
  stop). `pickNode` skip + a node "draining" state. *(remaining refinement)*
- [ ] Reconnect **backoff + jitter** (shared with the resilience quick wins).
- **Definition of done:** a provider can see their nodes, pause/resume serving in one command, and
  revoke a node remotely — without dropping work or hand-editing launchd.

### P4 — Provider dashboard: earnings + jobs, zero payload ✅ *(built; live-test pending)*
- [x] **Wallet-gated `/dashboard`** — provider connects Phantom, signs a single-use nonce
  (`/provider/challenge` → `/provider/stats`), sees jobs served, tokens earned, est. value,
  per-model breakdown, and recent jobs — scoped to their wallet.
- [x] **Privacy invariant enforced + tested** — stats are metadata only (what/when/tokens); no
  prompt/response content, no customer identity in the provider view. Tests assert a wallet can't
  see another's data and no payload field is ever returned.
- [x] **Admin `/admin/ledger/recent`** — raw recent rows; `/admin/*` gated by `ADMIN_TOKEN` when set.
- **Definition of done:** a provider sees their earnings + job history; no path exposes any customer
  payload. *(Verified via unit + HTTP tests with a simulated wallet; live wallet test after deploy.)*

### P5 — Truly noob-friendly polish *(last — biggest lift)*
- Plain-language docs + troubleshooting; a clear **"online / earning" status indicator**.
- **Zero-dependency standalone binary** (removes the Node runtime requirement from P1): compile
  with `bun build --compile` / Node SEA, then **sign + notarize** (Apple Developer ID + hardened
  runtime → `notarytool submit` → `stapler staple`, ideally wrapped in a signed `.pkg`/`.dmg`,
  automated in CI). Notarization is required — unsigned, Gatekeeper blocks it.
- Optional **native menu-bar app** (the real non-technical endpoint: start/stop, live earnings,
  model picker; signed + notarized).
- Agent **auto-update**.
- **Definition of done:** a non-developer onboards and operates entirely through a GUI.

**Ordering:** P0 + P1 are independent — do them first for the biggest UX win. P2 rides M3 and
unblocks P4 + M4 payouts. P3 is small and parallelizable. P4 needs P2. P5 is the final polish.

---

## Points & reputation track (R0–R5) — reward uptime, hardware & model quality

Goal: reward providers for **keeping nodes up, running the best hardware, and hosting the best
models** — and make that reward **un-farmable**. This track is the build-out of **M5**: the same
score that ranks a node also gates job-routing (M2) and, eventually, payouts (M4).

**Framing (decided):** publicly this is a **growth leaderboard** — ranks, tiers, badges, streaks.
It is **not** marketed as a payout and **must not** promise conversion. Underneath, the event log is
built as if real value will settle on it, because a **retroactive token airdrop is an undisclosed,
deferred option** computed from the same log with a *final* formula. Keep all public copy to
ranks/utility, never "1 point = $X".

**Core design (from the design discussion):**
- A points system is an **oracle problem** — you reward *claims* about off-chain state, so every
  measurable is an attack surface. Reward **verified work under unpredictable challenge**, gated by
  **reliable availability**. Never reward self-reported specs or bare heartbeats (free to fake).
- **Scoring shape (provisional, versioned — see `shared/points.ts`):**
  `points = uptimeFactor × (hardwareCapability + modelValue) × trustRamp − penalties`
  — uptime gates *multiplicatively* (offline beast GPU ≈ worthless); hardware = **measured**
  throughput (sqrt-curved, not spec sheet); modelValue = realized **demand** × diversity, **gated by
  authenticity**; trustRamp = the **no-staking sybil tax** (new identities earn at a floor, ramp with age).
- **No staking** (decided): the sybil tax is **Secure-Enclave hardware attestation** (one real Mac =
  one identity) + the **age trust-ramp** + **points-slashing/blacklist**, not capital at risk.
- **Central oracle + synthetic challenges** (decided): the dispatcher probes nodes and injects jobs
  indistinguishable from real ones. That one mechanism covers uptime, hardware, *and* model
  authenticity. Decentralized peer verification is R5.

### R0 — Event log + scoring foundation ✅ *(built this pass)*
- [x] **Append-only event log** (`shared/points.ts` + `-postgres.ts`, `node_events` table, selected
  by `DATABASE_URL` like settlement). Immutable rows carrying **raw measurements** (job served,
  challenge result, uptime sample, benchmark, penalty) — never derived points — so the formula can be
  re-run/retuned over all history (R4) and an airdrop computed + defended from it.
- [x] **Pure, versioned scorer** (`scoreNode`, `FORMULA_VERSION`) with a transparent per-term
  breakdown (uptime / hardware / model / trust) so any rank is explainable + auditable.
- [x] **Two-table read model** — raw `node_events` audit log (prunable on a TTL) + an incrementally
  maintained `node_summary` that all reads hit, so read cost scales with nodes, not history. See
  [POINTS-ARCHITECTURE.md](POINTS-ARCHITECTURE.md).
- [x] **Wired into the hot path** — every completed real job appends a `job` (demand) event alongside
  the ledger write, fire-and-forget + idempotent, attributed to the provider wallet.
- [x] **Read endpoints** — public `GET /leaderboard` (shadow ranks, per wallet, `?epoch=`/`?limit=`)
  and wallet-gated `POST /points/stats` (one wallet's points + per-node breakdown, metadata only).
- **Definition of done:** ✅ identical raw volume from a new/cheating wallet vs an established honest
  one scores ~388× lower in the smoke test — volume alone earns almost nothing. *(Next: R1 lights up
  the uptime/hardware/authenticity terms that are neutral until a prober feeds them.)*

### R1 — Synthetic challenge prober (the keystone) ✅ *(built)*
- [x] **Internal-job runner** (`runInternalJob`) — the dispatcher originates jobs that are byte-for-
  byte identical to customer traffic (refactored `PendingJob` to buffer instead of streaming to HTTP).
- [x] **Prober** (`dispatcher/prober.ts`) periodically challenges nodes (temp-0, fixed seed, one
  prompt per tick so nodes cross-check) → one `challenge` event measuring **reachability** (`ok`),
  **throughput** (`tokensPerSec` → hardwareCapability), and **authenticity** (`modelVerified`).
- [x] **Quorum fingerprinting** (`shared/fingerprint.ts`) — once N independent nodes agree on the
  greedy output for (model, prompt), that's canonical; a disagreeing node is flagged. Cold start =
  unknown (innocent until probed). Catches "claims 70B, serves 7B-quant".
- **Definition of done:** ✅ smoke test — a faker is flagged on every probe and its `modelValue`
  collapses ~14× vs an honest node with **identical real demand**. *(Sealed benchmark + standalone
  uptime sampling between jobs remain as refinements.)*

### R2 — Shadow leaderboard + provider-facing UI ✅ *(built)*
- [x] **Public `/leaderboard` page** (`leaderboard.html`) — ranks, medals, tier badges, growth
  framing, no payout language; JSON at `/leaderboard/data`. Verified rendering in-browser.
- [x] **Provider dashboard points view** — points card + per-node breakdown (uptime / hardware /
  model value / trust ramp / points), folded into the already-signed `/provider/stats` (no extra sig).
- [x] **Reputation-weighted routing** — `pickNode` uses a refreshed per-node score cache:
  `weight = (reputation + base) / (inflight + 1)`, with a base so idle newcomers still get traffic.
- **Definition of done:** ✅ providers see their rank + why, ranked nodes get routing preference.
  Runs in **shadow mode** (no payout) so a week of data can expose farming vectors before R4 binds.

### R3 — Anti-sybil hardening (no-staking defenses) ✅ *(built; attestation crypto stubbed)*
- [x] **Attestation seam + gate** (`shared/attestation.ts`) — `REQUIRE_ATTESTATION` blocks unattested
  nodes from registering (off by default so the live fleet keeps working). `OpenAttestation` for dev;
  `AppleAppAttestVerifier` is a **fail-closed stub** — the real DCAppAttest cert-chain/assertion crypto
  is the R3 follow-up (needs the agent's Swift side).
- [x] **Diminishing returns per operator** — a wallet's nodes sum best-first with geometric decay
  (`aggregateOwnerPoints`), so a 3-node operator earns ~0.86× linear — more good hardware still wins,
  just sub-linearly. One farm can't dominate.
- [x] **Penalty + auto-blacklist** — a confirmed fake-model serve records a `penalty` event (erodes
  score) and, after N strikes, bans the wallet (rejected at register, disconnected, hidden from the
  board). Admin `GET/POST /admin/blacklist` to inspect/override.
- **Definition of done:** ✅ a faker is penalized then banned; a banned wallet can't register or appear
  on the board; a multi-node farm is curbed by diminishing returns. *(Full sybil ceiling lands when
  the real App Attest verification replaces the stub.)*

### R4 — Reward issuance + formula finalization
- **Epoch snapshots** of a **fixed reward pool** split pro-rata by score (a competition for a fixed
  pie, not an infinite faucet — auto-balances supply), with **rolling-window decay** so it rewards
  *sustained* contribution, not one-off bursts.
- **Formula tuning, done honestly:** retune the `FORMULA_VERSION` constants against real shadow data,
  bump the version so historical scores stay reproducible, and **recompute history from the immutable
  log** before anything is finalized. Conversion rate stays **undisclosed + retroactive** until decided.
- **On-chain commitments** — periodically post the epoch leaderboard's **Merkle root to Solana** so the
  off-chain ledger is tamper-evident + auditable without paying for on-chain compute.
- **Definition of done:** an epoch closes, a fixed pool is allocated by a versioned formula recomputed
  from the log, and the result is committed on-chain — all without ever having promised a payout publicly.

### R5 — Decentralized peer verification (the trustless endgame)
- **Proof-of-sampling** — other nodes re-run a sample of each other's outputs and compare, reducing
  reliance on the central oracle; **prober signatures** on every event (the `sig` field, stubbed in R0)
  so attestations are independently verifiable.
- Collusion resistance (random committee selection, stake-free reputation weighting), then fold results
  back into the same score.
- **Definition of done:** a node's score can be independently reproduced from signed events without
  trusting a single central scorer.

**Ordering:** R0 done. **R1 is the keystone** — almost every score term is neutral until it runs.
R2 rides R0+R1 (endpoints exist). R3 hardens before any value is attached. R4 needs M4's settlement
rails. R5 is the long-horizon trustless upgrade.

---

## The 3 genuinely hard problems (everything else is "just engineering")
1. **Honest-inference verification (M5)** — your differentiator and your fraud risk.
2. **Payments security (M4)** — custody, escrow, on-chain payout correctness; mistakes lose real money.
3. **Provider unit economics** *(non-code, validate in parallel)* — per-commodity-token pricing **loses money on Macs**. Viable model: per-hour big-memory rental + batch, from *already-idle* Macs. If the economics don't work, the rest is moot.

## Minimum "end-to-end functional" slice
A thin vertical cut through M1+M2+M3+M4 (with basic M5, minimal M6/M7):
> customer funds USDC → gets an API key → calls the gateway → **load-balanced to an idle, model-warm node** → tokens metered to a Postgres ledger → provider gets a **batched USDC payout**.

Hitting that = a real marketplace with money flowing.

**Status (proven in prod):** everything in that slice *except the USDC funding/payout* now works
end-to-end — one-command provider onboarding → wallet identity → real inference routed to a node →
tokens metered to the Postgres ledger and attributed to the provider's wallet (`byOwner`). What's
left to "money flowing" is **M4** (customer USDC funding + batched provider payouts).

## Validate before scaling (top risks)
1. **Provider $/Mac/day** — supply must be already-idle Macs.
2. **Embedding/batch throughput** on a real Mac — makes or breaks the batch use case.
3. **Demand** for affordable big-memory / long-tail model access (interviews, not code).

---

## Deferred follow-ups
- **Idle-gated serving (node-agent).** Serving is currently always-on: the node serves continuously
  and relies on the dispatcher's least-inflight scheduler to route around a busy local node. Add an
  opt-in policy that detects user/agent activity and `koretex stop`/`start`s around it, so serving
  only runs when the machine is genuinely idle (lower contention, lower earnings). Surfaced by the
  Hermes provider skill (`skills/koretex-node-provider`), which uses the always-on flow today.
