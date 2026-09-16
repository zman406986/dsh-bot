# 07 — Todo reconciler

**What to build:** The dispatcher's private ledger of what the user asked for. It reconciles on every wake, shows several streams running at once, and only says "completed" once the user actually has the result.

**Blocked by:** 06 — Wake bus + coalescing.

**Status:** ready-for-agent

- [ ] A todo entry is created before a spawn, and moves to `in_progress` when the worker starts.
- [ ] Several items may be `in_progress` at the same time — one per live stream, plus at most one inline.
- [ ] An item is marked `completed` only after the result has been delivered to the user, not merely when the worker exits.
- [ ] Reconcile runs on every wake and reports the outstanding work: running, landed-but-undelivered, and next-to-dispatch.
- [ ] An item whose worker aborted is closed as cancelled.
- [ ] Stale items are pruned so the list stays usable; pure chat and trivial lookups create no entry.
- [ ] Reconcile is a pure function of the wake event and the current todo state — the same inputs produce the same mutations.
- [ ] A worker's own todo list stays empty; the user's ledger is never passed into a worker.