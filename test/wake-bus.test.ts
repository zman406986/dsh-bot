import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  createWakeBus,
  WAKE_SOURCES,
  type WakeBus,
  type WakeEvent,
  type WakeSource,
} from "../src/core/wake-bus.js";
import type { SpawnResult } from "../src/core/types.js";

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

async function spawnRunning(
  multitask: Multitask,
  parentSessionId: string,
  streamKey: string,
  title: string,
): Promise<string> {
  const workerId = unwrapSpawn(
    await multitask.spawnWorker({
      parentSessionId,
      streamKey,
      title,
      prompt: "Do the work.",
    }),
  );
  multitask.noteTurnStarted(workerId);
  return workerId;
}

function settled(
  parentSessionId: string,
  workerId: string,
  title = "Task",
  resultText = "done",
  status: "completed" | "error" | "aborted" = "completed",
): Parameters<WakeBus["enqueueWorkerSettled"]>[0] {
  return { parentSessionId, workerId, status, title, resultText };
}

describe("wake bus — the settle path opens no plugin wake", () => {
  // The old "an idle parent session is woken once for a single settle" unit
  // pin died with the plugin settle wake itself: `enqueueWorkerSettled` has
  // no production caller left (the stock completion notice is the one
  // parent-visible result). The contract now lives in
  // test/settle-single-notice.test.ts; the bus method remains exercised by
  // the hold/batching/peer suites in this file and wake-bus-{coalesce,peer}.
  it("a duplicate settle opens no plugin wake and keeps the first settle record", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Once");

    host.fireSettled({ workerId, status: "completed", report: "first" });
    const first = multitask.settleRecords.lookup("session-1", workerId);
    assert.ok(first);

    assert.doesNotThrow(() => {
      host.fireSettled({ workerId, status: "completed", report: "second" });
    });

    // Zero plugin wakes, ready or pending: the stock completion notice is the
    // only parent-visible result now.
    assert.deepEqual(host.wakeCalls, []);
    assert.equal(multitask.wakeBus.peek("session-1"), undefined);
    assert.equal(multitask.wakeBus.peekPending("session-1"), undefined);
    assert.equal(multitask.drainWake("session-1"), undefined);

    // One worker, one record; the duplicate changed neither, and the first
    // report is what the result channel carries.
    assert.equal(multitask.listWorkers("session-1").length, 1);
    assert.equal(multitask.getWorker(workerId)?.status, "completed");
    assert.deepEqual(multitask.settleRecords.lookup("session-1", workerId), first);
    assert.equal(first.status, "completed");
    assert.equal(first.resultText, "first");
  });

  it("a settle after an abort never reaches the bus — no second wake", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Stopped");

    await multitask.abortWorker(workerId);
    host.fireSettled({ workerId, status: "completed", report: "too late" });

    assert.deepEqual(host.wakeCalls, []);
    assert.equal(multitask.wakeBus.drain("session-1"), undefined);
  });
});

describe("wake bus — parent session routing", () => {
  it("a settle opens no wake; a peer wake still routes only to its own session", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const a = await spawnRunning(multitask, "session-a", "todo-a", "For A");
    const b = await spawnRunning(multitask, "session-b", "todo-b", "For B");

    host.fireSettled({ workerId: a, status: "completed", report: "A done" });
    host.fireSettled({ workerId: b, status: "error", report: "B failed" });

    // No plugin settle wake for either dispatcher.
    assert.deepEqual(host.wakeCalls, []);
    assert.equal(multitask.wakeBus.peek("session-a"), undefined);
    assert.equal(multitask.wakeBus.peek("session-b"), undefined);
    assert.equal(multitask.drainWake("session-a"), undefined);
    assert.equal(multitask.drainWake("session-b"), undefined);

    // Each settle record stays under its own parent session.
    const recordA = multitask.settleRecords.lookup("session-a", a);
    assert.ok(recordA);
    assert.equal(recordA.status, "completed");
    assert.equal(recordA.resultText, "A done");
    const recordB = multitask.settleRecords.lookup("session-b", b);
    assert.ok(recordB);
    assert.equal(recordB.status, "error");
    assert.equal(recordB.resultText, "B failed");
    assert.equal(multitask.settleRecords.lookup("session-a", b), undefined);
    assert.equal(multitask.settleRecords.lookup("session-b", a), undefined);

    // Parent routing survives on the peer lane (a live path through
    // wakeBus.enqueuePeer from sendPeer): a wake for A never touches B.
    multitask.wakeBus.enqueuePeer({
      sessionId: "session-a",
      notice: {
        messageId: "p-a",
        fromAgentId: "peer-a",
        fromName: "Peer A",
        to: { kind: "agent", agentId: "session-a" },
        conversationId: "c-a",
        text: "only for A",
        priority: false,
        createdAtMs: 1,
      },
      effectivePriority: false,
    });
    assert.deepEqual(host.wakeCalls, ["session-a"]);
    assert.equal(multitask.drainWake("session-a")?.wake.source, "peer");
    assert.equal(multitask.drainWake("session-b"), undefined);
  });

  it("two workers under one parent stay grouped by parent session and open no wake", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.wakeBus.noteTurnStarted("session-1");
    multitask.wakeBus.noteTurnStarted("session-2");

    const w1 = await spawnRunning(multitask, "session-1", "todo-1", "One");
    const w2 = await spawnRunning(multitask, "session-1", "todo-2", "Two");
    const w3 = await spawnRunning(multitask, "session-2", "todo-3", "Three");

    host.fireSettled({ workerId: w1, status: "completed", report: "1" });
    host.fireSettled({ workerId: w2, status: "completed", report: "2" });
    host.fireSettled({ workerId: w3, status: "completed", report: "3" });

    // Mid-turn: nothing delivered. Turn end: still nothing — the settle path
    // no longer enqueues a batch at all.
    assert.deepEqual(host.wakeCalls, []);
    multitask.wakeBus.noteTurnEnded("session-1");
    multitask.wakeBus.noteTurnEnded("session-2");
    assert.deepEqual(host.wakeCalls, []);
    assert.equal(multitask.drainWake("session-1"), undefined);
    assert.equal(multitask.drainWake("session-2"), undefined);

    // The per-parent grouping survives in the roster and settle records.
    assert.deepEqual(
      multitask
        .listWorkers("session-1")
        .map((worker) => worker.workerId)
        .sort(),
      [w1, w2].sort(),
    );
    assert.deepEqual(
      multitask.listWorkers("session-2").map((worker) => worker.workerId),
      [w3],
    );
    assert.equal(multitask.settleRecords.lookup("session-1", w1)?.resultText, "1");
    assert.equal(multitask.settleRecords.lookup("session-1", w2)?.resultText, "2");
    assert.equal(multitask.settleRecords.lookup("session-2", w3)?.resultText, "3");
    assert.equal(multitask.settleRecords.lookup("session-1", w3), undefined);
    assert.equal(multitask.settleRecords.lookup("session-2", w1), undefined);
  });
});

describe("wake bus — mid-turn hold", () => {
  it("a settle while the dispatcher is mid-turn is queued, never injected into the running turn", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => { delivered.push(id); } });

    bus.noteTurnStarted("session-1");
    bus.enqueueWorkerSettled(settled("session-1", "w1", "Mid-turn", "landed"));

    assert.deepEqual(delivered, [], "no host wake during the running turn");
    assert.equal(bus.peek("session-1"), undefined, "nothing ready to drain mid-turn");
    assert.equal(bus.isBusy("session-1"), true);
  });

  it("the queued wake flushes as its own turn when the current turn ends", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => { delivered.push(id); } });

    bus.noteTurnStarted("session-1");
    bus.enqueueWorkerSettled(settled("session-1", "w1", "Mid-turn", "landed"));
    assert.deepEqual(delivered, []);

    bus.noteTurnEnded("session-1");

    assert.deepEqual(delivered, ["session-1"]);
    const wake = bus.drain("session-1");
    assert.ok(wake);
    assert.equal(wake.source, "worker-settled");
    assert.equal(wake.settledWorkers.length, 1);
    assert.equal(bus.isBusy("session-1"), false);
  });

  it("the mid-turn hold is per session — another dispatcher still flushes immediately", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => { delivered.push(id); } });

    bus.noteTurnStarted("session-busy");
    bus.enqueueWorkerSettled(settled("session-busy", "w-busy"));
    bus.enqueueWorkerSettled(settled("session-idle", "w-idle"));

    assert.deepEqual(delivered, ["session-idle"]);
    assert.ok(bus.drain("session-idle"));
    assert.equal(bus.drain("session-busy"), undefined);
  });
});

describe("wake bus — pile-ups batch into one wake", () => {
  it("several mid-turn settles flush as a single batched wake with every worker", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => { delivered.push(id); } });

    bus.noteTurnStarted("session-1");
    bus.enqueueWorkerSettled(settled("session-1", "w1", "First", "r1"));
    bus.enqueueWorkerSettled(settled("session-1", "w2", "Second", "r2", "error"));
    bus.enqueueWorkerSettled(settled("session-1", "w3", "Third", "r3"));

    bus.noteTurnEnded("session-1");

    assert.deepEqual(delivered, ["session-1"], "one host wake for the whole pile");
    const wake = bus.drain("session-1");
    assert.ok(wake);
    assert.equal(wake.settledWorkers.length, 3);
    assert.deepEqual(
      wake.settledWorkers.map((n) => n.workerId),
      ["w1", "w2", "w3"],
    );
  });

  it("a settle that arrives before an undelivered ready batch is drained joins that batch", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => { delivered.push(id); } });

    // Idle: first settle flushes immediately.
    bus.enqueueWorkerSettled(settled("session-1", "w1", "First", "r1"));
    assert.deepEqual(delivered, ["session-1"]);

    // Second settle piles onto the same undelivered ready wake.
    bus.enqueueWorkerSettled(settled("session-1", "w2", "Second", "r2"));

    assert.deepEqual(delivered, ["session-1"], "no second host wake");
    const wake = bus.drain("session-1");
    assert.ok(wake);
    assert.equal(wake.settledWorkers.length, 2);
  });

  it("three workers settling through multitask open no wake and keep all three records", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.wakeBus.noteTurnStarted("session-1");
    const a = await spawnRunning(multitask, "session-1", "todo-a", "Alpha");
    const b = await spawnRunning(multitask, "session-1", "todo-b", "Beta");
    const c = await spawnRunning(multitask, "session-1", "todo-c", "Gamma");

    host.fireSettled({ workerId: a, status: "completed", report: "A ok" });
    host.fireSettled({ workerId: b, status: "error", report: "B boom" });
    host.fireSettled({ workerId: c, status: "aborted", report: "C stop" });

    multitask.wakeBus.noteTurnEnded("session-1");

    assert.deepEqual(host.wakeCalls, []);
    assert.equal(multitask.wakeBus.peek("session-1"), undefined);
    assert.equal(multitask.drainWake("session-1"), undefined);

    // The result channel keeps every status and report the batch used to
    // carry; the roster keeps the titles.
    assert.equal(multitask.settleRecords.lookup("session-1", a)?.status, "completed");
    assert.equal(multitask.settleRecords.lookup("session-1", a)?.resultText, "A ok");
    assert.equal(multitask.settleRecords.lookup("session-1", b)?.status, "error");
    assert.equal(multitask.settleRecords.lookup("session-1", b)?.resultText, "B boom");
    assert.equal(multitask.settleRecords.lookup("session-1", c)?.status, "aborted");
    assert.equal(multitask.settleRecords.lookup("session-1", c)?.resultText, "C stop");
    assert.equal(multitask.listWorkers("session-1").length, 3);
    assert.equal(multitask.getWorker(a)?.title, "Alpha");
    assert.equal(multitask.getWorker(b)?.status, "error");
    assert.equal(multitask.getWorker(c)?.status, "aborted");
  });
});

describe("wake bus — user wake preempts background", () => {
  it("a user wake reclaims a ready background batch so the user turn goes first", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => { delivered.push(id); } });

    // Idle settle: background ready + host notified.
    bus.enqueueWorkerSettled(settled("session-1", "w-bg", "Background", "bg result"));
    assert.deepEqual(delivered, ["session-1"]);

    // User arrives before the background wake is drained.
    bus.enqueueUserWake("session-1");

    const first = bus.drain("session-1");
    assert.ok(first);
    assert.equal(first.source, "user");
    assert.equal(first.settledWorkers.length, 0);

    // Background was not lost — it flushes after the user turn.
    bus.noteTurnStarted("session-1");
    bus.noteTurnEnded("session-1");
    assert.deepEqual(delivered, ["session-1", "session-1"]);
    const second = bus.drain("session-1");
    assert.ok(second);
    assert.equal(second.source, "worker-settled");
    assert.equal(second.settledWorkers[0]?.workerId, "w-bg");
  });

  it("a user wake during a mid-turn settle becomes the next turn; background waits behind it", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => { delivered.push(id); } });

    bus.noteTurnStarted("session-1");
    bus.enqueueWorkerSettled(settled("session-1", "w-bg", "Background", "bg"));
    bus.enqueueUserWake("session-1");

    // Mid-turn: nothing delivered; user owns the ready slot.
    assert.deepEqual(delivered, []);
    assert.equal(bus.peek("session-1")?.source, "user");

    bus.noteTurnEnded("session-1");
    // User wake still ready — background does not steal the next turn.
    assert.deepEqual(delivered, [], "user wake does not call onDeliver");
    assert.equal(bus.drain("session-1")?.source, "user");

    // After the user turn ends, background flushes on its own.
    bus.noteTurnStarted("session-1");
    bus.noteTurnEnded("session-1");
    assert.deepEqual(delivered, ["session-1"]);
    const background = bus.drain("session-1");
    assert.equal(background?.source, "worker-settled");
    assert.equal(background?.settledWorkers[0]?.workerId, "w-bg");
  });

  it("a settle opens no wake; a user wake still owns the next turn", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Worker");

    host.fireSettled({ workerId, status: "completed", report: "done" });
    assert.deepEqual(host.wakeCalls, []);
    assert.equal(multitask.drainWake("session-1"), undefined);

    // The user lane is a surviving path; it never calls onDeliver itself.
    multitask.wakeBus.enqueueUserWake("session-1");
    assert.deepEqual(host.wakeCalls, []);
    assert.equal(multitask.wakeBus.peek("session-1")?.source, "user");
    assert.equal(multitask.drainWake("session-1")?.wake.source, "user");
    assert.equal(multitask.settleRecords.lookup("session-1", workerId)?.resultText, "done");
  });
});

describe("wake bus — priority reclaim preserves mixed background payloads", () => {
  it("a priority peer reclaiming a dormant mixed wake keeps its external intake jobs", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => { delivered.push(id); } });
    const job = {
      jobId: "job-199",
      promptText: "intake prompt that must survive the reclaim",
      jobDir: "/inbox/job-199",
    };

    // Dormant dispatcher: the worker settles and the inbox job is accepted
    // while the dispatcher turn is still open. Both flush together at turn
    // end into ONE undrained mixed background wake.
    bus.noteTurnStarted("session-1");
    bus.enqueueExternalJob({ sessionId: "session-1", job });
    bus.enqueueWorkerSettled(settled("session-1", "w-199", "Worker", "report"));
    bus.noteTurnEnded("session-1");

    const mixed = bus.peek("session-1");
    assert.ok(mixed);
    assert.equal(mixed.source, "worker-settled");
    assert.equal(mixed.settledWorkers.length, 1);
    assert.deepEqual(mixed.externalJobs, [job]);

    // A priority peer arrives before the dormant wake is drained. The peer
    // turn goes first; the reclaimed background payload must remain queued.
    bus.enqueuePeer({
      sessionId: "session-1",
      notice: {
        messageId: "p-199",
        fromAgentId: "peer-199",
        fromName: "Peer 199",
        to: { kind: "agent", agentId: "session-1" },
        conversationId: "c-199",
        text: "priority peer message",
        priority: true,
        createdAtMs: 1,
      },
      effectivePriority: true,
    });

    const peerWake = bus.drain("session-1");
    assert.ok(peerWake);
    assert.equal(peerWake.source, "peer");
    assert.equal(peerWake.peerMessages?.length, 1);
    assert.equal(peerWake.peerMessages?.[0]?.text, "priority peer message");
    assert.equal(peerWake.externalJobs, undefined, "intake stays out of the peer wake");

    // After the peer turn ends, the reclaimed background batch presents both
    // categories: the worker notice and the original inbox payload.
    bus.noteTurnStarted("session-1");
    bus.noteTurnEnded("session-1");
    const background = bus.drain("session-1");
    assert.ok(background);
    assert.equal(background.source, "worker-settled");
    assert.equal(background.settledWorkers.length, 1);
    assert.equal(background.settledWorkers[0]?.workerId, "w-199");
    assert.equal(background.settledWorkers[0]?.resultText, "report");
    assert.deepEqual(background.externalJobs, [job], "intake survives the reclaim");
  });
});

describe("wake bus — settle result payload", () => {
  it("every settle writes status and result text to its record; the roster keeps titles", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.wakeBus.noteTurnStarted("session-1");
    const a = await spawnRunning(multitask, "session-1", "todo-a", "Research profiles");
    const b = await spawnRunning(multitask, "session-1", "todo-b", "Draft policy");

    host.fireSettled({
      workerId: a,
      status: "completed",
      report: "profiles collected",
    });
    host.fireSettled({
      workerId: b,
      status: "error",
      report: "policy draft failed",
    });
    multitask.wakeBus.noteTurnEnded("session-1");

    // No plugin wake is built; the settle record is the surviving payload
    // channel the core await and delivery redrive read.
    assert.deepEqual(host.wakeCalls, []);
    assert.equal(multitask.wakeBus.peek("session-1"), undefined);
    assert.equal(multitask.wakeBus.peekPending("session-1"), undefined);
    assert.equal(multitask.drainWake("session-1"), undefined);

    const first = multitask.settleRecords.lookup("session-1", a);
    assert.ok(first);
    assert.equal(first.workerId, a);
    assert.equal(first.status, "completed");
    assert.equal(first.resultText, "profiles collected");

    const second = multitask.settleRecords.lookup("session-1", b);
    assert.ok(second);
    assert.equal(second.workerId, b);
    assert.equal(second.status, "error");
    assert.equal(second.resultText, "policy draft failed");

    assert.equal(multitask.getWorker(a)?.title, "Research profiles");
    assert.equal(multitask.getWorker(a)?.status, "completed");
    assert.equal(multitask.getWorker(b)?.title, "Draft policy");
    assert.equal(multitask.getWorker(b)?.status, "error");
    assert.equal(multitask.listWorkers("session-1").length, 2);
  });
});

describe("wake bus — accepted wake sources", () => {
  it("the vocabulary accepts user, worker-settled, peer, timer, and external-event", () => {
    assert.deepEqual(
      [...WAKE_SOURCES],
      ["user", "worker-settled", "peer", "timer", "external-event"],
    );
    // Every listed source is a legal WakeSource; later tickets enqueue the rest.
    for (const source of WAKE_SOURCES) {
      const asSource: WakeSource = source;
      assert.ok(asSource.length > 0);
    }
  });

  it("user, worker-settled, and peer produce wakes; timer/external-event stay reserved", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => { delivered.push(id); } });

    bus.enqueueWorkerSettled(settled("session-1", "w1"));
    assert.equal(bus.drain("session-1")?.source, "worker-settled");

    bus.enqueueUserWake("session-1");
    assert.equal(bus.drain("session-1")?.source, "user");

    bus.enqueuePeer({
      sessionId: "session-1",
      notice: {
        messageId: "p1",
        fromAgentId: "peer-a",
        fromName: "Peer A",
        to: { kind: "agent", agentId: "session-1" },
        conversationId: "c1",
        text: "hi",
        priority: false,
        createdAtMs: 1,
      },
      effectivePriority: false,
    });
    assert.equal(bus.drain("session-1")?.source, "peer");

    // Reserved sources are part of the type surface but have no enqueue API yet.
    const reserved: readonly WakeSource[] = ["timer", "external-event"];
    for (const source of reserved) {
      assert.ok(WAKE_SOURCES.includes(source));
    }
  });
});
