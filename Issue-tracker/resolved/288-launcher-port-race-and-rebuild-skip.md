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
- If held, wait up to 15 s for it to free (the just-closed-console case).
- If it stays held and `-Restart` was not passed, print the PID and command
  line and exit 2 instead of letting dsh abort.
- `-Restart` kills the listener only when its command line looks like dsh
  (`dsh` and `bin.js`); any other process is refused with exit 3. Exit 4
  covers a kill that did not free the port.
- The probe fails closed: any internal error exits 1 rather than booting
  into the race.

**`dev/windows/dsh-bot.bat`**:

- Freshness probe runs first; a fresh tree boots without rebuilding
  (measured ~0.5 s instead of ~5 s).
- `-SkipCheck` skips both the build and the probe (was `-NoBuild` plus a
  probe; that combination still exists).
- `-Restart` and `-Port <n>` added; `-NoOpen` documented in the header.
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

- Port guard, exit 0/2/3/4 paths exercised with a real listener; a
  fake dsh-shaped process was killed by `-Restart`, a plain node server
  was refused.
- Wait-for-free path exercised with a server that closes after 2.5 s.
- Launcher `-DryRun` on both routes; `-SkipCheck`, `-Port`, `-NoOpen`
  argument handling; `-Port` without a value exits 1.
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
