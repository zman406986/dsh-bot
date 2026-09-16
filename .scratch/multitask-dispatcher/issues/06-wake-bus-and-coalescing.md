# 06 — Wake bus + coalescing

**What to build:** How the dispatcher learns that something happened. A worker finishing while the dispatcher is mid-turn must not corrupt that turn; the dispatcher gets a turn of its own afterwards, and several finishes that pile up arrive as one.

**Blocked by:** 05 — Worker registry + `stream_key` uniqueness.

**Status:** ready-for-agent

- [ ] A settled worker enqueues exactly one wake for its parent session; settling twice does not enqueue a second.
- [ ] Wakes route to the correct parent session — a settle never wakes a different dispatcher.
- [ ] A worker that settles while the dispatcher is mid-turn is queued, never injected into the running turn.
- [ ] Several settlements that pile up before the dispatcher's next turn are delivered as one batched wake.
- [ ] A user wake preempts queued background wakes; background work never delays the user's own turn.
- [ ] The wake carries, per settled worker: status, title, and result text.
- [ ] The bus accepts `user`, `worker-settled`, `peer`, `timer`, and `external-event` as wake sources even though only the first two produce wakes at this stage.