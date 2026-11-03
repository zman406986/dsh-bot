import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import type { SpawnRequest, SpawnResult } from "../src/core/types.js";

function unwrapSpawn(result: SpawnResult): string {
  if (!result.ok) {
    throw new Error(`spawn refused: ${result.detail}`);
  }
  return result.workerId;
}

async function spawnOk(
  multitask: Multitask,
  request: SpawnRequest,
): Promise<string> {
  return unwrapSpawn(await multitask.spawnWorker(request));
}

describe("worker registry — roster fields", () => {
  it("every spawn produces a worker record carrying id, parent session, stream key, title, status, start time, transcript ref, and todo id", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Research dsh profiles",
      prompt: "Look up how dsh profiles compose.",
      todoId: "todo-1",
    });

    const worker = multitask.getWorker(workerId);
    assert.ok(worker);
    assert.equal(worker.workerId, workerId);
    assert.equal(worker.parentSessionId, "session-1");
    assert.equal(worker.streamKey, "todo-1");
    assert.equal(worker.title, "Research dsh profiles");
    assert.equal(worker.status, "spawned");
    assert.equal(typeof worker.startedAtMs, "number");
    assert.ok(worker.startedAtMs > 0);
    assert.equal(worker.transcriptRef, null);
    assert.equal(worker.todoId, "todo-1");
    assert.equal(worker.toolCallCount, 0);
  });

});

describe("worker registry — listing", () => {
  it("listing a parent session returns elapsed time, tool-call count, and transcript reference for each worker", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Busy worker",
      prompt: "Work.",
    });

    multitask.noteTurnStarted(workerId);
    multitask.noteToolCall(workerId);
    multitask.noteToolCall(workerId);

    host.fireSettled({
      workerId,
      status: "completed",
      report: "all done",
      transcriptRef: "session://transcript-1",
    });

    const listed = multitask.listWorkers("session-1");
    assert.equal(listed.length, 1);
    const summary = listed[0];
    assert.ok(summary);
    assert.equal(summary.workerId, workerId);
    assert.equal(summary.parentSessionId, "session-1");
    assert.equal(summary.streamKey, "todo-1");
    assert.equal(summary.title, "Busy worker");
    assert.equal(summary.status, "completed");
    assert.equal(typeof summary.elapsedMs, "number");
    assert.ok(summary.elapsedMs >= 0);
    assert.equal(summary.toolCallCount, 2);
    assert.equal(summary.transcriptRef, "session://transcript-1");
  });

});

describe("worker registry — stream_key uniqueness", () => {
  it("a spawn for a stream_key that already has a live worker is refused and no second worker is created", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const first = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "First",
      prompt: "First.",
    });
    multitask.noteTurnStarted(first);

    const second = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Duplicate",
      prompt: "Second.",
    });

    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, "duplicate-stream-key");
    assert.ok(
      second.ok === false && second.detail.includes("todo-1"),
      "refusal should name the contested stream key",
    );
    // A second worker is never created for that stream.
    assert.equal(host.spawnCalls.length, 1);
    assert.equal(multitask.listWorkers("session-1").length, 1);
  });

  it("a stream_key becomes reusable once its worker reaches a terminal state via settle", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const first = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "First",
      prompt: "First.",
    });
    multitask.noteTurnStarted(first);
    host.fireSettled({
      workerId: first,
      status: "completed",
      report: "done",
    });
    assert.equal(multitask.getWorker(first)?.status, "completed");

    const second = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Reuse after complete",
      prompt: "Again.",
    });

    assert.ok(second.ok);
    assert.equal(host.spawnCalls.length, 2);
    // Both records exist; the first is terminal, the second is live.
    assert.equal(multitask.getWorker(first)?.status, "completed");
    assert.equal(multitask.getWorker(unwrapSpawn(second))?.status, "spawned");
  });

});

describe("worker registry — independent streams", () => {
  it("two different stream_keys spawn and run independently — neither waits on the other", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const a = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-a",
      title: "Stream A",
      prompt: "A",
    });
    const b = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-b",
      title: "Stream B",
      prompt: "B",
    });

    assert.notEqual(a, b);
    assert.equal(host.spawnCalls.length, 2);

    // Both reach running without waiting on each other.
    multitask.noteTurnStarted(a);
    multitask.noteTurnStarted(b);
    assert.equal(multitask.getWorker(a)?.status, "running");
    assert.equal(multitask.getWorker(b)?.status, "running");

    // Settling one leaves the other running.
    host.fireSettled({ workerId: a, status: "completed", report: "A done" });
    assert.equal(multitask.getWorker(a)?.status, "completed");
    assert.equal(multitask.getWorker(b)?.status, "running");

    // Stopping the other does not disturb the settled one.
    await multitask.abortWorker(b);
    assert.equal(multitask.getWorker(a)?.status, "completed");
    assert.equal(multitask.getWorker(b)?.status, "aborted");
  });
});

