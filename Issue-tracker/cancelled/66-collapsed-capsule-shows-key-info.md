# 66 — Collapsed capsule must surface key info at a glance: dispatcher ON/OFF + running subagent count

**Status:** cancelled
**Labels:** needs-triage
**Blocked by:** none
**Related:** 35 (capsule epic — defines the collapsed chip), 38 (capsule implementation), 27/28 (status dots, roster sections), 49 (theming)

## Problem

When the capsule is collapsed it is nearly content-free — a glyph and a dot. The user cannot tell, without expanding (or without the chat at all), whether the dispatcher is even on and how much is running. Epic 35 already specifies the chip should carry activation state, worker count, and a wake badge; the current implementation does not deliver that legibly.

## Requested behavior

The collapsed chip must show, compactly and legibly:

1. **Dispatcher state** — explicit ON/OFF (active/dormant, plus error state per epic 35), not only a color dot.
2. **Running subagent count** — e.g. `ON · 2 running` (0 when idle: `ON · 0 running`), so the user sees load without expanding.

The exact rendering (text, icon, dot color) is the implementer's call, but the two facts above must be readable from the chip alone, follow the host's `--dsw-*` tokens (ticket 49), and render from real core state — the roster snapshot via the settings-mirror channel — with no invented push channel (epic 35 honesty rules are binding).

## Acceptance criteria

- [ ] Chip shows dispatcher on/off/error state textually or via a legend-clear affordance, not color alone (accessibility).
- [ ] Chip shows the number of running subagents, live-updating from the reconciler/roster view model.
- [ ] Dormant/never-activated composition still matches ticket 32 (chip shows the dormant state honestly).
- [ ] Chip remains small; nothing in it is clickable except expand/collapse and the activation affordance already specified in epic 35.
- [ ] Unit tests offline; live browser pass uses trivial tasks only.

### 2026-09-19 — renumbered 64 → 66 (ticket 64's duplicate-number fix)

Two tickets were both numbered 64 (this one and the ADR-0018 re-base ticket). This file takes the
next free number, 66; all references (ticket 65's Related line and collapsed-state AC) updated.
Content unchanged by the renumber; triage against ADR-0018 follows separately.

### 2026-09-19 — re-triaged against ADR-0018 (ticket 64)

Split verdict:

- **The ON/OFF half is voided.** ADR-0018 rules the dispatcher always-on with no mode — there is
  no dispatcher state for a collapsed indicator to declare (only honest error states, if any).
- **The running-count half survives as a need, re-based.** Glanceable presence (what is running,
  how much) carries into the wrapper's presence surface at the imitation standard — it is not on
  the exception list. Ticket 27's surviving view models (dots, precedence, counts) are the design
  input; the wrapper shell ticket (67) owns the surface.

**Stays needs-triage:** the chip as specified is not actionable (superseded vehicle + voided
ON/OFF premise); the surviving half is tracked by 67. Moot-closure candidate after 67 confirms
coverage.

### 2026-09-19 — CANCELLED: vehicle retired; the surviving half already shipped in the shell

Dispositioned after ticket 78's cutover (commits `94e6127` / `a44084a` / `c437ee8`; live
pass 4 confirmed shell-as-root renders). Both halves are settled:

- **ON/OFF half — void** (per the re-triage above): ADR-0018 rules the dispatcher always-on
  with no mode; there is no collapsed surface left to declare it on, and the shell has no
  activation chip.
- **Running-count half — delivered by ticket 79** (resolved): glanceable presence lives on
  the shell's sidebar rows, not a chip — per-row working / needs-you / finished counters
  (`shell.row.working` = "{count} …" templates in `src/client/shell.tsx`), aggregate
  presence dots, waiting markers, and hover previews, all fed by the roster mirror watch.
  `src/client/shell.tsx` confirms the implementation; the session-granularity re-host was
  79's stated design.

No surviving request needs separate tracking. Textual (not color-only) state and the honest
dormant/error compositions carry over to the shell's copy where applicable (79's
presence-unavailable line); any residual polish belongs under the shell tickets, not here.
