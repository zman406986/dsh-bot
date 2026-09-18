# 81 — Wrapper approval cards + capsule retirement (ADR-0020 slice 5)

**Status:** open
**Labels:** needs-triage
**Blocked by:** 80 (cards render in the conversation surface), 69 (classifier gating design — this ticket is the wrapper-side rendering, 69 owns the gating design)
**Related:** ADR-0020 (inventory rows: approvals), 13/23/30 (relay + prompt UX re-host), 45/33 (live lane)

## What to do

- [ ] Render the access relay's pending asks as inline cards in the wrapper's conversation
      surface: re-host ticket 30's prompt anatomy (plain-language title, clamped detail with
      omission marker, resolve actions, stale/pending fencing, session-scoped always-allow —
      U-D binding). Secret asks keep the never-shown promise copy (adapted).
- [ ] While a card waits, the session's sidebar row shows the blocked marker with reason
      (closes the approval→presence loop, area 6).
- [ ] Capsule retirement: remove the `shell.overlay` chip/panel entry and its routes once the
      frame election has shipped; the stores/sections live on inside the wrapper (they are
      re-host inventory, not deleted). Toolview slot entries retire with the host chat — their
      content moved in ticket 80.
- [ ] Settings card (ticket 47) re-homes into the wrapper's own settings surface or stays a
      shipped-settings entry — decide with evidence once the frame displaces the settings UI.

## Constraints

- The relay's semantics (timeout ADR-0008, deny-by-default, dedupe) are untouched — rendering
  only. No persisted always-allow rules (U-D). No new prompt pathway.
