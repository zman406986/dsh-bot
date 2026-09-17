# 41 — Capsule deliverables line: completed-but-not-delivered count + most recent result excerpt (epic 35 §3)

**Status:** resolved
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

- [x] `test/roster-snapshot.test.ts` extended (if (a)): v3
      parse matrix — v3 round-trips; v1/v2 and malformed payloads fail parse to `null`; excerpt
      clamped to the constant; field cleared at the delivered transition.
- [x] Store/view tests: count math over terminal×delivered combinations;
      expansion state; the delivered-flip clears the line; (b)-branch hides
      the excerpt affordance entirely. *(Shipped (a); the count-only degrade
      inside (a) is the tested equivalent — a landed row with no honest
      excerpt yields `excerpt: null`, so no expand affordance exists to render.)*
- [x] Adapter projection test: publish carries the excerpt from the wake
      report (a) or omits it (b) — no new core state introduced (grep-able
      claim in the ticket comment). *(Composed of three suites; see comment
      note 2 for the plugin-level nuance.)*
- [x] `npm test` 0-fail; `npm run typecheck` clean; `npm run build:client`
      green.

## Verification

Named method: `npm test` (`roster-snapshot`, `client-capsule-chip` /
deliverables suite, `client-roster-panel` regressions), `npm run typecheck`,
`npm run build:client`. Browser assertion deferred to ticket 33.

## Comments

### 2026-09-18 — agent (implementation, worktree `clone/always-on-dispatcher` @ `883ac0f`)

**Mechanism: (a) — snapshot v3 fail-closed, excerpt sourced adapter-side at
publish time.** The adapter (`createCordisDshHost`) is the code that builds
`SettledEvent` from dsh's `subagent/end` payload, so the report text is in
adapter hands at settle-emit time. It now holds a bounded excerpt per
settled worker (`host.recentResult(workerId)`, clamped once at observation
via the new `clampRecentResultExcerpt` / `RECENT_RESULT_EXCERPT_CHARS = 200`,
total length including the ellipsis ≤ the constant) — the same discipline as
ticket 29's `workerActivity` firehose map. `projectRosterSnapshot` gained an
optional `recentResultOf` seat; `ROSTER_SNAPSHOT_SCHEMA_VERSION` 2→3;
`recentResult: { workerId, title, text } | null` on the envelope, picked
among terminal-undelivered rows by latest `settledAtMs` (ties → later roster
position), `null` when nothing is owed or no honest text exists. **No new
core state** (grep-able): `src/plugin.ts` ("No new core state holds report
text"), `src/adapter/cordis-dsh-host.ts` ("the core stores no report text
and no second transcript exists"), `src/core/roster-snapshot.ts` ("never a
second source of truth"; projection-only seat). The core never stores report
text; the excerpt is read at publish time and mirrored, nothing more.

**Fail-closed:** parse accepts only `schemaVersion === 3`; v1 AND v2 payloads
fail to `null` (the design-17 §4.1 rule accepted for v1→v2, applied
unchanged). `recentResult` is a REQUIRED key on a v3 envelope — a missing
key, wrong shape, empty text, or text longer than the constant fails the
whole snapshot to `null` (unbounded strings are corruption, never clamped
silently at parse). Old clients reading v3 degrade to `invalid` →
"unavailable" exactly as before.

**Client:** pure `describeCapsuleDeliverables` in `capsule-store.ts` — the
count is the chip's existing settled-undelivered wake math (shared, never a
second tally); visible only on a fresh snapshot with count > 0; excerpt
rides verbatim from the snapshot. The line renders in the expanded card
between the roster and the (ticket-42) footer; the expand/collapse state
(`toggleDeliverables`) rides the capsule store's box; a landed row without
an honest text (post-restart restore — markers deliberately carry no report
text) renders count-only. Locale keys `capsule.deliverables.{label,count,
expand,collapse}` in both faces; validator green; ticket 42 untouched.

**Files (worktree):** `src/core/roster-snapshot.ts`, `src/core/report-clamp.ts`,
`src/adapter/cordis-dsh-host.ts`, `src/plugin.ts`, `src/client/capsule-store.ts`,
`src/client/capsule.tsx`, `src/client/overlay.ts`; tests:
`test/roster-snapshot.test.ts` (v3 matrix: round-trip, v1/v2/malformed/
unbounded → null, clamp, delivered-transition clear, most-recent pick),
`test/adapter-cordis-dsh-host.test.ts` (seat: visible inside the settle
callback, clamp, empty-abort → null, dispose clears), `test/client-capsule-chip.test.ts`
(deliverables view-model + store + locale suites), `test/client-face-scaffold.test.ts`
(key list), plus v3 fixture updates in `client-capsule-activation` /
`client-capsule-actions` / `client-roster-panel` / `restart-honesty`.

**Gates (worktree):** `npm test` 686 pass / 0 fail (180 suites);
`npm run typecheck` clean; `npm run build:client` green (client\index.js,
60,978 bytes). Legal grep clean (only the S7 guard tests name the banned
identifiers).

**Notes / deviations:**

1. **Excerpt source is the adapter's settle observation, not `wakeBus.peek`.**
   The core's settle handler runs `transition()` (which fires the roster
   observer → the publish) BEFORE `enqueueWorkerSettled`, so peeking the bus
   at publish time would miss the very settle that triggered it. The adapter
   constructs the settle event itself and stamps/clamps at observation, so
   the settle-triggered publish always sees the text. Honest consequence:
   after a restart, restored landed rows have no excerpt (markers carry no
   report text by design) — the line degrades count-only.
2. **Plugin-level publish test asserts `recentResult: null` for its settle.**
   The shipped tool surface has no ledger-creation entry (`spawn_worker`'s
   `todo_id` only links a pre-existing ledger item; `linkWorker` returns
   false for unknown ids), so a tool-spawned worker projects `delivered:
   true`, owes nothing, and the excerpt is rightly withheld. The AC's
   positive claim is therefore composed of three suites: the adapter seat
   suite (excerpt present inside the settle-triggered publish window), the
   projection suite (seat text → published `recentResult`), and the plugin
   publish test (the real channel carries the v3 envelope with the field).
   No new core state holds the text at any point.
3. **(b)-branch n/a** — (a) shipped; the count-only degrade inside (a) is
   the tested equivalent (excerpt `null` → no expand affordance).
4. Browser assertion deferred to ticket 33 per this ticket's Verification.

### 2026-09-18 — resolved

Resolved by overnight sweep: offline ACs verified (independent verifier PASS); implementation on clone/always-on-dispatcher @ 883ac0f. Live browser assertion reserved to ticket 33 / epic 35.
