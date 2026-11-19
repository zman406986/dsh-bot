import assert from "node:assert/strict";
import { it } from "node:test";
import { createMultitask } from "../src/core/multitask.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createInMemoryDurability } from "../src/core/durability.js";
import { markerDomainSpec, MARKER_TABLE_NAME, WORKER_SESSION_TABLE_NAME } from "../src/adapter/durable-marker.js";

it("rebuilds the terminal current execution with its native run identity", async () => {
  const durability = createInMemoryDurability();
  const host = new FakeDshHost();
  const core = createMultitask(host, { durability });
  const request = { workerId: "child", parentSessionId: "parent" };
  try {
    core.adoptSpawnedWorker({ ...request, runId: "run-a" });
    core.noteTurnStarted("child");
    host.fireSettled({ workerId: "child", runId: "run-a", status: "completed", report: "FIRST" });
    core.markDelivered(core.getWorker("child")!.todoId!);
    core.adoptSpawnedWorker({ ...request, runId: "run-b" });
    core.noteTurnStarted("child");
    host.fireSettled({ workerId: "child", runId: "run-b", status: "completed", report: "SECOND" });
  } finally { core.dispose(); }
  const restored = createMultitask(new FakeDshHost(), { durability });
  try {
    await restored.rebuildFromDurability("parent");
    assert.equal(restored.getWorker("child")?.status, "completed");
    assert.equal(restored.getWorker("child")?.runId, "run-b", "recovery must identify the current native execution");
  } finally { restored.dispose(); }
});

it("keeps legacy marker and wake schemas compatible while validating optional native identity", () => {
  const spec = markerDomainSpec();
  assert(typeof spec === "object" && spec !== null && "tables" in spec);
  const tables = spec.tables;
  assert(typeof tables === "object" && tables !== null);
  for (const [name, legacy] of [
    [MARKER_TABLE_NAME, { workerId: "child", parentSessionId: "parent", streamKey: "child", title: "work", status: "running", transcriptRef: null, todoId: "todo-1", startedAtMs: 1, updatedAtMs: 2 }],
    [WORKER_SESSION_TABLE_NAME, { sessionId: "child", parentSessionId: "parent" }],
  ] as const) {
    assert(name in tables);
    const entry: unknown = Reflect.get(tables, name);
    assert(typeof entry === "object" && entry !== null && "valueSchema" in entry);
    const schema = entry.valueSchema;
    assert(typeof schema === "object" && schema !== null && "parse" in schema);
    const parse = schema.parse;
    assert(typeof parse === "function");
    assert.deepEqual(parse(JSON.parse(JSON.stringify(legacy))), legacy);
    assert.deepEqual(parse(JSON.parse(JSON.stringify({ ...legacy, runId: "run-b" }))), { ...legacy, runId: "run-b" });
    for (const runId of ["", 123, null]) assert.throws(() => parse({ ...legacy, runId }), /runId/);
  }
});

it("records native identity in the active worker wake row", () => {
  const durability = createInMemoryDurability();
  const core = createMultitask(new FakeDshHost(), { durability });
  try {
    core.adoptSpawnedWorker({ workerId: "child", parentSessionId: "parent", runId: "run-b" });
    assert.deepEqual(durability.workerSessions.get("child"), {
      sessionId: "child", parentSessionId: "parent", runId: "run-b",
    });
  } finally { core.dispose(); }
});
