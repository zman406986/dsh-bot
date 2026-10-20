# DD-011 — Resizable/collapsible persisted sidebar vs fixed grid
- **Area:** UI shell / window chrome (A1)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference gives its left sidebar a full layout lifecycle. A UI-layout state store (over the client
persistence bridge, ProductionRenderer.tsx:814) holds a
sidebar-layout record with width bounds (a named bounds constant carrying separate expanded and
collapsed widths) and a collapsed flag, and persists it through the client persistence layer so
the chosen width/side survives restarts. A separate sidebar-collapse store with its own persistence
adapter (line 815) tracks per-section collapse plus the recents list. The sidebar is interactive:
the sidebar component receives resize / resize-end handlers (line 3449) for drag-resizing the
column, and a global sidebar-toggle action flips the collapsed flag on the stored layout (lines
2882-2885), wired through the global-shortcut controller (as a keyboard toggle chord). The root shell grid
renders one column whose width is the collapsed or expanded width depending on the flag
(line 3445).

## What the current build does
`src/client/shell.tsx` (SHELL_CSS, line 99) hardcodes a fixed three-column grid:
`minmax(180px,240px) minmax(0,1fr) minmax(200px,280px)`. The left (agents) and right (workers)
columns clamp within those ranges, but the user cannot drag them, collapse them, or have any choice
remembered — placement state lives in in-memory stores only. This matches the build's stated store
convention elsewhere: `src/client/floating-window-store.ts` explicitly documents "in-memory ONLY —
no persistence is claimed" for the same kind of window-chrome state.

## The deviation
The build has no sidebar resize, no collapse, and no layout persistence; the reference has all
three, persisted via client persistence and driven by drag + keyboard toggle. This is a missing
UX feature, not a behavioral divergence in dispatcher logic.

## Verdict: ADAPT
No recorded ruling covers sidebar resize/collapse/persistence — ADR-0013 (draft, design superseded
by 0018) only settles that the dispatcher capsule is an additive `shell.overlay` entry, *not* a
sidebar takeover, which constrains but does not decide this. The idea (user-resizable,
collapsible, remembered sidebar geometry) is worth adopting for the web client, but adapted: the
build is a fixed three-column dispatcher shell, not the reference's two-column chat layout, so the
mechanism (per-column width store, collapse flag, optional persistence) must be re-derived against
the existing shell grid rather than copied. Per the authority stack there is no conflict to settle;
if the human wants layout persistence to become a claimed capability, that is a small PRD-level
note, otherwise in-memory-with-session-recall is a defensible default consistent with the
floating-window store precedent.

## Incorporation notes
- **Where it would live:** `src/client/shell.tsx` (SHELL_CSS grid + a small layout store, likely a
  sibling of `src/client/floating-window-store.ts` following its in-memory pattern; persistence, if
  approved, uses the client's existing localStorage usage as in `src/client/onboarding.ts`).
- **Constraints:** Grid template must stay a function of store state (`gridTemplateColumns` from
  width/collapsed values) so the shell renders server-safely; width bounds need their own constants
  analogous to the reference's bounds constant; must not conflict with ADR-0013/0018 — collapse is column
  geometry only, never an overlay or claim mechanism; keep the `minmax(0,1fr)` center column intact.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S/M — one store + grid-template-from-state + two drag handles on column gutters;
  risk is low (pure client chrome) with the only open question being whether persistence is claimed.
- **Key reference anchors:**
  - the reference tree's `frontend/src/production/ProductionRenderer.tsx:814-815` — layout + collapse stores over client persistence
  - `frontend/src/production/ProductionRenderer.tsx:2882-2885` — the sidebar-toggle action flipping the collapsed flag
  - `frontend/src/production/ProductionRenderer.tsx:3445-3449` — root grid from layout state; resize/resize-end props

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/ProductionRenderer.tsx` (lines 814-815, 2882-2885, 3445-3449)
- Build: `src/client/shell.tsx` (SHELL_CSS line 99; style injection line 657), `src/client/floating-window-store.ts` (in-memory-only store precedent)
