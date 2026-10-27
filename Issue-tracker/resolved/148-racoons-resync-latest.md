# 148 — Re-sync vendored racoons to upstream latest (b5f95cb)

**Status:** resolved
**Labels:** ready-for-agent
**Origin:** owner 2026-10-27: "racoons updated, re-integrate their latest version".
**Blocked by:** nothing — owner instruction 2026-10-27 names this work directly.
**Related:** ticket 145 (open, ready-for-human — previous racoons re-sync to 70c99ef; its live-boot item stays with 145), ADR-0018 (U-H usage-accounting rider — see ADR notes).

## Problem

The vendored library at `vendor/racoons` still holds upstream commit
`70c99ef64056d517708fd0a5d70c71310700ff34`: 105 `.ts` files under `vendor/racoons/core` and 28
under `vendor/racoons/adapter`, recorded in `vendor/racoons/PROVENANCE.md`. That tree was verified
byte-identical to `70c99ef` (CRLF normalization aside) before writing this ticket.

Upstream is the local clone at `C:\Users\TZhen\Desktop\racoons` (other device:
`C:\Users\TZ\Desktop\racoons`), branch `main`, remote `github.com/zman406986/RACOONS`. The pin was
first written as `303266044bee8b1ae17e7f24dfe0dba6212e655d` ("084: night addendum …", 2026-10-27),
then re-pinned 2026-10-27 (see Comments) to the commit that became HEAD minutes later:
`b5f95cbbd6f2dff8b25fce4c0208050ecd6fa2e6` ("060: paper amendments"), after upstream committed the
7 formerly-dirty files (f91d0ab "053: recall through the mount's source lane", 0e70674 "073:
settled set — applied keepall withholds its unit", plus c9894f4 and b5f95cb). Local `main` is 22
commits AHEAD of `origin/main`; the local clone is the source of truth. Upstream is being actively
committed to during this ticket's life — the pin is the pinned hash, not "whatever HEAD is later".

`70c99ef..3032660` was 255 commits, 48 touching vendored paths, 101 files, +8237/−3555; the
re-pinned range `70c99ef..b5f95cb` adds 4 more commits (the 053 source lane, 073 settled set ×2,
060 paper amendments) — the implementer recomputes the exact stat at copy time and records it in
PROVENANCE. `LICENSE` is
unchanged and both package versions are still `0.1.0` (no dependency bumps).

What changed that this repo must follow:

- **Breaking API change.** `registerPluginTools(host, sources: DshToolSources)` at upstream HEAD
  replaces the old `(host, recall: (id) => ...)` signature. Both dsh-bot call sites —
  `src/adapter/racoons-mount.ts:321` and `src/adapter/racoons-mount.ts:336` — pass a bare function
  and must become `{ recall: recallFor(sessionId) }`. `DshToolSources.forget` is optional, so no
  forget handler is required.
- **Removed journal vocabulary.** Upstream ADR-0028 removed the judge pass. `judge-ask`,
  `verdict-settled`, `verdict-posted` and every other `judge-*` kind are gone from
  `RACOONS_JOURNAL_KINDS`; entry-ask checkpoint kinds replace them (`entry-ask`, `entry-ask-off`,
  `entry-ask-refused`, `entry-apply`, `entry-apply-refused`). Tests that hard-code the dead kinds:
  `test/adapter-racoons-mount.test.ts:747` and `:750` (`verdict-settled`), `:1303` (`judge-ask`),
  `:1306` (`verdict-settled`). The `assertCapped` helper at `test/adapter-racoons-mount.test.ts:731-760`
  is the main one.
- **Ledger schema 2 → 3.** `application_removals.operation_kind` gains `proof` and `forget`;
  `SqliteLedger.open` auto-migrates v2 → v3 and writes `<db>.v2.bak`. Old per-session
  `ledger.sqlite` files under `<DSH_HOME>/storages/racoons` migrate automatically on open.
- **Copy from the pinned commit, never the working tree.** The 7 files that were dirty uncommitted
  work when this ticket was drafted (`adapter.ts`, `plugin.ts`, `port.ts`, `prune.ts`,
  `engine/engine.ts`, `index.ts`, `prune/pass.ts`) were committed upstream as f91d0ab + 0e70674, so
  the working tree is now clean against HEAD — but upstream is actively moving. Copy via
  `git -C <clone> archive b5f95cb…` (or `git show`) from the pin only, so the vendor stays
  deterministic regardless of later upstream commits.

## What to do

- [x] **Re-sync `vendor/racoons` from upstream commit `b5f95cbbd6f2dff8b25fce4c0208050ecd6fa2e6`** following
  `vendor/racoons/PROVENANCE.md` §"How to re-sync": delete the vendor directory entirely
  (including git-ignored `lib/`), full-copy `packages/core/src/**` → `vendor/racoons/core/`,
  `packages/adapters/dsh/src/**` → `vendor/racoons/adapter/`, `LICENSE` → `vendor/racoons/LICENSE`,
  all FROM THE PINNED COMMIT via `git archive`/`git show`, never the working tree. Restore the 5
  host-owned files (`vendor/racoons/core/package.json`, `vendor/racoons/core/tsconfig.json`,
  `vendor/racoons/adapter/package.json`, `vendor/racoons/adapter/tsconfig.json`,
  `vendor/racoons/PROVENANCE.md`). Update `PROVENANCE.md` with the new hash `b5f95cb`, its subject
  "060: paper amendments", the copy date, and the recomputed 70c99ef..b5f95cb stat. Do NOT use
  upstream's own `scripts/resync-vendor.mjs` (hardcoded wrong target, only overwrites files that
  already exist).
- [x] **Adapt the two `registerPluginTools` call sites** in `src/adapter/racoons-mount.ts:321` and
  `src/adapter/racoons-mount.ts:336` to the new `{ recall: ... }` sources shape.
- [x] **New additive upstream surfaces stay unwired unless compilation demands them.** The re-pin
  range adds `DshPortOptions.workspaceRoot`, `DshApplicationPort.recallReader()`, `indexSources()`,
  a `CoverageMeter` feeding `snapshot().pathCoverage`, and `recall(id, { reader })`. None are
  required by the current mount. Wire nothing new into dsh-bot beyond what typecheck forces;
  note anything you had to wire in the ticket comment.
- [x] **Rewrite the journal-kind assertions** in `test/adapter-racoons-mount.test.ts` from the
  judge/verdict vocabulary to the new entry-ask/entry-apply vocabulary. Check the upstream sources
  at the pinned commit for the exact kind names rather than guessing.
- [x] **Gates.** Run `npm install`, `npm run build:vendor`, then `npm run typecheck`, `npm test`,
  `npm run lint:docs` — all green.

## Constraints

- Copy from commit `3032660` only. The upstream working tree is dirty in 7 files; never copy
  working-tree state. Ignore the stale `.worktrees/rig-refresh` worktree at `9775d00`.
- No network needed or wanted: the upstream local clone is ahead of GitHub; do not pull.
- Offline tests only. No live dsh/LLM/browser run — live boot remains ticket 145's outstanding item.
- Host-owned files are never copied from upstream: the 4 manifests/tsconfigs plus `PROVENANCE.md`.
- npm, not pnpm. Any evidence/probe artifacts go under `.scratch/testing/2026-10-27-<slug>/` and are
  never committed.

### ADR notes

- Owner instruction 2026-10-27 ("re-integrate their latest version") is the level-1 ruling covering
  this re-sync. It is recorded here explicitly per the surface-don't-silently-assume rule.
- **ADR-0018 U-H (no usage accounting).** Upstream HEAD adds `usage.ts` plus
  `usage-reconciled` / `usage-missing` journaling — the first U-H-adjacent change since that rider.
  The owner instruction covers taking upstream latest, so the adjacency is recorded explicitly
  rather than treated as consent to spend. Guard: if during integration it turns out usage
  reconciliation writes meter observations into dsh-bot PRODUCT state (not the racoons library's own
  ledger), stop and surface to the owner instead of proceeding.
- **ADR-0006 / ADR-0018 A5 (no second database).** Unchanged — the racoons ledger stays the vendored
  library's own archive, the owner-confirmed deviation from ticket 145.
- **ADR-0029 (deterministic microcompact).** `microcompactEnabled` stays default-off; no change.
- **`nativeCompactionBackstop`.** dsh-bot sets nothing and inherits the library default (`true`) —
  consistent with the prior "ON" ruling recorded at the 70c99ef re-sync (commit `3732bc8`).

## DoD

- [x] Every vendored source file under `vendor/racoons` byte-identical to upstream commit `b5f95cb`
  (CRLF normalization acceptable), zero files from the working tree.
- [x] `PROVENANCE.md` records hash `b5f95cb`, subject "060: paper amendments", copy
  date 2026-10-27.
- [x] typecheck, full offline test suite, and lint green in one grouped run.
- [x] Ledger auto-migration v2→v3 verified at least by the existing durable-reopen test in
  `test/adapter-racoons-mount.test.ts`.

## Comments

2026-10-27: Filed from owner instruction; findings gathered read-only; no code changed.
2026-10-27: Re-pinned 3032660 → b5f95cb. Evidence (upstream reflog): while this ticket was being
prepared, upstream committed the 7 formerly-dirty files (f91d0ab 053 source lane, 0e70674 073
settled set) plus c9894f4 and b5f95cb at 21:53–21:54; holding the old pin would deliberately
exclude landed upstream work, contradicting the owner's "re-integrate their latest version". API
impact of the drift verified nil for this integration (registerPluginTools shape, journal
vocabulary, config surfaces identical at both pins); drift is additive scope only. ADR-0018 guard
checked: usage reconciliation stays inside the racoons journal, no dsh-bot product state touched.
2026-10-27 (implementation): Re-sync done on branch `ticket-148-racoons-resync` from the pinned
commit only. Copy used `git -c core.autocrlf=false -c core.eol=lf archive b5f95cb…` staged under
`.scratch/testing/2026-10-27-racoons-resync/`, each of the 146 files `cmp`-verified against
`git cat-file -p b5f95cb:<path>` before landing; nothing from the upstream working tree entered the
vendor. Vendor now holds core 117 `.ts` (was 105), adapter 28 `.ts` (unchanged), LICENSE, plus the 5
host-owned files restored byte-identically. `PROVENANCE.md` records the pin, subject and date, the
recomputed `70c99ef..b5f95cb` stat (101 files, +8475/−3560; 259 commits, 50 touching vendored paths),
and the new line-ending rule. Gate: `npm run typecheck && npm test && npm run lint:docs` → typecheck
clean, 1559/1559 tests pass (0 fail), doc-lint 0 findings, both indexes fresh (re-run on the committed
tree: 1560/1560 with the new pinning test below).

**Code change (outside vendor/).** Only `src/adapter/racoons-mount.ts:328` and `:338` — both
`registerPluginTools(...)` calls now pass `{ recall: recallFor(sessionId) }`. `forget` omitted
(optional; `createDshTools` then registers recall alone). No new upstream surface was wired:
typecheck did not force `workspaceRoot`, `recallReader()`, `indexSources()`, `CoverageMeter` or
`recall(id, { reader })`.

**Test rewrite.** `test/adapter-racoons-mount.test.ts`: the canned answer was the dead index-keyed
verdict table (`{"1":{"forgetall":"…"}}`), which the entry lane's parser refuses as `unknown-action`.
It is now the entry grammar (`FORGET_ALL_ANSWER` / `KEEP_ALL_ANSWER`). `assertCapped` asserts
`entry` + `entry-ask` (action/unitId) + `entry-apply` (`status: landed`, `engineStatus: applied`)
instead of `verdict-settled`; the shaped turn's form changed too, from the prune lane's
`[not retained]` receipt to core's `[racoons] kept 0 of N lines · recall <id>` marker. Both
record-only assertions were rewritten against real behavior (below). New test pins that behavior.

**Behavior change found, needs an owner call (not fixed here — outside this ticket's scope).**
`racoonsRecordOnly` no longer means "no context edits". At `70c99ef` the judge's `settleVerdicts` read
`enforcement === 'record-only'` and dropped the batch. At `b5f95cb` the judge is gone (ADR-0028) and
`enforcement` is read in exactly two places — `settlePrune` and `settleForget` — neither on the
entry-checkpoint path, so `entry-apply`'s `engineStatus` is `applied` and a `forgetall` answer edits
the transcript under `record-only` exactly as under `apply`. Verified by probe, not inference. This
contradicts dsh-bot's own text: `src/plugin.ts:111` ("no context edit is applied"), the settings card
label "record-only mode (no context edits)", and `README.md:77`. Pinned by the new test
"record-only does NOT gate the entry checkpoint's forget at upstream b5f95cb" so it cannot pass
unnoticed. Options for the owner: (a) accept the new library semantics and reword the dsh-bot
surfaces, or (b) gate the entry apply in the mount (drop the ask, or refuse a non-keepall answer)
when `enforcement === 'record-only'` — a behavior decision, hence not taken silently here.

**Migration DoD.** The existing durable-reopen test passes unchanged (archives written by the new
build reopen byte-exactly). Separately probe-verified that `SqliteLedger.open` on a hand-built
schema-2 file rewrites it to `user_version = 3`, writes `ledger.sqlite.v2.bak`, and widens
`application_removals.operation_kind` to include `proof` and `forget`.

## Resolution — 2026-10-28

Implemented at commit `2b53e6c` ("Ticket 148: re-sync vendored racoons to upstream b5f95cb"), already
on `main`; no code change in this bookkeeping pass. The record-only behavior question raised in this
ticket's comments stays open under ticket 150.

Bookkeeping: `**Status:**` → `resolved`; moved
`Issue-tracker/open/148-racoons-resync-latest.md` → `Issue-tracker/resolved/`.
