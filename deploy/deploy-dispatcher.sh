#!/usr/bin/env bash
# One-command deploy of the dispatcher to an Ubuntu/Debian VPS.
#
#   ./deploy/deploy-dispatcher.sh root@YOUR_VPS_IP
#
# Generates secrets on first run (saved to deploy/.secrets.env, gitignored), rsyncs the
# code, installs Node 22 + the systemd service, opens port 8787, and prints how to point
# this Mac's agent at it. Re-running redeploys with the SAME secrets.
set -euo pipefail

TARGET="${1:?usage: deploy-dispatcher.sh user@host}"
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="$PROJ/deploy/.secrets.env"

# 1. Secrets — generate once, reuse thereafter.
if [ ! -f "$SECRETS" ]; then
  echo "Generating secrets -> $SECRETS"
  {
    echo "PORT=8787"
    echo "CUSTOMER_KEYS=sk-cust-$(openssl rand -hex 16)"
    echo "NODE_TOKEN=$(openssl rand -hex 24)"
  } > "$SECRETS"
  chmod 600 "$SECRETS"
fi
# shellcheck disable=SC1090
source "$SECRETS"
HOST_ONLY="${TARGET#*@}"

echo "== rsync code -> $TARGET:/tmp/mi-src/ =="
rsync -az --delete --exclude node_modules --exclude '.git' --exclude 'deploy/.secrets.env' \
  "$PROJ/" "$TARGET:/tmp/mi-src/"
scp -q "$PROJ/deploy/dispatcher.service" "$TARGET:/tmp/dispatcher.service"
scp -q "$SECRETS" "$TARGET:/tmp/dispatcher.env"

echo "== remote setup (Node 22 + systemd + firewall) =="
ssh "$TARGET" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
# Node 22 if missing or too old
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
id macinf >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin macinf
mkdir -p /opt/macinference /etc/macinference
rsync -a --delete /tmp/mi-src/ /opt/macinference/
mv /tmp/dispatcher.env /etc/macinference/dispatcher.env
chmod 600 /etc/macinference/dispatcher.env
( cd /opt/macinference && npm install --no-audit --no-fund )
chown -R macinf:macinf /opt/macinference /etc/macinference
mv /tmp/dispatcher.service /etc/systemd/system/macinference-dispatcher.service
systemctl daemon-reload
systemctl enable --now macinference-dispatcher
# firewall (no-op if ufw absent/inactive)
command -v ufw >/dev/null 2>&1 && ufw allow 8787/tcp || true
sleep 1
systemctl --no-pager --lines=0 status macinference-dispatcher | head -4
REMOTE

echo
echo "============================================================"
echo " Dispatcher deployed to http://$HOST_ONLY:8787"
echo "   health:    curl http://$HOST_ONLY:8787/healthz"
echo "   customer:  Bearer $CUSTOMER_KEYS"
echo
echo " Point THIS Mac's agent at it:"
echo "   NODE_TOKEN=$NODE_TOKEN \\"
echo "   DISPATCHER_URL=ws://$HOST_ONLY:8787 \\"
echo "   $PROJ/deploy/install-agent.sh"
echo "============================================================"
