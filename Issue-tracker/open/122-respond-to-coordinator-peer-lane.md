# 122 — Worker mid-task reply channel (`RespondToCoordinator`) on the peer wake lane

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none (the peer wake lane it uses already ships; the dispatcher-side provenance it rides is enriched by 116)
**Related:** ADR-0028 (§Settled delivery lane), ADR-0008 (the access ask is a separate relay), ADR-0025 (worker-leaf rule), ticket 116 (peer provenance), ticket 119 (worker prompt wording)

## Problem

A worker that has something useful to report mid-task has no way to say it without ending its turn. ADR-0028 rules the channel in; ADR-0028's delivery-lane record settles **how** it arrives: on the existing `peer` wake lane, queued during a user turn. Today the worker prompt still says the only channels back are the final answer and the access ask.

## What to do

- [ ] Provide a worker-side verb that reports to the owning dispatcher **without** ending the turn, without settling the worker, and without producing a completion-kind wake.
- [ ] Deliver it through the existing `peer` wake lane. **No new lane, no new `WakeEvent.source`, no new wake kind** (ADR-0018 C15 stands).
  - During a user-owned turn it **queues**: `enqueuePeer` fails closed on unknown ownership (`src/core/wake-bus.ts:666-670`) and the notice flushes at turn end (`:825-836`).
  - Only a priority peer interrupts, and only a `worker-settled` or `peer` turn (`:678-690`). A user turn is never interrupted.
  - Do not call `agent.steer` / `agent.inject` for replies. Do not depend on `requestDispatcherInterrupt` — it is a no-op on this install (`src/adapter/cordis-dsh-host.ts:859-867`).
- [ ] Keep the reply distinguishable as a reply in its **text** (the existing "Peer message — not from the user" heading already separates it from user text). The source remains `peer`; that is the accepted consequence of the settled lane choice. Do not add a second wake kind to fix it.
- [ ] Enforce the single-parent rule: the reply reaches only the dispatcher that owns the worker. No worker-to-worker and no cross-dispatcher delivery.
- [ ] Bound it: rate and text caps. State them before implementation and reuse the peer caps where they fit (8,000 characters; rate limit per sender).
- [ ] Update `src/worker/prompt.ts` so the "only channels back" sentence names this channel. (Ticket 119 carries the wider text pass; if 119 lands first, this ticket only verifies the sentence.)
- [ ] Tests: a reply does not settle the worker and does not complete a todo; it arrives as a queued peer notice during a user turn and flushes after; a priority reply interrupts a peer turn but not a user turn; the owning dispatcher is the only recipient; the worker's final answer and access ask still behave as before.

## Constraints

- The worker-leaf and no-worker-to-worker rules are untouched.
- No new saved identity and no roster entry (C13).
- A reply never counts as user presence, never satisfies an approval ask, never opens a user wake.
- The access ask (ADR-0008) is a separate structured relay and is not replaced.
- Offline tests; no live dsh.

## Comments

### 2026-10-18 — filing

Filed for ADR-0028. The lane was the one open question in the ADR; the owner settled it on 2026-10-18 with "do whatever ZCode does", which matches the conservative half our `enqueuePeer` already implements. The Q1 evidence note had recommended a separate lane; the owner ruling outranks it, and the accepted consequence — the reply carries the peer source — is recorded in the ADR rather than engineered around.
