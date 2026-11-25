# 305 — Drop the vendored RACOONS integration and test CREMATOR as an external plugin

**Status:** resolved
**Labels:** ready-for-agent
**Type:** task
**Severity:** P1 / high
**Ship blocker:** no

## Request (owner, 2026-11-21)

Remove the old RACOONS integration from this repo and from the Desktop, then re-test the successor library CREMATOR as a brand-new user would: clone it from GitHub, build it, and mount it into dsh with a `--patch` overlay. No code-level integration work inside dsh-bot.

- Delete `C:\Users\TZhen\Desktop\dsh-bot-RACOONS.bat`.
- Owner chose "彻底拆掉" for the repo: remove the vendored tree, the mount glue, the config switches, the RACOONS tests, the dev patch, the client settings controls, and the live doc references.
- Owner chose "都不删" for local copies: keep `Desktop\racoons`, `racoons-bench`, `racoons-wt`, `~/.dsh/storages/racoons`, and `.scratch/racoons-storage`.
- Owner chose the `multitask` profile plus a `--patch` overlay for the new-user test.

## Why

The vendored tree is a copy of the predecessor library (RACOONS). CREMATOR is the published successor, its dsh adapter mounts from its own built `dist/plugin.js`, and a patch overlay is the documented user path. Keeping a second, stale copy inside this repo adds a second upgrade surface and a second set of tests for code the owner no longer ships.

## Done when

1. No RACOONS code, config, tests, or live doc references remain in `dsh-bot` (`vendor/racoons`, `src/adapter/racoons-mount.ts`, `dev/cordis.racoons.patch.yml`, `test/racoons-*.test.ts`, `test/adapter-racoons-mount.test.ts`, package workspaces/dependencies, settings keys).
2. `npm install`, `npm run build`, `npm run typecheck`, and the offline test suite pass.
3. A fresh clone of `https://github.com/zman406986/Agent-Memory-CREMATOR` is installed and built under `.scratch/testing/2026-11-21-cremator-new-user/`, and a `dsh --profile multitask --patch <overlay>` boot mounts it with no edits to `dsh-bot` source.
4. Evidence (boot log, kill-timer record, overlay file) stays under that evidence folder and is never committed.

## Comments

- 2026-11-21: Rip-out done. Deleted `Desktop\dsh-bot-RACOONS.bat`, `vendor/racoons/`, `src/adapter/racoons-mount.ts`, `dev/cordis.racoons.patch.yml`, `test/adapter-racoons-mount.test.ts`, the twelve `test/racoons-*.test.ts` files, and `.gitattributes` (its only rule pinned the vendor tree). Removed the four config fields, the mount wiring, the client settings controls (en + zh), the package workspaces/dependencies/`build:vendor`/`pretest`, the launcher's racoons switch, the README/dev doc references, and the build-freshness vendor roots. Ticket 302 moved to `cancelled/` because its subject code no longer ships here.
- 2026-11-21: Verification. `npm install` (prunes the two workspace packages), `npm run build`, and `npm run typecheck` pass. Offline suite: 1365 tests, 1363 pass, 2 fail — `stock-worker-continuation.test.ts` hardcodes `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` (this machine's global dsh lives under the Winget Node prefix, so the nested cordis import misses; environment-only, unrelated to this change), and the `inbox-end-to-end.test.ts` full-suite flake recorded in ticket 162 passes 7/7 in isolation. Log: `.scratch/testing/2026-11-21-cremator-new-user/offline-tests.log`.
- 2026-11-21: New-user check. Cloned `https://github.com/zman406986/Agent-Memory-CREMATOR` at `e49a9b3` into `.scratch/testing/2026-11-21-cremator-new-user/Agent-Memory-CREMATOR`, ran `npm install` and `npm run build`. Mounted it with the README's one-row overlay (`cremator.patch.yml`) on the `multitask` profile. `dsh --dump-config` shows the `cremator-mount` row pointing at the built `packages/adapters/dsh/dist/plugin.js`. The boot probe (`boot-probe.ps1`, 120 s kill timer armed at launch) served `http://127.0.0.1:61458` in 7 s with an empty stderr log, then the process tree was killed; no dsh-bot source was touched. No model turn was run: no dsh API key is present in this shell and the rule forbids exporting the human's key, so session-level pruning behavior is not exercised by this ticket.
