import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInMemoryDurability,
  type InMemoryDurability,
} from "../src/core/durability.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import { formatLedgerLine } from "../src/core/policy/assembler.js";
import {
  MAX_DELIVERY_REDRIVES,
  reconcileTodos,
  type TodoItem,
} from "../src/core/todo-reconciler.js";
import type { WakeEvent } from "../src/core/wake-bus.js";

/**
 * Ticket 58 — the delivery-obligation layer (register deviations D-5, D-6).
 *
 * The defect this suite exists for: an `in_progress && !delivered` item whose
 * worker had settled persisted forever, was never escalated, and was never
 * reported as stuck. Every test here asserts a *bounded* outcome — redriven or
 * `lost` — plus the telemetry that makes either one explicable.
 */

const SESSION = "s-1";

function emptyWake(sessionId = SESSION): WakeEvent {
  return {
    sessionId,
    source: "timer",
    settledWorkers: [],
  };
}

/** Create a todo and spawn a worker linked to it in one step. */
async function spawnForTodo(
  multitask: Multitask,
  host: FakeDshHost,
  todoId = "todo-1",
  streamKey = "stream-1",
): Promise<string> {
  multitask.createTodo({ sessionId: SESSION, id: todoId, title: "Research" });
  const result = await multitask.spawnWorker({
    parentSessionId: SESSION,
    streamKey,
    title: "Research",
    prompt: "go",
    todoId,
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  return result.workerId;
}

/** Take the item from settle to "still undelivered after its first chance". */
function settleUndelivered(host: FakeDshHost, workerId: string): void {
  host.fireSettled({ workerId, status: "completed", report: "done" });
}

function todoOf(multitask: Multitask, todoId = "todo-1"): TodoItem {
  const todo = multitask.todos.get(todoId);
  assert.ok(todo, `todo ${todoId} should exist`);
  return todo;
}

describe("delivery obligation — the settle wake is the first chance (D-5)", () => {
  it("draining a settle wake redrives nothing: that wake IS the delivery opportunity", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);

    settleUndelivered(host, workerId);
    const drained = multitask.drainWake(SESSION);
    assert.ok(drained, "the settle produced a wake");

    // The worker that settled in this very wake must not be treated as a
    // missed delivery — otherwise the happy path would silently spend part of
    // the retry budget and the bound would mean something weaker than it says.
    assert.equal(
      drained.reconcile.toRedrive.length,
      0,
      "a first-chance settle is not a redrive",
    );
    assert.equal(
      drained.reconcile.mutations.some((m) => m.type === "record-redrive"),
      false,
      "no attempt is spent on the settle that carries the result",
    );
    assert.equal(
      drained.reconcile.landedUndelivered.length,
      1,
      "it is still owed, and visible as owed",
    );
    assert.equal(todoOf(multitask).redriveAttempts, 0);
  });
});

describe("delivery obligation — bounded redrive opens a turn (D-5)", () => {
  it("a missed delivery costs one attempt and wakes the dispatcher", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);
    multitask.drainWake(SESSION);

    const wakesBefore = host.wakeCalls.length;
    const report = multitask.redriveUndelivered(SESSION);

    assert.equal(report.redriven.length, 1);
    assert.equal(report.lost.length, 0);
    assert.equal(todoOf(multitask).redriveAttempts, 1);
    // The delivery mechanism must be the waking primitive: queueing context
    // would repeat D-4, where the notice waited for a user who never spoke.
    assert.equal(
      host.wakeCalls.length,
      wakesBefore + 1,
      "the redrive opens a turn",
    );
    assert.equal(host.wakeCalls.at(-1), SESSION);
  });

  it("is a cheap no-op when nothing is owed", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);
    multitask.drainWake(SESSION);
    multitask.markDelivered("todo-1");

    const wakesBefore = host.wakeCalls.length;
    const report = multitask.redriveUndelivered(SESSION);

    assert.deepEqual(report.redriven, []);
    assert.deepEqual(report.lost, []);
    assert.equal(
      host.wakeCalls.length,
      wakesBefore,
      "a delivered result is never redriven",
    );
    // And a delivered item is not silently re-opened by the pass either.
    assert.equal(todoOf(multitask).status, "completed");
  });
});

describe("delivery obligation — the bound is terminal (D-5)", () => {
  it("exhausting the budget escalates to `lost`, which is NOT `completed`", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);
    multitask.drainWake(SESSION);

    // Spend the budget. Each pass that still finds the result undelivered
    // costs one attempt; the pass that finds the budget exhausted escalates.
    for (let attempt = 1; attempt <= MAX_DELIVERY_REDRIVES; attempt += 1) {
      const report = multitask.redriveUndelivered(SESSION);
      assert.equal(report.lost.length, 0, `attempt ${attempt} is inside the bound`);
      assert.equal(todoOf(multitask).redriveAttempts, attempt);
    }

    const wakesBefore = host.wakeCalls.length;
    const final = multitask.redriveUndelivered(SESSION);
    const todo = todoOf(multitask);

    assert.equal(final.redriven.length, 0, "past the bound there is no retry");
    assert.equal(final.lost.length, 1);
    assert.equal(todo.status, "lost");
    assert.equal(todo.delivered, false, "lost is NOT delivered");
    assert.equal(todo.disposition, "dropped");
    assert.equal(todo.dispositionReason, "max-redrives");
    // Deliberate: a pure escalation does not open another turn. The
    // dispatcher has already been given every attempt the bound allows, and
    // the loss rides the next turn's ledger line instead.
    assert.equal(host.wakeCalls.length, wakesBefore, "no wake for a pure loss");

    // Reportable, and distinguishable from a completed item on the reminder.
    const line = formatLedgerLine(todo);
    assert.ok(line.includes("lost"), line);
    assert.ok(line.includes("max-redrives"), line);
  });

  it("records a dropped disposition event so the loss is explicable", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host, { maxRedrives: 0 });
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);
    multitask.drainWake(SESSION);

    const report = multitask.redriveUndelivered(SESSION);
    assert.equal(report.lost.length, 1, "maxRedrives 0 escalates immediately");

    const events = multitask.todos.listDeliveryEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.disposition, "dropped");
    assert.equal(events[0]?.reason, "max-redrives");
    assert.equal(events[0]?.todoId, "todo-1");
  });

  it("a `lost` item is retired after retention — escalation must not just replace one unbounded row with another", () => {
    const todos = [
      {
        id: "gone",
        sessionId: SESSION,
        title: "Lost work",
        status: "lost" as const,
        streamKey: "k",
        workerId: "w1",
        delivered: false,
        redriveAttempts: MAX_DELIVERY_REDRIVES,
        disposition: "dropped" as const,
        dispositionReason: "max-redrives" as const,
        external: null,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      },
    ];
    const report = reconcileTodos({
      wake: emptyWake(),
      todos,
      workers: [],
      nowMs: 100_000,
      completedRetentionMs: 1,
    });

    assert.deepEqual(
      report.mutations.map((mutation) => mutation.type),
      ["prune"],
    );
    assert.equal(
      report.mutations[0]?.type === "prune" && report.mutations[0].reason,
      "lost-retention",
    );
  });
});

describe("delivery obligation — the budget is a lifetime one (D-5)", () => {
  it("attempts persist on the marker and survive a restart", async () => {
    const durability: InMemoryDurability = createInMemoryDurability();

    // Process 1: spawn, settle undelivered, spend one attempt, then crash.
    const hostA = new FakeDshHost();
    const coreA = createMultitask(hostA, { durability });
    const workerId = await spawnForTodo(coreA, hostA);
    settleUndelivered(hostA, workerId);
    coreA.drainWake(SESSION);
    assert.equal(coreA.redriveUndelivered(SESSION).redriven.length, 1);

    const marker = durability.markers.get(workerId);
    assert.ok(marker);
    assert.equal(marker.redriveAttempts, 1, "the spent budget is durable");

    // Process 2: a fresh core rebuilt from markers only (ADR-0006).
    const hostB = new FakeDshHost();
    const coreB = createMultitask(hostB, { durability });
    const rebuild = await coreB.rebuildFromDurability(SESSION);
    assert.equal(rebuild.restored.length, 1);
    assert.equal(
      todoOf(coreB).redriveAttempts,
      1,
      "the restart continues the same budget instead of restarting it",
    );

    // And the next attempt continues the count rather than resetting it.
    coreB.redriveUndelivered(SESSION);
    assert.equal(todoOf(coreB).redriveAttempts, 2);
  });

  it("activation redrives a restored undelivered result by opening a turn", async () => {
    const durability = createInMemoryDurability();

    // A result that settled before the crash and was never delivered.
    const hostA = new FakeDshHost();
    const coreA = createMultitask(hostA, { durability });
    const workerId = await spawnForTodo(coreA, hostA);
    settleUndelivered(hostA, workerId);
    coreA.drainWake(SESSION);

    // Activation: rebuild from markers only, then redrive — the two calls the
    // plugin makes, in order.
    const hostB = new FakeDshHost();
    const coreB = createMultitask(hostB, { durability });
    await coreB.rebuildFromDurability(SESSION);

    const wakesBefore = hostB.wakeCalls.length;
    const report = coreB.redriveUndelivered(SESSION);

    assert.equal(report.redriven.length, 1);
    assert.equal(
      hostB.wakeCalls.length,
      wakesBefore + 1,
      "recovery does not wait for the user to speak",
    );
    assert.equal(todoOf(coreB).redriveAttempts, 1);
  });

  it("a marker written before this ticket reads as zero attempts", async () => {
    const durability = createInMemoryDurability();
    durability.markers.set("w-legacy", {
      workerId: "w-legacy",
      parentSessionId: SESSION,
      streamKey: "legacy-key",
      title: "Half-written record",
      status: "completed",
      transcriptRef: "w-legacy",
      todoId: "todo-legacy",
      startedAtMs: 1_000,
      updatedAtMs: 2_000,
      // no redriveAttempts — pre-ticket-58 shape
    });

    const core = createMultitask(new FakeDshHost(), { durability });
    await core.rebuildFromDurability(SESSION);

    assert.equal(
      todoOf(core, "todo-legacy").redriveAttempts,
      0,
      "an absent field is not an error and not an unlimited budget",
    );
  });
});

describe("delivery obligation — telemetry (D-6)", () => {
  it("records `delivered` with its reason", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);
    multitask.drainWake(SESSION);
    multitask.markDelivered("todo-1");

    const events = multitask.todos.listDeliveryEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.disposition, "delivered");
    assert.equal(events[0]?.reason, "delivered-to-user");
    assert.equal(todoOf(multitask).dispositionReason, "delivered-to-user");
  });

  it("records `superseded` for a result from a worker the todo no longer points at", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    multitask.createTodo({ sessionId: SESSION, id: "todo-1", title: "Research" });

    const first = await multitask.spawnWorker({
      parentSessionId: SESSION,
      streamKey: "stream-1",
      title: "Research",
      prompt: "go",
      todoId: "todo-1",
    });
    assert.ok(first.ok);
    // Re-dispatch the same todo onto a second worker (a new stream key).
    const second = await multitask.spawnWorker({
      parentSessionId: SESSION,
      streamKey: "stream-2",
      title: "Research",
      prompt: "go again",
      todoId: "todo-1",
    });
    assert.ok(second.ok);
    assert.equal(todoOf(multitask).workerId, second.workerId);

    // The first worker finally reports. Nobody is waiting for it any more.
    settleUndelivered(host, first.workerId);
    const drained = multitask.drainWake(SESSION);
    assert.ok(drained);

    const superseded = multitask.todos
      .listDeliveryEvents()
      .filter((event) => event.disposition === "superseded");
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0]?.reason, "superseded-by-redispatch");
    assert.equal(superseded[0]?.workerId, first.workerId);
    // Crucially it is not mistaken for the current worker's result.
    assert.equal(
      drained.reconcile.landedUndelivered.length,
      0,
      "a superseded result does not become the live item's pending delivery",
    );
  });

  it("escalates an item whose worker we no longer hold (worker_gone)", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    multitask.createTodo({
      sessionId: SESSION,
      id: "todo-1",
      title: "Research",
      status: "in_progress",
      streamKey: "stream-1",
    });
    // A structural link to a worker this core never held: nothing will ever
    // settle it, so waiting is pointless and silence would be a lie.
    multitask.todos.linkWorker("todo-1", "ghost-worker", "stream-1");

    const report = multitask.redriveUndelivered(SESSION);

    assert.equal(report.redriven.length, 0);
    assert.equal(report.lost.length, 1);
    assert.equal(todoOf(multitask).status, "lost");
    assert.equal(todoOf(multitask).dispositionReason, "worker-gone");
  });

  it("records an aborted stream as dropped, not as lost", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    multitask.noteTurnStarted(workerId);
    await multitask.abortWorker(workerId);

    const events = multitask.todos.listDeliveryEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.disposition, "dropped");
    assert.equal(
      events[0]?.reason,
      "worker-aborted",
      "nothing was owed, so this is not a delivery failure",
    );
  });
});
