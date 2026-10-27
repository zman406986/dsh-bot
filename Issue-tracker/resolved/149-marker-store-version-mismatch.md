# 149 — Marker store version mismatch: every storageDomain.open throws since DOMAIN_VERSION 2

**Status:** resolved
**Labels:** ready-for-agent
**Origin:** owner 2026-10-27: "dispatcher status fails to persist after dsh shutdown. when restarted dispatcher seem to lose dispatcher status and says: 'Tools updated 10 removed Removed: await_agent, check_workers, deliver_result, message_agent, recall, request_access, spawn_dispatcher, spawn_worker, steer_worker, stop_worker'".
**Blocked by:** nothing — owner instruction 2026-10-27 names this work directly.
**Related:** ticket 147 (dispatcher status persists across restart — this defect is the no-degraded-notice half and must land before issue 2 is called done), ADR-0012.

## Problem

The live marker store `C:\Users\TZhen\.dsh\storages\multitask_dispatcher.json` (other device:
`C:\Users\TZ\.dsh\...`) is stamped `"unit": {"name": "multitask_dispatcher", "version": 1}` (file
mtime 2026-09-22).

`src/adapter/durable-marker.ts:86` declares `DOMAIN_VERSION = 2`, and the domain spec (`:344-365`)
declares no `compatibleVersions` and no `layout`, so the json backend opens with the "single" layout
and EXACT-version reads (`@deepseek-ai/dsh-storage-json lib/index.js:100-102, :161-190`).

Consequence since commit `15d42a5` (2026-10-02): every `storageDomain.open` throws version-mismatch;
`rebuildFromDurability` rejects → `RESTART_DEGRADED_NOTICE` on every activation
(`src/plugin.ts:1055-1063`) and ALL dispatcher/worker marks fail to write. The store has been
silently unreadable for about a month. This independently undermines "dispatcher status persists
across restart" (ticket 147) and is required for its full end-to-end resolution.

Coverage gap: `test/adapter-durable-marker.test.ts` pins `version === 2` (:131-135, :355-362,
:430-432) but no test opens a store stamped version 1, so the mismatch is unguarded.

## What to do

- [x] In `src/adapter/durable-marker.ts`, make v1 stores openable: read
  `@deepseek-ai/dsh-storage-json`'s actual semantics for `compatibleVersions`/migration in the
  single layout FIRST, then either declare `compatibleVersions: [1]` (if reads-accept-older +
  writes-restamp is supported) or add an explicit migration step. Choose the mechanism the library
  actually supports; do not guess.
- [x] Add a test that opens a store stamped version 1 (write a fixture store the way the json
  backend writes, or build one via the library at v1 semantics) and asserts open succeeds, marks
  read/write round-trip, and the unit version advances to 2 only if the library restamps on write.
- [x] Gates in one grouped run: `npm run typecheck && npm test && npm run lint:docs`.

## Constraints

- Offline only. Do not hand-edit the owner's live `~/.dsh` storages file — the fix must migrate at
  open time in code.
- Preserve domain version 2 as current; v1 is legacy-compat only.
- Keep ticket 147 unblocked: this fix is independent of 147's primary route but required for
  no-degraded-notice UX; both land before issue 2 is called done.

### ADR notes

- ADR-0012 (restart replays durability, never work): a version migration that restores read access
  to durable marks is durability replay; consistent.
- Owner instruction 2026-10-27 (dispatcher status must persist after restart) covers this as a
  blocking defect of that behavior.

## DoD

- [x] A v1-stamped store opens without throwing; existing version-2 pins stay green; new v1-compat
  test green.
- [x] Grouped gates green.

## Comments

2026-10-27: Filed from owner instruction; findings gathered read-only; no code changed.

2026-10-27 (implementer, branch `ticket-147-dispatcher-status-persistence`): **mechanism chosen:
`layout: "per-record"` + `compatibleVersions: [1]` — the library's own migration step.** Declaring
`compatibleVersions` alone would have fixed nothing, and that is the one thing worth recording.

What the installed library actually does (`@deepseek-ai/dsh-storage-json` 0.2.1-rc.2, read in
`C:\Users\TZhen\.dsh\profiles\node_modules`):

- `single` layout (`lib/index.js:91-128`) compares the stored `unit.version` to the descriptor
  EXACTLY (`:100-102`) and never looks at `compatibleVersions`. The backend contract says it outright:
  "`single`-layout reads stay exact-version" (`dsh-storage/lib/types/backend.d.ts:59-68`). Our spec
  had no `layout`, so it opened `single` — hence the throw on every open.
- `per-record` layout builds `acceptedStamps` = current version + `compatibleVersions`
  (`lib/index.js:353-355`) and, when no per-record document exists yet, bootstraps from a legacy
  whole-unit `<root>/<name>.json` file whose stamp is accepted (`bootstrapLegacyUnit`,
  `:358-400`). Each record is written as a document stamped with the CURRENT version; the legacy
  file is never modified. Writes always stamp `descriptor.version` (`serializeRecord`, `:437-445`).

So the library has exactly one migration path, and it lives on the per-record side. The fix is
`markerDomainSpec()` declaring `layout: "per-record"` and
`compatibleVersions: DOMAIN_LEGACY_VERSIONS` (`[1]`), with `DOMAIN_VERSION` unchanged at 2. Verified
against the REAL installed backend before writing the test: a v1 fixture opened, `loadAll` returned
the v1 rows, the legacy file stayed at version 1 on disk, and a fresh write landed as a version-2
document (scratch probe under `.scratch/testing/2026-10-27-t147-149-v1-compat/`, never committed).

Recorded limit of that layout, stated in the code and here: record keys become path segments and must
match `[a-zA-Z0-9_-]+` (`lib/index.js:301-302`, `:581-584`). Dispatcher/worker ids and host session
ids already match. Inbox `jobId`s come from an external queue file, so an exotic id (a dot, a space)
would now reject at write; the inbox paths already log and retry, so such a job is re-presented
rather than lost.

Tests: `test/storage-json-v1-compat.test.ts` (4 cases) carries a transcription of the library's
version handling (the repo imports no host packages and the library is not a dependency) with each
rule cited to its installed line. Cases: the spec declaration itself; a v1 fixture opening with rows
round-tripping, the legacy file byte-identical, writes stamped 2, and a second process reopening
cleanly; a CONTROL running the pre-149 spec shape against the same fixture and asserting
`version-mismatch`; and a v1 fixture holding a schema-invalid row failing as `invalid-record` (the
`compatibleVersions` claim is the owner's vouch about old rows, so a bad one must fail loudly).
Existing version-2 pins in `test/adapter-durable-marker.test.ts` are unmodified and green.

The owner's live `~/.dsh/storages/multitask_dispatcher.json` was NOT touched: the migration happens at
open time in code. Gate run: `npm run typecheck && npm test && npm run lint:docs` — exit 0, 1571/1571
tests pass, doc-lint 0 findings.

2026-10-28 (handoff): same situation as ticket 147 — implementation complete and gated green on
branch `ticket-147-dispatcher-status-persistence` (commit 30a16a2), agent stopped by owner order
before merge. Next team: merge with 147, run grouped gates on merged main, then move both tickets
to resolved/.

## Resolution — 2026-10-28

Landed via the same merge `a83f5e1` (branch commits `30a16a2`, `e7a8e0e`). Verified against the host
backend `@deepseek-ai/dsh-storage-json` 0.2.1-rc.2 APIs the fix relies on: per-record dispatch,
`acceptedStamps`, `bootstrapLegacyUnit`. No vendor interaction with ticket 148's racoons re-sync.

Two recorded caveats:

- Exotic `jobId`s outside `[a-zA-Z0-9_-]+` now reject at write (record keys are path segments).
  Inbox paths already log and retry, so such a job is re-presented, not lost.
- `bootstrapLegacyUnit` runs only when no readable per-record document exists
  (`lib/index.js:349`, function at `:370`). If even one record document is already there, migration
  from the legacy whole-unit file is skipped entirely and the remaining legacy rows are never copied.

Bookkeeping: `**Status:**` → `resolved`; moved
`Issue-tracker/open/149-marker-store-version-mismatch.md` → `Issue-tracker/resolved/`.
