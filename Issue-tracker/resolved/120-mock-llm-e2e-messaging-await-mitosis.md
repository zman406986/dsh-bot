# 120 — Mock-LLM end-to-end coverage for messaging, await, and mitosis

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** 116, 117, 118
**Related:** ticket 115, ticket 119, `dev/mock-llm.mjs` (parallel lane), design `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` §11.2 (untracked input, not authority)

## Problem

The unit tests prove each piece in isolation. Nothing proves that a dispatcher can message a worker, wait on it, spawn a dispatcher child, and receive that child's report — the behaviour a user actually exercises. Those four flows cross the core, the adapter, and the wake bus, which is exactly where the seams are.

## What to do

Add these four scenarios to the mock-LLM harness (`dev/mock-llm.mjs` style), where the scripted model can be told to call the new tools:

- [x] A dispatcher messages a running worker; the worker's next step reflects the correction (the steer path end to end, including the step-boundary send). — **scenario added; FAILS on a real bug** (worker status never leaves `spawned`; see the 2026-10-22 comment).
- [x] A dispatcher `await_agent`s a slow worker and receives its result **in the same turn**. — passes.
- [x] A dispatcher spawns a child dispatcher; the child spawns a worker; the child's result arrives at the creator as a peer message on a later turn. — passes.
- [x] A user message during an `await_agent` releases the wait promptly (the PRD S1 check). If ticket 117 shipped without early release because the user-source event shape could not be verified, **replace this scenario with the honest alternative**: the wait runs to its 120 s cap and the dispatcher still replies, and record why the release scenario is absent. — **real release path shipped; the release scenario is implemented and passes. No fallback needed.**

## Constraints

- Mock LLM only. No live dsh, no provider key, no network.
- Each scenario asserts observable behaviour, not internal calls: what the next turn sees, what the tool returned, which turn the message arrived on.
- No new harness when `dev/mock-llm.mjs` can carry the scenario; extend it.
- Keep runs short — these are regression scenarios, not a soak test.

## Comments

### 2026-10-18 — filing

Filed from design note §12 ticket 120. The fourth scenario carries a conditional honest fallback because ticket 117 may ship without user-message early release; writing the fallback here means the harness cannot quietly pretend the release exists.

### 2026-10-22 — scenarios added; s2/s3/s4 pass, s1 finds a real bug

**Harness (extended, no new harness).** `dev/mock-llm.mjs` gained capture/substitution (`capture` + `{{name}}`), two extra match keys (`anyUserIncludes`, `toolResultIncludes`), a `toolResults` log field carrying each tool's returned body with the tool that produced it, and `toolResultTexts` in `conversationTail`. `dev/e2e-mock.mjs` gained a `--only <names>` selector, four scenario phases, and a `statusFrom()` rule so a phase reports `fail` when any of its assertions fail (previously the phase said `pass` regardless). `dev/cordis.src.patch.yml` is new: the scenarios load `src/index.ts` through `node --import tsx`, because `lib/` is a git-ignored build artifact and this harness never builds. Nothing in `src/` was changed for any scenario.

Runs (all `.scratch/testing/2026-10-22-mock-e2e-messaging/`): `run-final/result.json` (latest; identical verdict to `run-all2/result.json`) — s1=fail, s2=pass, s3=pass, s4=pass, exit 1 (s1 gates it). Same verdict three runs in a row. `run-protocol/result.json` (mock+boot) and `run-dispatch/result.json` (dispatch smoke) both exit 0, so the existing phases still pass.

**s1 — dispatcher messages a running worker (FAILS: real bug).** Drives spawn → `message_agent` at the spawn ack → worker's next step. Asserts what `message_agent` returned, that a later worker turn carries `[Parent correction]` + the exact text, and that the worker turn count went up (step boundary, not a restart). The steer is REFUSED: `Worker "<id>" is not running (it may already be done)`. Root cause reproduced on both the source overlay and the committed `lib/` build: the child emits `agent/status: running` inside `startActivation` (1 ms after `subagent/start`), but `CordisDshHost.spawnWorker` inserts the worker into its `workers` map only AFTER that call resolves — so the plugin's `agent/status` handler sees `workerIdOf(...) === undefined` and drops the event. There is no second `running` edge in one turn, so `multitask.noteTurnStarted` never runs and the FSM stays `spawned` for the entire turn (observed 16 s and one tool call in, still `spawned`). Consequences: `steer_worker` / `message_agent`-to-worker refuse `not-running` for the whole first turn, and `check_workers` under-reports. Reproduce with `node dev/e2e-mock.mjs --only s1`. The assertions are left failing — not weakened. Not fixed here (ticket 120 forbids changing `src/` to make a scenario pass).

**s2 — `await_agent` returns the result in the same turn (PASSES).** Spawns a worker that sleeps 4 s, then `await_agent` with `timeout_ms: 60000`. Asserts the tool returned `settled: completed` with the worker's report text, that no dispatcher request intervened between the call and the result, and that the same turn continued after it. Note for future scenarios: counting user messages is NOT a valid "same turn" proxy — the host delivers its own `subagent-settled` notice as an extra user-role message inside the same turn (observed 1 → 2).

**s3 — mitosis: child dispatcher reports back as a peer message (PASSES).** Creator calls `spawn_dispatcher`; the child spawns a worker; the child addresses its creator using the creator's id from its OWN peer roster (`## Other agents — not the user`), i.e. exactly how a scripted model would learn it. Asserts the summon ack's peer-dispatcher note, that the child session is a real dispatcher (40 tools incl. `spawn_dispatcher` + `await_agent`), that the child got its brief, that its worker ran, that `message_agent` returned `Accepted for peer session <creator>`, and that the creator's LATER turn carries both `Peer message — not from the user` and the child's text. Limitation: the child's identity is NOT lost — it comes from the ack and the roster — so no workaround was needed.

**s4 — user message during `await_agent` releases the wait (PASSES, real release, no fallback).** The coordinator's update is correct: `released` / `user-message` is reachable (`plugin.ts:689` `onDispatcherUserMessage` → `multitask.releaseWaits`, detector `dispatcherUserMessageSession` at `cordis-dsh-host.ts:461`). The scenario sends a REAL user message through the host's own `session/prompt` RPC (source `kind: "user"`, same as the GUI composer) while the await is outstanding, and calls no plugin internals. Asserts the tool returned `released` with the user-message copy, that the worker was reported as not stopped, that the release came in 78–93 ms (well under the cap and BEFORE the worker settled), that the dispatcher still replied in that turn, and that the worker's late result arrived later anyway. Per the recorded limits: it asserts "before the worker settled", never microsecond promptness.

**Honest gaps.** (a) s1 fails on a real bug, as above. (b) No scenario asserts on the 120 s cap running to completion — the fallback was not needed because the real release path exists; a cap test would cost 2 minutes per run and adds nothing a unit test does not already pin. (c) `--only` was added because running all phases in one go is slow; the four scenarios together take ~98 s (`run-all2`), most of it s1's bounded wait for a correction that never arrives.

### 2026-10-22 — s1's product bug FIXED; s1 now passes

**Root cause confirmed, unchanged from the finding above.** The child is live inside `startActivation`: it emits `agent/created` and its first `agent/status: running` there. `CordisDshHost.spawnWorker` registered the worker only after that promise resolved, so the status handler's `workerIdOf(...)` answered `undefined` and dropped the edge. One `running` per turn ⇒ `noteTurnStarted` never ran ⇒ the FSM stayed `spawned` for the whole first turn ⇒ `steer_worker` / `message_agent` refused `not-running` and `check_workers` under-reported. Two registries were untruthful, not one: the adapter's `workers` map AND the core's `WorkerRecord` map.

**Fix — option (a), reservation, at BOTH layers.** Not (b): queueing a status edge would have made the FSM correct while leaving the registries dishonest, and it adds a second ordering path into the same handler.

- `src/adapter/cordis-dsh-host.ts` (`spawnWorker`, ~:1111–1183): mints `reservedChildId = randomUUID()` before the spawn, passes it as `spec.childId` (the exact ticket-118 pattern), and inserts the `workers` entry BEFORE `startActivation`. The host either creates the child under that id or refuses the spawn, so no other id can come back; a defensive re-key covers a host that mints its own anyway. Refusal deletes the reservation.
- `src/core/multitask.ts` (`spawnWorker`, ~:899–1026): the worker record is now created by a `register(id)` callback the host invokes through the new `SpawnOptions.onWorkerId` BEFORE the child can emit. The post-resolve path calls the same function (so hosts that commit no id behave exactly as before) and it is idempotent — one record per spawn, never a second `spawned` row over an already-`running` one. A failed spawn unregisters; an announced-vs-resolved id mismatch re-keys instead of leaving a phantom.
- `src/core/types.ts` + `src/core/dsh-host.ts`: `onWorkerId` documented as part of the host contract.
- `src/core/fake-host.ts`: the fake commits the id the same way, so tests can reproduce the ordering.

**Why this layer.** The registry is the thing that was lying. Reserving the id makes `workerIdOf`/`getWorker` truthful for exactly as long as the child exists, so the status listener needs no new state, no queue and no grace window — and the FSM is untouched. `spawnDispatcher` had already proved this shape for the same race (ticket 118).

**Edge counting.** Unchanged: the same `running` edge still reaches `noteTurnStarted` exactly once. `register` is idempotent by id, `turn-started` is legal only out of `spawned`, and the tests assert the record object is the SAME across the edge and the resolution (no reset, no duplicate row). `liveByStreamKey` is deliberately not set by the early registration — ticket 109's in-flight reservation owns that window — and the key is taken post-resolve only for a non-terminal worker, so a settle that wins the race frees it exactly as before.

**Refusal semantics unchanged.** A never-started worker is still `spawned` and refuses `not-running`; a settled worker still refuses `not-running`; no branch in `steerWorker`/`messageAgent` was touched. Tests pin both.

**Tests (deterministic, no sleeps).** `test/adapter-cordis-dsh-host.test.ts` gains a `duringActivation` seam in the stub (fires inside `startActivation`, after `agent/created`) and six tests: the `running` edge reaches the FSM (spawned → running) and the status is already `running` when the spawn resolves; the first-turn worker accepts `steerWorker`; one edge = one record, no double count; a settled worker still refuses; a never-started worker still refuses; a failed spawn leaves neither registry holding the reservation. `test/worker-lifecycle-fsm.test.ts` gains three core-level tests with hosts whose child starts inside the spawn, including the linked-todo flip and a failed-spawn cleanup. Verified honest: with the adapter ordering reverted these tests fail 5, and the s1 control run below fails identically.

**Existing tests updated (they pinned the old ordering, not new coverage).** `test/adapter-cordis-dsh-host.test.ts` asserted host-minted `child-N` ids and a post-resolve `spec.childId`-less spawn; the stub now honours a reserved id and those assertions read the returned id or assert `String(spec.childId) === workerId`. No other test file needed a change.

**Gates.** `npx tsc -p tsconfig.json --noEmit` green; `npx tsc -p tsconfig.client.json --noEmit` green. One grouped tsx run of `test/worker-lifecycle-fsm.test.ts`, `test/adapter-cordis-dsh-host.test.ts`, `test/spawn-*.test.ts`, `test/await-agent.test.ts`, `test/message-agent.test.ts`: **148/148 pass, 0 fail**. Full suite for safety: **1492/1492 pass, 0 fail** (was 1492 tests, 1491 pass + 1 fail at the pre-fix count of 1484 — 8 net new tests).

**s1 result: PASS.** `node dev/e2e-mock.mjs --only s1` (src overlay, `dev/cordis.src.patch.yml`), evidence `.scratch/testing/2026-10-22-mock-e2e-messaging/run-fix-final/result.json`: all four s1 assertions pass — `message_agent` returned `Message parked for "S1 draftsman"…`, the worker's next step carries `[Parent correction]` + the exact text, `workerTurns: 2` with `correctedIndex: 1` (a later turn, not a restart), and the worker finished on the corrected instruction. Control run `run-regress-control/` with the adapter ordering temporarily reverted: s1=fail with the original `Worker "<id>" is not running` refusal, so the fix is what makes it pass. An earlier run of this pass, `run-fix-s1/`, shows the steer accepted while two downstream assertions still failed — see the harness note below.

**Harness defects found by the fixed run (in `dev/e2e-mock.mjs`, not the product).** Two bugs in the s1 assertions had been masked by the earlier failure at the steer ack, and both made a correct product run un-passable: (1) the "correction reached the worker" wait filtered requests by the DISPATCHER's session id while the correction lands on the WORKER's session, so the predicate was unsatisfiable regardless of product behaviour — it now searches all sessions (`waitForAnyRequest`); (2) the "later turn, not a restart" check used `workerTurns.indexOf(corrected)` on two separate JSONL parses, i.e. reference equality across distinct objects, so it could never match — it now compares by the log's `seq`. Assertions were not weakened: both still fail on a real regression, as `run-regress-control/` shows. The now-stale `blocker` comment was rewritten to describe the fix.

**Not done here.** Ticket 120 is NOT resolved and stays in `open/` — the leader decides. Index not regenerated. No commit.

## Answer

Resolved 2026-10-22. All four scenarios exist, run offline against the scripted model, and pass. The ticket's main value is the product bug s1 found and the fix that bug forced; the harness itself was extended, not rebuilt.

### 1. Harness extended, not rebuilt

- `dev/mock-llm.mjs` gained `capture` + `{{name}}` substitution, so a scripted model can use an id it just read from a tool result (`capture` scans the request's system text, every message, and every `tool_result` body; first capture wins). It also gained the match keys `anyUserIncludes` and `toolResultIncludes`, a `toolResults` log field pairing each result body with the tool that produced it, and `toolResultTexts` in the conversation tail. An unresolved placeholder is an HTTP 500, never a literal — a scenario cannot silently pass with `{{workerId}}` as its target. Verified: `substitute()` throws, and both the capture-miss and substitution-miss paths return 500 (`dev/mock-llm.mjs:84-96, 403-465`).
- `dev/e2e-mock.mjs` gained `--only <names>` (plus `--skip` narrowing), four scenario phases, and `statusFrom()` (`dev/e2e-mock.mjs:700-705`), which makes a phase `fail` unless at least one assertion ran and all passed. Before this, the dispatcher phase did `phase.status = 'pass'` at the end of its happy path, so a green phase meant "no exception thrown", not "the assertions held".
- `dev/cordis.src.patch.yml` is new: the scenarios load `src/index.ts` via `node --import tsx` because `lib/` is a git-ignored build artifact and the harness never builds. The harness work itself changed nothing under `src/`; the only `src/` work in this ticket is the product-bug fix in §3, which s1 found rather than the other way round.

### 2. Scenarios and outcomes

- **s1 — steer a running worker.** Initially FAILED on a real product bug (see §3); after the fix it PASSES: `message_agent` returns `Message parked for "S1 draftsman"…`, the worker's next step carries `[Parent correction]` and the exact text, `workerTurns: 2` with `correctedIndex: 1` (a later turn, not a restart), and the worker finishes on the corrected instruction. Evidence `.scratch/testing/2026-10-22-mock-e2e-messaging/run-fix-final/result.json`.
- **s2 — `await_agent` returns in the same turn.** PASSES: the tool returns `settled: completed` with the worker's report, no dispatcher request intervenes, and the turn continues after it. Note recorded for future scenarios: counting user messages is NOT a valid same-turn proxy — the host delivers its own `subagent-settled` notice as an extra user-role message inside the same turn (observed 1 → 2).
- **s3 — mitosis.** PASSES: the child is a real dispatcher (40 tools including `spawn_dispatcher` and `await_agent`), gets its brief, spawns a worker, addresses its creator using the creator id read from its OWN peer roster (`## Other agents — not the user`), `message_agent` returns `Accepted for peer session <creator>`, and the creator's LATER turn carries `Peer message — not from the user` plus the child's text (`peerTurnSeq 11 > summonSeq 3`). The child's identity was never lost, so no workaround was needed.
- **s4 — a real user message releases the await.** PASSES with the REAL release path, no fallback: the message goes through the host's own `session/prompt` RPC (same as the GUI composer), the tool returns `released` with the user-message copy, the worker is reported as still running (not stopped), the release lands in 65-93 ms across the preserved runs (65 ms in `run-final/`, 93 ms in `run-all2/`) and BEFORE the worker settles, the dispatcher replies in that turn, and the worker's late result arrives later anyway.

Before the fix, `run-final/` and `run-all2/` both read s1=fail, s2/s3/s4=pass, exit 1. After the fix, `run-fix-final/` reads s1=pass, exit 0.

### 3. The product bug and its fix — the ticket's main value

**Bug.** The child emits `agent/status: running` INSIDE `startActivation` (about 1 ms after `subagent/start`), but both registries recorded the worker only after the spawn promise resolved: the adapter's `workers` map in `CordisDshHost.spawnWorker` and the core's `WorkerRecord` map in `multitask.spawnWorker` (the pre-fix code did `workers.set(workerId, record)` only after `await host.spawnWorker(...)`). So the plugin's status handler computed `workerIdOf(...) === undefined` and dropped the edge. There is one `running` edge per turn, so `noteTurnStarted` never ran and the FSM stayed `spawned` for the worker's entire first turn: `steer_worker` / `message_agent` refused `not-running` (the observed text: `Worker "<id>" is not running (it may already be done)`) and `check_workers` under-reported. Reproduced on both the source overlay and the committed `lib/` build.

**Fix — reservation at BOTH layers.** The registries were the thing lying; making them truthful needs no queue, no grace window, and leaves the FSM untouched.
- Adapter: `src/adapter/cordis-dsh-host.ts:1130-1182` mints `reservedChildId = randomUUID()` before the spawn, passes it as `spec.childId` (the ticket-118 pattern, already proved by `spawnDispatcher`), inserts the `workers` entry before `startActivation`, and calls `opts.onWorkerId?.(reservedChildId)` before the child can emit. A refusal deletes the reservation; a defensive re-key covers a host that mints its own id anyway.
- Core: `src/core/multitask.ts:899-1026` creates the worker record through an idempotent `register(id)` invoked via the new `SpawnOptions.onWorkerId` BEFORE the child can emit. The post-resolve path calls the same function, so hosts that commit no id behave exactly as before; a failed spawn unregisters, and an announced-vs-resolved mismatch re-keys rather than leaving a phantom. `onWorkerId` is documented in `src/core/types.ts:78` and `src/core/dsh-host.ts:21`, and `src/core/fake-host.ts:81` commits the id the same way so tests can reproduce the ordering.

**Constraints held.** Exactly one `noteTurnStarted` per running edge (one edge = one record, no double count; `turn-started` is legal only out of `spawned`). `liveByStreamKey` is still claimed post-resolve only, and only for a non-terminal worker (ticket 109's in-flight window). Refusal semantics unchanged: a never-started or settled worker still refuses `not-running`; no branch in `steerWorker`/`messageAgent` was touched.

### 4. Verification

- s1 passes on the fixed tree (`run-fix-final/`, `run-fix-s1b/`).
- CONTROL run with the fix reverted (`run-regress-control/`): s1=fail with the original `is not running` refusal — so the fix is what makes s1 pass.
- Reverting only the adapter ordering makes 5 of the new unit tests fail. The new tests use a `duringActivation` seam that fires inside `startActivation` (deterministic, no sleeps): the adapter file gains six tests and `test/worker-lifecycle-fsm.test.ts` gains three core-level ones, including linked-todo flip and failed-spawn cleanup.
- Two harness defects were also found and fixed, both masked by the earlier failure: (1) the "correction reached the worker" wait filtered by the dispatcher's session id while the correction lands on the worker's session — now searches all sessions (`waitForAnyRequest`, `dev/e2e-mock.mjs:791`); (2) the "later turn, not a restart" check used `workerTurns.indexOf(corrected)` across two separate JSONL parses — reference equality across distinct objects, so it could never match — now compared by the log's `seq` (`dev/e2e-mock.mjs:965-971`). No assertion was weakened; both still fail on a real regression.

### 5. Gates

`npx tsc -p tsconfig.json --noEmit` clean; `npx tsc -p tsconfig.client.json --noEmit` clean. Grouped run of the touched suites: **148/148 pass, 0 fail**. Full suite: **1492/1492 pass, 0 fail** (from 1491/1492; 8 net new tests). `node tools/doc-lint.mjs && node tools/issue-index.mjs --check && node tools/adr-index.mjs --check`: clean at resolution.

### 6. Residual worth recording

The client has no row renderers for `message_agent`, `await_agent`, or `spawn_dispatcher` — `src/client/toolviews.ts:58-65` still claims the six historical keys and its `switch` (`:393-409`) falls back to the generic row for the new tools. This is the same lag already recorded on tickets 116 and 117, not a blocker.

**Honest gap left open (recorded, not a defect):** no scenario asserts the 120 s cap running to completion. A cap test costs two minutes per run and pins nothing a unit test does not already pin; the real release path exists and s4 proves it.

Bookkeeping: `**Status:**` → `resolved`; moved `Issue-tracker/open/120-mock-llm-e2e-messaging-await-mitosis.md` → `Issue-tracker/resolved/`; open index regenerated. No commit.
