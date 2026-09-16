# 02 — Worker lifecycle FSM

**What to build:** The worker's state machine. A worker is spawned, starts running, can be moved into steering and back, and ends in exactly one terminal state. Everything else in the core reads this state, so it comes first.

**Blocked by:** 01 — Plugin scaffold + `DshHost` seam + fake host.

**Status:** ready-for-human

- [x] A worker moves `spawned → running` when its first turn starts.
- [x] A running worker moves into `steering` when a steer is received and back to `running` when the steer is injected and work continues.
- [x] A worker reaches `completed`, `error`, or `aborted` and stays there; no transition leaves a terminal state.
- [x] A second settle for an already-terminal worker is ignored — no second wake, no overwritten status, no error thrown.
- [x] Stopping a worker while it is steering aborts it cleanly.
- [x] Tests assert observable behavior only (status a test can query plus the calls the fake host received), never FSM internals.

## Comments

2026-09-16 — Pure FSM in `src/core/worker-fsm.ts` (`canTransition` / `applyEvent`, no host). Wired through `createMultitask` as `noteTurnStarted` / `noteSteerReceived` / `noteSteerInjected`; settle and abort go through the same FSM so terminal states reject every further event. Illegal transitions (including double settle and post-abort settle) are ignored, not thrown. Abort marks `aborted` before interrupting so a racing settle cannot revive the worker. Tests: `test/worker-lifecycle-fsm.test.ts` (8 cases, behavior-only via `getWorker` + `FakeDshHost` records). Suite total 17 green. Next unblocked ticket: 03 (steer queue).