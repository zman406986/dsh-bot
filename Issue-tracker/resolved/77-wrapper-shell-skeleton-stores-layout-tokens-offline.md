# 77 — Wrapper shell skeleton: session store, layout component, tokens (ADR-0020 slice 1)

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none (ADR-0020 drafted; this is its first implementable slice)
**Related:** 67 (parent), ADR-0020 (the vehicle decision), 49 (token discipline), 28 (hosted sections)

## Problem

ADR-0020's shell does not exist. This slice lands the offline-verifiable skeleton: the
dispatcher-session store, the three-pane layout component, and the styling contract — no live
registration, no behavior change to the running capsule.

## Acceptance criteria

- [x] `DispatcherShellStore` (pure, offline): upsert dispatcher-session rows; attach per-session
      presence summaries (working / needs-you / finished counts) derived from our roster
      snapshot shape; selection transitions (select known id; unknown id refused, not invented);
      a stable, documented row order; a `describeShell` view model. Tests in the existing
      node:test style.
- [x] Shell layout component factory (zero rendering asserts — build + typecheck cover render,
      same discipline as the panel): sidebar rows, main surface seat, right-panel seat that
      HOSTS the existing roster panel component (`createRosterPanel`) for the selected session —
      hosted, not rebuilt. Pane-selection logic is a pure, tested function.
- [x] Styling: namespaced classes, colours only via `--dsw-*` host tokens (ticket 49's test
      pattern extended to the shell CSS); no new animation; reduced-motion safe by construction.
- [x] Locale: `shell.*` copy keys in BOTH dictionary faces; `validateLocaleDictionary` clean;
      no verbatim reference text (B9).
- [x] `npm test` + `npm run typecheck` green; capsule/overlay path untouched.

## Constraints

- Offline only (S8). The live binding (`ctx.sessions` feed) is deliberately NOT here.
- Host design tokens; no private palette (ticket 49).

## Comments

### 2026-09-19 — agent (implemented in the 67 vehicle pass, commit 518030b)

- Store: `src/client/shell-store.ts` — `createDispatcherShellStore` (tri-state upserts: an
  omitted `dispatcher` field never clobbers the known flag; junk rows refused), selection that
  refuses unknown ids, no-ops on re-select, and resets when the selected session is removed;
  presence via the panel's own `rosterSectionFor` (one partition rule, never a second);
  `applyPresence` attaches only to the session the snapshot names; `markPresenceUnavailable`
  degrades to honest `null` (never fabricated zeros). View models: `describeShellSidebar`
  (dispatcher rows first, stable insertion order), `describeShellPanes` (pure).
- Component: `src/client/shell.tsx` — `createDispatcherShell(t, store, hosts)`: three-pane
  frame; the right seat hosts the existing `createRosterPanel` via `hosts.rosterPanel`
  (hosted, not rebuilt); the main surface renders the honest "conversation surface not wired
  yet" locale line until ticket 80. Render covered by build + typecheck per the S8 discipline.
- Tokens/CSS: `SHELL_CSS` pinned by test — no raw colour literals, only the evidenced token set
  (`bg-layer-1/3`, `border-l3`, `label-tertiary`, `state-*`), every class
  `multitask-dispatcher-` prefixed, zero animation.
- Locale: nine `shell.*` keys in BOTH faces; `validateLocaleDictionary` clean; the pinned key
  list in `test/client-face-scaffold.test.ts` extended.
- Gates: `npm test` 826 pass / 0 fail (212 suites); `npm run typecheck` clean; build:client
  green. Capsule/overlay path untouched (no live registration — that is ticket 78).
