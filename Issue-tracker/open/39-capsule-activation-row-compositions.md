# 39 — Capsule expanded panel: activation row + dormant vs activated compositions (epic 35 §1)

**Status:** open
**Labels:** ready-for-agent
**Epic:** 35
**Blocked by:** 38 (the expanded panel surface and store exist).

## Context

Epic 35 §1: the expanded panel's top section is the activation row, reflecting
the real per-session `/dispatcher-start` state (ADR-0009). Dormant
composition = the unactivated chat's whole experience (chip visible, panel
shows the activation pitch, nothing else pretends to run — ticket 32's dormant
copy). Activated = active-state row + the roster sections below.

**Known tension, resolved here (do not reopen):** the epic's active-state
"stop affordance" cannot be a direct kill/deactivate control — no
off-while-running exists (ADR-0005/0009 discipline; design-17 §3.2/§4.6;
ticket 31 ships a no-stop-control guard). The affordance is therefore a
**stop intent**: it renders honest conversational-stop copy and hands the
intent to a callback; ticket 40 binds it to the same user-verbatim command
path as everything else. No second activation/deactivation channel is invented.

**Tree rule:** same as ticket 38 (worktree branch until 33 merges).

## Requirements

- Activation row at the top of the expanded panel, derived from existing
  channel truth only:
  - **Dormant** — no activation observed (store `waiting`); single
    "Start dispatcher in this chat" affordance (a button that calls an
    injected `onActivationIntent("start")` callback — wiring is ticket 40).
  - **Active** — fresh snapshot; shows the active state and a stop intent
    affordance (`onActivationIntent("stop")`). A since-timestamp only if the
    adapter can provide an honest `activatedAtMs` (snapshot bump) — never
    present `publishedAtMs` as "active since"; if not added, omit the
    timestamp and record the gap in the ticket comment.
  - **Error/degraded** — stale/invalid/channel-missing: the row shows the
    honest unavailable copy; no start/stop affordance pretends otherwise.
- Dormant composition: roster sections hidden; the panel is the activation
  pitch (reuse ticket 32's dormant copy; new locale keys only where needed).
- Activated composition: activation row + existing sections below.
- The panel component factory gains the intent callback parameter (factory
  injection, same pattern as the translate seat); default no-op keeps the
  component render-only.
- Extend ticket 31's no-stop guard to the capsule view models: no view-model
  field offers direct worker-kill/deactivate authority; the stop affordance is
  an intent, structurally asserted.
- Locale keys (start/stop affordance labels, since-line if shipped) in BOTH
  faces; validator green; no literals.

## Acceptance criteria

- [x] Composition matrix tested (extend `test/client-capsule-chip.test.ts` or
      new `test/client-capsule-activation.test.ts`): each store kind maps to
      exactly one composition; dormant hides sections; activated shows row +
      sections; error state shows unavailable copy with no actionable
      start/stop affordance.
- [x] Intent callback invoked with the exact payload per affordance; default
      no-op keeps rendering pure.
- [x] No-stop guard extended: structural assertion that capsule view models
      carry no direct stop/deactivate control field.
- [x] Locale validator green; `npm test` 0-fail; `npm run typecheck` clean;
      `npm run build:client` green; host face untouched
      (`test/activation-lifecycle.test.ts` still green).

## Verification

Named method: `npm test` (new/extended capsule suites + existing
`activation-lifecycle`, `stop-semantics`, `client-roster-panel` regressions),
`npm run typecheck`, `npm run build:client`. Browser assertion deferred to
ticket 33.

## Comments

### 2026-09-18 — agent team (implementation, worktree `clone/always-on-dispatcher` @ `fc0434e`)

All ACs checked. Worktree commit `fc0434e` ("Ticket 39: capsule activation row +
dormant/activated compositions"), 6 files (1 new). **Gates** (worktree, all
green): `npm test` **645 pass / 0 fail / 170 suites** (delta over the ticket-38
baseline 630/0/167 is exactly the 15 new tests in 3 new suites; the pre-existing
suites pass untouched), `npm run typecheck` clean on both configs,
`npm run build:client` green (46451-byte bundle). Offline only (S8); host face
untouched.

What landed:
- **Activation-row view model** (`src/client/capsule-store.ts`):
  `describeCapsuleActivationRow(state, nowMs, windowMs?)` maps every store kind
  to exactly one composition with the chip's exact truth rules — `waiting` →
  `dormant` (state line `capsule.dot.dormant` + start affordance); fresh
  snapshot (empty included) → `activated` (`capsule.dot.active` + stop intent);
  stale/`invalid`/`channel-missing` → `unavailable` (`capsule.dot.error`,
  affordance `null`). Freshness shares `isRosterSnapshotStale` and the default
  window; exactly-at-window stays fresh.
- **Intent seat**: `CapsuleActivationIntent = "start" | "stop"`,
  `OnActivationIntent` callback type, `noopOnActivationIntent` default,
  `dispatchActivationIntent(affordance, cb)` — the whole click behavior as a
  pure named function. The affordance carries ONLY `{intent, labelKey}` — no
  handler/handle/command field.
- **Component** (`src/client/capsule.tsx`): `createDispatcherCapsule` gained
  the 4th factory-injected `onActivationIntent` parameter (default no-op —
  render-only until ticket 40). Expanded card renders the activation row:
  state line + (dormant only) pitch body + the one affordance button; the
  ticket-28 `<Panel/>` sections render ONLY in the activated composition.
  Namespaced static CSS added (no animation — chip CSS contract holds).
- **Copy** (`src/client/overlay.ts`, both faces, validator green; key-set pin
  in `client-face-scaffold.test.ts` extended): `capsule.activation.start`
  ("Start dispatcher in this chat" — the ticket's exact phrasing),
  `capsule.activation.stop` ("Ask the dispatcher to stop" / 「请求调度器停止」 —
  honest conversational ask, never kill phrasing),
  `capsule.activation.pitch` (dormant pitch body). Row state lines REUSE the
  `capsule.dot.*` keys (ticket 32's dormant copy) — no duplicates.
- **No-stop guard extended** (`test/restart-honesty.test.ts`, ticket 31's
  guard): over every store kind, both capsule view models are (a) exact
  deep-equal against the closed three-shape canon (no extra field can ride
  along), (b) key-scanned for
  /stop|cancel|kill|abort|deactivate|interrupt|terminate|destroy/ — zero
  offenders, and (c) value-scanned: the literal `"stop"` may only appear as
  the value under the `intent` payload key.
- **Tests**: new `test/client-capsule-activation.test.ts` (14 cases / 3
  suites): composition matrix (total/deterministic, all three compositions
  exercised, stale-boundary mirrored), affordance pairing, exact intent
  payloads through `dispatchActivationIntent`, default no-op + factory shapes,
  locale contract.

Deviations / recorded gaps (honest, per ticket):
- **"Active since" timestamp NOT shipped.** The snapshot carries only
  `publishedAtMs` (forbidden as "active since") and there is no honest
  `activatedAtMs` in existing channel truth; adding one would be a
  snapshot-contract change beyond this ticket's "existing channel truth only"
  rule. The field is omitted entirely from the view model — nothing
  half-shipped. Ticket 40/41 or a snapshot-v3 decision can add it.
- **Unavailable composition also hides sections** (row's honest line is the
  whole panel) — the degraded panel body would only repeat the same
  unavailable copy; the ticket text only mandates sections for `activated`.
- **Fresh empty snapshot → activated** (not dormant): consistent with ticket
  38's chip decision ("activation observed, no workers"); not reopened here.
- **Intent invocation is pinned one seam out** (S8, no DOM harness, unchanged
  discipline): the component's `onClick` is exactly
  `dispatchActivationIntent(affordance, onActivationIntent)`; the exact
  payload, the default no-op, and the factory injection shapes are asserted
  offline. Actual click-through rendering is ticket 33's browser pass; host
  binding is ticket 40.

For tickets 40–42: the intent seat is unbound (no-op); ticket 40 injects the
real transport at `src/client/index.ts` composition time; the pitch/stop copy
keys exist in both faces for its degrade UX; deliverables line (41) and footer
(42) still absent.
