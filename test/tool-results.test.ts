import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {toCheckRow} from "../src/core/tool-results.js";
import type { WorkerSummary } from "../src/core/types.js";

function summary(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  return {
    workerId: "w-1",
    parentSessionId: "session-1",
    streamKey: "todo-1",
    title: "Rewrite auth docs",
    status: "running",
    startedAtMs: 0,
    elapsedMs: 252_000,
    toolCallCount: 7,
    transcriptRef: "child-1",
    todoId: "t-3",
    ...overrides,
  };
}

describe("check row formatting", () => {
  it("maps a WorkerSummary onto a check row with nullable activity", () => {
    const row = toCheckRow(summary());
    assert.equal(row.worker_id, "w-1");
    assert.equal(row.stream_key, "todo-1");
    assert.equal(row.title, "Rewrite auth docs");
    assert.equal(row.status, "running");
    assert.equal(row.elapsed_ms, 252_000);
    assert.equal(row.tool_call_count, 7);
    assert.equal(row.transcript_ref, "child-1");
    assert.equal(row.todo_id, "t-3");
    assert.equal(row.recent_activity, null);
  });

});

