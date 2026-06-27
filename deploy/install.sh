#!/usr/bin/env bash
# One-command Koretex provider install (P1). Run:
#   curl -fsSL https://dispatcher.koretex.ai/install | bash
#
# Checks the Mac, installs Node if needed, downloads + runs a pinned inference engine that
# Koretex manages itself (so the user's own Ollama version can't break anything), pulls a
# model, installs the agent, links the wallet, and enables auto-start. Re-running is safe.
set -euo pipefail

DISPATCHER="${DISPATCHER:-https://dispatcher.koretex.ai}"
# ws(s):// form for the agent (https→wss, http→ws).
WS_DISPATCHER="$DISPATCHER"
WS_DISPATCHER="${WS_DISPATCHER/https:/wss:}"
WS_DISPATCHER="${WS_DISPATCHER/http:/ws:}"

KDIR="$HOME/.koretex"
AGENT="$KDIR/koretex-agent.cjs"
LABEL="com.koretex.node-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Managed inference engine — a pinned, checksum-verified Ollama we run ourselves on our own
# port, so we never depend on whatever Ollama (if any) the user has installed.
OLLAMA_VERSION="0.30.10"
OLLAMA_URL="https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/ollama-darwin.tgz"
OLLAMA_SHA256="ad8a4d2918ed09480b8160419570602b4f49e48c9e3792efb601c0f54619e48e"
OLLAMA_DIR="$KDIR/engine"
OLLAMA_BIN="$OLLAMA_DIR/ollama"
OLLAMA_ADDR="127.0.0.1:11435"             # off the default 11434 to avoid any system Ollama
ENGINE_URL="http://$OLLAMA_ADDR"
OLLAMA_LABEL="com.koretex.ollama"
OLLAMA_PLIST="$HOME/Library/LaunchAgents/$OLLAMA_LABEL.plist"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }

# Robustly (re)load a launchd agent. On a re-install the label is already registered, and a
# bare `bootstrap` then fails with "Input/output error" — so bootout first, settle, and fall
# back to kickstart. Never let a transient launchctl hiccup abort the install (set -e).
load_service() {
  local label="$1" plist="$2" dom="gui/$(id -u)"
  launchctl bootout "$dom/$label" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "$dom" "$plist" 2>/dev/null \
    || launchctl kickstart -k "$dom/$label" 2>/dev/null || true
  launchctl enable "$dom/$label" 2>/dev/null || true
}

bold "Koretex provider setup"

# 1. Eligibility (hard gate) -----------------------------------------------------
bold "1/5  Checking this Mac…"
if ! curl -fsSL "$DISPATCHER/preflight" | DISPATCHER="$DISPATCHER" bash; then
  echo "  Stopping — this Mac doesn't meet the requirements (see above)."; exit 1
fi

# 2. Node.js (the agent runs on it; the engine is managed below) ----------------
bold "2/5  Node.js…"
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "  Installing Node via Homebrew…"; brew install node
  else
    echo ""
    echo "  This Mac needs Node.js first (free). Install it, then re-run:"
    echo ""
    echo "    Node.js  →  https://nodejs.org"
    echo "       Download the macOS \"LTS\" installer (.pkg), open it, click through."
    echo ""
    echo "  Then re-run:"
    if [ -n "${KORETEX_TOKEN:-}" ]; then
      echo "    curl -fsSL $DISPATCHER/install | KORETEX_TOKEN=$KORETEX_TOKEN bash"
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
mkdir -p "$KDIR" "$OLLAMA_DIR"
if [ ! -x "$OLLAMA_BIN" ]; then
  echo "  Downloading the Koretex engine (~137MB, first time only)…"
  curl -fsSL -o "$KDIR/engine.tgz" "$OLLAMA_URL"
  GOT="$(shasum -a 256 "$KDIR/engine.tgz" | awk '{print $1}')"
  if [ "$GOT" != "$OLLAMA_SHA256" ]; then
    echo "  ✗ engine checksum mismatch — aborting for safety."; rm -f "$KDIR/engine.tgz"; exit 1
  fi
  tar -xzf "$KDIR/engine.tgz" -C "$OLLAMA_DIR"
  rm -f "$KDIR/engine.tgz"
fi
# Default context window for the managed engine. Ollama's stock default (~4096 tokens) is far too
# small for agentic/coding clients, whose system prompt + tool schemas alone can fill it (leaving
# almost nothing for the conversation → "context length exceeded" on the client). The OpenAI-compat
# endpoint gives callers no way to raise it, so we set it on the engine. Scale it to this Mac's
# memory so big rigs get a roomy window while 16GB Macs stay safe (KV cache is preallocated to this
# size). Models cap it at their own native max; KORETEX_CONTEXT_LENGTH overrides.
RAM_GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
if [ -n "${KORETEX_CONTEXT_LENGTH:-}" ]; then CTX_LEN="$KORETEX_CONTEXT_LENGTH"
elif [ "$RAM_GB" -ge 64 ]; then CTX_LEN=65536
elif [ "$RAM_GB" -ge 32 ]; then CTX_LEN=32768
else CTX_LEN=16384
fi

# Run the managed engine as its own launchd service (own port, auto-restart on login/crash).
cat > "$OLLAMA_PLIST" <<OPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$OLLAMA_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$OLLAMA_BIN</string><string>serve</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>OLLAMA_HOST</key><string>$OLLAMA_ADDR</string>
    <key>DYLD_LIBRARY_PATH</key><string>$OLLAMA_DIR</string>
    <key>OLLAMA_CONTEXT_LENGTH</key><string>$CTX_LEN</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/koretex-ollama.log</string>
  <key>StandardErrorPath</key><string>/tmp/koretex-ollama.err</string>
</dict></plist>
OPLIST
load_service "$OLLAMA_LABEL" "$OLLAMA_PLIST"
echo "  Waiting for the engine…"
for _ in $(seq 1 30); do curl -fsS "$ENGINE_URL/api/tags" >/dev/null 2>&1 && break; sleep 1; done

# Choose a model that fits this Mac (filtered by RAM + free disk, server-side). RAM_GB was computed
# above (for the engine context window); reuse it here.
FREE_GB="$(df -g "$HOME" 2>/dev/null | tail -1 | awk '{print $4}')"
FITTING="$(curl -fsS "$DISPATCHER/models/catalog?format=text&ram=$RAM_GB&disk=${FREE_GB:-0}" 2>/dev/null || true)"
if [ -n "${KORETEX_MODEL:-}" ]; then
  MODEL="$KORETEX_MODEL"
elif [ -n "${MODEL:-}" ]; then
  :
elif [ -n "$FITTING" ] && [ -r /dev/tty ]; then
  echo "  Models your Mac can run (×pts = points multiplier, \$/1M = what you earn — higher = prioritize):"
  i=1; TAGS=""
  while IFS='|' read -r tag name size type minram caps weight credits; do
    [ -z "$tag" ] && continue
    # credits/1M → $/1M at the 10000 credits/USDC peg (display only).
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
    ''|*[!0-9]*) MODEL="$PICK" ;;                                   # non-numeric → treat as a literal model tag
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
  # Website-first: the token was already minted when you connected your wallet on the site.
  printf '{"token":"%s","address":"%s"}\n' "$KORETEX_TOKEN" "${KORETEX_WALLET:-}" > "$KDIR/node.json"
  chmod 600 "$KDIR/node.json"
  echo "  Linked via your website wallet connection."
else
  # Agent-first: pair interactively (opens Phantom in your browser).
  DISPATCHER_URL="$WS_DISPATCHER" ENGINE_URL="$ENGINE_URL" node "$AGENT" pair
fi

# 5. Auto-start on login --------------------------------------------------------
bold "5/5  Enabling auto-start…"
NODE_BIN="$(command -v node)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string><string>$AGENT</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>DISPATCHER_URL</key><string>$WS_DISPATCHER</string>
    <key>ENGINE_URL</key><string>$ENGINE_URL</string>
    <key>KORETEX_BACKEND</key><string>${KORETEX_BACKEND:-llama.cpp}</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/koretex-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/koretex-agent.err</string>
</dict></plist>
PLIST
load_service "$LABEL" "$PLIST"

# Install a `koretex` convenience command (status/stop/start) on PATH where we can.
WRAP=""
for d in /opt/homebrew/bin /usr/local/bin; do
  [ -w "$d" ] && { WRAP="$d/koretex"; break; }
done
ADDED_PATH=0
if [ -z "$WRAP" ]; then
  mkdir -p "$HOME/.koretex/bin"; WRAP="$HOME/.koretex/bin/koretex"
  for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
    grep -qs 'koretex/bin' "$rc" 2>/dev/null || \
      printf '\n# Koretex node control\nexport PATH="$HOME/.koretex/bin:$PATH"\n' >> "$rc"
  done
  ADDED_PATH=1
fi
cat > "$WRAP" <<WRAP_EOF
#!/usr/bin/env bash
exec env ENGINE_URL="$ENGINE_URL" KORETEX_DISPATCHER="$DISPATCHER" "$NODE_BIN" "$AGENT" "\$@"
WRAP_EOF
chmod +x "$WRAP"

bold "✅ Done — this Mac is now a Koretex provider."
echo "  Earnings go to the wallet you just linked.  See them at: $DISPATCHER/dashboard"
if [ "$ADDED_PATH" = "1" ]; then
  echo "  Control:  open a NEW terminal, then:  koretex status | koretex stop | koretex start"
  echo "            (right now in this terminal:  export PATH=\"\$HOME/.koretex/bin:\$PATH\")"
else
  echo "  Control:  koretex status  |  koretex stop  |  koretex start"
fi
echo "  Models:   koretex models   (add/remove models to serve — more models = more demand you can earn from)"
echo "  Logs:     agent /tmp/koretex-agent.log · engine /tmp/koretex-ollama.log"
echo ""
