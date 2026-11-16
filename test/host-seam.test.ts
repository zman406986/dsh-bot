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
  it("a second settle for a terminal worker is ignored, and an unknown abort throws", async () => {
    // Late settle / unknown abort are the two places a host can double-fire.
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "late-settle",
        title: "Late settle",
        prompt: "Do the work.",
      }),
    );
    host.fireSettled({ workerId, status: "completed", report: "one" });
    const first = multitask.settleRecords.lookup("session-1", workerId);
    assert.ok(first);
    host.fireSettled({ workerId, status: "completed", report: "two" });
    assert.equal(multitask.getWorker(workerId)?.status, "completed");
    assert.deepEqual(host.wakeCalls, [], "neither settle opens a plugin wake");
    assert.deepEqual(
      multitask.settleRecords.lookup("session-1", workerId),
      first,
      "the second settle must not overwrite the record",
    );
    assert.equal(first.resultText, "one");

    await assert.rejects(() => multitask.abortWorker("never-spawned"));
    assert.deepEqual(host.interruptCalls, [], "an unknown abort must not interrupt");
  });

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

  it("a settled event updates the roster, opens no plugin wake, and leaves the todo open", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-1",
      title: "Build scaffold",
    });

    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Build scaffold",
        prompt: "Build it.",
        todoId: "todo-1",
      }),
    );

    multitask.noteTurnStarted(workerId);
    host.fireSettled({
      workerId,
      status: "completed",
      report: "Scaffold is in place.",
    });

    const worker = multitask.getWorker(workerId);
    assert.ok(worker);
    assert.equal(worker.status, "completed");
    // The stock completion notice is the parent-visible result; the plugin
    // opens no wake turn of its own.
    assert.deepEqual(host.wakeCalls, []);
    assert.equal(multitask.wakeBus.peek("session-1"), undefined);
    assert.equal(multitask.drainWake("session-1"), undefined);

    const settle = multitask.settleRecords.lookup("session-1", workerId);
    assert.ok(settle);
    assert.equal(settle.status, "completed");
    assert.equal(settle.resultText, "Scaffold is in place.");

    // A settle does not deliver: the obligation stays open and uncharged.
    const todo = multitask.todos.get("todo-1");
    assert.ok(todo);
    assert.equal(todo.status, "in_progress");
    assert.equal(todo.delivered, false);
    assert.equal(todo.redriveAttempts, 0);
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

  it("an unknown-state hold blocks only its own session's stream (ADR-0019)", async () => {
    const host = new FakeDshHost();
    const durability = createInMemoryDurability();
    // Simulate a previous life: worker "w-build" was live at crash time in
    // session-a only. `status: "running"` is the snapshot `rebuildFromDurability`
    // turns into unknown-state; there is no separate last-known field.
    durability.markers.set("w-build", {
      workerId: "w-build",
      parentSessionId: "session-a",
      streamKey: "build",
      title: "Crashed live",
      status: "running",
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

  /**
   * Fidelity (live `spawnDispatcher`): the core type makes the parent
   * mandatory, and the real adapter throws when no parent agent is bound. A
   * fake that minted an orphan id for the impossible input would let a test
   * claim a spawn the host can never serve.
   */
  it("spawnDispatcher refuses a missing or empty parent instead of minting an orphan id", async () => {
    const host = new FakeDshHost();

    await assert.rejects(
      () => host.spawnDispatcher({ title: "Peer", prompt: "Go." } as never),
      /parentSessionId/,
    );
    await assert.rejects(
      () =>
        host.spawnDispatcher({
          parentSessionId: "",
          title: "Peer",
          prompt: "Go.",
        }),
      /parentSessionId/,
    );
    assert.deepEqual(host.dispatcherSpawnCalls, []);

    // The legitimate shape still records exactly one dispatcher spawn, and
    // never enters the worker-call list.
    await host.spawnDispatcher({
      parentSessionId: "session-1",
      title: "Peer",
      prompt: "Go.",
    });
    assert.equal(host.dispatcherSpawnCalls.length, 1);
    assert.equal(host.spawnCalls.length, 0);
  });

  /**
   * Fidelity (live `interruptWorker`): the adapter resolves the worker's
   * spawning dispatcher and REJECTS when none is bound — the restart case.
   * The core has already transitioned the worker to `aborted`, so its
   * committed-abort catch must absorb that rejection and still report
   * `{ok:true}`: the stop is the core's state, not the host's answer.
   */
  it("interruptWorker rejects with no authority; the core's committed abort still returns ok", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const stoppedWithoutAuthority = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "no-authority",
        title: "Unbound",
        prompt: "Do it.",
      }),
    );
    const stoppedWithAuthority = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "authority",
        title: "Bound",
        prompt: "Do it.",
      }),
    );
    host.noInterruptAuthority.add(stoppedWithoutAuthority);

    // The direct seam refuses: exactly the live adapter's missing-parent
    // error, never a silent success.
    await assert.rejects(
      () => host.interruptWorker(stoppedWithoutAuthority),
      /CordisDshHost: no parent agent bound for worker .*the interrupt was not issued/,
    );

    // The core's committed-abort catch: the abort is already terminal, so
    // the rejection is logged and the stop still reports success.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    let withoutAuthority: Awaited<ReturnType<typeof multitask.abortWorker>>;
    let withAuthority: Awaited<ReturnType<typeof multitask.abortWorker>>;
    try {
      withoutAuthority = await multitask.abortWorker(stoppedWithoutAuthority);
      withAuthority = await multitask.abortWorker(stoppedWithAuthority);
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(withoutAuthority, { ok: true });
    assert.deepEqual(withAuthority, { ok: true });
    assert.ok(
      warnings.some(
        (line) =>
          line.includes(`interrupt for stopped worker ${stoppedWithoutAuthority} failed`) &&
          line.includes("no parent agent bound for worker"),
      ),
      "the missing authority is logged, not silently dropped",
    );

    assert.deepEqual(host.interruptCalls, [
      stoppedWithoutAuthority, // the direct refusal
      stoppedWithoutAuthority, // the core's caught attempt
      stoppedWithAuthority,
    ]);
    assert.deepEqual(host.interruptAuthorityCalls, [
      { workerId: stoppedWithoutAuthority, authorityAvailable: false },
      { workerId: stoppedWithoutAuthority, authorityAvailable: false },
      { workerId: stoppedWithAuthority, authorityAvailable: true },
    ]);
    // The core's stop is terminal either way — the missing authority only
    // means the host had nothing to interrupt.
    assert.equal(multitask.getWorker(stoppedWithoutAuthority)?.status, "aborted");
    assert.equal(multitask.getWorker(stoppedWithAuthority)?.status, "aborted");
  });

  /**
   * Fidelity (live `sendMessage`): the adapter throws "no parent agent bound;
   * cannot send" when it cannot resolve delivery authority. The core must not
   * read that as a successful steer: the correction stays parked and the next
   * step boundary retries it.
   */
  it("a failing sendMessage leaves the correction parked and retries at the next boundary", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "lost-send",
        title: "Lost delivery",
        prompt: "Take a step.",
      }),
    );
    multitask.noteTurnStarted(workerId);
    const refusal = new Error("CordisDshHost: no parent agent bound; cannot send");
    host.failNextSendMessage(refusal);

    assert.deepEqual(await multitask.steerWorker(workerId, "keep going"), {
      ok: true,
    });
    await host.fireStepBoundary(workerId);

    // The refused send is recorded as an attempt AND a failure. The worker is
    // still `steering` because `steer-injected` never ran.
    assert.equal(host.sendMessageCalls.length, 1);
    assert.equal(host.sendMessageFailures.length, 1);
    assert.equal(host.sendMessageFailures[0]?.workerId, workerId);
    assert.equal(multitask.getWorker(workerId)?.status, "steering");

    // Nothing was lost: the correction was peeked, not popped, so the next
    // boundary delivers the SAME text and only then claims the injection.
    await host.fireStepBoundary(workerId);
    assert.equal(host.sendMessageCalls.length, 2);
    assert.equal(host.sendMessageFailures.length, 1);
    assert.ok(host.sendMessageCalls[1]?.message.includes("keep going"));
    assert.equal(multitask.getWorker(workerId)?.status, "running");
  });

});
