import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMultitask } from "../src/core/multitask.js";
import { FakeDshHost } from "../src/core/fake-host.js";

describe("multitask core ↔ DshHost seam", () => {
  it("spawnWorker is non-blocking, returns a host worker id, and records the spawn", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Research dsh profiles",
      prompt: "Look up how dsh profiles compose.",
    });

    assert.equal(workerId, "fake-worker-1");
    assert.equal(host.spawnCalls.length, 1);
    const call = host.spawnCalls[0];
    assert.ok(call);
    assert.equal(call.prompt, "Look up how dsh profiles compose.");
    assert.equal(call.opts.parentSessionId, "session-1");
    assert.equal(call.opts.streamKey, "todo-1");
    assert.equal(call.opts.title, "Research dsh profiles");

    const worker = multitask.getWorker(workerId);
    assert.ok(worker);
    assert.equal(worker.status, "spawned");
    assert.equal(worker.parentSessionId, "session-1");
  });

  it("a settled event updates the roster and wakes the dispatcher exactly once", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Build scaffold",
      prompt: "Build it.",
    });

    host.fireSettled({
      workerId,
      status: "completed",
      report: "Scaffold is in place.",
    });

    const worker = multitask.getWorker(workerId);
    assert.ok(worker);
    assert.equal(worker.status, "completed");
    assert.deepEqual(host.wakeCalls, ["session-1"]);
  });

  it("a second settle for a terminal worker is ignored", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Once",
      prompt: "Do it once.",
    });

    host.fireSettled({ workerId, status: "completed", report: "first" });
    host.fireSettled({ workerId, status: "error", report: "second" });

    const worker = multitask.getWorker(workerId);
    assert.ok(worker);
    assert.equal(worker.status, "completed");
    assert.equal(host.wakeCalls.length, 1);
  });

  it("abortWorker interrupts through the host and drops a late settle", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Long job",
      prompt: "Take a while.",
    });

    await multitask.abortWorker(workerId);

    assert.deepEqual(host.interruptCalls, [workerId]);
    const worker = multitask.getWorker(workerId);
    assert.ok(worker);
    assert.equal(worker.status, "aborted");

    // Late result after stop must not revive the worker or wake anyone.
    host.fireSettled({ workerId, status: "completed", report: "too late" });
    assert.equal(multitask.getWorker(workerId)?.status, "aborted");
    assert.deepEqual(host.wakeCalls, []);
  });

  it("listWorkers filters by parent session", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    await multitask.spawnWorker({
      parentSessionId: "session-a",
      streamKey: "todo-a",
      title: "A",
      prompt: "A",
    });
    await multitask.spawnWorker({
      parentSessionId: "session-b",
      streamKey: "todo-b",
      title: "B",
      prompt: "B",
    });

    assert.equal(multitask.listWorkers("session-a").length, 1);
    assert.equal(multitask.listWorkers("session-a")[0]?.title, "A");
    assert.equal(multitask.listWorkers("session-b").length, 1);
    assert.equal(multitask.listWorkers("session-c").length, 0);
  });

  it("abortWorker on an unknown worker throws and does not interrupt", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    await assert.rejects(
      () => multitask.abortWorker("nope"),
      /unknown worker: nope/,
    );
    assert.deepEqual(host.interruptCalls, []);
  });
});
