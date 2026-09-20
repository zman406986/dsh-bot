# 103 — Floating-window drag flies across the screen (compounding start-relative delta)

**Status:** open
**Labels:** ready-for-agent
**Related:** 100 (resolved — the floating window; its unticked LIVE PASS drag item is where this report lands), 73 (cancelled — the drag need it asked for shipped on 100; this is its first live defect), ADR-0021 (decision 2 — the window vehicle)

## Problem

The human reports (2026-09-21, live use, verbatim): *"floating window when dragged around behave weird: house only move a few pixels but window goes flying across, travelling great distances, not expected dragging behavior"* ("house" read as "mouse"). Expected: the window follows the pointer 1:1. Observed: a few pixels of mouse movement send the window flying a great distance, usually until it slams against a viewport edge (the clamp's pin).

Root cause, identified in the scribe pass (verify, then fix): the drag compounds a start-relative delta onto the live position.

- `beginDrag` (`src/client/floating-window.tsx`, lines ~257–275) captures the POINTERDOWN point and, on every window `pointermove`, calls `store.moveBy(move.clientX - startX, move.clientY - startY, …)` — the delta from the START, not from the last event.
- `moveBy` (`src/client/floating-window-store.ts`, lines ~203–214) adds that delta to the LIVE position: `clampWindowPosition(state.x + dx, state.y + dy, …)`.

So every move event re-applies the full distance-from-start on top of the already-moved window. Trace (pointerdown at x=100, window origin 0): mouse creeps 100→105→108→110→112→113→114 while the window runs 0→5→13→23→35→48→62 — the offset compounds super-linearly and the window rockets away though the mouse barely moved. The clamp then pins it at the peek-strip edge, which reads as "flew across the screen".

Why the offline suite missed it: the rendered drag pins in `test/client-floating-window.test.ts` drive pointer events through the real clamp, but a single `pointermove` applies the delta exactly once and looks correct — only a MULTI-event drag exposes the compounding. This report is ticket 100's unticked LIVE PASS item ("drag/close interaction against a real dsh window — pointer capture feel") arriving as a live defect.

## What to do

- [ ] Fix the drag: anchor the window's placement at pointerdown and set the position per move event as `origin + (current − start)` (or equivalently feed per-event deltas measured against the LAST move). Never add a start-relative delta to the live position. The clamp contract is unchanged (`clampWindowPosition`: 64 px peek strip, deterministic edge pinning when the viewport collapses, never NaN).
- [ ] Offline test: a MULTI-event rendered drag pin — two or more `pointermove`s with increasing `clientX`/`clientY` must land the window at `origin + (last − start)`, bounded by the clamp, monotonic in the pointer. This pin must FAIL on the current code (name the compounding in the assertion's failure story); the existing single-move and clamp pins stay.
- [ ] Live confirmation joins ticket 100's unticked LIVE PASS lane (drag/close feel against a real dsh window): read `read-before-running-live-and-browser-tests.md` before anything live; kill timers mandatory at launch; testing artifacts under `.scratch/testing/<yyyy-mm-dd>-<slug>/` — never committed, ticket comment cites the in-repo path.

## Constraints

- The store stays pure (geometry decided in the store, the component only feeds pointer values and a viewport — the existing `describe*`/`moveBy` discipline).
- In-memory placement only; no persistence is claimed (the store's recorded posture — do not add storage while fixing).
- Presentation-only repair: token-only CSS, `multitask-dispatcher-` class discipline, no animation; the crash-isolation and launcher posture of ticket 100 is untouched.
- No new host seams, no live testing in the offline pass (ADR-0015 / ticket-33 convention — the live lane above carries the live confirmation).

## Comments

### 2026-09-21 — scribe session

Filed from the human's live-use report above. The scribe pass verified the root cause by code reading only (no implementation, no live run); the file:line cites in Problem are the evidence. The compounding trace is arithmetic from the cited code, not a reproduced run — the implementing team should confirm the failure shape live or in a rendered multi-event test before trusting the fix direction, though the code path leaves little room for an alternative explanation: any per-event handler that adds `current − start` to an already-updated position compounds by construction. Fix is small and localized to `beginDrag` + the `moveBy` call shape; the store's `moveBy(dx, dy, viewport)` face itself is sound and can stay if the component feeds it the right delta.
