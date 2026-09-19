# 89 — Delete the retired capsule source assets (post-cutover dead code)

**Status:** open
**Labels:** needs-triage
**Blocked by:** none
**Related:** 65/66/73 (this is the disposition lane's surviving follow-up — the tickets
themselves are cancelled, subsumed by the shell), 78 (the cutover that retired the vehicle),
81 (assigned its unrendered-toolview question to this disposition), 49 (token theming —
constraint if any retained component survives)

## Problem

Ticket 78's cutover (commits `94e6127`, `a44084a`, `c437ee8`, 2026-09-19) retired the
capsule and staging-launcher registrations: the wrapper shell frame is now the dynamic
`root` entry, and no `shell.overlay` registration remains. The sources were deliberately
RETAINED as re-host assets, with dead-code disposition assigned to the then-open 65/66/73
lane (`src/client/index.ts` module comment; ticket 78's cutover notes). The 2026-09-19
65/66/73 disposition cancelled all three as subsumed by the shell — leaving the retained
assets with no owner. This ticket is that disposition: delete what nothing consumes, keep
what the live composition still uses.

## Verified asset state (2026-09-19, pre-work inventory)

Dead or vestigial (git-tracked, candidates for deletion):

- `src/client/capsule.tsx` (~387 lines) — ZERO importers in `src/` or `test/`.
- `src/client/capsule-store.ts` (~529 lines) — vestigial: `CapsuleStore` is constructed in
  `apply`/`applyClientModule` but no method is ever called on it; `CapsuleFooterStore` is
  still fed by the settings watch (`footer.applyChannelValue`) but rendered by NOTHING
  (its only renderer was capsule.tsx). `actions.ts` imports only the
  `CapsuleActivationIntent` type from it.
- `capsule.*` locale keys in `src/client/overlay.ts` (~21 keys × en+zh ≈ 42 lines) — no
  live renderer consumes them; `actions.ts`'s `CAPSULE_ACTION_*` /
  `CAPSULE_STOP_MESSAGE_KEY` constants referencing them are themselves consumed only by
  `test/client-capsule-actions.test.ts` (the live conversation pane has its own
  `shell.conv.*` copy).
- `src/client/shell.tsx`: `createShellLauncher` + `SHELL_LAUNCHER_CSS` +
  `SHELL_LAUNCHER_CLASS` — the retired staging chip, zero consumers.
- `src/client/shell-mount.ts`: launcher-only contracts (`SHELL_LAUNCHER_ENTRY_ID`,
  `SHELL_LAUNCHER_OVERLAY_ORDER`, `shellLauncherRegistration`, `createShellLauncherLayout`)
  — consumed only by `test/client-face-scaffold.test.ts`. CAREFUL: keep the LIVE main-page
  contracts (`SHELL_PAGE_KEY`, `shellPageRegistration`, `openShellPage` if still bound) —
  the `main` page registration STAYS per 78's pinned staging contract (dormant behind the
  frame election, self-restoring on abdication).
- `src/client/index.ts`: dead `capsule`/`footer` parameters of `applyClientModule`, the
  `footer.applyChannelValue` feed, and the launcher/staging remnants.
- Tests: `test/client-capsule-chip.test.ts`, `client-capsule-activation.test.ts`,
  `client-capsule-composition.test.ts`, `client-capsule-actions.test.ts` (plus the
  launcher-layout assertions in `client-face-scaffold.test.ts` and the
  `createCapsuleFooterStore` default in `client-onboarding.test.ts`) — retire or adapt
  with the sources they pin.

Verify-while-there (flagged by ticket 81, riding this same disposition): post-cutover the
five `tool.call.toolview` slot entries (ticket 24) are registered but UNRENDERED — the
frame displaces the host chat and 80's conversation pane renders tool rows from the event
window. Confirm and include their retirement in this same sweep if still true.

## Constraints

- Deletion only — NO rebuild, no behavior change: the shell surface is untouched; gates
  after the sweep are the standard offline ones (`npm test`, `npm run typecheck`,
  `npm run build:client`).
- One vocabulary rule: if any `capsule.*` copy is still the best wording for a live
  surface, MOVE the key rather than duplicate it (ticket 79's shared-`roster.blocked.*`
  discipline).
- Keep the module-comment history honest: update `src/client/index.ts`'s numbered
  registration list (items 3 and 6 are already struck through as retired) to record the
  deletion instead of "retained as assets".

## Acceptance criteria

- [ ] `capsule.tsx` / `capsule-store.ts` deleted; no `src/` or `test/` reference remains
      (grep clean for `capsule` outside historical comments/ADR docs).
- [ ] Dead `capsule.*` locale keys and launcher contracts removed; live main-page
      contracts intact and still registered.
- [ ] `applyClientModule` signature and the settings watch lose the vestigial feeds;
      toolviews (24) either stay (with a recorded live-consumer justification) or go per
      the verify-while-there finding.
- [ ] Gates green offline; no live pass required for a pure deletion (unless toolviews
      are removed, in which case one trivial-task live smoke under ticket 33's rules).
