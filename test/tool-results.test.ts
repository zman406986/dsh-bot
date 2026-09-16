import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatCheckRowLine,
  formatCheckSummary,
  formatElapsedMs,
  formatSpawnAck,
  formatSteerNote,
  formatStopNote,
  toCheckRow,
  type WorkerCheckRow,
} from "../src/core/tool-results.js";
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

  it("includes elapsed, tool count, activity, and transcript in the line", () => {
    const row = toCheckRow(summary(), "reading src/auth/session.ts");
    const line = formatCheckRowLine(row);
    assert.ok(line.includes("running"));
    assert.ok(line.includes("4m12s"));
    assert.ok(line.includes("7 tool calls"));
    assert.ok(line.includes("todo t-3"));
    assert.ok(line.includes("transcript: child-1"));
    assert.ok(line.includes("activity: reading src/auth/session.ts"));
  });

  it("pluralizes tool calls", () => {
    const row = toCheckRow(summary({ toolCallCount: 1 }));
    assert.ok(formatCheckRowLine(row).includes("1 tool call"));
  });

  it("empty roster summary is honest", () => {
    assert.equal(formatCheckSummary([]), "No workers on the roster for this session.");
  });

  it("folds long rosters with a count line", () => {
    const rows: WorkerCheckRow[] = Array.from({ length: 25 }, (_, i) =>
      toCheckRow(
        summary({
          workerId: `w-${i}`,
          title: `Task ${i}`,
          transcriptRef: null,
          todoId: null,
        }),
      ),
    );
    const text = formatCheckSummary(rows, 20);
    assert.ok(text.includes("… and 5 more."));
    assert.ok(!text.includes('"Task 24"'));
  });

  it("missing transcript is explicit, not omitted", () => {
    const row = toCheckRow(summary({ transcriptRef: null }));
    assert.ok(formatCheckRowLine(row).includes("transcript: (none)"));
  });
});

describe("elapsed formatting", () => {
  it("covers seconds, minutes, and hours", () => {
    assert.equal(formatElapsedMs(0), "0s");
    assert.equal(formatElapsedMs(45_000), "45s");
    assert.equal(formatElapsedMs(252_000), "4m12s");
    assert.equal(formatElapsedMs(120_000), "2m");
    assert.equal(formatElapsedMs(3_600_000), "1h");
    assert.equal(formatElapsedMs(5_400_000), "1h30m");
  });
});

describe("spawn / steer / stop notes", () => {
  it("spawn ack says background and do not wait", () => {
    const ack = formatSpawnAck({
      title: "Summarize RFCs",
      workerId: "w-9",
      streamKey: "todo-1",
      prompt: "Summarize three RFCs.",
    });
    assert.ok(ack.includes("Summarize RFCs"));
    assert.ok(ack.includes("background"));
    assert.ok(ack.includes("do not need to wait"));
    assert.ok(ack.includes("poll"));
    assert.ok(ack.includes("Summarize three RFCs."));
  });

  it("steer note does not re-echo the message and says no restart", () => {
    const note = formatSteerNote("Summarize RFCs");
    assert.ok(note.includes("Summarize RFCs"));
    assert.ok(note.includes("no restart"));
    assert.ok(note.includes("latest"));
  });

  it("stop note is silent-to-user by default", () => {
    const note = formatStopNote();
    assert.ok(note.includes("Stopped"));
    assert.ok(note.includes("Tell the user only if"));
  });
});
