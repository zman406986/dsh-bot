# Research: dsh capability map per core-loop stage (feasibility floor, ticket 52 / R3)

- Question: For each stage of the core loop (ADR-0017 §"What the core loop means"), what does dsh actually permit today — availability, the exact seam, `file:line` evidence, and (most importantly) what each seam does NOT guarantee? The rebuild must never be specced against fantasy.
- Scope: product-code side only. Read `src/` (plugin + in-process core + adapter), `docs/research/*`, the ADR set, and the PRD. The forbidden reference tree was NOT opened; "what the reference needs" is taken from our own behaviour notes (`reference-agent-lifecycle.md`, `always-on-dispatcher-behavior.md`), never the tree.
- Method: read-only static inspection of the repo's actual wired seams, plus cross-check of the two load-bearing prior notes (`dsh-adapter-api-notes.md`, `dsh-extension-surface.md`). No network, no process launch, no running dsh.

## Verification status (read first)

**Host IS installed and was re-verified.** `C:/Users/TZhen/.dsh/profiles/node_modules/@deepseek-ai/` holds the real `dsh` packages — version **`0.1.5-rc.2`** (the prior notes said `rc.1` and pointed at a stale `C:/Users/TZ\...` path; this machine's profile is `TZhen`). All `@deepseek-ai/dsh-*` packages are MIT-licensed source we build on, so reading them is in-scope (the forbidden reference reconstruction tree was still NOT opened; clean-room rule honoured).

Every behaviour the prior notes claimed was "verified against the real installed code" has now been **re-asserted against the actual `0.1.5-rc.2` implementation**. Result: the six load-bearing claims below are all either **VERIFIED** or **refuted** — none remain open. The two highest-risk questions (`startContinuable` resolves on acceptance; `followup` opens a turn) are both **VERIFIED**.

Consequence for this map:

- **"VERIFIED (repo wiring)"** = a `file:line` in `src/` showing the plugin actually calls the seam.
- **"VERIFIED (host source)"** = a `file:line` or shipped `.d.ts` contract in the installed `0.1.5-rc.2` packages proving the runtime behaviour, not just the call site.
- **"CLAIMED BY NOTE — now REFUTED"** = the note's assertion is contradicted by host source.

This is exactly the trap tickets 46/49 warned about: a seam name in `docs/research/` is worthless until asserted against the implementation. That assertion is now complete against both our code and dsh's.

---

## Stage-by-stage map

### 1. Intake — user message → dispatcher turn

- **Reference need:** the dispatcher is a property of the agent, resolved once at startup; no activation step, no opt-in toggle (`always-on-dispatcher-behavior.md` §1; ADR-0017 open-Q4 re: activation).
- **Seam:** none for intake. Activation is an explicit host slash-command `dispatcher-start` (`src/adapter/activation-command.ts:98-130`; registered dormant at `src/plugin.ts:461-467`). The plugin boots **dormant and stock** — "Nothing is captured on load or on `agent/session-start`" (`src/adapter/parent-agent.ts:113-130`); the disabled path returns early with no core, no command, no tools (`src/plugin.ts:214-218`).
- **VERIFIED (repo wiring):** the plugin CAN inject context two ways, both best-effort and both *after* a turn has already begun:
  - at activation, one-shot policy via `agent.inject` (`src/adapter/parent-agent.ts:224-226`, `parent-agent.ts:49-57`);
  - a per-turn reminder re-injected on `agent/status` "running" (`src/adapter/parent-agent.ts:176-181`).
- **Verdict:** **PARTIAL.** A plugin can *observe* the dispatcher turn (only after `dispatcher-start`), and can *inject* context (queue) at activation and per-turn, but **cannot gate, block, or modify the user's message before it runs**, and cannot auto-activate on boot.
- **What it does NOT guarantee:** `agent.inject` queues context **without opening a turn** — **VERIFIED (host source):** `ReactLoopAgent.inject` calls `send(input, "next-step", false)` (dsh-agent-loop/lib/index.js:795-797); `wakeup=false` means `wakeDriver` is never called (index.js:787). So injected policy may not land in the very next model turn. There is no pre-turn hook and no message-transform seam.

### 2. Triage — answer inline or dispatch

- **Reference need:** host-side triage is n/a; the dispatcher model decides.
- **Seam:** none. The dispatcher decides via its own model + the five dispatcher tools (`src/adapter/dispatcher-tools.ts`); nothing host-side.
- **Verdict:** **N/A** (no host seam; matches expectation — noted only for completeness).

### 3. Spawn — create a blank-context, no-user-channel, leaf worker

- **Reference need:** idempotent dispatch; one worker ⇔ one parent tool call; blank context; worker gets no user channel (`reference-agent-lifecycle.md` §2).
- **Seam:** `ctx.subagents.startContinuable({ provider, label, request: { prompt, parent, signal, maxDepth, toolFilter }, signal })` → `{ childId, messageId }` (`src/adapter/cordis-dsh-host.ts:545-558`; invoked from `src/core/multitask.ts:416-423`; contract at `src/core/dsh-host.ts:11`).
- **VERIFIED (repo wiring):**
  - provider is hard-coded `"spawn"` (in-process) — `src/adapter/cordis-dsh-host.ts:227,546`. No custom worker agent type / persona is passed.
  - tool scoping via `toolFilter: { deny }`, intersected against live global tool names at every spawn (`src/adapter/cordis-dsh-host.ts:529-544`); empty deny omitted.
  - leaf enforced by `maxDepth: 0` (`src/adapter/cordis-dsh-host.ts:533`).
  - blank context is a comment, not a parameter — "Blank context is free with the in-process spawn provider" (`src/adapter/cordis-dsh-host.ts:522`).
  - one-worker-per-stream is enforced by **core** (`liveByStreamKey`, `src/core/multitask.ts:407-415`), not dsh.
- **Verdict:** **AVAILABLE** (wiring + host source). `spawnWorker` resolves to the child `SessionId` (workerId), used as the settlement key.
- **What it does NOT guarantee:**
  - **The child's base system prompt is refined** (deviation D-1). The repo passes only its own assembled text into `request.prompt` (`src/worker/prompt.ts:8-10`, `src/adapter/cordis-dsh-host.ts:524-527`) and sets **no `persona`**. **VERIFIED (host source):** `snapshotSubagentDescriptor` includes `persona` only `if request.persona !== undefined` (dsh-subagent/lib/index.js:1663), and `composition` threads `toolFilter`/`persona` into the child (index.js:1703-1706). So the child runs the in-process spawn provider's **default** base prompt; its exact text is in `dsh-agent-presets` (the `spawn` provider, optional peer dep, not separately present here) and was NOT inspected. Honest status: *no custom persona is set* is verified; *what the default prompt contains* is not.

  > **Superseded 2026-09-18 — see `dsh-child-system-prompt-seam.md`.** The "unverified/unknown" framing above is **partly wrong**, and `seam-channel` demonstrated it against the same host bundle. (i) The child's base prompt is **not unknown**: the child joins the parent/dispatcher preset via `composeFrom`, plus a fixed `subagent:delegation` context section and the harness-identity section. The `inheritsParentContext: false` flag blanks the *conversation*, not the system prompt — that conflation is the error here. (ii) The `persona` seam is **not absent**: it is typed, advertised by the spawn provider (`persona: true`), and **enforced** — it renders into the `deployment:persona-prefix` system-prompt section (`dsh-subagent/lib/index.js:549-553`). The only genuinely uninspected item is the *text* of the provider's default base prompt. Treat the seam note as authoritative for D-1.
  - **`toolFilter` IS honoured at runtime** — **VERIFIED (host source):** dsh's own shipped contract states "In-process backends apply it as a scoped `tools.restrict()` in the child's creation window: the named tools vanish from the child's prompt AND refuse to execute (one visibility), with loud unknown-name validation" (dsh-subagent/lib/types/types.d.ts, `toolFilter`). The repo proves the *names* are intersected before send (cordis-dsh-host.ts:529-544); the deny is enforced by the provider. S5 ("workers cannot address the user") therefore rests on a verified host guarantee.
  - **cwd is not specifiable** — no field carries it.
  - **`startContinuable` resolves on inbox acceptance, not on turn finish** — **VERIFIED (host source)** (this is the S1 timing claim). The method doc is "Start one continuable background child and **resolve at initial inbox acceptance**" (dsh-subagent/lib/index.js:1637); it returns `{ childId, messageId }` where `messageId` is the accepted initial-prompt inbox id (index.js:1678-1680, via `submitMaterialized` → `submitAdmitted`). It does **not** await child completion, so `spawnWorker` never blocks the dispatcher.

### 4. Concurrency — parallel streams; does a child block the parent?

- **Reference need:** workers run in parallel; the parent's responsiveness is protected by a **queue-liveness watchdog armed only when a USER task waits** (abandon-and-advance, not kill) — `reference-agent-lifecycle.md` §4. There is **no worker-health probe** (explicitly "a design gap we inherit").
- **Seam:** no dsh seam. Parallelism falls out of independent continuable sessions; the parent-side mid-turn hold + user preemption is modelled in **our** wake-bus (`src/core/wake-bus.ts:91-109, 464-499`).
- **VERIFIED (repo wiring):** a child settling while the dispatcher is mid-turn only **queues** the wake (`wake-bus.ts:96-100`); a user wake reclaims any waiting non-user batch (`wake-bus.ts:464-477`). The dispatcher's own turn bounds come from the host `agent/status` event (`src/adapter/parent-agent.ts:172-186`).
- **Verdict:** **PARTIAL.** Structurally a child does **not** block the dispatcher: spawn resolves on acceptance (**VERIFIED**, dsh-subagent/lib/index.js:1637,1678-1680), children are separate sessions, and our wake-bus holds/coalesces. **But there is no liveness watchdog for a wedged worker** — if a child hangs forever, nothing detects or escapes it (the reference's watchdog guards the *user* lane, which our wake-bus approximates via user-preemption; a stuck *worker* is invisible to both).
- **What it does NOT guarantee:** the structural non-blocking claim is now confirmed by host source; but **no worker-liveness escape exists** in dsh (deviation territory, reference §4 honest gap).

### 5. Steer — mid-run correction, context preserved, no restart

- **Reference need:** interrupt-then-resume on the **same preserved session** → last-wins, context preserved because it is the same session, not stream injection (`reference-agent-lifecycle.md` §6).
- **Seam (what the repo actually uses):** `ctx.subagents.sendMessage(parent, workerId, textBlocks(msg), { signal })` (`src/adapter/cordis-dsh-host.ts:570-578`) delivered at a step boundary. The core parks a last-wins steer (`src/core/steer-queue.ts`), interrupts the worker's current step via `ctx.subagents.interrupt` (`src/core/multitask.ts:516-524`), and on the host `agent/status` "idle" for that worker calls `host.emitStepBoundary` → `host.sendMessage(wrapParentCorrection(msg))` (`src/adapter/parent-agent.ts:196-199`, `src/core/multitask.ts:380-388`, `src/core/steer-queue.ts:47-55`).
- **VERIFIED (repo wiring):** the repo does **NOT** call the low-level `Agent.steer` the prior note lists. It implements the reference's interrupt-and-resume-on-same-session pattern explicitly. The single-slot last-wins queue is ours (`src/core/steer-queue.ts`).
- **Verdict:** **PARTIAL.** Mechanism matches the reference. The **host steer capability is now VERIFIED**: the host consumes steer delivery "at its next step boundary" (runtime-types.d.ts:193-200) — i.e. **steer nearest step, not next turn** — so the worst case ("steer only after the worker's whole turn") does not apply. Our explicit `interruptWorker` + deliver-on-`agent/status`-idle path is a *conservative superset* (waits for full worker quiescence) layered on top of the verified host steer; it is belt-and-suspenders, not a workaround. The remaining nuance: the repo delivers the steer on the host `agent/status` "idle" transition (whole-turn quiescence), which is broader than the host's per-step consumption, so timing is safe but our delivery lags the host's earliest possible step.
- **What it does NOT guarantee:**
  - **Context preservation is the child session's own continuity**, not a dsh "preserve context" promise. `wrapParentCorrection` is a *textual* "do not restart" instruction (`steer-queue.ts:47-55`); there is no host guarantee the worker complies. **Host steer capability VERIFIED (host source):** the host doc states "**steer delivery targets the nearest step** and retains the Agent loop's best-effort fallback semantics" (dsh-subagent/lib/index.js:3028-3029); `subagents.sendMessage` routes `delivery:"steer"` → `steerPrompt` → the child's `Agent.steer` (`send(input,"next-step",true)`, dsh-agent-loop/lib/index.js:792-794). The repo's explicit `interruptWorker` is belt-and-suspenders, not a workaround for a missing capability.
  - **`Agent.steer` as a usable low-level method is not used anywhere in the plugin** — but its host backing (`ReactLoopAgent.steer` → next-step + wake) is verified present, so the note's §3 table entry is confirmed valid for children (only the dispatcher parent has no public mid-turn cancel; see §6).

> **Ticket 60 (2026-09-19) — drain-point finding; register D-7 closed `not-a-deviation`.** The verdict's closing nuance ("our delivery lags the host's earliest possible step") is a statement about host **capability**, not about reference behaviour — and it is the latter that governs (ADR-0018). Three findings, all re-verified first-hand against the installed 0.1.5-rc.2 bundle:
>
> 1. **Host consumption (confirmed):** `Agent.steer` = `send(input, "next-step", true)` (dsh-agent-loop/lib/index.js:792-794); "a running driver consumes it at its next step boundary" (dsh-agent/lib/types/runtime-types.d.ts:191-200); `sendMessage` steer doc (dsh-subagent/lib/index.js:3028-3029). Riding it means **not** interrupting the worker — abandoning the reference's interrupt-then-resume mechanism.
> 2. **No step-completion event exists.** The bindable Agent event surface is `agent/status`, `agent/inbox/inserted`, `agent/inbox/claimed`, `agent/inbox/discarded`, `agent/session-start` (dsh-agent/lib/types/runtime-types.d.ts:247-287) plus raw `agent/error` / `agent/assistant-stream` (dsh-agent-loop/lib/index.js:863,1032). `agent/inbox/claimed` fires when a message **already in the host inbox** is claimed into a step (dsh-agent-loop/lib/index.js:100-112) — step-start, not step-end — so there is no observable per-step drain trigger for a slot the plugin has not yet sent.
> 3. **The reference waits for the turn to end too.** `reference-core-loop-spec.md:77` (stage 5) and `reference-agent-lifecycle.md:139`: park → **interrupt the current turn** → on settlement start a **new turn on the same session** with the steer text. Our path (`src/core/multitask.ts:607,611` park + interrupt; `src/adapter/parent-agent.ts:233-236` idle → `emitStepBoundary`; `src/core/multitask.ts:455-463` pop + send) is that mechanism.
>
> Delivering promptly without a drain event would break last-wins (both quick steers reach the worker; ticket R1) and timers are barred (R4). Net: stage 5's mechanism verdict stands upgraded from PARTIAL to **conformant** — the unused host nearest-step consumption is a deliberate fidelity choice, recorded in register D-7.

### 6. Stop — abort is silent and final; late result dropped

- **Reference need:** cooperative, ordered abort; an aborted worker disarms its pending wake and never reports back (`reference-agent-lifecycle.md` §6).
- **Seam:** `ctx.subagents.interrupt(workerId, { kind: "ancestor", agent: parent })` — fire-and-return (`src/adapter/cordis-dsh-host.ts:561-568`). Core path: `abortWorker` marks `aborted` → drops parked steer + pending access → deletes marker → `host.interruptWorker` (`src/core/multitask.ts:456-492`).
- **VERIFIED (repo wiring):** post-abort settles are dropped by the pure FSM (`src/core/worker-fsm.ts:30-44` — no transition leaves a terminal state; `src/core/multitask.ts:342-350` ignores unmatched settles). Our **core** enforces late-result suppression.
- **Verdict:** **AVAILABLE** (wiring + host source) for *issuing* the stop. 
- **What it does NOT guarantee:** **Host stop behaviour is now VERIFIED (host source).** `subagents.interrupt(childId, authority)` calls `activation.handle.agent.cancel(authority.kind === "user" ? {kind:"user"} : {kind:"parent"}, { keepInbox: true })` (dsh-subagent/lib/index.js:853-865, 1825-1826) — i.e. it aborts the child's active turn and the activation then undergoes teardown/deregistration (index.js:1202-1240, resident map cleared at :1238). So `interrupt` reliably deactivates the worker; the host will not silently revive it. Our core FSM (worker-fsm.ts:30-44) is the durable late-result suppressor and remains the authoritative guarantee. Note `keepInbox:true` preserves un-started/steering work for a later turn, but the aborted activity is gone.

### 7. Settle → wake — disciplined, deduped, coalesced wake

- **Reference need:** one-shot completion callback (push); dedupe by worker id; coalesce N into one wake; clear the durable pending wake; run as a hidden background-lane turn, silence allowed (`reference-agent-lifecycle.md` §3).
- **Seam:** host event `subagent/end` subscription (`src/adapter/cordis-dsh-host.ts:383-414`) → `wakeBus.enqueueWorkerSettled` (`src/core/multitask.ts:342-375`) → per-session batch (`src/core/wake-bus.ts:339-362`) → `requestDispatcherWakeup` → `agent.followup(wakeUserMessage(...))` (`src/adapter/cordis-dsh-host.ts:588-606`). Activity comes from the `session/event` firehose, filtered to `tool/call` (`src/adapter/cordis-dsh-host.ts:416-427`).
- **VERIFIED (repo wiring):** push (event subscription, not polling); dedup by worker id (`workers.has` guard at `:390`); coalesce (wake-bus batches). `agent.followup` is the wake primitive; the interface comment frames it as "Ask the host to open a dispatcher turn (wake)" (`src/core/dsh-host.ts:26`).
- **Verdict:** **AVAILABLE.** The linchpin is now **VERIFIED (host source):** `ReactLoopAgent.followup` calls `send(input, "next-turn", true)` (dsh-agent-loop/lib/index.js:789-791); `wakeup=true` invokes `this.wakeDriver(...)` (index.js:787), and the `send` doc states "A wake submitted while already idle always opens its turn boundary" (runtime-types.d.ts:175-186). So `followup` **opens a dispatcher model turn** — it is NOT queue-only. The push event, dedup, coalesce, and mid-turn hold are all wired; the wake produces a real model response, so S4/S7 delivery is sound.
- **What it does NOT guarantee:** only the *promptness* of a busy parent's wake flush — our wake-bus holds while `busy` and flushes on `agent/status` idle (`wake-bus.ts:183-186, 488-499`). The *turn-opening* guarantee itself is now verified.

### 8. Reconcile + deliver — completed means delivered to the user

- **Reference need:** delivery is always the agent speaking, as an ordinary turn; "completed" ⇒ delivered (`always-on-dispatcher-behavior.md` §3; reference-lifecycle §3).
- **Seam:** reconcile via `reconcileTodos` / `drainWake` (`src/core/multitask.ts:599-624`, `src/core/todo-reconciler.ts`); delivery is the dispatcher answering in its **own** turn — the wake `followup` carries settle notices as a UserMessage (`src/adapter/cordis-dsh-host.ts:588-606`, `src/adapter/wake-copy.ts`), and the model's normal response delivers. `markDelivered` is called only after a successful user-facing send (`src/core/multitask.ts:583-597`).
- **VERIFIED (repo wiring):** a plugin sends to the user **only from the dispatcher (parent) context**, by being the chat agent. Workers are denied user tools by `toolFilter` (`src/adapter/cordis-dsh-host.ts:542-544`), enforcing S5.
- **Verdict:** **AVAILABLE.** Delivery = dispatcher's own turn (wake followup + natural model response). From the dispatcher agent only; workers cannot address the user.
- **What it does NOT guarantee:** there is **no separate "deliver to user" API** — delivery rides on the dispatcher model producing a turn, which now rests on the **VERIFIED** `followup`-opens-a-turn guarantee (§7, dsh-agent-loop/lib/index.js:789-791,787).

### 9. Obligation — undelivered result is bounded and escalated

- **Reference need:** acknowledgement-obligation ledger; durable; run tokens; **boot redrive**; **bounded at 3 redrives → `lost`** with reason (`reference-agent-lifecycle.md` §5).
- **Seam:** `ctx.storageDomain` durable markers (`src/plugin.ts:220`, `src/core/durability.ts`); core writes at spawn (`src/core/multitask.ts:449-451`), updates on settle (`src/core/multitask.ts:361-365`), deletes on delivered/aborted (`src/core/multitask.ts:587-595, 359-360`).
- **VERIFIED (repo wiring):** durability exists; markers survive restart; terminal markers are restored so an undelivered result can finish delivery (`src/core/multitask.ts:626-700`).
- **Verdict:** **PARTIAL.** Durability is available; the **delivery guarantee is not**. There is **no `lost` state, no bounded redrive, no run-token fulfilment gating** (deviation D-5). In `todo-reconciler.ts:186-211` the only prunes are `completed+delivered` (retention) and `stale-pending`; an `in_progress && !delivered` landed item **persists forever, never escalated**. No delivery-path telemetry of `delivered`/`superseded`/`dropped`+reason (deviation D-6 — `markDelivered` just flips a boolean, `src/core/todo-reconciler.ts:354-364`).
- **What it does NOT guarantee:** that an undelivered result is ever bounded or surfaced as lost; that anything records *why* a delivery was superseded or dropped.

### 10. Restart — what survives; how the dispatcher is told

- **Reference need:** durable = wakes + acks (small sidecar ledgers); on restart, **redrive wakes and acks and actively drive recovery on boot**; workers/sessions are not reconstructed (`reference-agent-lifecycle.md` §7). Reference is always-on: no activation step.
- **Seam:** on activation (explicit `dispatcher-start`), `bindDispatcherLifecycle` runs `rebuildFromDurability` then `lifecycle.injectNotice(notice)` — which calls `agent.inject` (queue, **no turn**) (`src/plugin.ts:414-432`, `src/adapter/parent-agent.ts:231-236`, `src/adapter/restart-notice.ts`). Activation is explicit (`src/adapter/activation-command.ts`); there is **no boot hook**.
- **VERIFIED (repo wiring):** durable rebuild restores terminal rows (for undelivered-finishing) and honest unknown-state rows (`src/core/multitask.ts:626-700`); the restart notice is injected via `agent.inject` and explicitly does **not** open a turn.
- **Verdict:** **PARTIAL.** Durable rebuild is available. But (a) activation is **explicit, not automatic on boot** (deviation from reference always-on; ADR-0009); (b) the restart notice is **queued context, not a driven recovery turn** (deviation D-4 — reference "actively drives recovery work on boot"; we inject a notice and wait for the user's next message or a settle); (c) there is **no boot redrive loop** of obligations.
- **What it does NOT guarantee:** that the dispatcher is re-activated after a restart (it is not — the user must re-run `dispatcher-start`); that a queued restart notice is ever surfaced (needs a subsequent turn). **Cold-resume persistence is now VERIFIED (host source)** as a host capability: `ContinuableActivationRegistry.coldResume` re-observes a persisted `continuable`-mode session and resumes it (dsh-subagent/lib/index.js:1870-1910; a non-continuable descriptor throws `NOT_RESUMABLE`, :1889). So dsh *does* persist continuable worker sessions across restart for cold-resume. Our rebuild deliberately does NOT resume live workers — it only restores terminal/unknown markers (`src/core/multitask.ts:640-654`) — which is a **core design decision, not a host gap**.

---

## Summary table (per ADR-0017 stages)

| Stage | What the reference needs | What dsh provides (verified wiring / note-claimed) | Verdict |
|---|---|---|---|
| 1 Intake | Always-on property, resolved at startup; no activation step | Explicit `dispatcher-start` command; inject-at-activation + per-turn via `agent.inject` (no gate, no boot auto-activate) | PARTIAL |
| 2 Triage | n/a (model decides) | No host seam; dispatcher tools only | N/A |
| 3 Spawn | Idempotent; blank context; no user channel; leaf | `subagents.startContinuable` (provider=`spawn`, toolFilter deny, maxDepth=0); no custom persona → provider default base prompt (text uninspected); cwd unsettable; acceptance-resolution + toolFilter VERIFIED | AVAILABLE* |
| 4 Concurrency | Parallel; user-lane watchdog; no worker-health probe | Independent sessions + our wake-bus mid-turn hold/user-preemption; **no worker-liveness watchdog** | PARTIAL |
| 5 Steer | Interrupt-then-resume same session; last-wins; context preserved | `sendMessage` + explicit `interrupt` + deliver on `agent/status` idle; timing depends on host "idle" event | PARTIAL |
| 6 Stop | Silent final abort; late result dropped | `subagents.interrupt` → `agent.cancel` (keepInbox) + activation teardown VERIFIED; late-result suppression core-enforced | AVAILABLE* |
| 7 Settle→wake | Push callback; dedup; coalesce; hidden turn | `subagent/end` event → wake-bus batch → `agent.followup`; **`followup` opens-a-turn VERIFIED** (agent-loop:789-791,787) | AVAILABLE |
| 8 Reconcile+deliver | Agent speaks; completed ⇒ delivered | Reconcile in core; delivery = dispatcher's own turn; workers tool-filtered | AVAILABLE* |
| 9 Obligation | Durable ledger; boot redrive; bounded → `lost` | `storageDomain` markers durable; **no `lost`, no bound, no redrive, no telemetry** | PARTIAL |
| 10 Restart | Redrive wakes/acks; drive recovery on boot; always-on | `rebuildFromDurability` + injected notice (no turn); explicit activation, no boot hook | PARTIAL |

`*` = seam wired and used; the asterisk marks stages whose end-to-end guarantee depends on a dsh-internal behaviour that was **previously CLAIMED BY NOTE but is now VERIFIED against the installed 0.1.5-rc.2 host source**: child base prompt (no custom persona set — refined, not a gap), toolFilter honour (verified scoped `tools.restrict()`), acceptance-resolution of spawn (verified), `followup` opens a turn (verified), interrupt → `agent.cancel` (verified), cold-resume persistence (verified host capability). The only remaining asterisk-class item is *what the in-process provider's default child base prompt text contains* (uninspected `dsh-agent-presets`).

---

## Load-bearing claims in prior notes — all now RESOLVED against 0.1.5-rc.2

These were asserted in `dsh-adapter-api-notes.md` / `dsh-extension-surface.md` as "verified against the installed 0.1.5-rc.1 code." All six have now been **re-asserted against the real installed 0.1.5-rc.2 host source** (host at `C:/Users/TZhen/.dsh/profiles/node_modules/@deepseek-ai/`). Status:

1. **`startContinuable` resolves on inbox acceptance, not on turn finish** — **VERIFIED.** Doc "resolve at initial inbox acceptance" (dsh-subagent/lib/index.js:1637); returns `{ childId, messageId }` after `submitMaterialized` delivers to the child inbox (index.js:1678-1680). S1 sound: spawn never blocks the dispatcher.
2. **`Agent.followup` opens a dispatcher turn** — **VERIFIED (highest risk, now closed).** `ReactLoopAgent.followup` → `send(input,"next-turn",true)` → `wakeDriver` (dsh-agent-loop/lib/index.js:789-791,787); wake always opens a turn boundary (runtime-types.d.ts:175-186). If this had been false, results would never deliver — it is true.
3. **`Agent.inject` queues context without waking** — **VERIFIED.** `ReactLoopAgent.inject` → `send(input,"next-step",false)`, `wakeup=false` skips `wakeDriver` (dsh-agent-loop/lib/index.js:795-797). Confirms D-4 is a deviation, not a bug.
4. **`toolFilter` is honoured at runtime as scoped `tools.restrict()`** — **VERIFIED.** Host's own shipped contract (dsh-subagent/lib/types/types.d.ts, `toolFilter`): "In-process backends apply it as a scoped `tools.restrict()` … the named tools vanish from the child's prompt AND refuse to execute … with loud unknown-name validation." S5 rests on a verified guarantee.
5. **`ctx.subagents.sendMessage` steers the nearest step if running** — **VERIFIED.** Host doc "steer delivery targets the nearest step" (dsh-subagent/lib/index.js:3028-3029); routing `delivery:"steer"` → `steerPrompt` → child `Agent.steer` (next-step + wake). The repo's explicit `interrupt` is belt-and-suspenders.
6. **`Agent.cancel` is a usable low-level method** — **REFUTED for the dispatcher parent** (as our code already showed). `requestDispatcherInterrupt` is a documented no-op (`cordis-dsh-host.ts:608-616`). For *children*, `subagents.interrupt` → `agent.cancel` is verified present (dsh-subagent/lib/index.js:853-865). The note's framing of `Agent.cancel` as a general low-level tool is misleading for the dispatcher parent.

**Meta-finding (retracted):** the prior caveat that "dsh is not installed" was **false for this machine** — the real profile is `C:/Users/TZhen/.dsh` (the notes pointed at a stale `C:/Users/TZ\...` path and an outdated `rc.1` version; actual is `rc.2`). All prior-note claims have now been reproduced/refuted against the real install. The tickets 46/49 lesson still holds as a method rule — assert every seam against implementation — and this map now does so for both our code and dsh's.

## System-prompt position (cross-reference — see teammate `seam-channel`)

- **Is the system-prompt position plugin-settable?** **Yes — the seam exists.** `dsh-system-prompt` is a "Registry for **ordered** system sections, dynamic context, tool schemas, and prompt variables" (dsh-system-prompt/lib/index.js:6); sections "order by their explicit placement, then deterministically by name" (index.js:95), and a plugin can register a per-agent override through `agent.ctx` ("for a per-agent override, register through that agent's `agent.ctx` instead", index.js:188-190). So a plugin *can* claim a positioned slot in the dispatcher's system prompt.
- **This map does NOT assess the full system-prompt surface** (what slots exist, precedence, persona-shadowing, the deployment-prefix/suffix sections) — that is **`seam-channel`'s investigation** (ticket 52/53 system-prompt work). Cross-reference their note rather than duplicating.
- Our plugin currently does **not** use this seam: it injects policy via `agent.inject` (queue, no turn) and a per-turn reminder, not via a system-prompt section (`src/adapter/parent-agent.ts:224-226,176-181`). Whether the rebuild should move policy into a positioned system-prompt section is `seam-channel`'s call.

## Seams that do NOT exist (that we might assume exist)

- **`Agent.steer` / `Agent.cancel` on the dispatcher parent** — not used; `requestDispatcherInterrupt` is a no-op (`cordis-dsh-host.ts:608-616`). A dispatcher mid-turn cannot be preempted (priority-peer wake is the only soft path).
- **Host intake hook / pre-turn message gate** — none. The plugin can only react after a turn begins.
- **Boot/auto-activation hook** — none. Activation requires the explicit `dispatcher-start` command (ADR-0009).
- **Peer (sibling↔sibling) messaging bus** — none; only parent/child adjacency (`dsh-extension-surface.md` confirms).
- **Worker-liveness watchdog / health probe** — none in dsh (reference §4 gap inherited).
- **`completionDelivery=wakeup` config name** — does not exist; we use `agent.followup` (`dsh-extension-surface.md` confirms rename needed).
- **User-facing stop button / affordance** — none (matches reference; stop is conversational/agent-mediated).
- **Delivery obligation `lost` state, bounded redrive, run tokens, disposition telemetry** — none (D-5/D-6).

## What the rebuild may safely assume (verified here)

- dsh exposes `subagents.startContinuable` / `.interrupt` / `.sendMessage`, `agents.get`, the `subagent/end` and `session/event` and `agent/status` host events, `storageDomain`, `tools`/`commands`/`userQuestions`, and `agent.followup` / `agent.inject` — because our plugin **wires and calls every one of them** (`src/plugin.ts:73-81`, `src/adapter/cordis-dsh-host.ts`). Their *names and shapes as called* are real, and their **runtime semantics are now VERIFIED against the installed 0.1.5-rc.2 host source**: acceptance-resolution of `startContinuable`, `followup` opens a turn, `inject` queues without waking, `toolFilter` scoped `tools.restrict()`, `sendMessage` steers nearest step, `interrupt` → `agent.cancel` with teardown, and cold-resume persistence for continuable sessions. The only remaining inspection gap is the *text* of the in-process spawn provider's default child base prompt (`dsh-agent-presets`, not separately present).

---
*Prepared by dsh-loop-seams (R3). Read-only. No files modified except this note. Clean-room rule honoured: reference tree never opened; reference behaviour cited only through our own `docs/research/` notes.*
