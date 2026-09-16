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

describe("wake bus — settle enqueues exactly one wake", () => {
  it("an idle parent session is woken once for a single settle", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => delivered.push(id) });

    bus.enqueueWorkerSettled(settled("session-1", "w1"));

    assert.deepEqual(delivered, ["session-1"]);
    const wake = bus.drain("session-1");
    assert.ok(wake);
    assert.equal(wake.settledWorkers.length, 1);
    assert.equal(bus.drain("session-1"), undefined);
  });

  it("settling the same worker twice through multitask enqueues only one wake", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Once");

    host.fireSettled({ workerId, status: "completed", report: "first" });
    host.fireSettled({ workerId, status: "completed", report: "second" });

    assert.deepEqual(host.wakeCalls, ["session-1"]);
    const wake = multitask.wakeBus.drain("session-1");
    assert.ok(wake);
    assert.equal(wake.settledWorkers.length, 1);
    assert.equal(wake.settledWorkers[0]?.resultText, "first");
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
  it("a settle wakes only its own parent session, never a sibling dispatcher", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const a = await spawnRunning(multitask, "session-a", "todo-a", "For A");
    const b = await spawnRunning(multitask, "session-b", "todo-b", "For B");

    host.fireSettled({ workerId: a, status: "completed", report: "A done" });

    assert.deepEqual(host.wakeCalls, ["session-a"]);
    assert.ok(multitask.wakeBus.drain("session-a"));
    assert.equal(multitask.wakeBus.drain("session-b"), undefined);

    host.fireSettled({ workerId: b, status: "error", report: "B failed" });
    assert.deepEqual(host.wakeCalls, ["session-a", "session-b"]);
    const wakeB = multitask.wakeBus.drain("session-b");
    assert.ok(wakeB);
    assert.equal(wakeB.settledWorkers[0]?.status, "error");
  });

  it("two workers under one parent share that parent's single wake; a third under another parent is separate", async () => {
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

    // Mid-turn: nothing delivered yet.
    assert.deepEqual(host.wakeCalls, []);

    multitask.wakeBus.noteTurnEnded("session-1");
    multitask.wakeBus.noteTurnEnded("session-2");

    assert.deepEqual(host.wakeCalls, ["session-1", "session-2"]);
    const wake1 = multitask.wakeBus.drain("session-1");
    assert.ok(wake1);
    assert.equal(wake1.settledWorkers.length, 2);
    const wake2 = multitask.wakeBus.drain("session-2");
    assert.ok(wake2);
    assert.equal(wake2.settledWorkers.length, 1);
    assert.equal(wake2.settledWorkers[0]?.workerId, w3);
  });
});

describe("wake bus — mid-turn hold", () => {
  it("a settle while the dispatcher is mid-turn is queued, never injected into the running turn", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => delivered.push(id) });

    bus.noteTurnStarted("session-1");
    bus.enqueueWorkerSettled(settled("session-1", "w1", "Mid-turn", "landed"));

    assert.deepEqual(delivered, [], "no host wake during the running turn");
    assert.equal(bus.peek("session-1"), undefined, "nothing ready to drain mid-turn");
    assert.equal(bus.isBusy("session-1"), true);
  });

  it("the queued wake flushes as its own turn when the current turn ends", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => delivered.push(id) });

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
    const bus = createWakeBus({ onDeliver: (id) => delivered.push(id) });

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
    const bus = createWakeBus({ onDeliver: (id) => delivered.push(id) });

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
    const bus = createWakeBus({ onDeliver: (id) => delivered.push(id) });

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

  it("three workers settling together through multitask produce one wake carrying all three", async () => {
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

    assert.deepEqual(host.wakeCalls, ["session-1"]);
    const wake = multitask.wakeBus.drain("session-1");
    assert.ok(wake);
    assert.equal(wake.settledWorkers.length, 3);
    const byId = new Map(wake.settledWorkers.map((n) => [n.workerId, n]));
    assert.equal(byId.get(a)?.title, "Alpha");
    assert.equal(byId.get(b)?.status, "error");
    assert.equal(byId.get(c)?.status, "aborted");
  });
});

describe("wake bus — user wake preempts background", () => {
  it("a user wake reclaims a ready background batch so the user turn goes first", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => delivered.push(id) });

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
    const bus = createWakeBus({ onDeliver: (id) => delivered.push(id) });

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

  it("a user wake through multitask preempts a settle that already notified the host", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Worker");

    host.fireSettled({ workerId, status: "completed", report: "done" });
    assert.deepEqual(host.wakeCalls, ["session-1"]);

    multitask.wakeBus.enqueueUserWake("session-1");
    const wake = multitask.wakeBus.drain("session-1");
    assert.equal(wake?.source, "user");
  });
});

describe("wake bus — wake payload", () => {
  it("the wake carries status, title, and result text for every settled worker", async () => {
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

    const wake = multitask.wakeBus.drain("session-1");
    assert.ok(wake);
    assert.equal(wake.sessionId, "session-1");
    assert.equal(wake.source, "worker-settled");
    assert.equal(wake.settledWorkers.length, 2);

    const first = wake.settledWorkers[0];
    assert.ok(first);
    assert.equal(first.workerId, a);
    assert.equal(first.status, "completed");
    assert.equal(first.title, "Research profiles");
    assert.equal(first.resultText, "profiles collected");

    const second = wake.settledWorkers[1];
    assert.ok(second);
    assert.equal(second.workerId, b);
    assert.equal(second.status, "error");
    assert.equal(second.title, "Draft policy");
    assert.equal(second.resultText, "policy draft failed");
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

  it("user and worker-settled produce wakes today; peer/timer/external-event are reserved", () => {
    const delivered: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => delivered.push(id) });

    bus.enqueueWorkerSettled(settled("session-1", "w1"));
    assert.equal(bus.drain("session-1")?.source, "worker-settled");

    bus.enqueueUserWake("session-1");
    assert.equal(bus.drain("session-1")?.source, "user");

    // Reserved sources are part of the type surface but have no enqueue API yet.
    const reserved: readonly WakeSource[] = ["peer", "timer", "external-event"];
    for (const source of reserved) {
      assert.ok(WAKE_SOURCES.includes(source));
    }
  });
});
