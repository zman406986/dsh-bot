# 07 — Todo reconciler

**What to build:** The dispatcher's private ledger of what the user asked for. It reconciles on every wake, shows several streams running at once, and only says "completed" once the user actually has the result.

**Blocked by:** 06 — Wake bus + coalescing.

**Status:** ready-for-human

- [x] A todo entry is created before a spawn, and moves to `in_progress` when the worker starts.
- [x] Several items may be `in_progress` at the same time — one per live stream, plus at most one inline.
- [x] An item is marked `completed` only after the result has been delivered to the user, not merely when the worker exits.
- [x] Reconcile runs on every wake and reports the outstanding work: running, landed-but-undelivered, and next-to-dispatch.
- [x] An item whose worker aborted is closed as cancelled.
- [x] Stale items are pruned so the list stays usable; pure chat and trivial lookups create no entry.
- [x] Reconcile is a pure function of the wake event and the current todo state — the same inputs produce the same mutations.
- [x] A worker's own todo list stays empty; the user's ledger is never passed into a worker.

## Implementation notes

- `src/core/todo-reconciler.ts` — `TodoItem` / `TodoStatus` / `TodoMutation` / `ReconcileReport`, pure `reconcileTodos(input)`, and a stateful `createTodoLedger()` the core owns. Pure function takes wake + todos + roster snapshot (+ optional clock/thresholds); returns mutations and the three buckets without mutating inputs.
- Statuses: `pending | in_progress | completed | cancelled`. `completed` requires `delivered: true` (set by `markDelivered` after a successful user send — S4). `cancelled` is internal: dsh has no cancelled status, so cancel also emits a `prune` mutation (design-11 finding).
- Wiring in `createMultitask`: `createTodo` before spawn; `spawnWorker({ todoId })` structurally links the worker (ADR-0007); `noteTurnStarted` promotes pending → in_progress; `abortWorker` / aborted settle cancels + prunes the linked todo; `drainWake(sessionId)` drains the wake bus and applies reconcile in one step; `reconcileTodos(sessionId, wake?)` is available without draining.
- Report buckets: `running` (in_progress, live worker or inline), `landedUndelivered` (in_progress, terminal worker, not yet delivered), `nextToDispatch` (pending, no worker).
- Stale prune defaults: completed+delivered older than 1h; pending with no worker older than 1h. Thresholds and `nowMs` are injectable for tests.
- Workers never see the ledger: spawn prompt/opts carry no todo titles; `WorkerRecord` has only `todoId`; wake notices have no ledger payload. Spawn without `todoId` creates no entry (pure chat / trivial lookups).
- Exported from `src/index.ts`: `createTodoLedger`, `reconcileTodos`, and the todo/reconcile types.
- Tests: `test/todo-reconciler.test.ts` (18 new). Suite total 84 pass.
