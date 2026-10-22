# 138 — A resumed spawned dispatcher cannot be messaged, and has no sidebar glyph

**Status:** deferred
**Labels:** needs-info
**Deferred:** 2026-10-22 — originally blocked on two human decisions; **only the glyph one remains** (ADR-0027 condition (a) plus a preset-row/seat design, now tracked by ticket 140). Half 1 (message resume) shipped here; the children (worker) half shipped as ticket 142.
**Blocked by:** (1) ~~a dated human ruling amending ticket 70's fence rule for message-triggered resume~~ — **LANDED 2026-10-22 for durable-marked bots; half 1 implemented here, children half implemented in ticket 142 (resolved)**; (2) a ruled preset-row design for the child's glyph (ADR-0027 §Starting identity and dispatch item 4, condition (a)) — still open, owned by ticket 140. Neither can be made from the code or the recorded rules.
**Related:** ticket 130 (resolved 2026-10-22 — the identity half; this ticket is its residual), ticket 70 (resolved — §2 produced the `unknown-target` liveness fence this ticket changes FOR MARKED BOTS ONLY), ADR-0027 (§Starting identity and dispatch item 4 condition (a) — no dispatcher preset row exists; §Settled 5 — `origin` wins for workers), ADR-0025 (a summoned dispatcher is a peer and keeps its own state), ticket 123 (session-kind indicators — the glyph machinery), ADR-0024 rider + addendum (the one licensed glyph registration), ticket 140 (the glyph half, now its own ticket), ticket 142 (resolved 2026-10-22 — the CHILDREN half of the same ruling, a separate ticket since 2026-10-22)

## Owner ruling — 2026-10-22

**Level-1 authority, dated.** Quoted: *"yes bots should be wake-able, both dispatchers and children."*

What it settles here: a bot the owner started can be woken by a message after a restart. It supersedes ticket 70 §2's phantom-target fence **for bots this plugin durably marked**, and only for them — an id with no mark is still refused `unknown-target`. The children (worker) half was split out and implemented as **ticket 142 (resolved 2026-10-22)**; this ticket's own residual is the DISPATCHERS half.

**Ruling on the two questions the fence blocker asked** (ticket 70's blocker asked "which targets count as live enough" and "what an accepted send does while the resume is in flight"):

1. **Which targets count.** A target counts when it is either a live dispatcher session (`isLiveDispatcherSession`) **or** carries our own `dispatcher_sessions` mark (`isDurablyMarkedDispatcher`). A mark-only target is accepted. Nothing else is.
2. **What an accepted send does in flight.** It is accepted into the peer inbox and wake lane exactly like a live send, and its wake asks the adapter to cold-resume the target. The delivery itself is deferred to activation: the wake turn is parked and opened once the resumed child exists. The ack copy is unchanged ("accepted; their next turn will see it"), so it promises nothing the mechanism does not do.

**Scope reversal, stated explicitly** (this ticket asked for it): ticket 57 R4 records our non-use of cold-resume as a deliberate posture. This half narrows that posture for ONE case — a send aimed at a durably marked dispatcher whose spawner is bound and live in the current process. It adds no general cold-resume, no replay, and no worker resume.

## Problem

Ticket 130 gave a spawned dispatcher a durable identity. A marked child is now re-activated on `agent/created` with `source: "resume"`. Two halves of the original loss list were open, and both needed a decision before code moved.

**Both are now settled.** Half 1 (message resume) shipped here on 2026-10-22, and its children (worker) half shipped as ticket 142 (resolved 2026-10-22 — `worker_sessions` + the steer fence + `wakeDormantWorker`). Half 2 (the sidebar glyph) is ticket 140 and remains blocked on the preset-row/seat ruling. **What is left in this ticket is ONLY the glyph half, and ticket 140 owns it** — this file is kept as the record of the split and the owner ruling, not as open work.

## Residual half 1 — message resume

**IMPLEMENTED 2026-10-22 (dispatchers half), see the comment at the end.** The paragraphs below are the problem as filed; they are kept as the record of what the ruling had to answer, not as open work.

After a restart the creator still cannot MESSAGE the spawned dispatcher.

`sendPeer` checks the target against `isLiveDispatcherSession` before it touches the inbox and refuses with `unknown-target` when the target is not currently an activated dispatcher (`src/core/multitask.ts:1484-1489`; wired to `lifecycle.isDispatcherSession` at `src/plugin.ts:658-659`). Ticket 130 re-activates a marked child only when the host announces it on `agent/created` — a cold resume driven by the host. Nothing resumes the child on a SEND, so a child that has not been re-announced answers `unknown-target`.

Completing this needs two things together:

- **Send-triggered cold resume.** The host's `ctx.subagents.sendMessage` cold-resumes an absent child (`docs/research/dsh-adapter-api-notes.md:83`, `:104`). Reading a mark and resuming the child before the fence is consulted is the shape.
- **A fence change.** The fence must stop refusing a marked-but-not-yet-live target, or check the mark first. That is exactly ticket 70's phantom-target rule: the fence exists so a sloppy send is refused instead of acking into an inbox nothing will ever drain (`resolved/70-peer-tier-dispatcher-to-dispatcher-messaging.md:242-248`; the design rationale is quoted at `src/core/multitask.ts:217-224`). Widening the fence to accept a target that is only durably known re-opens that rule.

**Blocker: a dated human decision.** Ticket 70's ruling is recorded, so an agent cannot amend it. The ruling must say which targets count as live enough to accept — a mark-only target, a resumed target, or some narrower set — and it must say what an accepted send does while the resume is still in flight.

**Also note.** Ticket 57 R4 records that our non-use of cold-resume is a core design decision, not an oversight, and that reversing it is a separate decision (`src/core/multitask.ts:1337-1339`). A send-triggered resume for dispatcher children would be a narrow reversal of that posture, and the ruling above should say so explicitly rather than leave it implied.

## Residual half 2 — sidebar glyph

The spawned child renders with no dispatcher glyph. The client draws a dispatcher from `projectionValues.sessionKind === "dispatcher"` (`src/client/session-kind.tsx:151-156`), and that projection folds the `/dsh-bot` `command/run` + `command/done` pair the host writes into the invoking session's own log (`src/adapter/session-kind-projection.ts:201-272`). A spawned child never runs a command, so it folds to `null`.

The client resolves kind from the roster/preset side: `origin === "subagent"` is tested FIRST and returns `worker` (`src/client/session-kind.tsx:149`). A preset row is the only other durable route to the glyph — ADR-0027 §Starting identity and dispatch item 4, condition (a): a preset id must exist and be selected at activation before a dispatcher session carries `agentPreset` (`docs/adr/0027-peer-awareness-pushed-at-prompt-tail.md:34`). Today no dispatcher preset row exists, and ticket 130 deliberately left `agentPreset` alone.

An independent preset row is a real design task, not a small edit: a child preset does not inherit the parent composition, so the row would have to declare the child's whole tool set (the eight dispatcher tools) and its prompt (the dispatcher policy), well over 80 lines, and keep it in step with the activation path ticket 130 built.

**Blocker: a ruled preset-row design.** The design must say what the row declares, how it stays in step with the `agent/created` composition, and whether `origin` keeps winning (it must for workers — ADR-0027 §Settled 5; ticket 130's "What is NOT proposed here" forbids changing that order). The ADR-0024 rider licenses exactly one sidebar glyph registration (`src/client/index.ts:293-306`); a second registration needs the ruling to say so.

## Origin

Split from ticket 130 at its 2026-10-22 resolution. Ticket 130 shipped the identity half — durable `dispatcher_sessions` mark, re-activation on cold resume, idempotent, no-mark stays plain — and closed. These two halves were in its loss list (peer acceptance) and problem statement (client kind); neither could be honestly ticked, so both moved here instead of being claimed as done.

## Open items — as of 2026-10-22, the glyph half ONLY

**Message resume is done**, both halves:

- the DISPATCHERS half shipped here (see the implementation comment below);
- the CHILDREN (worker) half shipped as **ticket 142** (`Issue-tracker/resolved/142-workers-wakeable-on-send.md`) — a `worker_sessions` row written at worker spawn, the steer/message fence accepting a marked dormant worker, `host.wakeDormantWorker` cold-resuming it with the same `RESUME_WAKE_CUE`, delivery on activation, and the ticket-59 hold resolved on live evidence.

**What remains in this ticket is the sidebar glyph, and it now has its own home:**

- `Issue-tracker/open/140-spawned-dispatcher-glyph-parity.md` records the real blocker (stock dsh filters every `origin: 'subagent'` session out of the sidebar before any row is built), which seat could render the mark, and the two rulings it needs. **Ticket 140 owns that work.**

This ticket therefore stays in `deferred/` as the record of the split and of the owner ruling that unblocked message resume. It should be closed (cancelled or merged) once ticket 140 resolves, not worked on directly.

## Reopen gates

Not applicable any more — the remaining half is ticket 140's, not this ticket's. Kept for the record:

1. ~~A dated human ruling amending ticket 70's fence rule, stating which non-live targets `sendPeer` may accept and how the send-triggered resume behaves in flight.~~ **Landed 2026-10-22 (owner ruling above), implemented here for dispatchers and in ticket 142 for workers.**
2. A ruled preset-row design for the child's glyph, per ADR-0027 condition (a), including how it keeps in step with the activation composition and whether the ADR-0024 rider's single-registration limit is extended. **Still open — but tracked by ticket 140, which supersedes this ticket's analysis of the blocker.**

## Constraints

- No gate, cap, or refusal class is added by either half.
- ~~No change to the worker path~~ — narrowed by ticket 142 for ONE case (a send to a durably marked, dormant worker), additively; the shipped live-worker steer path is unchanged and ticket 04's "stop is for good" holds (a terminal worker's wake row is dropped).
- No change to `resolveSessionKind`'s `origin`-first order.
- No invented marker: the identity marks stay ours (`dispatcher_sessions`, `worker_sessions`); `agentPreset` is not fabricated.
- Offline tests only (S8).

## Comments

### 2026-10-22 — filing (split from ticket 130)

Filed at ticket 130's resolution. Ticket 130 satisfied its identity acceptance: the mark is durable, a cold-resumed child is re-activated, a repeat resume does not double-register, and an unmarked child stays a plain subagent (`test/spawn-dispatcher-activation.test.ts:912`, `:932`, `:992`, `:1027`; `test/spawn-dispatcher-host.test.ts:376`, `:391`, `:409`; `test/adapter-durable-marker.test.ts:332`, `:343`, `:362`). Message resume and the glyph were both explicitly out of that implementation, and both reopen recorded rulings or need a design that does not exist yet, so they are parked here rather than left as unticked boxes on a closed ticket.

### 2026-10-22 — wake-on-send, dispatchers half implemented (owner ruling)

**Owner ruling (level 1, dated):** *"yes bots should be wake-able, both dispatchers and children."* This half is the dispatchers part. The children (worker) half is a separate follow-up ticket and is NOT done here.

**What a send now does at a marked, non-live target.** It is accepted and it wakes the target, in three steps:

1. **Fence.** `sendPeer` accepts when the target is live OR carries our own durable `dispatcher_sessions` mark. The live check still runs first and the mark is consulted only when the target is not live, so a live dispatcher takes the unchanged path. A target with NO mark still refuses `unknown-target` — ticket 70 §2's fence is intact. `src/core/multitask.ts` (`isDurablyMarkedDispatcher` option + the `sendPeer` fence), wired at `src/plugin.ts` to `host.isDurablyMarkedDispatcher`.
2. **Resume.** The wake path (`requestDispatcherWakeup` → `openWakeTurn`) finds no live Agent for a marked id, parks the wake turn, and calls `ctx.subagents.sendMessage(parentAgent, targetId, …)` — the host's own cold-resume seam (`docs/research/dsh-adapter-api-notes.md:83`). The sender is the spawner recorded on the mark, so the mark now carries `parentSessionId` (`src/core/durability.ts`, `src/adapter/durable-marker.ts`, written at `src/adapter/cordis-dsh-host.ts`). The resume payload is `RESUME_WAKE_CUE` (`src/adapter/wake-copy.ts`), never the peer text.
3. **Deliver on activation.** The host announces the cold-resumed child on `agent/created` (`source: "resume"`), ticket 130's activation path re-registers role, tools and policy, and only THEN is the parked wake turn opened — so the resumed dispatcher reads the peer message as a normal `agent-message` peer turn via `assemblePeerWakeTurn`. The peer message is delivered exactly once.

**Wiring detail worth recording.** The fence is synchronous, so the host keeps an in-memory mirror of the mark table (`isDurablyMarkedDispatcher` / `refreshDispatcherMarks`, fed by the new optional `DurabilityPort.listDispatcherMarks`). The mirror is warmed from the plugin's activation chain, AFTER `rebuildFromDurability` and behind ticket 90's generation guard, so it cannot consume a marker read that ticket 90 deliberately parks and a dead chain warms nothing. Marks written in this process enter the mirror synchronously at write time, so a fresh spawn needs no round trip. The mirror read happens on a dispatcher ACTIVATION, not at apply, so the marker store still opens lazily (nothing is touched on a boot that never activates a dispatcher); ticket 130's pin changed only in its assertion — the table may now exist after an activation, and it must hold zero marks before a spawn.

**Honest limits, stated.**

- A pre-138 mark row has no `parentSessionId`. It still passes the fence (it is not a phantom) but cannot be resumed from a send — the host needs the sender Agent. Those rows predate this ticket and no migration is attempted; the message waits in the inbox until something else resumes the child.
- If the spawner is not bound in this process (it never activated this boot), the resume is not issued and the message stays in the inbox for the next activation. No refusal class is invented; the send was accepted and that stays true.
- A failing resume call clears the one-request guard so the next send retries, and logs. A failing resume never becomes a refusal.
- The parked wake turn is re-opened with the origin of the send that parked it, so a priority send keeps its `agent-message` provenance and lane once the child is back. Several sends before the child returns coalesce into one turn that surfaces the whole inbox (the inbox is the delivery authority, as it already was).

**Tests (offline, all green — 289 in the final grouped run of every touched suite plus the canaries).**

- `test/message-agent.test.ts` — 4 new: marked-but-not-live accepts and requests the wake with the sender origin; unmarked unknown still refuses `unknown-target`; live + marked takes the normal path; absent mark knob keeps pre-138 behavior.
- `test/spawn-dispatcher-activation.test.ts` — 3 new end-to-end (real plugin `apply`, real `CordisDshHost`, storage tables surviving a simulated restart): a send to a marked dispatcher cold-resumes it through `ctx.subagents.sendMessage` from the SPAWNER, the child re-activates as a dispatcher (8 scoped tools, one policy inject) and receives the peer text as its wake turn with `agent-message` provenance; a marked-but-LIVE child takes the normal wake path with no resume call and no double activation; an unmarked unknown target still refuses `unknown-target` through the real wiring. The test ctx's `sendMessage` now models the host's cold resume (absent target → re-created and announced with `source: "resume"`) instead of returning a stub.
- `test/adapter-durable-marker.test.ts` — 1 new + 1 extended: `listDispatcherMarks` returns every row from the one shared domain; the mark schema validates the optional `parentSessionId` (a non-string is rejected rather than read as "no parent").
- Canaries: `test/multi-dispatcher-peer.test.ts`, `test/multitask-peer.test.ts`, `test/spawn-dispatcher-host.test.ts`, `test/adapter-cordis-dsh-host.test.ts`, `test/worker-reply.test.ts`, `test/restart-honesty.test.ts`, `test/multi-dispatcher.test.ts`, `test/plugin-scaffold.test.ts`, `test/activation-lifecycle.test.ts`, `test/durable-roster.test.ts`, `test/roster-snapshot.test.ts`, `test/wake-bus.test.ts`, `test/delivery-obligation.test.ts`, `test/await-agent.test.ts`, `test/feature-flag.test.ts`, `test/coexistence.test.ts`, `test/adapter-policy-inject.test.ts` — all pass. `npx tsc --noEmit` on both configs is clean.

**Left for the children (worker) half** — **DONE 2026-10-22 as ticket 142 (resolved)**, kept here as the record of what the follow-up had to answer:

- ~~A worker interrupted by a restart has no durable dispatcher mark and no spawner row of its own; the `workers` record does not survive, and the ticket-58/59 unknown-state hold is deliberately still a hold. Waking one needs its own ruling on which record carries the resume facts (worker marker vs. a parallel mark), and the same "what does an accepted send do in flight" answer.~~ **Answered by ticket 142:** its own table (`worker_sessions`, same domain, same no-bump rule) rather than reusing the obligation marker, because the two have opposite terminal lifecycles; and the in-flight answer is the same as this half's (accept, park, cue-resume, deliver on activation). On adoption the ticket-59 hold is resolved into a live roster record — live evidence outranks "we cannot tell".
- ~~The `RESUME_WAKE_CUE` wording is dispatcher-agnostic on purpose, so the children half can reuse it if the ruling says so.~~ **Reused unchanged** by `host.wakeDormantWorker`.

**Not moved to `open/`.** The glyph half is the only open item left (ticket 140 owns it); message resume is done in both halves, and this ticket stays deferred as the split's record.
