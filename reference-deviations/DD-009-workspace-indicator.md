# DD-009 — Chrome-level active-agent indicator vs in-window header
- **Area:** UI shell / window chrome (A1)
- **Type:** behavior-delta
- **Date:** 2026-09-23

## What the reference does

The reference renders a window-chrome-level workspace indicator component at the root of its production renderer: a single `role="heading"` / `aria-level={1}` element showing the active agent's name as the first piece of chrome in the shell, ahead of the status badge and notification host (the reference tree's `frontend/src/production/ProductionRenderer.tsx:3427`). The component suppresses itself in two cases: when the window is fullscreen, and when the label is null/empty (the reference tree's `frontend/src/recovered/features/window-chrome/workspace-indicator.tsx:10-15`). The label is derived from the active workspace route — it shows the active agent's name only while no workspace route is active; entering a workspace route clears it (ProductionRenderer.tsx:3427). So the active agent is always legible at the outermost chrome level whenever the user is not inside a workspace and not fullscreen.

## What the current build does

The build has no chrome-level active-agent indicator. The closest analog is in-window only: the floating window's main pane renders a `__main-header` line showing the selected session title (falling back to the raw session id) — but only inside the selected-session branch of `src/client/shell.tsx:716-719`; when nothing is selected the pane shows the onboarding component or the no-selection copy with no title at all. Outside the window, the capsule's visible text is the counts pair `[dispatchers | workers]` (`src/client/floating-window.tsx:637`), which says how much is running but never which agent/session is active. Net: with no session selected, or while looking at the capsule rather than the window, the UI never answers "which agent am I on".

## The deviation

The reference puts the active agent's name at the outermost chrome level (hidden only in fullscreen and cleared when a workspace route takes over), so the current agent is identifiable even when no chat pane is mounted or the chat pane is small. The build confines the title to the in-window header of the selected-session state, so the no-selection state and every surface outside the window (collapsed capsule) do not show the agent's name at all. The delta is mostly about (a) the no-session-selected state and (b) out-of-window chrome contexts; the in-window header already covers the ordinary selected-session case.

## Verdict: ADAPT

No recorded ruling covers a chrome-level active-agent heading; ADR-0021/0022 settle the build's chosen setup (floating dispatcher window plus revived capsule with presence counters) but say nothing about agent-name affordances, so this is an open adaptation, not a ruled conflict. The build already shows the session title in-window (shell.tsx `__main-header`), so wholesale incorporation would duplicate it; the better move is adapting the reference's invariant — "the active agent is always nameable at chrome level" — to the build's window, e.g. surfacing the selected session title on the floating window's frame/title area and considering a name-bearing affordance for the no-selection and capsule states. Fullscreen suppression has no analog in the build's floating window and can be dropped. Per the authority stack, if implementation touches the capsule's ruled counter shape (ADR-0022), that specific ruled surface stays as-is and the question goes to the human rather than being picked silently.

## Incorporation notes
- **Where it would live:** a small chrome-level title element on the floating window (frame/title region of `src/client/floating-window.tsx`, mirroring the `__main-header` source of truth), plus optionally a title-bearing state in the no-selection branch of `src/client/shell.tsx:702-714`; the capsule (`floating-window.tsx:637`) only if a human ruling extends ADR-0022.
- **Constraints:** single source of truth with the existing `selectedTitle` used by `__main-header` (no second derivation of "active"); no change to the ruled `[dispatchers | workers]` counter text; aria semantics (heading role/level) may be carried over in re-derived form for accessibility parity; do not show when the window is fullscreen-equivalent (maximized) if such a state exists.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — one title element plus shared state wiring; risk is low but any capsule change needs a human ruling first.
- **Key reference anchors:**
  - the reference tree's `frontend/src/recovered/features/window-chrome/workspace-indicator.tsx:10-15` — component: null when fullscreen or empty label; heading role, aria-level 1.
  - the reference tree's `frontend/src/production/ProductionRenderer.tsx:3427` — chrome-level mount; label derived from the active workspace route (cleared when a workspace route is active).
- **Build anchors:**
  - `src/client/shell.tsx:716-719` — `__main-header` shows `selectedTitle ?? panes.main.sessionId`, selected-session branch only.
  - `src/client/shell.tsx:702-714` — no-selection branch: onboarding component or bare copy, no title.
  - `src/client/floating-window.tsx:637` — capsule text `${counts.dispatchers} | ${counts.workers}` (ADR-0022-ruled surface).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/window-chrome/workspace-indicator.tsx`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/ProductionRenderer.tsx` (line 3427)
- Build: `src/client/shell.tsx` (lines 702-719); `src/client/floating-window.tsx` (line 637); context `docs/adr/0021-addon-coexistence-floating-dispatcher-window.md`, `docs/adr/0022-floating-capsule-revived-by-human-ruling.md`
