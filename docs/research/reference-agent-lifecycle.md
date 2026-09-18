# Research: what actually controls agent lifecycle in the reference tree

- Question: If prompts do not control lifecycle, what does — for both the main agent and subagents? Specifically: how are they created, what makes them report back, is there a heartbeat and a heartbeat listener, and how do they terminate?
- Scope: reference tree only (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`). Structure and behavior in plain language; **no code, prompt text, tool strings, identifiers, or protocol artifacts copied**. Evidence cited as paths only.
- Related: `reference-agent-prompt-inventory.md` (why prompts are not the mechanism), `reference-architecture-patterns.md` (C1 wake composition, C2 coordinator, C6 durability), `reference-behavior-notes.md`.
- Date: 2026-09-18

---

## Verdict

**There is no heartbeat protocol and no heartbeat listener.** No worker pings a parent; no scheduler polls worker health. Three different mechanisms cover what a heartbeat would have covered, and they are deliberately not the same thing:

1. **A one-shot completion callback** — the only push. Fires once when a worker settles, and does not mean "alive," only "finished."
2. **Pull-on-demand progress** — elapsed time, tool-call count, a recent-activity snapshot, transcript path. Liveness is *observed when asked*, never announced.
3. **A queue watchdog timer** — armed only when a **user** task is waiting behind a long-running run. It is a *queue-liveness* guard, not a worker-health probe, and its remedy is **abandon-and-advance**, not kill.

Separately, "they must report back" is **not** enforced by liveness at all. It is enforced by a durable **acknowledgement-obligation ledger with bounded redrives** — a delivery guarantee that survives restart.

The division of labour is the interesting part: **liveness protects the user's responsiveness; obligations protect the user's information.** Neither one protects the worker.

---

## 1. Main agent lifecycle

A main agent is not a process. It is a **session + runner** that is minted on demand, run exclusively, and evicted when idle.

**Creation is two-phase.** The lifecycle class exposes a mint → commit-or-discard protocol: mint a session identity, then either commit it by opening the session or discard the mint on failure. Creation paths are the interactive one, a background one, and a clone from an existing agent. A created agent is then "kickstarted," with the kickstart reporting whether the agent is run-ready.

**Evidence:** `source/host/extensions/transcript/agent-lifecycle.ts` (`createAgent`, `createBackgroundAgent`, `mintAgentSession`, `commitOpenedSession`, `openMintedSession`, `discardMintedSession`, `cloneAgent`, `kickstartAgent`)

**Run admission is a per-agent exclusive queue.** One active run per agent, three priority lanes (user > agent > background), and the scheduler is a **feature-flagged replacement for a plain promise chain** — with the scheduler disabled, runs still serialize, they just lose lanes and the watchdog. There is a kill switch and env-tunable watchdog timings.

**Evidence:** `source/host/extensions/transcript/run-scheduler.ts`; `source/host/extensions/transcript/run-lifecycle.ts` (`enqueueExclusiveRun`, `isRunSchedulerDisabled`)

**Entering a run is re-entrant.** An in-flight counter per session is incremented on begin and decremented on end; the "run window" opens on the first begin and only closes when the count returns to zero. So nested runs (a run that itself triggers a run) don't corrupt the window.

**Observability is derived from the stream, not reported by the agent.** Activity, a "composing a message" flag (inferred from a pending send-tool call), a "retrying" flag, and an activity label with a max hold time to stop the UI flickering — all computed from stream updates and projected onto agent records. A parent also counts as *running* while its workers are running.

**Evidence:** `run-lifecycle.ts` (`beginSessionRun`, `endSessionRun`, `trackActivityFromUpdate`, `trackComposingFromUpdate`, `withRunStates`, `liveRunningAgentIds`)

**Termination is idle eviction, not a kill.** On the last end-of-run: clear turn state, schedule the ack redrive, then retire the session — expire auto-review approvals, drop the runner and live-session entries, dispose the agent store, close the DB — but only if the session is not the active one and has no in-flight runs.

**Explicit deletion** is separate: delete-agents runs over a set of ids, and interrupts the agent for deletion first.

**Evidence:** `run-lifecycle.ts` (`retireSession`, `closeSessionWhenIdle`); `agent-lifecycle.ts` (`deleteAgent`, `deleteAgents`, `runDeleteAgents`, `interruptAgentForDeletion`)

---

## 2. Subagent lifecycle — creation

Dispatch is **idempotent** (a second dispatch for a live worker id is a no-op) and maintains **five parallel maps plus two sets**: live runner handles, the run promise, immutable runtime meta, the observable status registry, and post-mortem outlines — plus a parked-steer map and an aborting set.

Two derivations matter:

- **The display title is derived from the prompt**, not authored by the dispatcher.
- **The worker's request id is derived from the parent's tool-call id**, which enforces *one worker ⇔ one parent tool call*. A lineage chain (parent request id, parent tool-call id) is recorded for attribution.

The observable status model is a four-state enum on a registry record: **running, done, error, aborted**. Dispatch fires a fan-out of events in one step — a dispatch event, a **pending-wake armed** marker for the durable ledger, a registry-changed event, and an async-tasks-changed event — then starts the turn.

**Evidence:** `source/host/runner/subagent-runtime.ts` (`dispatchBackgroundSubagent`, `SubagentRecord`, `computeSubagentRequestId`)

**Note the asymmetry worth stealing or avoiding:** the durable wake marker is armed *at dispatch*, before the work runs, whereas the observable status record persists after the runner handle is deleted. So "there was work" is durable from the start; "the worker" is not.

---

## 3. Subagent lifecycle — reporting back

This is the answer to "what ensures they report back," and it is **not** a worker action.

The chain is: worker settles → the runtime fires a **settlement callback** → the parent-side handler queues it → a **synthesised parent turn** runs.

Parent-side handler behaviour, in order:

- Drop immediately if the parent agent has been deleted (recorded as a distinct outcome).
- **Deduplicate by worker id** — a duplicate completion for the same worker is discarded silently.
- Queue per parent, and guard against re-entrant revival with an in-progress set, so one parent never runs two revival loops concurrently.
- **Coalesce**: drain the whole queue and build **one** wake for N completions, then loop while more arrive.
- For each consumed completion, **clear its durable pending wake** marker.
- Run the wake as a **hidden turn on the background lane**, with **silence explicitly allowed**.

Because the wake is a real turn, the parent is free to deliver, to stay silent, or to start more work. Two carry-forwards are wired in: **unanswered user-question prompts are re-supplied** to the revival turn (so a pending question isn't lost), and an **approval epoch of "continue"** is passed so approval state survives.

**Outcome taxonomy** (all telemetried): `delivered`, `superseded` (the run was aborted by a newer run), and `dropped` with a reason of `no_runner`, `session_unavailable`, `quiesced`, `error`, `agent_deleted`, or `agent_gone`.

**The completion payload can never be empty.** The result text is trimmed, and empty, aborted, and error outcomes are each substituted with a canned line. So a parent always receives *something* it can reason about, and always with the worker's title and type attached.

**An aborted worker never reports back at all.** On settlement, an aborted worker disarms its pending wake and returns before any completion event. Abort is silent by design.

**Routine-initiated work is treated differently.** Completions carry an optional "quiet origin" (which routine, or an unnamed quiet self-initiated run). When *every* completion in a batch is quiet-origin, a different instruction variant is used that strongly prefers silence and only permits one message if the outcome is genuinely new, actionable, or a blocking problem.

**Evidence:** `source/host/extensions/transcript/completion-revivals.ts` (`handleBackgroundSubagentCompletion`, `reviveForSubagentCompletions`, `runSubagentRevival`, `isAllQuietOrigin`); `subagent-runtime.ts` (`settleBackgroundSubagentTurn`)

---

## 4. Liveness: the watchdog, and what it is not

The scheduler's watchdog is the only liveness mechanism in the system, and it is **conditional, not periodic**.

- It is **armed only when a user-lane task is waiting behind an active run.** No waiting user, no watchdog. A background run wedged for an hour is not noticed by anything.
- The delay is computed as `watchdogMs − already-waited`, so a user who has already waited most of the budget isn't made to wait the full budget again.
- On trip: best-effort interrupt of the wedged run (the interrupt's success is captured and telemetried, but failure is swallowed), the active run is marked `interrupted`, and a **grace timer** starts.
- On grace expiry: **escape.** The active task's promise is *resolved* (not rejected), the old run's settle promise is parked in a **zombie set** so that `drain()` can still await it, the active slot is cleared, and the queue pumps the next task.
- A **generation counter** distinguishes a late settle from a current one: when a zombie finally finishes, its settle hits the stale-generation branch and only produces telemetry. It does not disturb the queue.

**The critical semantic: escape abandons, it does not cancel.** The wedged run keeps running as a zombie — still consuming resources, still unsupervised — while the user's work proceeds. The system trades resource waste for guaranteed responsiveness. Nothing kills a runaway run.

Defaults are a two-minute watchdog with a thirty-second grace, both env-tunable, and the whole subsystem is behind a kill switch.

**Evidence:** `run-scheduler.ts` (`armWatchdog`, `onWatchdogFired`, `escapeWedgedRun`, `onTaskSettled`, `zombies`); `run-lifecycle.ts` (defaults, env lookups, kill switch)

**Progress reporting, by contrast, is entirely pull-based**: list running workers → per worker, elapsed ms, observed tool-call count, a recent-activity snapshot, and the transcript path. Nothing pushes; the parent asks.

**Evidence:** `subagent-runtime.ts` (`buildRunningSubagentInfo`, `listRunningSubagents`, `getRunningSubagent`)

---

## 5. The delivery guarantee: acknowledgement obligations

This is the subsystem that actually makes an agent report back, and it is independent of liveness. An obligation means *this agent owes the user a visible acknowledgement*.

- **Storage**: a small JSON sidecar with a versioned envelope and an atomic `.part`-then-rename write, behind an in-memory cache. Every field is defensively coerced (`Math.max(1, coalescedCount)`, clamped attempt counts) and every filesystem call is wrapped, so a corrupt or missing file degrades to "no obligations" rather than throwing.
- **Created** when a user message is accepted for an agent. There is also a **deferred scope-exit guard** that creates the obligation on disposal if none exists, and an interrupt-confirmation path. Repeated sends **coalesce** into one obligation with an incremented count rather than multiplying obligations.
- **Fulfilled** only by a run holding a **live run token**: tokens are minted per agent (a UUID added to a per-agent set) when a run that could satisfy the obligation starts, and retired when it ends. Fulfilment requires the token to still be live, then clears the ledger entry and the timer, and reports **time-to-first-visible-ack** (plus interrupt-to-replacement-ack when there was an interrupt).
- **Redriven** when the agent goes idle (after a short delay) and, importantly, **on boot** — every outstanding obligation in the ledger re-arms a redrive. That is the crash-recovery story.
- **Redrive** resolves the session and runs a hidden background-lane recovery turn whose instruction tells the agent that messages were never acknowledged, that its newest message **may be missing from context entirely**, that it must actually invoke the send tool rather than reason about sending, and that it must never guess or claim completion of work it cannot see.
- **Bounded**: a maximum of three redrive attempts, then the obligation is marked **lost** with reason `max_redrives`. An agent that has been deleted also marks it lost (`agent_deleted`).
- **Outcomes telemetried**: created, coalesced, redrive, fulfilled, lost. A redrive run that *still* delivered nothing is separately reported as an empty-delivery event with the outstanding-ack flag set.
- **Group and remote rooms opt out**: their obligations are cleared rather than redriven.

The whole subsystem is gated on the acknowledgement store being present **and the run scheduler being enabled** — so with the kill switch on, both the watchdog and the delivery guarantee disappear together.

**Evidence:** `source/host/extensions/transcript/sand-ack-obligation-store.ts`; `source/host/extensions/transcript/ack-obligations.ts` (`recordAckObligationSend`, `armSendGuard`, `mintAckRunToken`, `fulfillAckObligation`, `redriveAckObligation`, `redriveUnfulfilledAckObligations`, `MAX_ACK_REDRIVES`); `run-lifecycle.ts` (`scheduleAckRedriveAfterIdle`, `retireAckRunToken` on escape); `agent-lifecycle.ts` (`markAckObligationLost`)

---

## 6. Steering and termination

**Steering is interrupt-then-resume, not mid-stream injection.** A steer parks the message in a per-worker map — which gives **last-wins** for free, since a second steer overwrites the first — then interrupts the current turn. On settlement, if a steer is parked, the worker is not aborting, and a runner still exists, the runtime starts a **new turn on the same session** with the steer text. Context is preserved because it is the same session, not because anything was injected into a live stream. Result is `ok` or `not-running`.

**Termination is cooperative and ordered.** Abort first marks the worker as aborting (so the settlement handler will not resume it), clears any parked steer (so a queued steer cannot resurrect it), disarms the durable pending wake, and only then interrupts. The actual state transition happens later, when the run promise settles.

**Settlement cleanup**, in order: drop the run promise; check for a parked steer and resume if present; otherwise resolve final status by precedence (aborting flag, then aborted, then completed→done, else error); snapshot the resolved outline so it stays readable after death; free the computer-use window; delete the runner handle and the runtime meta — **but keep the status registry record**, so the worker remains visible as a finished entry.

**Evidence:** `subagent-runtime.ts` (`steerSubagent`, `abortSubagent`, `settleBackgroundSubagentTurn`, `drainBackgroundSubagents`)

---

## 7. Restart: what is durable and what is not

Durable: **wakes and acknowledgements** — small versioned sidecar ledgers written atomically. Not durable: **workers, sessions, steers, run promises.** On restart the system redrives wakes and acks; it does not reconstruct workers.

A separate upgrade path exists: when a run returns "quiesced for upgrade," the invocation does not silently vanish — the agent is marked resume-pending so the work can be picked up after the upgrade.

**Evidence:** `sand-pending-wake-store.ts`, `sand-ack-obligation-store.ts`, `sand-upgrade-resume-store.ts`, `durable-file-policy.ts`; the quiesce branches in `completion-revivals.ts` and `ack-obligations.ts`

---

## 8. Implications for dsh

1. **This confirms the PRD's wake shape, and gives us its implementation.** "Worker finishes → dispatcher gets a hidden turn that is allowed to be silent" is exactly the reference's mechanism, and it is why a worker never needs a user channel (PRD S5, ADR-0003). Worth keeping: batch N completions into one wake, dedupe by worker id, clear the durable wake on consumption, re-supply unanswered questions, and never let a completion payload be empty.
2. **Liveness is a design gap we inherit, not a pattern we copy.** The reference never checks whether a worker is healthy. It only guarantees the *user's* queue drains. If dsh wants the dispatcher to know a worker is wedged, that is **new** work with no reference precedent — and the reference's own answer ("abandon it, let it zombie") is a deliberate divergence candidate.
3. **Ack obligations are the closest analogue to our "completed means delivered" rule — but weaker.** The reference obliges a *first visible acknowledgement* and bounds it at three redrives, then gives up. The PRD's todo rule is stronger: `completed` means *delivered to the user*. So the mechanism is worth imitating (durable ledger, run tokens, boot redrive, bounded attempts, explicit lost reason), but the *criterion* must be ours.
4. **Restart redrives wakes and acks, not workers.** That aligns with ADR-0006's minimum-to-reconstruct WorkerRecord for undelivered results — the reference would keep honest amnesia, we keep a durable record. Note the reference's durability is *best-effort* by construction (every write is fallible-silent), which interacts with S4: a silently failed write is an undelivered result.
5. **Steer: the reference achieves "last-wins, preserve context, don't restart" by interrupt-and-resume-next-turn on a preserved session.** That is a legitimate way to realise the PRD's steer requirement without a mid-stream injection primitive. Worth having in the option space for §15.
6. **Avoid the coupling.** Watchdog and delivery guarantee share one enable-flag and one store. Disabling the scheduler silently removes both. For dsh these are two different concerns and should not share a switch.

---

## Method / reproducibility

Read the scheduler, run lifecycle, agent lifecycle, completion-revival handler, subagent runtime, acknowledgement-obligation controller and store, and the settlement path end-to-end; then traced every caller of the obligation and watchdog entry points to establish semantics rather than inferring them from names. Progress/liveness surfaces were read from the running-worker info builder.

Not done: the redrive *scheduling policy* module was not read, so delay/jitter beyond the idle delay constant is unverified. No semantic similarity comparison against our own design was performed.

---

## Open / unclear

- **The acknowledgement redrive policy** (delay, jitter, and whether it is bounded per boot) lives in a separate policy object that was not read.
- **The dedicated worker lifecycle state machine is unavailable.** The `agent-exec` lifecycle state-machine and its store are both tree-shaken to empty stubs in this reconstruction, retaining only their initialiser edges. Any real FSM that exists upstream in the referenced runtime is **not observable here** — so "the reference has a worker FSM" is not something this tree can evidence.
- **`interruptWedgedRunForWatchdog`** semantics are unverified: cooperative cancellation versus a hard stop is not established from the name, and the watchdog swallows the result either way.
- **Boot redrive of pending wakes**: whether it reconstructs anything about the worker or only re-wakes the parent is unconfirmed.
- **Known overhangs.** `reset()` clears the session map, status registry, and outlines, but not the run promises, runtime meta, or parked steers. `hasRunningSubagents` reads the status registry while `isRunning` reads the run map — two sources of truth for the same question, consistent with the overhang pattern recorded in `reference-architecture-patterns.md` C3.
