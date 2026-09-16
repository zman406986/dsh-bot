# 08 鈥?Durable roster marker + restart behavior

**What to build:** Surviving a crash honestly. If the process restarts while a worker was in flight, the dispatcher must still be able to answer "what happened to my task?" 鈥?either by finishing a delivery the user never got, or by saying plainly that the worker's state is unknown and where its transcript is.

**Blocked by:** 07 鈥?Todo reconciler.

**Status:** open

- [x] At spawn, a small durable marker is written carrying the minimum needed to rebuild the roster across a restart: worker id, transcript pointer, todo link, and status.
- [x] The marker is written through the host's durable session/storage facility; no second transcript database is introduced.
- [x] After a simulated restart, a worker whose result landed but was never delivered is noticed from its marker and produces a reconcile action that finishes delivery.
- [x] A worker that cannot be reconstructed is reported as unknown-state with a pointer to its transcript 鈥?it is never replayed, resumed, or invented.
- [x] Steer state is not durable: after a restart, no steer is loaded or re-delivered.
- [x] Tests simulate a restart by discarding the in-memory core and re-creating it against persisted state only.

## Implementation notes

- `DurabilityPort` + `DurableWorkerMarker` live in `src/core/durability.ts` (ADR-0006 minimum-to-reconstruct). Core takes the port optionally via `createMultitask(host, { durability })` 鈥?existing FakeDshHost tests stay green with no durability.
- Write cadence: await write at spawn; update on settle (completed/error + `transcriptRef`); delete on abort and after `markDelivered`. Live turn-started statuses are not rewritten (last snapshot is `spawned` until settle).
- `rebuildFromDurability(parentSessionId)` restores terminal markers onto the roster and recreates the linked in-progress todo so `reconcileTodos` reports `landedUndelivered` (S4). Live markers become `UnknownStateWorker` (transcript pointer = marker value or worker id); stream keys stay free for re-dispatch; no host spawn/interrupt/message.
- Marker carries no report body 鈥?result text stays in dsh's transcript. No second transcript DB.
- Ticket 09 owns the live `storageDomain` backend behind `DurabilityPort` (design-09 搂8); keep this interface.
