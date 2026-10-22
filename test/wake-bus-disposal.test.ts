/**
 * Ticket 112 — wake-bus disposal reaches the core and is idempotent.
 *
 * Ticket 108 proved the bus's own `dispose()` (generation bump + timer
 * cancellation); this file proves the Multitask seam that shipped wiring
 * calls: `Multitask.dispose()` disarms a window armed under the ticket-108
 * coalescing option, a stale timer that still fires never wakes the host,
 * and a repeated dispose is a no-op. All timing runs on a manual scheduler —
 * no real timer may stay armed past a test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";

interface ManualScheduler {
  readonly scheduled: Array<{ fn: () => void; ms: number }>;
  readonly cancelled: number[];
  schedule(fn: () => void, ms: number): () => void;
  runAll(): void;
}

function createManualScheduler(): ManualScheduler {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const cancelled: number[] = [];
  return {
    scheduled,
    cancelled,
    schedule(fn, ms) {
      const index = scheduled.length;
      scheduled.push({ fn, ms });
      return () => {
        cancelled.push(index);
      };
    },
    runAll() {
      for (const entry of [...scheduled]) entry.fn();
    },
  };
}

async function spawnAndSettle(
  host: FakeDshHost,
  multitask: ReturnType<typeof createMultitask>,
): Promise<string> {
  const spawned = await multitask.spawnWorker({
    parentSessionId: "s-1",
    streamKey: "k-1",
    title: "Pending work",
    prompt: "Do the work.",
  });
  assert.ok(spawned.ok, spawned.ok ? "" : spawned.detail);
  host.fireSettled({
    workerId: spawned.workerId,
    status: "completed",
    report: "done",
  });
  return spawned.workerId;
}

describe("multitask disposal — wake bus teardown (ticket 112)", () => {
  it("dispose cancels an armed coalescing window and is idempotent", async () => {
    const host = new FakeDshHost();
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      wake: { coalesceWindowMs: 50, schedule: scheduler.schedule },
    });

    await spawnAndSettle(host, multitask);
    assert.deepEqual(host.wakeCalls, [], "the window holds the wake");
    assert.equal(scheduler.scheduled.length, 1, "one window timer per session");

    multitask.dispose();
    multitask.dispose();

    assert.deepEqual(
      scheduler.cancelled,
      [0],
      "the armed timer is cancelled exactly once — the second dispose finds none",
    );
    scheduler.runAll();
    assert.deepEqual(host.wakeCalls, [], "a stale timer never wakes the host");
    assert.equal(multitask.drainWake("s-1"), undefined);
  });

  it("dispose with nothing armed is a no-throw no-op", () => {
    const host = new FakeDshHost();
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      wake: { coalesceWindowMs: 50, schedule: scheduler.schedule },
    });

    assert.doesNotThrow(() => {
      multitask.dispose();
      multitask.dispose();
    });
    assert.equal(scheduler.scheduled.length, 0);
    assert.deepEqual(host.wakeCalls, []);
  });

  it("dispose invalidates timers only: a settle pending in the window survives", async () => {
    const host = new FakeDshHost();
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      wake: { coalesceWindowMs: 50, schedule: scheduler.schedule },
    });

    await spawnAndSettle(host, multitask);
    multitask.dispose();
    scheduler.runAll();

    // The stale window no-ops, but its notice is still queued on the bus.
    // Teardown is not a data drop: the next enqueue under the current
    // generation flushes both settles — never a lost result.
    await spawnAndSettle(host, multitask);
    scheduler.runAll();
    assert.deepEqual(host.wakeCalls, ["s-1"]);
    const wake = multitask.drainWake("s-1");
    assert.ok(wake);
    assert.equal(wake.wake.settledWorkers.length, 2);
  });
});
