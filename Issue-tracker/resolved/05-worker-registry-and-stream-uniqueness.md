# 05 鈥?Worker registry + `stream_key` uniqueness

**What to build:** The dispatcher's roster of live workers, and the rule that one stream has one worker. Two spawns for the same work item is the failure this ticket exists to prevent.

**Blocked by:** 04 鈥?Stop semantics.

**Status:** resolved

- [x] Every spawn produces a worker record carrying: worker id, parent session id, stream key, a short derived title, status, start time, transcript reference, and the linked todo id.
- [x] Listing workers for a parent session returns the live roster with elapsed time, tool-call count, and transcript reference for each.
- [x] A spawn for a `stream_key` that already has a running worker is refused; a second worker is never created for that stream.
- [x] A `stream_key` becomes reusable once its worker reaches a terminal state.
- [x] Two different `stream_key`s spawn and run independently 鈥?neither waits on the other.
- [x] Records for terminal workers are queryable but no longer counted as running.

## Implementation notes

- `spawnWorker` now returns `SpawnResult` (`ok: true` + workerId, or `ok: false` + `duplicate-stream-key`). Refusal never calls the host.
- `WorkerRecord` gained `toolCallCount`; `SpawnRequest` gained optional `todoId`; `SettledEvent` gained optional `transcriptRef` (written onto the record on settle).
- `listWorkers` returns `WorkerSummary[]` 鈥?record fields plus `elapsedMs` computed at list time.
- `noteToolCall(workerId)` increments the count; unknown workers are a no-op.
- Stream-key uniqueness is tracked via an internal `liveByStreamKey` map; any terminal transition (settle, abort) frees the key.
- Tests: `test/worker-registry.test.ts` (13 new). Existing spawn call sites updated for `SpawnResult`.

## Comments

- Moved to resolved by overnight sweep 2026-09-18: all ACs checked; verified via implementing commits and artifact spot-check on main.
