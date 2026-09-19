# 73 — Capsule (chip and expanded panel) must be draggable so the user can move it out of the way

**Status:** cancelled
**Labels:** needs-triage
**Blocked by:** none
**Related:** 35 (capsule epic — the surfaces this touches), 38 (`CAPSULE_CSS` / capsule implementation), 42 (capsule close-out), 49 (token theming)

## Problem

The dispatcher capsule chip and its expanded panel are fixed-position overlays registered into the `shell.overlay` slot. When they overlap other host UI (or each other), the user has no way to get them out of the way — they cannot be moved.

## Requested behavior

1. The **expanded panel** is floating and drag-able: the user can grab it (e.g. by its header/activation row) and reposition it anywhere in the viewport, in case it overlaps anything.
2. The **collapsed chip** is drag-able too, so the user can park the capsule wherever it least obstructs the host.

## Design notes / constraints

- Both surfaces live in the additive `shell.overlay` slot; dragging must not break click-through or stacking semantics of that slot (see epic 35's surface rules and `docs/research/dsh-plugin-ui-patterns.md`).
- Position should persist sensibly (at minimum within a session; across sessions is a bonus — note if the client offers a persistence seam, do not invent one).
- Respect the honesty/implementation rules of epic 35: no new host seams, no invented push channels; pure client-side positioning.
- Should consume the host's `--dsw-*` design tokens per ticket 49 so the drag handle/affordance follows the theme.
- Keep drag UX accessible: keyboard alternative or at minimum don't regress click affordances (expand/collapse still works on plain click; drag should be distinguished from click, e.g. threshold-based).

## Acceptance criteria

- [ ] Expanded panel can be dragged by a visible grab affordance and follows the pointer within the viewport.
- [ ] Collapsed chip can be dragged to a new position; a click still toggles expansion (no accidental drags on click).
- [ ] Dragged position survives expand/collapse and re-render (roster updates must not reset position).
- [ ] Overlapping content can be uncovered by dragging the capsule away; nothing under the capsule becomes permanently unclickable.
- [ ] Offline unit tests cover drag position state; browser pass (ticket 33 process) verifies the interaction live with trivial tasks only.

### 2026-09-19 — re-triaged against ADR-0018 (ticket 64)

The capsule chip/panel this ticket drags are the vehicle ADR-0018 voided (ADR-0013 superseded;
the wrapper window is the dispatcher's surface). The underlying need — "move it out of the way" —
is met natively by an OS window in the wrapper: dragging is platform behavior, not a feature to
build, and the shell.overlay stacking/click-through constraints this ticket designed around
no longer exist. **Stays needs-triage:** not actionable as written under the new model; a
moot-closure candidate once ticket 67's wrapper design confirms no in-window floating surfaces
need drag support. If the wrapper design does surface one, this ticket re-scopes onto it.

### 2026-09-19 — renumbered

Renumbered from 63 on 2026-09-19 — number collision with resolved/63-retune-wake-report-clamp.md
(same defect class as the 64→66 fix). Ticket 65's references updated.

### 2026-09-19 — CANCELLED: nothing left to drag, and no surviving drag requirement anywhere

Dispositioned after ticket 78's cutover (commits `94e6127` / `a44084a` / `c437ee8`; live
pass 4 confirmed shell-as-root renders, stock app returns on abdication). The premise this
ticket designed around — fixed-position overlays that can overlap other host UI — is void:
the capsule/launcher overlay entries are unregistered, and the shell registers as the
dynamic `root` frame that fills the whole cell and DISPLACES the shipped UI (abdication
restores it), so there is no coexistence overlap to escape. Verified honestly:

- `src/client/shell.tsx` has no floating surfaces, no drag code, and no drag affordance —
  a fixed three-pane grid (`width:100%;height:100%`).
- No drag requirement exists outside the capsule-era tickets: ADR-0020 and the wrapper
  tickets (77/78/79/80/68/81) never ask for one. The re-triage note above called the
  wrapper an "OS window"; more precisely it is a root-slot frame in the same web page —
  but the conclusion holds either way: within the page there is nothing to reposition,
  and the page-cell is the host's own layout, not ours to drag.

Per the anti-invention rule this does NOT re-scope onto the shell: if a future shell
surface genuinely needs repositioning, that is a new ticket with its own evidence, not a
revival of this one.
