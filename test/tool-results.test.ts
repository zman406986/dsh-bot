import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {formatAwaitNote, formatCheckRowLine, formatCheckSummary, toAwaitAgentToolResult, toCheckRow} from "../src/core/tool-results.js";
import { abortedReportBody, emptyErrorReportBody, emptyReportPlaceholder } from "../src/core/report-clamp.js";
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

describe("await note — status-aware settlement", () => {
  it("an aborted settle never reads as a finished worker", () => {
    const note = formatAwaitNote("w-1", {
      status: "settled",
      workerStatus: "aborted",
      result: emptyReportPlaceholder(),
    });
    assert.ok(note.includes("settled: aborted"));
    assert.ok(!note.toLowerCase().includes("finished"));
    assert.ok(!note.includes("See the transcript"), "no unnamed transcript pointer");
    assert.ok(!note.includes(emptyReportPlaceholder()));
  });

  it("maps an aborted settle onto the bookkeeping body, not the completed placeholder", () => {
    const mapped = toAwaitAgentToolResult("w-1", {
      ok: true,
      status: "settled",
      workerStatus: "aborted",
      result: emptyReportPlaceholder(),
      settledAtMs: 1,
      waitedMs: 2,
    });
    assert.ok(mapped.ok);
    if (!mapped.ok || mapped.status !== "settled") return;
    assert.equal(mapped.worker_status, "aborted");
    assert.equal(mapped.result, abortedReportBody());
    assert.ok(!mapped.summary.includes(emptyReportPlaceholder()));
    assert.ok(!mapped.summary.toLowerCase().includes("finished"));
  });

  it("an aborted settle with real partial findings keeps them, labelled partial", () => {
    const mapped = toAwaitAgentToolResult("w-1", {
      ok: true,
      status: "settled",
      workerStatus: "aborted",
      result: "half of the migration is staged",
      settledAtMs: 1,
      waitedMs: 2,
    });
    assert.ok(mapped.ok);
    if (!mapped.ok || mapped.status !== "settled") return;
    assert.equal(mapped.worker_status, "aborted");
    assert.equal(
      mapped.result,
      "Worker stopped before completion. Partial report:\nhalf of the migration is staged",
    );
    assert.ok(mapped.summary.includes("half of the migration is staged"));
    assert.match(mapped.summary, /partial/);
    assert.ok(!mapped.summary.includes(abortedReportBody()));
    assert.ok(!mapped.summary.includes(emptyReportPlaceholder()));
  });

  it("an aborted settle with only the completed placeholder still gets the no-report body", () => {
    const mapped = toAwaitAgentToolResult("w-1", {
      ok: true,
      status: "settled",
      workerStatus: "aborted",
      result: emptyReportPlaceholder(),
      settledAtMs: 1,
      waitedMs: 2,
    });
    assert.ok(mapped.ok);
    if (!mapped.ok || mapped.status !== "settled") return;
    assert.equal(mapped.result, abortedReportBody());
    assert.ok(!mapped.summary.includes(emptyReportPlaceholder()));
  });

  it("keeps a completed settle's real result untouched", () => {
    const note = formatAwaitNote("w-1", {
      status: "settled",
      workerStatus: "completed",
      result: "The docs are rewritten.",
    });
    assert.ok(note.includes("Result:\nThe docs are rewritten."));
    assert.ok(note.includes("Continue from this result."));
  });

  it("an error settle stored as the completed placeholder reads as an error", () => {
    const mapped = toAwaitAgentToolResult("w-1", {
      ok: true,
      status: "settled",
      workerStatus: "error",
      // The settle path clamps every report through the completed-report path.
      result: emptyReportPlaceholder(),
      settledAtMs: 1,
      waitedMs: 2,
    });
    assert.ok(mapped.ok);
    if (!mapped.ok || mapped.status !== "settled") return;
    assert.equal(mapped.worker_status, "error");
    assert.equal(mapped.result, emptyErrorReportBody());
    assert.ok(!mapped.summary.includes(emptyReportPlaceholder()));
    assert.ok(!mapped.summary.includes("produced no text"));
    assert.match(mapped.summary, /No error message was recorded/);
    assert.ok(mapped.summary.includes("not a successful finish"));
  });

  it("the adapter's empty-error sentinel is never echoed as a result", () => {
    const mapped = toAwaitAgentToolResult("w-1", {
      ok: true,
      status: "settled",
      workerStatus: "error",
      result: "worker failed with no message",
      settledAtMs: 1,
      waitedMs: 2,
    });
    assert.ok(mapped.ok);
    if (!mapped.ok || mapped.status !== "settled") return;
    assert.equal(mapped.result, emptyErrorReportBody());
    assert.ok(!mapped.summary.includes("worker failed with no message"));
  });

  it("an error settle with real text is prefixed as a failure, not a result", () => {
    const mapped = toAwaitAgentToolResult("w-1", {
      ok: true,
      status: "settled",
      workerStatus: "error",
      result: "it broke",
      settledAtMs: 1,
      waitedMs: 2,
    });
    assert.ok(mapped.ok);
    if (!mapped.ok || mapped.status !== "settled") return;
    assert.equal(mapped.result, "Worker failed:\nit broke");
    assert.ok(mapped.summary.includes("Worker failed:\nit broke"));
    assert.ok(!mapped.summary.includes(emptyReportPlaceholder()));
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

