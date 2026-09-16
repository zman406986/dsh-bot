# 08 — Durable roster marker + restart behavior

**What to build:** Surviving a crash honestly. If the process restarts while a worker was in flight, the dispatcher must still be able to answer "what happened to my task?" — either by finishing a delivery the user never got, or by saying plainly that the worker's state is unknown and where its transcript is.

**Blocked by:** 07 — Todo reconciler.

**Status:** ready-for-agent

- [ ] At spawn, a small durable marker is written carrying the minimum needed to rebuild the roster across a restart: worker id, transcript pointer, todo link, and status.
- [ ] The marker is written through the host's durable session/storage facility; no second transcript database is introduced.
- [ ] After a simulated restart, a worker whose result landed but was never delivered is noticed from its marker and produces a reconcile action that finishes delivery.
- [ ] A worker that cannot be reconstructed is reported as unknown-state with a pointer to its transcript — it is never replayed, resumed, or invented.
- [ ] Steer state is not durable: after a restart, no steer is loaded or re-delivered.
- [ ] Tests simulate a restart by discarding the in-memory core and re-creating it against persisted state only.