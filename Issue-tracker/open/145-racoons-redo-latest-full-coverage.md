# 145 — Racoons redo: latest upstream, full coverage (dispatcher + workers), durable storage

**Status:** open
**Labels:** ready-for-human
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

- [x] **Refresh the vendor tree.** Delete `vendor/racoons` entirely, including untracked `lib/` build artifacts. Fresh full copy: upstream `packages/core/src` → `vendor/racoons/core`, upstream `packages/adapters/dsh/src` → `vendor/racoons/adapter`, both at `af78642`.
- [x] **Host-owned vendor metadata.** Write `vendor/racoons/core/package.json`, `vendor/racoons/adapter/package.json` and their `tsconfig.json` by hand at version `0.1.0`: exports `"."` (core) and `"."` plus `"./plugin"` (adapter), both pointing at `lib/`, `engines.node` `>=22.13.0`. Add `vendor/racoons/PROVENANCE.md` recording the upstream repo, commit `af78642e0a6154fc5fc26ef77aca6508382b198d`, and the copy date.
- [x] **Root manifest.** `package.json`: dependency versions to `0.1.0`; keep `workspaces`, `bundledDependencies` (`bundled`) and `files` (including `vendor/racoons`), keep `build:vendor`. Run `npm install` to regenerate the lockfile.
- [x] **Delete the M1 glue.** Remove `src/adapter/racoons.ts`, `src/adapter/racoons-session.ts`, `src/adapter/racoons-port.ts`.
- [x] **New `src/adapter/racoons-mount.ts`.** Host glue using only public exports of `racoons-dsh/plugin` and `@racoons/core`. Build the adapter object over `ctx` (`on`/`effect`/`logger`, a no-op tool host, a guarded `get`). Cache a host-owned `openLedger` built from `resolveSessionStorage` + `openLedger` in a per-session `Map`, with a disposer that closes every ledger. Journal sink writes to `console.info`. `registerRacoonsMount(ctx, options)` calls `createRacoonsPlugin(...).apply(...)`.
- [x] **Mount unconditionally in `src/plugin.ts`.** Mount inside the plugin's enabled path. Remove the `racoonsEnabled` config field and interface member and the activation block that reads it. No session filter: worker sessions are covered by plugin-scope listeners.
- [x] **Per-session recall tools.** Register `registerPluginTools` on the dispatcher tool surface and on the worker session scope. Each reads that session's cached ledger. Suppress the built-in global recall by supplying the no-op `DshToolHost`.
- [x] **Config surface.** New volatile keys: `racoonsRecordOnly` (default `false` → enforcement `apply`), `racoonsStorageRoot` (default `""` → `<DSH_HOME>/storages/racoons`), `racoonsContextWindowTokens` (default `0` → `null`, off). Update `src/client/settings-card-store.ts`, `src/client/overlay.ts` (English and Chinese faces), `README.md` config table, and rewrite `dev/cordis.racoons.patch.yml` for the new keys.
- [x] **Engines.** `package.json` `engines.node` → `>=22.13.0`.
- [x] **Tests.** Delete the three M1 adapter tests (`test/adapter-racoons.test.ts`, `test/adapter-racoons-port.test.ts`, `test/adapter-racoons-engine.test.ts`). Update the pins: feature-flag list, client settings card, client face scaffold, `test/support/plugin-config.ts`. Add `test/adapter-racoons-mount.test.ts` proving: dispatcher, worker and plain-chat sessions are all captured and replaced (no filter); durable ledger, blobs and prune-round file persist under a temp root; recall after close/reopen is byte-exact; per-session recall refuses cross-session ids; config mapping for record-only, default root and window `0`; teardown closes ledgers.
- [x] **Gates.** `npm run typecheck`, `npm test`, `npm run lint:docs` all green.
- [x] **Supersede ticket 126.** This redo replaces its approach; the M1 code its live check would verify is being removed.

## Constraints

- The mount uses only public exports of `racoons-dsh/plugin` and `@racoons/core`; no reaching into vendored internals.
- No `racoonsEnabled` anywhere: schema, settings card, locales, README, dev overlay, tests.
- The live boot item uses a mock LLM only, needs a kill timer from launch, sends only a trivial task, and never exports the dsh key. Evidence goes under `.scratch/testing/2026-10-24-racoons-redo/`, never committed.
- No real-model calls, no browser, no key export.

## DoD

- [x] Vendor refreshed by full copy at upstream HEAD (record real hash); PROVENANCE.md present; typecheck+test pass with engines >=22.13.0.
- [x] M1 glue deleted; new mount glue uses only public exports of racoons-dsh/plugin and @racoons/core.
- [x] No racoonsEnabled anywhere (schema, card, locales, README, dev overlay, tests); racoons mounts unconditionally in the enabled path.
- [x] Test proves capture+replacement for dispatcher session, worker session, and plain chat (no session filter).
- [x] Test proves durable per-session storage (ledger.sqlite + blobs + prune-round file) and byte-exact recall after close/reopen.
- [x] recall registered per session on dispatcher and worker seams, reads its own ledger, refuses cross-session ids; no global recall.
- [x] Config keys racoonsRecordOnly/racoonsStorageRoot/racoonsContextWindowTokens volatile with library-default mapping; card + both locales updated and parity-pinned.
- [x] npm run typecheck, npm test, npm run lint:docs all green.
- [x] ADR notes recorded in ticket comments (see below).
- [ ] Live boot pass on a mock-LLM run (kill timer, trivial task; needs a human at the keyboard) — journal shows mounted + storage-plan, then for BOTH the dispatcher session and the worker session the chain `entry` → `entry-ask` → `entry-apply` (`status: landed`, `engineStatus: applied`) → one `surfaceOp: replace` (ADR-0028; no `publish` line on this path); recall round-trip in a worker session; llm/stream capture outcome recorded either way.

## Comments

2026-10-24: Filed from the approved plan; no code changed in this pass. The upstream hash was verified with `git rev-parse HEAD` / `git log --oneline -1` in `C:\Users\TZhen\Desktop\racoons` — the two earlier reported hashes were both stale.

### ADR notes (planner's verified reading of ADR-0029, ADR-0006, ADR-0018)

- Storage vs ADR-0006/0018-A5 ("no second database"): binding scope is dsh-bot's own product state (worker records, obligation markers, compaction boundary). The racoons ledger is the vendored library's own recall archive (removed-content bytes + manifests, per-session SQLite under `<DSH_HOME>/storages/racoons`, racoons' own application_id/user_version); no dsh-bot state moves and no second transcript DB is created. Read strictly as a global ban on any new store, A5 would condemn this — recorded here as an owner-confirmed deviation backed by the owner's 2026-10-24 goal (authority level 1), not silently assumed.
- ADR-0018 U-H (no usage accounting, no content-search index): satisfied — the mount's meter records no usage observations; recall is by-id, never searched; cleared results become restorable, not searchable.
- ADR-0029 (deterministic microcompact): its status line records what was adopted first, not a ban; decisions 1/4 say a model-in-the-loop layer needs a ticket stating the tradeoff. Tradeoff: racoons' judge/bar verdicts ARE model calls via the host llm service (PRUNE_ASK_SYSTEM_PROMPT / RECALL_TOOL_DESCRIPTION ship as model-facing strings). Also: ADR-0029's window source was session.requestContext()?.contextWindow; the racoons trigger takes a static contextWindowTokens (default off). Redundancy note: microcompact and racoons both rewrite tool results at pre-step; microcompactEnabled stays default-off; enabling both on one session is redundant, racoons being the superset.

### 2026-10-24 — offline work complete; only the live boot pass remains

**Commits.** `bdf694c` filed this ticket and moved 126 to `cancelled/`. `9ea800f` refreshed the vendor tree to upstream `af78642` (core 105 files, adapter 28 files, both `0.1.0`, host-owned manifests, `PROVENANCE.md`, `engines.node >=22.13.0`, lockfile regenerated). `e8a77a7` deleted the M1 glue (`racoons.ts`, `racoons-session.ts`, `racoons-port.ts`) and mounted racoons unconditionally inside the enabled path (`src/plugin.ts:1399`), with per-session recall on the dispatcher surface (`:1008`) and the worker seam (`:684`); `racoonsRecordOnly`/`racoonsStorageRoot`/`racoonsContextWindowTokens` replaced `racoonsEnabled` in the schema, card, both locales, README and the dev overlay. `782ced1` added `test/adapter-racoons-mount.test.ts` (9 tests).

**Gates.** `npm run typecheck` 0 errors; `npm test` 1559/1559 pass, 0 fail (375 suites); `npm run lint:docs` clean (0 findings; issue index fresh; ADR index 30 rows). Arithmetic: main's 1566 minus 16 from the three deleted M1 suite files, plus 9 new = 1559 (the 1550 seen mid-sequence is that same tree before the new mount suite landed).

**Evidence.** Probe: `.scratch/testing/2026-10-24-racoons-redo/` (`probe-mount.ts`, `probe-pass.ts`; git-ignored, never committed). `test/adapter-racoons-mount.test.ts`, 9 tests: (1) dispatcher, worker and plain-chat sessions all captured and replaced identically, with no global recall; (2) one activation adds exactly one per-session recall and nothing else; (3) per-session `ledger.sqlite` + blobs + `prune-round.json` persist, a remount resumes the round and recalls the original bytes byte-exactly; (4) recall answers its own id and refuses cross-session, unknown and malformed ids, `ledgerOf` throws for an unopened session; (5) the worker-seam definitions read the worker's ledger and refuse the parent's id; (6) record-only records entries and applies nothing; (7) an empty root maps to `defaultStorageRoot()`, window `0` to `null`/`command` and `4096` to `command+threshold`; (8) a record-only plugin apply never rewrites the transcript; (9) dispose closes every cached ledger, releases every listener, is idempotent, and a remount is clean.

**Implementation notes.** `openLedger` is NOT publicly exported from `racoons-dsh` — only `"."` and `"./plugin"` are published, and `"./plugin"` re-exports `resolveSessionStorage`/`defaultStorageRoot`/the storage error types but not `openLedger`. The host factory therefore composes core's public `SqliteLedger.open({ databasePath, blobStore: new FileBlobStore(blobRoot), clock })` over `resolveSessionStorage(root, sessionId)`: same on-disk layout, `<root>/sessions/<id>/ledger.sqlite` plus a sibling `blobs/`. `DshToolHost` is imported as a type from the root `racoons-dsh` export. Evidence chain on the verdict path is `entry` → `entry-ask` → `entry-apply` (`status: landed`, `engineStatus: applied`) → one `surfaceOp: replace` (post-148 resync, ADR-0028); there is no `publish` line on this path (`publish` belongs to the entry/append application only).

**Remaining: the live boot pass only** (needs the owner at the keyboard; follow `read-before-running-live-and-browser-tests.md` — kill timer at launch, trivial task, mock LLM only, no key export; evidence in `.scratch/testing/2026-10-24-racoons-redo/`). In the journal look for `mounted` with the storage plan, then for BOTH a dispatcher session and a worker session: `storage-plan`, `capabilities`, `entry`, `entry-ask`, `entry-apply` (`status: landed`, `engineStatus: applied`) and one `surfaceOp: replace`; a recall round-trip inside a worker (its own id answers byte-exactly, the parent's id refuses); and the `llm/stream` capture outcome recorded either way.

2026-10-24: Re-synced vendor to upstream 70c99ef (full-tree verified: 0 differing/missing/extra source files; only change = owner ruling nativeCompactionBackstop ships ON, default false→true; glue untouched, inherits the new default) — gates re-verified: typecheck 0, test 1559/1559, lint:docs 0.

2026-10-28: DoD vocabulary corrected to match upstream ADR-0028 after the ticket-148 vendor re-sync. `verdict-settled` is gone; the observed chain is `entry` → `entry-ask` → `entry-apply` (`status: landed`, `engineStatus: applied`) → one `surfaceOp: replace`, with no `publish` line on this path. Applies to both the dispatcher and worker lanes; the rest of the DoD is unchanged. A first live-boot attempt was blocked environmentally (main's `node_modules`/vendor clobbered by a concurrent process; being fixed separately) — evidence `.scratch/testing/2026-10-28-145-live-boot/summary.md`. That run says nothing about ticket code: blocked, not failed, no verdict either way.
