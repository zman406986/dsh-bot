# 197 - Delivery-redrive wake spends the retry budget twice

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P1 / high
**Ship blocker:** yes. A normal recovery chain can consume both persisted redrive attempts before it has composed the second redrive turn. The following activation can then mark an undelivered completed result lost and compose no result-specific recovery notice, so the bounded-delivery contract can drop owed work before its real retry budget is used.

## Requirement

A settled result that was not delivered must retain its result-specific recovery notice until delivery or actual exhaustion of the persisted redrive budget. Each redrive opens a dispatcher turn and spends one attempt; the settle wake is the first opportunity, not a redrive ([resolved ticket 58](../resolved/58-delivery-obligation-bound-lost-telemetry.md#L66), [PRD section 7.4](../../PRD-dsh-multitask-dispatcher.md#L244)).

## Problem and evidence

The activation recovery path calls `redriveUndelivered` once ([src/plugin.ts:1600](../../src/plugin.ts#L1600); shipped [lib/plugin.js:1284](../../lib/plugin.js#L1284)). That method reconciles an empty wake, applies the attempt increment, persists it to the worker marker, then enqueues a delivery-redrive wake ([src/core/multitask.ts:1854](../../src/core/multitask.ts#L1854), [1892](../../src/core/multitask.ts#L1892), [1911](../../src/core/multitask.ts#L1911); shipped [lib/core/multitask.js:1200](../../lib/core/multitask.js#L1200), [1239](../../lib/core/multitask.js#L1239), [1251](../../lib/core/multitask.js#L1251)).

When that wake is composed, `composeWakeText` drains it ([src/plugin.ts:565](../../src/plugin.ts#L565); shipped [lib/plugin.js:369](../../lib/plugin.js#L369)). `drainWake` runs the reconciler again and applies its mutations ([src/core/multitask.ts:1845](../../src/core/multitask.ts#L1845); shipped [lib/core/multitask.js:1191](../../lib/core/multitask.js#L1191)). The reconciler exempts only the worker's own settle wake (`settledNow` at [src/core/todo-reconciler.ts:320](../../src/core/todo-reconciler.ts#L320), exemption at [334](../../src/core/todo-reconciler.ts#L334)); a delivery-redrive wake has no settle notice, so this second pass increments the same todo again or marks it lost at the bound ([335](../../src/core/todo-reconciler.ts#L335), [346](../../src/core/todo-reconciler.ts#L346); shipped [lib/core/todo-reconciler.js:131](../../lib/core/todo-reconciler.js#L131), [143](../../lib/core/todo-reconciler.js#L143), [145](../../lib/core/todo-reconciler.js#L145)).

The drain pass updates the in-memory todo ledger but does not persist that second increment to the worker marker. `composeWakeText` builds restored notices only from settled notices or `landedUndelivered` todos ([src/plugin.ts:595](../../src/plugin.ts#L595), [596](../../src/plugin.ts#L596)); once reconciliation has marked the item lost, the no-notice path returns `null` ([src/plugin.ts:629](../../src/plugin.ts#L629); shipped [lib/plugin.js:391](../../lib/plugin.js#L391), [424](../../lib/plugin.js#L424)).

## Impact

The persisted lifetime budget is spent faster than the number of redrive turns actually opened. On the reproduced restart path, reconciliation reaches lost before the recovered result is composed, removing the result-specific notice and transcript pointer from this recovery wake. This violates the completion-delivery contract (PRD S4) and is a ship blocker because an ordinary missed delivery followed by restart can permanently retire completed work without presenting its recovery material.

This finding does not claim that every subsequent model turn is impossible: the adapter can still issue its generic settle-wake cue when composed text is null ([src/adapter/cordis-dsh-host.ts:1935](../../src/adapter/cordis-dsh-host.ts#L1935)). The defect is the premature loss of the result-specific recovery material and delivery obligation.

## Deterministic reproduction

Run as an inline Node ESM script from the repository root. It uses only shipped `lib/` modules and in-memory state; it creates no files:

```js
import assert from "node:assert/strict";
import { createInMemoryDurability } from "./lib/core/durability.js";
import { FakeDshHost } from "./lib/core/fake-host.js";
import { createMultitask } from "./lib/core/multitask.js";
import { composeWakeText } from "./lib/plugin.js";

const sessionId = "ticket-197-session";
const durability = createInMemoryDurability();
const hostA = new FakeDshHost();
const coreA = createMultitask(hostA, { durability });
coreA.createTodo({ sessionId, id: "todo-1", title: "Research" });
const spawned = await coreA.spawnWorker({
  parentSessionId: sessionId,
  streamKey: "stream-1",
  title: "Research",
  prompt: "go",
  todoId: "todo-1",
});
if (!spawned.ok) throw new Error("worker spawn failed");
hostA.fireSettled({
  workerId: spawned.workerId,
  status: "completed",
  report: "result",
  transcriptRef: "worker-transcript",
});
coreA.drainWake(sessionId);
coreA.redriveUndelivered(sessionId);
coreA.drainWake(sessionId);
assert.equal(coreA.todos.get("todo-1")?.redriveAttempts, 2);
assert.equal(durability.markers.get(spawned.workerId)?.redriveAttempts, 1);

const hostB = new FakeDshHost();
const recovered = createMultitask(hostB, { durability });
await recovered.rebuildFromDurability(sessionId);
recovered.redriveUndelivered(sessionId);
const wakeText = composeWakeText(recovered, sessionId);
assert.notEqual(wakeText, null, "the recovery wake must retain the result notice");
```

**Observed:** after the first core's second drain, the in-memory todo has `redriveAttempts: 2` while its durable marker has `redriveAttempts: 1`. After rebuilding, redriving, and composing, the todo is lost and `wakeText` is `null`; the final assertion fails (exit 1).

## Duplicate check

Ticket number 197 was checked unused in `open/`, `deferred/`, `resolved/`, and `cancelled/` immediately before creation. Title/root-cause searches covered all four status directories.

- [Resolved 58](../resolved/58-delivery-obligation-bound-lost-telemetry.md#L66) establishes the persisted bound and that each redrive opens a turn; this ticket is not a request to change that policy. It identifies the two separate recovery opportunities, while this finding is that one queued redrive turn is reconciled a second time.
- [Resolved 90](../resolved/90-restart-honesty-carried-verifier-findings.md#L58) records a separate stale activation chain that could invoke redrive twice for one activation; its generation guard fixed that duplicate activation path ([line 108](../resolved/90-restart-honesty-carried-verifier-findings.md#L108)). This finding occurs inside one valid activation chain when its own queued wake is drained.

## Acceptance criteria

- [ ] A redrive attempt is charged exactly once for its opened delivery-redrive turn; draining that turn does not independently spend another attempt.
- [ ] After a redrive and its wake drain, the todo's attempt count and durable marker agree, including after rebuilding from durability.
- [ ] A restored settled result below the configured attempt bound composes a non-null result-specific wake with the transcript pointer; it is not marked lost before the actual delivery opportunities are exhausted.
- [ ] The existing configured lifetime bound still reaches lost with its reason after the allowed number of actual redrive opportunities, across restart.

## Validation limits

The audit reports the shipped-`lib/` offline probe above and four adjacent controls passing (4/4, about 180 ms) with:

```
node --import tsx --test --test-reporter spec --test-name-pattern "writes, reads by parent, and deletes markers|dispose waits for an in-flight write|attempts persist on the marker and survive a restart|undelivered completed result finishes delivery" test/adapter-durable-marker.test.ts test/delivery-obligation.test.ts test/durable-roster.test.ts
```

This ticket-writing step did not rerun the probe or tests. No live host, physical crash, network, full suite, or build was checked.

## Resolution - 2026-11-08

A wake drained after a redrive attempt is already paid is marked, mapped to `ReconcileInput.redriveTurn`, and exempt from the extra charge and loss while still reporting in `landedUndelivered`; commit `6f8e5b3`; `test/delivery-obligation.test.ts` 16/16.
