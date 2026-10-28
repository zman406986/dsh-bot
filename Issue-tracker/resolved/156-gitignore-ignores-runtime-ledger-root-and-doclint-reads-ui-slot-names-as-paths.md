# 156 — The racoons test-ledger root is untracked, and doc-lint reads a dsh UI slot name as a repo path

**Status:** resolved
**Labels:** ready-for-agent
**Origin:** branch-merge-and-push pass 2026-10-28 — both findings surfaced while preparing main for push.
**Related:** ticket 127 (resolved — the launcher pins `.scratch\racoons-storage` as the storage root), ticket 140 (resolved — ADR-0031 introduced the `conversation.session.header.actions` seat), ticket 96 (the doc-lint tooling), ticket 97 (the rulebook moves), `.gitignore`, `dev/cordis.racoons.patch.yml`.

## Problem

Two independent defects blocked a clean push of `main`.

### 1. `.scratch/racoons-storage/` is untracked, not ignored

`dev/cordis.racoons.patch.yml:21` pins `racoonsStorageRoot: '.scratch/racoons-storage'`, and `src/adapter/racoons-mount.ts:232` falls back to it as the default storage root. A live launcher run therefore writes session ledgers there: `ledger.sqlite`, `-shm`, `-wal`, plus content-addressed blobs under `sessions/<id>/blobs/sha256/`.

`.gitignore` ignores `.scratch/testing/`, `.scratch/*.log`, `.scratch/adr-drafts/`, `.scratch/repo-analysis/`, and `.scratch/_overnight-*/` — but **not** `.scratch/racoons-storage/`. `git status` reported the directory as untracked, so a `git add -A` would have committed private dsh session content. That is exactly what the rulebook's operator rule of 2026-09-20 forbids ("artifacts may contain private dsh session content; **never commit them**", `docs/agents-rulebook.md` §Testing artifacts & evidence layout).

Verified: 31 files, 1.7 MB, sqlite ledgers holding prior sessions (blob contents include `CONTEXT.md` snapshots and tool results).

### 2. Doc-lint fails on the ADR-0031 seat name

`npm run lint:docs` fails with two findings, both `docs/adr/README.md`:

```
line  35 — backticked path `conversation.session.header.actions` does not resolve
line 174 — backticked path `conversation.session.header.actions` does not resolve
```

Both lines were introduced by commit `115ec19` (the ADR-0031 draft), which is in the unpushed range. The token is a **dsh UI slot name**, not a repo path. `looksLikeRepoPath` (`tools/lib.mjs:90-95`) qualifies any backticked token containing `/` or ending in a dotted extension, and an allowlist exists for exactly this class of false positive (`PATH_ALLOWLIST`, `tools/doc-lint.mjs:70-83` — it already carries `cordis.yml`, `map.md`, and the tracker folder shorthands for the same reason). No entry covered this slot name.

This was a real gate failure, not pre-existing rot: the failure arrived with the ADR commit and would have been pushed broken.

## What to do

1. Add `.scratch/racoons-storage/` to `.gitignore` beside the other `.scratch` entries, with a comment naming it as runtime ledger storage whose content is private.
2. Add `conversation.session.header.actions` to `PATH_ALLOWLIST` with a written reason (a dsh client slot name, not a repo path) — the data-driven extension point the tool documents.

## Acceptance

- [x] `git status` no longer lists `.scratch/racoons-storage/` as untracked.
- [x] `node tools/doc-lint.mjs` reports 0 findings.
- [x] `node tools/doc-lint.mjs --self-test` still passes 38/38.
- [x] `npm run typecheck` green.
- [x] `npm test` green (1693/1693).

## Constraints

- No source behavior changes: both fixes are configuration and tooling.
- The allowlist entry must stay narrow — the exact slot string, not a pattern that would exempt real paths.
- `.scratch/racoons-storage/` content is left on disk untouched; ignoring it does not delete it.

## Comments

**2026-10-28 — resolved.** Both fixes applied; gates re-run green (typecheck; tests 1693/1693; doc-lint 0 findings; doc-lint self-test 38/38; issue-index and adr-index fresh). The untracked directory is still on disk for the launcher's next run — only its git visibility changed.

Pruning note: both local branches (`ticket-154-copy-review` at `115ec19`, `ticket-154-finish` at `5dbf04c`) were verified fully merged into `main` before deletion (`git branch --merged main` listed both; `git log main..<branch>` was empty). Their commits stay reachable through `main`.
