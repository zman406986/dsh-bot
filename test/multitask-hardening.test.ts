/**
 * Review fixes — core hardening pins, all offline (S8).
 *
 * Each block pins one defect fix and is written against the observable core
 * behavior, never against an internal helper:
 * 1. A rejected/failed durability write or drop is owned by the core, never
 *    an unhandled rejection (which dsh treats as fatal).
 * 2. A step-boundary steer survives a failed send and is not lost, and a
 *    newer steer parked during an in-flight send is not dropped or
 *    double-delivered.
 * 3. A host seam rejection after the state is committed reports the truthful
 *    committed outcome instead of throwing.
 * 4. `awaitWorker` reports a terminal worker with no settle record instead of
 *    blocking to the timeout.
 * 5. `markDelivered` side effects fire once per obligation, while its
 *    idempotent marker cleanup can be retried after a store failure.
 * 6. Reclaim/adopt restore the ledger item (inbox origin included) and the
 *    durable redrive budget; a settle that lands before the rebuild is not
 *    lost.
 * 7. Releasing an unknown-state hold is durable-first, and a store failure is
 *    reported as `hold-release-failed` rather than as an unknown worker.
 * 8. Overlapping step boundaries deliver a parked steer once, and a failed
 *    send retries on a bounded timer without double delivery.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import {
  createInMemoryDurability,
  type DurableWorkerMarker,
  type InMemoryDurability,
} from "../src/core/durability.js";
import {
  createMultitask,
  type InboxJobResolution,
  type Multitask,
} from "../src/core/multitask.js";
import type { AgentMessageWakeOrigin } from "../src/core/peer-types.js";
import type { SpawnOptions, SpawnResult } from "../src/core/types.js";

const SESSION = "session-1";

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

async function spawnRunning(
  multitask: Multitask,
  streamKey = "stream-1",
  todoId?: string,
): Promise<string> {
  const workerId = unwrapSpawn(
    await multitask.spawnWorker({
      parentSessionId: SESSION,
      streamKey,
      title: "Hardening subject",
      prompt: "Do the work.",
      ...(todoId !== undefined ? { todoId } : {}),
    }),
  );
  multitask.noteTurnStarted(workerId);
  return workerId;
}

function markerFor(
  workerId: string,
  overrides: Partial<DurableWorkerMarker> = {},
): DurableWorkerMarker {
  return {
    workerId,
    parentSessionId: SESSION,
    streamKey: `stream-${workerId}`,
    title: `Work ${workerId}`,
    status: "running",
    transcriptRef: workerId,
    todoId: null,
    startedAtMs: 1,
    updatedAtMs: 2,
    ...overrides,
  };
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-scheduled rejection handler run. */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Collect unhandled rejections for the duration of one test. An unhandled
 * rejection is what the process-killing defect produced; a caught (logged)
 * failure leaves this list empty.
 */
function watchUnhandledRejections(): {
  readonly rejections: unknown[];
  stop(): void;
} {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", listener);
  return {
    rejections,
    stop: () => {
      process.off("unhandledRejection", listener);
    },
  };
}

/** Keep console output clean while still asserting a warning was logged. */
function captureWarnings(): { readonly messages: string[]; restore(): void } {
  const original = console.warn;
  const messages: string[] = [];
  console.warn = (...args: unknown[]): void => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.warn = original;
    },
  };
}

// --- host doubles ---------------------------------------------------------

class RejectingInterruptHost extends FakeDshHost {
  /** Interrupts that reject before the seam starts working. */
  failures = 1;

  override async interruptWorker(workerId: string): Promise<void> {
    this.interruptCalls.push(workerId);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("interrupt seam unavailable");
    }
  }
}

class RejectingWakeHost extends FakeDshHost {
  override async requestDispatcherWakeup(
    sessionId: string,
    origin?: AgentMessageWakeOrigin,
  ): Promise<void> {
    this.wakeCalls.push(sessionId);
    this.wakeOrigins.push({ sessionId, origin });
    throw new Error("wake seam unavailable");
  }
}

class GatedHost extends FakeDshHost {
  interruptGate: Deferred | null = null;
  sendGate: Deferred | null = null;

  override async interruptWorker(workerId: string): Promise<void> {
    this.interruptCalls.push(workerId);
    if (this.interruptGate !== null) await this.interruptGate.promise;
  }

  override async sendMessage(
    workerId: string,
    message: string,
  ): Promise<void> {
    this.sendMessageCalls.push({ workerId, message });
    if (this.sendGate !== null) await this.sendGate.promise;
  }
}

class SettleDuringSpawnHost extends FakeDshHost {
  override async spawnWorker(
    prompt: string,
    opts: SpawnOptions,
  ): Promise<string> {
    const workerId = await super.spawnWorker(prompt, opts);
    // The child settled while the spawn promise was still pending — exactly
    // the race ticket 120's early `onWorkerId` exists for.
    this.fireSettled({ workerId, status: "completed", report: "too fast" });
    return workerId;
  }
}

/** A durability store whose marker writes/drops can be made to fail. */
function failingStore(
  overrides: Partial<InMemoryDurability>,
): InMemoryDurability {
  return { ...createInMemoryDurability(), ...overrides };
}

describe("core hardening — durability failures are owned, never unhandled", () => {
  it("a rejecting marker store neither kills the flow nor leaks a rejection", async () => {
    const watcher = watchUnhandledRejections();
    const warnings = captureWarnings();
    try {
      const durability = failingStore({
        writeWorkerMarker: () => Promise.reject(new Error("marker store down")),
        deleteWorkerMarker: () => Promise.reject(new Error("marker store down")),
        deleteWorkerSession: () =>
          Promise.reject(new Error("wake row store down")),
      });
      const host = new FakeDshHost();
      const multitask = createMultitask(host, { durability });

      // Spawn: the marker write is awaited best-effort, so the spawn still
      // resolves and the worker stays live.
      const settled = await spawnRunning(multitask, "stream-settled");
      // Settle: the terminal marker write is fire-and-forget with a catch.
      host.fireSettled({
        workerId: settled,
        status: "completed",
        report: "done",
      });
      // Abort: the marker drop is fire-and-forget with a catch.
      const stopped = await spawnRunning(multitask, "stream-stopped");
      assert.deepEqual(await multitask.abortWorker(stopped), { ok: true });
      // Delivery: dropping the marker after delivery takes the same path.
      const deliveredTodo = multitask.createTodo({
        sessionId: SESSION,
        title: "Deliver me",
      });
      const delivered = await spawnRunning(
        multitask,
        "stream-delivered",
        deliveredTodo.id,
      );
      host.fireSettled({
        workerId: delivered,
        status: "completed",
        report: "done",
      });
      assert.equal(multitask.markDelivered(deliveredTodo.id, "answer"), true);
      // Redrive: persisting the spent budget is fire-and-forget with a catch.
      const redrivenTodo = multitask.createTodo({
        sessionId: SESSION,
        title: "Redrive me",
      });
      const redriven = await spawnRunning(
        multitask,
        "stream-redriven",
        redrivenTodo.id,
      );
      host.fireSettled({
        workerId: redriven,
        status: "completed",
        report: "done",
      });
      multitask.redriveUndelivered(SESSION);

      await settleMicrotasks();
      assert.deepEqual(
        watcher.rejections,
        [],
        "no store failure may become an unhandled rejection",
      );
      assert.ok(
        warnings.messages.some((message) => message.includes("marker store")),
        "each owned store failure is logged",
      );
      assert.equal(multitask.getWorker(stopped)?.status, "aborted");
    } finally {
      warnings.restore();
      watcher.stop();
    }
  });

  it("a rejecting async roster observer is swallowed", async () => {
    const watcher = watchUnhandledRejections();
    try {
      const host = new FakeDshHost();
      const multitask = createMultitask(host, {
        onRosterChanged: async () => {
          throw new Error("observer down");
        },
      });
      const workerId = await spawnRunning(multitask);
      host.fireSettled({
        workerId,
        status: "completed",
        report: "done",
      });
      await settleMicrotasks();
      assert.deepEqual(watcher.rejections, []);
    } finally {
      watcher.stop();
    }
  });

  it("a rejecting async inbox hook is swallowed", async () => {
    const watcher = watchUnhandledRejections();
    try {
      const host = new FakeDshHost();
      const multitask = createMultitask(host, {
        onInboxJobResolved: async () => {
          throw new Error("inbox writer down");
        },
      });
      const presented = multitask.enqueueExternalJob({
        sessionId: SESSION,
        jobId: "job-1",
        jobDir: "/jobs/job-1",
        promptText: "work",
      });
      assert.ok(presented.ok);
      const workerId = await spawnRunning(
        multitask,
        "stream-inbox",
        presented.todoId,
      );
      host.fireSettled({ workerId, status: "completed", report: "done" });
      assert.equal(multitask.markDelivered(presented.todoId, "answer"), true);
      await settleMicrotasks();
      assert.deepEqual(watcher.rejections, []);
    } finally {
      watcher.stop();
    }
  });
});

describe("core hardening — rejected host wakes stay counted, not thrown", () => {
  it("a rejecting dispatcher wakeup leaves the ready wake intact", async () => {
    const watcher = watchUnhandledRejections();
    try {
      const host = new RejectingWakeHost();
      const multitask = createMultitask(host);
      const workerId = await spawnRunning(multitask);

      host.fireSettled({ workerId, status: "completed", report: "done" });
      await settleMicrotasks();

      assert.deepEqual(watcher.rejections, []);
      assert.deepEqual(host.wakeCalls, [SESSION]);
      // The bus marked the wake ready BEFORE notifying, so a failed host
      // wake never drops it.
      const wake = multitask.wakeBus.peek(SESSION);
      assert.ok(wake);
      assert.equal(wake.settledWorkers[0]?.workerId, workerId);
    } finally {
      watcher.stop();
    }
  });
});

describe("core hardening — step-boundary steer delivery", () => {
  it("a failed send keeps the correction parked and retries at the next boundary", async () => {
    const warnings = captureWarnings();
    try {
      const host = new GatedHost();
      const multitask = createMultitask(host);
      const workerId = await spawnRunning(multitask);
      assert.deepEqual(await multitask.steerWorker(workerId, "keep it"), {
        ok: true,
      });
      assert.equal(multitask.getWorker(workerId)?.status, "steering");

      // First boundary: the send rejects. The correction is not lost.
      host.sendGate = deferred();
      const firstBoundary = host.fireStepBoundary(workerId);
      host.sendGate.reject(new Error("send failed"));
      await firstBoundary;

      assert.equal(host.sendMessageCalls.length, 1);
      assert.equal(
        multitask.getWorker(workerId)?.status,
        "steering",
        "a failed send does not complete the steer",
      );
      assert.ok(warnings.messages.some((m) => m.includes("stays parked")));

      // Second boundary: the same correction is delivered, once.
      host.sendGate = null;
      await host.fireStepBoundary(workerId);
      assert.equal(host.sendMessageCalls.length, 2);
      assert.ok(host.sendMessageCalls[1]?.message.includes("keep it"));
      assert.equal(multitask.getWorker(workerId)?.status, "running");
    } finally {
      warnings.restore();
    }
  });

  it("a newer steer parked during the send is preserved and delivered next", async () => {
    const host = new GatedHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask);
    assert.deepEqual(await multitask.steerWorker(workerId, "first"), {
      ok: true,
    });

    host.sendGate = deferred();
    const boundary = host.fireStepBoundary(workerId);
    // The send of "first" is in flight; a newer correction replaces the slot.
    assert.deepEqual(await multitask.steerWorker(workerId, "second"), {
      ok: true,
    });
    assert.equal(host.sendMessageCalls.length, 1);

    host.sendGate.resolve();
    await boundary;

    // "first" was delivered; "second" was not popped or double-delivered.
    assert.equal(host.sendMessageCalls.length, 1);
    assert.ok(host.sendMessageCalls[0]?.message.includes("first"));
    assert.equal(
      multitask.getWorker(workerId)?.status,
      "steering",
      "a newer correction keeps the worker steering",
    );

    host.sendGate = null;
    await host.fireStepBoundary(workerId);
    assert.equal(host.sendMessageCalls.length, 2);
    assert.ok(host.sendMessageCalls[1]?.message.includes("second"));
    assert.equal(multitask.getWorker(workerId)?.status, "running");
  });

  it("a newer steer whose only boundary arrives during the older send is still delivered", async () => {
    const host = new GatedHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask);
    assert.deepEqual(await multitask.steerWorker(workerId, "FIRST"), {
      ok: true,
    });
    assert.equal(multitask.getWorker(workerId)?.status, "steering");

    // FIRST's send is in flight. The worker observes "running" again while
    // it is held: in the FSM that is a no-op out of "steering".
    const gate = deferred();
    host.sendGate = gate;
    const firstBoundary = host.fireStepBoundary(workerId);
    multitask.noteTurnStarted(workerId);
    assert.deepEqual(await multitask.steerWorker(workerId, "SECOND"), {
      ok: true,
    });
    assert.deepEqual(
      host.interruptCalls,
      [workerId],
      "already steering: the newer correction does not re-interrupt",
    );

    // SECOND's only step boundary arrives inside FIRST's send window. The
    // in-flight guard skips it; no later boundary is emitted by this test.
    await host.fireStepBoundary(workerId);
    assert.equal(
      host.sendMessageCalls.length,
      1,
      "the skipped boundary sends nothing",
    );

    // FIRST succeeds. The successful send must still give the newer
    // correction its delivery opportunity.
    host.sendGate = null;
    gate.resolve();
    await firstBoundary;
    await settleMicrotasks();

    assert.equal(host.sendMessageCalls.length, 2, "SECOND is delivered");
    assert.ok(host.sendMessageCalls[1]?.message.includes("SECOND"));
    assert.equal(
      multitask.getWorker(workerId)?.status,
      "running",
      "no correction remains, so the worker is running again",
    );
  });

  it("two boundaries inside one send window deliver the correction exactly once", async () => {
    const host = new GatedHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask);
    assert.deepEqual(await multitask.steerWorker(workerId, "only once"), {
      ok: true,
    });

    host.sendGate = deferred();
    // Both boundaries are inside the same send window: the second is a
    // duplicate delivery point, not a new opportunity.
    const first = host.fireStepBoundary(workerId);
    const second = host.fireStepBoundary(workerId);
    assert.equal(host.sendMessageCalls.length, 1, "the second boundary is skipped");

    host.sendGate.resolve();
    await Promise.all([first, second]);
    assert.equal(host.sendMessageCalls.length, 1, "no duplicate delivery");
    assert.equal(multitask.getWorker(workerId)?.status, "running");

    // The parked slot is empty, so a later boundary sends nothing.
    host.sendGate = null;
    await host.fireStepBoundary(workerId);
    assert.equal(host.sendMessageCalls.length, 1);
  });

  it("a failed send parks the correction and a bounded retry delivers it once", async () => {
    const warnings = captureWarnings();
    try {
      const scheduled: Array<() => void> = [];
      const host = new FakeDshHost();
      const multitask = createMultitask(host, {
        steer: {
          // Manual scheduler: no real timer may stay armed past the test.
          schedule: (fn) => {
            scheduled.push(fn);
            return () => {};
          },
        },
      });
      const workerId = await spawnRunning(multitask);
      assert.deepEqual(await multitask.steerWorker(workerId, "retry me"), {
        ok: true,
      });

      host.failNextSendMessage(new Error("send seam down"));
      await host.fireStepBoundary(workerId);

      assert.equal(host.sendMessageCalls.length, 1);
      assert.equal(host.sendMessageFailures.length, 1);
      assert.equal(
        multitask.getWorker(workerId)?.status,
        "steering",
        "a failed send keeps the worker steerable",
      );
      assert.equal(scheduled.length, 1, "one bounded retry is armed");

      // The retry fires on the timer seam and succeeds.
      scheduled[0]?.();
      await settleMicrotasks();
      assert.equal(host.sendMessageCalls.length, 2);
      assert.ok(host.sendMessageCalls[1]?.message.includes("retry me"));
      assert.equal(multitask.getWorker(workerId)?.status, "running");

      // No second delivery after the retry succeeded.
      await host.fireStepBoundary(workerId);
      assert.equal(host.sendMessageCalls.length, 2);
      assert.ok(warnings.messages.some((m) => m.includes("stays parked")));
    } finally {
      warnings.restore();
    }
  });

  it("a failed retry is bounded, and a later real boundary still delivers", async () => {
    const warnings = captureWarnings();
    try {
      const scheduled: Array<() => void> = [];
      const host = new FakeDshHost();
      const multitask = createMultitask(host, {
        steer: {
          maxRetries: 1,
          schedule: (fn) => {
            scheduled.push(fn);
            return () => {};
          },
        },
      });
      const workerId = await spawnRunning(multitask);
      await multitask.steerWorker(workerId, "eventually");

      host.failNextSendMessage(new Error("first send down"));
      await host.fireStepBoundary(workerId);
      assert.equal(scheduled.length, 1, "the only allowed retry is armed");

      // The retry fails too: the bound is spent, so no endless timer.
      host.failNextSendMessage(new Error("retry down"));
      scheduled[0]?.();
      await settleMicrotasks();
      assert.equal(host.sendMessageCalls.length, 2);
      assert.equal(scheduled.length, 1, "no second retry was armed");
      assert.equal(multitask.getWorker(workerId)?.status, "steering");

      // A real step boundary is a fresh opportunity and delivers once.
      await host.fireStepBoundary(workerId);
      assert.equal(host.sendMessageCalls.length, 3);
      assert.equal(multitask.getWorker(workerId)?.status, "running");
    } finally {
      warnings.restore();
    }
  });
});

describe("core hardening — committed outcomes survive seam rejections", () => {
  it("stop reports the committed abort even when the interrupt rejects", async () => {
    const warnings = captureWarnings();
    try {
      const host = new RejectingInterruptHost();
      const multitask = createMultitask(host);
      const workerId = await spawnRunning(multitask);

      const stopped = await multitask.abortWorker(workerId);
      assert.deepEqual(stopped, { ok: true });
      assert.equal(multitask.getWorker(workerId)?.status, "aborted");
      assert.deepEqual(host.interruptCalls, [workerId]);
      assert.ok(warnings.messages.some((m) => m.includes("stopped worker")));
    } finally {
      warnings.restore();
    }
  });

  it("steer accepts the correction even when the interrupt rejects", async () => {
    const warnings = captureWarnings();
    try {
      const host = new RejectingInterruptHost();
      const multitask = createMultitask(host);
      const workerId = await spawnRunning(multitask);

      assert.deepEqual(await multitask.steerWorker(workerId, "carry on"), {
        ok: true,
      });
      assert.equal(multitask.getWorker(workerId)?.status, "steering");
      // The correction is still parked and delivered at the boundary.
      await host.fireStepBoundary(workerId);
      assert.equal(host.sendMessageCalls.length, 1);
      assert.ok(host.sendMessageCalls[0]?.message.includes("carry on"));
      assert.equal(multitask.getWorker(workerId)?.status, "running");
    } finally {
      warnings.restore();
    }
  });
});

describe("core hardening — await_agent on a terminal worker without a record", () => {
  it("a stopped worker resolves settled immediately instead of timing out", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask);
    assert.deepEqual(await multitask.abortWorker(workerId), { ok: true });

    const outcome = await multitask.awaitWorker(SESSION, workerId, 10);
    assert.ok(outcome.ok);
    if (!outcome.ok) return;
    assert.equal(outcome.status, "settled");
    if (outcome.status !== "settled") return;
    assert.equal(outcome.workerStatus, "aborted");
    assert.equal(outcome.result, "");
    assert.equal(outcome.waitedMs, 0);
  });

  it("a settle record still wins over the terminal-record fallback", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask);
    host.fireSettled({ workerId, status: "completed", report: "the result" });

    const outcome = await multitask.awaitWorker(SESSION, workerId, 10);
    assert.ok(outcome.ok);
    if (!outcome.ok || outcome.status !== "settled") return;
    assert.equal(outcome.workerStatus, "completed");
    assert.equal(outcome.result, "the result");
  });
});

describe("core hardening — markDelivered is one-shot in its side effects", () => {
  it("a repeat delivery neither re-projects the roster nor refires replied", async () => {
    const roster: string[] = [];
    const resolutions: InboxJobResolution[] = [];
    const host = new FakeDshHost();
    const multitask = createMultitask(host, {
      onRosterChanged: (sessionId) => {
        roster.push(sessionId);
      },
      onInboxJobResolved: (resolution) => {
        resolutions.push(resolution);
      },
    });
    const presented = multitask.enqueueExternalJob({
      sessionId: SESSION,
      jobId: "job-1",
      jobDir: "/jobs/job-1",
      promptText: "work",
    });
    assert.ok(presented.ok);
    const workerId = await spawnRunning(
      multitask,
      "stream-inbox",
      presented.todoId,
    );
    host.fireSettled({ workerId, status: "completed", report: "done" });

    assert.equal(multitask.markDelivered(presented.todoId, "answer"), true);
    const rosterAfterFirst = roster.length;
    assert.equal(
      resolutions.filter((resolution) => resolution.kind === "replied").length,
      1,
    );

    assert.equal(multitask.markDelivered(presented.todoId, "answer"), true);
    assert.equal(roster.length, rosterAfterFirst, "no second roster update");
    assert.equal(
      resolutions.filter((resolution) => resolution.kind === "replied").length,
      1,
      "one replied resolution per obligation",
    );
  });
});

describe("core hardening — markDelivered retries the idempotent cleanup", () => {
  it("a repeat call retries a failed marker drop without a second roster event", async () => {
    const warnings = captureWarnings();
    try {
      const roster: string[] = [];
      const resolutions: InboxJobResolution[] = [];
      let failures = 1;
      const store = createInMemoryDurability();
      const durability: InMemoryDurability = {
        ...store,
        deleteWorkerMarker: (workerId) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error("marker store down");
          }
          store.deleteWorkerMarker(workerId);
        },
      };
      const host = new FakeDshHost();
      const multitask = createMultitask(host, {
        durability,
        onRosterChanged: (sessionId) => {
          roster.push(sessionId);
        },
        onInboxJobResolved: (resolution) => {
          resolutions.push(resolution);
        },
      });
      const presented = multitask.enqueueExternalJob({
        sessionId: SESSION,
        jobId: "job-cleanup",
        jobDir: "/jobs/job-cleanup",
        promptText: "work",
      });
      assert.ok(presented.ok);
      const workerId = await spawnRunning(
        multitask,
        "stream-cleanup",
        presented.todoId,
      );
      host.fireSettled({ workerId, status: "completed", report: "done" });
      assert.equal(
        durability.markers.has(workerId),
        true,
        "the terminal marker exists before delivery",
      );

      // First delivery: the marker drop fails, so the obligation marker stays.
      assert.equal(multitask.markDelivered(presented.todoId, "answer"), true);
      assert.equal(
        durability.markers.has(workerId),
        true,
        "the failed drop leaves the marker behind",
      );
      const rosterAfterFirst = roster.length;

      // Second delivery: the cleanup is retried; the one-shot effects are not.
      assert.equal(multitask.markDelivered(presented.todoId, "answer"), true);
      assert.equal(
        durability.markers.has(workerId),
        false,
        "the repeat call retried the marker drop",
      );
      assert.equal(roster.length, rosterAfterFirst, "no duplicate roster event");
      assert.equal(
        resolutions.filter((resolution) => resolution.kind === "replied").length,
        1,
        "one replied resolution per obligation",
      );
      assert.ok(warnings.messages.some((m) => m.includes("marker store")));
    } finally {
      warnings.restore();
    }
  });
});

describe("core hardening — reclaim/adopt restore the ledger item", () => {
  it("reclaimWorker recreates the item and continues the redrive budget", async () => {
    const durability = createInMemoryDurability();
    durability.markers.set(
      "w-held",
      markerFor("w-held", {
        streamKey: "held-stream",
        todoId: "todo-7",
        redriveAttempts: 2,
      }),
    );
    const multitask = createMultitask(new FakeDshHost(), { durability });
    await multitask.rebuildFromDurability(SESSION);
    const hold = multitask.listUnknownStateHolds(SESSION)[0];
    assert.equal(hold?.redriveAttempts, 2, "the hold carries the budget");

    assert.equal(multitask.reclaimWorker("w-held", SESSION), true);
    const todo = multitask.todos.get("todo-7");
    assert.ok(todo, "the ledger item is recreated");
    assert.equal(todo.workerId, "w-held");
    assert.equal(todo.streamKey, "held-stream");
    assert.equal(todo.status, "in_progress");
    assert.equal(todo.redriveAttempts, 2, "the lifetime budget is preserved");
  });

  it("an inbox-origin hold reclaims with the same external and refuses a re-present", async () => {
    const durability = createInMemoryDurability();
    durability.markers.set(
      "w-inbox",
      markerFor("w-inbox", {
        streamKey: "inbox-stream",
        todoId: "todo-inbox",
        external: { kind: "inbox", jobId: "job-inbox", jobDir: "/jobs/job-inbox" },
      }),
    );
    const multitask = createMultitask(new FakeDshHost(), { durability });
    await multitask.rebuildFromDurability(SESSION);

    const hold = multitask.listUnknownStateHolds(SESSION)[0];
    assert.deepEqual(hold?.external, {
      kind: "inbox",
      jobId: "job-inbox",
      jobDir: "/jobs/job-inbox",
    });

    assert.equal(multitask.reclaimWorker("w-inbox", SESSION), true);
    const todo = multitask.todos.get("todo-inbox");
    assert.ok(todo, "the ledger item is recreated");
    assert.deepEqual(
      todo.external,
      { kind: "inbox", jobId: "job-inbox", jobDir: "/jobs/job-inbox" },
      "the reclaimed item keeps its intake provenance",
    );

    // With the origin intact, the same job is still recognized as presented.
    const again = multitask.enqueueExternalJob({
      sessionId: SESSION,
      jobId: "job-inbox",
      jobDir: "/jobs/job-inbox",
      promptText: "present me twice",
    });
    assert.deepEqual(again, { ok: false, reason: "duplicate-job" });
  });

  it("a hold whose worker never started restores a pending item", async () => {
    const durability = createInMemoryDurability();
    durability.markers.set(
      "w-spawned",
      markerFor("w-spawned", {
        status: "spawned",
        todoId: "todo-8",
        redriveAttempts: 1,
      }),
    );
    const multitask = createMultitask(new FakeDshHost(), { durability });
    await multitask.rebuildFromDurability(SESSION);
    assert.equal(multitask.reclaimWorker("w-spawned", SESSION), true);
    assert.equal(multitask.todos.get("todo-8")?.status, "pending");
  });

  it("adopted-before-rebuild recreates the item with its inbox origin", async () => {
    const durability = createInMemoryDurability();
    durability.markers.set(
      "w-adopt",
      markerFor("w-adopt", {
        todoId: "todo-9",
        redriveAttempts: 1,
        external: { kind: "inbox", jobId: "job-9", jobDir: "/jobs/job-9" },
      }),
    );
    const multitask = createMultitask(new FakeDshHost(), { durability });
    // A send landed before the rebuild ran: the host proved this worker live.
    assert.equal(multitask.reclaimWorker("w-adopt", SESSION), false);
    const report = await multitask.rebuildFromDurability(SESSION);
    assert.equal(report.restored.length, 1);

    const todo = multitask.todos.get("todo-9");
    assert.ok(todo, "the ledger item is recreated");
    assert.equal(todo.workerId, "w-adopt");
    assert.equal(todo.status, "in_progress");
    assert.equal(todo.redriveAttempts, 1);
    assert.deepEqual(todo.external, {
      kind: "inbox",
      jobId: "job-9",
      jobDir: "/jobs/job-9",
    });
  });
});

describe("core hardening — a settle inside the adopt-before-rebuild window", () => {
  it("is replayed when the rebuild restores the adopted record", async () => {
    const durability = createInMemoryDurability();
    durability.markers.set(
      "w-adopt-settle",
      markerFor("w-adopt-settle", {
        status: "running",
        streamKey: "adopt-stream",
        todoId: "todo-adopt",
      }),
    );
    const host = new FakeDshHost();
    const multitask = createMultitask(host, { durability });

    // A send landed before the rebuild: the host proved the worker live, so
    // this core remembers the id without a roster record.
    assert.equal(multitask.reclaimWorker("w-adopt-settle", SESSION), false);
    assert.equal(multitask.getWorker("w-adopt-settle"), undefined);

    // The worker settles before the rebuild restores it. Dropping this event
    // would rebuild the worker as live and hold its stream key forever.
    host.fireSettled({
      workerId: "w-adopt-settle",
      status: "completed",
      report: "the answer",
    });
    // A duplicate settle in the same window is still one outcome.
    host.fireSettled({
      workerId: "w-adopt-settle",
      status: "error",
      report: "second settle",
    });

    const report = await multitask.rebuildFromDurability(SESSION);
    assert.equal(report.restored.length, 1);

    const record = multitask.getWorker("w-adopt-settle");
    assert.ok(record, "the adopted worker is restored");
    assert.equal(record.status, "completed", "the terminal settle is applied");
    const settle = multitask.settleRecords.lookup(SESSION, "w-adopt-settle");
    assert.ok(settle, "the settle record is written");
    assert.equal(settle.status, "completed");
    assert.equal(settle.resultText, "the answer", "first settle wins");

    // The wake is enqueued exactly once, carrying the settle.
    assert.deepEqual(host.wakeCalls, [SESSION]);
    const wake = multitask.wakeBus.peek(SESSION);
    assert.ok(wake);
    assert.equal(wake.settledWorkers.length, 1);
    assert.equal(wake.settledWorkers[0]?.workerId, "w-adopt-settle");

    // The stream key is free because the worker is provably terminal.
    const reSpawn = await multitask.spawnWorker({
      parentSessionId: SESSION,
      streamKey: "adopt-stream",
      title: "Re-dispatched",
      prompt: "Do it again.",
    });
    assert.equal(reSpawn.ok, true, reSpawn.ok ? "" : reSpawn.detail);

    // The replayed settle took the ordinary terminal path: the linked ledger
    // item still exists and still points at the worker (delivery is owed).
    const todo = multitask.todos.get("todo-adopt");
    assert.ok(todo);
    assert.equal(todo.workerId, "w-adopt-settle");
    assert.equal(todo.delivered, false);
  });

  it("an aborted settle in the window closes the linked todo", async () => {
    const durability = createInMemoryDurability();
    durability.markers.set(
      "w-adopt-aborted",
      markerFor("w-adopt-aborted", {
        streamKey: "aborted-stream",
        todoId: "todo-aborted",
      }),
    );
    const host = new FakeDshHost();
    const multitask = createMultitask(host, { durability });

    multitask.reclaimWorker("w-adopt-aborted", SESSION);
    host.fireSettled({
      workerId: "w-adopt-aborted",
      status: "aborted",
      report: "stopped",
    });
    await multitask.rebuildFromDurability(SESSION);

    assert.equal(multitask.getWorker("w-adopt-aborted")?.status, "aborted");
    // `cancelLinkedTodo` prunes a cancelled item (dsh has no cancelled state).
    assert.equal(multitask.todos.get("todo-aborted"), undefined);
    assert.equal(durability.markers.has("w-adopt-aborted"), false);
  });
});

describe("core hardening — a sibling parent's rebuild keeps a buffered settle", () => {
  it("parent A's rebuild does not drop parent B's buffered settle", async () => {
    const PARENT_A = "session-a";
    const PARENT_B = "session-b";
    const base = createInMemoryDurability();
    // Both workers are live at the shared core's boot: one per dispatcher.
    base.markers.set(
      "w-sibling-a",
      markerFor("w-sibling-a", {
        parentSessionId: PARENT_A,
        streamKey: "sibling-stream-a",
      }),
    );
    base.markers.set(
      "w-sibling-b",
      markerFor("w-sibling-b", {
        parentSessionId: PARENT_B,
        streamKey: "sibling-stream-b",
        todoId: "todo-sibling-b",
      }),
    );
    // Each parent's marker read is held independently, so the two rebuilds
    // can be released in either order (the interleaving ticket 191 describes).
    const reads = new Map<string, Deferred>([
      [PARENT_A, deferred()],
      [PARENT_B, deferred()],
    ]);
    const durability: InMemoryDurability = {
      ...base,
      readWorkerMarkers(parentSessionId: string) {
        const gate = reads.get(parentSessionId);
        if (gate === undefined) return base.readWorkerMarkers(parentSessionId);
        return gate.promise.then(() =>
          base.readWorkerMarkers(parentSessionId),
        );
      },
    };
    const host = new FakeDshHost();
    const multitask = createMultitask(host, { durability });

    // A send landed for each worker before its rebuild: both are adopted, so
    // neither has a roster record yet.
    assert.equal(multitask.reclaimWorker("w-sibling-a", PARENT_A), false);
    assert.equal(multitask.reclaimWorker("w-sibling-b", PARENT_B), false);
    assert.equal(multitask.getWorker("w-sibling-b"), undefined);

    // B's worker finishes inside B's adopt-before-rebuild window: its
    // terminal event is buffered on the one shared core instance.
    host.fireSettled({
      workerId: "w-sibling-b",
      status: "completed",
      report: "B's answer",
    });

    // Both rebuilds are in flight, both marker reads pending.
    const rebuildA = multitask.rebuildFromDurability(PARENT_A);
    const rebuildB = multitask.rebuildFromDurability(PARENT_B);
    reads.get(PARENT_A)?.resolve();
    await rebuildA;
    // A's sweep has run. B's read is still pending, so B has no record yet.
    assert.equal(multitask.getWorker("w-sibling-b"), undefined);

    // Releasing B must still find B's buffered terminal event and replay it.
    reads.get(PARENT_B)?.resolve();
    const reportB = await rebuildB;
    assert.equal(reportB.restored.length, 1);

    const record = multitask.getWorker("w-sibling-b");
    assert.ok(record, "B's adopted worker is restored");
    assert.equal(
      record.status,
      "completed",
      "A's cleanup did not swallow B's buffered settle",
    );
    const settle = multitask.settleRecords.lookup(PARENT_B, "w-sibling-b");
    assert.ok(settle, "the settle record is written for B, not A");
    assert.equal(settle.status, "completed");
    assert.equal(settle.resultText, "B's answer", "the buffered event is replayed");

    // Exactly one settle wake, and it belongs to B.
    assert.deepEqual(host.wakeCalls, [PARENT_B]);
    const wake = multitask.wakeBus.peek(PARENT_B);
    assert.ok(wake);
    assert.equal(wake.settledWorkers.length, 1);
    assert.equal(wake.settledWorkers[0]?.workerId, "w-sibling-b");

    // The terminal replay released B's stream key.
    const reSpawn = await multitask.spawnWorker({
      parentSessionId: PARENT_B,
      streamKey: "sibling-stream-b",
      title: "Re-dispatched",
      prompt: "Do it again.",
    });
    assert.equal(reSpawn.ok, true, reSpawn.ok ? "" : reSpawn.detail);

    // The linked todo keeps B's delivery obligation.
    const todo = multitask.todos.get("todo-sibling-b");
    assert.ok(todo);
    assert.equal(todo.workerId, "w-sibling-b");
    assert.equal(todo.delivered, false);
  });
});

describe("core hardening — hold release is durable-first", () => {
  it("keeps the in-memory hold when the marker drop rejects", async () => {
    const warnings = captureWarnings();
    try {
      const durability = failingStore({
        deleteWorkerMarker: () =>
          Promise.reject(new Error("marker store down")),
      });
      // The store's own map is the one its reader closure uses.
      durability.markers.set("w-held", markerFor("w-held"));
      const multitask = createMultitask(new FakeDshHost(), { durability });
      await multitask.rebuildFromDurability(SESSION);
      assert.equal(multitask.listUnknownStateHolds(SESSION).length, 1);

      assert.equal(await multitask.releaseUnknownStateHold("w-held"), false);
      assert.equal(
        multitask.listUnknownStateHolds(SESSION).length,
        1,
        "memory and disk agree: the hold was not released",
      );
      assert.ok(warnings.messages.some((m) => m.includes("marker store")));
    } finally {
      warnings.restore();
    }
  });

  it("reports a store failure as hold-release-failed, not as not-held", async () => {
    const warnings = captureWarnings();
    try {
      const durability = failingStore({
        deleteWorkerMarker: () =>
          Promise.reject(new Error("marker store down")),
      });
      durability.markers.set("w-held", markerFor("w-held"));
      const multitask = createMultitask(new FakeDshHost(), { durability });
      await multitask.rebuildFromDurability(SESSION);

      const notHeld =
        await multitask.releaseUnknownStateHoldOutcome("nobody");
      assert.equal(notHeld.ok, false);
      assert.equal(notHeld.ok ? "" : notHeld.reason, "not-held");

      const failed = await multitask.releaseUnknownStateHoldOutcome("w-held");
      assert.equal(failed.ok, false);
      assert.equal(
        failed.ok ? "" : failed.reason,
        "hold-release-failed",
        "a store failure is distinct from an unknown worker",
      );
      assert.ok(
        (failed.ok ? "" : failed.detail).includes("still held"),
        "the detail says the stream key is still occupied",
      );
      // The boolean shape is unchanged and the hold was not released.
      assert.equal(await multitask.releaseUnknownStateHold("w-held"), false);
      assert.equal(multitask.listUnknownStateHolds(SESSION).length, 1);
      assert.ok(warnings.messages.some((m) => m.includes("marker store")));
    } finally {
      warnings.restore();
    }
  });
});

describe("core hardening — spawn survives a marker store failure", () => {
  it("an accepted spawn is not turned into a tool error by a failed write", async () => {
    const warnings = captureWarnings();
    try {
      const durability = failingStore({
        writeWorkerMarker: () => Promise.reject(new Error("marker store down")),
      });
      const multitask = createMultitask(new FakeDshHost(), { durability });

      const spawned = await multitask.spawnWorker({
        parentSessionId: SESSION,
        streamKey: "stream-1",
        title: "Live but unmarked",
        prompt: "Do the work.",
      });
      assert.equal(spawned.ok, true);
      if (!spawned.ok) return;
      assert.equal(multitask.getWorker(spawned.workerId)?.status, "spawned");

      // The stream key is still held: a failed marker never frees live work.
      const duplicate = await multitask.spawnWorker({
        parentSessionId: SESSION,
        streamKey: "stream-1",
        title: "Duplicate",
        prompt: "x",
      });
      assert.equal(duplicate.ok, false);
      assert.equal(
        duplicate.ok ? "" : duplicate.reason,
        "duplicate-stream-key",
      );
      assert.ok(warnings.messages.some((m) => m.includes("marker store")));
    } finally {
      warnings.restore();
    }
  });

  it("skips the marker write for a worker that settled during the spawn", async () => {
    const store = createInMemoryDurability();
    const writes: DurableWorkerMarker[] = [];
    const durability: InMemoryDurability = {
      ...store,
      writeWorkerMarker: (marker) => {
        writes.push(marker);
        store.writeWorkerMarker(marker);
      },
    };
    const host = new SettleDuringSpawnHost();
    const multitask = createMultitask(host, { durability });

    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: SESSION,
        streamKey: "stream-fast",
        title: "Too fast",
        prompt: "Do the work.",
      }),
    );

    // Exactly one write: the settle path's terminal marker. The spawn path
    // must not overwrite it with a fresh-spawn snapshot.
    assert.deepEqual(
      writes.map((marker) => marker.status),
      ["completed"],
    );
    assert.equal(multitask.getWorker(workerId)?.status, "completed");
    // No wake identity for an already-terminal worker (ticket 04).
    assert.equal(durability.workerSessions.has(workerId), false);
  });
});
