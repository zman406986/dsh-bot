# 70 — Peer tier: dispatcher-to-dispatcher messaging (ADR-0018 in-scope area)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none for the design pass — 67 resolved (ADR-0020); 72 resolved and its practical gate (76's session keying) landed. Live two-dispatcher verification rides the 45/33 lane (ADR-0019 sign-off gates live work only — ticket-76 precedent). See the 2026-09-19 triage comment.
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

## Comments

### 2026-09-19 — agent (vehicle hand-off from 67)

Vehicle decided (draft): **ADR-0020**. Placement: peers are dispatcher sessions, so the
wrapper's sidebar roster (ticket 79, keyed by session id per ADR-0019/76) is where peer
presence and the send targets live; conversations with peers render as conversation surfaces
of their session (80). Your design constraints (C14 point-to-point, C15 single wake kind) are
unchanged; your remaining block on 72 is discharged at the design level (ADR-0019 drafted) —
the practical gate is now 76's session keying, same as 79's.

### 2026-09-19 — agent (triage: actionable NOW → ready-for-agent)

Verdict (a) for the design pass. Every named gate has landed: 67 → ADR-0020; 72 → ADR-0019
drafted AND 76 shipped the session keying this tier needs. Verified against the core: the peer
data path is already per-dispatcher (`src/core/peer-inbox.ts:35-46` — the inbox face is
`send(sessionId, envelope)` / `listPending(sessionId)` / per-session delivered flags;
`src/core/multitask.ts:943-962` — `sendPeer`/`listPendingPeers` take the session id; the wake
bus holds per-session peer deques with turn-ownership + priority-interrupt rules from 14). What
does not exist yet is the outbound half (14 explicitly left the dispatcher send tool out of
MVP; 50's cancellation voided its sketch, not the need) and the wrapper-era placement/sort.

**Agent-ready brief (design ticket — implementation decomposes at dispatch time; this ticket
does not spawn sub-tickets)**

- **Scope-in:** reference peer-messaging verification from the notes (thin — record it);
  inbound re-base audit against 76's keying; outbound send design; the C14 sort of the shipped
  group/broadcast envelope targets; implementation ACs chunked for dispatch.
- **Scope-out:** org chart, group rooms, routines (C14); workers as participants (leaves); a
  new wake-kind class (C15 — peer messages stay a wake source into the existing single-wake
  pipeline); send journal / offline queue / retry or reconnect affordances (A4 + the
  conservative U-A reading of ticket 82's interim rule: a failed peer send gets honest copy,
  never a retry control); push presence (79's pull-only markers stand).
- **Builds on:** `src/core/peer-types.ts` (`PeerEnvelope`, `PeerTarget` agent|group|broadcast,
  priority), `src/core/peer-inbox.ts` + `src/core/wake-bus.ts` (per-session lanes, interrupt
  of non-user turns only), the optional `requestDispatcherInterrupt` host seam (live adapter
  no-op fallback — recorded), 76's per-session scoped tool registration (the outbound tool
  registers in each dispatcher's own surface), 79's sidebar roster rows + 80's conversation
  surfaces (placement per ADR-0020's hand-off), `docs/research/reference-behavior-notes.md:60`
  (peer tool is top-level-agent-only; workers exclude it) + `always-on-dispatcher-behavior.md`
  area 9 (org-chart context — excluded C14, cited only for what peer messaging is NOT).
- **ACs:**
  1. Verification from the research notes, cited file:line, with the thin-depth caveat
     recorded — design only on what is cited; no invented reference detail.
  2. Inbound audit: an offline S8 test pins two dispatcher sessions have fully isolated
     inboxes, wake lanes, and delivered flags (expected pass — the core is already keyed;
     a failure here is a bug to fix, not new design).
  3. Outbound design: per-session dispatcher send tool (name/schema ours), addressing =
     target dispatcher session id (how the sender learns ids: the sessions feed / 79's
     roster), async fire-and-forget ack (direct send — A4), optional priority interrupt of
     non-user work only (existing turn-ownership rules; S9).
  4. C14 sort recorded for the shipped group|broadcast targets: expose / fence / retire,
     with rationale — point-to-point is the tier's contract.
  5. Implementation ACs chunked: (i) core outbound + offline tests; (ii) client placement
     hooks in 79/80 surfaces; (iii) live two-dispatcher verification, marked for the 45/33
     lane only.
- **Risks:** the group/broadcast shapes predate ADR-0018 — the AC-4 sort may retire shipped
  surface (that is in-scope conformance, not a new exception); priority interrupt must never
  interrupt a user-driven turn (14's rules already pin this — reuse, don't re-design).
- **Size:** M (design); implementation L → decompose at dispatch time.
