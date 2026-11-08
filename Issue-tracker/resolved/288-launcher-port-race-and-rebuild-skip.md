# 288 — Launcher reboot races the previous dsh and rebuilds every time

**Status:** resolved
**Labels:** ready-for-human
**Related:** 167 (launcher re-sync; this continues the stale-build guard it added); 127 (the launcher's `%~dp0` resolution rule); owner report, 2026-11-08.

## Problem

Every launcher run printed:

```
dsh: startup failed: 2 required plugins did not activate
  webserver (required)
    Error: listen EADDRINUSE: address already in use 127.0.0.1:3080
```

Closing the launcher window and launching again then worked. Port 3080 was
still held by the previous dsh process: closing a console window does not
release the listening socket instantly, so a quick relaunch raced it. The
failure surfaced as a plugin-startup diagnostic, which reads like a broken
plugin rather than a busy port.

A second complaint: the launcher rebuilt on every run (two `tsc` compiles,
about 5 s), even when nothing had changed. It runs no lint — that part of
the report was the type checker's output.

## What changed

**`dev/windows/port-guard.ps1`** (new) — runs before boot:

- If the port is free, boot immediately.
- If a dsh is already serving (the reported "two windows" case), replace it
  by default: kill it, and also close the launcher `cmd.exe` window that owns
  it, so a relaunch leaves one window instead of a paused one plus a live one.
- `-Keep` leaves the running dsh alone and closes the new launch (exit 5).
- A listener that is not dsh is refused with exit 3 and never killed.
- Exit 4 covers a kill that did not free the port.
- The probe fails closed: any internal error exits 1 rather than booting
  into the race.

**`dev/windows/dsh-bot.bat`**:

- Freshness probe runs first; a fresh tree boots without rebuilding
  (measured ~0.5 s instead of ~5 s).
- `-SkipCheck` skips both the build and the probe (was `-NoBuild` plus a
  probe; that combination still exists).
- `-Keep`, `-Restart` (explicit spelling of the default) and `-Port <n>`
  added; `-NoOpen` documented in the header.
- The probe's stderr is suppressed on the auto-rebuild path only, so a
  stale tree rebuilds quietly instead of printing a message that looks like
  a failed launch. The `-NoBuild` refusal path is unchanged and still loud.

**`dev/check-build-fresh.ps1`** — bug fix. `Get-ChildItem -LiteralPath`
silently ignores `-Include`, so vendored build output
(`vendor/racoons/**/lib/*.js`, `*.map`) counted as source and every
checkout looked stale forever. Extension filtering now happens in
`Where-Object`. Without this the skip-rebuild path could never trigger.

## Verification

Offline only; no dsh boot, no model contact, no browser:

- Port guard, every exit path exercised with a real listener: free (0),
  keep (5), non-dsh holder refused (3), killed holder frees the port (0).
- Replacement tested end to end through a fake launcher-shaped batch file:
  first run serves, second run stops it and closes its window, and exactly
  one listener plus one `cmd.exe` window remain. `-Keep` on a running
  instance leaves exactly one of each.
- Ancestor detection checked against the owner's live dsh: it resolves to
  the launcher window (`cmd /c dsh-bot.bat`), not the terminal.
- Launcher `-DryRun` on both routes; `-SkipCheck`, `-Keep`, `-Restart`,
  `-Port`, `-NoOpen` argument handling; `-Port` without a value exits 1.
- Fresh tree: probe exit 0, launcher reports "build is up to date".
- Touched source: probe exit 1, launcher rebuilds, second run skips.
- `-NoBuild` on a stale tree still refuses with the documented message.
- `npm test` 1311 pass; `npm run lint:docs` clean.
- Not verified by eye: a real dsh boot through the fixed launcher.

## Comments

2026-11-08: Filed after the fix, one change-set. The owner asked for the
release to be committed and pushed in the same breath, which conflicts
with the tracker rule that a ticket exists before implementation; the
ticket is written from the landed diff rather than ahead of it, so the
record is honest about the order.
