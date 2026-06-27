# Points & reputation — architecture reference

How the provider points system is built, and **why** it's built this way. This is the reference for
the data model; the product/roadmap view of the R-track lives in [ROADMAP.md](ROADMAP.md), and the
provider-facing explanation is the public `/points` page (`src/dispatcher/points.html`).

---

## The shape of the problem

Points reward providers for three things: **uptime**, **hardware quality**, and **serving the best,
genuine models** — and must be **un-farmable**. A points system is fundamentally an *oracle problem*
(we reward claims about off-chain state), so the rule is: reward **verified work under unpredictable
challenge**, never self-reported specs or bare heartbeats.

Publicly this is framed as a **growth leaderboard** (ranks, tiers, badges) with **no payout
promise**. Underneath, the ledger is built so a retroactive reward *could* be computed and defended
later — so the data must be trustworthy from day one even though the displayed formula is provisional.

---

## Two tables: an audit log + a summary read model

The naive design — one append-only `node_events` table that every read re-aggregates — has a
scaling flaw. The prober writes a steady stream of mostly-identical "still healthy" rows, and the
reputation cache + leaderboard would re-scan the *entire* growing table every 30s. Write volume is
bounded (the prober caps probes per tick), but **read cost grows with all of history, forever.**

So we split reads from writes (event-sourcing with a materialized read model / CQRS):

| Table | Role | Grows with | Read on the hot path? |
|---|---|---|---|
| `node_events` | Immutable **audit log** of every probe/job/penalty | event volume (pruned on a TTL) | No |
| `node_summary` | **Read model**: running counters per `(node, epoch)` | nodes × epochs | Yes |
| `node_models` | Distinct `(node, epoch, model)` for the diversity bonus | nodes × epochs × models | Yes |

Every read (leaderboard, routing reputation, dashboard) hits **only the summary**, so its cost
scales with the number of *nodes*, not the amount of *history*.

### Why we store *ingredients*, not a running *score*

The obvious idea — keep one cumulative "total score" and add to it per event — **does not work here**,
for three reasons baked into the scoring formula
(`points = uptime × (hardware + modelValue) × trust − penalties`):

1. **A time term that moves on its own.** `trust` ramps with a node's *age*, so the score changes
   every second even when no new events arrive. A frozen total would be stale immediately.
2. **Averages.** `hardware` uses *average* throughput — you can't keep a running average as one
   number; you need the running **sum** and **count**, then divide.
3. **Ratios.** `uptime` is passes ÷ checks — again two running counts, not one total.

So the summary stores the **linear building blocks** (counts and sums — every field composes by
addition), and the nonlinear, clock-dependent score is **re-derived on read** from those counters.
That derivation is `summaryToSignals() → scoreNode()`, microscopic math over ~one row per node.

The one field that isn't a scalar sum is **model diversity** (a `count(DISTINCT model)`), which can't
be kept as a running number — hence the small `node_models` set table.

---

## How it's maintained

The single source of truth for "how does one event change the summary" is the pure function
**`eventDeltas(ev)`** in `src/shared/points.ts`. Both store implementations use it, so the
incremental math lives in exactly one tested place and can't drift between them.

- **Postgres** (`points-postgres.ts`): `record()` runs **one statement** that inserts the audit row
  *and* upserts the summary, with the summary update gated on the insert actually happening
  (`RETURNING 1` + `WHERE EXISTS`). This makes it **atomic** (summary can't drift from the log) and
  **idempotent** (a duplicate `event_id` hits `ON CONFLICT DO NOTHING`, so `ins` is empty and the
  summary isn't touched). The `node_models` insert is separately idempotent on its primary key.
- **In-memory** (`points.ts`, dev/e2e): mirrors the same structure — a raw `events` array plus
  `node→epoch` counter maps and model sets, updated via the same `eventDeltas`, with an `event_id`
  dedup set mirroring Postgres' `ON CONFLICT`. So unit tests here validate the exact logic prod uses.

---

## Pruning the audit log

Because the summary already holds the aggregates, the raw `node_events` rows are only needed for
recent audit/debugging. The dispatcher prunes them on a TTL (`RAW_RETENTION_DAYS`, default 30; set
`0` to keep everything) every 6 hours. **Pruning never changes any score** — that invariant is tested
(prune raw rows → leaderboard identical).

### The trade-off to remember

The summary is now the durable history; the raw log is a rolling recent window. Consequences:

- **Re-tuning the formula** over history works as long as the new formula needs only signals the
  summary already tracks — it does, by construction (`scoreNode` reads only `NodeSignals`, all of
  which the summary carries per epoch).
- **Adding a brand-new signal** (a counter we don't track yet) only applies from when it's added
  forward, *unless* you backfill it from whatever raw window is still retained. If a signal might
  matter retroactively, add its counter to the summary before you need it.
- For a full forever-audit trail, archive pruned rows to cold storage (e.g. S3) before deleting —
  not done today; flagged here for when it's needed.

On upgrade from the old single-table version, `init()` **backfills** the summary from existing raw
events once (guarded on the summary being empty), so no history is lost.

---

## Epochs

Counters are keyed by `(node, epoch)` where an epoch is one day (`EPOCH_MS`, from a fixed genesis).
This gives per-epoch leaderboards cheaply (`WHERE epoch = N`) and is the natural grain for the
fixed-pool, decaying reward seasons in R4. "All-time" reads simply sum across a node's epoch rows —
still tiny (one row per node per day).

---

## What's deliberately *not* here

- **No static hardware/model ladder.** Scoring never reads `chip`/`ramGb` or specific model names —
  those are self-reported and spoofable. Hardware is scored from *measured* throughput; model value
  from *realized demand* + diversity + authenticity. A legible named-tier mapping could be layered on
  top for display without changing this truth.
- **No precomputed score column.** By design (see "ingredients, not score" above).

---

## File map

| File | What |
|---|---|
| `src/shared/points.ts` | Event types, pure scorer, summary primitives (`eventDeltas`/`addCounters`/`summaryToSignals`), in-memory store |
| `src/shared/points-postgres.ts` | Two-table Postgres store (events + summary + models), backfill, prune |
| `src/dispatcher/prober.ts` | Synthetic challenge prober (writes `challenge` events) |
| `src/shared/fingerprint.ts` | Quorum model-authenticity fingerprinting |
| `src/dispatcher/index.ts` | Wiring: record on job done, prober, reputation cache, prune job, read endpoints |
| `src/dispatcher/leaderboard.html` / `points.html` | Public leaderboard + explainer pages |
