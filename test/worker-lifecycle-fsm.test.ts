import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import type { SpawnOptions, SpawnResult } from "../src/core/types.js";

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

async function spawn(host: FakeDshHost, multitask: Multitask): Promise<string> {
  return unwrapSpawn(
    await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-1",
      title: "Lifecycle subject",
      prompt: "Do the work.",
    }),
  );
}

/**
 * Ticket 120: a host whose child starts DURING the spawn — it announces the
 * id and then reports the first turn running before `spawnWorker` resolves.
 * This is the real host's ordering (the status edge fires inside
 * `startActivation`), reproduced without timing.
 */
class FirstTurnDuringSpawnHost extends FakeDshHost {
  constructor(private readonly multitaskRef: () => Multitask) {
    super();
  }
  override async spawnWorker(
    prompt: string,
    opts: SpawnOptions,
  ): Promise<string> {
    const workerId = await super.spawnWorker(prompt, opts);
    // The core must already know this worker here — it registered from the
    // `onWorkerId` callback `super` invoked before returning.
    this.multitaskRef().noteTurnStarted(workerId);
    return workerId;
  }
}

/** Ticket 120: a turn starts, then the host refuses the spawn outright. */
class FailingAfterTurnHost extends FakeDshHost {
  constructor(private readonly multitaskRef: () => Multitask) {
    super();
  }
  override async spawnWorker(
    prompt: string,
    opts: SpawnOptions,
  ): Promise<string> {
    const workerId = await super.spawnWorker(prompt, opts);
    this.multitaskRef().noteTurnStarted(workerId);
    throw new Error("host refused the spawn");
  }
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

  /**
   * Ticket 120 (e2e finding s1): the host's child starts inside the spawn, so
   * its first `running` edge arrives BEFORE `spawnWorker` resolves. The core
   * must have registered the worker record by then — otherwise the edge is
   * dropped, the FSM stays `spawned` for the whole first turn, and every
   * steer/message is refused `not-running`.
   */
  it("a first turn that starts inside the spawn still moves the worker to running", async () => {
    let multitask: Multitask | null = null;
    const host = new FirstTurnDuringSpawnHost(() => {
      assert.ok(multitask !== null);
      return multitask;
    });
    multitask = createMultitask(host);

    const workerId = await spawn(host, multitask);

    // `spawned` was created early enough to accept the turn, and the
    // post-resolve path did not reset it.
    assert.equal(multitask.getWorker(workerId)?.status, "running");
    // Still exactly one worker, one spawn — no duplicate registration.
    assert.deepEqual(
      multitask.listWorkers("session-1").map((w) => w.workerId),
      [workerId],
    );
    assert.equal(host.spawnCalls.length, 1);
    // And the first turn is steerable, which is what s1 needed.
    assert.deepEqual(await multitask.steerWorker(workerId, "correct it"), {
      ok: true,
    });
  });

});
