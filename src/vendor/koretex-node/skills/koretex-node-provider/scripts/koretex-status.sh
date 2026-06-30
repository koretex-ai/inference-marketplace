#!/usr/bin/env bash
# koretex-status.sh — show whether this machine is serving, what it earns, and its credit balance.
# Read-only. Prints a human summary plus a JSON block for programmatic use.
set -euo pipefail

DISPATCHER="${KORETEX_DISPATCHER:-https://dispatcher.koretex.ai}"
AGENT_CJS="$HOME/.koretex/koretex-agent.cjs"
kx() {
  if command -v koretex >/dev/null 2>&1; then koretex "$@"
  elif [ -x "$HOME/.local/bin/koretex" ]; then "$HOME/.local/bin/koretex" "$@"
  elif [ -x "/opt/homebrew/bin/koretex" ]; then "/opt/homebrew/bin/koretex" "$@"
  else KORETEX_DISPATCHER="$DISPATCHER" node "$AGENT_CJS" "$@"; fi
}

if [ ! -f "$AGENT_CJS" ]; then
  echo "Koretex node is NOT installed on this machine. Run koretex-up.sh first."
  exit 0
fi

kx status || true
echo
echo "Credit balance (signed query for this machine's wallet):"
kx balance 2>/dev/null || echo "  (balance unavailable — update the node agent: re-run the installer)"
echo
echo "Dashboard: $DISPATCHER/dashboard"

ADDR="$(node -e 'try{console.log(require(process.env.HOME+"/.koretex/customer.json").address||"")}catch{console.log("")}')"
BAL="$(kx balance --json 2>/dev/null || echo '{}')"
echo "===KORETEX-JSON==="
node -e 'const b=JSON.parse(process.argv[3]||"{}");console.log(JSON.stringify({address: process.argv[1]||b.address||null, balanceCredits: b.balance ?? null, balanceUsd: b.usd ?? null, dashboard: process.argv[2]+"/dashboard"}, null, 2))' "$ADDR" "$DISPATCHER" "$BAL"
echo "===KORETEX-JSON==="
