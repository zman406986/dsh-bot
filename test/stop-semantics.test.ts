import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import type { SpawnResult } from "../src/core/types.js";

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

async function spawnRunning(
  _host: FakeDshHost,
  multitask: Multitask,
  parentSessionId = "session-1",
  streamKey = "todo-1",
): Promise<string> {
  const workerId = unwrapSpawn(
    await multitask.spawnWorker({
      parentSessionId,
      streamKey,
      title: "Stop subject",
      prompt: "Do the work.",
    }),
  );
  multitask.noteTurnStarted(workerId);
  return workerId;
}

describe("stop semantics", () => {
  it("stopping a running worker aborts it, confirms to the caller, and sends no user-facing message", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);

    const result = await multitask.abortWorker(workerId);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(host.interruptCalls, [workerId]);
    assert.equal(multitask.getWorker(workerId)?.status, "aborted");
    // The stop path never talks to the user.
    assert.equal(host.sendMessageCalls.length, 0);
    // And it does not itself wake the dispatcher.
    assert.deepEqual(host.wakeCalls, []);
  });

  it("stopping disarms the completion wake: a finish after stop never wakes the dispatcher", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);
    await multitask.abortWorker(workerId);

    host.fireSettled({
      workerId,
      status: "completed",
      report: "finished after stop",
    });

    assert.deepEqual(host.wakeCalls, []);
    assert.equal(multitask.getWorker(workerId)?.status, "aborted");
  });

  it("a result that settles after a stop is dropped: no delivery, no wake, no revived work", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);
    await multitask.abortWorker(workerId);

    host.fireSettled({
      workerId,
      status: "completed",
      report: "too late",
    });

    // Dropped: status stays aborted, nobody is woken, nothing is sent.
    assert.equal(multitask.getWorker(workerId)?.status, "aborted");
    assert.deepEqual(host.wakeCalls, []);
    assert.equal(host.sendMessageCalls.length, 0);
    // The roster still lists the stopped worker — it is out of play, not erased.
    assert.equal(multitask.listWorkers("session-1").length, 1);
    assert.equal(multitask.listWorkers("session-1")[0]?.status, "aborted");
  });

  it("stopping clears a parked steer so no late step boundary delivers it", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);
    const steered = await multitask.steerWorker(workerId, "doomed correction");
    assert.equal(steered.ok, true);
    assert.equal(multitask.getWorker(workerId)?.status, "steering");

    assert.deepEqual(await multitask.abortWorker(workerId), { ok: true });
    assert.equal(multitask.getWorker(workerId)?.status, "aborted");

    // A step boundary after stop must not revive the parked correction.
    await host.fireStepBoundary(workerId);
    assert.equal(host.sendMessageCalls.length, 0);
  });

  it("the stop flag wins when the stop path itself produces a completion", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);
    await multitask.abortWorker(workerId);

    // Whatever the host reports after stop, nothing observable changes.
    for (const status of ["completed", "error", "aborted"] as const) {
      host.fireSettled({ workerId, status, report: `late ${status}` });
      assert.equal(multitask.getWorker(workerId)?.status, "aborted");
    }
    assert.deepEqual(host.wakeCalls, []);
  });

  it("a stop for a worker that already settled is refused; the earlier completion was delivered normally", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);

    // Settle first: the completion reaches the parent through the host's stock
    // completion notice, and the core records the terminal settle. The plugin's
    // own settle wake was deleted on purpose (lane V2) — the settle must not
    // enqueue a second, parent-visible turn.
    host.fireSettled({
      workerId,
      status: "completed",
      report: "all finished",
    });
    assert.equal(multitask.getWorker(workerId)?.status, "completed");
    assert.deepEqual(host.wakeCalls, [], "a settle opens no plugin wake");
    const settle = multitask.settleRecords.lookup("session-1", workerId);
    assert.equal(settle?.status, "completed");
    assert.equal(settle?.resultText, "all finished");

    const stopped = await multitask.abortWorker(workerId);
    assert.equal(stopped.ok, false);
    assert.equal(stopped.ok === false && stopped.reason, "already-settled");
    assert.ok(
      stopped.ok === false && stopped.detail.includes("done"),
      "refusal should say the worker may already be done",
    );

    // Refusal does not interrupt and does not undo the delivered completion —
    // and the refusal itself wakes nothing.
    assert.deepEqual(host.interruptCalls, []);
    assert.equal(multitask.getWorker(workerId)?.status, "completed");
    assert.deepEqual(host.wakeCalls, []);
    assert.equal(
      multitask.settleRecords.lookup("session-1", workerId)?.status,
      "completed",
      "the terminal settle record survives the refused stop",
    );
  });

  it("stopping a worker that has not started yet still aborts it cleanly", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-2",
        title: "Never started",
        prompt: "Wait.",
      }),
    );

    const result = await multitask.abortWorker(workerId);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(host.interruptCalls, [workerId]);
    assert.equal(multitask.getWorker(workerId)?.status, "aborted");
    assert.equal(host.sendMessageCalls.length, 0);
  });
});
