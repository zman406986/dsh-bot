import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryDurability } from "../src/core/durability.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";

/**
 * Lane B — one worker completion, one parent-visible notice.
 *
 * The stock completion notice (source kind `subagent-settled`, delivered by
 * the host to the parent, `delivery: "parent"`) is that notice. The plugin no
 * longer opens a settle wake turn, which was the duplicate.
 *
 * This fake host cannot emit the stock notice itself (it only records
 * `requestDispatcherWakeup`), so the stock half is pinned where the activation
 * spec is built: `test/adapter-cordis-dsh-host.test.ts` asserts
 * `spec.delivery === "parent"`. Here we pin the plugin half — zero wake turns
 * — plus the settle record, durable obligation, and todo behavior that must
 * not change.
 */
describe("one completion, one parent-visible notice (no duplicate settle wake)", () => {
  it("a settle opens no plugin wake and leaves the record, marker, and todo intact", async () => {
    const host = new FakeDshHost();
    const durability = createInMemoryDurability();
    const multitask = createMultitask(host, { durability });
    multitask.createTodo({ sessionId: "s-1", id: "todo-1", title: "One job" });
    const spawned = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k-1",
      title: "One job",
      prompt: "go",
      todoId: "todo-1",
    });
    assert.ok(spawned.ok);
    const workerId = spawned.workerId;
    multitask.noteTurnStarted(workerId);

    host.fireSettled({ workerId, status: "completed", report: "the result" });

    // Zero plugin wake turns: no host wake, nothing ready or pending, and a
    // drain has nothing to hand the dispatcher.
    assert.deepEqual(host.wakeCalls, [], "the settle opens no plugin turn");
    assert.equal(multitask.wakeBus.peek("s-1"), undefined);
    assert.equal(multitask.wakeBus.peekPending("s-1"), undefined);
    assert.equal(multitask.drainWake("s-1"), undefined);

    // Settle record still written, before any delivery attempt (ticket 115).
    const record = multitask.settleRecords.lookup("s-1", workerId);
    assert.ok(record);
    assert.equal(record.status, "completed");
    assert.equal(record.resultText, "the result");

    // Durable obligation marker still written (the result is still owed).
    const marker = durability.markers.get(workerId);
    assert.ok(marker, "the undelivered obligation is durable");
    assert.equal(marker.todoId, "todo-1");

    // Todo behavior unchanged: still open, not delivered, no redrive spent.
    const todo = multitask.todos.get("todo-1");
    assert.ok(todo);
    assert.equal(todo.status, "in_progress");
    assert.equal(todo.delivered, false);
    assert.equal(todo.redriveAttempts, 0);
    // Roster terminal status is unchanged.
    assert.equal(multitask.getWorker(workerId)?.status, "completed");

    // The bounded delivery lane still owns missed delivery: the first turn
    // end opens exactly one redrive wake. It is not a settle wake.
    const redrive = multitask.redriveUndelivered("s-1");
    assert.equal(redrive.redriven.length, 1);
    assert.equal(host.wakeCalls.length, 1, "only the redrive opens a turn");
    assert.equal(multitask.todos.get("todo-1")?.redriveAttempts, 1);

    // deliver_result closes the obligation; no wake remains to present.
    assert.equal(multitask.markDelivered("todo-1"), true);
    assert.equal(multitask.todos.get("todo-1")?.status, "completed");
    assert.equal(multitask.drainWake("s-1"), undefined);
    assert.equal(host.wakeCalls.length, 1, "delivery opens no further turn");
  });
});
