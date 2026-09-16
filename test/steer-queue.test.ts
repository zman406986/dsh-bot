import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import { createSteerQueue } from "../src/core/steer-queue.js";
import type { SpawnResult } from "../src/core/types.js";

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

async function spawnRunning(
  host: FakeDshHost,
  multitask: Multitask,
  parentSessionId = "session-1",
  streamKey = "todo-1",
): Promise<string> {
  const workerId = unwrapSpawn(
    await multitask.spawnWorker({
      parentSessionId,
      streamKey,
      title: "Steer subject",
      prompt: "Do the work.",
    }),
  );
  multitask.noteTurnStarted(workerId);
  return workerId;
}

describe("steer queue (single-slot, last-wins)", () => {
  it("parks a message and pops it once", () => {
    const queue = createSteerQueue();
    queue.park("w1", "use metric units");
    assert.equal(queue.pop("w1"), "use metric units");
  });

  it("a second park replaces the first; the earlier message is never delivered", () => {
    const queue = createSteerQueue();
    queue.park("w1", "first correction");
    queue.park("w1", "second correction");
    assert.equal(queue.pop("w1"), "second correction");
    assert.equal(queue.pop("w1"), undefined);
  });

  it("popping an empty queue yields nothing rather than throwing", () => {
    const queue = createSteerQueue();
    assert.doesNotThrow(() => {
      assert.equal(queue.pop("w1"), undefined);
      assert.equal(queue.pop("never-parked"), undefined);
    });
  });

  it("workers hold independent slots", () => {
    const queue = createSteerQueue();
    queue.park("w1", "for one");
    queue.park("w2", "for two");
    assert.equal(queue.pop("w1"), "for one");
    assert.equal(queue.pop("w2"), "for two");
  });

  it("clear drops a parked message so a later pop yields nothing", () => {
    const queue = createSteerQueue();
    queue.park("w1", "doomed");
    queue.clear("w1");
    assert.equal(queue.pop("w1"), undefined);
  });
});

describe("multitask steer delivery (observable via fake host)", () => {
  it("a steer sent to a running worker is delivered into that worker and context is preserved", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);

    const result = await multitask.steerWorker(workerId, "switch to metric units");
    assert.deepEqual(result, { ok: true });

    await host.fireStepBoundary(workerId);

    assert.equal(host.sendMessageCalls.length, 1);
    const delivered = host.sendMessageCalls[0];
    assert.ok(delivered);
    assert.equal(delivered.workerId, workerId);
    assert.ok(delivered.message.includes("switch to metric units"));
    // Context preserved: the same worker continues. No replacement is spawned.
    assert.equal(host.spawnCalls.length, 1);
    assert.equal(multitask.getWorker(workerId)?.status, "running");
  });

  it("a steer interrupts the current step and work resumes at the next step boundary", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);

    const result = await multitask.steerWorker(workerId, "tighten the intro");
    assert.deepEqual(result, { ok: true });

    // Current step was interrupted; the steer is not yet delivered.
    assert.deepEqual(host.interruptCalls, [workerId]);
    assert.equal(host.sendMessageCalls.length, 0);
    assert.equal(multitask.getWorker(workerId)?.status, "steering");

    // Step boundary: the steer is folded in and work continues.
    await host.fireStepBoundary(workerId);
    assert.equal(host.sendMessageCalls.length, 1);
    assert.equal(multitask.getWorker(workerId)?.status, "running");
  });

  it("a second steer before the first is delivered replaces it; the earlier one is never delivered", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);

    await multitask.steerWorker(workerId, "first correction");
    assert.equal(multitask.getWorker(workerId)?.status, "steering");

    // Second steer arrives while the first is still parked.
    const second = await multitask.steerWorker(workerId, "second correction");
    assert.deepEqual(second, { ok: true });

    await host.fireStepBoundary(workerId);

    assert.equal(host.sendMessageCalls.length, 1);
    const delivered = host.sendMessageCalls[0];
    assert.ok(delivered);
    assert.ok(delivered.message.includes("second correction"));
    assert.ok(!delivered.message.includes("first correction"));
    // Only one interrupt for the original step; the replacement does not re-interrupt.
    assert.deepEqual(host.interruptCalls, [workerId]);
  });

  it("a steer sent to a worker that is not running is refused and no replacement worker is created", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    // Unknown worker.
    const unknown = await multitask.steerWorker("ghost", "are you there?");
    assert.equal(unknown.ok, false);
    assert.equal(unknown.ok === false && unknown.reason, "unknown-worker");

    // Spawned but first turn has not started.
    const spawnedId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-2",
        title: "Not started",
        prompt: "Wait.",
      }),
    );
    const beforeTurn = await multitask.steerWorker(spawnedId, "hurry up");
    assert.equal(beforeTurn.ok, false);
    assert.equal(beforeTurn.ok === false && beforeTurn.reason, "not-running");
    assert.ok(
      beforeTurn.ok === false && beforeTurn.detail.includes("done"),
      "refusal should say the worker may already be done",
    );

    // Completed worker.
    const completedId = await spawnRunning(host, multitask, "session-2");
    host.fireSettled({
      workerId: completedId,
      status: "completed",
      report: "all finished",
    });
    const afterDone = await multitask.steerWorker(completedId, "one more thing");
    assert.equal(afterDone.ok, false);
    assert.equal(afterDone.ok === false && afterDone.reason, "not-running");
    assert.ok(afterDone.ok === false && afterDone.detail.includes("done"));

    // Aborted worker.
    const abortedId = await spawnRunning(host, multitask, "session-3");
    await multitask.abortWorker(abortedId);
    const afterAbort = await multitask.steerWorker(abortedId, "come back");
    assert.equal(afterAbort.ok, false);
    assert.equal(afterAbort.ok === false && afterAbort.reason, "not-running");
    assert.ok(afterAbort.ok === false && afterAbort.detail.includes("done"));

    // Refusals never spawn a replacement worker and never deliver anything.
    assert.equal(host.spawnCalls.length, 3);
    assert.equal(host.sendMessageCalls.length, 0);
    // Refused steers do not move a non-running worker into steering.
    assert.equal(multitask.getWorker(spawnedId)?.status, "spawned");
    assert.equal(multitask.getWorker(completedId)?.status, "completed");
    assert.equal(multitask.getWorker(abortedId)?.status, "aborted");
  });

  it("a delivered steer is wrapped in a parent-correction note, not sent raw", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);

    await multitask.steerWorker(workerId, "prefer metric units");
    await host.fireStepBoundary(workerId);

    const delivered = host.sendMessageCalls[0];
    assert.ok(delivered);
    // The user's steer text is present…
    assert.ok(delivered.message.includes("prefer metric units"));
    // …and it is wrapped, not the bare message.
    assert.notEqual(delivered.message, "prefer metric units");
  });
});
