# 04 — Stop semantics

**What to build:** Cancelling a stream cleanly. Stop takes a worker out of play for good — nothing about it arrives afterwards — and the cancellation itself is silent in the conversation.

**Blocked by:** 03 — Steer queue.

**Status:** ready-for-human

- [x] Stopping a running worker aborts it and returns a plain confirmation to the caller; no user-facing message is sent by the stop path.
- [x] Stopping disarms the completion wake that was armed at spawn, so the worker's finish never wakes the dispatcher.
- [x] Stopping clears any parked steer for that worker; nothing is kept for a later revival.
- [x] A result that settles after a stop has taken effect is dropped: no delivery, no wake, no revived work.
- [x] The stop flag wins even if the stop path still produces a completion — a late settle on a stopped worker changes nothing observable.
- [x] A stop arriving for a worker that has already settled is refused, the refusal notes the worker may already be done, and any completion already queued is delivered normally.
- [x] Tests cover the boundary both ways: settled before stop delivers; settles after stop drops.

## Implementation notes

2026-09-16 — `Multitask.abortWorker` now returns a `StopResult` (`ok: true` confirmation, or refusal with `reason: "already-settled"` and detail that the worker may already be done). On a successful stop the core transitions to `aborted`, calls `steerQueue.clear(workerId)` (per ticket 03's note — the queue lives inside `createMultitask`), then interrupts through the host; the stop path never calls `sendMessage` and never requests a wake. Terminal workers (already settled or previously stopped) are refused without a second interrupt, and an already-delivered completion wake is left intact. Late settles after stop are dropped by the existing terminal FSM gate — no delivery, no wake, no status change. Unknown workers still throw (unchanged). Tests: `test/stop-semantics.test.ts` (9 cases via FakeDshHost records only). Suite total 36 green.