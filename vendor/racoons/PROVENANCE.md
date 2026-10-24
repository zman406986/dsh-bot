# Vendored racoons — provenance

- Upstream repo: `C:\Users\TZhen\Desktop\racoons` (branch `main`; tracked files clean at copy time — the only dirty entries are `docs/plans/` and an untracked ledger, neither under `packages/`)
- Upstream commit: `70c99ef64056d517708fd0a5d70c71310700ff34`
- Commit subject: `035: item 10 design — critic fixes (verdict authority, W source, milestones, snapshot, labels)`
- Upstream commit date: 2026-10-24
- Copy date: 2026-10-24
- Re-sync date: 2026-10-24 — re-synced from `af78642e0a6154fc5fc26ef77aca6508382b198d` to `70c99ef64056d517708fd0a5d70c71310700ff34`. The re-sync covered a single changed source file, `packages/adapters/dsh/src/plugin.ts` (+10/−6 across commits `af78642..70c99ef`, landing commit `c05646b`), which flips the `nativeCompactionBackstop` default from `false` to `true` (owner ruling 2026-10-24). Every other vendored source file was verified byte-identical to `70c99ef`.

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

1. Pin upstream: in `C:\Users\TZhen\Desktop\racoons`, confirm `git status --short`
   is empty and record `git rev-parse HEAD`.
2. Delete `vendor/racoons` entirely (including untracked `lib/` build output).
3. Full copy: `packages/core/src/**` -> `vendor/racoons/core/`,
   `packages/adapters/dsh/src/**` -> `vendor/racoons/adapter/`, upstream root
   `LICENSE` -> `vendor/racoons/LICENSE`.
4. Restore the host-owned `package.json` / `tsconfig.json` files listed above
   (they are not upstream files).
5. Update `PROVENANCE.md` with the new hash, subject and copy date.
6. Run `npm install` at the repo root, then `npm run build:vendor`.
