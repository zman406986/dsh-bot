# 05 — Worker registry + `stream_key` uniqueness

**What to build:** The dispatcher's roster of live workers, and the rule that one stream has one worker. Two spawns for the same work item is the failure this ticket exists to prevent.

**Blocked by:** 04 — Stop semantics.

**Status:** ready-for-agent

- [ ] Every spawn produces a worker record carrying: worker id, parent session id, stream key, a short derived title, status, start time, transcript reference, and the linked todo id.
- [ ] Listing workers for a parent session returns the live roster with elapsed time, tool-call count, and transcript reference for each.
- [ ] A spawn for a `stream_key` that already has a running worker is refused; a second worker is never created for that stream.
- [ ] A `stream_key` becomes reusable once its worker reaches a terminal state.
- [ ] Two different `stream_key`s spawn and run independently — neither waits on the other.
- [ ] Records for terminal workers are queryable but no longer counted as running.