# 03 — Steer queue

**What to build:** Mid-run correction. The dispatcher injects a message into a worker that is already working; the worker folds it in and continues from where it is, without restarting and without losing what it has already done.

**Blocked by:** 02 — Worker lifecycle FSM.

**Status:** ready-for-human

- [x] A steer sent to a running worker is delivered into that worker and its context is preserved — the worker does not restart from zero.
- [x] Sending a steer interrupts the worker's current step and work resumes at the next step boundary with the steer folded in.
- [x] The queue holds one steer per worker: a second steer before the first is delivered replaces it, and the earlier one is never delivered.
- [x] Popping from an empty queue yields nothing rather than throwing.
- [x] A steer sent to a worker that is not running is refused, the refusal says the worker may already be done, and no replacement worker is silently created.
- [x] A delivered steer is wrapped in a short note identifying it as a correction from the parent and directing the worker to incorporate it and continue rather than restart.

## Implementation notes

2026-09-16 — Pure single-slot last-wins `SteerQueue` in `src/core/steer-queue.ts` (`park`/`pop`/`clear`/`peek`) plus `wrapParentCorrection` (new copy). `DshHost` gains `sendMessage` and `onStepBoundary`; `FakeDshHost` records `sendMessageCalls` and exposes `fireStepBoundary`. `Multitask.steerWorker` parks the steer (replace if already steering), drives `running → steering`, and interrupts the current step; on step boundary the core pops the latest steer, wraps it, delivers via `sendMessage`, and returns to `running`. Refusals (`unknown-worker` / `not-running`) never recreate a worker and the not-running detail says the worker may already be done. Tests: `test/steer-queue.test.ts` (10 cases — queue unit + multitask delivery via FakeDshHost records). Suite total 27 green. Next unblocked ticket: 04 (stop semantics).