#!/usr/bin/env bash
# Stops and removes the Koretex node-agent + managed engine services.
# Cross-platform: launchd on macOS, systemd --user on Linux. Leaves ~/.koretex (models, identity)
# in place unless you pass --purge.
set -euo pipefail

OS="$(uname -s)"
PURGE="${1:-}"

if [ "$OS" = "Darwin" ]; then
  for label in com.koretex.node-agent com.koretex.ollama; do
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$label.plist"
    echo "Removed $label"
  done
else
  for unit in koretex-node-agent koretex-ollama; do
    # system unit (current installs)
    sudo systemctl disable --now "$unit.service" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/$unit.service" 2>/dev/null || true
    # --user unit (older / no-sudo installs)
    systemctl --user disable --now "$unit.service" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/$unit.service"
    echo "Removed $unit"
  done
  sudo systemctl daemon-reload 2>/dev/null || true
  systemctl --user daemon-reload 2>/dev/null || true
fi

if [ "$PURGE" = "--purge" ]; then
  rm -rf "$HOME/.koretex"
  echo "Purged ~/.koretex (engine, models, identity)."
else
  echo "Left ~/.koretex in place (engine + models + wallet identity). Re-run with --purge to delete it."
fi
