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

- [ ] Composition matrix tested (extend `test/client-capsule-chip.test.ts` or
      new `test/client-capsule-activation.test.ts`): each store kind maps to
      exactly one composition; dormant hides sections; activated shows row +
      sections; error state shows unavailable copy with no actionable
      start/stop affordance.
- [ ] Intent callback invoked with the exact payload per affordance; default
      no-op keeps rendering pure.
- [ ] No-stop guard extended: structural assertion that capsule view models
      carry no direct stop/deactivate control field.
- [ ] Locale validator green; `npm test` 0-fail; `npm run typecheck` clean;
      `npm run build:client` green; host face untouched
      (`test/activation-lifecycle.test.ts` still green).

## Verification

Named method: `npm test` (new/extended capsule suites + existing
`activation-lifecycle`, `stop-semantics`, `client-roster-panel` regressions),
`npm run typecheck`, `npm run build:client`. Browser assertion deferred to
ticket 33.
