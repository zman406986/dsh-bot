# 11 — Dispatcher tools + policy prompts

**What to build:** The dispatcher's own working surface and the instructions that make it act like one busy person: short turns, delegating the heavy work, steering instead of cloning, reconciling before it speaks.

**Blocked by:** 10 — Worker agent type + tool barrier.

**Status:** ready-for-human

- [x] The dispatcher can spawn a stream, check running workers, steer one, stop one, and deliver a message to the user — each surfaced as its own dsh-native tool with dsh-native wording.
- [x] The spawn result tells the dispatcher the worker runs in the background and its final response will arrive on completion, so it should not wait or poll.
- [x] The check surface returns elapsed time, tool-call count, recent activity, and the transcript location for each running worker.
- [x] The dispatcher policy is injected as new copy covering: dispatcher not workhorse; non-trivial multi-step work spawns a worker; independent work runs in parallel; a correction steers rather than clones; a todo entry precedes a spawn; reconcile on every wake; worker prompts are self-contained; workers never message the user; the machinery is never named to the user.
- [x] Short reminders re-inject the todo list and the policy highlights at the start of each dispatcher turn, rather than relying on a one-time system prompt.
- [x] The wake turn instructs the dispatcher to lead with the concrete thing that finished and to stay silent when the result is stale or duplicate.
- [x] Worker report text arriving in the dispatcher's context is clamped with a transcript reference attached, and check/steer results are summarized rather than dumped.
- [x] No shipped prompt string, identifier, or tool description comes from the reconstruction — all copy is written for this project.
- [x] A short manual demo shows a long fake worker with rapid user messages: the user is answered within seconds, a mid-run steer changes the worker's direction without restarting it, and the result is delivered to the user at the end.

## Implementation notes (ready-for-human review)

### What landed (design: `.scratch/multitask-dispatcher/design-11-dispatcher-tools-prompts.md`)

New pure modules (no host; FakeDshHost untouched):

- `src/core/report-clamp.ts` — `REPORT_CLAMP_CHARS` (2000), `ERROR_CLAMP_CHARS` (800), `CHECK_ACTIVITY_CHARS` (120), `TOOL_RESULT_SUMMARY_MAX_ROWS` (20); `clampReport` / `clampError` / `formatWakeReportBody` / `clampActivity`. Hard character cut; empty → placeholder; aborted → no report body; truncation marker carries transcript pointer.
- `src/core/tool-results.ts` — check rows (`WorkerCheckRow`, `toCheckRow`, compact `formatCheckRowLine` / head-tail fold), spawn ack (do-not-wait), steer/stop notes. Never JSON dumps, never transcript contents.
- `src/core/policy/prompts.ts` — tool names + descriptions, stable section headings, full policy / standing-rules / wake-instructions copy (new).
- `src/core/policy/assembler.ts` — `assembleSessionPolicy(enabled)` (ADR-0005: OFF → empty), `assembleTurnReminder(todos)` (empty ledger → `(empty)` + rules), `assembleWakeTurn(notices)` (clamped reports + silence/stale rules).
- `src/core/tools.ts` — five dispatcher tools mapped 1:1 onto `Multitask.spawnWorker` / `listWorkers` / `steerWorker` / `abortWorker` / `markDelivered` (+ injectable `deliverToUser`). Handlers stay core-side.

Adapter wiring:

- `src/adapter/dispatcher-tools.ts` — structural `ctx.tools.register` wrap (`toRegisterableTool`); no-op when tools absent.
- `src/adapter/cordis-dsh-host.ts` — `ToolsLike.register?`, `AgentLike.inject?`, `composeWakeText` option on the host.
- `src/adapter/parent-agent.ts` — policy inject once at bind; per-turn reminder on dispatcher turn start (best-effort `agent.inject`).
- `src/adapter/wake-copy.ts` — `wakeUserMessage(text?)` accepts the composed wake body.
- `src/plugin.ts` — `composeWakeText` drains the wake (reconcile runs), maps settle notices + rebuild `landedUndelivered` (empty report → transcript pointer), prepends the per-turn reminder; registers the five tools.

### Manual demo outline (S1–S5)

Fake-host path runs in CI without network/LLM (S8). Live dsh pass is the M2 exit.

| Step | Action | Expect | Criterion |
|---|---|---|---|
| D1 | User: "Summarize the three auth RFCs and draft a migration note." | Todo written; `spawn_worker` with self-contained prompt; user answered within seconds; ack says do not wait. | S1 |
| D2 | User (while worker runs): "Status of the docs rewrite?" | Short turn; no poll loop. | S1 |
| D3 | User: two independent asks. | Two todos; two spawns; distinct `stream_key`s; both running. | S2 |
| D4 | User mid-run: "Focus on the third RFC only." | `steer_worker` on that stream; no clone; interrupt + wrapped correction. | S3 |
| D5 | Fake `fireSettled` with a long report. | Wake turn; report clamped with transcript pointer; reminder + wake instructions present. | Clamp |
| D6 | On wake: reconcile, `deliver_result` leading with the concrete thing, mark todo `completed`. | User sees result; `completed` only after delivery. | S4 |
| D7 | Inspect worker tool list. | No user-messaging / spawn / steer / stop / check / todo tools (T10 barrier). | S5 |
| D8 | D3 workers still running while D6 delivers. | User never blocked; parallel `in_progress` stay open. | S1, S2 |

Stale/silence sub-demo (part of D6): fire a duplicate/already-summarized settle → wake runs, no `deliver_result`, turn ends silently.

### Residual / follow-ups

- `recent_activity` stays `null` until a live jobs/step-line resolver is wired (design open point 2).
- User-turn reminder relies on `agent.inject` when present; hosts without inject still get session policy + wake-path reminder + tool descriptions.
- `deliver_result` without an injectable send marks the todo delivered after the tool call (wake followup turn is already user-visible); a real host send can be plugged in later without changing the tool shape.
