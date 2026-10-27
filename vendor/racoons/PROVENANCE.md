# Vendored racoons — provenance

- Upstream repo: `C:\Users\TZhen\Desktop\racoons` (branch `main`)
- Upstream commit: `b5f95cbbd6f2dff8b25fce4c0208050ecd6fa2e6`
- Commit subject: `060: paper amendments — the six-page draft records the settled set and the recall source lane`
- Upstream commit date: 2026-10-27
- Copy date: 2026-10-27
- Re-sync date: 2026-10-27 — re-synced from `70c99ef64056d517708fd0a5d70c71310700ff34` to
  `b5f95cbbd6f2dff8b25fce4c0208050ecd6fa2e6` (ticket 148). The range is 259 commits, 50 of them
  touching vendored paths; the source diff for `packages/core/src` + `packages/adapters/dsh/src` +
  `LICENSE` is 101 files, +8475/−3560. Every vendored source file was verified byte-identical to
  `b5f95cb` at copy time.

## Copy discipline

The copy was taken from the pinned commit, never from the upstream working tree:
`git -C <clone> -c core.autocrlf=false -c core.eol=lf archive b5f95cb… packages/core/src
packages/adapters/dsh/src LICENSE | tar -x -C <staging>` and then a flat copy into `vendor/racoons`.
Each staged file was byte-compared (`cmp`) against `git cat-file -p b5f95cb:<path>` before it landed,
so no working-tree state can enter the vendor. The upstream clone keeps moving while work is in
flight (it committed four more commits during ticket 148's own life), so the pin — not "whatever
`HEAD` is now" — is what these files match.

The `autocrlf=false, eol=lf` override matters: this repo and the clone both set
`core.autocrlf=true`, so a plain `git archive` would write CRLF and diverge from the committed
blobs. Vendored sources are LF, matching the upstream blobs byte for byte.

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

1. Pin upstream: in `C:\Users\TZhen\Desktop\racoons`, record `git rev-parse HEAD`
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
