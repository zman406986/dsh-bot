# 95 — Packaging hygiene: MIT LICENSE, `prepack` builds the client into the tarball, repository/homepage/bugs metadata

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 33 (the closeout umbrella), 89 (the retired-capsule cleanup that
preceded this packaging pass)

## Description

One packaging-hygiene commit on branch `wt/hygiene` (tip `6c14567`): an MIT
`LICENSE` file added at the repo root; a `"prepack": "npm run build:client"`
hook in `package.json` so that `npm pack` rebuilds the client bundle first and
the published tarball actually contains the built `client/index.js` (not a
stale or missing one); and `repository` / `homepage` / `bugs` metadata added
to `package.json`. No product code changed — the commit touches only
`LICENSE` (+21 lines) and `package.json` (+11/−1). Merged to main with
`--no-ff` at `9b5da8a`.

## Acceptance criteria

1. (offline) `LICENSE` exists at the repo root and `package.json` carries
   `prepack`, `repository`, `homepage`, `bugs`.
   **DONE 2026-09-19** — commit `6c14567` (merge `9b5da8a` on main).
2. (offline) `npm pack --dry-run` produces a tarball containing the built
   artifacts: **180 files**, including `package/LICENSE` and
   `package/client/index.js`, and **no** `src/` or `test/` paths.
   **DONE 2026-09-19** — recorded from the packaging run of `6c14567`.
3. (offline) Gates on main after the merge are green with exact numbers.
   **DONE 2026-09-19** — `npm run typecheck` clean (both configs);
   `npm test` **1103 tests / 269 suites / 0 fail** at `9b5da8a`.

## Comments

- **2026-09-19 (wind-down agent) — this ticket was filed RETROACTIVELY, after
  the change had already been implemented, committed, and merged.** The
  project rule is "always log an issue before implementing anything"; the
  packaging commit `6c14567` landed without one. This file is the honest
  bookkeeping for that miss: the implementation predated its ticket, and no
  number was reserved in advance. The rule applies even to small changes —
  file first, then implement.
