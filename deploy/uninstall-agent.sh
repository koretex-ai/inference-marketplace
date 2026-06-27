#!/usr/bin/env bash
# Stops and removes the node-agent launchd service.
set -euo pipefail
LABEL="com.macinference.node-agent"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL"
