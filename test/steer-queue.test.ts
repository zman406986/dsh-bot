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
  it("a second park replaces the first; the earlier message is never delivered", () => {
    const queue = createSteerQueue();
    queue.park("w1", "first correction");
    queue.park("w1", "second correction");
    assert.equal(queue.pop("w1"), "second correction");
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
