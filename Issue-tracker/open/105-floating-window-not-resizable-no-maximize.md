# 105 — Floating window has a fixed 760×520 size — no resize, no maximize/restore affordance

**Status:** open
**Labels:** ready-for-agent
**Related:** 103 (resolved — the per-event-delta drag pattern to reuse), ADR-0021 (accepted — the floating-window vehicle this window rides)

## Problem

The human requests (2026-09-22, in-session, verbatim): *"floating-window should be allowed to be resized, with a maximize button like windows"*.

Today the window's size is written once at store creation and never mutated:

- `src/client/floating-window-store.ts:49` — the state field's own comment: "The window's size — fixed for now (no resize affordance is ticketed)".
- `src/client/floating-window-store.ts:83-84` — the constants `FLOATING_WINDOW_WIDTH = 760` / `FLOATING_WINDOW_HEIGHT = 520`, seeded into the initial state at `:153-154` and never written again: `open`, `close`, and `moveBy` all spread the existing width/height through, and no other writer exists under `src/client`.
- No resize or maximize code exists anywhere under `src/client` — the only `resize` in the client face is the unrelated composer textarea (`resize:vertical`, `src/client/conversation.tsx:88`).

The store face has position mutation (`moveBy`, `src/client/floating-window-store.ts:203-214`) but no size mutation, and the window component offers only drag + close (the titlebar's single button, `src/client/floating-window.tsx:196-205`). There is no way to make the window larger, smaller, or viewport-filling.

## What to do

- [ ] Add store mutation paths for width/height, mirroring the `moveBy` pattern (`src/client/floating-window-store.ts:203-214`): pure, clamped, immutable emit, and the same early-return-when-absorbed contract `moveBy` follows (pinned at `test/client-floating-window.test.ts:175-189` — a resize that changes nothing must not emit). Decide and document whether a size change re-clamps the position so the window stays reachable under `clampWindowPosition` (`:129-145`).
- [ ] Add edge/corner resize handles in `describeFloatingWindow` (`src/client/floating-window.tsx:172-214`), reusing the per-event-delta drag pattern (`beginDrag`, `:265-287`; the per-event-delta contract is pinned at `test/client-floating-window.test.ts:674-748` — each move feeds its OWN delta, no start-relative compounding).
- [ ] Add a Windows-style maximize/restore toggle button in the titlebar next to close (`floating-window.tsx:196-205`): maximize fills the viewport (respecting the clamp and `FLOATING_WINDOW_MARGIN`, `floating-window-store.ts:89`), restore returns the prior geometry (position AND size). Pure store transition, pinned offline.
- [ ] Keep the pinned child order in `describeFloatingWindow` (children[0]=style, [1]=titlebar, [2]=body/boundary; pinned at `test/client-floating-window.test.ts:844-894`) — append any handle elements AFTER the body, or update that structural pin deliberately with the change recorded in the test's own words.
- [ ] CSS goes in the inline `FLOATING_WINDOW_CSS` (`floating-window.tsx:85-96`): token-only (`var(--dsw-*)`, no raw colour literals), `multitask-dispatcher-fwin__*` class discipline, no animation.
- [ ] en+zh locale lockstep for any new accessible copy (e.g. maximize/restore aria-labels): one key in BOTH faces — `validateLocaleDictionary` (`src/client/overlay.ts:507-540`) enforces identical key sets.
- [ ] Update the deliberately-broken records (the "fixed for now" comment at `floating-window-store.ts:49`) and add offline pins for the resize math (store-level: grow, shrink, clamp, absorbed-no-op) and the maximize/restore toggle.
- [ ] `client/index.js` is a build artifact — run `npm run build:client` and include the regenerated file if tracked-git shows it changes.

## Constraints

- No new host seams — everything lives in our own client module (`floating-window-store.ts` + `floating-window.tsx`); the portal/DOM technique of ticket 100 is untouched.
- Token-only CSS; `multitask-dispatcher-fwin__*` class discipline; no animation.
- In-memory only: the store records no persistence (same posture as the window's position — a reload starts at the default size again); do not add storage while implementing.
- The store stays pure (geometry decided in the store; the component feeds pointer values and a viewport — the existing `describe*`/`moveBy` discipline).

## Comments

### 2026-09-22 — scribe session

Filed from the human's in-session request of 2026-09-22 (quoted verbatim in Problem). The scribe pass verified the cited facts by code reading only (no implementation): the size is seeded once at store creation and has no writer, the store face has no size mutation, and the only `resize` anywhere in the client face is the composer textarea's. The implementer should reuse the two recorded contracts rather than inventing new ones: `moveBy`'s clamp-and-early-return discipline at store level, and the per-event-delta drag rule at component level (ticket 103's fix, pinned at `test/client-floating-window.test.ts:674-748`). Labelled ready-for-agent: the behavior is fully specified by the request plus the existing patterns; no design decision is left open beyond the handle/affordance details the implementing ticket records as it goes.
