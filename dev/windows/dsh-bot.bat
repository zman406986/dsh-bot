@echo off
rem ===================================================================
rem  dsh-bot - launcher for the multitask dispatcher checkout.
rem  Tracked source of truth; the Desktop dsh-bot.bat forwards here.
rem
rem  Usage:
rem    dsh-bot.bat                  build if stale, then boot the multitask profile
rem    dsh-bot.bat web              build if stale, then boot web + committed overlay
rem    dsh-bot.bat -NoBuild         skip the build (still checks build freshness)
rem    dsh-bot.bat -SkipCheck       skip the build AND the freshness probe
rem    dsh-bot.bat -Restart         stop a previous dsh still holding the port
rem    dsh-bot.bat -Port <n>        listen on another port (default 3080)
rem    dsh-bot.bat -DryRun          resolve and print the command, boot nothing
rem    dsh-bot.bat -NoOpen          do not open the browser
rem    extra arguments after the route are passed to dsh
rem
rem  Baseline: dev\dsh-baseline.txt (README "What you need")
rem ===================================================================
setlocal EnableExtensions EnableDelayedExpansion
title dsh-bot

rem Resolve the checkout from this file (dev\windows -> repo root).
for %%I in ("%~dp0..\..") do set "REPO=%%~fI"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

set "DSH=%APPDATA%\npm\dsh.cmd"
if not exist "%DSH%" set "DSH=%USERPROFILE%\AppData\Roaming\npm\dsh.cmd"
rem One shared version for every launcher: dev\dsh-baseline.txt. The literal
rem fallback only covers a launcher kept beside an incomplete checkout.
set "DSH_BASELINE=0.2.2-rc.1"
if exist "%REPO%\dev\dsh-baseline.txt" for /f "usebackq delims=" %%V in ("%REPO%\dev\dsh-baseline.txt") do set "DSH_BASELINE=%%V"
set "ROUTE=multitask"
set "EXTRA="
set "NOBUILD="
set "SKIPFRESH="
set "DRYRUN="
set "NOOPEN="
set "RESTART="
set "PORT="
set "PORTGIVEN="

:parse
if "%~1"=="" goto args_done
set "ARG=%~1"
if /i "!ARG!"=="web" goto arg_web
if /i "!ARG!"=="racoons" (
  echo [dsh-bot] the racoons route was removed; this launcher has no racoons switch.
  exit /b 1
)
if /i "!ARG!"=="multitask" goto arg_multitask
if /i "!ARG!"=="-NoBuild" goto arg_nobuild
if /i "!ARG!"=="-SkipCheck" goto arg_skipcheck
if /i "!ARG!"=="-Restart" goto arg_restart
if /i "!ARG!"=="-Port" goto arg_port
if /i "!ARG!"=="--port" goto arg_port
if /i "!ARG!"=="-DryRun" goto arg_dryrun
if /i "!ARG!"=="-NoOpen" goto arg_noopen
if /i "!ARG!"=="-h" goto usage
if /i "!ARG!"=="-help" goto usage
if /i "!ARG!"=="--help" goto usage
goto arg_extra

:arg_web
set "ROUTE=web"
shift
goto parse
:arg_multitask
set "ROUTE=multitask"
shift
goto parse
:arg_nobuild
set "NOBUILD=1"
shift
goto parse
:arg_skipcheck
set "NOBUILD=1"
set "SKIPFRESH=1"
shift
goto parse
:arg_restart
set "RESTART=1"
shift
goto parse
:arg_port
if "%~2"=="" (
  echo [dsh-bot] -Port needs a number
  exit /b 1
)
set "PORT=%~2"
set "PORTGIVEN=1"
shift
shift
goto parse
:arg_dryrun
set "DRYRUN=1"
set "NOBUILD=1"
shift
goto parse
:arg_noopen
set "NOOPEN=1"
shift
goto parse
:arg_extra
if defined EXTRA (set "EXTRA=!EXTRA! %1") else (set "EXTRA=%1")
shift
goto parse

:usage
echo Usage: dsh-bot.bat [web^|multitask] [-NoBuild^|-SkipCheck] [-Restart] [-Port ^<n^>] [-DryRun] [-NoOpen] [dsh args]
exit /b 1

:args_done
if not defined PORT set "PORT=3080"
if defined PORTGIVEN set "EXTRA=!EXTRA! --port !PORT!"
if defined NOOPEN set "EXTRA=!EXTRA! --no-open"

if not exist "%REPO%" (
  echo [dsh-bot] checkout not found: %REPO%
  echo [dsh-bot] keep the Desktop launcher beside the dsh-bot folder
  pause
  exit /b 1
)
if not exist "%DSH%" (
  echo [dsh-bot] dsh not found: %DSH%
  echo [dsh-bot] install it with: npm install -g @deepseek-ai/dsh@!DSH_BASELINE!
  pause
  exit /b 1
)

cd /d "%REPO%"

if defined NOBUILD (
  if defined SKIPFRESH (
    echo [dsh-bot] build and freshness checks skipped -SkipCheck
  ) else (
    echo [dsh-bot] build skipped -NoBuild
  )
) else (
  rem Rebuild only when something actually changed. The same probe used by
  rem -NoBuild answers "is lib/ and client/ at least as new as the sources?";
  rem a fresh tree boots straight away instead of paying the tsc build every run.
  rem Its stderr is dropped here: on this path a nonzero exit just means
  rem "rebuild", and the probe's own error text reads like a failed launch.
  echo [dsh-bot] checking build freshness ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\dev\check-build-fresh.ps1" -Repo "%REPO%" 2>nul
  if "!ERRORLEVEL!"=="0" (
    echo [dsh-bot] build is up to date; skipping rebuild
  ) else (
    echo [dsh-bot] building lib ...
    call npm run build
    if not "!ERRORLEVEL!"=="0" (
      echo [dsh-bot] npm run build failed
      pause
      exit /b 1
    )
    echo [dsh-bot] building client ...
    call npm run build:client
    if not "!ERRORLEVEL!"=="0" (
      echo [dsh-bot] npm run build:client failed
      pause
      exit /b 1
    )
  )
)

if not exist "%REPO%\lib\index.js" (
  echo [dsh-bot] missing build artifact: %REPO%\lib\index.js
  pause
  exit /b 1
)
if not exist "%REPO%\client\index.js" (
  echo [dsh-bot] missing build artifact: %REPO%\client\index.js
  pause
  exit /b 1
)
if not exist "%REPO%\lib\core\multitask.js" (
  echo [dsh-bot] missing build artifact: %REPO%\lib\core\multitask.js
  pause
  exit /b 1
)

rem Staleness guard: on the -NoBuild path, refuse to serve a build older
rem than the newest source file (2026-10-30 incident: hours of stale lib/).
rem -SkipCheck waives both the build and this probe, for a deliberately
rem quick relaunch against whatever is already in lib/ and client/.
rem -DryRun is exempt: it boots nothing, so a stale build cannot be served.
rem The probe is fail-closed: ANY nonzero exit (stale, missing output, or a
rem blocked/failed PowerShell probe) refuses the launch.
if defined NOBUILD if not defined DRYRUN if not defined SKIPFRESH (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\dev\check-build-fresh.ps1" -Repo "%REPO%"
  if not "!ERRORLEVEL!"=="0" goto err_srcstale
)

if /i "%ROUTE%"=="web" (
  set "PATCH=%REPO%\dev\cordis.web.patch.yml"
  if not exist "!PATCH!" (
    echo [dsh-bot] overlay missing: !PATCH!
    pause
    exit /b 1
  )
  set "CMDLINE=--profile web --patch "!PATCH!""
  goto launch
)

rem Default route: the dedicated multitask profile. A junction to this
rem checkout is re-pointed after every build, because the profile's
rem pnpm file: install can hold a stale copy.
set "PROFILE_PATCH=%USERPROFILE%\.dsh\profiles\multitask\cordis.patch.yml"
set "PROFILE_PLUGIN=%USERPROFILE%\.dsh\profiles\multitask\node_modules\dsh-multitask-dispatcher"
if not exist "%PROFILE_PATCH%" (
  echo [dsh-bot] multitask profile missing: %PROFILE_PATCH%
  echo [dsh-bot] seed with: dsh --profile multitask --from-default-profile web
  pause
  exit /b 1
)
if not defined DRYRUN (
  echo [dsh-bot] refreshing profile plugin link ...
  rem The normal state is a junction into this checkout. `rmdir /s` can
  rem recurse THROUGH a junction on some Windows builds and delete the repo,
  rem so /s is used only when PowerShell positively confirms the top entry is
  rem a REAL directory with NO nested reparse point anywhere in its tree.
  rem Any failed/blocked probe, a top-level link, or a nested link falls back
  rem to plain rmdir (removes a junction, refuses a non-empty real directory),
  rem which is fail safe rather than fail open.
  if exist "%PROFILE_PLUGIN%" (
    set "PROFILE_PLUGIN_RECURSE="
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try{$p=Get-Item -LiteralPath '%PROFILE_PLUGIN%' -Force -ErrorAction Stop}catch{exit 1}; if(($p.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){exit 3}; $s=[System.Collections.Stack]::new(); $s.Push($p.FullName); $h=$false; while(($s.Count -gt 0) -and (-not $h)){$d=$s.Pop(); foreach($c in (Get-ChildItem -LiteralPath $d -Force -ErrorAction Stop)){if(($c.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){$h=$true; break}; if($c.PSIsContainer){$s.Push($c.FullName)}}}; if($h){exit 4}; exit 0"
    if "!ERRORLEVEL!"=="0" set "PROFILE_PLUGIN_RECURSE=1"
    if defined PROFILE_PLUGIN_RECURSE (
      rmdir /s /q "%PROFILE_PLUGIN%"
    ) else (
      rmdir "%PROFILE_PLUGIN%"
    )
  )
  mklink /J "%PROFILE_PLUGIN%" "%REPO%" >nul
  if not "!ERRORLEVEL!"=="0" (
    echo [dsh-bot] mklink /J failed
    pause
    exit /b 1
  )
)
if not exist "%PROFILE_PLUGIN%\lib\core\multitask.js" (
  if not defined DRYRUN (
    echo [dsh-bot] profile plugin missing lib\core\multitask.js
    pause
    exit /b 1
  )
)
set "CMDLINE=--profile multitask"
goto launch

:launch
echo [dsh-bot] repo:    %REPO%
echo [dsh-bot] command: dsh !CMDLINE! !EXTRA!
echo.
if defined DRYRUN (
  echo [dsh-bot] -DryRun: nothing started
  exit /b 0
)
rem Closing a dsh console window does not free the port instantly, so a quick
rem relaunch used to boot into "listen EADDRINUSE". Wait for the old listener
rem to go away; -Restart stops a previous dsh that is still running.
set "GUARD_ARGS=-Port !PORT! -WaitSeconds 15"
if defined RESTART set "GUARD_ARGS=!GUARD_ARGS! -Restart"
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\dev\windows\port-guard.ps1" !GUARD_ARGS!
if not "!ERRORLEVEL!"=="0" (
  pause
  exit /b 1
)
call "%DSH%" !CMDLINE! !EXTRA!
set "EXITCODE=%ERRORLEVEL%"
if not "!EXITCODE!"=="0" (
  echo.
  echo [dsh-bot] dsh exited with code !EXITCODE!
  pause
)
exit /b !EXITCODE!

:err_srcstale
echo [dsh-bot] refusing to serve a stale or unverifiable build.
echo [dsh-bot] lib\index.js or client\index.js is older than its newest source,
echo [dsh-bot] an output is missing, or the freshness probe itself failed.
echo [dsh-bot] run the launcher without -NoBuild to rebuild.
exit /b 1
