# DD-003 — Agent-selection navigation history vs click-only selection
- **Area:** UI shell / window chrome (A1)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference gives agent (session) selection three keyboard-driven navigation mechanisms on top of plain clicking, all implemented in window-chrome state code:

1. **Navigation history with a cursor** (the reference tree's `frontend/src/recovered/features/window-chrome/root-shell-state.tsx:59-91`): a navigation-state record holding an entry list, a cursor, a pending target, and the applied agent id. Every agent open records a selection through a selection-recorder helper, which truncates any forward branch past the cursor, dedupes against the applied selection, and clears a pending target when the applied selection catches up to it. A navigation resolver walks the entries back/forward from the cursor, skipping entries whose agent is no longer in the set of currently visible, non-hidden agents, and never lands on the current entry.
2. **Adjacent-agent stepping** (`root-shell-state.tsx:93-102`, `ProductionRenderer.tsx:2847-2856`): an adjacent-agent resolver moves previous/next through the visible agent list; the production renderer filters out hidden agents first and routes the result through its agent-open path (so stepping is itself recorded in history).
3. **Indexed focus** (`ProductionRenderer.tsx:2873-2880`): an indexed-focus helper partitions sidebar agents pinned-then-unpinned and selects the Nth in that ordering.

These are wired to keyboard shortcuts (`root-shell-state.tsx:34-52`): Alt+ArrowUp/ArrowDown for previous/next agent, Ctrl/Cmd+1..9 for focus-agent-N, and Ctrl/Cmd+[ / Ctrl/Cmd+] for navigate-back / navigate-forward.

## What the current build does
Selection in `src/client/shell.tsx` is a plain sidebar click: the row button calls `store.select(sessionId)` and optionally passes `hosts.onSelectSession?.(sessionId)` along to the host (`shell.tsx:255`, `675-676`, commented at line 320 as "selection is a plain click, no router yet"). There is no selection history, no back/forward traversal, no stepping between adjacent agents, and no indexed focus. All selection changes come from explicit clicks.

## The deviation
The reference treats "where have I been" as first-class shell state — a stack of entries with a cursor, filtered for visibility and reconciled with a pending target — reachable entirely from the keyboard; the build has only direct selection. The build's interaction options are fewer: a user with many sessions must re-click (or re-scroll and click) to return to a previous session, and there is no equivalent of Alt+arrows / Ctrl+1-9 / Ctrl+[ ] traversal. Note the reference path in the enumeration was slightly off: the file lives under `features/window-chrome/`, not `features/conversation/workspace/`.

## Verdict: ADAPT
No recorded ruling found in `docs/` or `docs/adr/` covering selection navigation history — the only "adjacency" hits in docs are dsh's own parent/child message-adjacency rules, unrelated to shell UI — so no recorded decision settles this, and it falls to judgment. It is a small, purely additive UX convenience (extra shell state + optional keybindings; it changes no existing behaviour), which makes it a reasonable ADAPT candidate rather than DO-NOT-INCORPORATE. But it must respect the ADR-0022 rule of a single additive extension point (extend the existing selection path, do not open a second one) and the fact that no shortcut registry exists — the reference's back/forward and indexed focus are keyboard-driven, and this project has no global shortcut registry to attach them to, so a first version would likely be the history state and adjacent-agent stepping without keybindings, with bindings deferred until a shortcut surface exists. If human input wants to weigh in on keyboard conventions, this is the natural ask; otherwise ADAPT with a minimal version that respects the existing extension point.

## Incorporation notes
- **Where it would live:** selection-history state and pure transition helpers beside the shell store in `src/client/` (e.g. a small module next to `shell.tsx`), applied inside or alongside `store.select` so every selection (click or future programmatic open) records an entry; the existing `onSelectSession` call to the host stays untouched.
- **Constraints:** ADR-0022's rule of a single additive extension point — extend the existing selection path, no parallel selection channel; no global shortcut registry exists in the build, so keybindings (Alt+arrows, Ctrl+1-9, Ctrl+[ ]) have no home yet and should be out of scope for a first version; visibility filtering should reuse whatever the build's sidebar ordering/pinning is, not the reference's partition; independent re-derivation required.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S-M — the history stack, cursor, and adjacent-agent stepping are small pure logic; risk is low, but scope should not creep into keybinding infrastructure until a shortcut extension point exists.
- **Key reference anchors:**
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/window-chrome/root-shell-state.tsx:34-52` (shortcut resolution: Alt+arrows, Ctrl+1-9, Ctrl+[ ])
  - `.../frontend/src/recovered/features/window-chrome/root-shell-state.tsx:59-102` (the navigation-state record, its selection recorder, the navigation resolver, the adjacent-agent resolver)
  - `.../frontend/src/production/ProductionRenderer.tsx:2847-2880` (previous/next-agent stepping, back/forward navigation, and indexed focus over hidden-filtered, pinned-then-unpinned ordering)

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/window-chrome/root-shell-state.tsx` (lines 34-52, 59-102); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/ProductionRenderer.tsx` (lines 2847-2880)
- Build: `src/client/shell.tsx` (lines 255, 320, 648-720; select path at 675-676)
- Docs: grep of `docs/` and `docs/adr/` for navigation/back-forward/adjacency rulings found none relevant (only dsh parent/child message-adjacency in `docs/research/`, unrelated)
