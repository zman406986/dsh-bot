import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";

async function spawnRunning(
  _host: FakeDshHost,
  multitask: Multitask,
  parentSessionId = "session-1",
): Promise<string> {
  const workerId = await multitask.spawnWorker({
    parentSessionId,
    streamKey: "todo-1",
    title: "Stop subject",
    prompt: "Do the work.",
  });
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

  it("stopping clears any parked steer; a later step boundary delivers nothing", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);

    // Park a steer (running → steering, interrupt, message held in the slot).
    const steered = await multitask.steerWorker(workerId, "doomed correction");
    assert.equal(steered.ok, true);
    assert.equal(multitask.getWorker(workerId)?.status, "steering");

    const stopped = await multitask.abortWorker(workerId);
    assert.deepEqual(stopped, { ok: true });
    assert.equal(multitask.getWorker(workerId)?.status, "aborted");

    // A step boundary after stop must not revive the parked steer.
    await host.fireStepBoundary(workerId);
    assert.equal(host.sendMessageCalls.length, 0);
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

    // Settle first: the completion is delivered through the normal path.
    host.fireSettled({
      workerId,
      status: "completed",
      report: "all finished",
    });
    assert.equal(multitask.getWorker(workerId)?.status, "completed");
    assert.deepEqual(host.wakeCalls, ["session-1"]);

    const stopped = await multitask.abortWorker(workerId);
    assert.equal(stopped.ok, false);
    assert.equal(stopped.ok === false && stopped.reason, "already-settled");
    assert.ok(
      stopped.ok === false && stopped.detail.includes("done"),
      "refusal should say the worker may already be done",
    );

    // Refusal does not interrupt and does not undo the delivered completion.
    assert.deepEqual(host.interruptCalls, []);
    assert.equal(multitask.getWorker(workerId)?.status, "completed");
    assert.deepEqual(host.wakeCalls, ["session-1"]);
  });

  it("a second stop after an abort is refused and does not interrupt again", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnRunning(host, multitask);

    const first = await multitask.abortWorker(workerId);
    assert.deepEqual(first, { ok: true });

    const second = await multitask.abortWorker(workerId);
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, "already-settled");
    assert.ok(second.ok === false && second.detail.includes("done"));

    assert.deepEqual(host.interruptCalls, [workerId]);
    assert.equal(multitask.getWorker(workerId)?.status, "aborted");
  });

  it("settled before stop delivers; settles after stop drops", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    // A: settle, then stop — delivery already happened; stop is refused.
    const settledFirst = await spawnRunning(host, multitask, "session-a");
    host.fireSettled({
      workerId: settledFirst,
      status: "completed",
      report: "done in time",
    });
    const refuseA = await multitask.abortWorker(settledFirst);
    assert.equal(refuseA.ok, false);
    assert.deepEqual(host.wakeCalls, ["session-a"]);
    assert.equal(multitask.getWorker(settledFirst)?.status, "completed");

    // B: stop, then settle — late result is dropped.
    const stoppedFirst = await spawnRunning(host, multitask, "session-b");
    const stopB = await multitask.abortWorker(stoppedFirst);
    assert.deepEqual(stopB, { ok: true });
    host.fireSettled({
      workerId: stoppedFirst,
      status: "completed",
      report: "too late",
    });
    assert.equal(multitask.getWorker(stoppedFirst)?.status, "aborted");
    // Only A's completion woke anyone.
    assert.deepEqual(host.wakeCalls, ["session-a"]);
  });

  it("stopping a worker that has not started yet still aborts it cleanly", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-2",
      title: "Never started",
      prompt: "Wait.",
    });

    const result = await multitask.abortWorker(workerId);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(host.interruptCalls, [workerId]);
    assert.equal(multitask.getWorker(workerId)?.status, "aborted");
    assert.equal(host.sendMessageCalls.length, 0);
  });
});
