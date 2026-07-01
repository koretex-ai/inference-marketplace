# koretex-status.ps1 — show whether this Windows machine is serving, what it earns, and its balance.
# Read-only. Native-Windows counterpart to koretex-status.sh. Prints a human summary + a JSON block.

$ErrorActionPreference = "SilentlyContinue"

$DISPATCHER = $env:KORETEX_DISPATCHER; if ([string]::IsNullOrEmpty($DISPATCHER)) { $DISPATCHER = "https://dispatcher.koretex.ai" }
$DISPATCHER = $DISPATCHER.TrimEnd("/")
$KDIR = Join-Path $env:USERPROFILE ".koretex"
$AGENT = Join-Path $KDIR "koretex-agent.cjs"
$env:ENGINE_URL = "http://127.0.0.1:11435"
$env:KORETEX_DISPATCHER = $DISPATCHER

function Invoke-Kx { & node $AGENT @args }

if (-not (Test-Path $AGENT)) {
  Write-Host "Koretex node is NOT installed on this machine. Run koretex-up.ps1 first."
  return
}

Invoke-Kx status
Write-Host ""
Write-Host "Credit balance (signed query for this machine's wallet):"
Invoke-Kx balance
Write-Host ""
Write-Host "Dashboard: $DISPATCHER/dashboard"

$address = $null
$customerPath = Join-Path $KDIR "customer.json"
if (Test-Path $customerPath) { $address = (Get-Content $customerPath -Raw | ConvertFrom-Json).address }
$bal = $null
try { $bal = (Invoke-Kx balance --json) | Out-String | ConvertFrom-Json } catch {}

$out = [ordered]@{
  address        = if ($address) { $address } elseif ($bal) { $bal.address } else { $null }
  balanceCredits = if ($bal) { $bal.balance } else { $null }
  balanceUsd     = if ($bal) { $bal.usd } else { $null }
  dashboard      = "$DISPATCHER/dashboard"
}
Write-Host "===KORETEX-JSON==="
($out | ConvertTo-Json)
Write-Host "===KORETEX-JSON==="
