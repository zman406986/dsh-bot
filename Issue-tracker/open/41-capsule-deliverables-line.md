# 41 — Capsule deliverables line: completed-but-not-delivered count + most recent result excerpt (epic 35 §3)

**Status:** open
**Labels:** ready-for-agent
**Epic:** 35
**Blocked by:** 38 (the expanded panel exists; the count math rides the same
store). Independent of 39/40.

## Context

Epic 35 §3: a deliverables line showing the count of todos
`completed`-but-not-`delivered` (S6 semantics: delivered means the user got
it) with the most recent result text, expandable. The **count** is derivable
today from snapshot v2 (terminal-status workers with `delivered === false`).
The **result text** has no honest client source: the mirror snapshot carries
flags, not text.

**Design constraint (do not violate):** presence/attention is a projection of
existing core truth only — no new core state machine (design-17 §5 conflict 8;
ADR-0010-reserved rule). The result text already exists core-side in the
wake/report path; the question is whether the adapter holds it at roster
publish time without new core state.

## Requirements

Decide, then implement one of:

- **(a) Default — snapshot v3 excerpt.** If the adapter can source the most
  recent result text at publish time from existing core truth (the landed
  report/wake text), extend the roster mirror snapshot to schema v3 with a
  bounded `recentResult` excerpt field (clamp via the `report-clamp.ts`
  pattern, bounded length constant). Defensive parse stays fail-closed: v1/v2
  payloads fail parse → panel degrades to unavailable (the rule design-17 §4.1
  already accepted for v1→v2). Bump `ROSTER_SNAPSHOT_SCHEMA_VERSION` 2→3 in
  `src/core/roster-snapshot.ts`; adapter projection sets the field; cleared
  when everything delivered.
- **(b) Fallback — count-only.** If no honest source exists without new core
  state, ship the count-only line, and record the excerpt as a documented gap
  in the ticket comment and the epic thread. Do NOT invent a push channel or a
  second data source.

Either way, client-side:

- Deliverables line in the expanded panel (between roster and footer; footer
  itself is ticket 42). Count > 0 renders the line; expandable to show the
  most recent excerpt; count 0 hides the line entirely.
- S6 visible proof: the line clears when `delivered` flips — assert the
  flip clears it.
- Locale keys (label, expand/collapse affordance, count phrasing) in BOTH
  faces; validator green.

## Acceptance criteria

- [ ] `test/roster-snapshot.test.ts` extended (if (a)): v3 parse matrix — v3
      round-trips; v1/v2 and malformed payloads fail parse to `null`; excerpt
      clamped to the constant; field cleared at the delivered transition.
- [ ] Store/view tests: count math over terminal×delivered combinations;
      expansion state; the delivered-flip clears the line; (b)-branch hides
      the excerpt affordance entirely.
- [ ] Adapter projection test: publish carries the excerpt from the wake
      report (a) or omits it (b) — no new core state introduced (grep-able
      claim in the ticket comment).
- [ ] `npm test` 0-fail; `npm run typecheck` clean; `npm run build:client`
      green.

## Verification

Named method: `npm test` (`roster-snapshot`, `client-capsule-chip` /
deliverables suite, `client-roster-panel` regressions), `npm run typecheck`,
`npm run build:client`. Browser assertion deferred to ticket 33.
