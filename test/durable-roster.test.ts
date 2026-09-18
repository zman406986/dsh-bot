import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInMemoryDurability,
  type InMemoryDurability,
} from "../src/core/durability.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import type { SpawnResult } from "../src/core/types.js";

function unwrapSpawn(result: SpawnResult): string {
  if (!result.ok) {
    throw new Error(`spawn refused: ${result.detail}`);
  }
  return result.workerId;
}

/**
 * Simulated first process: spawn, optionally settle, then "crash" by
 * discarding the multitask core (the durability store outlives it).
 */
async function runPreCrash(options: {
  durability: InMemoryDurability;
  parentSessionId?: string;
  todoId?: string;
  title?: string;
  streamKey?: string;
  /** "none" | "settled-undelivered" | "live" | "aborted" | "steered" */
  mode?: "none" | "settled-undelivered" | "live" | "aborted" | "steered";
  transcriptRef?: string;
}): Promise<{
  workerId: string;
  parentSessionId: string;
  todoId: string | undefined;
  host: FakeDshHost;
  multitask: Multitask;
}> {
  const parentSessionId = options.parentSessionId ?? "session-1";
  const todoId = options.todoId ?? "todo-1";
  const title = options.title ?? "Durable task";
  const streamKey = options.streamKey ?? todoId;
  const mode = options.mode ?? "none";

  const host = new FakeDshHost();
  const multitask = createMultitask(host, { durability: options.durability });

  multitask.createTodo({
    sessionId: parentSessionId,
    id: todoId,
    title,
  });

  const workerId = unwrapSpawn(
    await multitask.spawnWorker({
      parentSessionId,
      streamKey,
      title,
      prompt: "Do the work.",
      todoId,
    }),
  );

  if (mode === "settled-undelivered") {
    multitask.noteTurnStarted(workerId);
    host.fireSettled({
      workerId,
      status: "completed",
      report: "Done; user never saw this.",
      transcriptRef: options.transcriptRef ?? "child-session-1",
    });
  } else if (mode === "aborted") {
    multitask.noteTurnStarted(workerId);
    await multitask.abortWorker(workerId);
  } else if (mode === "steered") {
    multitask.noteTurnStarted(workerId);
    await multitask.steerWorker(workerId, "parked steer that must vanish");
  } else if (mode === "live") {
    multitask.noteTurnStarted(workerId);
  }

  return { workerId, parentSessionId, todoId, host, multitask };
}

describe("durable roster marker — write path", () => {
  it("spawn writes a minimum marker: worker id, todo link, status spawned, no report body", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const multitask = createMultitask(host, { durability });

    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-1",
      title: "Research profiles",
    });
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Research profiles",
        prompt: "Look up profiles.",
        todoId: "todo-1",
      }),
    );

    const marker = durability.markers.get(workerId);
    assert.ok(marker);
    assert.equal(marker.workerId, workerId);
    assert.equal(marker.parentSessionId, "session-1");
    assert.equal(marker.streamKey, "todo-1");
    assert.equal(marker.title, "Research profiles");
    assert.equal(marker.status, "spawned");
    assert.equal(marker.todoId, "todo-1");
    assert.equal(marker.transcriptRef, null);
    assert.ok(marker.startedAtMs > 0);
    assert.ok(marker.updatedAtMs > 0);
    // No second transcript DB: the marker carries no result/report body.
    // Ticket 58 added ONE field — `redriveAttempts`, the delivery budget.
    // It is a counter, not content: the "minimum to reconstruct" rule holds,
    // because a restart that forgets the spent budget would hand the same
    // obligation a fresh set of retries on every boot.
    assert.equal(marker.redriveAttempts, 0);
    const keys = Object.keys(marker).sort();
    assert.deepEqual(keys, [
      "parentSessionId",
      "redriveAttempts",
      "startedAtMs",
      "status",
      "streamKey",
      "title",
      "todoId",
      "transcriptRef",
      "updatedAtMs",
      "workerId",
    ]);
  });

  it("settle updates the marker with terminal status and transcript pointer", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const multitask = createMultitask(host, { durability });

    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Settle subject",
        prompt: "Work.",
      }),
    );

    host.fireSettled({
      workerId,
      status: "completed",
      report: "All done.",
      transcriptRef: "child-session-9",
    });

    const marker = durability.markers.get(workerId);
    assert.ok(marker);
    assert.equal(marker.status, "completed");
    assert.equal(marker.transcriptRef, "child-session-9");
  });

  it("abort deletes the marker — nothing left to reconstruct or deliver", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const multitask = createMultitask(host, { durability });

    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-1",
      title: "Abort subject",
    });
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Abort subject",
        prompt: "Work.",
        todoId: "todo-1",
      }),
    );
    assert.ok(durability.markers.has(workerId));

    await multitask.abortWorker(workerId);

    assert.equal(durability.markers.has(workerId), false);
  });

  it("markDelivered deletes the marker once the user has the result (S4)", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const multitask = createMultitask(host, { durability });

    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-1",
      title: "Deliver subject",
    });
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Deliver subject",
        prompt: "Work.",
        todoId: "todo-1",
      }),
    );
    multitask.noteTurnStarted(workerId);
    host.fireSettled({
      workerId,
      status: "completed",
      report: "Ready for the user.",
      transcriptRef: "child-session-1",
    });
    assert.ok(durability.markers.has(workerId));

    assert.equal(multitask.markDelivered("todo-1"), true);
    assert.equal(durability.markers.has(workerId), false);
  });

  it("no durability port: spawn and settle behave as before (existing suite green)", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Plain",
        prompt: "Work.",
      }),
    );
    host.fireSettled({ workerId, status: "completed", report: "ok" });
    assert.equal(multitask.getWorker(workerId)?.status, "completed");
  });
});

describe("durable roster marker — restart rebuild", () => {
  it("undelivered completed result finishes delivery after a restart from markers only", async () => {
    const durability = createInMemoryDurability();
    const pre = await runPreCrash({
      durability,
      mode: "settled-undelivered",
      transcriptRef: "child-session-1",
    });

    // Discard the in-memory core entirely; rebuild against the store only.
    const hostAfter = new FakeDshHost();
    const after = createMultitask(hostAfter, { durability });
    const report = await after.rebuildFromDurability(pre.parentSessionId);

    assert.equal(report.unknownState.length, 0);
    assert.equal(report.restored.length, 1);
    const restored = report.restored[0];
    assert.ok(restored);
    assert.equal(restored.workerId, pre.workerId);
    assert.equal(restored.status, "completed");
    assert.equal(restored.transcriptRef, "child-session-1");
    assert.equal(restored.todoId, "todo-1");
    // Terminal: stream key is free, not held live.
    const roster = after.listWorkers("session-1");
    assert.equal(roster.length, 1);
    assert.equal(roster[0]?.status, "completed");

    // No host spawn was used to rebuild — never replayed.
    assert.equal(hostAfter.spawnCalls.length, 0);

    // Reconcile notices the landed-but-undelivered item and delivery can finish.
    const todos = after.listTodos("session-1");
    assert.equal(todos.length, 1);
    assert.equal(todos[0]?.id, "todo-1");
    assert.equal(todos[0]?.status, "in_progress");
    assert.equal(todos[0]?.delivered, false);
    assert.equal(todos[0]?.workerId, pre.workerId);

    const reconcile = after.reconcileTodos("session-1");
    assert.equal(reconcile.landedUndelivered.length, 1);
    assert.equal(reconcile.landedUndelivered[0]?.id, "todo-1");

    assert.equal(after.markDelivered("todo-1"), true);
    assert.equal(after.listTodos("session-1")[0]?.delivered, true);
    // Marker obligation closed after delivery.
    assert.equal(durability.markers.has(pre.workerId), false);
  });

  it("a live worker at crash time is unknown-state with a transcript pointer — never replayed", async () => {
    const durability = createInMemoryDurability();
    const pre = await runPreCrash({ durability, mode: "live" });

    // Marker last snapshotted at spawn (live); turn-started does not rewrite.
    // A live status is enough: we cannot reconstruct the worker.
    const marker = durability.markers.get(pre.workerId);
    assert.ok(marker);
    assert.equal(marker.status, "spawned");

    const hostAfter = new FakeDshHost();
    const after = createMultitask(hostAfter, { durability });
    const report = await after.rebuildFromDurability(pre.parentSessionId);

    assert.equal(report.restored.length, 0);
    assert.equal(report.unknownState.length, 1);
    const unknown = report.unknownState[0];
    assert.ok(unknown);
    assert.equal(unknown.workerId, pre.workerId);
    assert.equal(unknown.lastKnownStatus, "spawned");
    assert.equal(unknown.title, "Durable task");
    assert.equal(unknown.todoId, "todo-1");
    // Transcript pointer falls back to the worker id (child session id).
    assert.equal(unknown.transcriptRef, pre.workerId);

    // Not invented onto the roster as a fake terminal (or live) worker.
    assert.equal(after.getWorker(pre.workerId), undefined);
    assert.equal(after.listWorkers("session-1").length, 0);
    // Never replayed: no spawn, no interrupt, no message.
    assert.equal(hostAfter.spawnCalls.length, 0);
    assert.equal(hostAfter.interruptCalls.length, 0);
    assert.equal(hostAfter.sendMessageCalls.length, 0);
    // Stream key is free for a legitimate re-dispatch.
    const redispatch = await after.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Re-dispatched",
      prompt: "Try again.",
      todoId: "todo-1",
    });
    assert.ok(redispatch.ok);
  });

  it("a marker that settled with a transcriptRef still reports unknown when status was live — pointer prefers marker value", async () => {
    // Direct store write: status live but transcript already known (edge).
    const durability = createInMemoryDurability();
    durability.markers.set("w-edge", {
      workerId: "w-edge",
      parentSessionId: "session-1",
      streamKey: "todo-edge",
      title: "Edge",
      status: "steering",
      transcriptRef: "child-edge",
      todoId: null,
      startedAtMs: 1,
      updatedAtMs: 2,
    });

    const after = createMultitask(new FakeDshHost(), { durability });
    const report = await after.rebuildFromDurability("session-1");
    assert.equal(report.unknownState.length, 1);
    assert.equal(report.unknownState[0]?.transcriptRef, "child-edge");
  });

  it("steers are not durable: a parked steer is not loaded or re-delivered after restart", async () => {
    const durability = createInMemoryDurability();
    const pre = await runPreCrash({ durability, mode: "steered" });

    // Pre-crash: the steer was parked and the worker is steering.
    assert.equal(pre.multitask.getWorker(pre.workerId)?.status, "steering");
    // Steer never touches the marker store.
    assert.equal(durability.markers.size, 1);
    const markerOnly = [...durability.markers.values()][0];
    assert.ok(markerOnly);
    assert.equal(
      Object.prototype.hasOwnProperty.call(markerOnly, "message"),
      false,
    );

    const hostAfter = new FakeDshHost();
    const after = createMultitask(hostAfter, { durability });
    const report = await after.rebuildFromDurability(pre.parentSessionId);

    // Live steering marker → unknown-state; nothing to re-steer.
    assert.equal(report.unknownState.length, 1);
    assert.equal(report.restored.length, 0);

    // Even a step boundary for the old worker id must not deliver a steer.
    await hostAfter.fireStepBoundary(pre.workerId);
    assert.equal(hostAfter.sendMessageCalls.length, 0);

    // A steer request against the unknown worker is refused, not revived.
    const steer = await after.steerWorker(pre.workerId, "late steer");
    assert.ok(!steer.ok);
    assert.equal(steer.ok ? "" : steer.reason, "unknown-worker");
    assert.equal(hostAfter.spawnCalls.length, 0);
  });

  it("steering a restored terminal worker after restart is refused", async () => {
    const durability = createInMemoryDurability();
    const pre = await runPreCrash({ durability, mode: "settled-undelivered" });

    const after = createMultitask(new FakeDshHost(), { durability });
    await after.rebuildFromDurability(pre.parentSessionId);

    const steer = await after.steerWorker(pre.workerId, "try to steer a ghost");
    assert.ok(!steer.ok);
    assert.equal(steer.ok ? "" : steer.reason, "not-running");
  });

  it("rebuild without a durability port returns an empty report and invents nothing", async () => {
    const after = createMultitask(new FakeDshHost());
    const report = await after.rebuildFromDurability("session-1");
    assert.deepEqual(report, { restored: [], unknownState: [] });
  });

  it("rebuild restores only the requested parent session's markers", async () => {
    const durability = createInMemoryDurability();
    // Shared host so the two workers get distinct ids (same id counter).
    const host = new FakeDshHost();
    const mtA = createMultitask(host, { durability });
    const mtB = createMultitask(host, { durability });
    mtA.createTodo({
      sessionId: "session-a",
      id: "todo-a",
      title: "Task A",
    });
    mtB.createTodo({
      sessionId: "session-b",
      id: "todo-b",
      title: "Task B",
    });
    const workerA = unwrapSpawn(
      await mtA.spawnWorker({
        parentSessionId: "session-a",
        streamKey: "todo-a",
        title: "Task A",
        prompt: "A.",
        todoId: "todo-a",
      }),
    );
    const workerB = unwrapSpawn(
      await mtB.spawnWorker({
        parentSessionId: "session-b",
        streamKey: "todo-b",
        title: "Task B",
        prompt: "B.",
        todoId: "todo-b",
      }),
    );
    assert.notEqual(workerA, workerB);
    host.fireSettled({
      workerId: workerA,
      status: "completed",
      report: "A done.",
      transcriptRef: "child-a",
    });
    host.fireSettled({
      workerId: workerB,
      status: "completed",
      report: "B done.",
      transcriptRef: "child-b",
    });

    const after = createMultitask(new FakeDshHost(), { durability });
    const report = await after.rebuildFromDurability("session-a");
    assert.equal(report.restored.length, 1);
    assert.equal(report.restored[0]?.parentSessionId, "session-a");
    assert.equal(report.restored[0]?.workerId, workerA);
    assert.equal(after.listWorkers("session-b").length, 0);
    // session-b markers still on the store for a later rebuild.
    assert.ok(durability.markers.has(workerB));
  });

  it("aborted workers leave no marker, so restart reports nothing for them", async () => {
    const durability = createInMemoryDurability();
    await runPreCrash({ durability, mode: "aborted" });

    assert.equal(durability.markers.size, 0);
    const after = createMultitask(new FakeDshHost(), { durability });
    const report = await after.rebuildFromDurability("session-1");
    assert.deepEqual(report, { restored: [], unknownState: [] });
  });

  it("restart + drainWake: a settled worker still delivers its wake path from the roster", async () => {
    const durability = createInMemoryDurability();
    const pre = await runPreCrash({
      durability,
      mode: "settled-undelivered",
      transcriptRef: "child-session-2",
    });

    const after = createMultitask(new FakeDshHost(), { durability });
    await after.rebuildFromDurability(pre.parentSessionId);

    // A dispatcher turn after restart: drain a user wake and reconcile.
    after.wakeBus.enqueueUserWake(pre.parentSessionId);
    const drained = after.drainWake(pre.parentSessionId);
    assert.ok(drained);
    assert.equal(drained.wake.source, "user");
    assert.equal(drained.reconcile.landedUndelivered.length, 1);
    assert.equal(drained.reconcile.landedUndelivered[0]?.id, "todo-1");
  });
});
