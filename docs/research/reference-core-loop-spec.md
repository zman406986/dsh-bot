# Reference core-loop spec — consolidated, for dsh fidelity audit

- **Purpose.** A single implementable description of the reference product's dispatch core loop, built for the ADR-0017 fidelity audit (ticket 52). It consolidates the two prior notes (`reference-agent-lifecycle.md`, `reference-agent-prompt-inventory.md`), which remain the citable authority for everything they already established, and **closes the four gaps they left open**.
- **Scope.** Reference tree only (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`). Concept-level description; behavioural facts only.
- **Legal rule (binding).** No source text, prompt text, tool strings, identifiers, or protocol artifacts reproduced. File names are cited as provenance only. Every mechanism is named in my own words. Self-audit in §4.
- **Evidence-grade legend** (used per element below):
  - **(a)** directly evidenced — named source file read this pass or by the prior notes.
  - **(b)** inferred — derived from surrounding call sites / types, not from the mechanism itself.
  - **(c)** unobservable in this reconstruction — cannot be evidenced here; not guessed.
  - **(d)** open — not resolvable from the tree as it stands.
- **Date.** 2026-09-18. **Author.** observation pass over the four open gaps.

---

## Part 1 — The four open gaps, closed

### G1. Acknowledgement redrive scheduling policy — **CLOSED (a)**

The redrive delay — the wait before a failed acknowledgement is retried — lives in a small scheduling helper, not in the obligation controller. Concretely:

- The obligation controller arms a timer through a policy object of type `ExpiryPolicy`, constructed as `createExpiryPolicy(clock, { name, ttlMs: ACK_REDRIVE_IDLE_DELAY_MS })`. `ACK_REDRIVE_IDLE_DELAY_MS` is a module constant equal to **5000 ms** (`ack-obligations.ts`).
- The `ExpiryPolicy` implementation (`internal/scheduling.ts`, `createExpiryPolicy`) does exactly one thing on `arm(key, onExpire)`: it calls `clock.schedule(ttlMs, onExpire)` and returns a disposable. There is **no jitter** — the wait is the literal `ttlMs`, with no randomization or backoff. Re-arming the same `key` disposes the prior timer, so the last timer set for a key wins, and the key is the agentId.
- **Delay:** fixed 5 seconds, both for the idle trigger (`scheduleAckRedriveAfterIdle`) and the boot trigger (`redriveUnfulfilledAckObligations` → `armAckRedriveTimer(..., "boot")`). No separate boot delay exists.
- **Bounded per boot? No.** The policy primitive itself is unbounded per boot — every boot can re-arm a fresh 5s timer. The *actual* bound is on the **persisted attempt counter**, not on the timer. `redriveAckObligation` refuses once `obligation.redriveAttempts >= MAX_ACK_REDRIVES`, where `MAX_ACK_REDRIVES = 3`. Each fire calls `store.recordRedriveAttempt(agentId)`, which increments `redriveAttempts` and writes the durable sidecar (`sand-ack-obligation-store.ts`). Because the counter lives in the durable ledger, the three attempts **accumulate across boots** — it is a 3-attempt lifetime bound, not 3-per-boot. After the third attempt the obligation is marked `lost` with reason `max_redrives`.
- The recovery turn runs as a hidden background turn — a turn on the background priority level — and is instructed, in my own paraphrase, to actually invoke the message-send tool (the channel is the only thing the user sees), to treat the newest user message as possibly absent from context, and never to claim completion of work it cannot see.

### G2. Boot redrive of pending wakes — **CLOSED (a): parent-only, worker never reconstructed**

- Entry point: at host startup the transcript manager is asked, via optional reflective calls, to run `rearmPendingWakes()` and `redriveUnfulfilledAckObligations()` (`sand-host.ts`). This is the crash-recovery path.
- `rearmPendingWakes()` (`pending-wake-rearm.ts`): first prunes markers older than a 48-hour stale age, then iterates every durable pending-wake marker. For each it (1) skips agents that are gone, (2) clears the marker, and (3) re-arms a wake for the **parent** (`marker.agentId`). Nothing about the worker is rebuilt.
- The durable marker shape is deliberately thin: `parentId`, `kind`, `workId` (the worker id), `markedAtMs`, and a little static metadata (`title`, `subagentType`, `quietOrigin`). **It carries no result payload.**
- Per wake kind the re-arm does different things, and only one of them is relevant to our workers:
  - **Subagent (our worker case):** `reviveParentForLostSubagentWake` re-persists the marker and then feeds the parent a **synthetic "interrupted" completion** — in my own words: a host restart ended this background task before its result could be delivered, the in-process run did not survive, its final state is unknown, check the transcript if needed, and dispatch fresh work if it still matters. The parent is thus told the task is gone; the worker is not resurrected.
  - Shell / cloud-agent wakes instead re-attach a *watch* on an externally-still-living process (`watchBackgroundShell` / `watchCloudAgent`). Those are not workers in our sense and are not reconstructed either — only re-observed.
- **Conclusion.** Boot reconstructs **nothing about the worker**. It re-wakes the parent, and for subagents supplies a synthetic lost-result notice. This refines (and agrees with) the prior note's §7 claim that "restart redrives wakes and acks; it does not reconstruct workers" — the re-wake is a parent-side prompt, not a worker rebuild.

### G3. Watchdog interrupt semantics — **CLOSED (a) for the scheduler's use; (c) for the runner's internals**

- The watchdog lives in the run scheduler. On trip it calls an injected callback `interruptWedgedRun(agentId)` once, records the returned boolean as `interrupted` telemetry, and **never branches on it**. It then marks the active run `phase: "interrupted"` unconditionally and starts a grace timer. On grace expiry `escapeWedgedRun` **resolves the run's promise and adds the run to a set of abandoned runs** — the underlying task keeps running unsupervised.
- The real implementation of that callback (`runner-registry.ts`, `interruptWedgedRunForWatchdog`) calls the registered runner's `interrupt(reason)` method (and the group-member runner's, if any) and returns whether an active run existed to interrupt. So the watchdog's *request* to the runner is best-effort.
- Whether the runner's `interrupt` is cooperative cancellation or a hard stop is determined inside the runner (agent-exec / runner code not among the files read for this note). **That internal semantics is (c) unobservable here.** But it does not change the observable loop: the scheduler abandons regardless. So the name `interruptWedgedRunForWatchdog` is **not** evidence of either cooperative or hard-stop behaviour — the watchdog's own behaviour is to signal and then abandon, identical in both cases. Treat the reference watchdog as something that **asks the runner to stop and then abandons the run**, not as something that cancels it.

### G4. Worker lifecycle FSM — **CLOSED: not evidenced in this reconstruction (c)**

- The dedicated worker state machine is `source/packages/agent-exec/subagent-lifecycle-state-machine.ts` and its `subagent-lifecycle-store.ts`. Both are **empty stubs**: `export {}` (the state-machine file) and an import of that file plus `export {}` (the store). Only the initializer edge survives tree-shaking.
- I checked the surrounding `agent-exec` package: other files there (execution timing, hook executor, error classification) are **populated**, so the package is not wholesale stripped — only the worker-lifecycle FSM and its store were removed by the reconstruction.
- **Plain statement for the people auditing this:** "the reference has a worker FSM" is **not something this tree can evidence**. There is no populated worker FSM to read, cite, or match against. Any dsh design that assumes a reference worker FSM must treat that assumption as (c) and design from first principles, not from the reference.

---

## Part 2 — The core-loop state machine (10 stages)

Ordered, implementable. Each sub-element carries an evidence grade.

### Stage 1 — Intake
- A user message is accepted for an agent; the session is created and committed and "kickstarted" run-ready. A run window opens on first begin and closes only when the in-flight counter returns to zero (re-entrant). **(a)** `run-lifecycle.ts` (`beginSessionRun`, `endSessionRun`), `agent-lifecycle.ts` (`createAgent`, `kickstartAgent`).
- On accept, an **acknowledgement obligation** is recorded for the agent (coalescing repeated sends into one obligation with an incremented count). **(a)** `ack-obligations.ts` (`recordAckObligationSend`, `armSendGuard`).
- An obligation is also created defensively on disposal if none exists, and on interrupt-confirmation. **(a)** `ack-obligations.ts` (`confirmAckObligationAfterInterrupt`).

### Stage 2 — Triage
- The decision to answer inline versus dispatch a worker is **not a separate coded check in the files read**; it is expressed as guidance in the main agent's prompt (a "delegating background work" section) plus the dispatcher's spawn path. **(b)** from `system-prompt.ts` delegation section (per prompt-inventory note) and the dispatch entry in `subagent-runtime.ts`. The loop is always-on and multitask is a standing mode, so triage is a per-turn model decision, not a branch the core loop enforces. **(c)** the exact dispatch-trigger code path is not isolated in this pass.

### Stage 3 — Spawn + contract assembly
- A worker is spawned idempotently (a second dispatch for a live worker id is a no-op) and tracked across five parallel maps plus two sets (live handles, run promise, immutable runtime meta, observable status registry, post-mortem outlines, parked-steer map, aborting set). **(a)** `subagent-runtime.ts` (`dispatchBackgroundSubagent`).
- The **display title is derived from the prompt**; the **worker request id is derived from the parent's tool-call id**, enforcing one-worker-per-parent-tool-call, with a lineage record. **(a)** `subagent-runtime.ts` (`computeSubagentRequestId`, `SubagentRecord`).
- **Contract composition (the central question for our D-1/D-3 — D-1 being how the worker contract is delivered, D-3 the missing shared safety section):** the worker's instructions are delivered as a **system prompt built by a dedicated subagent prompt constructor**, not as conversation-role content. The constructor takes a type string and a readonly boolean, interpolates the type name into one sentence, appends a fixed behavioural block (work autonomously; end with a plain-text final answer that is the result; no user channel; do not ask follow-up questions), conditionally appends a readonly line, and appends **one shared safety section constant**. **(a)** `system-prompt.ts` (the subagent prompt constructor and its shared safety section constant) per prompt-inventory note L2.
- The system prompt is assembled through the general context assembler; a subagent runner is differentiated from the main agent by `null`-guards on several sections, `canSendMessage: false` on the spotlight section, and a declined profile-snapshot lifecycle — **not** by a blank system prompt. "Blank context" for a worker means a blank *conversation*, not a blank *system prompt*. **(a)** `system-prompt-assembly.ts` per prompt-inventory note Appendix B.
- Observable status is a four-state enum (running / done / error / aborted); dispatch fires a fan-out of events in one step including a **durable pending-wake armed marker** and a registry-changed event. **(a)** `subagent-runtime.ts`.
- The durable wake marker is armed *at dispatch, before work runs*; the observable status record persists *after* the runner handle is deleted. **(a)** `subagent-runtime.ts`, `completion-revivals.ts`.

### Stage 4 — Concurrency
- **One active run per agent**, plus a background queue, governed by a per-agent scheduler with **three priority levels: user > agent > background**. The scheduler is a feature-flagged replacement for a plain promise chain; with it disabled, runs still serialize but lose the priority levels and the watchdog. **(a)** `run-scheduler.ts` (`enqueue`, `pump`, `takeNextUserTask`), `run-lifecycle.ts` (`enqueueExclusiveRun`, `isRunSchedulerDisabled`).
- A waiting user task behind an active run arms the watchdog; a background run wedged for an hour is noticed by nothing. **(a)** `run-scheduler.ts` (`armWatchdog`, `waitedBehindActiveMs`).
- Defaults: a two-minute watchdog and a thirty-second grace, both env-tunable, behind a single kill switch that disables the scheduler. **(a)** `run-lifecycle.ts`.

### Stage 5 — Steer
- Steering is **interrupt-then-resume on a preserved session**, not mid-stream injection. A steer parks the message in a per-worker map (the last parked message wins automatically), then interrupts the current turn. On settlement, if a steer is parked, the worker is not aborting, and a runner still exists, the runtime starts a **new turn on the same session** with the steer text — context is preserved because the session is the same. Result is `ok` or `not-running`. **(a)** `subagent-runtime.ts` (`steerSubagent`, `settleBackgroundSubagentTurn`) per lifecycle note §6.

### Stage 6 — Stop
- Termination is **cooperative and ordered**. Abort first marks the worker aborting (so settlement will not resume it), clears any parked steer (so a queued steer cannot resurrect it), disarms the durable pending wake, and only then interrupts. The final state is resolved later, on settle, by precedence: aborting flag → aborted → completed→done → else error. **(a)** `subagent-runtime.ts` (`abortSubagent`) per lifecycle note §6.
- **A worker that is aborted never reports back**: on settlement it disarms its pending wake and returns before any completion event. Abort is silent by design. **(a)** `completion-revivals.ts` / `subagent-runtime.ts` per lifecycle note §3.
- **A late result from a superseded run** is dropped: a newer run aborting an older one yields the `superseded` outcome; a settle that carries an out-of-date generation number from an abandoned run produces telemetry only, never disturbing the queue. **(a)** `completion-revivals.ts` (`superseded`), `run-scheduler.ts` (`onTaskSettled` stale-generation branch).

### Stage 7 — Settle → wake
- Worker settles → a **settlement callback** fires → the parent-side handler queues it → a **synthesised parent turn** runs. **(a)** `completion-revivals.ts` (`handleBackgroundSubagentCompletion`, `reviveForSubagentCompletions`, `runSubagentRevival`).
- Parent-side handler order: drop if parent deleted; **deduplicate by worker id**; queue per parent with an in-progress set guarding re-entrant revival; **coalesce** N completions into one wake and loop while more arrive; for each consumed completion **clear its durable pending wake**; run the wake as a **hidden turn at background priority, with silence explicitly allowed**. **(a)** `completion-revivals.ts`.
- The completion payload is **never empty**: empty/aborted/error outcomes are each substituted with a canned line, always with the worker's title and type attached. **(a)** `completion-revivals.ts` per lifecycle note §3.
- Outcome taxonomy (records a telemetry event for every outcome): `delivered`, `superseded`, `dropped` (reasons: no_runner, session_unavailable, quiesced, error, agent_deleted, agent_gone). **(a)** `completion-revivals.ts`.

### Stage 8 — Reconcile + deliver
- Because the wake is a real turn, the parent may deliver, stay silent, or start more work. Two pieces of state are carried forward: **unanswered user-question prompts are re-supplied** to the revival turn, and an **approval epoch of "continue"** is passed so approval state survives. **(a)** `completion-revivals.ts` (`collectUnansweredQuestionPrompts`, `autoReviewEpoch: "continue"`).
- Quiet-origin (routine / quiet self-initiated) completions use a variant that strongly prefers silence and permits one message only if the outcome is genuinely new, actionable, or blocking. **(a)** `completion-revivals.ts` (`isAllQuietOrigin`, `QUIET_REVIVAL_INSTRUCTION` per my paraphrase).

### Stage 9 — Obligation (if never delivered)
- An obligation means *this agent owes the user a visible acknowledgement*. It is **fulfilled only by a run holding a live run token** (issued per agent at the start of a qualifying run, retired when the run ends). **(a)** `ack-obligations.ts` (`mintAckRunToken`, `fulfillAckObligation`, `retireAckRunToken`).
- Redriven when the agent goes idle (after a short delay) and **on boot** (every outstanding obligation re-arms). **(a)** `ack-obligations.ts` (`scheduleAckRedriveAfterIdle`, `redriveUnfulfilledAckObligations`) — see G1 for the precise policy.
- **Bounded**: `MAX_ACK_REDRIVES = 3`, then marked `lost` (`max_redrives`); a deleted agent also marks it `lost` (`agent_deleted`). Outcomes that record a telemetry event: created, coalesced, redrive, fulfilled, lost; a redrive that still delivered nothing is reported as an empty-delivery event with the outstanding-ack flag set. **(a)** `ack-obligations.ts`, `sand-ack-obligation-store.ts`.
- Group and remote rooms opt out: their obligations are cleared rather than redriven. **(a)** `ack-obligations.ts` (`redriveAckObligation` group/remote checks).
- Storage is a versioned JSON sidecar with atomic `.part`-then-rename and an in-memory cache; every field defensively coerced; every filesystem call wrapped so corruption degrades to "no obligations." **(a)** `sand-ack-obligation-store.ts`.

### Stage 10 — Restart
- **Durable:** acknowledgement obligations and pending wakes — small versioned sidecars written atomically. **Not durable:** workers, sessions, steers, run promises. On restart the system redrives wakes and acks; it does **not** reconstruct workers (see G2). **(a)** `sand-pending-wake-store.ts`, `sand-ack-obligation-store.ts`; `pending-wake-rearm.ts` (`rearmPendingWakes`); `ack-obligations.ts` (`redriveUnfulfilledAckObligations`); `sand-host.ts` boot calls.
- A separate upgrade path: a run that returns "quiesced for upgrade" marks the agent resume-pending so work can be picked up after upgrade. **(a)** `completion-revivals.ts` / `ack-obligations.ts` quiesce branches per lifecycle note §7.
- The parent is told about an interrupted worker only via the synthetic lost-result notice described in G2; no worker state survives. **(a)** `pending-wake-rearm.ts` (`reviveParentForLostSubagentWake`).

---

## Part 3 — Evidence-grade summary

Counts across the 10 stages and the four gaps (distinct graded claims):

- **(a) directly evidenced:** the large majority — all four gaps (G1, G2, G3's scheduler use, G4's stub finding), and stages 1, 3 (contract composition + assembler), 4, 5, 6, 7, 8, 9, 10. Every (a) carries a named source file.
- **(b) inferred:** Stage 2 (triage) — the dispatch decision is inferred to be a prompt-guided model choice rather than a coded check, because no separate triage branch was isolated in the files read.
- **(c) unobservable:** G3's runner-internal interrupt mechanism (cooperative vs hard stop); G4's worker FSM (stubbed out); the exact Stage-2 dispatch-trigger code path.
- **(d) open:** none outstanding after this pass.

**Most valuable correction for implementers:** the acknowledgement redrive is **not** "bounded per boot" — it is a 3-attempt *lifetime* bound persisted across boots (G1). And boot redrive is **parent-only**: a subagent wake on restart carries a synthetic "interrupted" result, never the worker's real output (G2). Both are easy to get wrong when re-implementing.

**Surprises / contradictions vs. the prior note:**
- The prior note (§5, open items) listed the redrive policy as "unverified." It is now verified: fixed 5s, no jitter, 3-attempt lifetime bound. No contradiction — only closure.
- The prior note (§7) said restart "redrives wakes and acks; it does not reconstruct workers." G2 adds the precise mechanism: for subagents it is a synthetic lost-result re-delivery to the parent, and for shell/cloud-agent it is a re-attached watch. This is a refinement, not a contradiction.

---

## Part 4 — Legal self-audit

- Rule applied: no source/prompt/tool strings, identifiers, or protocol artifacts reproduced; file names used only as provenance; mechanisms named in my own words.
- **Self-audit result (case-insensitive grep for `sand`).** The only hits are three file-name provenance cites — `sand-host.ts`, `sand-ack-obligation-store.ts`, `sand-pending-wake-store.ts` — plus this audit's own prose; the prior `SAND_*` env-var identifiers and the `buildSandSubagentSystemPrompt` CamelCase symbol were reproduced in an earlier draft and have been rewritten out. **No `SAND_*` env identifiers and no `Sand*` CamelCase symbols remain as mechanism names.** File-name provenance cites are explicitly permitted by the clean-room rule, so the note is clean.
