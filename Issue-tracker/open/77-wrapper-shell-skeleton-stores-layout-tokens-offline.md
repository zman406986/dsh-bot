# 77 — Wrapper shell skeleton: session store, layout component, tokens (ADR-0020 slice 1)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none (ADR-0020 drafted; this is its first implementable slice)
**Related:** 67 (parent), ADR-0020 (the vehicle decision), 49 (token discipline), 28 (hosted sections)

## Problem

ADR-0020's shell does not exist. This slice lands the offline-verifiable skeleton: the
dispatcher-session store, the three-pane layout component, and the styling contract — no live
registration, no behavior change to the running capsule.

## Acceptance criteria

- [ ] `DispatcherShellStore` (pure, offline): upsert dispatcher-session rows; attach per-session
      presence summaries (working / needs-you / finished counts) derived from our roster
      snapshot shape; selection transitions (select known id; unknown id refused, not invented);
      a stable, documented row order; a `describeShell` view model. Tests in the existing
      node:test style.
- [ ] Shell layout component factory (zero rendering asserts — build + typecheck cover render,
      same discipline as the panel): sidebar rows, main surface seat, right-panel seat that
      HOSTS the existing roster panel component (`createRosterPanel`) for the selected session —
      hosted, not rebuilt. Pane-selection logic is a pure, tested function.
- [ ] Styling: namespaced classes, colours only via `--dsw-*` host tokens (ticket 49's test
      pattern extended to the shell CSS); no new animation; reduced-motion safe by construction.
- [ ] Locale: `shell.*` copy keys in BOTH dictionary faces; `validateLocaleDictionary` clean;
      no verbatim reference text (B9).
- [ ] `npm test` + `npm run typecheck` green; capsule/overlay path untouched.

## Constraints

- Offline only (S8). The live binding (`ctx.sessions` feed) is deliberately NOT here.
- Host design tokens; no private palette (ticket 49).
