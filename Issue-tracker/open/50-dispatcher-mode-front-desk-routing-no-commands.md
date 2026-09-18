# 50 — Dispatcher mode is the front desk: activate without a slash command, and let the dispatcher decide the routing

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none for research/design/offline work. **Live** verification of any routed turn is co-blocked by 45 (dispatcher tool schemas are invalid JSON Schema — the provider rejects *every* activated turn, so no spawn/route can run against the real host), 44 (host-half commands never register live), 46 (client roster/flag feed dead), 47 (no plugin settings card).
**Related:** 19 (activation lifecycle — the `/dispatcher-start` + flag-matrix implementation this ticket reverses), 16 (activation model + ADR-0009), 17 (always-on epic — this is design-17 §3.1(b)/conflict 4's recorded revisit path), 31 (conversational stop semantics), 14 + ADR-0002 (peer inbox — the peer tier this ticket needs an outbound half of), ADR-0016 (drafted with this ticket pair), 51 (the dedicated dispatcher conversation surface this model pairs with)

## What the human asked for (verbatim intent, 2026-09-18)

> when dispatcher mode is turned on, expected behavior is a dispatcher bot acting as front desk/customer service, answer user first, then retell user requests to subagents they own / talk to other dispatchers who will talk to subagent they own - user should not need to do slash command and enter subagent id, or even the start slash command at all - the dispatcher decides which subagents to talk to.

## Current behavior vs the ask

| Ask | Today | Delta |
|---|---|---|
| Dispatcher answers the user first, then relays to subagents | Already policy: PRD §6.1 (`src/core/policy/prompts.ts`), wake-turn delivery shipped | Front-desk **framing** in policy/copy: ack → route. The ack must stay honest — PRD §6.4 anti-pattern "Opening ack that pretends work finished" stays banned. |
| User never enters a subagent id | Already true for workers — the dispatcher spawns them; `/dispatcher-steer` is a power path that design-17 §4.4 says "must never be *required*" | Nothing to build for workers; add a **structural pin** (no user-facing copy may name a worker id or a command as the way to reach one). |
| User never runs a start command | **`/dispatcher-start` is the only activation channel** (ADR-0009; `src/adapter/activation-command.ts`); with the flag ON a session boots *dormant* | **Reverse.** Activation moves to the mode boundary. This is ADR-0016 and is the load-bearing change in this ticket. |
| Dispatcher decides which subagents to talk to | True at the worker tier (spawn = the dispatcher's judgement) | Extend to the **peer tier**: routing across dispatcher identities that own their own subagents. |
| Talk to other dispatchers who own subagents | Inbound peer inbox shipped (ticket 14); **outbound `send_peer` dispatcher tool, fan-out directory, and out-of-process transport were explicitly out of MVP** | New work: outbound peer send tool + peer identity/directory + the spawn-authority question below. |

## Why this is bigger than a copy change — ADR conflicts, surfaced not silently overridden

`agent.md` requires contradicting an existing ADR to be **raised explicitly**. Five collisions, in order of severity:

1. **ADR-0009 (accepted) — "Activation is an explicit user command; the plugin no longer captures the primary chat on load."** Its consequences fix the matrix: "OFF = fully inert … ON + never activated = dormant (invisible plumbing + the command only); ON + activated = full dispatcher in that chat." The ask deletes the middle row. **This ticket reverses an accepted decision**; it needs the superseding ADR (0016, drafted alongside) rather than a quiet code change. Consent does not vanish — it moves from *per-session command* to *the mode boundary* (see 51: the user's own chats are never repurposed, which is what makes a default-on front desk consent-safe rather than the bug #19 removed).
2. **design-17 §3.1(b) already weighed and rejected exactly this**: "Default-activation (auto-activate the first top-level chat under a profile) | Rejected for Phase 2 | Re-introduces silent capture by another name — the bug #19 removed." And conflict 4's marker is the standing invitation to revisit: "record in the merge ticket that default-activation remains unadopted **by choice, not oversight**." The human has now made the choice; the revisit must be recorded as a decision, not slipped in.
3. **design-17 §13 non-goals** list "Default-activation, activation persistence, multi-chat dispatchers (§3.1)" and "Agent-identity surfaces … (Phase-2-peer territory)". The peer half of this ask is that territory.
4. **ADR-0003 (accepted) — flat topology: "Peers … remain dispatcher-level identities; this ADR grants them no spawn authority."** The ask's "other dispatchers who will talk to subagent they own" gives peers subagents of their own. Either (a) each peer is a *full dispatcher* in its own right with spawn authority scoped to itself — which needs the host to hold more than one bound parent, and ADR-0009 option C records why that is deferred ("`ctx.tools.register` is process-global … and the host is single-parent throughout"), or (b) peers stay childless routers, which does not satisfy the ask as written. **Resolve explicitly; do not assume (a).**
5. **CONTEXT.md glossary collision.** "Multitask profile" carries `_Avoid_: mode, setting` — the profile *is* the flag's home, not a runtime toggle (ADR-0005). The ask says "dispatcher mode is turned on". Either the human means the profile/flag (already exists) or a live mode toggle (reopens ADR-0005). **This must be disambiguated before implementation** — see D1. The glossary has no term for "front desk"; that is a real gap to note for `/domain-modeling`, not to invent here.

## Requirements

**R1 — Activation moves to the mode boundary.** With the mode ON, a top-level session must reach the front-desk experience with **zero user commands**. `/dispatcher-start` may survive as an idempotent, discoverable affordance (and as the recovery path when the mode is OFF) but must no longer be the only way in. Whatever replaces it must keep ADR-0009's auditability: the transition is still observable as a session event, and it still never hijacks a chat that the user is driving.

**R2 — Front-desk routing is the dispatcher's judgement.** The dispatcher answers first, then decides: answer inline, spawn a worker, steer a running worker, or forward to a peer dispatcher. No user-facing machinery vocabulary (PRD §6.1 "speak as one busy person"); the user never selects a target.

**R3 — No command is ever required.** No user-facing copy (activation, wake turns, errors, approval prompts, empty states) may instruct the user to run a slash command or name a worker id as the way to get something done. `/dispatcher-steer` stays an optional exact-target power path. Pin this structurally so a future edit cannot reintroduce it.

**R4 — Outbound peer tier exists.** A dispatcher must be able to *send* to a peer dispatcher asynchronously (ticket 14 shipped only the inbound half: `PeerEnvelope`, `sendPeer` in core, inbox, priority lane; "dispatcher `send_peer` tool" was out of MVP). Requirements: an async, fire-and-forget send with an ack (PRD S9), never silently dropping the user's lane, and a way to name a peer that is not "the user types an id".

**R5 — Routing across the peer tier is honest.** A peer that owns subagents must be represented truthfully — if a peer is unavailable or a forward cannot be delivered, the user hears it from the dispatcher in plain language. No invented peer, no fake delivery, no silent drop.

**R6 — Adapter/core layering holds.** FSM, routing policy, and the wake bus stay in the multitask core; spawn/interrupt/send stay behind the dsh adapter (AGENTS.md layer table, ADR-0001). Do not leak host specifics into policy.

**R7 — Clean-room and offline-first.** New copy only (en/zh, identical key sets). Tests run without network/LLM/running dsh (S8, FakeDshHost). The reference tree is **behaviour evidence only** and must not be open in the same session as product code (ticket 17 Phase-1 rule).

## Open decisions the implementer must raise, not guess

| # | Decision | Why it cannot be assumed |
|---|---|---|
| D1 | **What "dispatcher mode" *is*.** The profile/flag read once at session start (ADR-0005, already shipped) — or a live runtime mode toggle? | The glossary avoids "mode" for exactly this reason. If it is a live toggle, ADR-0005 reopens wholesale (and the off-while-running state returns). Recommended reading: the mode *is* the existing flag/profile; only its *meaning when ON* changes. Raise if the human meant otherwise. |
| D2 | **How many dispatchers can be active at once.** One per process (host single-parent, ADR-0009 option C) — or several? | "Other dispatchers" and ticket 51's "select and talk to dispatcher bots" both imply more than one identity. In-process multi-activation is blocked by process-global `ctx.tools.register` today (patterns note (a)). Decide: several *identities* with one active parent at a time, or a real concurrency change. |
| D3 | **Peer identity, directory, and transport.** | Ticket 14 deliberately left "messaging hub, fan-out directory, … out-of-process transport" out of MVP. Without a directory there is no "which peers exist"; without transport a peer is in-process only. |
| D4 | **Where the front desk speaks.** In the primary chat (ADR-0009's conversational delivery) or in ticket 51's dedicated surface? | The two tickets are one product model; this decides whether ADR-0009's "delivery remains conversational" is preserved in place or merely relocated. PRD S5 ("only the dispatcher delivers to the user") holds either way. |
| D5 | **Where the consent moment is recorded and shown.** | ADR-0009's whole point was consent + auditability. Moving consent to the mode boundary must still be *visible* — the user should be able to see, from inside a chat, that the mode is on and who is fronting it. |

## Acceptance criteria

- [ ] (offline, gate) With the mode ON, a top-level session reaches the front-desk state with **no command executed**; with the mode OFF the session is inert (no core, no tools, no listeners) — asserted over fake seams.
- [ ] (offline, gate) A structural pin asserts that no user-facing string instructs the user to run a command or name a worker id (R3), across policy assets, locale dictionaries, and activation/wake/approval copy.
- [ ] (offline, gate) Outbound peer send: async, ack-only, idempotent on re-accept, never preempts the user lane (extends ticket 14's priority-lane tests to the send side).
- [ ] (offline, gate) Routing policy tests: answer-inline / spawn / steer / forward-to-peer decisions are exercised without network or LLM, including the "peer unavailable" honest-report path.
- [ ] (offline, gate) `npm test` 0 fail and `npm run typecheck` clean on both configs; no regression in the dormant matrix asserted by `test/composition-polish.test.ts`, `test/activation-lifecycle.test.ts`.
- [ ] (live, ticket 33's lane, trivial prompts only) With the mode ON, a real launcher boot reaches the front desk and answers a one-line user message without any command being typed.
- [ ] ADR-0016 signed off (or amended to match what shipped) before this ticket is closed; the design-17 §5 conflict-4 revisit row is updated to record the decision.
- [ ] A design note exists under `.scratch/<slug>/` before implementation, of the design-09…design-17 family, covering D1–D5 with the resolutions and their evidence.

## Notes

- **Do not build this as one blob.** Like 16 and 17, this is umbrella-shaped: research/seam-verification first (especially the peer tier and whatever replaces the command), then a design note, then split tickets with blocking edges. The split may be small — the point is that each slice is independently offline-testable.
- **Order relative to the open live defects.** 45 is the hard one: while it stands, *no* activated turn completes against a real provider, so "the user asks and the dispatcher routes" cannot be demonstrated live at all. Fixing 45 first makes every live assertion in this ticket cheap.
- **The reference product's behaviour** (no activation step; capability resolved once at startup; left rail = agent roster) is already recorded abstractly and contamination-free in `docs/research/always-on-dispatcher-behavior.md:17,72`. Cite the note, not the tree.
- **Banned identifiers** in shipped code stay banned (`sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*`); clean-room grep is a ship gate (PRD §8/§12, S7).

## Comments

### 2026-09-18 — scribe pass (filed, not implemented)

Filed from the human's directive of the same date. Two judgement calls recorded here so the implementing team does not have to re-derive them:

1. **Split as two tickets, plus one ADR.** The routing/activation model (this ticket) and the conversation surface (51) are one coherent product model — "the dispatcher is the front desk" — but they are implementable and verifiable separately, and they collide with *different* ADRs (0009/0005/0003 here; 0013 + design-17 §6/§13 there). Draft ADR-0016 records the single load-bearing reversal both depend on: activation moves to the mode boundary and the dispatcher becomes an addressable bot. It is filed `-draft-nonhuman-approved`, consistent with the ADR-0013–0015 convention from ticket 37.
2. **No ticket was closed or re-scoped by this pass.** design-17's conflict-4 `revisit-before-merge` marker is *triggered*, not satisfied — the merge ticket (33) must still record that default-activation was adopted as a decision, now in the other direction. Likewise ADR-0003's peer spawn authority and the design-17 §13 non-goals are reopened on paper only; none of them is edited here.
