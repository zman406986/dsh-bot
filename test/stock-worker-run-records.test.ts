import assert from "node:assert/strict";
import { it } from "node:test";
import { createMultitask } from "../src/core/multitask.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createInMemoryDurability } from "../src/core/durability.js";

it("keeps terminal native runs separate and rejects stale or untagged settlements", () => {
  const host = new FakeDshHost();
  const core = createMultitask(host);
  try {
    const request = { workerId: "child", parentSessionId: "parent", label: "follow-up" };
    assert.equal(core.adoptSpawnedWorker(request), true);
    const firstTodo = core.getWorker("child")!.todoId!;
    assert.equal(core.adoptSpawnedWorker({ ...request, runId: "run-a" }), false);
    assert.equal(core.getWorker("child")?.todoId, firstTodo, "native identity binds the existing initial obligation");
    core.noteTurnStarted("child");
    assert.equal(core.adoptSpawnedWorker({ ...request, runId: "run-b" }), false, "a live execution is never replaced");
    host.fireSettled({ workerId: "child", runId: "run-a", status: "completed", report: "FIRST" });
    core.markDelivered(firstTodo);
    const first = structuredClone(core.getWorker("child"));
    const firstDelivered = structuredClone(core.todos.get(firstTodo));
    assert.equal(core.adoptSpawnedWorker({ ...request, runId: "run-a" }), false);
    assert.equal(core.adoptSpawnedWorker({ ...request, runId: "run-b" }), true);
    core.noteTurnStarted("child");
    assert.equal(core.adoptSpawnedWorker({ ...request, runId: "run-b" }), false);
    assert.equal(core.adoptSpawnedWorker({ ...request, runId: "run-a" }), false, "old starts cannot replace the current run");
    host.fireSettled({ workerId: "child", runId: "run-a", status: "error", report: "OLD_LATE" });
    host.fireSettled({ workerId: "child", status: "completed", report: "UNTAGGED" });
    assert.equal(core.getWorker("child")?.status, "running");
    host.fireSettled({ workerId: "child", runId: "run-b", status: "completed", report: "SECOND" });
    const second = structuredClone(core.getWorker("child"));
    host.fireSettled({ workerId: "child", runId: "run-b", status: "error", report: "DUPLICATE" });
    assert.deepEqual(core.getWorker("child"), second);
    assert.deepEqual(core.getWorker("child", "run-a"), first);
    assert.deepEqual(core.todos.get(firstTodo), firstDelivered);
    assert.equal(core.settleRecords.lookup("parent", "child", "run-a")?.resultText, "FIRST");
    assert.equal(core.settleRecords.lookup("parent", "child", "run-b")?.resultText, "SECOND");
    assert.equal(core.settleRecords.lookup("parent", "child")?.resultText, "SECOND");
  } finally { core.dispose(); }
});

it("awaits the current run while retaining an older undelivered obligation", async () => {
  const host = new FakeDshHost();
  const durability = createInMemoryDurability();
  const core = createMultitask(host, { durability });
  try {
    const request = { workerId: "child", parentSessionId: "parent" };
    core.adoptSpawnedWorker({ ...request, runId: "run-a" });
    core.noteTurnStarted("child");
    host.fireSettled({ workerId: "child", runId: "run-a", status: "completed", report: "FIRST_OWED" });
    const oldTodoId = core.getWorker("child")!.todoId!;
    core.adoptSpawnedWorker({ ...request, runId: "run-b" });
    core.noteTurnStarted("child");
    const newTodoId = core.getWorker("child")!.todoId!;
    const whileRunning = await core.awaitWorker("parent", "child", 0);
    assert(whileRunning.ok);
    assert.equal(whileRunning.status, "still-running", "prior result is not current completion");
    const marker = structuredClone(durability.markers.get("child"));
    const report = core.redriveUndelivered("parent");
    assert.deepEqual(report.redriven.map(todo => todo.id), [oldTodoId], "the old settled obligation remains owed");
    assert.equal(core.todos.get(newTodoId)?.redriveAttempts, 0, "running work spends no delivery budget");
    assert.equal(core.getWorker("child", "run-a")?.redriveAttempts, 1);
    assert.equal(core.getWorker("child")?.redriveAttempts, 0);
    assert.deepEqual(durability.markers.get("child"), marker, "old delivery budget never overwrites the current marker");
    const reconciled = core.reconcileTodos("parent");
    assert.deepEqual(reconciled.landedUndelivered.map(todo => todo.id), [oldTodoId]);
    assert.deepEqual(reconciled.running.map(todo => todo.id), [newTodoId]);
    assert.equal(core.settleRecords.lookup("parent", "child", "run-a")?.resultText, "FIRST_OWED");
    const currentWait = core.awaitWorker("parent", "child", 1000);
    host.fireSettled({ workerId: "child", runId: "run-a", status: "completed", report: "STALE" });
    assert.equal(core.settleRecords.waiterCount("parent"), 1);
    host.fireSettled({ workerId: "child", runId: "run-b", status: "completed", report: "SECOND_OWED" });
    const completed = await currentWait;
    assert(completed.ok);
    assert.equal(completed.status, "settled");
    if (completed.ok && completed.status === "settled") assert.equal(completed.result, "SECOND_OWED");
    assert.equal(core.settleRecords.lookup("parent", "child", "run-a")?.resultText, "FIRST_OWED");
  } finally { core.dispose(); }
});

it("repeating an old delivered todo cannot clear the new run's marker or wake identity", () => {
  const host = new FakeDshHost();
  const durability = createInMemoryDurability();
  const core = createMultitask(host, { durability });
  try {
    const request = { workerId: "child", parentSessionId: "parent" };
    core.adoptSpawnedWorker({ ...request, runId: "run-a" });
    core.noteTurnStarted("child");
    host.fireSettled({ workerId: "child", runId: "run-a", status: "completed", report: "FIRST" });
    const oldTodoId = core.getWorker("child")!.todoId!;
    core.markDelivered(oldTodoId);
    const oldTodo = structuredClone(core.todos.get(oldTodoId));
    core.adoptSpawnedWorker({ ...request, runId: "run-b" });
    core.noteTurnStarted("child");
    const current = structuredClone(core.getWorker("child"));
    const marker = structuredClone(durability.markers.get("child"));
    const wake = structuredClone(durability.workerSessions.get("child"));
    assert(marker);
    assert(wake);
    assert.equal(core.markDelivered(oldTodoId), true);
    assert.equal(core.markDelivered(oldTodoId), true);
    assert.deepEqual(core.todos.get(oldTodoId), oldTodo);
    assert.deepEqual(core.getWorker("child"), current);
    assert.deepEqual(durability.markers.get("child"), marker);
    assert.deepEqual(durability.workerSessions.get("child"), wake);
    assert.equal(host.workerWakes.get("child"), "parent");
    host.fireSettled({ workerId: "child", runId: "run-a", status: "completed", report: "OLD_LATE" });
    assert.deepEqual(durability.markers.get("child"), marker);
    assert.deepEqual(durability.workerSessions.get("child"), wake);
    assert.equal(host.workerWakes.get("child"), "parent");
  } finally { core.dispose(); }
});
