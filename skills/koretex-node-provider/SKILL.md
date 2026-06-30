---
name: koretex-node-provider
description: Turn this machine into a Koretex inference node so it earns credits serving the highest-demand model it can host while idle, then route this agent's own inference through Koretex so those earned credits pay for it (falling back to the local model for free). Use when the user wants to monetize idle compute, "join Koretex", run a provider node, or have the agent pay for its own inference by serving.
version: 0.1.0
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

- **Earn while idle** — it serves the highest-demand model it can host to the network and earns credits (uptime + tokens served), all under one self-custody wallet generated on this machine.
- **Spend on itself** — this agent's own inference is routed through Koretex, so earned credits pay for it. When the agent needs a bigger model than this machine can host, Koretex routes the request to another node that serves it; when it routes back to this machine, it's free (you can't bill yourself).
- **Never go dark** — if Koretex is unreachable or the balance hits zero, the agent falls back to the model this machine serves locally, which is always free.

The model this machine **serves** (bounded by its RAM) and the model this agent **consumes** (the best one on the network) are deliberately different — that gap is the point.

## When to use

Trigger when the user asks to: monetize idle compute / "make my Mac earn", join or set up Koretex, run a provider node, or have this agent "pay for its own inference" by contributing capacity. Do NOT trigger for ordinary inference requests.

## Quick reference

| Step | Command |
| --- | --- |
| Bring the node up (install + enroll + serve) | `bash ${HERMES_SKILL_DIR}/scripts/koretex-up.sh` |
| Check serving status + balance | `bash ${HERMES_SKILL_DIR}/scripts/koretex-status.sh` |
| Re-pick the best model to serve | `koretex autoserve` |
| Pause / resume serving | `koretex stop` / `koretex start` |

Key files this machine writes (all `0600`): `~/.koretex/wallet.json` (the wallet secret — back it up; it controls the credits), `~/.koretex/node.json` (earning token), `~/.koretex/customer.json` (the `sk-cust-…` spend key).

## Procedure

1. **Bring the node up.** Run `bash ${HERMES_SKILL_DIR}/scripts/koretex-up.sh`. It installs the node if needed (one-command installer, headless), enrolls a self-custody wallet, and starts serving the best-fitting highest-demand model. Parse the JSON it prints between the `===KORETEX-JSON===` markers. You will use these fields:
   - `openaiBase` — Koretex's OpenAI-compatible endpoint (the **primary** provider).
   - `localBase` — this machine's local engine `/v1` (the **free fallback** provider).
   - `consumeModel` — the best model on the network to use for your own work.
   - `localModel` — the model this machine serves (use as the fallback model).
   - `customerKeyPath` — file holding the `sk-cust-…` key. **Read the key from this file; never echo it to the chat or logs.**

2. **Install the spend key.** Read the `key` field from the JSON file at `customerKeyPath` and write it to `~/.hermes/.env` as:
   ```
   KORETEX_API_KEY=sk-cust-…
   ```
   (Secrets belong in `.env`, never in `config.yaml`.)

3. **Repoint your own inference.** Edit `~/.hermes/config.yaml` so Koretex is the primary provider with the local model as a fallback. Use the values from step 1:
   ```yaml
   model:
     provider: koretex
     default: <consumeModel>
     fallback_providers:
       - provider: custom
         model: <localModel>
         base_url: <localBase>     # local engine — free, always available
         key_env: ""               # local engine needs no key
   custom_providers:
     koretex:
       base_url: <openaiBase>       # e.g. https://dispatcher.koretex.ai/v1
       api_key_env: KORETEX_API_KEY
       model_id_template: "{model}"
       supports_vision: false
   ```
   Preserve any existing `model:` settings the user already had as an additional fallback if they want a paid escape hatch (e.g. their old provider after the local one). Do not delete unrelated config.

   Then make an **empty Koretex balance** trigger the local fallback (Koretex returns HTTP `402` when
   credits run out; by default Hermes does not fail over on `402`):
   ```
   hermes config set fallback_on_status "402,429,500,502,503,504"
   ```
   New nodes start with welcome credits, so the common path won't hit `402`; this covers the case
   where the agent spends faster than the machine earns, degrading to the free local model.

4. **Verify** (see below), then **report**: tell the user which model the machine is now serving (earning) and which model the agent now consumes, the wallet address, and the dashboard URL for watching earnings/balance.

## Pitfalls

- **Never print or paste the `sk-cust-…` key or the wallet secret into the chat.** Reference them by file path only.
- **The wallet secret (`~/.koretex/wallet.json`) is the only key to this machine's credits.** Tell the user to back it up; losing it loses the balance. Don't regenerate it (don't run `enroll` with `FORCE=1`) unless the user explicitly wants a new identity.
- **End the Koretex base URL at `/v1`** — Hermes appends the path itself. `openaiBase` is already correct; don't add `/chat/completions`.
- **`consumeModel` may equal `localModel` on a young network** (few models served). That's fine — as the network grows, re-running the setup or `koretex recommend --json` will pick a larger model.
- **Balance can run dry** if this agent consumes far more than the machine serves. Koretex returns HTTP `402` when credits hit zero; the `fallback_on_status` setting (step 3) makes Hermes fail over to the free local model so the agent keeps working. Suggest the user serve a higher-demand model (`koretex autoserve`) or top up credits on the dashboard. (Note: some Hermes versions have known bugs where `402` failover doesn't fire reliably — if the agent errors on empty balance instead of falling back, update Hermes or temporarily set the local provider as primary.)
- **Serving is always-on in this version.** It runs continuously and relies on Koretex's scheduler to route around a busy local node. (Idle-gated serving — only serving when the user isn't using the machine — is on the roadmap.)

## Verification

1. `bash ${HERMES_SKILL_DIR}/scripts/koretex-status.sh` → confirms `Serving: yes ✓` and shows the wallet + served model.
2. Send a tiny test completion through Koretex to confirm the spend path works, e.g.:
   ```
   curl -s <openaiBase>/chat/completions \
     -H "Authorization: Bearer $(node -e 'console.log(require(process.env.HOME+"/.koretex/customer.json").key)')" \
     -H "content-type: application/json" \
     -d '{"model":"<consumeModel>","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
   ```
   A normal completion (or a clear `402` if there are zero credits yet — earnings accrue as the node serves) confirms the wiring. A `402` is expected on a brand-new node with no balance and no welcome credits; the local fallback covers the agent meanwhile.
3. Confirm the agent itself answers a prompt after the config change (it should now go out through Koretex, falling back to the local model if needed).
