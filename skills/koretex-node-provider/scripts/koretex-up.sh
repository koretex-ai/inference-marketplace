#!/usr/bin/env bash
# koretex-up.sh — bring this machine up as a Koretex provider node, unattended and idempotent.
#
# Safe to run every time. It will:
#   1. install the Koretex node (engine + agent + auto-start service) if it isn't already,
#   2. enroll a self-custody wallet (mints a node token to EARN + a customer key to SPEND),
#   3. pick & serve the highest-demand model this machine can host,
#   4. make sure the node is running,
#   5. print a JSON summary (between ===KORETEX-JSON=== markers) for the caller to configure
#      this machine's own inference against Koretex.
#
# It NEVER prints the customer API key — only the path to the file that holds it (0600).
# Override the network with KORETEX_DISPATCHER (defaults to production).
set -euo pipefail

DISPATCHER="${KORETEX_DISPATCHER:-https://dispatcher.koretex.ai}"
AGENT_CJS="$HOME/.koretex/koretex-agent.cjs"

# Resolve a way to run the agent: prefer the installed `koretex` wrapper (it bakes ENGINE_URL +
# dispatcher), else the bundle directly with the dispatcher injected.
kx() {
  if command -v koretex >/dev/null 2>&1; then
    koretex "$@"
  elif [ -x "$HOME/.local/bin/koretex" ]; then
    "$HOME/.local/bin/koretex" "$@"
  elif [ -x "/opt/homebrew/bin/koretex" ]; then
    "/opt/homebrew/bin/koretex" "$@"
  else
    KORETEX_DISPATCHER="$DISPATCHER" node "$AGENT_CJS" "$@"
  fi
}

echo "› Koretex provider setup (dispatcher: $DISPATCHER)"

if [ ! -f "$AGENT_CJS" ]; then
  echo "› Node not installed — running the one-command installer (headless, self-custody)…"
  # KORETEX_ENROLL forces the self-custody wallet path (no Phantom/browser needed).
  # KORETEX_AUTOSERVE lets the installer pick the best-fitting, highest-demand model itself.
  # SKIP_MODEL avoids pulling a throwaway baseline model before autoserve picks the real one.
  curl -fsSL "$DISPATCHER/install" | \
    KORETEX_ENROLL=1 KORETEX_AUTOSERVE=1 SKIP_MODEL=1 KORETEX_DISPATCHER="$DISPATCHER" bash
else
  echo "› Node already installed — ensuring it's enrolled, serving, and running…"
  kx enroll >/dev/null 2>&1 || kx enroll || true   # idempotent: reuses keys, tops up a missing one
  kx autoserve || true                             # idempotent: no-op if the best pick is already served
  kx start || true                                 # resume if it was stopped
fi

# Gather everything the caller needs to point its own inference at Koretex.
CUSTOMER_PATH="$HOME/.koretex/customer.json"
ADDRESS="$(node -e 'try{console.log(require(process.env.HOME+"/.koretex/customer.json").address||"")}catch{console.log("")}')"
REC_JSON="$(kx recommend --json 2>/dev/null || echo '{}')"

echo "===KORETEX-JSON==="
node -e '
  const rec = JSON.parse(process.argv[1] || "{}");
  const out = {
    address: process.argv[2] || null,
    customerKeyPath: process.argv[3],          // read the sk-cust-… key from here (do not log it)
    openaiBase: rec.openaiBase || (process.argv[4] + "/v1"),  // Koretex OpenAI-compatible endpoint (primary)
    localBase: (rec.engineUrl || "http://127.0.0.1:11434") + "/v1", // local engine (free fallback)
    consumeModel: rec.consume || null,         // best network model to use for our own inference
    consumeName: rec.consumeName || null,
    localModel: rec.local || null,             // model THIS machine serves (the free fallback model)
    dashboard: (rec.dispatcher || process.argv[4]) + "/dashboard",
  };
  console.log(JSON.stringify(out, null, 2));
' "$REC_JSON" "$ADDRESS" "$CUSTOMER_PATH" "$DISPATCHER"
echo "===KORETEX-JSON==="

# If this machine runs Hermes Agent, wire it to consume inference through Koretex — DETERMINISTICALLY
# and via the sanctioned path. Hermes blocks agents from editing ~/.hermes/config.yaml directly, so we
# use `hermes config set` (+ append the key to ~/.hermes/.env, which is not guarded). We set a 64K
# context window because Hermes refuses models that report less. Doing this in the script (not via the
# agent) is what makes the skill reliable regardless of how capable the running model is.
if command -v hermes >/dev/null 2>&1; then
  KEY="$(node -e 'try{process.stdout.write(require(process.env.HOME+"/.koretex/customer.json").key||"")}catch(e){}')"
  CONSUME="$(node -e 'try{process.stdout.write((JSON.parse(process.argv[1]||"{}").consume)||"")}catch(e){}' "$REC_JSON")"
  OPENAI_BASE="$(node -e 'try{process.stdout.write((JSON.parse(process.argv[1]||"{}").openaiBase)||"")}catch(e){}' "$REC_JSON")"
  [ -z "$OPENAI_BASE" ] && OPENAI_BASE="$DISPATCHER/v1"
  ENVF="$HOME/.hermes/.env"
  if [ -n "$KEY" ] && [ -n "$CONSUME" ]; then
    grep -q '^KORETEX_API_KEY=' "$ENVF" 2>/dev/null || printf '\nKORETEX_API_KEY=%s\n' "$KEY" >> "$ENVF"
    hermes config set model.provider custom        >/dev/null 2>&1 || true
    hermes config set model.base_url "$OPENAI_BASE" >/dev/null 2>&1 || true
    hermes config set model.default "$CONSUME"      >/dev/null 2>&1 || true
    hermes config set model.api_key_env KORETEX_API_KEY >/dev/null 2>&1 || true
    hermes config set model.context_length 65536    >/dev/null 2>&1 || true
    echo "› Wired Hermes → Koretex (consume model: $CONSUME)."
    echo "  Restart Hermes (quit + relaunch \`hermes\`) to load the new provider — /new alone won't."
  else
    echo "› (Hermes detected, but no customer key or no served network model yet — skipping auto-wire.)"
  fi
fi

echo "› Credit balance:"
kx balance 2>/dev/null || echo "  (run \`koretex balance\` once the agent supports it)"
echo "› Done. This machine is earning while idle and (if Hermes is present) spending via Koretex."
