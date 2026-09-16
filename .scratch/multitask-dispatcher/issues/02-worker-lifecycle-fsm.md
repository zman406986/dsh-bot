# 02 — Worker lifecycle FSM

**What to build:** The worker's state machine. A worker is spawned, starts running, can be moved into steering and back, and ends in exactly one terminal state. Everything else in the core reads this state, so it comes first.

**Blocked by:** 01 — Plugin scaffold + `DshHost` seam + fake host.

**Status:** ready-for-agent

- [ ] A worker moves `spawned → running` when its first turn starts.
- [ ] A running worker moves into `steering` when a steer is received and back to `running` when the steer is injected and work continues.
- [ ] A worker reaches `completed`, `error`, or `aborted` and stays there; no transition leaves a terminal state.
- [ ] A second settle for an already-terminal worker is ignored — no second wake, no overwritten status, no error thrown.
- [ ] Stopping a worker while it is steering aborts it cleanly.
- [ ] Tests assert observable behavior only (status a test can query plus the calls the fake host received), never FSM internals.