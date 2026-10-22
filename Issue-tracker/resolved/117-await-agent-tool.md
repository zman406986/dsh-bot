# 117 — `await_agent` tool

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** 115
**Related:** ADR-0025, ADR-0028 (the reply lane is the inverse direction), ticket 119 (policy text and PRD anti-pattern narrowing), design `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` §4.2 and §7 (untracked input, not authority)

## Problem

Ticket 115 gives the core a bounded wait. Nothing exposes it to the model, so the dispatcher still cannot use it. It also cannot be released early when the user sends a message, which is what keeps PRD S1 ("reply within seconds") believable while a wait is in flight.

## What to do

- [ ] Register the `await_agent(target, timeout_ms?)` tool through the dispatcher tool surface with `executeOverride(args, exec)` so `exec.signal` reaches the wait.
- [ ] Bounds: default 30,000 ms; accepted range 0–120,000; `timeout_ms: 0` is a non-blocking status read. Out of range → `invalid-timeout`.
- [ ] **Worker targets only.** A dispatcher target refuses with `not-awaitable`, and the copy says to message it and end the turn. This is the cycle rule: workers have no await tool and dispatchers are not awaitable, so `A awaits B awaits A` is not constructible. A refusal, not a timeout.
- [ ] Waiter cap: 4 concurrent per dispatcher session; a fifth → `too-many-waits`.
- [ ] User-message early release: the adapter watches the **dispatcher's own** session in `session/event` and releases that session's waiters with `released` / `reason: "user-message"`. Key the release on the **structured** user source, never on text.
  - When the event shape is first verified against the booted 0.2.1 tree. If it cannot be verified, **ship without early release** and record that honestly — the 120 s cap is then the only bound. Do not guess a shape.
- [ ] Deactivation cancels waiters (`cancelWaits` from 115); turn abort via `exec.signal` propagates.
- [ ] Unit tests: `timeout_ms: 0` on a settled record returns `settled` with the clamped result; a settle landing during the wait resolves it; timeout returns `still-running` and the record survives; abort resolves `released` and leaves no timer; dispatcher target returns `not-awaitable`; fifth waiter returns `too-many-waits`; a user message releases a live waiter; deactivation cancels.

## Bounds (ticket-level, recorded before implementation)

| Value | Chosen |
|---|---|
| Default timeout | 30,000 ms |
| Max timeout | 120,000 ms |
| Concurrent waiters per session | 4 |
| `timeout_ms: 0` | non-blocking status read |

The 120 s cap is deliberately below the host's own wait ceiling because the dispatcher's turn is the user's chat turn.

## Constraints

- No timer polling. The only timers are the per-wait timeout and the release path.
- Reads ticket 115's record. Does not poll the host, does not read a transcript.
- Worker tool surface unchanged: `await_agent` is a dispatcher-only tool and must never appear in a worker's scope.
- Offline tests (S8 lane). A live check of the user-source event shape is gated by `read-before-running-live-and-browser-tests.md` (kill timer, trivial task, evidence under `.scratch/testing/2026-10-18-<slug>/`).

## Comments

### 2026-10-18 — filing

Filed from design note §12 ticket 117. The early-release item is the one place where this ticket may have to ship a reduced shape: the user-source event shape on the dispatcher's own session is not yet verified against the booted tree, and the honest fallback is to ship without early release rather than guess. That fallback is recorded here so it cannot be discovered mid-implementation.

Blocked by 115 (the record and the wait this tool exposes).

### 2026-10-22 — core half landed (status stays claimed)

**Landed (core + tool definition + registration only):**

- `AWAIT_AGENT_TOOL = "await_agent"` in `src/core/policy/prompts.ts`, added to `DISPATCHER_TOOL_NAMES` (now seven) and to `TOOL_DESCRIPTIONS` (copy states the bound, that a timeout is a normal outcome, workers-only, and what `released` means).
- Tool handler in `createDispatcherTools` (`src/core/tools.ts`). Schema: `{target: string, required}`, `{timeout_ms: number, required:false}`, `additionalProperties: false`. `DispatcherToolDef.execute` now carries an optional structural `exec`; a new exported `readExecSignal(exec)` pulls `exec.signal` out of it.
- Routing: `multitask.awaitWorker(sessionId, target, timeout_ms, signal)` — the existing ticket-115 core. No second wait mechanism, no host poll, no transcript read.
- Wire mapping: `toAwaitAgentToolResult` in `src/core/tool-results.ts` is the ONE camelCase→snake_case boundary. Success shapes: `settled{target, worker_status, result, settled_at_ms, waited_ms}`, `still-running{target, waited_ms}`, `gone{target, waited_ms}`, `released{target, reason, waited_ms}` — all `ok:true`; refusals are `{ok:false, reason, detail}` with the closed vocabulary `unknown-target|self-target|not-awaitable|too-many-waits|invalid-timeout`. Every success also carries `summary` (model-facing text; for `settled` it embeds the result itself, because the host renders only that text).
- `not-awaitable` copy override: names `message_agent` and says to end the turn (the ticket's copy requirement).
- Non-number `timeout_ms` (e.g. `"5000"`) refuses `invalid-timeout` before the core, using the new shared `AWAIT_INVALID_TIMEOUT_DETAIL`; nothing is coerced and no timer is armed.
- Worker barrier: `"await_agent"` added to `WORKER_DENIED_TOOL_CANDIDATES` (`src/worker/tool-barrier.ts`), so the cycle rule still holds.
- Index exports updated (`src/index.ts`): `AWAIT_AGENT_TOOL`, `readExecSignal`, `AwaitAgentToolResult`, `toAwaitAgentToolResult`, `formatAwaitNote`.

**Semantics per outcome/refusal**

| Result | Meaning |
|---|---|
| `settled` | A settle record existed at call time or arrived during the wait. Wins over timer and abort. Clamped result, `waited_ms` from the wait. |
| `still-running` | Timeout fired, no record, worker alive (or no liveness port). Record survives for a later read. |
| `gone` | Timeout fired, no record, liveness port says the agent is dead. Consulted once, at the timeout. |
| `released` / `stopped` | Turn abort (`exec.signal`) or session deactivation (`cancelWaits`). Worker is NOT stopped. |
| `released` / `user-message` | Wire shape supports it; **nothing produces it yet** (adapter seam below). |
| `invalid-timeout` | Non-number, negative, non-finite, or > 120,000. Validated before any target lookup. |
| `self-target` | Target is the calling session; refused before any lookup. |
| `unknown-target` | Not a worker of this session (unknown id, or another session's worker, or a dispatcher that is not live). |
| `not-awaitable` | Live dispatcher session. Refusal, not a timeout; copy says message it and end the turn. |
| `too-many-waits` | Fifth concurrent waiter in one dispatcher session. |

**Deactivation / stop signal:** reused, not duplicated. `cancelWaits` is already called at plugin level (`src/plugin.ts:967`) and resolves waiters `released`/`stopped`; `exec.signal` reaches the wait through `readExecSignal`.

**Adapter follow-up IS needed (recorded, not built here):** `registerDispatcherTools` wraps each def with `toRegisterableTool(def)` and that default path calls `def.execute(args)` **with no exec**, so on live hosts `exec.signal` does not reach `await_agent` yet and the 120 s cap is the only live bound. Two things a follow-up chunk owns, all in `src/adapter` + `src/plugin`:
1. Pass exec through (`toRegisterableTool(def, (args, exec) => def.execute(args, exec))`, or equivalent) so turn abort releases the wait.
2. User-message early release: watch the dispatcher's OWN session's `session/event`, key the release on the **structured** user source (never text), and release that session's waiters with `reason: "user-message"` through the reserved `AwaitWorkerHooks` / a new core release path. Ticket 117 itself says: if the event shape cannot be verified against the booted 0.2.1 tree, ship without early release and record it — that fallback is what has effectively shipped so far.

No `src/adapter`, `src/plugin.ts`, or `src/client/` file was edited (verified by grep: no `await_agent`/`awaitAgent` reference in those trees).

**Exact-selection pins updated** (six-tool shape → seven):
`test/activation-lifecycle.test.ts` (3 exact lists + 7 count pins), `test/composition-polish.test.ts`, `test/coexistence.test.ts` (exact list + 2 count pins), `test/multi-dispatcher.test.ts` (2 scoped lists), `test/plugin-scaffold.test.ts` (list + 5 count pins), `test/worker-composition.test.ts` (agent-plane fixture, deny list, `names.size` 12→13), `test/adapter-cordis-dsh-host.test.ts` (agent-plane fixture + deny list), `test/worker-agent-type.test.ts` (deny candidates + dispatcher-tools list), `test/dispatcher-tools.test.ts` (2 lists), `test/policy-assembler.test.ts` (order pin), `test/client-toolviews.test.ts` (states the deliberate `await_agent` client-row lag alongside the existing `send_peer` one).

**Gates:** `npx tsc -p tsconfig.json --noEmit` clean; `npx tsc -p tsconfig.client.json --noEmit` clean. One grouped offline run of 21 files: **470 tests, 470 pass, 0 fail** (105 suites), including the new `test/await-agent.test.ts` (**23 tests**). Manual clock/scheduler only — no real timers. No `npm test`, no full suite, no build, no commit.

**Still open on this ticket:** the adapter half described above; a live check of the user-source event shape (gated by `read-before-running-live-and-browser-tests.md`); the `AWAIT_AGENT_TOOL` checkbox in "What to do" is therefore only half-done — the tool is registered and unit-pinned, the early release is not.

### 2026-10-22 — adapter half landed: exec passthrough + user-message release (status stays claimed)

Both gaps recorded above are closed. Nothing in `src/client/`, no policy text, and no core tool behavior changed.

**GAP 1 — exec passthrough (landed).**

`src/adapter/dispatcher-tools.ts:180` — the default path of `toRegisterableTool` is now `return def.execute(record, exec);` (was `def.execute(record)`). The `executeOverride` branch already forwarded exec and is untouched.

The host shape this satisfies is the installed one: `dsh-tools/lib/index.js:3406` (`dispatchToolBody`) calls `tool.execute(exec.arguments, exec)`, and the `exec.signal` it passes there is the turn's fused cancellation signal (caller signal fused with any around-wrapper replacement, `:3394-3413`). So `readExecSignal(exec)` in `await_agent` now receives a real `AbortSignal` live, and `spawn_dispatcher`'s `exec.signal` pass-through into `host.spawnDispatcher` is live for the first time. Every other dispatcher handler ignores the second parameter, so the change is inert for them — no observable behavior changed except signal delivery.

**GAP 2 — `released` / `user-message` (landed; the event shape verified against the installed tree, so the ticket's reduced fallback was NOT taken).**

Chain, each hop cited against `dsh@0.2.1-rc.2` (`C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`):

1. A user prompt reaches the dispatcher Agent as `agent.followup(message)` or `agent.steer(message)` from the API controller (`dsh-api-session-controller/lib/types/commands.js:337-343`), with the durable source built at `lib/index.js:3225` as `{ kind: "user", rpcId, clientTimeZone?, principal? }`.
2. `Agent.send` splices it into the durable inbox with `this.inbox.splice(target, Infinity, 0, [message])` (`dsh-agent-loop/lib/index.js:800-802`), and `Inbox.mutate` commits `session.append("agent/inbox/spliced", { target, start, inserted })` **synchronously inside that call** (`:180-207`). This is the hop that matters: it runs while the tool call is still blocked, so the observation does not wait for the turn or the next step.
3. `Session.commit` publishes to `session/event` observers inside the same append (`dsh-session/lib/index.js:1577-1592`), which is the subscription our host already holds.

The release therefore keys on the **structured source**, never on text: `src/adapter/cordis-dsh-host.ts:461` `dispatcherUserMessageSession(sessionRef, event)` returns the session id only when

- the event is `agent/inbox/spliced` and at least one `data.inserted[]` entry has `role === "user"` **and** `source.kind === "user"`, or
- the event is `user/message` with the same two fields on `data` (the turn-boundary catch — the same message committed at a pre-step, `dsh-agent-loop/lib/index.js:1069-1073`).

`removedCount` / `outcome: "canceled"` are ignored on purpose: queue management is not a user prompt. Everything else on the same stream is a non-match by source — our own wakes (`plugin:multitask-dispatcher`, `src/adapter/wake-copy.ts:33`), peer wakes (`agent-message`, `dsh-subagent/lib/index.js:444-449`), settle wakes (`subagent-settled`, `:534`), runtime context (`runtime-context`), and model/tool traffic. No text field is read anywhere on this path, so no wording can forge or suppress a release.

Wiring:

- `src/adapter/cordis-dsh-host.ts:728` — new `userMessageCallbacks` fan-out, fired from the EXISTING ticket-29 `session/event` subscription (`:835`) **before** its `tool/call`-only filter (a dispatcher session is never an owned worker, so that filter would drop it). Same subscription, no new host seam, no polling, no timers. Public seam: `CordisDshHost.onDispatcherUserMessage` (`:373`, implementation `:1030`), cleared in `dispose()` (`:1334`).
- `src/plugin.ts:689` — `host.onDispatcherUserMessage((sessionId) => multitask.releaseWaits(sessionId, "user-message"))`.
- New core release path, shared with the existing one: `SettleRecords.releaseWaits(sessionId, reason)` (`src/core/settle-records.ts:194` / `:394`, over one private `releaseAll`, `:255`) and `Multitask.releaseWaits` (`src/core/multitask.ts:451` / `:1439`). `cancelWaits` keeps resolving `"stopped"` through the same `releaseAll`. The race is first-wins over the existing set: settle record, timeout, abort, `cancelWaits`, `releaseWaits` — every loser still cleans up its timer, abort listener, and waiter registration in the one `finish` path. Released waiters do not stop the worker and do not clear records; other sessions' waiters are untouched. A session with no waiters is a no-op.

`AwaitReleasedReason = "stopped" | "user-message"` is now the core's reason type (`src/core/settle-records.ts:97`), exported through `src/core/multitask.ts`; the wire mapping in `toAwaitAgentToolResult` already handled both, so its stale "only produces stopped today" comment was updated, not its behavior.

**Honest limits recorded (not hidden):**

- The observation is of `session/event` on the dispatcher's own session, so it is one event-loop turn behind a real wall-clock keystroke, not instantaneous. The bound that matters is unchanged: what the user typed while the await blocks is never behind the 120 s cap.
- A slash command that steers user input (e.g. `/plan`) produces the same `source.kind: "user"` message and will release a wait. That is the host's own attribution of human input, and it is treated as such rather than special-cased.
- No live boot was run in this chunk. The shape claims above are code reading of the installed 0.2.1-rc.2 tree (citations inline), which is what the ticket asked for; a live pass under `read-before-running-live-and-browser-tests.md` (kill timer, trivial task, evidence in `.scratch/testing/`) is still the honest confirmation step and is unchanged by this comment.
- `AwaitWorkerHooks` stayed empty. The release is an explicit call the adapter makes, not a per-wait closure, so nothing needed to be threaded through the reserved parameter; its doc comment now says exactly that.

**Tests (all manual clock/scheduler; no real timers, no host, no network):**

- `test/adapter-dispatcher-tools.test.ts` — **29 tests** (was 12): 4 exec-passthrough pins (default path forwards the exact exec object; the wrapper's `await_agent` releases on the aborted `exec.signal` with timer cancelled and waiter freed; exec is forwarded verbatim rather than validated; `executeOverride` still wins and still receives exec), 7 structured-detection pins (inbox splice, `user/message`, every non-user source ignored, assistant role rejected, text lookalike ignored, removals ignored, unreadable payloads), 6 end-to-end release pins over the real `createCordisDshHost` subscription (own-session release with `waited_ms`, our wake / peer wake / runtime-context do not release, sibling-session scoping, no-waiter no-op, worker-brief isolation, wire shape + copy). The FakeDshHost supplies only the core ports; the detection side is the production `createCordisDshHost` over a stub bus.
- `test/settle-records.test.ts` — **33 tests** (was 32): one `releaseWaits("user-message")` pin (reason propagated, sibling session keeps its waiter and still settles, unknown session no-op).
- `test/plugin-scaffold.test.ts` — **15 tests** (was 14): one wiring pin that the shipped `apply()` handles structured user prompts, our wake, and a peer wake on the firehose without throwing, unregistering anything, or disturbing the nine-tool surface, dormant and activated.
- `test/await-agent.test.ts` unchanged at **23 tests**.

**One host behavior worth recording:** the host submits a spawned child's initial task with `source: {kind: "user"}` too (`dsh-subagent/lib/index.js:1461`). So a worker spawned while a dispatcher wait is in flight delivers a user-sourced message on the CHILD's session. It cannot release anything: waiters are keyed by the awaiting dispatcher's session id, and workers are denied `await_agent` by the barrier, so no waiter can ever be registered under a worker id. The `child-worker-9` pin above holds that guarantee rather than leaving it implied.

**Gates:** `npx tsc -p tsconfig.json --noEmit` clean (run twice, before and after the test edits). ONE grouped offline run of 20 files — `await-agent`, `adapter-dispatcher-tools`, `plugin-scaffold`, `settle-records`, `adapter-cordis-dsh-host`, `composition-polish`, `activation-lifecycle`, `spawn-dispatcher-host`, `spawn-dispatcher-activation`, `spawn-dispatcher-tool`, `tool-results`, `host-seam`, `dispatcher-tools`, `worker-agent-type`, `worker-composition`, `multi-dispatcher`, `coexistence`, `tool-schema-shape`, `message-agent`, `adapter-policy-inject` — **345 tests, 345 pass, 0 fail** (75 suites). No `npm test`, no full suite, no build, no commit. Ticket status stays `claimed`; no resolve, no index regeneration.

**Both adapter gaps from the 2026-10-22 core-half comment are now closed.** What remains open is only the optional live confirmation of the user-source observation under `read-before-running-live-and-browser-tests.md`; the release itself is built, wired, and pinned offline.

## Answer

Resolved 2026-10-22. `await_agent` is registered, routed through the ticket-115 core, released both by turn abort and by a real user message, and pinned offline. The claims below were spot-checked at the cited lines before resolution.

**The tool.** `await_agent(target, timeout_ms?)` — `AWAIT_AGENT_TOOL` in `src/core/policy/prompts.ts:38`, member of `DISPATCHER_TOOL_NAMES` and `TOOL_DESCRIPTIONS`. Handler in `createDispatcherTools` (`src/core/tools.ts:1262`, execute at :1288) with schema `{target: string, required}`, `{timeout_ms: number, required:false}`, `additionalProperties: false`. The single camelCase→snake_case boundary is `toAwaitAgentToolResult` (`src/core/tool-results.ts:317`); every success carries a model-facing `summary` because the host renders only that text. Bounds: default 30,000 ms, max 120,000 ms, `timeout_ms: 0` a non-blocking status read, 4 concurrent waits per dispatcher session.

**Outcomes** (all `ok: true`): `settled {target, worker_status, result, settled_at_ms, waited_ms}`, `still-running {target, waited_ms}`, `gone {target, waited_ms}`, `released {target, reason, waited_ms}` with `reason` `"stopped"` or `"user-message"`. **Refusals** (`ok: false`): `invalid-timeout` (non-number — `"5000"` is refused, never coerced — negative, non-finite, or > 120,000; validated before any target lookup), `self-target`, `unknown-target`, `not-awaitable` (a live dispatcher target; the copy names `message_agent` and says to end the turn — the cycle rule is a refusal, not a timeout), `too-many-waits` (fifth waiter).

**Core reuse, no second mechanism.** `multitask.awaitWorker(sessionId, target, timeout_ms, signal)` → `SettleRecords.wait` (`src/core/settle-records.ts`) is the only wait engine. `cancelWaits` was already wired at plugin level by ticket 115 (`src/plugin.ts:967`, the lifecycle `onDeactivated` handler); the tool reuses it and adds nothing. `exec.signal` reaches the wait through `readExecSignal` (`src/core/tools.ts:234`). Worker barrier unchanged: `await_agent` is in `WORKER_DENIED_TOOL_CANDIDATES` (`src/worker/tool-barrier.ts:47`), so workers never see the tool and `A awaits B awaits A` stays unconstructible.

**Adapter follow-up — both gaps closed.**

- **exec passthrough.** `src/adapter/dispatcher-tools.ts:180` is now `return def.execute(record, exec);` (was `def.execute(record)`); the `executeOverride` branch already forwarded exec. The installed host calls `await tool.execute(exec.arguments, exec)` (`dsh-tools/lib/index.js:3406`) with `exec.signal` set to the turn's fused cancellation signal, so `await_agent`'s abort path and `spawn_dispatcher`'s signal pass-through are live for the first time. Every other handler ignores the parameter, so the change is inert for them.
- **user-message release — the ticket's reduced fallback was NOT taken.** The event shape was verified against the installed `dsh@0.2.1-rc.2` tree by code reading, so the real hull shipped. `dispatcherUserMessageSession()` (`src/adapter/cordis-dsh-host.ts:461`) returns a session id only for a structured user source: `agent/inbox/spliced` with an `inserted[]` entry whose `role === "user"` and `source.kind === "user"`, plus a `user/message` turn-boundary catch with the same two fields. It is called from the EXISTING ticket-29 `session/event` subscription (`:835`, before its `tool/call`-only filter, which would drop a dispatcher session), fans out through `onDispatcherUserMessage` (`:373`, impl `:1030`, cleared in `dispose()` at `:1334`), and is routed at `src/plugin.ts:689` to `multitask.releaseWaits(sessionId, "user-message")`. Non-matches by source: our own `plugin:multitask-dispatcher` wakes, `agent-message` peer wakes, `subagent-settled`, `runtime-context`, and model/tool traffic. No text field is read anywhere on this path.
- **Core release path.** `SettleRecords.releaseWaits` (`src/core/settle-records.ts:194`, impl :394) shares one private `releaseAll` (:255) with `cancelWaits` (:390–391, `"stopped"`). `AwaitReleasedReason = "stopped" | "user-message"` is the core reason type (:97). First-wins over the existing race set (settle record, timeout, abort, `cancelWaits`, `releaseWaits`); every loser cleans up its timer, abort listener, and waiter registration in the one `finish` path. Released waiters do not stop the worker, do not clear records, and leave other sessions' waiters untouched. `AwaitWorkerHooks` stayed empty by design — the release is an explicit adapter call, not a per-wait closure.

**Honest limits, recorded.** (1) The observation is `session/event`, so it lands one event-loop turn behind a wall-clock keystroke; the bound that matters is unchanged — what the user typed during a blocked await is never behind the 120 s cap. (2) A user-input slash command that steers human input also releases; that is the host's own attribution of human input, treated as such rather than special-cased. (3) A spawned child's initial brief is also `source.kind: "user"` (`dsh-subagent/lib/index.js:1461`), but it can never release anything: waiters are keyed by the awaiting dispatcher's session id and workers are denied the tool. Pinned by a test rather than left implied. (4) No live boot was run: the shape claims are code reading of the installed tree, and a live pass under `read-before-running-live-and-browser-tests.md` remains the optional confirmation step, not a blocker.

**Client residual.** `src/client/toolviews.ts` has no `await_agent` row renderer — the same lag as `message_agent` and `spawn_dispatcher` — so it falls back to the generic row. Recorded, not a blocker.

**Gates at resolution.** `npx tsc -p tsconfig.json --noEmit` clean (also `tsconfig.client.json` at the core half); one grouped offline run of 20 files — **345 tests, 345 pass, 0 fail (75 suites)** — including `test/await-agent.test.ts` 23, `test/adapter-dispatcher-tools.test.ts` 29, `test/settle-records.test.ts` 33, `test/plugin-scaffold.test.ts` 15. Manual clock/scheduler only. No live or browser test, no build, no commit.

Moved `Issue-tracker/open/117-await-agent-tool.md` → `Issue-tracker/resolved/`, `**Status:**` → `resolved`, index regenerated. No other file moved.
