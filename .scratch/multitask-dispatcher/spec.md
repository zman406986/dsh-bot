# Spec: Always-On Multitask Dispatcher for dsh

Status: ready-for-agent

Source of truth: `PRD-dsh-multitask-dispatcher.md` (actors, policy, FSM, wake/steer, todos, milestones, S1–S9), `CONTEXT.md` (glossary), `docs/adr/` (resolved decisions), `docs/research/` (cited findings). This spec does not replace the PRD; it is the buildable slice of it.

---

## Problem Statement

As a dsh user, my single chat turn blocks while research, builds, or long tool loops run. I cannot talk, redirect, or cancel while work is in flight, and I cannot run two independent requests at once. I want one busy assistant that stays responsive, runs heavy work in parallel, and tells me results as they land.

## Solution

An always-on dispatcher in the primary chat, shipped as an in-process dsh/Cordis plugin. The dispatcher answers in seconds, delegates each non-trivial stream to its own blank worker, steers running workers mid-flight on correction, and is woken when a worker settles so it can reconcile its todos and deliver the result. Workers are leaves: they never reach the user, never spawn, and never coordinate with each other. The user sees one person working, never the machinery.

## User Stories

1. As a dsh user, I want the dispatcher to reply within seconds while a worker runs, so that I am never blocked by my own task.
2. As a dsh user, I want two independent requests to run at the same time, so that the second never waits on the first.
3. As a dsh user, I want to correct a running stream mid-flight, so that the worker folds in my correction and continues instead of starting over.
4. As a dsh user, I want my correction to win over an earlier one, so that the stream reflects my latest intent without ambiguity.
5. As a dsh user, I want to be told when a stream lands, so that no work is silently forgotten.
6. As a dsh user, I want each request to produce a visible todo entry, so that I can see what is in flight and what has landed.
7. As a dsh user, I want several streams shown as `in_progress` at once, so that the todo list tells the truth about parallelism.
8. As a dsh user, I want a todo marked `completed` only after I actually have the result, so that "done" never lies.
9. As a dsh user, I want a worker I stopped to stop cleanly and stay stopped, so that a late result never arrives after I cancelled.
10. As a dsh user, I want a stopped stream's parked corrections discarded with it, so that nothing is resurrected after a cancel.
11. As a dsh user, I want stopping a worker to be silent until the dispatcher decides to mention it, so that the dispatcher stays in control of the conversation.
12. As a dsh user, I want a worker that errors to be reported honestly, so that I can decide to retry, steer, or drop.
13. As a dsh user, I want worker results delivered as I asked for them, so that the report format I specified is respected.
14. As a dsh user, I want worker results pasted in essentially verbatim (trimmed, with a placeholder when a worker produces no text), so that I get the worker's own words rather than the dispatcher's paraphrase.
15. As a dsh user, I want the dispatcher to lead with the concrete thing that finished, so that wake messages are not bare pronouns or vague acknowledgements.
16. As a dsh user, I want the dispatcher to stay silent when a landed result is stale or irrelevant, so that I am not pinged for nothing.
17. As a dsh user, I want the dispatcher to poll workers in a controlled way rather than a busy loop, so that a long worker does not degrade my chat.
18. As a dsh user, I want to ask what a worker is doing at any time, so that I can inspect elapsed time, activity, and transcript location.
19. As a dsh user, I want the dispatcher to reconcile its todos on every wake, so that the list always reflects running, landed, and next-to-dispatch work.
20. As a dsh user, I want a worker that finishes while the dispatcher is mid-turn to be queued rather than injected, so that my own turn is never corrupted.
21. As a dsh user, I want several completions that pile up to be batched into one wake, so that the dispatcher does not thrash.
22. As a dsh user, I want my own message to take priority over background bookkeeping, so that I am always answered first.
23. As a dsh user, I want the dispatcher to never spawn a second worker for a stream that already has one running, so that work is not duplicated.
24. As a dsh user, I want a stream that shares context with another to be sequenced, so that genuinely dependent work is ordered correctly.
25. As a dsh user, I want trivial lookups and pure conversation to skip the worker machinery, so that quick questions stay quick.
26. As a dsh user, I want the machinery invisible in the conversation, so that the dispatcher speaks as one busy person and never mentions dispatching an executor.
27. As a dsh user, I want the feature present in my multitask profile and absent from stock profiles, so that a default dsh install is unchanged.
28. As a dsh user, I want the enable/disable setting to apply at the start of my next dispatcher session, so that I never hit a half-applied state.
29. As a dsh user, I want a restart to leave me with an answerable question when a worker was in flight, so that I am not left with a lying todo.
30. As a dsh user, I want a worker lost across a restart reported as unknown-state with a pointer to its transcript, so that nothing is fabricated or replayed.
31. As a dsh user, I want the worker's own todo list to stay empty, so that only my dispatcher's ledger describes my work.
32. As a dsh user, I want to reach the dispatcher's chat through dsh's existing UI, so that no new client is required.
33. As a dsh user, I want to keep using dsh's tools and transcript storage, so that my existing environment is unchanged.
34. As a dsh user, I want the plugin to hot-reload like other dsh plugins, so that development does not require a restart on every change.
35. As a dsh user, I want work to stay local except for LLM calls, so that no remote compute is required.
36. As a dsh user, I want a peer agent to be able to reach my dispatcher asynchronously, so that multi-agent messaging is possible without live RPC.
37. As a dsh user, I want a priority peer message to preempt background and worker work but never my own turn, so that other agents cannot interrupt me.
38. As a dsh user, I want a non-priority peer message queued behind my current work, so that peer traffic does not disrupt me.
39. As a dsh user, I want a peer message to arrive on a fresh hidden turn with a cue that it is another assistant, so that the dispatcher does not confuse it with me.
40. As a dsh user, I want a group or broadcast target to be representable in the peer envelope from day one, so that group messaging does not force a later breaking schema change.
41. As a dsh user, I want a worker's report to be clamped when it reaches the dispatcher's context, so that a day of parallel streams does not degrade my reply latency.
42. As a dsh user, I want check and steer results summarized rather than dumped, so that the dispatcher's context stays lean.
43. As an implementer, I want the dispatcher's policy to be injected as new prompt copy, so that no reference prompt text ships.
44. As an implementer, I want core modules testable with fake wake, steer, and complete signals, so that the suite runs with no network and no LLM.
45. As an implementer, I want the adapter isolated behind a thin seam, so that core tests never need a live host.
46. As an implementer, I want worker records to be written through a durable control-plane marker, so that delivery can be finished after a restart.
47. As an implementer, I want steer tickets to stay in memory, so that no transient value is persisted and reloaded meaninglessly.
48. As an implementer, I want durable state written through dsh's session and storage facilities, so that no second transcript database is invented.
49. As an implementer, I want the legal QA grep to be a single late-milestone gate, so that the clean-room audit happens once the product is mostly finished.
50. As an implementer, I want the wake bus to accept timer and external-event sources from the start, so that the wake contract does not change when scheduled sweeps arrive.
51. As an implementer, I want a permission or secret request from a worker to have a defined relay path with a default timeout, so that a stream cannot hang forever.
52. As a maintainer, I want every shipped identifier to come from this project's own glossary, so that no reconstruction codename enters the deliverable.

## Implementation Decisions

### Modules

- **Multitask core (TypeScript, in-process dsh/Cordis plugin)** — ADR-0001. Owns the worker lifecycle FSM, worker registry, steer queue, todo reconciler, wake bus, peer inbox plus priority lane, and policy prompt assembly. Owns state machines and policy only.
- **Plugin packaging** — plain ES module (`type: module`, `main` entry) exporting `name`, `inject`, a schemastery `Config`, and `apply(ctx, config)`; `peerDependencies` on `@deepseek-ai/cordis` plus each dsh service it touches. dsh is installed locally (`@deepseek-ai/dsh@0.1.5-rc.1`, `docs/research/dsh-local-install.md`) and its own MIT plugin `@deepseek-ai/dsh-web-search-exa` is the shape to follow — the host tree is safe to imitate, unlike the reference tree.
- **Profile composition** — the plugin reaches a profile through an `insert` row in that profile's `cordis.patch.yml`; the profile root `cordis.yml` is never edited. The dedicated multitask profile does not exist yet and is created from a shipped template. During development a `--patch` overlay is the transient route.
- **Worker lifecycle FSM** — states `spawned → running → steering → running`, terminal `completed | error | aborted` (PRD §7.2). The FSM is pure and host-free.
- **Worker registry** — holds `WorkerRecord` per live worker; the in-memory half is the live roster, the durable half is the reconstruction minimum.
- **Steer queue** — single slot per worker, last-wins.
- **Todo reconciler** — maps wake events to todo mutations.
- **Wake bus** — accepts `user`, `worker-settled`, `peer`, `timer`, `external-event` sources; coalesces and batches.
- **Peer inbox plus priority lane** — Phase 2 surface, but the lane exists in the scheduler from the start.
- **Policy assembler** — assembles the dispatcher prompt section and reminder middleware from our own prompt assets.
- **dsh adapter** — host-native glue over `ctx.subagents`, `ctx.jobs`, `ctx.tools`, `ctx.sessions`, `ctx.storage`, `ctx.agents`, and the scoped tool barrier. Thin: no policy lives here.
- **Dispatcher agent definition and worker agent definition** — agent types, tools, and prompt sections, shipped as new copy.

### Interfaces

Public core surface (names illustrative; the shapes are the decision):

```ts
interface Multitask {
  registerWorker(rec: WorkerRecord): void;
  settleWorker(id: string, status: Status, report: string): void;
  enqueueSteer(id: string, msg: string): void; // last-wins
  popSteer(id: string): string | undefined;
  abortWorker(id: string): void;
  listWorkers(parentSession: string): WorkerView[];
  reconcileTodos(wake: WakeEvent): TodoMutation[];
}

interface DshHost {
  spawnWorker(prompt: string, opts: SpawnOptions): Promise<string>;
  interruptWorker(workerID: string): Promise<void>;
  onWorkerSettled(cb: (e: SettledEvent) => void): void;
  requestDispatcherWakeup(sessionID: string): Promise<void>;
}
```

The core depends only on `DshHost`. The adapter implements `DshHost`. Dispatcher-facing tools map one-to-one onto core calls; core internals never appear in user-visible strings.

- `spawnWorker` is non-blocking and returns worker id plus an acknowledgement.
- `settleWorker` is idempotent: a second settle for the same worker is ignored.
- `enqueueSteer` on a non-running worker is refused, not silently recreated.
- `reconcileTodos` is a pure function of wake event plus current todo state.

### Data model

```text
WorkerRecord {
  worker_id: string
  parent_session_id: string
  stream_key: string          // logical stream (todo id)
  title: string               // short derived title
  status: enum                // spawned | running | steering | completed | error | aborted
  started_at_ms: number
  tool_call_count: number     // optional live
  transcript_ref: string | null
  todo_id: string | null
}

TodoItem {
  id, title, status, stream_key?, worker_id?, delivered: bool
}

SteerTicket {
  worker_id, message, created_at_ms
}

WakeEvent {
  source: user | worker-settled | peer | timer | external-event
  ...
}

// Phase 2
PeerEnvelope {
  from_agent_id, from_name, to_agent_id,   // to_agent_id may name a group or broadcast target
  conversation_id,                          // forward-compatibility slot (Gap 7)
  text, image_refs[], priority: bool,
  created_at_ms
}
```

### Durability split (ADR-0006)

- **Durable:** the minimum-to-reconstruct `WorkerRecord` — worker id, transcript pointer, todo link, status. Written at spawn through dsh's control-plane obligation-marker idiom, on `ctx.sessions` / `ctx.storage`. This is our deliberate divergence from the reference, stated as such.
- **In-memory:** the live roster's extra fields and `SteerTicket` — a steer is single-slot and last-wins by definition.
- **Restart behavior:** imitate the reference's honest amnesia for everything in-memory — a worker that cannot be reconstructed is reported as unknown-state with a pointer to its transcript, never replayed, never fabricated. For a durable worker record whose result landed but was not delivered, the dispatcher notices the outstanding marker and finishes delivery (S4).
- **Never:** a second transcript DB. Worker transcripts stay dsh's.

### Reference-imitation decisions

These are adopted from `docs/research/reference-behavior-notes.md` and are normative here:

- **Stop is silent** — the stop tool returns a plain confirmation to the dispatcher only; nothing in the stop path messages the user. The dispatcher may raise it on a later turn.
- **Stop disarms and drops** — stopping clears the completion wake and clears any parked steer for that worker. A result that settles after the stop is dropped, never revived. The stop flag wins even if the flagged path produces a completion.
- **Stop races** — a stop arriving after the worker already settled is refused, and the already-queued completion is delivered normally. Finished before stop delivers; finishes after stop drops.
- **Steer is single-slot, last-wins** — a new steer replaces any undelivered steer for that worker. Delivering a steer interrupts the current step; on unwind the worker is started again with the latest steer wrapped in a short parent-correction note directing it to fold the message in and resume rather than restart, keeping context.
- **Steering an idle worker is refused**, with a note that the worker may be done and a pointer at the follow-up route. No queue for finished workers.
- **Spawn returns immediately** — worker id plus a short note that it runs in the background and its final response will arrive on completion, so the dispatcher should not wait.
- **Worker completion is a queued background wake**, never a mid-turn injection. Completions are de-duplicated per worker id and batched into one wake prompt.
- **The wake turn is silence-allowed** — the dispatcher is told to lead with the concrete thing that finished and to stay silent when the result is stale or duplicate.
- **Result text is essentially verbatim** — trimmed; empty becomes a no-output placeholder; errors pass the error message; a stopped worker's result is not delivered at all. No automatic artifact attachment; the dispatcher attaches a path only when it chooses to.
- **Flat topology** — only the top-level dispatcher spawns; workers are leaves (ADR-0003).
- **Priority is 1:1 only** — a priority peer message goes to the front of the inbound queue and interrupts an active non-user run; it never interrupts a user-lane run. Group posts ignore priority.
- **User messages supersede the current dispatcher turn** rather than queueing behind it.

### Deliberate divergences from the reference

- **Durable `WorkerRecord`** — the reference is in-memory only; we keep the minimum-to-reconstruct (ADR-0006).
- **Wake sources as an enum including `timer` and `external-event`** — the reference has automations and external listeners; we reserve the slots now so the contract does not change later (Gap 4).
- **Report clamping into the dispatcher's context (S1 protection)** — the reference's wake path does not clamp worker result text; we do, with a transcript reference (Gap 5).
- **Permission relay with default deny/timeout** — the reference has dedicated permission and secret request flows; the PRD was silent, and an unrelayed request breaks S4 in practice (Gap 2). A worker that hits an approval-gated action or needs a credential emits a structured request; the dispatcher wakes, asks the user or applies a stored policy, and steers the answer back. A default denial and a timeout are defined so no stream hangs forever. Secrets reach a blank worker only by scoped injection, never discoverable by prompt. dsh ships the underlying seams (`dsh-user-approval`, `dsh-credentials`, `dsh-permission-presets`), so this is glue over existing machinery rather than a new subsystem.

### Policy prompt assembly

- **Dispatcher policy section** — roles from PRD §6.1: dispatcher not workhorse; non-trivial multi-step work spawns a worker; independent work runs in parallel; correction steers rather than clones; todo entry before spawn; reconcile on every wake; self-contained worker prompts; workers never message the user; machinery never named to the user.
- **Reminder middleware** — re-inject the todo list and the policy highlights at dispatcher turn start, rather than relying on a one-time system prompt (Gap 5's cheap mechanism).
- **Worker definition** — headless, autonomous, no way to talk to the user, no follow-ups, must end with a concise plain-text final answer that becomes the stream's report.
- **Steer wrapper** — a short correction-from-parent note: incorporate, continue from here, do not restart.
- **Tool descriptions** — dsh-native wording for spawn, check, steer, stop, todo, and deliver.

All prompt assets are new copy. No reference prompt text, identifier, or string literal.

### Tools and commands

| Capability | Surface | Semantics |
|---|---|---|
| Spawn stream | dsh spawn/task with a worker agent type | Blank worker; returns worker id plus ack; non-blocking |
| Check | `check_worker` plus job status | List running workers; detail: elapsed, tool count, recent activity, transcript path |
| Steer | `message_worker` / dsh followup-interrupt | Inject into running worker; refused when not running |
| Stop | `stop_worker` | Abort; silent to user; late results dropped |
| Todos | dsh todo tools | Multiple `in_progress`; reconcile on wake |
| Deliver | dsh user message tool | Dispatcher to user only |

### Host wiring

- Worker agent type runs with a scoped tool barrier: no user messaging, no peer messaging, no spawn, no worker-management tools, no todo tool. Work tools stay.
- Wake bus maps onto dsh's completion-delivery wake (PRD §11.2's literal `completionDelivery=wakeup` name does not exist in dsh; the equivalent mechanisms do).
- `ctx.jobs` is used for live job status; it is process-local, so it is not treated as durable.
- Feature flag `multitask_dispatcher`: ON in the dedicated multitask profile, OFF in stock profiles; read once at dispatcher-session start and fixed for that session (ADR-0005). The control is a profile/UI setting writing the value for future sessions. There is no off-while-running state.
- Optional telemetry: dispatch count, steer count, time-to-first-reply while busy. No prompt text in telemetry.

### Milestone mapping

| Phase | Scope | Exit |
|---|---|---|
| M1 | Core FSM, steer queue, wake bus, todo reconciler, unit tests | S8 |
| M2 | dsh adapter, worker agent type, tools | S1–S5 |
| M3 | Todo reconciliation and policy prompts | S6 |
| M4 | Flag, docs, ZH/EN prompts, clean-room/license audit run once | S7 |
| M5 (optional) | Peer async messaging | S9 |

### Deferred, with the slot reserved

- **Per-agent memory** (Gap 1) — no memory facility ships in dsh; the natural floor is a `ctx.storageDomain` domain, or an MCP memory server. Post-MVP; the design slot is reserved so the prompt assembler can accept a memory block.
- **Scheduled sweeps and routines** — the wake source enum reserves `timer`/`external-event`; M1 ships at most an idle reconciler on a timer.
- **Artifact references on settle and on todo completion** (Gap 3) — post-MVP; the settle event's shape should be able to carry an artifact list.
- **Group messaging, agent creation at runtime, nested spawns** — out; see Out of Scope.

## Testing Decisions

Good tests here assert **external behavior of the core against fake host signals** — never FSM internals, never a specific call sequence of private helpers, never prompt string contents.

- **Modules tested:** the FSM, the steer queue, the todo reconciler, the wake bus, and the adapter seam. The policy assembler is tested only for the presence and assembly order of its sections, not for wording.
- **Seams — one, preferred:** every core test drives the core through `Multitask` and observes through `DshHost`, with a fake host that records spawn, interrupt, and wake calls. The fake host is the single test seam and the only place a host is simulated.
- **Prior art:** PRD §12's testing table is the prior art for what to cover; there is no existing test suite in this repo yet, so this spec sets the pattern — a pure core, one fake host, no network, no LLM.
- **Required coverage, expressed as behavior:**
  - FSM: spawn to run to steer to complete; abort during steer; double settle ignored; stop then late settle drops the result and wakes nobody.
  - Steer queue: last-wins with an overwritten earlier steer never delivered; empty pop; steer on an idle worker refused and the worker is not recreated.
  - Todo reconciler: several `in_progress` at once; `completed` set only after the delivered flag; stale items cancelled; duplicate spawn for a live `stream_key` refused.
  - Wake bus: settle enqueues exactly one wake; routing to the correct parent session; several settlements batch into one wake; user wake preempts background.
  - Adapter seam: spawn and interrupt are called as expected; the worker-scoped tool barrier exposes no user-messaging tool; a settle calls the wake path exactly once.
  - Restart: a durable record whose result is undelivered produces a reconcile action that finishes delivery; an unreconstructable worker produces an unknown-state report, never a replay.
- **Not tested at unit level:** live dsh process behavior, real LLM output, real transcript contents.
- **Manual/scripted E2E:** a long fake worker with rapid user messages, a mid-run steer, and the delivered text checked against S1–S5.
- **Legal QA:** one grep of the shipped tree for reconstruction identifiers, run once at M4 (S7).

## Out of Scope

- Rebuilding dsh's inference router, transcript storage, or tool runtime.
- Remote sandbox, remote desktop, and computer-use parity.
- Bit-for-bit Sand/Cursor/Grok Bot UI or binary compatibility.
- Copying any file, string, class, prompt, identifier, or protocol artifact from the reconstruction tree.
- A second transcript database.
- Nested workers (a worker spawning a worker) — workers are leaves (ADR-0003).
- Worker-to-worker messaging — all worker traffic routes through the dispatcher.
- A group/broadcast messaging hub — only the envelope's group-target and `conversation_id` slots are in scope.
- Agents creating or managing other agents at runtime.
- Per-stream token accounting, an action audit trail, an auto-review quality gate, a local content-search index, and an experiments/feature-flag framework.
- Per-agent durable memory, scheduled routines, and artifact-reference delivery (deferred with slots reserved, above).
- A dedicated frontend — the dispatcher lives in dsh's existing chat.

## Further Notes

- Every shipped identifier comes from this project's glossary or is chosen independently. The exclusions are hard: no `sand`, no `executor`, no `MessageSubagent`, no `SAND_MULTITASK_*`, no reconstruction file basenames (PRD §8, §17).
- `reference-architecture.json` at the repo root is an untracked architecture diagram of the reference with a reference-repo URL and reference-derived labels. It is not part of the deliverable; decide separately whether it is kept as a local research artifact or removed, and never ship it.
- Where the PRD is silent, the reference observed behavior governs (AGENTS.md "Source of truth"); where we deviate, the divergence is listed above and recorded in an ADR.
- S9 (Phase 2) is the only success criterion that may be dropped without touching S1–S8; the peer lane exists in the scheduler from M1 so that dropping it costs nothing.