import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toPeerNotice, type PeerEnvelope } from "../src/core/peer-types.js";
import {
  createWakeBus,
  type SettledWorkerNotice,
  type WakeBusDegradedInfo,
} from "../src/core/wake-bus.js";

/**
 * Ticket 108 — opt-in wake coalescing window (idle-window batching).
 *
 * With `coalesceWindowMs > 0`, idle background/peer enqueues share ONE
 * per-session drain per window instead of each firing its own wake turn;
 * enqueues landing inside the window join the pending batch. User wakes
 * preempt the window immediately (same discipline as the ticket-06
 * mid-turn hold). Timers are generation-checked: dispose bumps the
 * generation and a stale timer no-ops. A fail budget (default 3
 * consecutive failed coalesced deliveries) degrades the bus to immediate
 * mode — wakes are never dropped. The default (window 0) must stay
 * byte-identical to pre-108 behavior. All timing here runs on a manual
 * scheduler — no real timer may stay armed past a test.
 */

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

function settled(
  parentSessionId: string,
  workerId: string,
  title = "Task",
  resultText = "done",
): { parentSessionId: string } & SettledWorkerNotice {
  return { parentSessionId, workerId, status: "completed", title, resultText };
}

function peerNotice(id: string, priority: boolean) {
  const env: PeerEnvelope = {
    messageId: id,
    fromAgentId: `peer-${id}`,
    fromName: `Peer ${id}`,
    to: { kind: "agent", agentId: "dispatcher-1" },
    conversationId: "conv-1",
    text: `message ${id}`,
    priority,
    createdAtMs: 1_000,
  };
  return toPeerNotice(env, priority);
}

describe("wake bus coalescing — default off (ticket 108)", () => {
  it("window 0 (default) delivers immediately and arms no timer", () => {
    const delivered: string[] = [];
    const scheduler = createManualScheduler();
    const bus = createWakeBus({
      onDeliver: (id) => delivered.push(id),
      schedule: scheduler.schedule,
    });

    bus.enqueueWorkerSettled(settled("s1", "w1"));

    assert.deepEqual(delivered, ["s1"]);
    assert.equal(scheduler.scheduled.length, 0);
    const wake = bus.drain("s1");
    assert.ok(wake);
    assert.equal(wake.settledWorkers.length, 1);
  });

  it("window 0 keeps per-settle immediate delivery with no timer armed", () => {
    const delivered: string[] = [];
    const scheduler = createManualScheduler();
    const bus = createWakeBus({
      onDeliver: (id) => delivered.push(id),
      schedule: scheduler.schedule,
    });

    bus.enqueueWorkerSettled(settled("s1", "w1"));
    assert.deepEqual(delivered, ["s1"], "the first settle wakes at once");
    assert.ok(bus.drain("s1"), "the host takes the wake between turns");

    bus.enqueueWorkerSettled(settled("s1", "w2"));
    assert.deepEqual(delivered, ["s1", "s1"], "the next settle wakes at once too");
    assert.equal(scheduler.scheduled.length, 0, "no window timer at the default");
    assert.equal(bus.drain("s1")?.settledWorkers[0]?.workerId, "w2");
  });
});

describe("wake bus coalescing — window batching (ticket 108)", () => {
  it("three settles inside the window coalesce into exactly one delivery", () => {
    const delivered: string[] = [];
    const scheduler = createManualScheduler();
    const bus = createWakeBus({
      onDeliver: (id) => delivered.push(id),
      coalesceWindowMs: 50,
      now: () => 1_000,
      schedule: scheduler.schedule,
    });

    bus.enqueueWorkerSettled(settled("s1", "w1", "One", "r1"));
    bus.enqueueWorkerSettled(settled("s1", "w2", "Two", "r2"));
    bus.enqueueWorkerSettled(settled("s1", "w3", "Three", "r3"));

    assert.deepEqual(delivered, [], "nothing delivered before the window fires");
    assert.equal(scheduler.scheduled.length, 1, "one pending timer per session");
    assert.equal(scheduler.scheduled[0]?.ms, 50, "the timer is the window");

    scheduler.runAll();

    assert.deepEqual(delivered, ["s1"], "exactly one onDeliver");
    const wake = bus.drain("s1");
    assert.ok(wake);
    assert.equal(wake.settledWorkers.length, 3);
    assert.deepEqual(
      wake.settledWorkers.map((w) => w.workerId),
      ["w1", "w2", "w3"],
      "the batch carries all three settles in arrival order",
    );
  });

  it("windows are per session — sibling dispatchers coexist independently", () => {
    const delivered: string[] = [];
    const scheduler = createManualScheduler();
    const bus = createWakeBus({
      onDeliver: (id) => delivered.push(id),
      coalesceWindowMs: 50,
      schedule: scheduler.schedule,
    });

    bus.enqueueWorkerSettled(settled("s-a", "w1"));
    bus.enqueueWorkerSettled(settled("s-b", "w2"));

    assert.equal(scheduler.scheduled.length, 2, "one timer per session");
    scheduler.runAll();
    assert.deepEqual(delivered, ["s-a", "s-b"]);
    assert.equal(bus.drain("s-a")?.settledWorkers[0]?.workerId, "w1");
    assert.equal(bus.drain("s-b")?.settledWorkers[0]?.workerId, "w2");
  });

  it("a user wake mid-window flushes immediately and keeps the batch behind the user", () => {
    const delivered: string[] = [];
    const scheduler = createManualScheduler();
    const bus = createWakeBus({
      onDeliver: (id) => delivered.push(id),
      coalesceWindowMs: 50,
      schedule: scheduler.schedule,
    });

    bus.enqueueWorkerSettled(settled("s1", "w1"));
    bus.enqueueUserWake("s1");

    // The window timer was cancelled: firing it again must be inert.
    scheduler.runAll();

    const userWake = bus.drain("s1");
    assert.ok(userWake);
    assert.equal(userWake.source, "user", "the user wake is what is ready");

    // The window batch was not lost — it delivers after the user's turn.
    bus.noteTurnStarted("s1");
    bus.noteTurnEnded("s1");
    assert.deepEqual(delivered, ["s1", "s1"]);
    const batch = bus.drain("s1");
    assert.ok(batch);
    assert.equal(batch.source, "worker-settled");
    assert.equal(batch.settledWorkers[0]?.workerId, "w1");
  });

  it("a generation bump leaves an armed window timer a no-op; the bus keeps working", () => {
    const delivered: string[] = [];
    const scheduler = createManualScheduler();
    const bus = createWakeBus({
      onDeliver: (id) => delivered.push(id),
      coalesceWindowMs: 50,
      schedule: scheduler.schedule,
    });

    bus.enqueueWorkerSettled(settled("s1", "w1"));
    bus.dispose();

    assert.deepEqual(scheduler.cancelled, [0], "dispose cancelled the timer");
    scheduler.runAll();
    assert.deepEqual(delivered, [], "a stale timer must never fire");
    assert.equal(bus.drain("s1"), undefined);

    // New enqueues arm fresh (current-generation) windows and still deliver.
    // Dispose cancels timers, not data: the stale window's settle (w1) was
    // left pending and must ride the next flush — never dropped.
    bus.enqueueWorkerSettled(settled("s1", "w2"));
    scheduler.runAll();
    assert.deepEqual(delivered, ["s1"]);
    const wake = bus.drain("s1");
    assert.ok(wake);
    assert.deepEqual(
      wake.settledWorkers.map((w) => w.workerId),
      ["w1", "w2"],
      "dispose invalidates timers only; pending wakes still deliver",
    );
  });

  it("three consecutive failed coalesced deliveries degrade to immediate mode; nothing is dropped", () => {
    let calls = 0;
    const delivered: string[] = [];
    const degraded: WakeBusDegradedInfo[] = [];
    const scheduler = createManualScheduler();
    const bus = createWakeBus({
      onDeliver: (id) => {
        calls += 1;
        if (calls <= 3) throw new Error(`delivery ${calls} failed`);
        delivered.push(id);
      },
      coalesceWindowMs: 50,
      schedule: scheduler.schedule,
      coalesceFailBudget: 3,
      onDegraded: (info) => degraded.push(info),
    });

    // Three windows, each failing once. The host drains the ready wake
    // between windows (the flush marks ready before notifying, so the wake
    // survives even a failed delivery).
    for (const workerId of ["w1", "w2", "w3"]) {
      bus.enqueueWorkerSettled(settled("s1", workerId));
      scheduler.runAll();
      assert.ok(bus.drain("s1"), `${workerId} was still made ready`);
    }

    assert.equal(degraded.length, 1, "onDegraded fired exactly once");
    assert.equal(degraded[0]?.consecutiveFailures, 3);
    assert.ok(degraded[0]?.lastError instanceof Error);

    // Degraded mode: a new enqueue bypasses the window entirely.
    bus.enqueueWorkerSettled(settled("s1", "w4"));
    assert.equal(
      scheduler.scheduled.length,
      3,
      "no fourth window was armed after degrade",
    );
    assert.deepEqual(delivered, ["s1"], "the pending wake delivered immediately");
    const wake = bus.drain("s1");
    assert.ok(wake);
    assert.equal(wake.settledWorkers.length, 1);
    assert.equal(wake.settledWorkers[0]?.workerId, "w4");
  });

  it("peer priority rank order is preserved through a window flush", () => {
    const delivered: string[] = [];
    const scheduler = createManualScheduler();
    const bus = createWakeBus({
      onDeliver: (id) => delivered.push(id),
      coalesceWindowMs: 50,
      schedule: scheduler.schedule,
    });

    // One window: a settle, a priority peer, and a normal peer join it.
    bus.enqueueWorkerSettled(settled("s1", "w1"));
    bus.enqueuePeer({
      sessionId: "s1",
      notice: peerNotice("m2", true),
      effectivePriority: true,
    });
    bus.enqueuePeer({
      sessionId: "s1",
      notice: peerNotice("m3", false),
      effectivePriority: false,
    });
    assert.equal(scheduler.scheduled.length, 1, "all three joined one window");

    scheduler.runAll();
    assert.deepEqual(delivered, ["s1"], "one flush for the whole window");

    // Rank order: priority peer first, never mixed with settles.
    const priority = bus.drain("s1");
    assert.ok(priority);
    assert.equal(priority.source, "peer");
    assert.deepEqual(
      (priority.peerMessages ?? []).map((m) => m.messageId),
      ["m2"],
    );

    // Then the normal peer, then the settled batch — separate turns.
    bus.noteTurnStarted("s1");
    bus.noteTurnEnded("s1");
    const normal = bus.drain("s1");
    assert.ok(normal);
    assert.equal(normal.source, "peer");
    assert.deepEqual((normal.peerMessages ?? []).map((m) => m.messageId), ["m3"]);

    bus.noteTurnStarted("s1");
    bus.noteTurnEnded("s1");
    const batch = bus.drain("s1");
    assert.ok(batch);
    assert.equal(batch.source, "worker-settled");
    assert.equal(batch.settledWorkers[0]?.workerId, "w1");
    assert.deepEqual(delivered, ["s1", "s1", "s1"]);
  });
});
