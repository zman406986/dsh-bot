# 100 — Floating dispatcher window + an additive launcher in the stock UI (ADR-0021)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** 99 (the root election must leave the default posture first — the window is additive, never a displacement)
**Related:** ADR-0021 (the vehicle — decisions 2 and 4), ADR-0013 (the `shell.overlay` seam research survives and is the sanctioned evidence), 73 (cancelled — its anti-revival clause is satisfied by this ticket + ADR-0021), 77/79/80/81 (resolved — the surface inventory re-hosted), 89 (resolved — capsule deletion stands)

## Problem

ADR-0021: dispatcher functions are "called out and used in a separate floating window" launched from the stock UI. The surfaces already exist — sidebar roster, conversation pane, approval cards, roster panel (tickets 77/79/80/81) — but they render only through the displacement mounts ticket 99 retires; there is no floating window and no launcher affordance in the stock UI.

## What to do

- [ ] Build the floating window hosting the EXISTING shell surfaces — re-host, not rebuild (ADR-0021 decision 4): sidebar roster + conversation pane + approval cards + roster panel move in as surface inventory.
- [ ] Additive launcher affordance in the stock UI on the `shell.overlay` seam: `src/client/overlay.ts` still exports `SHELL_OVERLAY_SLOT` + `rosterOverlayRegistration()` though nothing registers them — those exports survive and are the entry point. Launcher opens/closes the floating window; honest degrade when the seam is absent.
- [ ] Draggable and closable window behavior (the floating window must be movable out of the way and dismissible).
- [ ] Crash isolation: a crashed floating window NEVER affects stock dsh (ADR-0021 decision 2). The abdication machinery was root-specific (shadowing entry yields the cell) — re-base the isolation onto the additive posture and record the new guarantee.
- [ ] Offline node:test coverage for the window store / launcher registration (registration contracts over fakes in the existing shell-mount/overlay pin style).
- [ ] Live-pass items pinned as UNTICKED checkboxes for a future live lane (the ADR-0015 / ticket-33 convention): floating-window render on a real boot, drag/close interaction, crash-isolation under a real render crash, launcher click-through/stacking. NO live testing in this pass.

## Constraints

- Stock dsh stays primary (ticket 99's outcome): the window is additive — it must not register over `root` or claim a full-cell `main` page.
- Not a capsule revival: the window hosts the WHOLE dispatcher shell, not a collapsed chip (ADR-0021 Consequences). The capsule stays retired; resolved ticket 89's deletions stand.
- No new host seams, no invented push channels — client-side composition per the surviving ADR-0013 seam research (overlay anatomy, click-through, per-entry error boundary).
- Locale discipline (new copy in our dictionaries, en+zh) and token-only CSS (`--dsw-*`) as the existing shell suites pin.

## Comments

### 2026-09-20 — team-leader session

Filed with ADR-0021. Cancelled ticket 73's anti-revival clause ("if a future shell surface genuinely needs repositioning, that is a new ticket with its own evidence, not a revival of this one") is satisfied by the book: ADR-0021's quoted human ruling is the new evidence, and this ticket is the new ticket — the drag need 73 asked for lands here, re-based onto the floating-window vehicle. The exact DOM technique for the window (portal vs slot composition) is this ticket's evidence to gather, per ADR-0021's Open questions.
