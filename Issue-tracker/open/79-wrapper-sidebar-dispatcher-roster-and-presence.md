# 79 — Wrapper sidebar: dispatcher roster + presence re-host (ADR-0020 slice 3)

**Status:** open
**Labels:** needs-triage
**Blocked by:** 77 (skeleton), 76 (per-dispatcher session keying of the roster mirror)
**Related:** ADR-0020 (multi-dispatcher placement), ADR-0019 (keying table), 27/28 (presence stores re-hosted here), `wrapper-vehicle-seams.md` Finding 1 (`ctx.sessions.list`)

## What to do

- [ ] Bind the shell sidebar to the standard sessions feed (`ctx.sessions.list` snapshot;
      selection via `open(id)` semantics) — rows = sessions, dispatcher flag from our
      per-session activation state.
- [ ] Re-host the ticket-27/28 presence stores onto the sidebar rows: status dot, blocked
      chip, activity line, finished marker — per session, keyed by session id (ADR-0019's
      mirror keying). Until 76 lands, rows degrade to honest "presence unavailable" copy,
      never a wrong roster.
- [ ] Roster failure states with honest copy: empty / unavailable / retry-less (no reconnect
      banner — U-A). Hover preview precedence (waiting reason > draft > last entry) only if the
      underlying data exists per session; otherwise record the gap.
- [ ] Unread/attention markers: pull-only (no push seam exists) — keep ticket 27's honesty.

## Constraints

- No user-facing stop affordance anywhere (area 7 conformity). No identities/avatars (C13).
- Offline-testable parts: feed→store projection, keying, degradation paths, view models.
