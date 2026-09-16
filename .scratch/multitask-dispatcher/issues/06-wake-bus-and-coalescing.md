# 06 — Wake bus + coalescing

**What to build:** How the dispatcher learns that something happened. A worker finishing while the dispatcher is mid-turn must not corrupt that turn; the dispatcher gets a turn of its own afterwards, and several finishes that pile up arrive as one.

**Blocked by:** 05 — Worker registry + `stream_key` uniqueness.

**Status:** ready-for-human

- [x] A settled worker enqueues exactly one wake for its parent session; settling twice does not enqueue a second.
- [x] Wakes route to the correct parent session — a settle never wakes a different dispatcher.
- [x] A worker that settles while the dispatcher is mid-turn is queued, never injected into the running turn.
- [x] Several settlements that pile up before the dispatcher's next turn are delivered as one batched wake.
- [x] A user wake preempts queued background wakes; background work never delays the user's own turn.
- [x] The wake carries, per settled worker: status, title, and result text.
- [x] The bus accepts `user`, `worker-settled`, `peer`, `timer`, and `external-event` as wake sources even though only the first two produce wakes at this stage.

## Implementation notes

- `src/core/wake-bus.ts` — per-session queue with mid-turn hold, pile-up batching, and user preemption. Idle sessions flush immediately; busy sessions flush on `noteTurnEnded`. A user wake reclaims any undelivered background batch back onto pending.
- `createMultitask` owns a wake bus; `onDeliver` calls `host.requestDispatcherWakeup`. The settle path enqueues through the bus instead of waking the host directly. Double/post-abort settles never reach the bus (FSM guard).
- `Multitask.wakeBus` exposes the bus so callers can note dispatcher turn bounds, drain wakes, and enqueue user wakes. Worker `noteTurnStarted(workerId)` is unchanged and distinct from the bus's session-level turn markers.
- `WakeEvent` carries `sessionId`, `source`, and `settledWorkers[]`; each notice has `workerId`, `status`, `title`, `resultText` (from `SettledEvent.report`).
- Peer/timer/external-event are in the source vocabulary and `WAKE_SOURCES` but have no enqueue API yet — later tickets add them without changing the type.
- Exported from `src/index.ts`: `createWakeBus`, `WAKE_SOURCES`, and the wake types.
- Tests: `test/wake-bus.test.ts` (17 new). Suite total 66 pass.
