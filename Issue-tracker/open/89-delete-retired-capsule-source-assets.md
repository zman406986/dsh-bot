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

## Comments

### Handover 2026-09-19 (session end)

The deletion agent was cancelled mid-flight. Its uncommitted work was **kept, not reverted**: `npm run typecheck` clean (both configs), `npm test` **1044 pass / 0 fail** (256 suites), `npm run build:client` green (161,087 B) — frozen as **`d25d6ef`** ("Ticket 69/89: WIP checkpoint from cancelled agent … tests green"). Worktree clean at session end. The sweep looks **offline-complete** against the corrected inventory, but the ACs above are deliberately left **unticked**: tick them only after the read-through below (this comment asserts only what the gates prove).

**Corrected inventory (supersedes the pre-work list's undercount — read this first):** the deleted tuple was the 4 capsule test files (`client-capsule-chip`, `client-capsule-activation`, `client-capsule-composition`, `client-capsule-actions`), PLUS **4 further test importers the pre-work inventory missed** — `test/client-theme-tokens.test.ts` (carried the `CAPSULE_CSS` token assertions), `test/restart-honesty.test.ts` and `test/composition-polish.test.ts` (both imported `capsule-store`), and `test/client-onboarding.test.ts` (`createCapsuleFooterStore` default). All four were adapted, not deleted. **Main-page contracts must stay live** — confirmed intact in `d25d6ef`: `SHELL_PAGE_KEY`, `shellPageRegistration` (still registered, `index.ts:417`), `MAIN_PAGE_SLOT`/`SHIPPED_MAIN_PAGE_KEY` and every `root`-election contract; only the launcher/staging remnants (`SHELL_LAUNCHER_*`, `createShellLauncher`, `shellLauncherRegistration`, `createShellLauncherLayout`, `openShellPage`) went.

**State left in the tree:** `capsule.tsx` (387 lines) and `capsule-store.ts` (529) deleted; `capsule.*` locale keys removed from `overlay.ts`; launcher code removed from `shell.tsx`; launcher-only contracts removed from `shell-mount.ts`; `applyClientModule`/the settings watch lost the capsule/footer parameters and the footer feed (`actions.ts`, `index.ts`); `index.ts`'s numbered module comment now records the deletion (items 3/6) instead of "retained as assets"; `grep` for `capsule`/`CAPSULE_CSS` over `src/` + `test/` is clean outside historical comments/ADRs. **Not verified within this sweep:** the verify-while-there toolview finding (five `tool.call.toolview` entries possibly unrendered post-cutover) — no claim made either way.

**Successor next steps:** (1) read `src/client/index.ts:390-470`, `shell-mount.ts` and `shell.tsx`, then tick ACs 1–2 if they match (evidence: `d25d6ef`, gates above); (2) settle AC 3's toolview clause — record a live-consumer justification or fold the retirement into a follow-up commit; (3) AC 4: a pure deletion needs no live pass (the optional trivial-task smoke applies only if toolviews are removed); (4) do NOT reintroduce `openShellPage`/launcher registrations — the `main` page stays dormant behind the frame election per ticket 78's pinned contract.
