# 125 — Chatroom broadcasting: optional named room a dispatcher can address

**Status:** deferred
**Labels:** needs-info
**Deferred:** 2026-10-22 — blocked on two human decisions (ADR-0026 open questions 3 and 4); the 2026-10-22 comment below records the reason and the reopen gate.
**Blocked by:** ADR-0026 open question 3 (how room traffic reaches a wake; C15 is unamended) and open question 4 (who may create a room) — both human decisions. 116 and 121 are resolved. Reopening also waits on 112 and 131 being settled.
**Related:** ADR-0026 (§Settled bound set, membership identity, persistence), ADR-0002 (peers in scope), ADR-0006 / ADR-0018 A5 (persistence stays in dsh's store), ADR-0018 C13 (no identity roster), C15 (single wake kind), ADR-0018 U-H (no local search index)

## Problem

The dispatcher can address one agent. There is no way to broadcast to a named group, so every team-wide message is N separate sends and the replies have no shared order. ADR-0026 rules an optional room in and supersedes C14's room exclusion; its bound set was settled on 2026-10-18 and is written into the ADR.

## What to do

**Membership and identity**

- [ ] A room is `{ roomId, memberSessionIds[] }`. **Session id is the only identity.** No user-assigned names (C13).
- [ ] Enforce **2–8 members**. Fewer than 2 is the existing 1:1 path; 8 matches the host's active-subagent default so a full room can be woken inside one root pool.
- [ ] Display a member as `subagent.label` → session title → session id.

**Turn order and caps (settled — build to these)**

- [ ] Speaker order: explicit `@name` mention first; otherwise **admin-first** (the creator), then room order.
- [ ] Round limit: **`members + 4`**, hard-capped at **8 rounds**.
- [ ] Per-member per-round cap: **2 messages**.
- [ ] A member passes by posting `[PASS]` or `(pass)`; store it as a no-op log line so it still advances the cursor.
- [ ] Stop conditions: empty round; round limit reached; **40 total messages**; or **epoch cancel** — any new user message bumps the epoch and aborts the in-flight round.
- [ ] Slow-member grace: **15 s**, then mark the slot `working` and advance the round. A late reply is still posted to the room, but only the **asker** is notified.

**Shared log**

- [ ] Keep the latest **60 lines**. Each member reads through its own per-member `seen` cursor; messages are **not forwarded** into member sessions.

**Transport and persistence**

- [ ] Deliver through the existing peer inbox / peer wake path. No new wake kind (C15). Decide and record how a room message reaches a wake — that is ADR-0026 open question 3 and must be answered before implementation.
- [ ] Decide and record **who may create a room** (ADR-0026 open question 4; both references create rooms from outside the dispatcher's tool surface).
- [ ] Persist membership and the ordered log in dsh's session/job store. Round, per-member, total-message, and epoch counters are the room turn's in-memory state and need no store. No second database (ADR-0006), no local search index (U-H).

**Provenance**

- [ ] Room messages are from an agent, never the user. They never count as user presence, never satisfy an approval ask, never open a user wake.

## Recorded as owner-delegated defaults, not reference-derived truths

Four numbers have no stated reason in either reference: the **8** member cap, the **15 s** grace, the **60**-line log window, and the **40**-message total. ADR-0026 records them as owner-delegated defaults on the mechanism each serves. Do not restate them as reference facts.

## Not adopted

Grok's 6-member cap and 24-line log; DeepSeek-Bot's 12-member cap and `+4` admin bonus; Grok's 3-round / 10-message numbers; DeepSeek-Bot's late-round cap of 10.

## Constraints

- 1:1 peer messaging is unchanged; a room never replaces it.
- Membership is not a saved agent-identity roster (C13).
- Room traffic can wake N members per message; the 40-message and 8-member caps are the budget, together with existing wake coalescing.
- Offline tests with `FakeDshHost` plus a fake clock for the grace timer and epoch cancel.

## Comments

### 2026-10-18 — filing

Filed for ADR-0026, whose "bounds TBD / source material only" was replaced on 2026-10-18 by the settled set now in the ADR (§Settled bound set). Two ADR-level questions remain this ticket's to answer before coding: how a room message reaches a wake, and who may create a room. Both are recorded as gates rather than guessed.

### 2026-10-22 — deferred by agent ruling (subject to human reversal)

Deferred 2026-10-22 by agent ruling (subject to human reversal). Rooms are in scope per the 2026-10-18 ruling (ADR-0018 C14 room exclusion superseded by ADR-0026) and are not a "full messaging hub" rebuild (PRD §7.6 line 293); peer messaging itself is optional M5 (PRD §13). The build is blocked by ADR-0026 open questions 3 and 4, both human decisions: Q3 needs a new wake path or a C15 amendment (ADR-0026 line 13), and ADR-0003's no-worker-to-worker rule binds against a member-to-member log; Q4 needs an owner decision on room creation, since no client surface exists (ADR-0024). Reopen only after (a) C15 is amended for room wakes or a dispatcher-only room shape is ruled, (b) an owner decision names who creates a room, and (c) tickets 112 and 131 are settled. Move back to open/ when those land.
