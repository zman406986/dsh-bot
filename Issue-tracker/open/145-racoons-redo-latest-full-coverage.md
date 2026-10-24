# 145 — Racoons redo: latest upstream, full coverage (dispatcher + workers), durable storage

**Status:** open
**Labels:** ready-for-agent
**Origin:** owner 2026-10-24 (level-1 ruling): integrate the LATEST version of the external racoons library into dsh-bot, applied to EVERYTHING — the dispatcher session and all worker sessions — replacing the previous integration.
**Related:** ticket 126 (superseded by this ticket — its M1 lane is removed, not extended), ticket 127 (desktop launcher — not touched here), ADR-0006 (worker-record durability split), ADR-0018 (imitate the reference; A5 no second database, U-H no usage accounting and no content-search index), ADR-0029 (deterministic microcompact), `docs/research/racoons-integration-2026-10-20.md`, `read-before-running-live-and-browser-tests.md` (mandatory before the live boot item).

## Upstream state recorded 2026-10-24

- Repo: `C:\Users\TZhen\Desktop\racoons`, branch `main`, working tree clean.
- HEAD: `af78642e0a6154fc5fc26ef77aca6508382b198d` — short `af78642`.
- Subject: `002: defer — owner: always observing; no dedicated session needed`.
- Commit date: 2026-10-24.
- Both packages are at version `0.1.0`, `engines.node` `>=22.13.0`. `@racoons/core` exports `"."`; `racoons-dsh` exports `"."` and `"./plugin"`. `createRacoonsPlugin` is exported from `racoons-dsh/plugin`.

Earlier reports disagreed on the hash (`536e340` vs `3578f23`). Neither matches the current HEAD; the value above is what `git rev-parse HEAD` returns in the upstream repo on 2026-10-24 and is the one this ticket records.

## Problem

The 126 integration vendored a stale M1 snapshot and mounted it behind a dispatcher-only opt-in flag (`racoonsEnabled`, default `false`). In that shape the old copy is functionally inert: it misses whole upstream subsystems, its package metadata is a local M1 variant, and only a dispatcher session could ever reach it. The owner's ruling is to clear it out entirely and redo the integration against the latest upstream with no session filter, so workers get the same treatment as the dispatcher.

## What to do

- [ ] **Refresh the vendor tree.** Delete `vendor/racoons` entirely, including untracked `lib/` build artifacts. Fresh full copy: upstream `packages/core/src` → `vendor/racoons/core`, upstream `packages/adapters/dsh/src` → `vendor/racoons/adapter`, both at `af78642`.
- [ ] **Host-owned vendor metadata.** Write `vendor/racoons/core/package.json`, `vendor/racoons/adapter/package.json` and their `tsconfig.json` by hand at version `0.1.0`: exports `"."` (core) and `"."` plus `"./plugin"` (adapter), both pointing at `lib/`, `engines.node` `>=22.13.0`. Add `vendor/racoons/PROVENANCE.md` recording the upstream repo, commit `af78642e0a6154fc5fc26ef77aca6508382b198d`, and the copy date.
- [ ] **Root manifest.** `package.json`: dependency versions to `0.1.0`; keep `workspaces`, `bundledDependencies` (`bundled`) and `files` (including `vendor/racoons`), keep `build:vendor`. Run `npm install` to regenerate the lockfile.
- [ ] **Delete the M1 glue.** Remove `src/adapter/racoons.ts`, `src/adapter/racoons-session.ts`, `src/adapter/racoons-port.ts`.
- [ ] **New `src/adapter/racoons-mount.ts`.** Host glue using only public exports of `racoons-dsh/plugin` and `@racoons/core`. Build the adapter object over `ctx` (`on`/`effect`/`logger`, a no-op tool host, a guarded `get`). Cache a host-owned `openLedger` built from `resolveSessionStorage` + `openLedger` in a per-session `Map`, with a disposer that closes every ledger. Journal sink writes to `console.info`. `registerRacoonsMount(ctx, options)` calls `createRacoonsPlugin(...).apply(...)`.
- [ ] **Mount unconditionally in `src/plugin.ts`.** Mount inside the plugin's enabled path. Remove the `racoonsEnabled` config field and interface member and the activation block that reads it. No session filter: worker sessions are covered by plugin-scope listeners.
- [ ] **Per-session recall tools.** Register `registerPluginTools` on the dispatcher tool surface and on the worker session scope. Each reads that session's cached ledger. Suppress the built-in global recall by supplying the no-op `DshToolHost`.
- [ ] **Config surface.** New volatile keys: `racoonsRecordOnly` (default `false` → enforcement `apply`), `racoonsStorageRoot` (default `""` → `<DSH_HOME>/storages/racoons`), `racoonsContextWindowTokens` (default `0` → `null`, off). Update `src/client/settings-card-store.ts`, `src/client/overlay.ts` (English and Chinese faces), `README.md` config table, and rewrite `dev/cordis.racoons.patch.yml` for the new keys.
- [ ] **Engines.** `package.json` `engines.node` → `>=22.13.0`.
- [ ] **Tests.** Delete the three M1 adapter tests (`test/adapter-racoons.test.ts`, `test/adapter-racoons-port.test.ts`, `test/adapter-racoons-engine.test.ts`). Update the pins: feature-flag list, client settings card, client face scaffold, `test/support/plugin-config.ts`. Add `test/adapter-racoons-mount.test.ts` proving: dispatcher, worker and plain-chat sessions are all captured and replaced (no filter); durable ledger, blobs and prune-round file persist under a temp root; recall after close/reopen is byte-exact; per-session recall refuses cross-session ids; config mapping for record-only, default root and window `0`; teardown closes ledgers.
- [ ] **Gates.** `npm run typecheck`, `npm test`, `npm run lint:docs` all green.
- [ ] **Supersede ticket 126.** This redo replaces its approach; the M1 code its live check would verify is being removed.

## Constraints

- The mount uses only public exports of `racoons-dsh/plugin` and `@racoons/core`; no reaching into vendored internals.
- No `racoonsEnabled` anywhere: schema, settings card, locales, README, dev overlay, tests.
- The live boot item uses a mock LLM only, needs a kill timer from launch, sends only a trivial task, and never exports the dsh key. Evidence goes under `.scratch/testing/2026-10-24-racoons-redo/`, never committed.
- No real-model calls, no browser, no key export.

## DoD

- [ ] Vendor refreshed by full copy at upstream HEAD (record real hash); PROVENANCE.md present; typecheck+test pass with engines >=22.13.0.
- [ ] M1 glue deleted; new mount glue uses only public exports of racoons-dsh/plugin and @racoons/core.
- [ ] No racoonsEnabled anywhere (schema, card, locales, README, dev overlay, tests); racoons mounts unconditionally in the enabled path.
- [ ] Test proves capture+replacement for dispatcher session, worker session, and plain chat (no session filter).
- [ ] Test proves durable per-session storage (ledger.sqlite + blobs + prune-round file) and byte-exact recall after close/reopen.
- [ ] recall registered per session on dispatcher and worker seams, reads its own ledger, refuses cross-session ids; no global recall.
- [ ] Config keys racoonsRecordOnly/racoonsStorageRoot/racoonsContextWindowTokens volatile with library-default mapping; card + both locales updated and parity-pinned.
- [ ] npm run typecheck, npm test, npm run lint:docs all green.
- [ ] ADR notes recorded in ticket comments (see below).
- [ ] Live boot pass on a mock-LLM run (kill timer, trivial task; needs a human at the keyboard) — journal shows mounted + storage-plan + entry/publish for BOTH dispatcher and worker session; recall round-trip in a worker session; llm/stream capture outcome recorded either way.

## Comments

2026-10-24: Filed from the approved plan; no code changed in this pass. The upstream hash was verified with `git rev-parse HEAD` / `git log --oneline -1` in `C:\Users\TZhen\Desktop\racoons` — the two earlier reported hashes were both stale.

### ADR notes (planner's verified reading of ADR-0029, ADR-0006, ADR-0018)

- Storage vs ADR-0006/0018-A5 ("no second database"): binding scope is dsh-bot's own product state (worker records, obligation markers, compaction boundary). The racoons ledger is the vendored library's own recall archive (removed-content bytes + manifests, per-session SQLite under `<DSH_HOME>/storages/racoons`, racoons' own application_id/user_version); no dsh-bot state moves and no second transcript DB is created. Read strictly as a global ban on any new store, A5 would condemn this — recorded here as an owner-confirmed deviation backed by the owner's 2026-10-24 goal (authority level 1), not silently assumed.
- ADR-0018 U-H (no usage accounting, no content-search index): satisfied — the mount's meter records no usage observations; recall is by-id, never searched; cleared results become restorable, not searchable.
- ADR-0029 (deterministic microcompact): its status line records what was adopted first, not a ban; decisions 1/4 say a model-in-the-loop layer needs a ticket stating the tradeoff. Tradeoff: racoons' judge/bar verdicts ARE model calls via the host llm service (PRUNE_ASK_SYSTEM_PROMPT / RECALL_TOOL_DESCRIPTION ship as model-facing strings). Also: ADR-0029's window source was session.requestContext()?.contextWindow; the racoons trigger takes a static contextWindowTokens (default off). Redundancy note: microcompact and racoons both rewrite tool results at pre-step; microcompactEnabled stays default-off; enabling both on one session is redundant, racoons being the superset.
