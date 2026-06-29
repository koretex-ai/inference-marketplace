#!/usr/bin/env bash
# Provider eligibility preflight. Read-only — installs nothing, changes nothing.
#
# HARDWARE-AGNOSTIC: supports Apple Silicon Macs (unified memory), NVIDIA GPUs (dedicated VRAM)
# on macOS/Linux, and CPU-only machines. It detects the accelerator, reports the memory the
# inference engine can actually use, and recommends a model that fits.
#
# Usage:
#   ./deploy/preflight.sh
#   curl -fsSL https://dispatcher.koretex.ai/preflight | bash
#
# Exit code: 0 = can participate, 1 = cannot (reason printed).
set -euo pipefail

# --- Minimum spec --------------------------------------------------------------
MIN_ACCEL_GB=8       # below this: only tiny models, little demand
DISK_HEADROOM_GB=10  # free space needed on top of the model's own size
DISPATCHER="${DISPATCHER:-https://dispatcher.koretex.ai}"  # source of the live model catalog

# --- Output helpers ------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  BOLD=""; RED=""; GRN=""; YEL=""; DIM=""; RST=""
fi
pass() { printf "  ${GRN}✓${RST} %s\n" "$1"; }
warn() { printf "  ${YEL}!${RST} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RST} %s\n" "$1"; }
hr()   { printf "${DIM}%s${RST}\n" "────────────────────────────────────────────────────────"; }

# --- Hardware detection (cross-platform) ---------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

# Total system memory in whole GiB.
detect_ram_gb() {
  case "$OS" in
    Darwin) echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 )) ;;
    Linux)  echo $(( $(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1048576 )) ;;
    *)      echo 0 ;;
  esac
}

# Total NVIDIA VRAM in whole GiB (summed across cards); 0 if no NVIDIA GPU / driver.
detect_vram_gb() {
  command -v nvidia-smi >/dev/null 2>&1 || { echo 0; return; }
  local mib
  mib="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | awk '{s+=$1} END{print int(s)}')"
  echo $(( ${mib:-0} / 1024 ))
}

# Free disk on the volume backing $HOME, in whole GiB (POSIX df, portable across macOS/Linux).
detect_free_disk_gb() {
  df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print int($4/1048576)}'
}

# Recommend a model for a given amount of usable ACCELERATOR memory (GB).
# Echoes: <ollama-tag>|<human label>|<approx model size GB>
recommend_model() {
  local gb=$1
  if   (( gb >= 96 )); then echo "llama3.3:70b|70B class|43"
  elif (( gb >= 48 )); then echo "qwen2.5:32b|32B class|20"
  elif (( gb >= 24 )); then echo "gemma3:12b-it-qat|12B class — the network's primary model|9"
  elif (( gb >= 16 )); then echo "gemma3:12b-it-qat|12B class (tight but workable) — the network's primary model|9"
  else                      echo "llama3.2:3b|3B class (small models only — limited demand)|2"
  fi
}

printf "\n${BOLD}Koretex provider preflight${RST}\n"
hr

eligible=1   # 1 = ok so far, 0 = hard-blocked

# --- 1. OS ---------------------------------------------------------------------
case "$OS" in
  Darwin) pass "macOS ($(sw_vers -productVersion 2>/dev/null || echo '?'))" ;;
  Linux)  pass "Linux ($(uname -r))" ;;
  *)      fail "Unsupported OS '$OS'. On Windows, install WSL2 (Ubuntu) and run this inside it."
          eligible=0 ;;
esac

# --- 2. Accelerator (Apple Silicon → NVIDIA → CPU) -----------------------------
ram_gb="$(detect_ram_gb)"
vram_gb="$(detect_vram_gb)"
accel_kind="cpu"; accel_name="CPU"; accel_gb=$(( ram_gb * 7 / 10 ))

if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  # Apple Silicon: unified memory IS the GPU memory.
  accel_kind="apple"
  accel_name="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'Apple Silicon')"
  accel_gb=$ram_gb
  pass "$accel_name — Apple Silicon (${ram_gb} GB unified memory)"
elif (( vram_gb > 0 )); then
  # NVIDIA on macOS/Linux: bounded by VRAM, not system RAM.
  accel_kind="nvidia"
  accel_name="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
  accel_gb=$vram_gb
  pass "${accel_name:-NVIDIA GPU} — ${vram_gb} GB VRAM"
else
  # No supported GPU. Allowed (permissionless), but slow and low-demand — not a hard block.
  warn "No supported GPU detected — CPU-only. You can join, but inference is slow and demand limited."
fi

# --- 3. Usable accelerator memory (soft floor) ---------------------------------
if (( accel_gb >= MIN_ACCEL_GB )); then
  pass "${accel_gb} GB usable accelerator memory"
else
  warn "${accel_gb} GB usable accelerator memory — very tight; tiny models only, limited demand."
fi

# --- 4. Pick the model this machine should serve -------------------------------
IFS='|' read -r model_tag model_label model_gb <<<"$(recommend_model "$accel_gb")"
need_disk_gb=$(( model_gb + DISK_HEADROOM_GB ))

# --- 5. Disk -------------------------------------------------------------------
free_disk_gb="$(detect_free_disk_gb)"
if [ -n "${free_disk_gb:-}" ] && (( free_disk_gb >= need_disk_gb )); then
  pass "${free_disk_gb} GB free disk (need ~${need_disk_gb} GB for $model_tag)"
else
  fail "${free_disk_gb:-?} GB free disk — need ~${need_disk_gb} GB for $model_tag (free up space, then re-run)."
  eligible=0
fi

# --- 6. Inference engine (managed by Koretex) ---------------------------------
pass "Inference engine: downloaded + managed automatically (no manual Ollama setup needed)"

hr

# --- Verdict -------------------------------------------------------------------
if (( eligible == 1 )); then
  printf "${GRN}${BOLD}You can participate.${RST}\n\n"
  printf "  Accelerator:       ${BOLD}%s${RST} (%s, ${BOLD}%s GB${RST} usable)\n" "$accel_name" "$accel_kind" "$accel_gb"
  printf "  Recommended model: ${BOLD}%s${RST}\n" "$model_tag"
  printf "  ${DIM}%s${RST}\n" "$model_label"

  # Best-effort: list every catalog model this machine can actually run (filtered by accel memory).
  models="$(curl -fsS "$DISPATCHER/models/catalog?format=text&accel=$accel_gb&disk=$free_disk_gb" 2>/dev/null || true)"
  if [ -n "$models" ]; then
    printf "\n  Models this machine can run (you'll choose during install):\n"
    printf '%s\n' "$models" | while IFS='|' read -r tag name size type _; do
      [ -n "$tag" ] && printf "    • %-26s ${DIM}[%s]  (%s, ~%sGB)${RST}\n" "$name" "${type:-text}" "$tag" "$size"
    done
  fi

  printf "\n  Next: run the one-command installer to start serving and earning.\n"
  exit 0
else
  printf "${RED}${BOLD}This machine can't join the network yet.${RST}\n"
  printf "  See the ${RED}✗${RST} items above — fix those and re-run this check.\n"
  exit 1
fi
