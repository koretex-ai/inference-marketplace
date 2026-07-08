# One-command Koretex provider install for NATIVE Windows (no WSL). Run in PowerShell:
#   irm https://dispatcher.koretex.ai/install.ps1 | iex
# or, with options (self-custody + auto-pick model), e.g. from the Hermes provider skill:
#   $env:KORETEX_ENROLL=1; $env:KORETEX_AUTOSERVE=1; irm https://dispatcher.koretex.ai/install.ps1 | iex
#
# NVIDIA-first: runs the pinned Ollama Windows build with CUDA. This is the Windows-native counterpart
# to deploy/install.sh (macOS/Linux) — same engine version, same dispatcher endpoints, same self-custody
# enroll + autoserve flow. Node agent + Ollama both run natively on Windows, so Hermes (native Windows)
# and the node share one environment — no WSL, no key bridge. Re-running is safe (idempotent).
#
# Env knobs (all optional): DISPATCHER, KORETEX_ENROLL, KORETEX_AUTOSERVE, KORETEX_MODEL, SKIP_MODEL,
# KORETEX_TOKEN, KORETEX_WALLET, KORETEX_CONTEXT_LENGTH, KORETEX_BACKEND, KORETEX_ENGINE_SHA256.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is far faster without the progress bar
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

function Get-EnvOr($name, $default) { $v = [Environment]::GetEnvironmentVariable($name); if ([string]::IsNullOrEmpty($v)) { $default } else { $v } }
function Write-Step($msg) { Write-Host ""; Write-Host $msg -ForegroundColor White }

# --- Config -------------------------------------------------------------------
$DISPATCHER = (Get-EnvOr "DISPATCHER" "https://dispatcher.koretex.ai").TrimEnd("/")
$WS = $DISPATCHER -replace '^https:', 'wss:' -replace '^http:', 'ws:'
$UserHome = $env:USERPROFILE
$KDIR = Join-Path $UserHome ".koretex"
$AGENT = Join-Path $KDIR "koretex-agent.cjs"
$ENGINE_DIR = Join-Path $KDIR "engine"
$BIN_DIR = Join-Path $KDIR "bin"

$OLLAMA_VERSION = "0.30.10"
$OLLAMA_ADDR = "127.0.0.1:11435"                       # off the default 11434 to avoid any system Ollama
$ENGINE_URL = "http://$OLLAMA_ADDR"
$OLLAMA_ASSET = "ollama-windows-amd64.zip"
# Pinned SHA256 of the Windows amd64 (CUDA) build v0.30.10, from the GitHub release asset digest.
$OLLAMA_SHA256 = (Get-EnvOr "KORETEX_ENGINE_SHA256" "9606cee7501703a0969682667def313130f99ed73f44a88a7a8efe82d4b565f0")
$OLLAMA_URL = "https://github.com/ollama/ollama/releases/download/v$OLLAMA_VERSION/$OLLAMA_ASSET"

$TASK_ENGINE = "KoretexOllama"
$TASK_AGENT = "KoretexNodeAgent"

# --- 1. Platform + accelerator detection --------------------------------------
Write-Step "1/5  Checking this machine..."
$ramGb = 0
try { $ramGb = [math]::Floor((Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory / 1GB) } catch {}
$vramGb = 0
$gpuName = $null
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  try {
    $mib = (& nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null | ForEach-Object { [int]($_.Trim()) } | Measure-Object -Sum).Sum
    $vramGb = [math]::Floor([int]$mib / 1024)
    $gpuName = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1)
  } catch {}
}
if ($vramGb -gt 0) { $accelKind = "nvidia"; $accelGb = $vramGb; $backendDefault = "cuda" }
else               { $accelKind = "cpu";    $accelGb = [math]::Floor($ramGb * 0.7); $backendDefault = "cpu" }
$backend = Get-EnvOr "KORETEX_BACKEND" $backendDefault

# Free disk on the volume backing the user profile.
$freeGb = 0
try { $drive = (Get-Item $UserHome).PSDrive.Name; $freeGb = [math]::Floor((Get-PSDrive $drive).Free / 1GB) } catch {}

if ($accelKind -eq "nvidia") { Write-Host "  Detected: $($gpuName) - $vramGb GB VRAM (CUDA), $freeGb GB free disk" -ForegroundColor Green }
else { Write-Host "  ! No NVIDIA GPU detected - CPU-only. You can join, but inference is slow and demand limited." -ForegroundColor Yellow }
if ($accelGb -lt 8) { Write-Host "  ! Only ~$accelGb GB usable accelerator memory - tiny models only, limited demand." -ForegroundColor Yellow }
if ($freeGb -lt 20) { Write-Host "  x Low free disk (~$freeGb GB). Models need room; free up space if a pull fails." -ForegroundColor Yellow }

# --- 2. Node.js (the agent runs on it; the engine is managed below) -----------
Write-Step "2/5  Node.js..."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "  Installing Node.js LTS via winget..."
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    # winget updates the machine PATH; refresh this session so `node` resolves now.
    $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
  }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "  This machine needs Node.js 20+ first (free). Install it, then re-run this installer:" -ForegroundColor Yellow
  Write-Host "    Node.js  ->  https://nodejs.org  (download the Windows LTS installer, run it)"
  Write-Host "  Then re-run:  irm $DISPATCHER/install.ps1 | iex"
  return
}
$NodeBin = (Get-Command node).Source
Write-Host "  OK Node $(node -v)  (the inference engine is managed by Koretex - nothing else to install)" -ForegroundColor Green

# --- 3. Managed inference engine + model --------------------------------------
Write-Step "3/5  Setting up the inference engine..."
New-Item -ItemType Directory -Force -Path $KDIR, $ENGINE_DIR, $BIN_DIR | Out-Null

# Discover ollama.exe under the engine dir (extraction layout can vary between releases).
function Find-OllamaBin { Get-ChildItem -Path $ENGINE_DIR -Recurse -Filter "ollama.exe" -ErrorAction SilentlyContinue | Sort-Object { $_.FullName.Length } | Select-Object -First 1 -ExpandProperty FullName }
$OllamaBin = Find-OllamaBin
if (-not $OllamaBin) {
  $archive = Join-Path $KDIR "engine-download.zip"
  Write-Host "  Downloading the Koretex engine ($OLLAMA_ASSET, ~1.4GB, first time only)..."
  Invoke-WebRequest -Uri $OLLAMA_URL -OutFile $archive -UseBasicParsing
  $got = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLower()
  if ($got -ne $OLLAMA_SHA256.ToLower()) {
    Remove-Item $archive -Force -ErrorAction SilentlyContinue
    Write-Host "  x engine checksum mismatch - aborting for safety." -ForegroundColor Red
    Write-Host "    expected $OLLAMA_SHA256"
    Write-Host "    got      $got"
    throw "engine checksum mismatch"
  }
  Write-Host "  Unpacking..."
  Expand-Archive -Path $archive -DestinationPath $ENGINE_DIR -Force
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  $OllamaBin = Find-OllamaBin
}
if (-not $OllamaBin) { throw "engine binary (ollama.exe) not found under $ENGINE_DIR after extract." }

# Context window scaled to accelerator memory (KV cache is preallocated to this). Models cap it at
# their own native max; KORETEX_CONTEXT_LENGTH overrides.
$ctxLen = Get-EnvOr "KORETEX_CONTEXT_LENGTH" $null
if (-not $ctxLen) {
  if     ($accelGb -ge 64) { $ctxLen = 65536 }
  elseif ($accelGb -ge 32) { $ctxLen = 32768 }
  else                     { $ctxLen = 16384 }
}

# Launcher .cmd files bake in the env (Scheduled Task actions can't set env vars cleanly).
$engineCmd = Join-Path $KDIR "engine-run.cmd"
@"
@echo off
set "OLLAMA_HOST=$OLLAMA_ADDR"
set "OLLAMA_CONTEXT_LENGTH=$ctxLen"
"$OllamaBin" serve
"@ | Set-Content -Path $engineCmd -Encoding ASCII

$agentCmd = Join-Path $KDIR "agent-run.cmd"
@"
@echo off
set "DISPATCHER_URL=$WS"
set "ENGINE_URL=$ENGINE_URL"
set "KORETEX_BACKEND=$backend"
"$NodeBin" "$AGENT"
"@ | Set-Content -Path $agentCmd -Encoding ASCII

# Register (or refresh) an at-logon, restart-on-failure Scheduled Task; fall back to the Startup folder
# if task registration is denied (non-elevated). Returns $true if a Scheduled Task was used.
function Register-KoretexTask($taskName, $cmdPath) {
  try {
    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$cmdPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force -ErrorAction Stop | Out-Null
    return $true
  } catch { return $false }
}

# Startup-folder fallback: a .vbs that launches the .cmd hidden (no admin, survives reboot after logon).
function Install-StartupFallback($name, $cmdPath) {
  $startup = [Environment]::GetFolderPath("Startup")
  $vbs = Join-Path $startup "$name.vbs"
  "CreateObject(""WScript.Shell"").Run """"""$cmdPath"""""", 0, False" | Set-Content -Path $vbs -Encoding ASCII
}

# --- start the engine, wait for it, pull a model ---
$engineTask = Register-KoretexTask $TASK_ENGINE $engineCmd
if ($engineTask) { Start-ScheduledTask -TaskName $TASK_ENGINE -ErrorAction SilentlyContinue }
else { Install-StartupFallback $TASK_ENGINE $engineCmd; Start-Process -FilePath $engineCmd -WindowStyle Hidden }

Write-Host "  Waiting for the engine..."
$up = $false
for ($i = 0; $i -lt 30; $i++) { try { Invoke-WebRequest -Uri "$ENGINE_URL/api/tags" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep -Seconds 1 } }

# Choose a model that fits (server-side filter by accelerator memory + free disk), unless overridden.
$model = Get-EnvOr "KORETEX_MODEL" $null
if (-not $model) {
  try {
    $catalog = (Invoke-WebRequest -Uri "$DISPATCHER/models/catalog?format=text&accel=$accelGb&disk=$freeGb" -UseBasicParsing -TimeoutSec 10).Content
    $first = ($catalog -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
    if ($first) { $model = ($first -split '\|')[0] }
  } catch {}
  if (-not $model) { $model = "gemma3:12b-it-qat" }
}
if ((Get-EnvOr "SKIP_MODEL" "0") -ne "1") {
  if ($up) {
    Write-Host "  Pulling $model (large download - first time only)..."
    $env:OLLAMA_HOST = $OLLAMA_ADDR
    try { & $OllamaBin pull $model } catch { Write-Host "  (pull failed - retry later)" -ForegroundColor Yellow }
  } else {
    Write-Host "  Engine didn't come up in time - check it later with: koretex status" -ForegroundColor Yellow
  }
}

# --- 4. Install the agent + link the wallet -----------------------------------
Write-Step "4/5  Installing the agent and linking your wallet..."
Invoke-WebRequest -Uri "$DISPATCHER/agent.js" -OutFile $AGENT -UseBasicParsing
$env:DISPATCHER_URL = $WS
$env:ENGINE_URL = $ENGINE_URL
$env:KORETEX_DISPATCHER = $DISPATCHER
if (-not [string]::IsNullOrEmpty($env:KORETEX_TOKEN)) {
  "{`"token`":`"$($env:KORETEX_TOKEN)`",`"address`":`"$(Get-EnvOr 'KORETEX_WALLET' '')`"}" | Set-Content -Path (Join-Path $KDIR "node.json") -Encoding ASCII
  Write-Host "  Linked via your website wallet connection."
} elseif ($env:KORETEX_ENROLL -eq '1' -or -not [Environment]::UserInteractive) {
  # Headless (unattended installs / the Hermes provider skill): self-custody enroll - generate a
  # local wallet + mint the node token and a customer key for this machine's own inference.
  # The secret stays in $KDIR\wallet.json.
  Write-Host "  Linking with a self-custody wallet (headless)..."
  & $NodeBin $AGENT enroll
} else {
  # Interactive: scan-to-approve pairing. Prints a QR of the connect link - scan it with the
  # Koretex wallet app (Seeker) or any phone camera, or open the link in a browser, and approve.
  Write-Host "  Link this machine to your wallet - scan the QR below with your phone..."
  & $NodeBin $AGENT pair
}

# --- 5. Auto-start on login ---------------------------------------------------
Write-Step "5/5  Enabling auto-start..."
$agentTask = Register-KoretexTask $TASK_AGENT $agentCmd
if ($agentTask) { Start-ScheduledTask -TaskName $TASK_AGENT -ErrorAction SilentlyContinue }
else { Install-StartupFallback $TASK_AGENT $agentCmd; Start-Process -FilePath $agentCmd -WindowStyle Hidden }

# Optional: let the agent pick the best-fitting, highest-demand model itself (unattended installs / the
# Hermes provider skill). Runs after the agent is up so the pull registers live.
if ((Get-EnvOr "KORETEX_AUTOSERVE" "0") -eq "1") {
  Write-Host "  Auto-selecting the best model to serve..."
  try { & $NodeBin $AGENT autoserve } catch {}
}

# Install a `koretex` convenience command on PATH (a .cmd shim that bakes ENGINE_URL + dispatcher).
$koretexCmd = Join-Path $BIN_DIR "koretex.cmd"
@"
@echo off
set "ENGINE_URL=$ENGINE_URL"
set "KORETEX_DISPATCHER=$DISPATCHER"
"$NodeBin" "$AGENT" %*
"@ | Set-Content -Path $koretexCmd -Encoding ASCII
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BIN_DIR*") {
  [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $BIN_DIR), "User")
  $env:Path = $env:Path + ";" + $BIN_DIR
}

Write-Host ""
Write-Host "DONE - this machine is now a Koretex provider." -ForegroundColor Green
Write-Host "  Accelerator: $accelKind (~$accelGb GB usable).  Earnings go to the wallet you linked."
Write-Host "  Dashboard:   $DISPATCHER/dashboard"
Write-Host ""
Write-Host "  Control your node:  koretex status | koretex stop | koretex start | koretex balance"
if (-not $engineTask -or -not $agentTask) {
  Write-Host "  (Auto-start uses the Startup folder - a Scheduled Task needed admin. It starts on next logon.)" -ForegroundColor Yellow
} else {
  Write-Host "  Auto-starts via a Scheduled Task at logon (restarts on crash). Survives reboot after you log in." -ForegroundColor Green
}
Write-Host "    ↳ Open a NEW terminal for the `koretex` command to be on PATH."
Write-Host ""
