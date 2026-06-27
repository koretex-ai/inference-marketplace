#!/usr/bin/env bash
# Provider eligibility preflight (P0). Read-only — installs nothing, changes nothing.
# Tells a prospective provider whether this Mac can join the network and which model to serve.
#
# Usage:
#   ./deploy/preflight.sh
#   curl -fsSL https://get.koretex.ai/preflight | bash      # (eventual hosted form)
#
# Exit code: 0 = can participate, 1 = cannot (reason printed).
set -euo pipefail

# --- Minimum spec --------------------------------------------------------------
MIN_RAM_GB=16        # below this: small models only, little demand
MIN_MACOS_MAJOR=13   # Ventura+ (Ollama + current model support)
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

# Recommend a model for a given amount of unified memory (GB).
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

# --- 1. macOS ------------------------------------------------------------------
if [ "$(uname -s)" != "Darwin" ]; then
  fail "Not macOS. The provider agent runs on macOS only."
  eligible=0
else
  macos_ver="$(sw_vers -productVersion)"
  macos_major="${macos_ver%%.*}"
  if (( macos_major >= MIN_MACOS_MAJOR )); then
    pass "macOS $macos_ver"
  else
    fail "macOS $macos_ver — need $MIN_MACOS_MAJOR or newer (please update macOS)."
    eligible=0
  fi
fi

# --- 2. Apple Silicon ----------------------------------------------------------
# hw.optional.arm64 = 1 on Apple Silicon even when the shell runs under Rosetta.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  chip="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'Apple Silicon')"
  pass "$chip"
else
  fail "Not Apple Silicon (Intel Macs aren't supported — no unified-memory GPU inference)."
  eligible=0
fi

# --- 3. Memory -----------------------------------------------------------------
ram_gb=0
if mem_bytes="$(sysctl -n hw.memsize 2>/dev/null)"; then
  ram_gb=$(( mem_bytes / 1073741824 ))
  if (( ram_gb >= MIN_RAM_GB )); then
    pass "${ram_gb} GB unified memory"
  else
    warn "${ram_gb} GB unified memory — below the ${MIN_RAM_GB} GB sweet spot; small models only, limited demand."
    # Not a hard block: tiny models can still serve.
  fi
fi

# --- 4. Pick the model this Mac should serve -----------------------------------
IFS='|' read -r model_tag model_label model_gb <<<"$(recommend_model "$ram_gb")"
need_disk_gb=$(( model_gb + DISK_HEADROOM_GB ))

# --- 5. Disk -------------------------------------------------------------------
# Models live under ~/.ollama; check the volume backing $HOME.
free_disk_gb="$(df -g "$HOME" 2>/dev/null | tail -1 | awk '{print $4}')"
if [ -n "${free_disk_gb:-}" ] && (( free_disk_gb >= need_disk_gb )); then
  pass "${free_disk_gb} GB free disk (need ~${need_disk_gb} GB for $model_tag)"
else
  fail "${free_disk_gb:-?} GB free disk — need ~${need_disk_gb} GB for $model_tag (free up space, then re-run)."
  eligible=0
fi

# --- 6. Inference engine (managed by Koretex) ---------------------------------
pass "Inference engine: downloaded + managed automatically (no Ollama setup needed)"

hr

# --- Verdict -------------------------------------------------------------------
if (( eligible == 1 )); then
  printf "${GRN}${BOLD}You can participate.${RST}\n\n"
  printf "  Recommended model: ${BOLD}%s${RST}\n" "$model_tag"
  printf "  ${DIM}%s${RST}\n" "$model_label"

  # Best-effort: list every catalog model this Mac can actually run (chosen during install).
  models="$(curl -fsS "$DISPATCHER/models/catalog?format=text&ram=$ram_gb&disk=$free_disk_gb" 2>/dev/null || true)"
  if [ -n "$models" ]; then
    printf "\n  Models this Mac can run (you'll choose during install):\n"
    printf '%s\n' "$models" | while IFS='|' read -r tag name size type; do
      [ -n "$tag" ] && printf "    • %-26s ${DIM}[%s]  (%s, ~%sGB)${RST}\n" "$name" "${type:-text}" "$tag" "$size"
    done
  fi

  printf "\n  Next: run the one-command installer to start serving and earning.\n"
  exit 0
else
  printf "${RED}${BOLD}This Mac can't join the network yet.${RST}\n"
  printf "  See the ${RED}✗${RST} items above — fix those and re-run this check.\n"
  exit 1
fi
