#!/usr/bin/env bash
# End-to-end test of the full marketplace data path on ONE machine:
#   curl (customer) -> dispatcher gateway -> WS -> node-agent -> Ollama -> back
set -uo pipefail
cd "$(dirname "$0")/.."

MODEL="${MODEL:-gemma:2b}"   # override with gemma3:12b-it-qat once it's pulled
PORT=8787

echo "== starting dispatcher =="
ADMIN_TOKEN=e2e-admin
PORT=$PORT CUSTOMER_KEYS=sk-cust-demo ADMIN_TOKEN=$ADMIN_TOKEN npx tsx src/dispatcher/index.ts >/tmp/disp.log 2>&1 &
DISP=$!
sleep 1.5

echo "== starting node-agent =="
DISPATCHER_URL="ws://127.0.0.1:$PORT" npx tsx src/vendor/koretex-node/src/node-agent/index.ts >/tmp/agent.log 2>&1 &
AGENT=$!
sleep 2.5

cleanup() { kill $DISP $AGENT 2>/dev/null; }
trap cleanup EXIT

echo "== /v1/models (what the marketplace advertises) =="
curl -s http://127.0.0.1:$PORT/v1/models -H "Authorization: Bearer sk-cust-demo" | head -c 400; echo

echo "== unauth request (must be 401) =="
curl -s -o /dev/null -w "  HTTP %{http_code}\n" http://127.0.0.1:$PORT/v1/chat/completions \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"

echo "== streaming completion through the full path =="
curl -sN http://127.0.0.1:$PORT/v1/chat/completions \
  -H "Authorization: Bearer sk-cust-demo" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Say hi in 5 words.\"}]}" \
  | grep -o '"content":"[^"]*"' | head -20

echo "== ledger (billing basis: tokens credited to the node) =="
sleep 0.5
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:$PORT/admin/ledger | head -c 400; echo

echo "== done =="
