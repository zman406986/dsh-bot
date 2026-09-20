<#
  ============================================================================
   dsh-bot-launcher.ps1  --  dsh web UI launcher
   Logic home since the 2026-09-20 consolidation: the Desktop dsh-bot.bat is
   the single entry point and forwards every argument here.
  ----------------------------------------------------------------------------
   Menu picks which checkout to serve in the browser (dsh opens it itself):

     [1] main checkout        C:\Users\TZhen\Desktop\dsh-bot
         branch main -- the whole product; tracker + research live here

   One live target. Option [2] was removed at ticket 48's closeout
   (2026-09-19): it pointed at C:\Users\TZhen\Desktop\dsh-bot-always-on,
   branch clone/always-on-dispatcher, whose whole 17.27-17.33 batch merged
   into main at 400450f (ticket 33); the worktree and that branch are both
   gone, so the entry could only die at the missing-path throw. Dead entry
   beats stale copy, so it is removed rather than repointed. The freshness
   machinery (Resolve-StaleTarget / -Sync / -AllowStale) is kept and reusable:
   add a row to $targets below to serve another checkout again.

   Any selected target is freshness-checked: a behind-main checkout is
   REFUSED unless you pass -Sync (fast-forward it first) or -AllowStale (serve
   the old tree on purpose). A target carrying unique commits is never
   fast-forwarded; it reports and stops.

   Per launch:
     1. git freshness check -- a stale checkout is refused, never silently
        served (ticket 48: option [2] once built a tree 39 commits behind main,
        which then fails a live pass for reasons long fixed on main)
     2. npm run build + npm run build:client in the chosen checkout
        (skip with -NoBuild when you know lib/ + client/ are current)
     3. boots `dsh --profile web --patch <checkout>\dev\cordis.web.patch.yml`
        in its own console window; dsh serves the UI and opens the default
        browser with the tokenized URL. Closing that window stops the server.
        Since ADR-0021 (2026-09-20) the patched boot serves stock dsh as the
        primary UI plus our additive client module: a "Dispatcher" launcher
        chip in the stock UI opens the floating dispatcher window. No UI
        takeover — the old whole-shell displacement vehicle was retired.
        The overlay is the COMMITTED in-repo file (ticket 43 Requirement 1,
        ticket 48 Requirement 2): its plugin path is relative, so the boot
        layer anchors it to whichever checkout passed it, and the web profile's
        own package tree + cordis.patch.yml are never touched. This is the
        README's "transient overlay" dev route; the dispatcher's shipping home
        stays the dedicated multitask profile with the plugin always-on, no
        flag (ADR-0018, superseding ADR-0005's flag semantics).

   Kill timer (AGENTS.md / ADR-0015: armed at launch, never cleanup-at-end):
     -KillAfterMinutes <n> arms a detached force-kill of the whole server
     process tree. Interactive human launches default to none; every test pass
     must pass the flag.

   Usage (double-click or run C:\Users\TZhen\Desktop\dsh-bot.bat, which
   forwards %* here; or call this file directly):
     powershell -NoProfile -ExecutionPolicy Bypass -File <this file>
     powershell -NoProfile -ExecutionPolicy Bypass -File <this file> -Checkout 1 -Sync
     powershell -NoProfile -ExecutionPolicy Bypass -File <this file> -Checkout 1 -NoBuild -Port 8080
     powershell -NoProfile -ExecutionPolicy Bypass -File <this file> -NoOpen -KillAfterMinutes 45
     powershell -NoProfile -ExecutionPolicy Bypass -File <this file> -DryRun
  ============================================================================
#>
[CmdletBinding()]
param(
    [ValidateSet('1')]
    [string]$Checkout,
    # passthrough for `dsh web --port`; omit for the profile's composed port
    [ValidateRange(0, 65535)]
    [int]$Port = -1,
    [switch]$NoOpen,
    [switch]$NoBuild,
    # fast-forward a clean, 0-ahead, behind-main checkout to main before building
    [switch]$Sync,
    # serve a behind-main checkout as-is (reproducing an old state on purpose)
    [switch]$AllowStale,
    # arm a detached kill timer for the spawned server tree (0 = off)
    [ValidateRange(0, 100000)]
    [int]$KillAfterMinutes = 0,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Add a row to offer another checkout (ticket 48 keeps the freshness machinery
# reusable). Keys are menu/`-Checkout` keys; extend the ValidateSet on
# $Checkout and the menu's valid list if you add one. `Path` must be a working
# checkout with a local `main` to measure against and, to be servable, the
# committed overlay; `Overlay` is relative to `Path`.
$targets = @(
    [pscustomobject]@{
        Key     = '1'
        Name    = 'main'
        Title   = 'dsh web [main]'
        Path    = 'C:\Users\TZhen\Desktop\dsh-bot'
        Overlay = 'dev\cordis.web.patch.yml'
        Note    = 'branch main -- the whole product; tracker + research live here'
    }
)

function Get-GitState([string]$Path) {
    # @() everywhere: a single-line git output is still an array (a bare string
    # would make [0] index the first character).
    $state = [pscustomobject]@{
        Ok      = $false
        Branch  = '(unknown)'
        Detail  = '(no .git!)'
        Dirty   = 0
        Ahead   = 0
        Behind  = 0
        HasMain = $false
    }
    if (-not (Test-Path (Join-Path $Path '.git'))) { return $state }

    $branch = @(& git -C $Path rev-parse --abbrev-ref HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $branch) {
        $state.Detail = '(git rev-parse failed)'
        return $state
    }
    $state.Branch = [string]$branch[0]
    $state.Ok = $true

    $porcelain = @(& git -C $Path status --porcelain 2>$null)
    $state.Dirty = $porcelain.Count

    # Ahead/behind against main: rev-list --left-right --count main...HEAD
    # prints "<left> <right>" = "<in main only> <in HEAD only>".
    $hasMain = @(& git -C $Path rev-parse --verify --quiet main 2>$null)
    if ($LASTEXITCODE -eq 0 -and $hasMain) {
        $state.HasMain = $true
        $counts = @(& git -C $Path rev-list --left-right --count 'main...HEAD' 2>$null)
        if ($LASTEXITCODE -eq 0 -and $counts) {
            $parts = ([string]$counts[0]) -split '\s+'
            if ($parts.Count -ge 2) {
                $state.Behind = [int]$parts[0]
                $state.Ahead = [int]$parts[1]
            }
        }
    }
    return $state
}

function Format-GitState($state) {
    if (-not $state.Ok) { return $state.Detail }
    $out = $state.Branch
    if ($state.Dirty -gt 0) { $out += ", $($state.Dirty) dirty" } else { $out += ', clean' }
    if ($state.HasMain) {
        if ($state.Ahead -eq 0 -and $state.Behind -eq 0) {
            $out += ', = main'
        } else {
            if ($state.Ahead -gt 0) { $out += ", $($state.Ahead) ahead of main" }
            if ($state.Behind -gt 0) { $out += ", $($state.Behind) behind main" }
        }
    }
    return $out
}

function Show-Menu {
    Write-Host ''
    Write-Host '  dsh-bot launcher' -ForegroundColor Cyan
    Write-Host '  ----------------'
    foreach ($t in $targets) {
        $state = Get-GitState $t.Path
        Write-Host ("   [{0}] {1,-19} {2}" -f $t.Key, $t.Name, $t.Path)
        $colour = 'DarkGray'
        if ($state.Behind -gt 0) { $colour = 'Yellow' }
        Write-Host ("        {0}" -f (Format-GitState $state)) -ForegroundColor $colour
        Write-Host ("        {0}" -f $t.Note) -ForegroundColor DarkGray
    }
    Write-Host '   [0] exit'
}

function Get-MenuAnswer([string]$Prompt, [string[]]$Valid, [string]$Default) {
    while ($true) {
        $answer = Read-Host $Prompt
        if (-not $answer -and $Default) { return $Default }
        if ($Valid -contains $answer) { return $answer }
        Write-Host "   ? answer one of: $($Valid -join ', ')" -ForegroundColor Yellow
    }
}

function Resolve-StaleTarget([object]$t, [bool]$Interactive) {
    $state = Get-GitState $t.Path
    if (-not $state.Ok) { throw "cannot read git state for $($t.Path): $($state.Detail)" }

    if ($state.Behind -le 0) {
        if ($state.Ahead -gt 0) {
            Write-Host "   note: $($state.Ahead) commit(s) here are not in main (local work, left untouched)" -ForegroundColor DarkGray
        }
        return
    }

    Write-Host ("   STALE: {0} is {1} commit(s) behind main ({2} ahead of it)." -f $t.Name, $state.Behind, $state.Ahead) -ForegroundColor Yellow

    if ($state.Ahead -gt 0) {
        throw "refusing to serve $($t.Path): it carries $($state.Ahead) commit(s) not in main, so a fast-forward would drop work. Merge or rebase it deliberately, or pass -AllowStale to serve it as-is."
    }
    if ($state.Dirty -gt 0) {
        throw "refusing to serve $($t.Path): $($state.Behind) behind main with $($state.Dirty) uncommitted change(s), so it cannot be fast-forwarded. Commit or stash, then re-run with -Sync; or pass -AllowStale to serve it as-is."
    }

    $doSync = [bool]$Sync
    if (-not $doSync -and -not $AllowStale -and $Interactive) {
        $answer = Get-MenuAnswer '  fast-forward it to main now? [Y/n]' @('Y','y','N','n','') 'Y'
        if ($answer -eq 'Y' -or $answer -eq 'y' -or $answer -eq '') { $doSync = $true }
    }

    if (-not $doSync) {
        if ($AllowStale) {
            Write-Host "   -AllowStale: serving the old tree on purpose ($($state.Behind) behind main)" -ForegroundColor Yellow
            return
        }
        throw "refusing to serve a stale checkout. Re-run with -Sync to fast-forward $($t.Path) to main, or -AllowStale to serve it as-is."
    }

    Write-Host '   syncing: git merge --ff-only main'
    $out = @(& git -C $t.Path merge --ff-only main 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $out | Select-Object -Last 10 | Write-Host
        throw "fast-forward failed in $($t.Path); the launcher made no other change"
    }
    $out | ForEach-Object { Write-Host "     $_" -ForegroundColor DarkGray }
    Write-Host ("   now: {0}" -f (Format-GitState (Get-GitState $t.Path))) -ForegroundColor Green
}

function Get-OverlayPath([object]$t) {
    $path = Join-Path $t.Path $t.Overlay
    if (-not (Test-Path $path)) {
        throw "overlay missing: $path -- it is committed in the repo (dev/cordis.web.patch.yml). A checkout without it predates ticket 48 and cannot be served through this route."
    }
    return $path
}

function Build-Checkout([string]$Path, [string]$Name) {
    if ($NoBuild) { Write-Host '   build skipped (-NoBuild)' -ForegroundColor Yellow; return }
    Write-Host "   building $Name checkout (npm run build + build:client)..."
    $out = & cmd /c "cd /d `"$Path`" && npm run build && npm run build:client" 2>&1
    if ($LASTEXITCODE -ne 0) {
        $out | Select-Object -Last 25 | Write-Host
        throw "build failed in $Path"
    }
    Write-Host '   build ok' -ForegroundColor Green
}

function Launch([object]$t, [string]$OverlayPath) {
    $line = "dsh --profile web --patch `"$OverlayPath`""
    if ($Port -ge 0) { $line += " --port $Port" }
    if ($NoOpen)     { $line += " --no-open" }

    # Always printed, never only under -DryRun: ticket 43's drift note is that a
    # live pass ran an invocation nobody recorded (port 8799 vs the probed boot).
    Write-Host "   overlay: $OverlayPath" -ForegroundColor DarkGray
    Write-Host "   command: $line" -ForegroundColor DarkGray

    if ($DryRun) {
        Write-Host '   [dry-run] not spawning; overlay contents:' -ForegroundColor Yellow
        Get-Content $OverlayPath | ForEach-Object { Write-Host "     $_" }
        return
    }

    $proc = Start-Process -FilePath "$env:ComSpec" -ArgumentList "/k title $($t.Title) && $line" -PassThru
    Write-Host "   server window started: $($t.Title) (pid $($proc.Id))" -ForegroundColor Green

    if ($KillAfterMinutes -gt 0) {
        # Armed at launch, not cleanup-at-end (AGENTS.md): a detached cmd does
        # the waiting, so the timer outlives this launcher process.
        $secs = [int]$KillAfterMinutes * 60
        $kill = "ping -n $($secs + 1) 127.0.0.1 >nul & taskkill /PID $($proc.Id) /T /F"
        Start-Process -FilePath "$env:ComSpec" -ArgumentList "/c $kill" -WindowStyle Hidden | Out-Null
        Write-Host "   kill timer armed: server tree force-killed after $KillAfterMinutes min" -ForegroundColor Yellow
    } else {
        Write-Host '   no kill timer (-KillAfterMinutes 0 = off; AGENTS.md wants one for test passes)' -ForegroundColor DarkGray
    }

    Write-Host '   dsh is opening the browser UI; closing that window stops the server.'
}

# --- resolve checkout -------------------------------------------------------
$interactive = $false
if (-not $Checkout) {
    $interactive = $true
    Show-Menu
    # The answer goes to a local first: assigning '0' straight into $Checkout
    # re-runs the parameter's ValidateSet and throws before the exit check.
    $choice = Get-MenuAnswer '  Which one? [1, 0=exit]' @('1','0') '1'
    if ($choice -eq '0') { return }
    $Checkout = $choice
}
$t = $targets | Where-Object Key -eq $Checkout
if (-not (Test-Path $t.Path)) { throw "checkout path missing: $($t.Path)" }

Resolve-StaleTarget -t $t -Interactive $interactive
$overlayPath = Get-OverlayPath -t $t
Build-Checkout -Path $t.Path -Name $t.Name
Launch -t $t -OverlayPath $overlayPath
