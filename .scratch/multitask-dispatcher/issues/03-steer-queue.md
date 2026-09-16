# 03 — Steer queue

**What to build:** Mid-run correction. The dispatcher injects a message into a worker that is already working; the worker folds it in and continues from where it is, without restarting and without losing what it has already done.

**Blocked by:** 02 — Worker lifecycle FSM.

**Status:** ready-for-agent

- [ ] A steer sent to a running worker is delivered into that worker and its context is preserved — the worker does not restart from zero.
- [ ] Sending a steer interrupts the worker's current step and work resumes at the next step boundary with the steer folded in.
- [ ] The queue holds one steer per worker: a second steer before the first is delivered replaces it, and the earlier one is never delivered.
- [ ] Popping from an empty queue yields nothing rather than throwing.
- [ ] A steer sent to a worker that is not running is refused, the refusal says the worker may already be done, and no replacement worker is silently created.
- [ ] A delivered steer is wrapped in a short note identifying it as a correction from the parent and directing the worker to incorporate it and continue rather than restart.