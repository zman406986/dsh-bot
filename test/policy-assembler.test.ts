import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assembleSessionPolicy,
  assembleTurnReminder,
  assembleWakeTurn,
  noticeFromSettled,
  type WakeNotice,
} from "../src/core/policy/assembler.js";
import {
  CHECK_WORKERS_TOOL,
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
  TOOL_DESCRIPTIONS,
} from "../src/core/policy/prompts.js";
import { emptyReportPlaceholder } from "../src/core/report-clamp.js";
import type { TodoItem } from "../src/core/todo-reconciler.js";

const FORBIDDEN_VOCAB = [
  "sand",
  "executor",
  "MessageSubagent",
  "SAND_MULTITASK_",
] as const;

function assertNewCopy(text: string): void {
  const lower = text.toLowerCase();
  for (const term of FORBIDDEN_VOCAB) {
    assert.ok(
      !lower.includes(term.toLowerCase()),
      `forbidden identifier in copy: ${term}`,
    );
  }
}

function todo(overrides: Partial<TodoItem> & { id: string }): TodoItem {
  return {
    sessionId: "session-1",
    title: "Task",
    status: "pending",
    streamKey: null,
    workerId: null,
    delivered: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

function notice(overrides: Partial<WakeNotice> = {}): WakeNotice {
  return {
    workerId: "w-1",
    title: "Rewrite auth docs",
    status: "completed",
    report: "Auth docs rewritten.",
    transcriptRef: "child-1",
    ...overrides,
  };
}

describe("session policy assembler", () => {
  it("flag OFF → empty (ADR-0005)", () => {
    assert.equal(assembleSessionPolicy(false), "");
  });

  it("flag ON → policy with stable sections in order", () => {
    const policy = assembleSessionPolicy(true);
    const headings = [
      "# Multitask dispatcher",
      "## How you work",
      "## What you never do",
    ];
    let last = -1;
    for (const heading of headings) {
      const at = policy.indexOf(heading);
      assert.ok(at >= 0, `missing section: ${heading}`);
      assert.ok(at > last, `section out of order: ${heading}`);
      last = at;
    }
    assertNewCopy(policy);
  });

  it("covers the PRD §6.1 behavioral bullets without jargon dumps", () => {
    const policy = assembleSessionPolicy(true).toLowerCase();
    for (const needle of [
      "dispatcher, not the workhorse",
      "parallel",
      "steer",
      "todo",
      "reconcile",
      "self-contained",
      "cannot talk to the user",
      "never hears the machinery",
      "poll",
    ]) {
      assert.ok(policy.includes(needle), `policy missing: ${needle}`);
    }
  });
});

describe("per-turn reminder assembler", () => {
  it("empty ledger still injects rules with (empty) marker", () => {
    const reminder = assembleTurnReminder([]);
    assert.ok(reminder.includes("## Ledger"));
    assert.ok(reminder.includes("(empty)"));
    assert.ok(reminder.includes("## Standing rules"));
    assertNewCopy(reminder);
  });

  it("renders id, status, and title per todo", () => {
    const reminder = assembleTurnReminder([
      todo({ id: "t-1", title: "Summarize RFCs", status: "in_progress" }),
      todo({ id: "t-2", title: "Changelog stub", status: "pending" }),
    ]);
    assert.ok(reminder.includes("- t-1 · in_progress · Summarize RFCs"));
    assert.ok(reminder.includes("- t-2 · pending · Changelog stub"));
    assert.ok(!reminder.includes("(empty)"));
  });

  it("standing rules cover short-turn / spawn / steer / todo / wake / silence", () => {
    const reminder = assembleTurnReminder([]);
    const rules = reminder.toLowerCase();
    for (const needle of [
      "short turn",
      "spawn",
      "steer",
      "todo before spawn",
      "reconcile",
      "never message the user",
      "never name the machinery",
    ]) {
      assert.ok(rules.includes(needle), `reminder missing: ${needle}`);
    }
  });
});

describe("wake-turn assembler", () => {
  it("sections appear in order and silence is a valid outcome", () => {
    const wake = assembleWakeTurn([notice()]);
    for (const heading of [
      "# Background work landed",
      "## Settled workers",
      "## What to do now",
    ]) {
      assert.ok(wake.includes(heading), `missing ${heading}`);
    }
    const settledAt = wake.indexOf("## Settled workers");
    const whatAt = wake.indexOf("## What to do now");
    assert.ok(settledAt < whatAt);
    assert.ok(wake.includes("Silence is a valid outcome") || wake.includes("Silence is a valid"));
    assert.ok(wake.toLowerCase().includes("stale"));
    assert.ok(wake.toLowerCase().includes("duplicate"));
    assert.ok(wake.includes("lead with the concrete thing"));
    assertNewCopy(wake);
  });

  it("clamps the report body and attaches the transcript pointer", () => {
    const long = "R".repeat(2500);
    const wake = assembleWakeTurn([notice({ report: long })]);
    assert.ok(wake.includes("Transcript: child-1"));
    assert.ok(wake.includes("report truncated"));
    assert.ok(wake.includes("Full transcript: child-1"));
  });

  it("empty report → placeholder pointing at the transcript", () => {
    const wake = assembleWakeTurn([notice({ report: "" })]);
    assert.ok(wake.includes(emptyReportPlaceholder()));
  });

  it("error notice is prefixed", () => {
    const wake = assembleWakeTurn([
      notice({ status: "error", report: "timeout after 10m" }),
    ]);
    assert.ok(wake.includes("Worker failed:"));
    assert.ok(wake.includes("timeout after 10m"));
  });

  it("aborted notice carries no real report", () => {
    const wake = assembleWakeTurn([
      notice({ status: "aborted", report: "secret work product" }),
    ]);
    assert.ok(wake.includes("Stopped before completion"));
    assert.ok(!wake.includes("secret work product"));
  });

  it("maps SettledWorkerNotice through noticeFromSettled", () => {
    const mapped = noticeFromSettled(
      {
        workerId: "w-2",
        status: "completed",
        title: "Changelog",
        resultText: "Drafted.",
      },
      "child-2",
    );
    assert.equal(mapped.workerId, "w-2");
    assert.equal(mapped.title, "Changelog");
    assert.equal(mapped.status, "completed");
    assert.equal(mapped.report, "Drafted.");
    assert.equal(mapped.transcriptRef, "child-2");
  });
});

describe("tool descriptions (new copy)", () => {
  it("covers the five dispatcher tool names", () => {
    assert.deepEqual(
      [...DISPATCHER_TOOL_NAMES],
      [
        SPAWN_WORKER_TOOL,
        CHECK_WORKERS_TOOL,
        STEER_WORKER_TOOL,
        STOP_WORKER_TOOL,
        DELIVER_RESULT_TOOL,
      ],
    );
    for (const name of DISPATCHER_TOOL_NAMES) {
      const description = TOOL_DESCRIPTIONS[name];
      assert.ok(typeof description === "string" && description.length > 20);
      assertNewCopy(description);
    }
  });

  it("spawn description says do not wait or poll", () => {
    const description = TOOL_DESCRIPTIONS[SPAWN_WORKER_TOOL];
    assert.ok(description.includes("do not wait or poll"));
  });

  it("deliver description covers silence on wake turns", () => {
    const description = TOOL_DESCRIPTIONS[DELIVER_RESULT_TOOL];
    assert.ok(description.includes("otherwise stay silent"));
    assert.ok(description.includes("concrete thing"));
  });
});
