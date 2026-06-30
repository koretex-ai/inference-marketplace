#!/usr/bin/env bash
# One-command Koretex provider install. Run:
#   curl -fsSL https://dispatcher.koretex.ai/install | bash
#
# HARDWARE-AGNOSTIC: works on Apple Silicon Macs (Metal), Linux+NVIDIA (CUDA), and CPU-only
# machines. Windows providers: install WSL2 (Ubuntu) and run this inside it — WSL2 exposes the
# NVIDIA GPU to Linux, so it follows the Linux+NVIDIA path.
#
# Checks the machine, installs Node if needed, downloads + runs a pinned inference engine that
# Koretex manages itself (so the user's own Ollama can't break anything), pulls a model, installs
# the agent, links the wallet, and enables auto-start. Re-running is safe.
set -euo pipefail

DISPATCHER="${DISPATCHER:-https://dispatcher.koretex.ai}"
# ws(s):// form for the agent (https→wss, http→ws).
WS_DISPATCHER="$DISPATCHER"
WS_DISPATCHER="${WS_DISPATCHER/https:/wss:}"
WS_DISPATCHER="${WS_DISPATCHER/http:/ws:}"

KDIR="$HOME/.koretex"
AGENT="$KDIR/koretex-agent.cjs"

# --- Platform + accelerator detection ------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

detect_ram_gb() {
  case "$OS" in
    Darwin) echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 )) ;;
    Linux)  echo $(( $(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1048576 )) ;;
    *)      echo 0 ;;
  esac
}
detect_vram_gb() {
  command -v nvidia-smi >/dev/null 2>&1 || { echo 0; return; }
  local mib
  mib="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | awk '{s+=$1} END{print int(s)}')"
  echo $(( ${mib:-0} / 1024 ))
}

RAM_GB="$(detect_ram_gb)"
VRAM_GB="$(detect_vram_gb)"
# ACCEL_GB = memory the engine can actually use (drives model-fit + context sizing).
if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  ACCEL_KIND="apple"; ACCEL_GB="$RAM_GB"; BACKEND_DEFAULT="mlx"
elif (( VRAM_GB > 0 )); then
  ACCEL_KIND="nvidia"; ACCEL_GB="$VRAM_GB"; BACKEND_DEFAULT="cuda"
else
  ACCEL_KIND="cpu"; ACCEL_GB=$(( RAM_GB * 7 / 10 )); BACKEND_DEFAULT="cpu"
fi

# --- Managed inference engine — pinned, checksum-verified Ollama on our own port ---------------
OLLAMA_VERSION="0.30.10"
OLLAMA_DIR="$KDIR/engine"
OLLAMA_ADDR="127.0.0.1:11435"             # off the default 11434 to avoid any system Ollama
ENGINE_URL="http://$OLLAMA_ADDR"

# Per-platform asset + pinned SHA256 (verified against the GitHub release's published digests). Each
# platform pins its OWN checksum and compression; set KORETEX_ENGINE_SHA256 to override on a new
# arch. We fail closed if a platform's checksum is still a placeholder. macOS ships a gzip .tgz whose
# `ollama` binary sits at the archive root; Linux ships a zstd .tar.zst laid out as bin/ + lib/ollama.
case "$OS" in
  Darwin)
    OLLAMA_ASSET="ollama-darwin.tgz"; ENGINE_COMPRESS="gzip"
    OLLAMA_SHA256="${KORETEX_ENGINE_SHA256:-ad8a4d2918ed09480b8160419570602b4f49e48c9e3792efb601c0f54619e48e}"
    OLLAMA_BIN="$OLLAMA_DIR/ollama"; ENGINE_LIB_KEY="DYLD_LIBRARY_PATH"; ENGINE_LIB_DIR="$OLLAMA_DIR"
    ;;
  Linux)
    ENGINE_COMPRESS="zstd"
    case "$ARCH" in
      x86_64|amd64)  OLLAMA_ASSET="ollama-linux-amd64.tar.zst"; OLLAMA_SHA256="${KORETEX_ENGINE_SHA256:-046d8f28e58d58477a49558d8d1bcb2e81ca8b287f93c44b12ff919c10d178dd}" ;;
      aarch64|arm64) OLLAMA_ASSET="ollama-linux-arm64.tar.zst"; OLLAMA_SHA256="${KORETEX_ENGINE_SHA256:-b626aef722ddb9d64dd20a76eeba9267abc5e9494faabb97839db85462b707d7}" ;;
      *) echo "Unsupported Linux architecture: $ARCH"; exit 1 ;;
    esac
    OLLAMA_BIN="$OLLAMA_DIR/bin/ollama"; ENGINE_LIB_KEY="LD_LIBRARY_PATH"; ENGINE_LIB_DIR="$OLLAMA_DIR/lib/ollama"
    ;;
  *)
    echo "Unsupported OS '$OS'. On Windows, install WSL2 (Ubuntu) and run this installer inside it."
    exit 1
    ;;
esac
OLLAMA_URL="https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/${OLLAMA_ASSET}"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }

# 1. Eligibility (hard gate) -----------------------------------------------------
bold "1/5  Checking this machine…"
if ! curl -fsSL "$DISPATCHER/preflight" | DISPATCHER="$DISPATCHER" bash; then
  echo "  Stopping — this machine doesn't meet the requirements (see above)."; exit 1
fi
echo "  Detected: ${ACCEL_KIND} accelerator, ~${ACCEL_GB}GB usable, OS ${OS}/${ARCH}"

# 2. Node.js (the agent runs on it; the engine is managed below) ----------------
bold "2/5  Node.js…"
if ! command -v node >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    echo "  Installing Node via Homebrew…"; brew install node
  else
    echo ""
    echo "  This machine needs Node.js 20+ first (free). Install it, then re-run this installer:"
    echo ""
    if [ "$OS" = "Darwin" ]; then
      echo "    Node.js  →  https://nodejs.org  (download the macOS LTS .pkg, open it, click through)"
    else
      echo "    Easiest:  install nvm then 'nvm install 20'   →  https://github.com/nvm-sh/nvm"
      echo "    Or your distro's package (must be Node 20+):   e.g. 'sudo apt install nodejs npm'"
    fi
    echo ""
    echo "  Then re-run:"
    if [ -n "${KORETEX_TOKEN:-}" ]; then
      echo "    curl -fsSL $DISPATCHER/install | KORETEX_TOKEN=$KORETEX_TOKEN${KORETEX_WALLET:+ KORETEX_WALLET=$KORETEX_WALLET} bash"
    else
      echo "    curl -fsSL $DISPATCHER/install | bash"
    fi
    echo ""
    exit 0
  fi
fi
echo "  ✓ Node $(node -v)  (the inference engine is managed by Koretex — nothing else to install)"

# 3. Managed inference engine + model ------------------------------------------
bold "3/5  Setting up the inference engine…"
# Fail closed if this platform's engine checksum hasn't been pinned yet (never run unverified).
case "$OLLAMA_SHA256" in
  PLACEHOLDER_*)
    echo "  ✗ No pinned engine checksum for $OS/$ARCH yet."
    echo "    Set the verified SHA256 of $OLLAMA_ASSET and re-run:"
    echo "      curl -fsSL $DISPATCHER/install | KORETEX_ENGINE_SHA256=<sha256> bash"
    exit 1
    ;;
esac
mkdir -p "$KDIR" "$OLLAMA_DIR"
# Linux zstd bundles need the `zstd` tool to extract (matches Ollama's own installer requirement).
if [ "$ENGINE_COMPRESS" = "zstd" ] && ! command -v zstd >/dev/null 2>&1; then
  echo "  ✗ This engine needs 'zstd' to unpack. Install it and re-run:"
  echo "      Debian/Ubuntu: sudo apt-get install -y zstd"
  echo "      RHEL/Fedora:   sudo dnf install -y zstd"
  echo "      Arch:          sudo pacman -S zstd"
  exit 1
fi
if [ ! -x "$OLLAMA_BIN" ]; then
  ARCHIVE="$KDIR/engine-download"
  echo "  Downloading the Koretex engine ($OLLAMA_ASSET, first time only)…"
  curl -fsSL -o "$ARCHIVE" "$OLLAMA_URL"
  # shasum (macOS) or sha256sum (Linux).
  if command -v shasum >/dev/null 2>&1; then GOT="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  else GOT="$(sha256sum "$ARCHIVE" | awk '{print $1}')"; fi
  if [ "$GOT" != "$OLLAMA_SHA256" ]; then
    echo "  ✗ engine checksum mismatch — aborting for safety."; echo "    expected $OLLAMA_SHA256"; echo "    got      $GOT"
    rm -f "$ARCHIVE"; exit 1
  fi
  echo "  Unpacking…"
  if [ "$ENGINE_COMPRESS" = "zstd" ]; then
    zstd -dc "$ARCHIVE" | tar -xf - -C "$OLLAMA_DIR"   # → $OLLAMA_DIR/bin/ollama + $OLLAMA_DIR/lib/ollama
  else
    tar -xzf "$ARCHIVE" -C "$OLLAMA_DIR"               # darwin: ollama binary at the archive root
  fi
  rm -f "$ARCHIVE"
fi
if [ ! -x "$OLLAMA_BIN" ]; then echo "  ✗ engine binary not found at $OLLAMA_BIN after extract."; exit 1; fi

# Default context window for the managed engine. Ollama's stock default (~4096 tokens) is far too
# small for agentic/coding clients. Scale it to this machine's ACCELERATOR memory so big rigs get a
# roomy window while small ones stay safe (KV cache is preallocated to this size). Models cap it at
# their own native max; KORETEX_CONTEXT_LENGTH overrides.
if [ -n "${KORETEX_CONTEXT_LENGTH:-}" ]; then CTX_LEN="$KORETEX_CONTEXT_LENGTH"
elif [ "$ACCEL_GB" -ge 64 ]; then CTX_LEN=65536
elif [ "$ACCEL_GB" -ge 32 ]; then CTX_LEN=32768
else CTX_LEN=16384
fi

# Run the managed engine + agent as auto-restart services — launchd on macOS, systemd --user on Linux.
NODE_BIN="$(command -v node)"
NODE_PATH_DIR="$(dirname "$NODE_BIN")"
AGENT_LABEL="com.koretex.node-agent"
OLLAMA_LABEL="com.koretex.ollama"

start_engine_service() {
  if [ "$OS" = "Darwin" ]; then
    local plist="$HOME/Library/LaunchAgents/$OLLAMA_LABEL.plist"
    cat > "$plist" <<OPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$OLLAMA_LABEL</string>
  <key>ProgramArguments</key><array><string>$OLLAMA_BIN</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>OLLAMA_HOST</key><string>$OLLAMA_ADDR</string>
    <key>$ENGINE_LIB_KEY</key><string>$ENGINE_LIB_DIR</string>
    <key>OLLAMA_CONTEXT_LENGTH</key><string>$CTX_LEN</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/koretex-ollama.log</string>
  <key>StandardErrorPath</key><string>/tmp/koretex-ollama.err</string>
</dict></plist>
OPLIST
    launchd_load "$OLLAMA_LABEL" "$plist"
  else
    systemd_unit "koretex-ollama" "Koretex inference engine" \
      "$OLLAMA_BIN serve" \
      "OLLAMA_HOST=$OLLAMA_ADDR" "$ENGINE_LIB_KEY=$ENGINE_LIB_DIR" "OLLAMA_CONTEXT_LENGTH=$CTX_LEN"
  fi
}

start_agent_service() {
  if [ "$OS" = "Darwin" ]; then
    local plist="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$AGENT</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>DISPATCHER_URL</key><string>$WS_DISPATCHER</string>
    <key>ENGINE_URL</key><string>$ENGINE_URL</string>
    <key>KORETEX_BACKEND</key><string>${KORETEX_BACKEND:-$BACKEND_DEFAULT}</string>
    <key>PATH</key><string>$NODE_PATH_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/koretex-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/koretex-agent.err</string>
</dict></plist>
PLIST
    launchd_load "$AGENT_LABEL" "$plist"
  else
    systemd_unit "koretex-node-agent" "Koretex node agent" \
      "$NODE_BIN $AGENT" \
      "DISPATCHER_URL=$WS_DISPATCHER" "ENGINE_URL=$ENGINE_URL" \
      "KORETEX_BACKEND=${KORETEX_BACKEND:-$BACKEND_DEFAULT}" \
      "PATH=$NODE_PATH_DIR:/usr/local/bin:/usr/bin:/bin"
  fi
}

# launchd: robustly (re)load a user agent — bootout first, then bootstrap, falling back to kickstart.
launchd_load() {
  local label="$1" plist="$2" dom="gui/$(id -u)"
  launchctl bootout "$dom/$label" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "$dom" "$plist" 2>/dev/null || launchctl kickstart -k "$dom/$label" 2>/dev/null || true
  launchctl enable "$dom/$label" 2>/dev/null || true
}

# systemd --user: write a unit, reload, enable+start. Linger lets it run without an active login.
systemd_unit() {
  local name="$1" desc="$2" exec="$3"; shift 3
  local dir="$HOME/.config/systemd/user"; mkdir -p "$dir"
  { echo "[Unit]"; echo "Description=$desc"; echo "After=network-online.target"
    echo ""; echo "[Service]"
    for env in "$@"; do echo "Environment=\"$env\""; done
    echo "ExecStart=$exec"; echo "Restart=always"; echo "RestartSec=3"
    echo ""; echo "[Install]"; echo "WantedBy=default.target"
  } > "$dir/$name.service"
  # Linger keeps user services running after logout. Best-effort here (a piped installer can't
  # prompt for sudo); if it doesn't take, the final message tells the user the one command to run.
  loginctl enable-linger "$USER" 2>/dev/null || sudo -n loginctl enable-linger "$USER" 2>/dev/null || true
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now "$name.service" 2>/dev/null \
    || echo "    (couldn't start $name via systemd --user — check: systemctl --user status $name)"
}

start_engine_service
echo "  Waiting for the engine…"
for _ in $(seq 1 30); do curl -fsS "$ENGINE_URL/api/tags" >/dev/null 2>&1 && break; sleep 1; done

# Choose a model that fits this machine (filtered by ACCELERATOR memory + free disk, server-side).
FREE_GB="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print int($4/1048576)}')"
FITTING="$(curl -fsS "$DISPATCHER/models/catalog?format=text&accel=$ACCEL_GB&disk=${FREE_GB:-0}" 2>/dev/null || true)"
if [ -n "${KORETEX_MODEL:-}" ]; then
  MODEL="$KORETEX_MODEL"
elif [ -n "${MODEL:-}" ]; then
  :
elif [ -n "$FITTING" ] && [ -r /dev/tty ]; then
  echo "  Models your machine can run (×pts = points multiplier, \$/1M = what you earn — higher = prioritize):"
  i=1; TAGS=""
  while IFS='|' read -r tag name size type minram caps weight credits; do
    [ -z "$tag" ] && continue
    usd=$(awk -v c="${credits:-0}" 'BEGIN{printf "%.2f", c/10000}')
    printf "    %d) %-28s [%-4s] ~%sGB%s   ·  ×%s pts · \$%s/1M\n" \
      "$i" "$name" "${type:-text}" "$size" "${caps:+   ·  ${caps//,/, }}" "${weight:-1.00}" "$usd"
    TAGS="$TAGS${TAGS:+ }$tag"; i=$((i + 1))
  done <<EOF
$FITTING
EOF
  echo "  These are just suggestions — you can serve ANY model: type its Ollama tag"
  echo "  (e.g. llama3.2:1b) or a HuggingFace GGUF (hf.co/<org>/<repo>:<QUANT>)."
  echo "  (add more anytime after setup with:  koretex models)"
  printf "  Choose a number, or paste any model tag [1]: "; read -r PICK < /dev/tty || PICK=1
  PICK="${PICK:-1}"
  case "$PICK" in
    ''|*[!0-9]*) MODEL="$PICK" ;;
    *)           MODEL="$(echo "$TAGS" | tr ' ' '\n' | sed -n "${PICK}p")" ;;
  esac
  [ -z "$MODEL" ] && MODEL="$(echo "$TAGS" | tr ' ' '\n' | sed -n '1p')"
else
  MODEL="$(printf '%s\n' "$FITTING" | head -1 | cut -d'|' -f1)"
  [ -z "$MODEL" ] && MODEL="gemma3:12b-it-qat"
fi

if [ "${SKIP_MODEL:-0}" != "1" ]; then
  if curl -fsS "$ENGINE_URL/api/tags" >/dev/null 2>&1; then
    echo "  Pulling $MODEL (large download — first time only)…"
    OLLAMA_HOST="$OLLAMA_ADDR" "$OLLAMA_BIN" pull "$MODEL" || echo "  (pull failed — retry later)"
  else
    echo "  Engine didn't come up — see /tmp/koretex-ollama.log"
  fi
fi

# 4. Install the agent + link your wallet ---------------------------------------
bold "4/5  Installing the agent and linking your wallet…"
curl -fsSL "$DISPATCHER/agent.js" -o "$AGENT"
if [ -n "${KORETEX_TOKEN:-}" ]; then
  printf '{"token":"%s","address":"%s"}\n' "$KORETEX_TOKEN" "${KORETEX_WALLET:-}" > "$KDIR/node.json"
  chmod 600 "$KDIR/node.json"
  echo "  Linked via your website wallet connection."
else
  DISPATCHER_URL="$WS_DISPATCHER" ENGINE_URL="$ENGINE_URL" node "$AGENT" pair
fi

# 5. Auto-start on login --------------------------------------------------------
bold "5/5  Enabling auto-start…"
start_agent_service

# Install a `koretex` convenience command on PATH. Prefer a system bin that's already on PATH;
# otherwise ~/.local/bin (login shells add it automatically when it exists) + wire the rc files.
WRAP=""; NEEDS_PATH_HINT=0; KBIN="$HOME/.local/bin"
for d in /opt/homebrew/bin /usr/local/bin; do
  [ -d "$d" ] && [ -w "$d" ] && { WRAP="$d/koretex"; break; }
done
if [ -z "$WRAP" ]; then
  mkdir -p "$KBIN"; WRAP="$KBIN/koretex"
  case ":$PATH:" in *":$KBIN:"*) : ;; *) NEEDS_PATH_HINT=1 ;; esac
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [ -e "$rc" ] || continue
    grep -qs '# KORETEX PATH' "$rc" 2>/dev/null || \
      printf '\n# KORETEX PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
  done
fi
cat > "$WRAP" <<WRAP_EOF
#!/usr/bin/env bash
exec env ENGINE_URL="$ENGINE_URL" KORETEX_DISPATCHER="$DISPATCHER" "$NODE_BIN" "$AGENT" "\$@"
WRAP_EOF
chmod +x "$WRAP"

bold "✅ Done — this machine is now a Koretex provider."
echo "  Accelerator: ${ACCEL_KIND} (~${ACCEL_GB}GB usable).  Earnings go to the wallet you linked."
echo "  Dashboard:   $DISPATCHER/dashboard"
echo ""
echo "  Control your node:  koretex status | koretex stop | koretex start | koretex models"
if [ "$NEEDS_PATH_HINT" = "1" ]; then
  echo "    ↳ in THIS terminal first run:  export PATH=\"\$HOME/.local/bin:\$PATH\"   (new terminals pick it up automatically)"
fi
if [ "$OS" != "Darwin" ]; then
  echo ""
  echo "  IMPORTANT — keep the node running after you log out / close the terminal:"
  echo "      sudo loginctl enable-linger \"$USER\""
  echo "    Low-level control:  systemctl --user status|stop|start koretex-node-agent"
  echo "    On WSL (Windows), also keep the distro alive — see the dashboard's \"Run a node\" → troubleshooting."
fi
echo "  Logs:  agent /tmp/koretex-agent.log · engine /tmp/koretex-ollama.log"
[ "$OS" = "Linux" ] && echo "         (or: journalctl --user -u koretex-node-agent -f)"
echo ""
