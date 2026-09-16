# 04 — Stop semantics

**What to build:** Cancelling a stream cleanly. Stop takes a worker out of play for good — nothing about it arrives afterwards — and the cancellation itself is silent in the conversation.

**Blocked by:** 03 — Steer queue.

**Status:** ready-for-agent

- [ ] Stopping a running worker aborts it and returns a plain confirmation to the caller; no user-facing message is sent by the stop path.
- [ ] Stopping disarms the completion wake that was armed at spawn, so the worker's finish never wakes the dispatcher.
- [ ] Stopping clears any parked steer for that worker; nothing is kept for a later revival.
- [ ] A result that settles after a stop has taken effect is dropped: no delivery, no wake, no revived work.
- [ ] The stop flag wins even if the stop path still produces a completion — a late settle on a stopped worker changes nothing observable.
- [ ] A stop arriving for a worker that has already settled is refused, the refusal notes the worker may already be done, and any completion already queued is delivered normally.
- [ ] Tests cover the boundary both ways: settled before stop delivers; settles after stop drops.