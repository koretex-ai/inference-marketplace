---
name: koretex-node-provider
description: Turn this machine into a Koretex inference node so it earns credits serving the highest-demand model it can host while idle, then route this agent's own inference through Koretex so those earned credits pay for it. Use when the user wants to monetize idle compute, "join Koretex", run a provider node, check Koretex credits, or have the agent pay for its own inference by serving.
version: 0.2.0
author: Koretex (koretex-ai)
license: Apache-2.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [inference, earnings, provider, koretex, local-models, credits, monetize-idle]
related_skills: []
---

# Koretex provider node

Make this machine a two-way participant in the Koretex inference marketplace:

- **Earn while idle** — it serves the highest-demand model it can host to the network and earns credits (uptime + tokens served), under one self-custody wallet generated on this machine.
- **Spend on itself** — this agent's own inference is routed through Koretex, so earned credits pay for it. Routing back to this machine is free (you can't bill yourself); routing to another node spends credits.

The model this machine **serves** (bounded by its RAM) and the model this agent **consumes** (a big-context model on the network) are deliberately different — that gap is the point. Hermes requires a model with **≥64K context**, so the consume model is always a larger network model, never the small local one.

## When to use

Trigger when the user asks to: monetize idle compute / "make my Mac earn", join or set up Koretex, run a provider node, check Koretex credit balance, or have this agent "pay for its own inference" by contributing capacity. Do NOT trigger for ordinary inference requests.

## Quick reference

| Step | Command |
| --- | --- |
| Bring the node up + auto-wire this agent | `bash ${HERMES_SKILL_DIR}/scripts/koretex-up.sh` |
| Status + credit balance | `bash ${HERMES_SKILL_DIR}/scripts/koretex-status.sh` |
| Credit balance only | `koretex balance` |
| Re-pick the best model to serve | `koretex autoserve` |
| Pause / resume serving | `koretex stop` / `koretex start` |

Files this machine writes (all `0600`): `~/.koretex/wallet.json` (wallet secret — back it up; it controls the credits), `~/.koretex/node.json` (earning token), `~/.koretex/customer.json` (the `sk-cust-…` spend key).

## Procedure

1. **Run the setup script — it does everything:**
   ```
   bash ${HERMES_SKILL_DIR}/scripts/koretex-up.sh
   ```
   It installs the node (headless), enrolls a **self-custody wallet** (mints the earn token + spend key, grants welcome credits), serves the best-fit model, and — because it detects it's running under Hermes — **wires Hermes to consume through Koretex automatically**: it runs `hermes config set` (provider `custom`, the Koretex base URL, the consume model, `api_key_env`, `context_length 65536`) and puts the key in `~/.hermes/.env`. It prints a `===KORETEX-JSON===` block and the current credit balance.

   **Do NOT try to edit `~/.hermes/config.yaml` yourself** — Hermes blocks agents from writing it (security), and you don't need to: the script already did it via the sanctioned `hermes config set` path.

2. **Tell the user to restart Hermes.** The config only loads in a **fresh Hermes process** — `quit and relaunch \`hermes\``. `/new` alone does **not** reload it (a new session reuses the running process's startup config).

3. **Report:** the served (earning) model, the consume model now configured, the wallet address, the current balance (from the script / `koretex balance`), and the dashboard URL. Never print the `sk-cust-…` key or the wallet secret — reference them by file path.

## Pitfalls

- **Never print/paste the `sk-cust-…` key or `~/.koretex/wallet.json` into the chat.** Reference by path.
- **The wallet secret is the only key to this machine's credits.** Tell the user to back up `~/.koretex/wallet.json`; losing it loses the balance. Don't re-enroll with `FORCE=1` unless they want a new identity.
- **Don't edit `~/.hermes/config.yaml` directly** — Hermes refuses agent writes to it. Use `hermes config set …` (the script already does). The API key goes in `~/.hermes/.env` (not guarded).
- **Config changes need a Hermes RESTART**, not `/new`. Quit and relaunch `hermes`.
- **Hermes needs ≥64K context.** The script sets `model.context_length 65536` and picks a large network model. If Hermes errors that a model's window is below 64K, the chosen consume model (or the node serving it) is too small — pick a bigger one with `hermes config set model.default <model>` from the network's larger models.
- **Empty balance → HTTP 402.** New nodes start with welcome credits, so the common path is fine. If the agent out-spends what it earns and inference starts failing with a credit error, have the user serve a higher-demand model (`koretex autoserve`) or top up on the dashboard. (There is no automatic local-model fallback — a small local model can't satisfy Hermes's 64K requirement. If the user wants a safety net, keep their previous provider via `hermes fallback add`.)
- **Some served models are reasoning models** (output arrives in a `reasoning` field) — Hermes handles these. Avoid models that return empty content.
- **Serving is always-on** in this version (relies on Koretex's scheduler to route around a busy local node). Idle-gated serving is on the roadmap.

## Verification

1. `bash ${HERMES_SKILL_DIR}/scripts/koretex-status.sh` → shows `Serving: yes ✓`, the wallet, and the **credit balance**.
2. After the user restarts Hermes, ask the agent **"which model are you using?"** — it should report the Koretex consume model (provider `custom`, via `dispatcher.koretex.ai`), not the previous provider.
3. Give it a small real task; a normal answer confirms inference is flowing through Koretex. Check `koretex balance` before/after a few requests to see credits move (it stays flat when requests route back to this machine — that's the free self-deal).
