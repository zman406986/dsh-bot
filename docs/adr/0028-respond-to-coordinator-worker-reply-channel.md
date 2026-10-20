# A worker→dispatcher mid-task reply channel, distinct from the completion report

**Status:** agent-drafted 2026-10-18 from the owner's decision 4 (see `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions"); **owner-reviewed and corrected 2026-10-19** — this ADR records what we adopt first, not a ban on anything else. No ADR is superseded. The delivery lane in §Starting delivery lane is a first-implementation choice, not an owner ruling.

**Numbering:** 0028, the fourth free number at filing (2026-10-18; 0024 was the highest in use before this pass). Filed by the records pass from the owner's 2026-10-18 decision, recorded in `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 4. The human ruled the direction; the text below is the agent's draft of it. Implementation is ticketed separately per repo rule; no source was edited in this pass.

## Context

ZCode v3.15.1 has a dedicated worker→dispatcher reply channel, `RespondToCoordinator`, distinct from the completion report; parent→child stays `SendMessage` (steer/queue/resume), and there is no child↔child channel (`docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Subagent mechanics (ZCode)"). We have no equivalent. Today the worker contract in `src/worker/prompt.ts` states: "Your only channels back are your final answer and, when a gated action needs one-time access, the ask described below." So a worker that has something useful to say mid-task has no way to say it without ending its turn.

ADR-0003 does not block this ruling: it governs spawning and worker↔worker messaging, not a worker's reply to its own dispatcher.

## Decision

1. **Add a worker→dispatcher mid-task reply channel (ZCode's `RespondToCoordinator` is the model).** It is **distinct from the completion report**: a worker can use it to report something to its owning dispatcher **without ending its turn**, and it does not settle the worker or produce a wake of the completion kind.
2. **Parent→child keeps the existing steer path.** Steering, interrupt-at-step-boundary, and last-wins are unchanged. The reply channel is the other direction and a different verb.
3. **No child↔child (the owner said this explicitly).** A worker does not address another worker or another dispatcher's worker. The reply reaches the dispatcher that owns the worker (ADR-0003's single-parent rule binds).
4. **The worker contract must document it.** `src/worker/prompt.ts` must be updated so its "only channels back" statement names this channel. As of this records pass it does not, and that gap is a known, recorded obligation of the implementing ticket — not a resolved item.
5. **Provenance is structured, not the user.** A mid-task reply is marked as from an agent. It is not user input and does not satisfy an approval ask; a wake it causes is a peer wake, not a user turn.
6. **No new saved identity (ADR-0018 C13 binds).** The channel carries no new saved identity and creates no roster entry.

## Starting delivery lane (first implementation)

The owner's instruction was **"do whatever ZCode does"**, and the answer follows from how ZCode delivers a mid-turn message: it **steers mid-turn only when the parent was registered with a message sink**; otherwise the message **queues and flushes at the next session-ready point** (`RespondToCoordinator` → parent runtime command queue, `mode: "subagent-message"`).

Our existing `enqueuePeer` (`src/core/wake-bus.ts:662-723`) already implements the conservative half of that behaviour, so the first implementation uses it rather than building a new lane:

1. **Route `RespondToCoordinator` through the existing `peer` wake lane.** This is the first implementation. ADR-0018 C15 (single wake kind) binds; a ticket that needs a new wake kind records the amendment.
2. **During a user-owned turn it QUEUES.** `enqueuePeer` fails closed on unknown ownership and treats a user-owned turn as user-owned (`:666-670`); the notice is held and flushed at `noteTurnEnded` (`:825-836`) as a turn-opening `followup`. The reply does not interleave into the user's answer.
3. **Only a priority peer interrupts, and only a non-user turn.** `enqueuePeer` interrupts a `worker-settled` or `peer` turn for a priority notice (`:678-690`); a user turn is never interrupted. There is no host primitive that opens a turn while a turn is running — the only mid-turn insertion point is `agent.steer` / `agent.inject` at the next step boundary — and this first implementation does not use it for replies. A future ticket may adopt a different lane by stating the tradeoff.
4. **The host semantics behind this are recorded evidence, not assumption.** `send` has exactly three input verbs (`followup` → next-turn + wake; `steer`/`inject` → next-step); see `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q1. `agent.cancel` is a stop, not a wake, and discards pending inbox work — so preempting a user turn is not something the host offers.
5. **`requestDispatcherInterrupt` is a no-op on this install** (`src/adapter/cordis-dsh-host.ts:859-867`). The first implementation does not depend on mid-turn cancel.

**Recorded tension.** The Q1 evidence note recommended a *separate* lane (a new `WakeEvent.workerMessages?` on the background side) so a worker report is not answered as a peer conversation. The first implementation takes the owner's "do whatever ZCode does" reading and reuses the existing lane; the separate-lane option remains open and would need a ticket that states the C15 amendment it requires. The accepted consequence of the first implementation: a reply arriving this way carries the peer source and the dispatcher may treat it as a peer message. The implementation ticket may still make the text distinguishable (the existing "Peer message — not from the user" heading already separates it from user text).

**What this closes.** Open question 1 below ("where a mid-task reply lands") has a first-implementation answer: the peer lane, queued during a user turn, flushed at turn end.

## Consequences

- The worker's channel list becomes: final answer, access ask, and mid-task reply. The prompt text must say so, and a test should pin that the contract names all three.
- The dispatcher needs a disposition for a mid-task reply. First implementation: the reply rides the existing `peer` wake lane, queues during a user-owned turn, and lands at turn end (§Starting delivery lane).
- A mid-task reply does not create a settle record, does not complete a todo, and does not change worker state. Anything that reads worker state must distinguish it from the final answer.
- The worker tool barrier and the worker's tool surface are the ticket's: if the channel is a tool, it registers on the worker side; if it is a host primitive, the adapter owns it. Whether a dispatcher-side counterpart is needed is also the ticket's.
- **PRD sections needing amendment (ticket-owned, not amended here):** §5 (Worker definition and roles diagram), §6.2 (Worker contract — Context/Tools/Report rows), §6.3 (tool table — the dispatcher side of the channel), §6.4 (wake model — how a mid-task reply is handled), §7.6 (Phase 2 peers, the worker row), §16 (glossary).

## Open questions

1. ~~**Where a mid-task reply lands** when the dispatcher is mid-conversation with the user — a turn-opening wake, or folded into the next reconcile?~~ **First implementation:** the existing `peer` wake lane; it queues during a user turn and flushes at turn end (§Starting delivery lane). A separate lane remains an open option.
2. **How much a worker may send** — rate and text bounds are the ticket's.
3. **Whether the dispatcher can reply back inside the worker's turn.** The ruling names the worker→dispatcher direction; parent→child is the steer path, and whether a non-steering reply exists is unset.
4. **The channel's surface** — a tool the worker calls, or a host primitive the adapter wires. The ruling does not choose.

## Traceability

- Ruling: `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 4 (level-1 dated human ruling; the ADR text is the agent's draft of it); ZCode shape in the same file, §"Subagent mechanics (ZCode)". The ruling's own words include "no child↔child", so that restriction is the owner's, not agent-added.
- Delivery-lane evidence: `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q1. The lane choice recorded here is the first implementation's, not a ruling.
- Worker contract gap: `src/worker/prompt.ts` (`buildWorkerSystemPrompt`, "Limits" section: "Your only channels back are your final answer and, when a gated action needs one-time access, the ask described below.").
- ADRs: 0003 (worker-leaf, single-parent, and no-worker-to-worker rules bind), 0008 (the access ask is a separate structured relay and is not replaced), 0018 (C13/C15 bind), 0025 (mitosis does not change the worker rule), 0026/0027 (room and discovery channels are unrelated).
