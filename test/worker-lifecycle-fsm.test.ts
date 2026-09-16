import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";

async function spawn(host: FakeDshHost, multitask: Multitask): Promise<string> {
  return multitask.spawnWorker({
    parentSessionId: "session-1",
    streamKey: "todo-1",
    title: "Lifecycle subject",
    prompt: "Do the work.",
  });
}

describe("worker lifecycle FSM (observable via multitask + fake host)", () => {
  it("a worker moves spawned → running when its first turn starts", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawn(host, multitask);
    assert.equal(multitask.getWorker(workerId)?.status, "spawned");

    multitask.noteTurnStarted(workerId);
    assert.equal(multitask.getWorker(workerId)?.status, "running");
    // Lifecycle notices do not talk to the host.
    assert.deepEqual(host.spawnCalls.length, 1);
    assert.deepEqual(host.interruptCalls, []);
    assert.deepEqual(host.wakeCalls, []);
  });

  it("a running worker moves into steering on a steer and back to running when the steer is injected", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawn(host, multitask);
    multitask.noteTurnStarted(workerId);

    multitask.noteSteerReceived(workerId);
    assert.equal(multitask.getWorker(workerId)?.status, "steering");

    multitask.noteSteerInjected(workerId);
    assert.equal(multitask.getWorker(workerId)?.status, "running");
  });

  it("a worker reaches completed, error, or aborted and stays there — no transition leaves a terminal state", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    // completed via settle
    const completedId = await spawn(host, multitask);
    multitask.noteTurnStarted(completedId);
    host.fireSettled({ workerId: completedId, status: "completed", report: "done" });
    assert.equal(multitask.getWorker(completedId)?.status, "completed");

    // error via settle
    const errorId = await spawn(host, multitask);
    multitask.noteTurnStarted(errorId);
    host.fireSettled({ workerId: errorId, status: "error", report: "boom" });
    assert.equal(multitask.getWorker(errorId)?.status, "error");

    // aborted via stop
    const abortedId = await spawn(host, multitask);
    multitask.noteTurnStarted(abortedId);
    await multitask.abortWorker(abortedId);
    assert.equal(multitask.getWorker(abortedId)?.status, "aborted");

    // Every terminal worker rejects further lifecycle movement.
    for (const workerId of [completedId, errorId, abortedId]) {
      const before = multitask.getWorker(workerId)?.status;
      multitask.noteTurnStarted(workerId);
      multitask.noteSteerReceived(workerId);
      multitask.noteSteerInjected(workerId);
      assert.equal(multitask.getWorker(workerId)?.status, before);
    }

    // abort on an already-terminal worker is a no-op (no second interrupt).
    const interruptsBefore = host.interruptCalls.length;
    await multitask.abortWorker(completedId);
    await multitask.abortWorker(errorId);
    await multitask.abortWorker(abortedId);
    assert.equal(host.interruptCalls.length, interruptsBefore);
    assert.equal(multitask.getWorker(completedId)?.status, "completed");
    assert.equal(multitask.getWorker(errorId)?.status, "error");
    assert.equal(multitask.getWorker(abortedId)?.status, "aborted");
  });

  it("a second settle for an already-terminal worker is ignored — no second wake, no overwritten status, no throw", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawn(host, multitask);
    multitask.noteTurnStarted(workerId);

    host.fireSettled({ workerId, status: "completed", report: "first" });
    assert.equal(host.wakeCalls.length, 1);

    assert.doesNotThrow(() => {
      host.fireSettled({ workerId, status: "error", report: "second" });
      host.fireSettled({ workerId, status: "aborted", report: "third" });
    });

    assert.equal(multitask.getWorker(workerId)?.status, "completed");
    assert.deepEqual(host.wakeCalls, ["session-1"]);
  });

  it("stopping a worker while it is steering aborts it cleanly", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawn(host, multitask);
    multitask.noteTurnStarted(workerId);
    multitask.noteSteerReceived(workerId);
    assert.equal(multitask.getWorker(workerId)?.status, "steering");

    await multitask.abortWorker(workerId);

    assert.deepEqual(host.interruptCalls, [workerId]);
    assert.equal(multitask.getWorker(workerId)?.status, "aborted");

    // A settle that races the stop is dropped.
    host.fireSettled({ workerId, status: "completed", report: "too late" });
    assert.equal(multitask.getWorker(workerId)?.status, "aborted");
    assert.deepEqual(host.wakeCalls, []);
  });

  it("illegal lifecycle notices on a live worker are ignored, not thrown", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawn(host, multitask);

    // steer cannot arrive before the first turn
    assert.doesNotThrow(() => multitask.noteSteerReceived(workerId));
    assert.equal(multitask.getWorker(workerId)?.status, "spawned");

    // inject without a parked steer does nothing
    assert.doesNotThrow(() => multitask.noteSteerInjected(workerId));
    assert.equal(multitask.getWorker(workerId)?.status, "spawned");

    multitask.noteTurnStarted(workerId);
    // second turn-started is not a restart
    multitask.noteTurnStarted(workerId);
    assert.equal(multitask.getWorker(workerId)?.status, "running");

    // inject without steer-received
    assert.doesNotThrow(() => multitask.noteSteerInjected(workerId));
    assert.equal(multitask.getWorker(workerId)?.status, "running");
  });

  it("a settle while the worker is steering still completes and wakes once", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawn(host, multitask);
    multitask.noteTurnStarted(workerId);
    multitask.noteSteerReceived(workerId);

    host.fireSettled({ workerId, status: "completed", report: "finished mid-steer" });

    assert.equal(multitask.getWorker(workerId)?.status, "completed");
    assert.deepEqual(host.wakeCalls, ["session-1"]);
  });

  it("lifecycle notices for an unknown worker are ignored", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    assert.doesNotThrow(() => multitask.noteTurnStarted("ghost"));
    assert.doesNotThrow(() => multitask.noteSteerReceived("ghost"));
    assert.doesNotThrow(() => multitask.noteSteerInjected("ghost"));
    assert.equal(multitask.getWorker("ghost"), undefined);
  });
});
