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

  it("todo id is optional on spawn and stays null when omitted", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "No todo link",
      prompt: "Do it.",
    });

    assert.equal(multitask.getWorker(workerId)?.todoId, null);
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

  it("tool-call count starts at zero and only increments for the noted worker", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const a = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-a",
      title: "A",
      prompt: "A",
    });
    const b = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-b",
      title: "B",
      prompt: "B",
    });

    multitask.noteToolCall(a);
    multitask.noteToolCall(a);
    multitask.noteToolCall(b);

    const listed = multitask.listWorkers("session-1");
    const byId = new Map(listed.map((w) => [w.workerId, w.toolCallCount]));
    assert.equal(byId.get(a), 2);
    assert.equal(byId.get(b), 1);
  });

  it("noting a tool call for an unknown worker is ignored, not thrown", () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    assert.doesNotThrow(() => multitask.noteToolCall("ghost"));
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

  it("a spawn is refused while the live worker is still spawned (first turn not started)", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Not started",
      prompt: "Wait.",
    });

    const second = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Duplicate",
      prompt: "Second.",
    });

    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, "duplicate-stream-key");
    assert.equal(host.spawnCalls.length, 1);
  });

  it("a spawn is refused while the live worker is steering", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Steering",
      prompt: "Work.",
    });
    multitask.noteTurnStarted(workerId);
    multitask.noteSteerReceived(workerId);

    const second = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Duplicate",
      prompt: "Second.",
    });

    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, "duplicate-stream-key");
    assert.equal(host.spawnCalls.length, 1);
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

  it("a stream_key becomes reusable once its worker is aborted", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const first = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Doomed",
      prompt: "Work.",
    });
    multitask.noteTurnStarted(first);
    await multitask.abortWorker(first);
    assert.equal(multitask.getWorker(first)?.status, "aborted");

    const second = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Reuse after abort",
      prompt: "Again.",
    });

    assert.ok(second.ok);
    assert.equal(host.spawnCalls.length, 2);
  });

  it("a stream_key becomes reusable once its worker settles with error", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const first = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Fails",
      prompt: "Work.",
    });
    multitask.noteTurnStarted(first);
    host.fireSettled({
      workerId: first,
      status: "error",
      report: "boom",
    });

    const second = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Retry",
      prompt: "Again.",
    });

    assert.ok(second.ok);
    assert.equal(host.spawnCalls.length, 2);
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

describe("worker registry — terminal records", () => {
  it("records for terminal workers remain queryable but are no longer running", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = await spawnOk(multitask, {
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Finishes",
      prompt: "Work.",
    });
    multitask.noteTurnStarted(workerId);
    host.fireSettled({
      workerId,
      status: "completed",
      report: "all done",
      transcriptRef: "session://transcript-9",
    });

    // Queryable by id.
    const record = multitask.getWorker(workerId);
    assert.ok(record);
    assert.equal(record.status, "completed");
    assert.equal(record.transcriptRef, "session://transcript-9");

    // Still listed for the parent session, with terminal status.
    const listed = multitask.listWorkers("session-1");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, "completed");

    // Not counted as running: the stream key is free for a new spawn.
    const next = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Next round",
      prompt: "Again.",
    });
    assert.ok(next.ok);

    // The terminal record is untouched by the new spawn.
    assert.equal(multitask.getWorker(workerId)?.status, "completed");
    assert.equal(multitask.getWorker(workerId)?.transcriptRef, "session://transcript-9");
  });
});
