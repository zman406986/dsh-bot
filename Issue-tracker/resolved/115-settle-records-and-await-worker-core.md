# 115 — Per-target settle records + `Multitask.awaitWorker` (no tool yet)

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** 114
**Related:** ADR-0025 (bounded await is part of the dispatcher peer model), ticket 116 (`message_agent`), ticket 117 (`await_agent` tool), design `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` §4.2 and §7 (untracked input, not authority)

## Problem

Nothing in the core remembers a worker's terminal result. The settle path receives `status` and the report text and immediately composes a wake; after that the text lives only in the wake and in the transcript. A dispatcher therefore cannot ask "did that worker finish, and what did it say?" without polling `check_workers` and reading state that does not carry the result.

ADR-0025's product shape needs a bounded wait on a named worker. The wait has to read a record, not poll the host and not read a transcript.

## What to do

- [ ] Add a bounded per-parent-session ring of **64** `SettleRecord`s: `{ workerId, status: "completed" | "error" | "aborted", resultText (clamped), settledAtMs }`. Write it in the settle path **before** the wake is enqueued, so a wait that races the wake still sees the record.
- [ ] Add `awaitWorker(parentSessionId, workerId, timeoutMs, signal, hooks)` returning the outcome union in the design note §4.2: `settled` (with `worker_status`, `result`, `settled_at_ms`, `waited_ms`), `still-running`, `gone`, `released`; refusals `unknown-target`, `self-target`, `not-awaitable`, `too-many-waits`, `invalid-timeout`.
- [ ] Add `cancelWaits(sessionId)`. Wire it to session deactivation so no waiter or timer outlives a deactivated dispatcher.
- [ ] Add an optional `isAgentAlive?: (id) => boolean` port on the core options, wired adapter-side to `ctx.agents.get(id) !== undefined`. It is checked **once at timeout**, never on a timer.
- [ ] Race set: settle-record arrival, timeout timer, `signal` abort, and session deactivation. First wins; every loser is cleaned up in a `finally`.
- [ ] Enforce **4 concurrent waiters per dispatcher session**; a fifth returns `too-many-waits`.
- [ ] Unit tests with the existing `FakeDshHost` harness: settled-before-wait (timeout 0), settle-during-wait with clamped result, timeout returns `still-running` and a later settle is not lost, aborted signal returns `released` and leaves no timer, `isAgentAlive` false at timeout with no record returns `gone`, waiter cap, deactivation cancels waiters.
- [ ] Keep this ticket tool-free. No registration, no prompt text, no PRD text — those are 117 and 119.

## Bounds and constants (ticket-level, recorded before implementation)

| Value | Chosen | Reason |
|---|---|---|
| Ring size | 64 | Bounded memory; far more than one dispatcher can settle between two turns. |
| Default `timeout_ms` | 30,000 | Matches the host's `wait_agent` default. |
| Max `timeout_ms` | 120,000 | The dispatcher's turn is the user's chat; a longer wait is not a chat turn. |
| Concurrent waiters | 4 | Small enough to bound timers, large enough for a team. |
| `timeout_ms: 0` | non-blocking status read | Lets a dispatcher check without waiting. |

## Constraints

- In-memory only. Nothing durable: a restart loses results, which is the documented worker behaviour — report the loss plainly, never replay (ADR-0012).
- No polling of the host, no transcript reads, no timers except the one timeout per wait.
- Does not change settle-wake composition or wake ordering.
- Offline tests only (S8 lane); no live dsh, no LLM.
- ADR-0018 U-H: this is a bounded result ring, not per-stream token/usage accounting and not a search index.

## Comments

### 2026-10-18 — filing

Filed from the 2026-10-18 messaging/await/mitosis design (§12 ticket 115), re-checked against accepted ADR-0025 and the resolved open questions in `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md`. The settle record is the only thing `await_agent` (117) reads, which is why it ships first and without a tool.

Blocked by 114: the 0.2.1 host port must land before this is built against the booted tree.

### 2026-10-21 — first half landed (records + wait engine); `awaitWorker` remains

Split note: this pass implemented everything except the `Multitask.awaitWorker` method itself (checkbox 2 is deliberately split — the record layer and the full wait engine landed; the public method is a thin entry on top) and the adapter wiring (src/plugin.ts is out of scope for this pass).

Landed:

- `src/core/settle-records.ts` (new): `SettleRecord` (`workerId`, `status: "completed" | "error" | "aborted"`, `resultText` (clamped by the settle path with the wake-side `clampReport`), `settledAtMs`); per-parent-session ring of 64 (`SETTLE_RING_SIZE`), oldest evicted; `createSettleRecords()` → `SettleRecords` with `record` / `lookup` / `wait` / `cancelWaits` / `waiterCount`.
- The bounded-wait engine `awaitWorker` will delegate to: race set is exactly the ticket's — record arrival, timeout timer, `signal` abort, session deactivation (`cancelWaits`); first wins and every loser is cleaned in one finish path (timer cancelled, abort listener removed, waiter unregistered). 4 concurrent waiters per session (`MAX_CONCURRENT_WAITS`), a fifth refused `too-many-waits`. `isAgentAlive` is consulted once, at timeout, only when no record exists — false → `gone`, true → `still-running`. `timeoutMs: 0` is a non-blocking status read: no timer, no waiter registration.
- Outcome union `AwaitWorkerOutcome` per design §4.2 (adopted by the ticket): `settled` (`workerStatus`/`result`/`settledAtMs`/`waitedMs`), `still-running`, `gone`, `released`, refusals `unknown-target` / `self-target` / `not-awaitable` / `too-many-waits` / `invalid-timeout`. Core fields are camelCase; the tool layer (117) maps onto the wire snake_case. `released.reason` is always `"stopped"` — the design note's "user-message" race is not in this ticket's race set.
- Entry helpers so the method stays thin: `validateAwaitTimeout` (undefined → default 30,000; 0 valid; negative / non-finite / >120,000 → `invalid-timeout`) and `resolveAwaitTarget` (self → `self-target` before any lookup; caller's own worker → proceed; another session's worker → `unknown-target`; live dispatcher → `not-awaitable`; otherwise `unknown-target`).
- `src/core/multitask.ts`: `MultitaskOptions.isAgentAlive` port (ticket-named) + `MultitaskOptions.awaits` clock/scheduler seams (access/wake pattern); the settle path writes the record BEFORE `wakeBus.enqueueWorkerSettled` — wake composition and ordering untouched (verified by test); `Multitask.settleRecords` (exposed like `wakeBus`, for tests and the await layer) and `Multitask.cancelWaits(sessionId)`.
- `test/settle-records.test.ts`: 20 passing, covering every behavior in the ticket's test list that the engine surface can reach: settled-before-wait (timeout 0), settle-during-wait with clamped result, timeout → `still-running` with the later settle not lost, pre-aborted and mid-wait abort → `released` with no surviving timer, `isAgentAlive` false at timeout → `gone` (checked exactly once), waiter cap, `cancelWaits` scoping (siblings keep their waiters), ring eviction at 64, per-session ring isolation, error/aborted settle records, and the timeout/target validation helpers.

Remaining for the second half:

- `Multitask.awaitWorker(parentSessionId, workerId, timeoutMs, signal, hooks)` on the interface + implementation: validate the timeout (`validateAwaitTimeout`), resolve the target (`resolveAwaitTarget` fed with `workers.get` and `isLiveDispatcherSession`), then delegate to `settleRecords.wait`. All machinery exists; nothing in the engine needs to change.
- Adapter wiring (next pass): `isAgentAlive` → `ctx.agents.get(id) !== undefined`; `cancelWaits(sessionId)` → session deactivation. Still tool-free (117/119 own registration, prompt, PRD).

Deviation from the design note (ticket is authority): design §7's "record absent + worker terminal (stop-aborted) → settled" rule is NOT implemented — the ticket's timeout semantics (`still-running` / `gone` via `isAgentAlive`) govern.

Gates: `npx tsc -p tsconfig.json --noEmit` clean; `npx tsx --tsconfig tsconfig.client.json --test test/settle-records.test.ts` 20/20.

### 2026-10-21 — second half landed: `Multitask.awaitWorker`; adapter wiring still pending

Scope note (consistent with the split recorded above): this pass implemented ONLY the core half — the public `Multitask.awaitWorker` method. Nothing outside `src/core/` and `test/` was touched: `src/plugin.ts`, `src/adapter/`, `src/worker/`, `src/client/` are untouched by this pass (their dirty state in the tree belongs to parallel tickets). **Adapter wiring remains pending** for a later pass: `isAgentAlive` → `ctx.agents.get(id) !== undefined` and `cancelWaits(sessionId)` on session deactivation. The core port stays safely defaulted (absent `isAgentAlive` = timeout always reports `still-running`, never `gone`; `resolveAwaitTarget` runs without the live-dispatcher probe).

Landed:

- `Multitask.awaitWorker(parentSessionId, workerId, timeoutMs, signal?, hooks?)` on the interface + implementation in `createMultitask` (src/core/multitask.ts). Order per ticket: `validateAwaitTimeout` first (so a bad timeout refuses `invalid-timeout` even for an unknown target), then `resolveAwaitTarget({ callerSessionId: parentSessionId, targetId: workerId, getWorker: workers.get, isLiveDispatcherSession })`, then delegate to `settleRecords.wait`. No engine changes; `hooks` is the ticket-signature parameter the design note never defined — landed as a reserved, empty `AwaitWorkerHooks` interface (documented for ticket 117), pass nothing today. `timeoutMs: undefined` takes the 30,000 ms default.
- Semantics per refusal, all returned (never thrown): `invalid-timeout` (negative / non-finite / >120,000); `self-target` (target is the calling session, refused before any lookup); `not-awaitable` (target is a live dispatcher session — only when the adapter wires `isLiveDispatcherSession`); `unknown-target` (no such worker, or the worker belongs to another parent session); `too-many-waits` (fifth concurrent waiter in the session). Outcomes: `settled` (record present at call or arriving mid-wait; carries `workerStatus`/`result`/`settledAtMs`/`waitedMs`), `still-running` (timeout, agent alive or port unwired), `gone` (timeout, `isAgentAlive` false — consulted once at the timeout), `released` (signal abort or `Multitask.cancelWaits`).
- Tests: extended `test/settle-records.test.ts` with a `Multitask.awaitWorker` describe block in the existing harness style (FakeDshHost + manual clock/scheduler, no real timers): **32/32 pass** (20 prior + 12 new). New coverage via the public method: settled-immediate at timeout 0 (also with an explicit empty hooks object), settle-during-wait with clamped result, timeout → `still-running`, omitted timeout arms the 30,000 ms default timer, `gone` via `isAgentAlive` (checked exactly once), mid-wait abort → `released` with the timer cancelled, each refusal (`invalid-timeout`, `self-target`, `unknown-target` ×2, `not-awaitable`, `too-many-waits`), and `cancelWaits` releasing a public-method waiter and freeing its slot.
- Refusal-before-wait paths arm no timer and register no waiter (asserted).

Gates: `npx tsc -p tsconfig.json --noEmit` clean; ONE `npx tsx --tsconfig tsconfig.client.json --test test/settle-records.test.ts` run, 32/32. No full suite, no build, no commit.

Still open on this ticket: adapter wiring only (above). Tool registration, prompt text, PRD text remain 117/119.

### 2026-10-21 — adapter wiring landed; ticket complete (tool-free as scoped)

The last remaining piece — the adapter wiring — landed in `src/plugin.ts` (free since ticket 129 finished with it):

- `isAgentAlive` wired on the `createMultitask` options: `(workerId) => ctx.agents.get(workerId) !== undefined`. Registry verified before wiring: worker ids ARE dsh subagent session ids, and `ctx.agents` is the same live-agent registry the host's own wake path resolves — `requestDispatcherWakeup` does `ctx.agents.get(sessionId)` (`src/adapter/cordis-dsh-host.ts:908`; the `AdapterContext.agents` port is declared at `:204`). No invented lookup. Consulted once, at the timeout, only when no settle record exists — the core's contract, unchanged.
- `multitask.cancelWaits(sessionId)` added to the lifecycle's `onDeactivated` handler (after `clearSessionAccessPolicy`, before the pump reset — same early-return-tolerant cleanup block). One hook covers BOTH release paths: `agent/disposed` and plugin unload (`lifecycle.unbind`) funnel through the same `deactivateSession` → `onDeactivated` sequence (`src/adapter/parent-agent.ts` — disposed handler at `:256-262`, `unbind` deactivating each session at `:386-391`, `onDeactivated` fired at `:231`), so no separate unload call exists or is needed.
- Comment-only fix while owning the file: the session-kind projection comment at the apply entry no longer names `/dispatcher-stop` as a live counterpart of `/dsh-bot` — it now records the post-ADR-0030 reality (stop command withdrawn, removed by ticket 129) and that the projection still matches the legacy literal so persisted pre-rename logs keep marking their sessions.

Test (honest reduction, per the wiring-pass instruction): NO new plugin-level test. The plugin-scaffold harness DOES drive `onDeactivated` (activate via the start command, deactivate via `agent/disposed`), but `cancelWaits` has no observable effect reachable from the plugin surface: the `Multitask` instance is private to `apply()`, this ticket is deliberately tool-free (no registered tool reaches `awaitWorker` — that is 117), and `cancelWaits` emits nothing external without a waiter. A `dispatchApprovalSeamFor`-style exported helper would be driven with the test's own Multitask, so it could not fail if the `onDeactivated` line were deleted — it would pin a copy, not the wiring. The only honest observation path is module mocking (experimental `mock.module` flag plus tsx loader interplay) — the heavy scaffolding this pass was told not to build. The behavior itself stays covered where it is testable: the 32 core tests already pin `cancelWaits` releasing a public-method waiter and freeing its slot, and `isAgentAlive` false at timeout → `gone`.

Gates: `npx tsc -p tsconfig.json --noEmit` clean; ONE `npx tsx --tsconfig tsconfig.client.json --test test/plugin-scaffold.test.ts` run, 13/13 (the plugin-level harness that drives the edited `apply()`). Nothing else touched; no commit.

Nothing remains on this ticket: records, wait engine, `awaitWorker`, and both wiring points are landed. Registration, prompt text, and PRD text stay with 117/119.

## Answer

Resolved 2026-10-22 — the record layer, the wait engine, the public `awaitWorker` method, and both adapter wiring points are on the shipped tree; the claims below were spot-checked at the cited lines before resolution.

**Records (`src/core/settle-records.ts`).** One insertion-ordered ring per parent session, `SETTLE_RING_SIZE = 64` (:28; oldest evicted at :221), holding `SettleRecord { workerId, status: "completed" | "error" | "aborted", resultText, settledAtMs }` (:40). The settle path writes the record BEFORE `wakeBus.enqueueWorkerSettled` (`src/core/multitask.ts:789`, wake at :799), and `resultText` is clamped with the wake-side `clampReport` at that same call site — so a wait that races the wake still sees the result, and wake composition/ordering is untouched. In-memory only; a restart loses results (ADR-0012: reported plainly, never replayed).

**Wait engine (`src/core/settle-records.ts`).** `record` / `lookup` / `wait` / `cancelWaits` / `waiterCount` (:125-158). Race set is exactly the ticket's: settle-record arrival, the one timeout timer, `signal` abort, and session deactivation (`cancelWaits`); first wins and every loser is cleaned in one finish path (timer cancelled, abort listener removed, waiter unregistered). Bounds: `AWAIT_DEFAULT_TIMEOUT_MS = 30_000` (:31), `AWAIT_MAX_TIMEOUT_MS = 120_000` (:34), `MAX_CONCURRENT_WAITS = 4` (:37; fifth refused at :273). `isAgentAlive` is consulted exactly once, at the timeout, only when no record exists — false → `gone`, true → `still-running`. `timeoutMs: 0` is a non-blocking status read: no timer, no waiter registration. Factory seams `now` / `schedule` / `isAgentAlive` keep tests on a manual clock and scheduler.

**`Multitask.awaitWorker` (`src/core/multitask.ts:1423-1445`).** Interface at :458-464. Order is `validateAwaitTimeout` first (so a bad timeout refuses `invalid-timeout` even for an unknown target), then `resolveAwaitTarget` (self → `self-target` before any lookup; caller's own worker → proceed; another session's worker → `unknown-target`; live dispatcher → `not-awaitable`; otherwise `unknown-target`), then delegation to `settleRecords.wait`. `timeoutMs: undefined` takes the 30,000 ms default. `AwaitWorkerHooks` landed as a reserved, empty interface (`src/core/settle-records.ts:96`) documented for ticket 117; `hooks` is accepted and ignored today.

**Outcomes, all returned and never thrown.** `settled` (`workerStatus` / `result` / `settledAtMs` / `waitedMs`), `still-running`, `gone`, `released` (`reason: "stopped"` — the design note's "user-message" race is not in this ticket's race set); refusals `invalid-timeout`, `self-target`, `not-awaitable`, `unknown-target`, `too-many-waits`. Refusal-before-wait paths arm no timer and register no waiter. Core fields are camelCase; ticket 117 maps them to the wire's snake_case.

**Adapter wiring.** `isAgentAlive: (workerId) => ctx.agents.get(workerId) !== undefined` (`src/plugin.ts:653`) — the same live-agent registry the host wake path resolves (`src/adapter/cordis-dsh-host.ts:908`), verified before wiring. `multitask.cancelWaits(sessionId)` sits in the lifecycle `onDeactivated` handler (`src/plugin.ts:967`, after `clearSessionAccessPolicy`, before the pump reset); one hook covers both release paths (`agent/disposed` and plugin unload), because both funnel through `deactivateSession` → `onDeactivated` (`src/adapter/parent-agent.ts:227-231`, :256-262, :386-391).

**Recorded deviation (ticket is authority).** The design note §7 rule "record absent + worker terminal (stop-aborted) → settled" is NOT implemented; the ticket's timeout semantics (`still-running` / `gone` via `isAgentAlive`) govern.

**Honest reduction.** No plugin-level test pins the `cancelWaits` line: `Multitask` is private to `apply()`, the ticket is deliberately tool-free until 117, and `cancelWaits` emits nothing external without a waiter — a test would pin a copy, not the wiring. The behavior stays covered where it is testable: `test/settle-records.test.ts` (32/32, `FakeDshHost` with manual clock/scheduler) pins `cancelWaits` releasing a public-method waiter and freeing its slot, and `isAgentAlive` false at timeout → `gone` (checked exactly once), plus every listed case (settled-before-wait at timeout 0, settle-during-wait with clamped result, timeout → `still-running` with the later settle not lost, abort → `released` with no surviving timer, waiter cap, ring eviction, per-session isolation).

**Gates at resolution.** `npx tsc -p tsconfig.json --noEmit` clean; one `test/settle-records.test.ts` run 32/32; one `test/plugin-scaffold.test.ts` run 13/13.

**Not here (by design).** Tool registration, prompt text, and PRD text belong to tickets 117 (`await_agent`) and 119. Ticket 117 builds on this core, mapping the camelCase fields to the wire's snake_case at the tool layer.
