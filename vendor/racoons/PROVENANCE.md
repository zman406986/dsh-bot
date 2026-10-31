# Vendored racoons — provenance

- Upstream repo: a local checkout of the racoons repo, next to this repo on the owner's machine
  (branch `main`)
- Upstream commit: `b838ae79203767a8c92232b7d04664a1151b015a`
- Commit subject: `record: the pair — both arms crossed the trigger for the first time`
- Upstream commit date: 2026-10-29
- Copy date: 2026-10-29
- Re-sync date: 2026-10-29 — re-synced from `b5f95cbbd6f2dff8b25fce4c0208050ecd6fa2e6` to
  `b838ae79203767a8c92232b7d04664a1151b015a`. The range is 62 commits
  (`git rev-list --count b5f95cb..b838ae7`), 13 of them touching vendored paths
  (`git rev-list --count b5f95cb..b838ae7 -- packages/core/src packages/adapters/dsh/src LICENSE`);
  the source diff for `packages/core/src` + `packages/adapters/dsh/src` + `LICENSE` is 30 files,
  +540/−413 (`git diff --shortstat b5f95cb b838ae7 -- <those three paths>`), split 23 files
  +382/−296 in `packages/core/src` and 7 files +158/−117 in `packages/adapters/dsh/src`, with
  `LICENSE` unchanged. No files were added upstream in the range; two were deleted
  (`packages/core/src/rules/evict.ts`, `packages/core/src/rules/span.ts`). Every vendored source
  file was verified byte-identical to `b838ae7` at copy time.
- Previous re-sync: 2026-10-27 — `70c99ef64056d517708fd0a5d70c71310700ff34` to
  `b5f95cbbd6f2dff8b25fce4c0208050ecd6fa2e6` (ticket 148). That range was 259 commits, 50 of them
  touching vendored paths; the source diff was 101 files, +8475/−3560.

## Copy discipline

The copy was taken from the pinned commit, never from the upstream working tree:
`git -C <clone> -c core.autocrlf=false -c core.eol=lf archive b838ae7… packages/core/src
packages/adapters/dsh/src LICENSE | tar -x -C <staging>` and then a flat copy into `vendor/racoons`.
Each staged file was byte-compared against `git cat-file -p b838ae7:<path>` before it landed,
so no working-tree state can enter the vendor. The upstream clone keeps moving while work is in
flight, so the pin — not "whatever `HEAD` is now" — is what these files match. At re-sync time the
upstream working tree was dirty; nothing was read from it.

The `autocrlf=false, eol=lf` override matters: this repo and the clone both set
`core.autocrlf=true`, so a plain `git archive` would write CRLF and diverge from the committed
blobs. Vendored sources are written LF, matching the upstream blobs byte for byte. That is the
committed state, not the on-disk state: with `core.autocrlf=true` this repo's own checkout
expands them to CRLF in the working tree, so a raw on-disk hash never matches the pin — compare
`git hash-object -- vendor/...` (clean-filtered) or re-hash against the blobs, as the re-sync does.

## What was copied

| Upstream path | Vendored path |
|---|---|
| `packages/core/src/**` | `vendor/racoons/core/**` |
| `packages/adapters/dsh/src/**` | `vendor/racoons/adapter/**` |
| `LICENSE` (repo root) | `vendor/racoons/LICENSE` |

Both source trees are copied flat: `packages/core/src/index.ts` becomes
`vendor/racoons/core/index.ts`, and `packages/adapters/dsh/src/index.ts` becomes
`vendor/racoons/adapter/index.ts`. Source is TypeScript only; no other assets
were copied.

The copy is a full rebuild of the tree, not an update of the files that happen to exist. At the
`b838ae7` re-sync, 144 files were copied and 2 vendored files were deleted because upstream deleted
them: `vendor/racoons/core/rules/evict.ts` and `vendor/racoons/core/rules/span.ts`. An
update-only copy would have left both behind.

## Host-owned files (not upstream)

These files exist only in this repo and are maintained by hand for the vendored
build. Do not expect them in upstream, and do not overwrite them from upstream:

- `vendor/racoons/core/package.json` — `@racoons/core` 0.1.0, private, exports `"."` only
- `vendor/racoons/core/tsconfig.json` — compiles flat sources to `lib/`
- `vendor/racoons/adapter/package.json` — `racoons-dsh` 0.1.0, private, exports `"."` and `"./plugin"`
- `vendor/racoons/adapter/tsconfig.json` — compiles flat sources to `lib/`
- `vendor/racoons/PROVENANCE.md` — this file

Upstream manifest names differ on purpose: upstream emits to `dist/` and ships a
different `exports` map; the vendored manifests point at `lib/` to match this
repo's build.

## How to re-sync

Do not use upstream's `resync-vendor.mjs`: it has a wrong hardcoded target and
only updates files that already exist, so it silently leaves stale files behind.

1. Pin upstream: in the local racoons checkout, record `git rev-parse HEAD`
   and copy from that hash, not from the working tree (upstream is often dirty
   and is often still moving).
2. Delete `vendor/racoons` entirely (including untracked `lib/` build output),
   after stashing the host-owned files outside the tree.
3. Full copy from the pin, with line-ending conversion disabled so the bytes match
   the committed blobs:
   `git -C <clone> -c core.autocrlf=false -c core.eol=lf archive <hash>
   packages/core/src packages/adapters/dsh/src LICENSE | tar -x -C <staging>`,
   then `packages/core/src/**` -> `vendor/racoons/core/`,
   `packages/adapters/dsh/src/**` -> `vendor/racoons/adapter/`, upstream root
   `LICENSE` -> `vendor/racoons/LICENSE`.
4. Byte-compare each staged file against `git cat-file -p <hash>:<path>` before it
   lands.
5. Restore the host-owned `package.json` / `tsconfig.json` files listed above
   (they are not upstream files).
6. Update `PROVENANCE.md` with the new hash, subject and copy date.
7. Run `npm install` at the repo root, then `npm run build:vendor`.
