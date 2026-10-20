# DD-017 — Centralized Escape-overlay semantics vs unguarded local dismiss
- **Area:** keyboard shortcuts (A2)
- **Type:** behavior-delta
- **Date:** 2026-09-23

## What the reference does
Escape is handled centrally, before any chord matching. The global-shortcut controller carries an overlay-escape state — an armed flag, a stacked flag, and a close callback (interface at the reference tree's `global-keyboard-shortcuts.ts:143-147`) — and its keydown handler intercepts Escape first: it closes the topmost overlay only when the state is armed, not stacked, and the event was not already default-prevented, then returns without consulting chord resolution (`global-keyboard-shortcuts.ts:175-178`). The root renderer feeds that state (the reference tree's `ProductionRenderer.tsx:2895-2908`): armed while logged in and any of find-in-chat / command palette / aux overlay / async-tasks drawer is open, stacked when palette and overlay coexist, with a close priority of find-in-chat > command palette > overlay > async tasks. One owner, one policy, and every overlay dismisses through it.

## What the current build does
Exactly one surface in the entire client handles Escape: the session-row context menu in `src/client/shell.tsx:595-597`, which calls `setMenu(null)` on Escape unconditionally — no armed/stacked tracking, no `defaultPrevented` guard, no close priority. The dismissal is scoped only by listener lifetime: the keydown (plus outside pointer-down and scroll) listeners attach while the menu is open and detach when it closes (`shell.tsx:589-607`). A search over `src/client/` finds no other Escape handler — the settings card, approval pane, and onboarding do not dismiss on Escape, and there is no central shortcut owner at all (DD-016).

## The deviation
The reference solves "which surface does Escape close" as a central, stateful arbitration problem: an armed bit fed by the root, a stacked guard, a documented close priority, and a `defaultPrevented` hand-off to any earlier handler. The build has no such problem and no such machinery — one locally-scoped menu listener closes unconditionally. The visible behavioral delta is small (the menu is effectively "armed" by construction, since its listener exists only while it is open), but the guard vocabulary is entirely absent: nothing stops our handler from swallowing an Escape that stock dsh — sharing the same DOM document under ADR-0021 coexistence — had already claimed via `preventDefault`, and nothing scales if a second surface of ours ever learns to dismiss.

## Verdict: ADAPT
Do not build the reference's controller now: its armed states (find-in-chat, palette, overlay stack, async tasks) name surfaces the build never shipped, and DD-010's ruling of one additive extension point means there is no overlay stack for a stacked guard to arbitrate, while the existing local dismiss is already effectively armed by listener lifetime. What is worth adapting is the discipline as a rule rather than code — any Escape handler we add in the shared document must respect `defaultPrevented` and stay scoped to our own surfaces (the same focus-scoping constraint DD-016 puts on shortcut handling, and requiring no registry), and the moment a second build surface dismisses on Escape, dismiss policy gets centralized into one owner instead of per-surface listeners. The area is unruled — no ADR or ticket records Escape semantics either way — so this verdict is a proposal; the concrete trigger (adding a second Escape surface or any document-level handler) should get a human nod at that point, not now.

## Incorporation notes
- **Where it would live:** today, nowhere new — the guard rule is a comment-level constraint on `src/client/shell.tsx`'s menu-dismiss effect; if a second surface ever appears, a single Escape-dismiss owner module under `src/client/` (alongside `overlay.ts`) holding armed/stacked state and the close priority, with surfaces registering through the shell composition.
- **Constraints:** never attach document-level Escape handling that can swallow stock dsh's Escape (ADR-0021 coexistence; `defaultPrevented` respect is the minimum interop guard); handlers stay focus-scoped to the floating window per DD-016; no new overlay surface is implied — DD-010's rule of one additive extension point and the ticket-73 anti-revival clause stand; no central shortcut registry (DD-016) is required for one local listener.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — at most a `defaultPrevented` guard clause and a comment today; only becomes M if the second-surface trigger fires and a central owner is warranted.
- **Key reference anchors:**
  - the reference tree's `frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts:143-147` — the overlay-escape-state interface (an armed flag, a stacked flag, a close callback).
  - `frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts:175-178` — Escape intercepted before chord matching; gated on armed, not stacked, not default-prevented.
  - `frontend/src/production/ProductionRenderer.tsx:2895-2908` — root feeds armed/stacked state; close priority find-in-chat > palette > overlay > async tasks.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts` (lines 143-147, 164-183), `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/ProductionRenderer.tsx` (lines 2895-2908)
- Build: `src/client/shell.tsx` (lines 584-607 — menu dismiss effect; 595-597 — the sole Escape handler)
