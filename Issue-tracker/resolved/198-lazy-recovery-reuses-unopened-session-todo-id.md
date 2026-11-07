# 198 — Lazy recovery reuses an unopened session's durable todo ID

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P1 / high
**Ship blocker:** yes — a valid per-session recovery order can alias a completed worker's durable todo link to another session's newly created todo. The owning session then has no ledger obligation to redrive or deliver that result, violating the shipped S4 recovery contract.

## Requirement

A durable worker record must retain its todo link across restart so the dispatcher can find and finish delivery of an undelivered result ([ADR-0006:5](../../docs/adr/0006-worker-record-durability-split.md#L5), [ADR-0006:25](../../docs/adr/0006-worker-record-durability-split.md#L25)). The todo remains in its owning dispatcher's ledger, and the worker-to-todo association is structural ([ADR-0007:5](../../docs/adr/0007-todo-stays-dispatcher-only-with-structural-worker-link.md#L5), [ADR-0007:30](../../docs/adr/0007-todo-stays-dispatcher-only-with-structural-worker-link.md#L30)).

## Problem and evidence

Todo IDs are generated from a process-local counter in a map keyed only by ID: [src/core/todo-reconciler.ts:543](../../src/core/todo-reconciler.ts#L543), [line 545](../../src/core/todo-reconciler.ts#L545). Restoring an explicit `todo-N` advances that counter only when that row is loaded ([lines 578-584](../../src/core/todo-reconciler.ts#L578)); a new ID is otherwise allocated directly from the counter.

Recovery is lazy and parent-scoped: [`rebuildFromDurability(parentSessionId)`](../../src/core/multitask.ts#L1931) reads markers for that one parent ([lines 1939-1942](../../src/core/multitask.ts#L1939)). Activation starts recovery for the activated session ([src/plugin.ts:1659](../../src/plugin.ts#L1659)). The production spawn path creates a todo before spawning when no explicit todo ID was supplied ([src/core/tools.ts:890](../../src/core/tools.ts#L890)). Thus, IDs belonging to a not-yet-recovered sibling session are not reserved when the first session creates a new todo.

When the second session is recovered, `restoreLedgerLink` returns if any ledger row already has the marker's ID, without checking its owner ([src/core/multitask.ts:896-910](../../src/core/multitask.ts#L896)). The terminal-marker recovery path calls it for non-aborted workers ([lines 2051-2063](../../src/core/multitask.ts#L2051)). The shipped modules have the same behavior: the generated sequence starts at 1 and explicit IDs advance it only on loaded rows ([lib/core/todo-reconciler.js:245](../../lib/core/todo-reconciler.js#L245), [lines 269-275](../../lib/core/todo-reconciler.js#L269)); the restore helper returns on any existing ID ([lib/core/multitask.js:309-317](../../lib/core/multitask.js#L309)).

## Deterministic reproduction

The prior audit confirmed this against shipped lib modules using `createInMemoryDurability`, `FakeDshHost`, `createMultitask`, and `composeWakeText`; the store is memory-only and no files are involved. The probe observations and 4/4 adjacent-control results below were supplied by that audit and were not rerun during ticket filing:

1. In one core, create parent A's todo-1, spawn A's worker linked to it, and settle that worker completed while leaving delivery undelivered so A's worker marker preserves todo-1. Then create parent B's todo-2, spawn B's worker linked to it, and settle that worker completed with delivery still undelivered. Dispose the core with both durable worker markers retained.
2. Recreate the core using the same memory store. Rebuild only A, then create a new todo for A. It receives todo-2 because B's marker has not been loaded.
3. Rebuild B and call `redriveUndelivered(B)`. B's restored worker still points to todo-2, but the ledger row with that ID belongs to A, so B's link and redrive are lost.

Observed output:

```text
oldA=todo-1
oldB=todo-2
newA=todo-2
ownerOfRestoredTodo=A
restoredBWorkerTodo=todo-2
bTodos=0
bRedrives=0
```

The assertion `ownerOfRestoredTodo === "B"` fails. The delivery tool's ownership fence rejects B delivering against A's row ([src/core/tools.ts:1230-1239](../../src/core/tools.ts#L1230)).

Adjacent control tests passed during the audit (4/4, about 180 ms):

```sh
node --import tsx --test --test-reporter spec --test-name-pattern "writes, reads by parent, and deletes markers|dispose waits for an in-flight write|attempts persist on the marker and survive a restart|undelivered completed result finishes delivery" test/adapter-durable-marker.test.ts test/delivery-obligation.test.ts test/durable-roster.test.ts
```

No live host, physical crash, network, full suite, or build was checked.

## Impact

A completed worker in B silently loses its own todo linkage and is not redriven after recovery; its result can remain undelivered while the colliding todo belongs to A. The session ownership check then refuses B's delivery request. This breaks S4 on the durable recovery path, not merely the displayed todo state, and can permanently strand completed work. That makes this a release blocker until cross-session IDs cannot alias and restore preserves the link only to its owning session.

## Duplicate check

Checked ticket IDs and searched issue bodies across open, deferred, resolved, and cancelled: 198 is unused, and no duplicate of this finding was found. Resolved [151:67](../resolved/151-dispatcher-todo-ledger-never-written.md#L67) fixes the same-session case where restoring todo-1 must advance the next generated ID to todo-2; it does not reserve IDs belonging to a sibling session whose marker is not yet loaded. Open [190:14-23](190-cold-resume-drops-worker-running-edge.md#L14) concerns losing a resumed worker's running-state event, not todo-ID ownership or result redrive. Resolved 145's cross-session ID refusal is for the separate Racoons recall ledger, not dispatcher todos ([145:51](../resolved/145-racoons-redo-latest-full-coverage.md#L51)).

## Acceptance criteria

- [ ] Rebuilding one parent and creating new todos cannot allocate IDs present in durable markers for another, not-yet-rebuilt parent.
- [ ] Restoring a worker whose todo ID already exists under a different session does not accept or silently reuse that row; the owning session's todo link and undelivered result remain recoverable.
- [ ] A deterministic memory-only regression test covers the A-then-B recovery order above, asserts globally non-aliasing IDs, and verifies B's completed result is redriven and deliverable only against B's ledger row.
- [ ] Existing same-session restore behavior covered by ticket 151 and the adjacent durable-marker / delivery-obligation controls remain passing.

## Resolution - 2026-11-08

Fixed in `43e7c08`: durable marker ids are reserved before a rebuild, an existing row is accepted only for the restoring session, and a foreign id is relinked to a fresh one with the marker corrected; `test/durable-roster.test.ts` passes 17/17.
