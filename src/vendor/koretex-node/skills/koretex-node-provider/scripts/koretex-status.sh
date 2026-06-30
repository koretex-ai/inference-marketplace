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
echo "Earnings + balance: $DISPATCHER/dashboard  (connect the same wallet shown above)"

# Best-effort balance via the customer key (the spend side). The /credits/balance endpoint takes a
# signed request from the browser; for a quick local read we just surface the wallet + dashboard.
ADDR="$(node -e 'try{console.log(require(process.env.HOME+"/.koretex/customer.json").address||"")}catch{console.log("")}')"
echo "===KORETEX-JSON==="
node -e 'console.log(JSON.stringify({address: process.argv[1]||null, dashboard: process.argv[2]+"/dashboard"}, null, 2))' "$ADDR" "$DISPATCHER"
echo "===KORETEX-JSON==="
