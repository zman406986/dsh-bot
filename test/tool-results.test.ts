import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {formatCheckRowLine, formatCheckSummary, toCheckRow} from "../src/core/tool-results.js";
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

describe("check row stage segment (ticket 171)", () => {
  it("defaults the stage to null and renders no stage segment", () => {
    const row = toCheckRow(summary());
    assert.equal(row.stage, null);
    assert.ok(!formatCheckRowLine(row).includes("stage:"));
  });

  it("renders stage when present, after the liveness segment", () => {
    const row = toCheckRow(summary(), null, "quiet", "waiting-for-delivery");
    assert.equal(row.stage, "waiting-for-delivery");
    const line = formatCheckRowLine(row);
    assert.ok(line.includes("stage: waiting-for-delivery"));
    assert.ok(
      line.indexOf("liveness: quiet") < line.indexOf("stage:"),
      "stage must follow liveness, same as the documented row shape",
    );
  });

  /**
   * The S4 distinction the stage exists for: the two rows below carry the
   * SAME `status` (a delivered result and an owed one both ended their turn),
   * and only the stage separates "already read by the user" from "still owed".
   */
  it("distinguishes a delivered result from an owed one at equal status", () => {
    const owed = formatCheckRowLine(
      toCheckRow(summary({ status: "completed" }), null, "quiet", "waiting-for-delivery"),
    );
    const delivered = formatCheckRowLine(
      toCheckRow(summary({ status: "completed" }), null, "quiet", "ended"),
    );
    assert.ok(owed.includes("completed") && delivered.includes("completed"));
    assert.ok(owed.includes("stage: waiting-for-delivery"));
    assert.ok(delivered.includes("stage: ended"));
    assert.notEqual(owed, delivered);
  });

  it("the summary line carries the stage through formatCheckSummary", () => {
    const rows = [
      toCheckRow(summary(), null, null, "working"),
      toCheckRow(
        summary({ workerId: "w-2", streamKey: "todo-2" }),
        null,
        null,
        "ended",
      ),
    ];
    const text = formatCheckSummary(rows);
    assert.ok(text.includes("stage: working"));
    assert.ok(text.includes("stage: ended"));
  });
});

