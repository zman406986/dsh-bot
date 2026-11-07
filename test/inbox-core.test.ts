/**
 * Ticket 113 / ADR-0023 — the core external-event path.
 *
 * Offline only (S8): FakeDshHost + the real core. Covers the three core
 * halves of the inbox: (1) `enqueueExternalJob` — one todo per job with the
 * inbox origin, one wake, idempotent by jobId; (2) the external-event wake
 * lane — immediate when idle, joined into background batches, flushed at
 * turn end while busy, coalesced under ticket-108 windows; (3) the
 * `onInboxJobResolved` hook — replied from delivery, failed from an error
 * settle, cancelled from an abort, and never allowed to break the core.
 * A final test pins the marker-carried origin through a simulated restart.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryDurability } from "../src/core/durability.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import {
  createMultitask,
  type InboxJobResolution,
  type Multitask,
} from "../src/core/multitask.js";
import { createWakeBus, type WakeBus } from "../src/core/wake-bus.js";
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
  todoId?: string,
): Promise<string> {
  const workerId = unwrapSpawn(
    await multitask.spawnWorker({
      parentSessionId,
      streamKey,
      title,
      prompt: "Do the work.",
      ...(todoId !== undefined ? { todoId } : {}),
    }),
  );
  multitask.noteTurnStarted(workerId);
  return workerId;
}

/** Manual scheduler for the coalescing test (no real timer may survive). */
function createManualScheduler(): {
  scheduled: Array<{ fn: () => void; ms: number }>;
  schedule(fn: () => void, ms: number): () => void;
  runAll(): void;
} {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  return {
    scheduled,
    schedule(fn, ms) {
      scheduled.push({ fn, ms });
      return () => {};
    },
    runAll() {
      for (const entry of [...scheduled]) entry.fn();
    },
  };
}

describe("inbox core — enqueueExternalJob (ticket 113)", () => {
  it("creates one todo with the inbox origin and one external-event wake", () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const result = multitask.enqueueExternalJob({
      sessionId: "s-1",
      jobId: "job-1",
      jobDir: "/tmp/inbox/job-1",
      promptText: "Build the widget",
    });

    assert.ok(result.ok);
    assert.deepEqual(host.wakeCalls, ["s-1"]);

    const todos = multitask.listTodos("s-1");
    assert.equal(todos.length, 1);
    assert.equal(todos[0]?.title, "Inbox job job-1");
    assert.equal(todos[0]?.status, "pending");
    assert.deepEqual(todos[0]?.external, {
      kind: "inbox",
      jobId: "job-1",
      jobDir: "/tmp/inbox/job-1",
    });

    const drained = multitask.drainWake("s-1");
    assert.ok(drained);
    assert.equal(drained.wake.source, "external-event");
    assert.deepEqual(drained.wake.externalJobs, [
      {
        jobId: "job-1",
        promptText: "Build the widget",
        jobDir: "/tmp/inbox/job-1",
      },
    ]);
    assert.equal(multitask.drainWake("s-1"), undefined, "one wake per enqueue");
  });

  it("is idempotent per session: a second enqueue of one jobId is a duplicate", () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const first = multitask.enqueueExternalJob({
      sessionId: "s-1",
      jobId: "job-1",
      jobDir: "/d",
      promptText: "x",
    });
    assert.ok(first.ok);
    const second = multitask.enqueueExternalJob({
      sessionId: "s-1",
      jobId: "job-1",
      jobDir: "/d",
      promptText: "x",
    });
    assert.deepEqual(second, { ok: false, reason: "duplicate-job" });
    assert.equal(multitask.listTodos("s-1").length, 1);
    assert.deepEqual(host.wakeCalls, ["s-1"], "no second wake either");

    // The same jobId under a DIFFERENT session is a different presentation.
    const other = multitask.enqueueExternalJob({
      sessionId: "s-2",
      jobId: "job-1",
      jobDir: "/d",
      promptText: "x",
    });
    assert.ok(other.ok);
  });

  it("an external job joins an already-ready background wake into ONE turn", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, "s-1", "k-1", "One");

    host.fireSettled({ workerId, status: "completed", report: "finished" });
    assert.deepEqual(host.wakeCalls, ["s-1"], "the settle wakes at once");

    multitask.enqueueExternalJob({
      sessionId: "s-1",
      jobId: "job-1",
      jobDir: "/d",
      promptText: "extra",
    });
    assert.deepEqual(
      host.wakeCalls,
      ["s-1"],
      "the external job joins the ready wake — no second delivery",
    );

    const drained = multitask.drainWake("s-1");
    assert.ok(drained);
    assert.equal(drained.wake.settledWorkers.length, 1);
    assert.equal(drained.wake.externalJobs?.length, 1);
    assert.equal(multitask.drainWake("s-1"), undefined);
  });

  it("an external job arriving mid-turn is flushed at turn end (background rank)", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, "s-1", "k-1", "Busy");
    // The dispatcher's own turn is what gates the bus (the worker state
    // machine and the wake bus track turns independently). "user" is the
    // closed set's name for that turn; the external job is the pending wake.
    multitask.wakeBus.noteTurnStarted("s-1", "user");

    multitask.enqueueExternalJob({
      sessionId: "s-1",
      jobId: "job-1",
      jobDir: "/d",
      promptText: "queued while busy",
    });
    assert.deepEqual(
      host.wakeCalls,
      [],
      "nothing is delivered while the turn is open",
    );

    multitask.wakeBus.noteTurnEnded("s-1");
    assert.deepEqual(host.wakeCalls, ["s-1"], "turn end flushes the lane");
    const drained = multitask.drainWake("s-1");
    assert.ok(drained);
    assert.equal(drained.wake.source, "external-event");
    assert.equal(drained.wake.externalJobs?.[0]?.jobId, "job-1");
  });

  it("the ticket-108 window coalesces external jobs into one delivery", () => {
    const delivered: string[] = [];
    const scheduler = createManualScheduler();
    const bus: WakeBus = createWakeBus({
      onDeliver: (id) => {
        delivered.push(id);
      },
      coalesceWindowMs: 50,
      schedule: scheduler.schedule,
    });

    bus.enqueueExternalJob({
      sessionId: "s-1",
      job: { jobId: "j-1", promptText: "one", jobDir: "/d1" },
    });
    bus.enqueueExternalJob({
      sessionId: "s-1",
      job: { jobId: "j-2", promptText: "two", jobDir: "/d2" },
    });
    assert.deepEqual(delivered, [], "inside the window nothing is delivered yet");

    scheduler.runAll();
    assert.deepEqual(delivered, ["s-1"], "exactly one coalesced delivery");
    const wake = bus.drain("s-1");
    assert.ok(wake);
    assert.equal(wake.source, "external-event");
    assert.deepEqual(
      wake.externalJobs?.map((job) => job.jobId),
      ["j-1", "j-2"],
      "both jobs ride the one turn",
    );
  });
});

describe("inbox core — the onInboxJobResolved hook (ticket 113)", () => {
  function createWithHook(): {
    host: FakeDshHost;
    multitask: Multitask;
    resolutions: InboxJobResolution[];
  } {
    const host = new FakeDshHost();
    const resolutions: InboxJobResolution[] = [];
    const multitask = createMultitask(host, {
      onInboxJobResolved: (resolution) => {
        resolutions.push(resolution);
      },
    });
    return { host, multitask, resolutions };
  }

  it("delivery of an inbox-origin item fires the replied resolution with the text", async () => {
    const { host, multitask, resolutions } = createWithHook();
    const presented = multitask.enqueueExternalJob({
      sessionId: "s-1",
      jobId: "job-1",
      jobDir: "/d/job-1",
      promptText: "work",
    });
    assert.ok(presented.ok);

    const workerId = await spawnRunning(
      multitask,
      "s-1",
      "k-1",
      "Inbox job job-1",
      presented.todoId,
    );
    host.fireSettled({ workerId, status: "completed", report: "the answer" });
    multitask.drainWake("s-1");
    assert.equal(multitask.markDelivered(presented.todoId, "the answer"), true);

    assert.equal(resolutions.length, 1);
    const resolution = resolutions[0];
    assert.ok(resolution);
    assert.equal(resolution.kind, "replied");
    assert.equal(resolution.jobId, "job-1");
    assert.equal(resolution.jobDir, "/d/job-1");
    assert.equal(resolution.todoId, presented.todoId);
    assert.equal(resolution.sessionId, "s-1");
    assert.equal(
      resolution.kind === "replied" ? resolution.replyText : "",
      "the answer",
    );
  });

  it("an error settle fires the failed resolution; the todo stays open", async () => {
    const { host, multitask, resolutions } = createWithHook();
    const presented = multitask.enqueueExternalJob({
      sessionId: "s-1",
      jobId: "job-1",
      jobDir: "/d/job-1",
      promptText: "work",
    });
    assert.ok(presented.ok);
    const workerId = await spawnRunning(
      multitask,
      "s-1",
      "k-1",
      "Inbox job job-1",
      presented.todoId,
    );

    host.fireSettled({ workerId, status: "error", report: "boom" });

    assert.equal(resolutions.length, 1);
    const resolution = resolutions[0];
    assert.ok(resolution);
    assert.equal(resolution.kind, "failed");
    assert.equal(resolution.jobId, "job-1");
    assert.equal(
      resolution.kind === "failed" ? resolution.error : "",
      "boom",
    );
    const todo = multitask.listTodos("s-1").find((t) => t.id === presented.todoId);
    assert.ok(todo, "the todo stays open — the failure is honest, not silent");
    assert.equal(todo.delivered, false);
  });

  it("an abort fires the cancelled resolution", async () => {
    const { host, multitask, resolutions } = createWithHook();
    const presented = multitask.enqueueExternalJob({
      sessionId: "s-1",
      jobId: "job-1",
      jobDir: "/d/job-1",
      promptText: "work",
    });
    assert.ok(presented.ok);
    const workerId = await spawnRunning(
      multitask,
      "s-1",
      "k-1",
      "Inbox job job-1",
      presented.todoId,
    );

    await multitask.abortWorker(workerId);

    assert.equal(resolutions.length, 1);
    const resolution = resolutions[0];
    assert.ok(resolution);
    assert.equal(resolution.kind, "cancelled");
    assert.equal(resolution.jobId, "job-1");
  });

  it("a non-inbox delivery fires nothing", async () => {
    const { host, multitask, resolutions } = createWithHook();
    const todo = multitask.createTodo({
      sessionId: "s-1",
      title: "plain",
      status: "in_progress",
    });
    assert.equal(multitask.markDelivered(todo.id, "done"), true);
    assert.deepEqual(resolutions, []);
  });

  it("a throwing hook never breaks the delivery path", () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host, {
      onInboxJobResolved: () => {
        throw new Error("hook is broken");
      },
    });
    const presented = multitask.enqueueExternalJob({
      sessionId: "s-1",
      jobId: "job-1",
      jobDir: "/d",
      promptText: "x",
    });
    assert.ok(presented.ok);
    assert.equal(multitask.markDelivered(presented.todoId, "text"), true);
  });
});

describe("inbox core — restart re-presentation dedupes on the marker origin (ticket 113)", () => {
  it("a rebuilt inbox-origin todo absorbs the re-presented jobId without a duplicate", async () => {
    const durability = createInMemoryDurability();

    // ── Life 1: present the job, run its worker to a settled-but-unread
    // end, and "crash" before the reply is ever delivered. The terminal
    // marker is the durable trace a restart rebuilds from. ──
    {
      const host = new FakeDshHost();
      const multitask = createMultitask(host, { durability });
      const presented = multitask.enqueueExternalJob({
        sessionId: "s-1",
        jobId: "job-1",
        jobDir: "/d/job-1",
        promptText: "work",
      });
      assert.ok(presented.ok);
      const workerId = await spawnRunning(
        multitask,
        "s-1",
        "k-job-1",
        "Inbox job job-1",
        presented.todoId,
      );
      host.fireSettled({ workerId, status: "completed", report: "answer" });
      // (No markDelivered: the reply was never written — the crash window.)
    }

    // ── Life 2: fresh core over the SAME durability store. ──
    {
      const host = new FakeDshHost();
      const multitask = createMultitask(host, { durability });
      const report = await multitask.rebuildFromDurability("s-1");
      assert.equal(report.restored.length, 1, "the marker is restored");
      assert.equal(
        multitask.listTodos("s-1").length,
        1,
        "the ledger item is recreated",
      );
      assert.deepEqual(
        multitask.listTodos("s-1")[0]?.external,
        { kind: "inbox", jobId: "job-1", jobDir: "/d/job-1" },
        "the rebuilt item keeps its inbox origin",
      );

      // The plugin's boot re-present hits the dedupe: no second todo, no
      // second wake for one job.
      const again = multitask.enqueueExternalJob({
        sessionId: "s-1",
        jobId: "job-1",
        jobDir: "/d/job-1",
        promptText: "work",
      });
      assert.deepEqual(again, { ok: false, reason: "duplicate-job" });
      assert.equal(multitask.listTodos("s-1").length, 1);
      assert.deepEqual(host.wakeCalls, [], "no duplicate wake either");
    }
  });
});
