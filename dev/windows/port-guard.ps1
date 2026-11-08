<#
  dev/windows/port-guard.ps1 — keep the launcher from dying on EADDRINUSE.

  Symptom this fixes: closing a dsh console window does not free port 3080
  instantly, so relaunching right away made webserver abort with
  "listen EADDRINUSE: address already in use 127.0.0.1:3080". The launcher
  now waits for the old listener to go away instead of racing it, and says
  who still holds the port if it does not.

  Exit codes:
    0  the port is free; boot dsh
    2  the port is still held by something that was not restarted
    3  -Restart was asked for, but the listener is not a dsh process
    4  -Restart killed the listener but the port did not free
    1  the probe itself failed (fail closed: do not boot into a race)

  -Restart only kills a listener whose command line looks like dsh itself
  (node ... dsh ... bin.js). Anything else is left alone and reported.
#>
param(
  [Parameter(Mandatory = $true)][int]$Port,
  [int]$WaitSeconds = 20,
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'

function Get-ListenerPid {
  param([int]$LocalPort)
  $conn = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $conn) { return $null }
  return [int]$conn.OwningProcess
}

function Wait-PortFree {
  param([int]$LocalPort, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if ($null -eq (Get-ListenerPid -LocalPort $LocalPort)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return ($null -eq (Get-ListenerPid -LocalPort $LocalPort))
}

function Get-ProcessLabel {
  param([int]$ProcessId)
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $p) { return "PID $ProcessId" }
  $cmd = $p.CommandLine
  if ([string]::IsNullOrWhiteSpace($cmd)) { $cmd = $p.Name }
  return "PID $ProcessId ($cmd)"
}

function Test-IsDsh {
  param([int]$ProcessId)
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $p -or [string]::IsNullOrWhiteSpace($p.CommandLine)) { return $false }
  return ($p.CommandLine -match 'dsh' -and $p.CommandLine -match 'bin\.js')
}

try {
  $listener = Get-ListenerPid -LocalPort $Port
  if ($null -eq $listener) { exit 0 }

  # A console that was just closed takes a moment to release the port.
  Write-Host "[dsh-bot] port $Port is still held; waiting up to $WaitSeconds s for it to free ..."
  if (Wait-PortFree -LocalPort $Port -Seconds $WaitSeconds) {
    Write-Host "[dsh-bot] port $Port is free"
    exit 0
  }

  $label = Get-ProcessLabel -ProcessId $listener
  if (-not $Restart) {
    [Console]::Error.WriteLine("[dsh-bot] port $Port is still in use by $label")
    [Console]::Error.WriteLine("[dsh-bot] close that window, or run dsh-bot.bat with -Restart to replace it.")
    exit 2
  }

  if (-not (Test-IsDsh -ProcessId $listener)) {
    [Console]::Error.WriteLine("[dsh-bot] -Restart refused: port $Port is held by $label")
    [Console]::Error.WriteLine("[dsh-bot] that is not a dsh process; stop it yourself and relaunch.")
    exit 3
  }

  Write-Host "[dsh-bot] -Restart: stopping previous dsh, $label"
  taskkill /PID $listener /T /F | Out-Null
  if (-not (Wait-PortFree -LocalPort $Port -Seconds 15)) {
    $still = Get-ListenerPid -LocalPort $Port
    [Console]::Error.WriteLine("[dsh-bot] port $Port did not free after stopping $label (now: $(Get-ProcessLabel -ProcessId $still))")
    exit 4
  }
  Write-Host "[dsh-bot] previous dsh stopped; port $Port is free"
  exit 0
} catch {
  [Console]::Error.WriteLine("[dsh-bot] port probe failed: $($_.Exception.Message)")
  exit 1
}
