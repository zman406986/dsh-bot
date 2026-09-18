import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMultitask } from "../src/core/multitask.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createInMemoryDurability } from "../src/core/durability.js";
import type { SpawnResult } from "../src/core/types.js";

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

describe("multitask core ↔ DshHost seam", () => {
  it("spawnWorker is non-blocking, returns a host worker id, and records the spawn", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Research dsh profiles",
        prompt: "Look up how dsh profiles compose.",
      }),
    );

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

    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Build scaffold",
        prompt: "Build it.",
      }),
    );

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

    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Once",
        prompt: "Do it once.",
      }),
    );

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

    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Long job",
        prompt: "Take a while.",
      }),
    );

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

    unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-a",
        streamKey: "todo-a",
        title: "A",
        prompt: "A",
      }),
    );
    unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-b",
        streamKey: "todo-b",
        title: "B",
        prompt: "B",
      }),
    );

    assert.equal(multitask.listWorkers("session-a").length, 1);
    assert.equal(multitask.listWorkers("session-a")[0]?.title, "A");
    assert.equal(multitask.listWorkers("session-b").length, 1);
    assert.equal(multitask.listWorkers("session-c").length, 0);
  });

  it("the same model-authored stream_key in two sessions does not collide (ADR-0019)", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const first = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-a",
        streamKey: "build",
        title: "A build",
        prompt: "A",
      }),
    );
    const second = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-b",
        streamKey: "build",
        title: "B build",
        prompt: "B",
      }),
    );
    assert.notEqual(first, second);

    // Terminal frees the key for its OWN session only.
    host.fireSettled({ workerId: first, status: "completed", report: "done" });
    unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-a",
        streamKey: "build",
        title: "A build again",
        prompt: "A",
      }),
    );
    // The sibling's live worker still holds its session's key.
    const blocked = await multitask.spawnWorker({
      parentSessionId: "session-b",
      streamKey: "build",
      title: "B build twice",
      prompt: "B",
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.reason, "duplicate-stream-key");
      assert.ok(blocked.detail.includes(second));
    }
  });

  it("the same stream key twice within one session still refuses", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-a",
        streamKey: "build",
        title: "First",
        prompt: "go",
      }),
    );
    const refused = await multitask.spawnWorker({
      parentSessionId: "session-a",
      streamKey: "build",
      title: "Second",
      prompt: "go",
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, "duplicate-stream-key");
  });

  it("an unknown-state hold blocks only its own session's stream (ADR-0019)", async () => {
    const host = new FakeDshHost();
    const durability = createInMemoryDurability();
    // Simulate a previous life: worker "w-build" was live at crash time in
    // session-a only.
    durability.markers.set("w-build", {
      workerId: "w-build",
      parentSessionId: "session-a",
      streamKey: "build",
      title: "Crashed live",
      status: "running",
      lastKnownStatus: "running",
      transcriptRef: null,
      todoId: null,
      startedAtMs: 1_000,
      updatedAtMs: 2_000,
    });
    const multitask = createMultitask(host, { durability });
    await multitask.rebuildFromDurability("session-a");

    // Session-b's same-named stream is free; session-a's is held.
    const sibling = await multitask.spawnWorker({
      parentSessionId: "session-b",
      streamKey: "build",
      title: "B build",
      prompt: "B",
    });
    assert.ok(sibling.ok);
    const held = await multitask.spawnWorker({
      parentSessionId: "session-a",
      streamKey: "build",
      title: "A build",
      prompt: "A",
    });
    assert.equal(held.ok, false);
    if (!held.ok) {
      assert.equal(held.reason, "stream-key-held-by-unknown-state");
    }
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
