#!/usr/bin/env bash
# Installs the node-agent as a launchd LaunchAgent so this Mac auto-joins the
# marketplace on login and restarts if it crashes.
#
# Usage:
#   ./deploy/install-agent.sh                       # connects to ws://127.0.0.1:8787 (local test)
#   DISPATCHER_URL=ws://VPS_IP:8787 ./deploy/install-agent.sh   # connect to a remote dispatcher
set -euo pipefail

LABEL="com.macinference.node-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NODE_BIN="$(command -v node)"
TSX_CLI="$PROJ/node_modules/tsx/dist/cli.mjs"
AGENT_TS="$PROJ/src/node-agent/cli.ts"

# Config (overridable via env) ------------------------------------------------
DISPATCHER_URL="${DISPATCHER_URL:-ws://127.0.0.1:8787}"
ENGINE_URL="${ENGINE_URL:-http://127.0.0.1:11434}"
NODE_ID="${NODE_ID:-mac-$(scutil --get LocalHostName 2>/dev/null || hostname)}"
PRICE_PER_MTOK="${PRICE_PER_MTOK:-0.5}"
REGION="${REGION:-local}"
NODE_TOKEN="${NODE_TOKEN:-}"

[ -f "$TSX_CLI" ] || { echo "tsx not found at $TSX_CLI — run 'npm install' first"; exit 1; }
[ -n "$NODE_BIN" ] || { echo "node not found on PATH"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$TSX_CLI</string>
    <string>$AGENT_TS</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DISPATCHER_URL</key><string>$DISPATCHER_URL</string>
    <key>ENGINE_URL</key><string>$ENGINE_URL</string>
    <key>NODE_ID</key><string>$NODE_ID</string>
    <key>PRICE_PER_MTOK</key><string>$PRICE_PER_MTOK</string>
    <key>REGION</key><string>$REGION</string>
    <key>NODE_TOKEN</key><string>$NODE_TOKEN</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>$PROJ</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/macinference-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/macinference-agent.err</string>
</dict>
</plist>
PLIST_EOF

# Reload cleanly.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "Installed $LABEL"
echo "  dispatcher: $DISPATCHER_URL"
echo "  node id:    $NODE_ID"
echo "  logs:       /tmp/macinference-agent.log (+ .err)"
echo "To repoint at a VPS: DISPATCHER_URL=ws://VPS_IP:8787 $0"
