# 70 — Peer tier: dispatcher-to-dispatcher messaging (ADR-0018 in-scope area)

**Status:** open
**Labels:** needs-triage
**Blocked by:** 67 (where peer messaging lives in the wrapper UI), 72 (multi-dispatcher session scoping — peers are dispatcher sessions)
**Related:** ADR-0018 (in scope: "the peer tier (dispatcher-to-dispatcher messaging)"; exception C15, C14), PRD §7.6 / S9 / ADR-0002 (peer agents in scope; async fire-and-forget with optional priority interrupt), 14 (shipped peer inbox + priority lane), ticket 50's cancelled outbound half

## Problem

ADR-0018 makes dispatcher-to-dispatcher messaging a first-class area. Ticket 14 shipped a peer
inbox and priority lane against the single-dispatcher model; ticket 50 (cancelled) sketched the
outbound half under a since-retracted premise. The wrapper era needs the peer tier re-based:
dispatcher sessions messaging each other, async, with the optional priority interrupt of non-user
work (S9).

## What to do (research/design ticket)

- [ ] Re-verify what the reference's peer/multi-agent messaging actually does from the research
      notes (org-chart edges, recent-conversation markers — cite file:line; never open the
      reference tree).
- [ ] Re-base ticket 14's inbox/priority-lane design onto per-dispatcher sessions (keying per
      session, not one process-global lane).
- [ ] Design the outbound send: async fire-and-forget; optional priority interrupt of non-user
      work; last-wins semantics do not apply across peers (per-peer steer is a dispatcher-internal
      concern).
- [ ] **C14 is binding:** no org chart, no group rooms, no routines — the tier is point-to-point
      messaging only. **C15 is binding:** peer messages are a wake source into the receiving
      dispatcher's existing single-wake-kind pipeline, not a new wake kind class.
- [ ] Draft implementation ACs once 67 and 72 land.

## Constraints

- Workers never participate in the peer tier (leaves); only dispatchers.
- New or adapted copy only.
