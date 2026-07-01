# koretex-up.ps1 — bring this Windows machine up as a Koretex provider node, unattended + idempotent.
# Native-Windows counterpart to koretex-up.sh: no WSL. Because the node runs natively on Windows,
# Hermes (native Windows) and the node share one environment, so this script both installs the node
# AND wires Hermes to consume through Koretex — no key bridge.
#
# Safe to run every time. It will:
#   1. install the Koretex node (engine + agent + auto-start task) if it isn't already,
#   2. enroll a self-custody wallet (mints a node token to EARN + a customer key to SPEND),
#   3. pick & serve the highest-demand model this machine can host,
#   4. print a JSON summary (between ===KORETEX-JSON=== markers) for the caller,
#   5. if Hermes is present, wire it to consume through Koretex via `hermes config set`.
# It NEVER prints the customer API key — only the path to the file that holds it.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$DISPATCHER = $env:KORETEX_DISPATCHER; if ([string]::IsNullOrEmpty($DISPATCHER)) { $DISPATCHER = "https://dispatcher.koretex.ai" }
$DISPATCHER = $DISPATCHER.TrimEnd("/")
$KDIR = Join-Path $env:USERPROFILE ".koretex"
$AGENT = Join-Path $KDIR "koretex-agent.cjs"
$ENGINE_URL = "http://127.0.0.1:11435"
$env:ENGINE_URL = $ENGINE_URL
$env:KORETEX_DISPATCHER = $DISPATCHER

function Invoke-Kx { & node $AGENT @args }

Write-Host "> Koretex provider setup (dispatcher: $DISPATCHER)"

if (-not (Test-Path $AGENT)) {
  Write-Host "> Node not installed - running the native Windows installer (headless, self-custody)..."
  # KORETEX_ENROLL forces the self-custody wallet path; KORETEX_AUTOSERVE lets the installer pick the
  # best-fitting, highest-demand model; SKIP_MODEL avoids a throwaway pull before autoserve picks.
  $env:KORETEX_ENROLL = "1"; $env:KORETEX_AUTOSERVE = "1"; $env:SKIP_MODEL = "1"; $env:DISPATCHER = $DISPATCHER
  Invoke-Expression (Invoke-WebRequest -Uri "$DISPATCHER/install.ps1" -UseBasicParsing).Content
} else {
  Write-Host "> Node already installed - ensuring it's enrolled, serving, and running..."
  try { Invoke-Kx enroll | Out-Null } catch {}
  try { Invoke-Kx autoserve } catch {}
  try { Invoke-Kx start } catch {}
}

# Gather everything the caller needs to point its own inference at Koretex.
$rec = $null
try { $rec = (Invoke-Kx recommend --json) | Out-String | ConvertFrom-Json } catch {}
$address = $null
$customerPath = Join-Path $KDIR "customer.json"
if (Test-Path $customerPath) { try { $address = (Get-Content $customerPath -Raw | ConvertFrom-Json).address } catch {} }

# Precompute values (PowerShell `if` is only usable as an expression in a standalone assignment,
# not inline inside a bigger expression).
$openaiBase   = if ($rec -and $rec.openaiBase) { $rec.openaiBase } else { "$DISPATCHER/v1" }
$engineBase   = if ($rec -and $rec.engineUrl)  { $rec.engineUrl }  else { $ENGINE_URL }
$dispBase     = if ($rec -and $rec.dispatcher) { $rec.dispatcher } else { $DISPATCHER }
$consumeModel = if ($rec) { $rec.consume }     else { $null }
$consumeName  = if ($rec) { $rec.consumeName } else { $null }
$localModel   = if ($rec) { $rec.local }       else { $null }
$out = [ordered]@{
  address         = $address
  customerKeyPath = $customerPath          # read the sk-cust-... key from here (do not log it)
  openaiBase      = $openaiBase            # Koretex OpenAI-compatible endpoint (primary)
  localBase       = "$engineBase/v1"       # local engine (free fallback)
  consumeModel    = $consumeModel          # best network model to use for our own inference
  consumeName     = $consumeName
  localModel      = $localModel            # model THIS machine serves
  dashboard       = "$dispBase/dashboard"
}
Write-Host "===KORETEX-JSON==="
($out | ConvertTo-Json)
Write-Host "===KORETEX-JSON==="

# If this machine runs Hermes Agent, wire it to consume inference through Koretex - DETERMINISTICALLY
# and via the sanctioned path. Hermes blocks agents from editing its main config file directly, so we
# use `hermes config set` (+ append the key to Hermes's env file, which is not guarded). We set a 64K
# context window because Hermes refuses models that report less.
if (Get-Command hermes -ErrorAction SilentlyContinue) {
  $key = $null; if (Test-Path $customerPath) { try { $key = (Get-Content $customerPath -Raw | ConvertFrom-Json).key } catch {} }
  $consume = if ($rec) { $rec.consume } else { $null }
  if ($key -and $consume) {
    # Resolve the env file Hermes ACTUALLY reads. On Windows that's %LOCALAPPDATA%\hermes\.env, NOT
    # ~/.hermes\.env — so ask Hermes rather than hardcoding. Fall back to ~/.hermes\.env if unavailable.
    $envFile = $null
    try { $envFile = (hermes config env-path 2>$null | Select-Object -First 1).Trim() } catch {}
    if ([string]::IsNullOrWhiteSpace($envFile)) { $envFile = Join-Path (Join-Path $env:USERPROFILE ".hermes") ".env" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $envFile) | Out-Null
    if (Test-Path $envFile) { (Get-Content $envFile) | Where-Object { $_ -notmatch '^KORETEX_API_KEY=' } | Set-Content $envFile }
    Add-Content -Path $envFile -Value "KORETEX_API_KEY=$key"
    hermes config set model.provider custom        2>$null | Out-Null
    hermes config set model.base_url $openaiBase   2>$null | Out-Null
    hermes config set model.default $consume       2>$null | Out-Null
    hermes config set model.api_key_env KORETEX_API_KEY 2>$null | Out-Null
    # Hermes prefers a LITERAL model.api_key over api_key_env, so a stale literal (e.g. from a prior
    # Google-login setup) would keep spending the old wallet. Overwrite it with THIS node's spend key.
    hermes config set model.api_key $key           2>$null | Out-Null
    hermes config set model.context_length 65536   2>$null | Out-Null
    # Generous OUTPUT cap so reasoning models don't get truncated and stuck in Hermes's continuation loop.
    hermes config set model.max_tokens 16384       2>$null | Out-Null
    Write-Host "> Wired Hermes -> Koretex (consume model: $consume)."
    Write-Host "  Restart Hermes (fully quit + relaunch) to load the new provider - /new alone won't."
  } else {
    Write-Host "> (Hermes detected, but no customer key or served network model yet - skipping auto-wire.)"
  }
}

Write-Host "> Credit balance:"
try { Invoke-Kx balance } catch { Write-Host "  (run 'koretex balance' once the node is up)" }
Write-Host "> Done. This machine is earning while idle and (if Hermes is present) spending via Koretex."
