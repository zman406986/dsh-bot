/**
 * Red tests — durable delivered-ack (auto-continue fix, design note Decision 1).
 *
 * Desired contract: every post-fix marker write carries `delivered`
 * (toDurableMarker always emits it; a fresh settle is owed = false, so absence
 * of the field stays a reliable legacy discriminator), and markDelivered
 * upserts a delivered:true tombstone BEFORE the best-effort delete — the
 * failed-delete backstop the deletion-only ack lacks. A durably acked result
 * must not resurrect as an obligation on a fresh-core rebuild: no redrive,
 * no wake. The #301 current-run guard is preserved: an old-run ack never
 * writes or deletes the latest run's marker row.
 *
 * Pure core (S8): FakeDshHost + createInMemoryDurability held across fresh
 * createMultitask instances = simulated restart. No network/LLM, no plugin
 * import, no dsh-scope, no loader.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInMemoryDurability,
  type DurableWorkerMarker,
  type InMemoryDurability,
} from "../src/core/durability.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";
import type { SpawnResult } from "../src/core/types.js";

/**
 * The ack field the fix adds, read off the EXISTING row shape. Optional in
 * the intersection so this file type-checks against the pre-fix marker
 * interface; the assertions demand its presence and value.
 */
type AckedMarker = DurableWorkerMarker & { readonly delivered?: boolean };

function unwrapSpawn(result: SpawnResult): string {
  if (!result.ok) {
    throw new Error(`spawn refused: ${result.detail}`);
  }
  return result.workerId;
}

function markerOf(store: InMemoryDurability, workerId: string): AckedMarker {
  const marker: AckedMarker | undefined = store.markers.get(workerId);
  assert.ok(marker, `durable marker for ${workerId} must exist`);
  return marker;
}

/**
 * Spawn one linked worker and settle it completed (delivery still owed).
 * `port` defaults to the store itself; pass a wrapped port to inject a
 * transient store failure while the shared markers map stays observable.
 */
async function settleOwedWorker(
  store: InMemoryDurability,
  port: InMemoryDurability = store,
): Promise<{ workerId: string; core: ReturnType<typeof createMultitask> }> {
  const host = new FakeDshHost();
  const core = createMultitask(host, { durability: port });
  core.createTodo({
    sessionId: "session-1",
    id: "todo-1",
    title: "Durable ack subject",
  });
  const workerId = unwrapSpawn(
    await core.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Durable ack subject",
      prompt: "Do the work.",
      todoId: "todo-1",
    }),
  );
  core.noteTurnStarted(workerId);
  host.fireSettled({
    workerId,
    status: "completed",
    report: "Done; the dispatcher still owes the user this result.",
    transcriptRef: "child-session-1",
  });
  return { workerId, core };
}

/** A store whose NEXT deleteWorkerMarker throws once (transient failure). */
function failNextDelete(store: InMemoryDurability): InMemoryDurability {
  let armed = true;
  return {
    ...store,
    deleteWorkerMarker(workerId: string): void {
      if (armed) {
        armed = false;
        throw new Error("simulated transient marker-delete failure");
      }
      store.deleteWorkerMarker(workerId);
    },
  };
}

describe("durable delivered-ack — marker projection", () => {
  it("a fresh settle stamps delivered:false on the durable marker", async () => {
    const store = createInMemoryDurability();
    const { workerId } = await settleOwedWorker(store);
    const marker = markerOf(store, workerId);
    assert.equal(marker.status, "completed");
    // Post-fix writes ALWAYS emit the field; absence is reserved for legacy
    // (pre-fix) rows, so a fresh settle must carry the discriminator.
    assert.ok(
      Object.prototype.hasOwnProperty.call(marker, "delivered"),
      "post-fix settle must emit the delivered discriminator",
    );
    assert.equal(
      marker.delivered,
      false,
      "a settled-but-unacked result is still owed",
    );
  });
});

describe("durable delivered-ack — failed-delete backstop", () => {
  it("markDelivered leaves a delivered:true tombstone when the delete fails", async () => {
    const store = createInMemoryDurability();
    const { workerId, core } = await settleOwedWorker(store, failNextDelete(store));
    // The ledger ack succeeds even though the store delete throws.
    assert.equal(core.markDelivered("todo-1"), true);
    const tombstone = markerOf(store, workerId);
    assert.equal(
      tombstone.delivered,
      true,
      "failed delete must leave an acked tombstone, not an owed marker",
    );
  });

  it("a fresh rebuild owes nothing after a failed-delete ack: no redrive, no wake", async () => {
    const store = createInMemoryDurability();
    const { core } = await settleOwedWorker(store, failNextDelete(store));
    assert.equal(core.markDelivered("todo-1"), true);

    // Simulated restart: fresh core, same durable store (healthy reads).
    const after = createMultitask(new FakeDshHost(), { durability: store });
    const report = await after.rebuildFromDurability("session-1");
    // Acked work stays answerable on the roster (#300 wording: terminal rows
    // still count as restored) — but it owes nothing.
    assert.equal(report.restored.length, 1);
    const todo = after.listTodos("session-1")[0];
    assert.ok(todo);
    assert.equal(
      todo.delivered,
      true,
      "a durably acked result must not resurrect as owed",
    );
    assert.equal(todo.status, "completed");
    const redrive = after.redriveUndelivered("session-1");
    assert.deepEqual(redrive.redriven, [], "no obligation left to redrive");
    assert.deepEqual(redrive.lost, []);
    assert.equal(
      after.wakeBus.peekPending("session-1"),
      undefined,
      "no obligation means no redrive wake",
    );
  });
});

describe("durable delivered-ack — preserved behavior (controls)", () => {
  it("healthy store: the ack still deletes the marker and rebuild restores nothing", async () => {
    const store = createInMemoryDurability();
    const { workerId, core } = await settleOwedWorker(store);
    assert.equal(core.markDelivered("todo-1"), true);
    // Delete-success → row gone (today's behavior; the tombstone is only the
    // failed-delete backstop, never a second permanent row).
    assert.equal(store.markers.has(workerId), false);
    const after = createMultitask(new FakeDshHost(), { durability: store });
    const report = await after.rebuildFromDurability("session-1");
    assert.deepEqual(report, { restored: [], unknownState: [] });
    assert.deepEqual(after.listTodos("session-1"), []);
  });

  it("#301: repeating an old-run ack never clobbers the latest run's marker", () => {
    const store = createInMemoryDurability();
    const host = new FakeDshHost();
    const core = createMultitask(host, { durability: store });
    const request = { workerId: "child", parentSessionId: "session-1" };
    assert.equal(core.adoptSpawnedWorker({ ...request, runId: "run-a" }), true);
    core.noteTurnStarted("child");
    host.fireSettled({
      workerId: "child",
      runId: "run-a",
      status: "completed",
      report: "FIRST",
    });
    const oldTodoId = core.getWorker("child")?.todoId;
    assert.ok(oldTodoId);
    assert.equal(core.markDelivered(oldTodoId), true);

    // A genuinely-new run of the same worker owns the marker row now.
    assert.equal(core.adoptSpawnedWorker({ ...request, runId: "run-b" }), true);
    core.noteTurnStarted("child");
    const newTodoId = core.getWorker("child")?.todoId;
    assert.ok(newTodoId);
    assert.notEqual(newTodoId, oldTodoId);
    const marker = structuredClone(store.markers.get("child"));
    assert.ok(marker, "the current run's marker exists before the stale ack");

    // Repeat the OLD run's ack: the current-run guard must block both the
    // tombstone upsert and the delete — the row belongs to run-b.
    assert.equal(core.markDelivered(oldTodoId), true);
    assert.equal(core.markDelivered(oldTodoId), true);
    assert.deepEqual(store.markers.get("child"), marker);
    assert.equal(
      core.todos.get(newTodoId)?.delivered,
      false,
      "the current run still owes its own delivery",
    );
  });
});
