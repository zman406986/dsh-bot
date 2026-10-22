# 122 — Worker mid-task reply channel (`RespondToCoordinator`) on the peer wake lane

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none (the peer wake lane it uses already ships; the dispatcher-side provenance it rides is enriched by 116)
**Related:** ADR-0028 (§Settled delivery lane), ADR-0008 (the access ask is a separate relay), ADR-0025 (worker-leaf rule), ticket 116 (peer provenance), ticket 119 (worker prompt wording)

## Problem

A worker that has something useful to report mid-task has no way to say it without ending its turn. ADR-0028 rules the channel in; ADR-0028's delivery-lane record settles **how** it arrives: on the existing `peer` wake lane, queued during a user turn. Today the worker prompt still says the only channels back are the final answer and the access ask.

## What to do

- [x] Provide a worker-side verb that reports to the owning dispatcher **without** ending the turn, without settling the worker, and without producing a completion-kind wake.
- [x] Deliver it through the existing `peer` wake lane. **No new lane, no new `WakeEvent.source`, no new wake kind** (ADR-0018 C15 stands).
  - During a user-owned turn it **queues**: `enqueuePeer` fails closed on unknown ownership (`src/core/wake-bus.ts:666-670`) and the notice flushes at turn end (`:825-836`).
  - Only a priority peer interrupts, and only a `worker-settled` or `peer` turn (`:678-690`). A user turn is never interrupted.
  - Do not call `agent.steer` / `agent.inject` for replies. Do not depend on `requestDispatcherInterrupt` — it is a no-op on this install (`src/adapter/cordis-dsh-host.ts:859-867`).
- [x] Keep the reply distinguishable as a reply in its **text** (the existing "Peer message — not from the user" heading already separates it from user text). The source remains `peer`; that is the accepted consequence of the settled lane choice. Do not add a second wake kind to fix it.
- [x] Enforce the single-parent rule: the reply reaches only the dispatcher that owns the worker. No worker-to-worker and no cross-dispatcher delivery.
- [x] Bound it: rate and text caps. State them before implementation and reuse the peer caps where they fit (8,000 characters; rate limit per sender).
- [x] Update `src/worker/prompt.ts` so the "only channels back" sentence names this channel. (Ticket 119 carries the wider text pass; if 119 lands first, this ticket only verifies the sentence.)
- [x] Tests: a reply does not settle the worker and does not complete a todo; it arrives as a queued peer notice during a user turn and flushes after; a priority reply interrupts a peer turn but not a user turn; the owning dispatcher is the only recipient; the worker's final answer and access ask still behave as before.

## Constraints

- The worker-leaf and no-worker-to-worker rules are untouched.
- No new saved identity and no roster entry (C13).
- A reply never counts as user presence, never satisfies an approval ask, never opens a user wake.
- The access ask (ADR-0008) is a separate structured relay and is not replaced.
- Offline tests; no live dsh.

## Comments

### 2026-10-18 — filing

Filed for ADR-0028. The lane was the one open question in the ADR; the owner settled it on 2026-10-18 with "do whatever ZCode does", which matches the conservative half our `enqueuePeer` already implements. The Q1 evidence note had recommended a separate lane; the owner ruling outranks it, and the accepted consequence — the reply carries the peer source — is recorded in the ADR rather than engineered around.

## Answer

Resolved 2026-10-21 — audited against the shipped tree; every claim below was spot-checked at the cited line.

**The verb.** `reply_to_dispatcher` is declared at `src/core/tools.ts:265` with a model-facing description that never offers an address (:294-300). It is absent from the dispatcher tool surface and registered ONLY on the worker's scoped surface via `WORKER_LOCAL_TOOL_NAMES` (`src/worker/agent-def.ts:8-19`; pinned by `test/worker-reply.test.ts:454` — absent for dispatchers, :462 — registered on the worker scope, :480 — the barrier does not deny it, worker-only not dispatcher-only).

**Single-parent by construction.** The handler resolves the caller through core truth (`resolveWorkerId` + `multitask.getWorker`, with a refusal for any caller that is not an owned worker, `tools.ts:386-397`) and takes the destination from the worker's own roster record — `record.parentSessionId` (:392, :447). There is no recipient parameter at all, so no worker→worker and no cross-dispatcher path exists (tests :176 — a supplied target is ignored, :491 — no recipient argument).

**Lane.** The reply rides `multitask.sendPeer` into the existing peer wake lane (:457). The bus's source set is unchanged (`src/core/wake-bus.ts:23-31`) — no new lane, no new `WakeEvent.source`, no new wake kind; ADR-0018 C15 stands. Replies are enqueued non-priority by recorded design — "A mid-task report must never preempt the dispatcher's user turn" (`tools.ts:450-452`) — so during a user-owned turn the notice queues and flushes at turn end (test :287), and a reply never interrupts any turn; the lane's own priority-interrupt rule (only a priority peer, only a `worker-settled`/`peer` turn) stays pinned by `test/wake-bus-peer.test.ts`. No `agent.steer` / `agent.inject` and no dependency on `requestDispatcherInterrupt`.

**Not a completion.** The side-effect contract never touches the worker FSM, the todo ledger, or a completion path (`tools.ts:339-345`); pinned: a reply does not settle the worker, complete a todo, or end the turn (test :211), and the two wake shapes the dispatcher distinguishes are unchanged (:248). Provenance is structured, not a text prefix — origin `{ kind: "worker-reply", workerId, status? }` (:438-442) survives inbox accept and renders as not-from-the-user (tests :374, :398, :433); an ordinary dispatcher peer message carries no origin (:433). A reply is never user presence and never satisfies an approval ask.

**Bounds.** Text cap 8,000 characters — the peer lane's own `SEND_PEER_TEXT_MAX_CHARS` (`tools.ts:245`, reused at :276, enforced with a clear refusal at :407-412; test :317 accepts at the cap and refuses one over). Rate: 8 accepted replies per worker per rolling 60 s, refusals not counted (:285-291, :425-436; test :346); the inbox's 64-undelivered cap is the second independent bound (:288).

**Distinguishability in text.** The source remains `peer` — the accepted consequence of the settled lane — and separation from user text comes from the existing "Peer message — not from the user" heading plus the structured origin (tests :374).

**Prompt.** `src/worker/prompt.ts:61` now reads "Your only channels back are your final answer, the mid-task reply described below, and, when a gated action needs one-time access, the access ask described below", and the "## Mid-task reply" section (:67-70) names the tool, the status words, and the parent-only reach. The contract test pins the sentence (`test/worker-reply.test.ts:522-526`). The access-ask section is untouched — still a separate structured relay (ADR-0008); ticket 119 owns the wider text pass.

Tests: `test/worker-reply.test.ts` — ownership/routing (:114, :151), not-a-completion (:210), delivery lane (:286), bounds (:316), provenance (:373), worker-only surface and barrier (:453).
