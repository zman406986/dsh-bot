# Research: reference behavior notes (plain-language observations for imitation)

- Question: For the open behavioral questions (stop semantics, steering queues, spawning topology, worker-to-worker messaging, wake-while-busy, priority/peer messages, result-delivery shape), what does the reference implementation actually do — so dsh can imitate it?
- Scope: reference tree only (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`). Everything below describes observable behavior in plain language; no code, prompts, tool strings, identifiers, or protocol artifacts were copied, and none may be reconstructed from these notes. Evidence entries are file paths only, relative to that tree's root.
- Caveat on the source: the reference tree is itself an unofficial, source-oriented reconstruction of a shipped desktop app (see the tree's README/PROVENANCE), not the vendor's original source. Behavior statements below are what the reconstruction encodes; the reconstruction states its own evidence/parity process. Treat "clear" as "this is what the reconstructed code does", not "the vendor's binary was disassembled again here".
- Date: 2026-09-16

---

## 1. Stop semantics (worker stopped/cancelled)

**Observed behavior**

- Stopping a running worker is an explicit action by the agent that dispatched it, through a dedicated stop tool. The tool returns a plain confirmation to the dispatcher: the worker is being stopped and nothing further will arrive from it. Nothing in the stop path sends a chat message to the user: whether the user hears about the cancellation is entirely the dispatcher's own choice on a later turn. The app UI does show the worker's lifecycle state changing (running/finished/failed/stopped) in the agent's task/roster surfaces, so the cancellation is visible in the interface, but it is not announced in the conversation.
- Stopping also disarms the completion wake that had been registered when the worker was dispatched, marks the worker's record as stopped, and clears any parked steer text for that worker. The worker session is discarded.
- A result that arrives after the stop takes effect is dropped: when the worker's run settles, the settle path checks the stop flag first, skips both the result delivery and the parent wake, and returns. Late results are never brought back or delivered. (There is also a fallback: if the flagged path somehow produces a completion, the stop flag still wins at settle.)
- Race boundary: if the worker had already fully settled before the stop call reached it, the stop is refused because no run is active; the refusal also notes the worker might already be done, and the completion that was already queued is delivered normally. So "finished before stop" delivers; "finishes after stop" drops.
- Messages or steers queued for that worker at the moment of stop are dropped along with it — nothing is kept parked for a later attempt to bring the worker back.

**Evidence**

- `source/host/runner/subagent-runtime.ts` (stop/steer/settle flow)
- `source/host/runner/tools/sand-subagent-management-tools.ts` (stop tool confirmation and refusal wording)
- `source/host/extensions/transcript/roster-projection.ts` (lifecycle state emitted to the UI)
- `frontend/src/production/ProductionRenderer.tsx`, `frontend/src/recovered/features/conversation/workspace/conversation-outline-view.tsx` (UI shows a stopped status)

**Confidence**: clear for dispatcher-initiated worker stop. Partial for the exact user-visible UI copy when the *user* stops a top-level run: the backend interrupt path exists and emits no chat message, but the renderer's cancellation presentation is only partly recovered.

**Notes for dsh**: imitate — stopping a worker is silent to the user by default; the dispatcher learns via the tool result and decides whether to tell the user; late results and parked steers are dropped.

---

## 2. Steering queues

**Observed behavior**

- Worker steering is **single-slot, latest-wins, per worker**: a new steer replaces any undelivered earlier steer for that worker. Delivering a steer interrupts the worker's current step; when that step unwinds, the worker is started again with the latest steer text wrapped in a short note identifying it as a message from the parent and directing the worker to fold it in and resume from where it left off rather than restart, keeping its existing context. Context is preserved; the worker does not restart from scratch.
- Only the latest survives because the parked-steer store holds one message per worker id. If several steers are sent before the current step finishes unwinding, earlier ones are simply overwritten and never delivered.
- Steering a worker that is not running is refused, with a message noting the worker might already be done (and pointing at the resume route for following up with a finished worker). There is no queue for finished workers.
- At the dispatcher's own inbound level the model is different: three priority lanes — that is, three separate queues that are always drained in priority order: user, peer-agent, background — with first-in-first-out inside each one and one run at a time. A new user message does **not** wait behind the current turn — it interrupts/supersedes it (the previous turn's context is recoverable) and becomes the next run. Peer messages queue in the agent lane; worker completions queue in the background lane. The run scheduler also has watchdog behavior: if a queued user message waits too long behind a stuck run, the stuck run is interrupted, and if it still will not settle, it is abandoned so the user's turn can proceed.

**Evidence**

- `source/host/runner/subagent-runtime.ts` (parked steer is a single map entry; interrupt then re-run on unwind)
- `source/host/runner/background-work.ts` (steer text wrapper)
- `source/host/runner/tools/sand-subagent-management-tools.ts` (steer/refused wording)
- `source/host/extensions/transcript/run-scheduler.ts` (lanes, FIFO, watchdog)
- `source/host/extensions/transcript/send-turn-dispatch.ts` (user message supersedes the active run instead of queueing behind it)

**Confidence**: clear.

**Notes for dsh**: imitate — latest-wins for worker steers, refused when the worker is idle/finished; user messages supersede the dispatcher's current turn rather than queueing.

---

## 3. Spawning topology

**Observed behavior**

- Only the top-level per-chat agent has the spawn tool. Worker runs are constructed with an internal flag distinguishing this run as a subagent run, and the per-turn tool builder excludes, for workers: the spawn tool, the worker-management tools (inspect/steer/stop), the user-facing message tool, the peer-agent message tool, agent create/update tools, the plan/todo tool, image generation, screenshots, box help, and MCP management. Workers do keep the work tools: shell/read/await on both surfaces, web search/fetch, and (for the dedicated computer/browser worker types) the computer/browser tools.
- The worker's system prompt is a separate short prompt (not the dispatcher's): it says the worker is running as a delegated worker, must complete the task autonomously, has **no way to talk to the user**, must not ask follow-ups, and must end with a concise plain-text final answer that is delivered back to the parent as its result. A read-only variant is possible.
- Spawn mechanics: the dispatcher's spawn tool call is adapted by a host adapter that allocates a worker id (or resumes an existing one, but refuses to resume one that is still running), then hands the run to the background-work dispatcher, which registers the worker, arms a pending-wake marker, and starts the run in the background. The spawn tool result returns the worker id plus a short note that it now runs in the background and its final response will be delivered upon completion, so the dispatcher should not wait and should either end its turn or move on to other work.
- Group/shared-room participant runs also exclude the spawn tool (they run with the shared-room flag), so spawn authority is a property of a top-level, non-shared agent context.
- Cloud coding agents are a separate tool (not the spawn tool) and are only offered outside shared rooms.

**Evidence**

- `source/host/runner/tools/turn-toolset.ts` (tool list filtered by role)
- `source/host/runner/system-prompt.ts` (worker prompt: no user contact, result back to parent)
- `source/host/runner/agent-adapters.ts` (create-or-resume session, allocation, dispatch)
- `source/host/runner/subagent-runtime.ts` (dispatch registers, arms wake, starts run)
- `source/host/host-runner-composition.ts` (worker runner built with the subagent flag; management controller)
- `source/packages/agent/tools/task-client.ts` (background spawn result text)
- `source/host/runner/system-prompt-assembly.ts` (sections meant only for the dispatcher, switched off for workers)

**Confidence**: clear (both the tool-list gating and the worker prompt agree). One low-impact ambiguity: the tool builder has an early branch that returns an empty toolset for a worker run in a configuration where no spawnable-worker type list is present; it does not affect the spawn conclusion.

**Notes for dsh**: imitate — flat parent-and-children structure, only the top-level dispatcher spawns; workers sit at the bottom and have work tools only.

---

## 4. Worker-to-worker messaging

**Observed behavior**

- There is **no direct worker-to-worker messaging**. Workers have no messaging tools at all (neither to the user nor to peers); all worker traffic routes through the dispatcher that spawned them: dispatcher to worker via steer, worker to dispatcher via the completion wake (result text), plus inspect/stop. The inspect tool can return the worker's live transcript path so the dispatcher can read the full step-by-step history itself.
- Direct agent-to-agent messaging does exist, but only between **top-level agents** (the user's separate per-chat assistants) and into shared group rooms they belong to. Sending does not wait for an answer: the send returns a delivery acknowledgement; a reply arrives later as its own message that wakes the sender on a fresh turn (not a live back-and-forth inside one turn). The wake prompt tells the recipient it is another assistant reaching out, not the user.
- Workers share files rather than messages: they have shell/read tools, so artifacts are exchanged by path, and the dispatcher reads transcripts/files when it wants more detail.

**Evidence**

- `source/host/runner/tools/turn-toolset.ts` (worker tool list excludes both messaging tools)
- `source/host/runner/tools/sand-subagent-management-tools.ts` (inspect returns transcript path)
- `source/host/agents/agent-messaging.ts` (peer directory/messaging description; no worker involvement)
- `source/host/extensions/transcript/agent-to-agent-messaging.ts` (peer send/reply routing and wake)
- `source/host/extensions/transcript/shared-rooms.ts` (group posting path)

**Confidence**: clear.

**Notes for dsh**: imitate — workers cannot message each other; the dispatcher relays; direct peer messaging exists only at dispatcher level (matches ADR-0002/0003 intent).

---

## 5. Wake while busy

**Observed behavior**

- A worker finishing while the dispatcher is mid-turn is **queued, never injected into the running turn**. The completion handler de-duplicates per worker id, stores the completion, and enqueues a background-lane run. The run scheduler allows one run per agent at a time and selects by lane priority (user > peer > background), so the wake-up turn waits until the current turn ends.
- When it runs, it is a hidden, silence-allowed turn: the dispatcher is handed a formatted wake prompt announcing that a background task it started has now completed, containing each completed worker's status, title/type, and result text, plus an instruction to pick the work back up, only tell the user if the result is genuinely new and relevant (or the user asked to be told), and otherwise stay silent and end the turn. Several completions that pile up are batched into one wake prompt.
- If the parent agent no longer exists (deleted), the completion is dropped with telemetry. If a wake-up turn is already running for that agent, newly arriving completions stay pending and are picked up by that same running loop.
- The spawn tool result itself tells the dispatcher the completion will be delivered when it ends its turn, i.e. the guidance is to rely on being woken rather than polling or waiting.

**Evidence**

- `source/host/extensions/transcript/completion-revivals.ts` (completion queue, hidden wake-up run, silence allowed, batching, drop rules)
- `source/host/extensions/transcript/run-scheduler.ts` (one run at a time, lane priority)
- `source/host/runner/subagent-runtime.ts` (settle emits the completion event)
- `source/packages/agent/tools/task-client.ts` (background result promises auto-delivery on turn end)

**Confidence**: clear.

**Notes for dsh**: imitate — worker completion is a queued background wake that runs after the current turn, not a mid-turn injection.

---

## 6. Priority / peer messages

**Observed behavior**

- Peer (agent-to-agent) messages have an explicit priority flag. Normal peer messages queue behind the recipient's current work (they still run ahead of automations/other background work). A priority peer message is put at the **front** of the recipient's inbound queue and, additionally, interrupts the recipient's currently running turn — but never a turn the user is driving: if the active run is in the user lane, no interrupt happens.
- The interrupt is a normal run interrupt; the interrupted non-user work is re-queued (flagged as re-drivable, with dedupe so it is not lost or double-shown), and the priority message's wake prompt tells the recipient this is a priority instruction from another assistant, not the user, and to drop conflicting in-flight work and follow it.
- Priority is 1:1 only. Group posts ignore priority (and images): a group post just enqueues a group turn in the peer-agent lane, and the sender is told priority did not interrupt members.
- There is also a broadcast wake for messages the user sends to all their agents (a distinct wake prompt telling the agent this is the user speaking to all agents, not another agent), and a channel delivery path for external/messaging-channel inbound (a separate wake prompt, and user-facing sends can target a channel). The PRD's idea of a priority lane maps most directly to the peer-message priority flag.

**Evidence**

- `source/host/runner/tools/sand-agent-management-tools.ts` (priority flag semantics as described to the model)
- `source/host/extensions/transcript/agent-to-agent-messaging.ts` (put at the front of the queue, interrupt except in the user lane, retry after an interrupt)
- `source/host/extensions/transcript/shared-rooms.ts` (group post: priority ignored)
- `source/host/agents/agent-messaging.ts` (priority wake wording; broadcast prompt)
- `source/host/runner/tools/send-message-schema.ts` (channel target for user-facing sends)

**Confidence**: clear for 1:1 peer priority; partial for the broadcast/channel lanes (present in code and prompts, not traced end-to-end here).

**Notes for dsh**: imitate — peer messages have a priority flag that preempts non-user work only; never the user's own turn.

---

## 7. Result delivery shape (brief)

**Observed behavior**

- The worker's result is passed to the dispatcher essentially verbatim: the settled run's text is trimmed, and if empty it is replaced with a fixed placeholder noting the task produced no text output; error outcomes pass the error message; a stop outcome is not delivered at all. In the wake prompt the result sits under a labeled block that names the task's title and type and marks it as finished, joined with the pick-the-work-back-up instruction. No limit on result size was found on this path.
- The dispatcher is the only party that talks to the user, via its user-facing send tool; the wake prompt explicitly asks it to lead with the concrete thing that finished, not a bare pronoun, and to skip messaging when the result is stale/duplicate.
- Inline (non-background) worker results render as the worker's last assistant output; when a summary is present it is presented as a high-level summary block above the response block, and the result also carries the worker id so the dispatcher can resume or link to it. Background spawn results only say the worker is running and will report later.
- Peer text is limited to a fixed maximum (8,000 characters) before routing; worker result text going into the wake prompt is not limited by that helper. The user-facing send tool supports text, images inline with text, standalone file/media attachments by URL, widgets, secret requests, and cloud-agent cards; box-side file paths are automatically copied to the user's machine when attached (per the model-facing instructions). The wake path itself attaches nothing — artifacts flow only when the dispatcher chooses to attach a path in its own user-facing send.

**Evidence**

- `source/host/runner/subagent-runtime.ts` (result trimming, placeholder, error/stop outcomes)
- `source/host/extensions/transcript/completion-revivals.ts` (wake prompt assembly, silence rule)
- `source/packages/agent/tools/task-client.ts` (inline result rendering, summary block, background notice)
- `source/host/agents/agent-messaging.ts` (limit on peer text)
- `source/host/runner/tools/send-message-schema.ts`, `source/host/runner/tools/send-message-tool.ts` (user-facing delivery types and attachment resolution)

**Confidence**: clear for text shape and size limits; partial for artifact auto-handling (attachment behavior is prompt-level and tool-level, not exercised by the wake path).

**Notes for dsh**: imitate — deliver the worker report verbatim (trimmed, with a no-output placeholder), let the dispatcher decide the user message; no automatic artifact attachment.

---

## Open / unclear

- The exact user-facing presentation when the **user** stops a running top-level turn (chat marker vs. status-only): the backend interrupt path emits no chat message; the renderer presentation is only partly recovered.
- Whether a priority peer message can preempt a *background wake-up run* specifically: the code interrupts any active run whose lane is not the user lane, which would include a background-lane wake-up run, but this was not verified by observation.
- Whether anything upstream (outside the wake path) truncates an oversized worker result before it reaches the wake prompt; none found, but not exhaustively audited.
- Exact boundary behavior in the completion-vs-stop race (finished just before vs. just after the stop arrives): the code forks on a settle-time flag, but the practical timing window was not executed/observed.
- Workers can read files on their surfaces, so indirect coordination via paths is physically possible; this was not audited as a communication channel, and no messaging mechanism exists.
- The list of wake sources was not exhaustively enumerated (automations/routines, cloud agents, shell completions, external listeners all have their own wake paths; only the worker-completion path was traced in depth here).
