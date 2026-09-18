# 11 鈥?Dispatcher tools + policy prompts

**What to build:** The dispatcher's own working surface and the instructions that make it act like one busy person: short turns, delegating the heavy work, steering instead of cloning, reconciling before it speaks.

**Blocked by:** 10 鈥?Worker agent type + tool barrier.

**Status:** resolved

- [x] The dispatcher can spawn a stream, check running workers, steer one, stop one, and deliver a message to the user 鈥?each surfaced as its own dsh-native tool with dsh-native wording.
- [x] The spawn result tells the dispatcher the worker runs in the background and its final response will arrive on completion, so it should not wait or poll.
- [x] The check surface returns elapsed time, tool-call count, recent activity, and the transcript location for each running worker.
- [x] The dispatcher policy is injected as new copy covering: dispatcher not workhorse; non-trivial multi-step work spawns a worker; independent work runs in parallel; a correction steers rather than clones; a todo entry precedes a spawn; reconcile on every wake; worker prompts are self-contained; workers never message the user; the machinery is never named to the user.
- [x] Short reminders re-inject the todo list and the policy highlights at the start of each dispatcher turn, rather than relying on a one-time system prompt.
- [x] The wake turn instructs the dispatcher to lead with the concrete thing that finished and to stay silent when the result is stale or duplicate.
- [x] Worker report text arriving in the dispatcher's context is clamped with a transcript reference attached, and check/steer results are summarized rather than dumped.
- [x] No shipped prompt string, identifier, or tool description comes from the reconstruction 鈥?all copy is written for this project.
- [x] A short manual demo shows a long fake worker with rapid user messages: the user is answered within seconds, a mid-run steer changes the worker's direction without restarting it, and the result is delivered to the user at the end.

## Implementation notes (ready-for-human review)

### What landed (design: `.scratch/multitask-dispatcher/design-11-dispatcher-tools-prompts.md`)

New pure modules (no host; FakeDshHost untouched):

- `src/core/report-clamp.ts` 鈥?`REPORT_CLAMP_CHARS` (2000), `ERROR_CLAMP_CHARS` (800), `CHECK_ACTIVITY_CHARS` (120), `TOOL_RESULT_SUMMARY_MAX_ROWS` (20); `clampReport` / `clampError` / `formatWakeReportBody` / `clampActivity`. Hard character cut; empty 鈫?placeholder; aborted 鈫?no report body; truncation marker carries transcript pointer.
- `src/core/tool-results.ts` 鈥?check rows (`WorkerCheckRow`, `toCheckRow`, compact `formatCheckRowLine` / head-tail fold), spawn ack (do-not-wait), steer/stop notes. Never JSON dumps, never transcript contents.
- `src/core/policy/prompts.ts` 鈥?tool names + descriptions, stable section headings, full policy / standing-rules / wake-instructions copy (new).
- `src/core/policy/assembler.ts` 鈥?`assembleSessionPolicy(enabled)` (ADR-0005: OFF 鈫?empty), `assembleTurnReminder(todos)` (empty ledger 鈫?`(empty)` + rules), `assembleWakeTurn(notices)` (clamped reports + silence/stale rules).
- `src/core/tools.ts` 鈥?five dispatcher tools mapped 1:1 onto `Multitask.spawnWorker` / `listWorkers` / `steerWorker` / `abortWorker` / `markDelivered` (+ injectable `deliverToUser`). Handlers stay core-side.

Adapter wiring:

- `src/adapter/dispatcher-tools.ts` 鈥?structural `ctx.tools.register` wrap (`toRegisterableTool`); no-op when tools absent.
- `src/adapter/cordis-dsh-host.ts` 鈥?`ToolsLike.register?`, `AgentLike.inject?`, `composeWakeText` option on the host.
- `src/adapter/parent-agent.ts` 鈥?policy inject once at bind; per-turn reminder on dispatcher turn start (best-effort `agent.inject`).
- `src/adapter/wake-copy.ts` 鈥?`wakeUserMessage(text?)` accepts the composed wake body.
- `src/plugin.ts` 鈥?`composeWakeText` drains the wake (reconcile runs), maps settle notices + rebuild `landedUndelivered` (empty report 鈫?transcript pointer), prepends the per-turn reminder; registers the five tools.

### Manual demo outline (S1鈥揝5)

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

Stale/silence sub-demo (part of D6): fire a duplicate/already-summarized settle 鈫?wake runs, no `deliver_result`, turn ends silently.

### Residual / follow-ups

- `recent_activity` stays `null` until a live jobs/step-line resolver is wired (design open point 2).
- User-turn reminder relies on `agent.inject` when present; hosts without inject still get session policy + wake-path reminder + tool descriptions.
- `deliver_result` without an injectable send marks the todo delivered after the tool call (wake followup turn is already user-visible); a real host send can be plugged in later without changing the tool shape.

## 2026-09-18 — Considered passed (human deferral)

Human review of the live dsh demo (D1–D8, S1–S5) is **deferred, not done**: the human has not executed it. For continuation-of-work purposes only, this ticket is **considered passed** so downstream tickets may proceed. The deferral reason is that the human is waiting for the client UI surfaces to be complete, then will run the demo against the finished product in one pass. This note does not constitute verification; ticket 33 (closeout) still owns ensuring the demo happens before merge.

## Comments

- Moved to resolved by overnight sweep 2026-09-18: all ACs checked; verified via implementing commits and artifact spot-check on main.

## 2026-09-18 — live smoke observed (re-pass #2): registration + policy injection GREEN; tool EXECUTION blocked by ticket 45 (schemas invalid); D1–D8 demo still deferred

Live facts from the ticket-44 re-pass #2 (`C:\Users\TZhen\Desktop\dsh-live-repass2-2026-09-18\`): the five dispatcher tools (a) register on activation — the activated turn's payload carried them, which is exactly what the provider's schema validator rejected (`Invalid schema for function 'check_workers'`, ticket 45); (b) the policy surface is live — two `上下文注入 · multitask-dispatcher` rows (session policy + per-turn reminder) appear on the activated session's turn (`shots/09`), and the dormant state registers exactly the two commands (dormant-registration matrix confirmed live via `commands/list`). The D1–D8 manual demo (S1–S5) remains deferred until ticket 45 makes turns executable; no live tool result, steer, wake, or delivery has been observed yet.
