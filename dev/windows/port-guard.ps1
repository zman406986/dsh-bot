<#
  dev/windows/port-guard.ps1 — keep exactly one dsh, and the launcher's window.

  Symptom this fixes: closing a dsh console window does not free port 3080
  instantly, so relaunching right away made webserver abort with
  "listen EADDRINUSE: address already in use 127.0.0.1:3080". There was also
  a second window every time: the new launch refused, or the old dsh was
  killed by hand and its paused launcher window stayed open.

  Default behaviour: if a dsh is already listening, stop it (and the launcher
  window it belongs to) and let this launch boot the fresh build. -Keep
  leaves it alone and closes this launch instead.

  Exit codes:
    0  the port is free; boot dsh
    5  -Keep was passed and a dsh is already serving; do not boot
    3  the port is held by something that is not dsh; refuse to touch it
    4  the old listener was stopped but the port did not free
    1  the probe itself failed (fail closed: do not boot into a race)

  Only a listener whose command line looks like dsh (node ... dsh ... bin.js)
  is stopped. When that dsh was started by this launcher, the owning cmd.exe
  window is closed too, so no paused window is left behind.
#>
param(
  [Parameter(Mandatory = $true)][int]$Port,
  [int]$WaitSeconds = 15,
  [switch]$Keep
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
    Start-Sleep -Milliseconds 400
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

# The cmd.exe that ran dsh-bot.bat owns the console window. Killing the node
# child alone leaves that window paused on "dsh exited with code 1", which is
# the second window. Only a `cmd /c ...dsh-bot...` ancestor is eligible: the
# /c test keeps an interactive terminal the owner happens to be typing in
# from being closed.
function Get-LauncherAncestor {
  param([int]$ProcessId)
  $found = $null
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  $depth = 0
  while ($null -ne $p -and $depth -lt 12) {
    $parentId = [int]$p.ParentProcessId
    if ($parentId -eq 0) { break }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
    if ($null -eq $parent) { break }
    if ($parent.Name -ieq 'cmd.exe' -and
        $parent.CommandLine -match 'dsh-bot' -and
        $parent.CommandLine -match '/c') {
      $found = $parent
    }
    $p = $parent
    $depth += 1
  }
  return $found
}

try {
  $listener = Get-ListenerPid -LocalPort $Port
  if ($null -eq $listener) { exit 0 }

  $label = Get-ProcessLabel -ProcessId $listener

  if ($Keep) {
    Write-Host "[dsh-bot] dsh is already serving on port $Port, $label"
    Write-Host "[dsh-bot] -Keep: leaving it running and closing this launch"
    exit 5
  }

  if (-not (Test-IsDsh -ProcessId $listener)) {
    [Console]::Error.WriteLine("[dsh-bot] port $Port is held by $label")
    [Console]::Error.WriteLine("[dsh-bot] that is not a dsh process; stop it yourself and relaunch.")
    exit 3
  }

  $ancestor = Get-LauncherAncestor -ProcessId $listener
  if ($null -ne $ancestor) {
    Write-Host "[dsh-bot] replacing the running dsh and closing its window, $label"
    taskkill /PID $ancestor.ProcessId /T /F | Out-Null
  } else {
    Write-Host "[dsh-bot] replacing the running dsh, $label"
    taskkill /PID $listener /T /F | Out-Null
  }

  if (-not (Wait-PortFree -LocalPort $Port -Seconds $WaitSeconds)) {
    $still = Get-ListenerPid -LocalPort $Port
    [Console]::Error.WriteLine("[dsh-bot] port $Port did not free after stopping $label (now: $(Get-ProcessLabel -ProcessId $still))")
    exit 4
  }
  Write-Host "[dsh-bot] port $Port is free"
  exit 0
} catch {
  [Console]::Error.WriteLine("[dsh-bot] port probe failed: $($_.Exception.Message)")
  exit 1
}
