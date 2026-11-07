# 167 — Desktop launchers re-sync to the vendored repo

**Status:** open
**Labels:** ready-for-human
**Related:** 127 (the RACOONS launcher and its `%~dp0` resolution rule); 144 (the earlier dsh rc.3 baseline — now superseded by `dev/dsh-baseline.txt`, currently `0.2.2-rc.1`); 145 (racoons is opt-in since ADR-0033/ticket 174: `racoonsEnabled` gates the mount, and `racoonsRecordOnly` / `racoonsStorageRoot` / `racoonsContextWindowTokens` apply only while it is enabled); owner request, 2026-10-29.

## What to do

Bring both Desktop launchers back in line with the repo as it stands
(racoons vendored as npm workspaces and opt-in via `racoonsEnabled`,
dsh 0.2.2-rc.1 baseline read from `dev/dsh-baseline.txt`):

- `dsh-bot.bat`: drop the hardcoded `C:\Users\TZhen\Desktop\dsh-bot` repo
  path — the owner works from two devices with different home directories
  (`TZhen…` and `TZ…`), so the launcher must resolve the `dsh-bot` folder
  beside itself, exactly as `dsh-bot-RACOONS.bat` already does.
- `dsh-bot.bat`: the missing-dsh error should read the shared
  `dev\dsh-baseline.txt` baseline (currently `0.2.2-rc.1`), not a hardcoded
  version. The RACOONS launcher already does; the main launcher has the same
  fallback literal for an incomplete checkout.
- `dsh-bot.bat`: the header still calls this file "the ONLY launcher file";
  the RACOONS launcher exists, so reword.
- `dsh-bot-RACOONS.bat`: add the opt-in `-NoOpen` switch recorded as an
  optional follow-up in ticket 127. Without the switch, behaviour is
  unchanged (a browser tab still opens).

## Constraints

- Both launchers live on the Desktop, outside git. ASCII text, CRLF line
  endings, no dsh start, no keys, no model contact, no browser.
- Static checks only; `-DryRun -NoBuild` on the main launcher starts
  nothing and builds nothing; the RACOONS launcher is checked with a
  neutered copy under `.scratch/testing/`.

## DoD

- [x] Main launcher resolves the adjacent checkout on either desktop root.
- [x] Missing-dsh error reads the shared baseline in `dev/dsh-baseline.txt`
      (currently `0.2.2-rc.1`), not a hardcoded version.
- [x] RACOONS launcher takes `-NoOpen`; without it behaviour is unchanged.
- [x] Both launchers refuse to serve a build older than the source: the main
      one on its `-NoBuild` path, the RACOONS one unless `-Build` is passed.
- [x] RACOONS launcher takes `-Build`, and that path runs `npm run build`
      **and** `npm run build:client` — it checked for `client\index.js` but
      never rebuilt it.
- [ ] Human launch check on both launchers, now including the stale-build
      refusal: make a tree stale, confirm the documented message on each, then
      confirm a normal launch still serves.

## Comments

2026-10-29: Filed before implementing. Verified by inspection:
`node_modules\@racoons\core` is an npm-workspaces junction to
`vendor\racoons\core`, so the RACOONS launcher's required-output checks
still pass as written; `dev\cordis.racoons.patch.yml` still pins the three
racoons options named in its header, matching `src/plugin.ts`; the launch
command is unchanged. The stale items are the ones listed above.

2026-10-29: Landed (agent-run, subject to owner reversal). `dsh-bot.bat`:
repo now resolves as `%~dp0dsh-bot`; the missing-checkout error tells the
owner to keep the launcher beside the `dsh-bot` folder; the missing-dsh
error names `@deepseek-ai/dsh@0.2.1-rc.3`; the header no longer claims this
is the only launcher file. `dsh-bot-RACOONS.bat`: opt-in `-NoOpen` appends
`--no-open` to the command line; unknown arguments are rejected with the
usage line; default behaviour (browser opens) unchanged. Both files remain
ASCII with CRLF. Checks run from
`.scratch/testing/2026-10-29-launcher-update/`: the real `dsh-bot.bat` with
`-DryRun -NoBuild` resolved the checkout by launcher location and exited 0
(started and built nothing); a neutered copy of the RACOONS launcher
(`start` swapped for `echo`, repo pinned) passed all existence checks and
printed the exact command with and without `-NoOpen`; a bogus argument hit
the usage error and exited 1. No dsh start, no browser, no model contact.
Human launch check on both launchers still open, so status stays open.

2026-10-30: Stale-build guards added (agent-run, subject to owner reversal).
The 2026-10-29 incident that motivated this: the app silently served a
2026-10-28 `lib/` build for hours, so a summoned dispatcher kept the
subagent shape long after the source was fixed. Changes: `dsh-bot.bat`
refuses on the `-NoBuild` path when the newest `src`/`vendor\racoons` `.ts`
file is newer than `lib\index.js` (`:err_srcstale`); `dsh-bot-RACOONS.bat`
gained `-Build` and refuses under the same comparison when it is not passed.
The RACOONS `-Build` path was also missing `npm run build:client` — it
checked for `client\index.js` among its required outputs but never rebuilt
it, so a server build could have run against a stale browser bundle. Both
files stay ASCII with CRLF (183 and 126 CRLF pairs, zero non-ASCII bytes).
Static checks only, from `.scratch/testing/2026-10-29-launcher-staleness/`:
real `dsh-bot.bat -DryRun -NoBuild` exits 0 on a fresh tree and reproduced
the refusal on a stale scratch copy; a neutered RACOONS copy refuses stale
with and without `-NoOpen`, rejects `-Bogus` with the updated usage line, and
reaches the start line under `-Build` with both build calls replaced by
`echo`. No dsh start, no real build, no browser, no model contact. Cost to
know: the guard spawns one PowerShell process per launch (~0.3 s).

2026-11-07: Premise correction (second-round audit). The baseline is no
longer `0.2.1-rc.3`: `dev/dsh-baseline.txt` holds `0.2.2-rc.1` and both
launchers now read it, so their missing-dsh text follows the shared file
instead of naming rc.3. Racoons no longer mounts unconditionally either — it
is off by default and gated by `racoonsEnabled`, with the RACOONS launcher and
`dev\cordis.racoons.patch.yml` as the manual switch (ADR-0033/ticket 174).
The DoD row and Related line are updated; the dated comments above record the
state at the time they were written. The human launch check remains open.

2026-11-07: Consolidation (owner request). Only one launcher remains. The
tracked source of truth is `dev/windows/dsh-bot.bat`; the Desktop
`dsh-bot.bat` is a small forwarder to it, so the two can no longer drift.
The separate `dsh-bot-RACOONS.bat` was deleted; its feature switch is the
`racoons` route on the single launcher. DoD rows about the second launcher
are retired with it. The human launch check is now one file, not two.
