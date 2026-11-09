# 289 — Windows launcher cannot find dsh when npm's global bin is not `%APPDATA%\npm`
**Status:** open
**Labels:** ready-for-human
**Priority:** low — the launcher refuses to start on this device; the fix is a path fallback.
**Severity:** P2 / medium (blocks the only launch path on one of the owner's two devices)
**Ship blocker:** no
**Origin:** owner request 2026-11-08 ("rebuild newest build, and see if launcher bat on my desktop needs update"), verified offline.
**Blocked by:** nothing; a real launch needs the owner (it starts dsh).

## Problem
`dev/windows/dsh-bot.bat` resolves dsh only at `%APPDATA%\npm\dsh.cmd` (with a same-path
`%USERPROFILE%` retry). On this device npm's global prefix is the WinGet Node LTS folder, so
`dsh` is on PATH at
`…\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_…\node-v24.19.0-win-x64\dsh.cmd`
and `%APPDATA%\npm\dsh.cmd` does not exist. A `-DryRun` through the Desktop forwarder exits 1
with "dsh not found" while `dsh --version` answers `0.2.2-rc.1` from the same shell.

The literal path was written from the other device's recorded install (`docs/research/dsh-local-install.md:29`,
`C:\Users\TZ\AppData\Roaming\npm\dsh.ps1`), so it is correct there and wrong here.

## Requested work
After the two explicit locations, fall back to `where dsh.cmd` and use the first hit. Keep the
existing error message and the baseline read from `dev/dsh-baseline.txt`. No other behaviour changes.

## Acceptance
- `dsh-bot.bat -DryRun` resolves dsh and prints the command on this device, exit 0.
- On a device where `%APPDATA%\npm\dsh.cmd` exists, resolution is unchanged (explicit path first).
- When dsh is genuinely absent, the current install hint still prints and the launcher exits 1.

## Checks
Offline only: `dsh-bot.bat -DryRun` through the Desktop forwarder (starts nothing, builds nothing),
`node tools/issue-index.mjs --check`, `node tools/doc-lint.mjs`. No dsh start, no browser, no model contact.

## Comments
2026-11-08: Filed before the edit, per the tracker rule. Found while re-syncing the Desktop
launcher to the tracked copy: the Desktop `dsh-bot.bat` was still the 2026-10-29 standalone file,
not the forwarder ticket 167 says it is. First filed as 288; renumbered to 289 the same day
because the other device had already published a different ticket 288
(`resolved/288-launcher-port-race-and-rebuild-skip.md`).

2026-11-08: Fix landed (agent-run, subject to owner reversal). `dev/windows/dsh-bot.bat` now
keeps the two explicit paths first, then falls back to the first `where dsh.cmd` hit. Evidence:
- Desktop forwarder `dsh-bot.bat -DryRun` → repo `…\Desktop\dsh-bot`, command `dsh --profile multitask`, exit 0.
- `dsh-bot.bat web -DryRun` → command `dsh --profile web --patch "…\dev\cordis.web.patch.yml"`, exit 0.
- Both files stay ASCII with CRLF (Desktop 22 CRLF, 0 non-ASCII; tracked 232 CRLF, 0 non-ASCII).
- `node tools/issue-index.mjs --check` fresh; `node tools/doc-lint.mjs` clean.
Nothing started: no dsh process, no browser, no model contact. A real launch still needs the
owner, so this stays open.

2026-11-08: Re-applied on top of the pulled launcher. The remote commits `5cd8ec2` and `c0be005`
rewrote the launcher (port guard, rebuild only when stale) but kept the two hardcoded dsh
locations, so the fallback was added again at the same spot. Same dry-run checks pass:
`dsh-bot.bat -DryRun` prints `dsh --profile multitask`, `web` route prints the web overlay
command; both exit 0.
