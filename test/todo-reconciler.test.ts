import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  createTodoLedger,
  reconcileTodos,
  type ReconcileInput,
  type TodoItem,
} from "../src/core/todo-reconciler.js";
import type { SpawnResult, WorkerSummary } from "../src/core/types.js";
import type { WakeEvent } from "../src/core/wake-bus.js";

function unwrapSpawn(result: SpawnResult): string {
  if (!result.ok) {
    throw new Error(`spawn refused: ${result.detail}`);
  }
  return result.workerId;
}

function emptyWake(sessionId: string): WakeEvent {
  return { sessionId, source: "user", settledWorkers: [] };
}

function workerSummary(
  workerId: string,
  status: WorkerSummary["status"],
  todoId: string | null = null,
  parentSessionId = "session-1",
): WorkerSummary {
  return {
    workerId,
    parentSessionId,
    streamKey: todoId ?? workerId,
    title: "Task",
    status,
    startedAtMs: 1_000,
    elapsedMs: 0,
    toolCallCount: 0,
    transcriptRef: null,
    todoId,
  };
}

function todoFixture(overrides: Partial<TodoItem> & { id: string }): TodoItem {
  return {
    sessionId: "session-1",
    title: "Task",
    status: "pending",
    streamKey: null,
    workerId: null,
    delivered: false,
    redriveAttempts: 0,
    disposition: null,
    dispositionReason: null,
    external: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

describe("todo reconciler — in_progress on start", () => {
  it("a todo created before spawn stays pending until the worker starts, then becomes in_progress", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const todo = multitask.createTodo({
      sessionId: "session-1",
      id: "todo-1",
      title: "Research dsh profiles",
    });
    assert.equal(todo.status, "pending");

    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Research dsh profiles",
        prompt: "Look up profiles.",
        todoId: "todo-1",
      }),
    );

    // Spawn links structurally but does not start the stream.
    assert.equal(multitask.listTodos("session-1")[0]?.status, "pending");
    assert.equal(multitask.listTodos("session-1")[0]?.workerId, workerId);

    multitask.noteTurnStarted(workerId);

    assert.equal(multitask.listTodos("session-1")[0]?.status, "in_progress");
  });

  it("spawn without a todo id creates no ledger entry (pure chat / trivial lookup)", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "ad-hoc",
      title: "Quick lookup",
      prompt: "One-step fact.",
    });

    assert.deepEqual(multitask.listTodos("session-1"), []);
  });
});

describe("todo reconciler — multiple in_progress", () => {
  it("several todos may be in_progress at once, one per live stream", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-a",
      title: "Stream A",
    });
    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-b",
      title: "Stream B",
    });

    const a = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-a",
        title: "Stream A",
        prompt: "Work A.",
        todoId: "todo-a",
      }),
    );
    const b = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-b",
        title: "Stream B",
        prompt: "Work B.",
        todoId: "todo-b",
      }),
    );
    multitask.noteTurnStarted(a);
    multitask.noteTurnStarted(b);

    const statuses = multitask
      .listTodos("session-1")
      .map((t) => t.status)
      .sort();
    assert.deepEqual(statuses, ["in_progress", "in_progress"]);
  });

  it("inline in_progress is allowed alongside a worker-backed in_progress", () => {
    const ledger = createTodoLedger();
    ledger.create({
      sessionId: "session-1",
      id: "inline",
      title: "Answer inline",
      status: "in_progress",
    });
    ledger.create({
      sessionId: "session-1",
      id: "stream",
      title: "Background stream",
    });
    ledger.linkWorker("stream", "w1", "stream");
    ledger.markInProgress("stream");

    const statuses = ledger.list("session-1").map((t) => t.status).sort();
    assert.deepEqual(statuses, ["in_progress", "in_progress"]);
  });
});

describe("todo reconciler — completed only after delivered", () => {
  it("worker exit alone does not complete the todo; delivery does", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-1",
      title: "Deliver me",
    });
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Deliver me",
        prompt: "Work.",
        todoId: "todo-1",
      }),
    );
    multitask.noteTurnStarted(workerId);

    host.fireSettled({
      workerId,
      status: "completed",
      report: "here is the result",
    });

    // Settled but not delivered — still in_progress.
    const afterSettle = multitask.listTodos("session-1")[0];
    assert.equal(afterSettle?.status, "in_progress");
    assert.equal(afterSettle?.delivered, false);

    assert.equal(multitask.markDelivered("todo-1"), true);

    const afterDeliver = multitask.listTodos("session-1")[0];
    assert.equal(afterDeliver?.status, "completed");
    assert.equal(afterDeliver?.delivered, true);
  });

  it("an error settle is still undelivered until the dispatcher delivers", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-err",
      title: "Risky",
    });
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-err",
        title: "Risky",
        prompt: "Work.",
        todoId: "todo-err",
      }),
    );
    multitask.noteTurnStarted(workerId);
    host.fireSettled({ workerId, status: "error", report: "boom" });

    const todo = multitask.listTodos("session-1")[0];
    assert.equal(todo?.status, "in_progress");
    assert.equal(todo?.delivered, false);

    multitask.markDelivered("todo-err");
    assert.equal(multitask.listTodos("session-1")[0]?.status, "completed");
  });
});

describe("todo reconciler — wake reports outstanding work", () => {
  it("reports running, landed-undelivered, and next-to-dispatch in one reconcile", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    // Running stream
    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-run",
      title: "Still running",
    });
    const runId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-run",
        title: "Still running",
        prompt: "Work.",
        todoId: "todo-run",
      }),
    );
    multitask.noteTurnStarted(runId);

    // Landed undelivered
    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-done",
      title: "Finished waiting",
    });
    const doneId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-done",
        title: "Finished waiting",
        prompt: "Work.",
        todoId: "todo-done",
      }),
    );
    multitask.noteTurnStarted(doneId);

    // Next to dispatch — created, never spawned
    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-next",
      title: "Not started",
    });

    host.fireSettled({ workerId: doneId, status: "completed", report: "done" });

    const drained = multitask.drainWake("session-1");
    assert.ok(drained);

    assert.equal(drained.reconcile.running.length, 1);
    assert.equal(drained.reconcile.running[0]?.id, "todo-run");
    assert.equal(drained.reconcile.landedUndelivered.length, 1);
    assert.equal(drained.reconcile.landedUndelivered[0]?.id, "todo-done");
    assert.equal(drained.reconcile.nextToDispatch.length, 1);
    assert.equal(drained.reconcile.nextToDispatch[0]?.id, "todo-next");

    // Wake still carries the settled notice.
    assert.equal(drained.wake.settledWorkers.length, 1);
    assert.equal(drained.wake.settledWorkers[0]?.workerId, doneId);
  });

  it("reconcileTodos without a wake still buckets current state", () => {
    const ledger = createTodoLedger();
    ledger.create({ sessionId: "session-1", id: "a", title: "A" });
    ledger.linkWorker("a", "w-a", "a");
    ledger.markInProgress("a");
    ledger.create({ sessionId: "session-1", id: "b", title: "B" });

    const report = reconcileTodos({
      wake: emptyWake("session-1"),
      todos: ledger.list("session-1"),
      workers: [workerSummary("w-a", "running", "a")],
    });

    assert.equal(report.running.length, 1);
    assert.equal(report.running[0]?.id, "a");
    assert.equal(report.nextToDispatch.length, 1);
    assert.equal(report.nextToDispatch[0]?.id, "b");
    assert.equal(report.landedUndelivered.length, 0);
  });
});

describe("todo reconciler — aborted closes as cancelled", () => {
  it("abortWorker closes the linked todo and drops it from the list", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-1",
      title: "Stop me",
    });
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Stop me",
        prompt: "Work.",
        todoId: "todo-1",
      }),
    );
    multitask.noteTurnStarted(workerId);

    const stop = await multitask.abortWorker(workerId);
    assert.ok(stop.ok);
    assert.deepEqual(multitask.listTodos("session-1"), []);
  });

  it("an aborted settle in a wake is reconciled to cancelled and pruned", () => {
    const todos = [
      todoFixture({
        id: "todo-1",
        status: "in_progress",
        workerId: "w1",
        streamKey: "todo-1",
      }),
    ];
    const wake: WakeEvent = {
      sessionId: "session-1",
      source: "worker-settled",
      settledWorkers: [
        {
          workerId: "w1",
          status: "aborted",
          title: "Task",
          resultText: "",
        },
      ],
    };

    const report = reconcileTodos({
      wake,
      todos,
      workers: [workerSummary("w1", "aborted", "todo-1")],
    });

    assert.ok(
      report.mutations.some(
        (m) =>
          m.type === "set-status" &&
          m.todoId === "todo-1" &&
          m.status === "cancelled",
      ),
    );
    assert.ok(
      report.mutations.some((m) => m.type === "prune" && m.todoId === "todo-1"),
    );
    assert.equal(report.running.length, 0);
    assert.equal(report.landedUndelivered.length, 0);
  });
});

describe("todo reconciler — prune stale", () => {
  it("prunes completed+delivered items past retention", () => {
    const todos = [
      todoFixture({
        id: "old",
        status: "completed",
        delivered: true,
        updatedAtMs: 1_000,
      }),
      todoFixture({
        id: "fresh",
        status: "completed",
        delivered: true,
        updatedAtMs: 9_000,
      }),
    ];

    const report = reconcileTodos({
      wake: emptyWake("session-1"),
      todos,
      workers: [],
      nowMs: 10_000,
      completedRetentionMs: 5_000,
    });

    assert.ok(
      report.mutations.some(
        (m) =>
          m.type === "prune" &&
          m.todoId === "old" &&
          m.reason === "completed-retention",
      ),
    );
    assert.ok(!report.mutations.some((m) => m.todoId === "fresh"));
  });

  it("prunes pending items with no worker past the stale age", () => {
    const todos = [
      todoFixture({ id: "stale", createdAtMs: 1_000, updatedAtMs: 1_000 }),
      todoFixture({ id: "ok", createdAtMs: 9_000, updatedAtMs: 9_000 }),
    ];

    const report = reconcileTodos({
      wake: emptyWake("session-1"),
      todos,
      workers: [],
      nowMs: 10_000,
      stalePendingMs: 2_000,
    });

    assert.ok(
      report.mutations.some(
        (m) =>
          m.type === "prune" &&
          m.todoId === "stale" &&
          m.reason === "stale-pending",
      ),
    );
    assert.ok(!report.mutations.some((m) => m.todoId === "ok"));
  });

  it("does not prune in-progress or undelivered items — it redrives them instead (ticket 58)", () => {
    const todos = [
      todoFixture({
        id: "live",
        status: "in_progress",
        workerId: "w1",
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      }),
      todoFixture({
        id: "waiting",
        status: "in_progress",
        workerId: "w2",
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      }),
    ];

    const report = reconcileTodos({
      wake: emptyWake("session-1"),
      todos,
      workers: [
        workerSummary("w1", "running", "live"),
        workerSummary("w2", "completed", "waiting"),
      ],
      nowMs: 100_000,
      stalePendingMs: 1,
      completedRetentionMs: 1,
    });

    assert.equal(report.running.length, 1);
    assert.equal(report.landedUndelivered.length, 1);
    // `mutations` used to be asserted EMPTY here. That expectation was
    // deviation D-5 written down as a requirement: an `in_progress &&
    // !delivered` item whose worker had settled stayed untouched forever and
    // was never escalated. Ticket 58 replaces "leave it alone" with a bounded
    // redrive — the item is still never pruned while it is owed, but it is no
    // longer ignored.
    assert.deepEqual(
      report.mutations.map((mutation) => mutation.type),
      ["record-redrive"],
      "a missed delivery costs exactly one redrive attempt",
    );
    assert.equal(report.toRedrive.length, 1);
    assert.equal(report.toRedrive[0]?.id, "waiting");
    assert.equal(report.toRedrive[0]?.redriveAttempts, 1);
    assert.equal(report.lost.length, 0, "one attempt is nowhere near the bound");
    assert.equal(
      report.mutations.some((mutation) => mutation.type === "prune"),
      false,
      "an owed item is still never pruned",
    );
  });
});

describe("todo reconciler — pure function of wake + todo state", () => {
  it("same inputs produce the same mutations and do not mutate the inputs", () => {
    const todos = [
      todoFixture({
        id: "t1",
        status: "pending",
        workerId: "w1",
        streamKey: "t1",
      }),
      todoFixture({ id: "t2", status: "pending" }),
    ];
    const workers = [
      workerSummary("w1", "running", "t1"),
      workerSummary("w2", "aborted", "gone"),
    ];
    const wake: WakeEvent = {
      sessionId: "session-1",
      source: "worker-settled",
      settledWorkers: [
        { workerId: "w2", status: "aborted", title: "Gone", resultText: "" },
      ],
    };
    const input: ReconcileInput = {
      wake,
      todos,
      workers,
      nowMs: 50_000,
      stalePendingMs: 10_000,
      completedRetentionMs: 10_000,
    };

    const first = reconcileTodos(input);
    const second = reconcileTodos(input);

    assert.deepEqual(first.mutations, second.mutations);
    assert.deepEqual(first.running, second.running);
    assert.deepEqual(first.landedUndelivered, second.landedUndelivered);
    assert.deepEqual(first.nextToDispatch, second.nextToDispatch);

    // Inputs untouched.
    assert.equal(todos[0]?.status, "pending");
    assert.equal(todos.length, 2);
    assert.equal(workers.length, 2);
  });

  it("promotes a pending todo to in_progress when reconcile sees a started worker", () => {
    const report = reconcileTodos({
      wake: emptyWake("session-1"),
      todos: [
        todoFixture({
          id: "t1",
          workerId: "w1",
          streamKey: "t1",
        }),
      ],
      workers: [workerSummary("w1", "running", "t1")],
    });

    assert.deepEqual(report.mutations, [
      {
        type: "set-status",
        todoId: "t1",
        status: "in_progress",
        reason: "worker-started",
      },
    ]);
    assert.equal(report.running[0]?.id, "t1");
  });
});

describe("todo reconciler — worker list stays empty (ADR-0007)", () => {
  it("never sends ledger titles or ids into a spawn prompt or host options", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-secret",
      title: "SECRET-LEDGER-TITLE",
    });

    await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "todo-secret",
      title: "Public stream title",
      prompt: "Do the work. You cannot see the user or the ledger.",
      todoId: "todo-secret",
    });

    const spawn = host.spawnCalls[0];
    assert.ok(spawn);
    assert.ok(!spawn.prompt.includes("SECRET-LEDGER-TITLE"));
    assert.ok(!spawn.prompt.includes("todo-secret"));
    assert.equal(spawn.opts.streamKey, "todo-secret");
    // Structural link is on the worker record only — not on the spawn payload
    // beyond the stream key the dispatcher chose.
    assert.ok(!("todoId" in spawn.opts));
    assert.ok(!("todos" in spawn.opts));
  });

  it("WorkerRecord carries only the todo id link, never the ledger list", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-1",
      title: "Private title",
    });
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Public title",
        prompt: "Work.",
        todoId: "todo-1",
      }),
    );

    const record = multitask.getWorker(workerId);
    assert.ok(record);
    assert.equal(record.todoId, "todo-1");
    const keys = Object.keys(record);
    assert.ok(!keys.includes("todos"));
    assert.ok(!keys.includes("todoList"));
    assert.ok(!keys.includes("title") || record.title === "Public title");
  });

  it("wake notices carry result text and title only — no ledger payload", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-1",
      title: "SECRET-LEDGER-TITLE",
    });
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "todo-1",
        title: "Public title",
        prompt: "Work.",
        todoId: "todo-1",
      }),
    );
    multitask.noteTurnStarted(workerId);
    host.fireSettled({ workerId, status: "completed", report: "result" });

    const drained = multitask.drainWake("session-1");
    assert.ok(drained);
    const notice = drained.wake.settledWorkers[0];
    assert.ok(notice);
    assert.equal(notice.title, "Public title");
    assert.equal(notice.resultText, "result");
    const serialized = JSON.stringify(drained.wake);
    assert.ok(!serialized.includes("SECRET-LEDGER-TITLE"));
  });
});
