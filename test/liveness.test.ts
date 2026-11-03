import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveWorkerLiveness,
  WORKER_ACTIVE_WINDOW_MS,
  WORKER_STALL_THRESHOLD_MS,
  type WorkerLivenessInput,
} from "../src/core/liveness.js";
import { formatCheckRowLine, toCheckRow } from "../src/core/tool-results.js";
import type { WorkerSummary } from "../src/core/types.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  createDispatcherTools,
  type DispatcherToolDef,
} from "../src/core/tools.js";
import { CHECK_WORKERS_TOOL } from "../src/core/policy/prompts.js";
import type { CheckWorkersToolResult } from "../src/core/tool-results.js";
import type { SpawnResult } from "../src/core/types.js";

/**
 * Ticket 61 (register A-8, ADR-0018 exception D22): the liveness verdict is
 * a pure derivation over the fields check_workers already projects. Every
 * test passes `nowMs` explicitly — no real clock anywhere (R1, S8).
 */

const NOW = 1_000_000;

function input(
  overrides: Partial<WorkerLivenessInput> = {},
): WorkerLivenessInput {
  return {
    status: "running",
    startedAtMs: NOW - 5 * 60_000,
    toolCallCount: 3,
    lastActivityAtMs: NOW - 5_000,
    ...overrides,
  };
}

function summary(
  overrides: Partial<WorkerSummary> = {},
): WorkerSummary {
  return {
    workerId: "w-1",
    parentSessionId: "session-1",
    streamKey: "s-1",
    title: "Summarize RFCs",
    status: "running",
    startedAtMs: NOW - 5 * 60_000,
    elapsedMs: 5 * 60_000,
    toolCallCount: 3,
    transcriptRef: "w-1",
    todoId: "t-1",
    ...overrides,
  };
}

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

function byName(tools: DispatcherToolDef[], name: string): DispatcherToolDef {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool;
}

describe("liveness — verdict classes", () => {
  it("advancing: activity observed within the active window reads active", () => {
    const verdict = deriveWorkerLiveness(
      input({ lastActivityAtMs: NOW - 5_000 }),
      NOW,
    );
    assert.equal(verdict, "active");
  });

  it("quiet-but-fine: activity older than the active window but inside the stall bound reads quiet", () => {
    const verdict = deriveWorkerLiveness(
      input({ lastActivityAtMs: NOW - WORKER_ACTIVE_WINDOW_MS - 1 }),
      NOW,
    );
    assert.equal(verdict, "quiet");
  });

  it("stalled: silence beyond the stall threshold on a live worker reads stalled", () => {
    const verdict = deriveWorkerLiveness(
      input({ lastActivityAtMs: NOW - WORKER_STALL_THRESHOLD_MS - 1 }),
      NOW,
    );
    assert.equal(verdict, "stalled");
  });
});

describe("liveness — boundaries", () => {
  it("exactly at the stall threshold still reads quiet (strictly-beyond stalls, like isRosterSnapshotStale)", () => {
    const verdict = deriveWorkerLiveness(
      input({ lastActivityAtMs: NOW - WORKER_STALL_THRESHOLD_MS }),
      NOW,
    );
    assert.equal(verdict, "quiet");
  });

});

describe("liveness — never-observed workers", () => {
  it("no observed activity and no counted calls is measured from start: young reads quiet", () => {
    const verdict = deriveWorkerLiveness(
      input({
        status: "spawned",
        toolCallCount: 0,
        lastActivityAtMs: null,
        startedAtMs: NOW - WORKER_STALL_THRESHOLD_MS,
      }),
      NOW,
    );
    assert.equal(verdict, "quiet");
  });

  it("no observed activity, no counted calls, silent past the threshold since spawn reads stalled (wedged at start)", () => {
    const verdict = deriveWorkerLiveness(
      input({
        status: "spawned",
        toolCallCount: 0,
        lastActivityAtMs: null,
        startedAtMs: NOW - WORKER_STALL_THRESHOLD_MS - 1,
      }),
      NOW,
    );
    assert.equal(verdict, "stalled");
  });

});

describe("liveness — misclassification pins (R3)", () => {
  it("a settled (completed) worker never reads stalled, however long the silence", () => {
    const verdict = deriveWorkerLiveness(
      input({
        status: "completed",
        toolCallCount: 0,
        lastActivityAtMs: null,
        startedAtMs: NOW - 100 * WORKER_STALL_THRESHOLD_MS,
      }),
      NOW,
    );
    assert.equal(verdict, "quiet");
  });

  it("an errored worker never reads stalled", () => {
    const verdict = deriveWorkerLiveness(
      input({ status: "error", lastActivityAtMs: NOW - 100 * WORKER_STALL_THRESHOLD_MS }),
      NOW,
    );
    assert.equal(verdict, "quiet");
  });

  it("an aborted worker never reads stalled, however long the silence", () => {
    const verdict = deriveWorkerLiveness(
      input({
        status: "aborted",
        toolCallCount: 0,
        lastActivityAtMs: null,
        startedAtMs: NOW - 100 * WORKER_STALL_THRESHOLD_MS,
      }),
      NOW,
    );
    assert.equal(verdict, "quiet");
  });

});

describe("liveness — check-row surfacing", () => {
  it("toCheckRow with a verdict carries it and the summary line shows it", () => {
    const row = toCheckRow(summary(), "reading notes", "active");
    assert.equal(row.liveness, "active");
    const line = formatCheckRowLine(row);
    assert.ok(line.includes("liveness: active"));
    assert.ok(line.includes("activity: reading notes"));
  });

});

describe("liveness — end to end through check_workers", () => {
  async function setup(options?: {
    lastActivityAtMs?: (workerId: string) => number | null;
  }): Promise<{ host: FakeDshHost; multitask: Multitask; tools: DispatcherToolDef[] }> {
    const host = new FakeDshHost();
    // Ticket 174 / ADR-0033 removed the access-ask seam and its options;
    // the core is constructed with defaults here.
    const multitask = createMultitask(host);
    const tools = createDispatcherTools({
      multitask,
      getSessionId: () => "session-1",
      ...(options?.lastActivityAtMs !== undefined
        ? { lastActivityAtMs: options.lastActivityAtMs }
        : {}),
    });
    return { host, multitask, tools };
  }

  async function spawnRunning(
    multitask: Multitask,
    streamKey: string,
  ): Promise<string> {
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey,
        title: "Summarize RFCs",
        prompt: "Do the work.",
      }),
    );
    multitask.noteTurnStarted(workerId);
    return workerId;
  }

  it("a worker with only ancient observed activity reads stalled", async () => {
    const { multitask, tools } = await setup({
      lastActivityAtMs: () => 0, // observed long before any realistic now
    });
    const workerId = await spawnRunning(multitask, "s-1");
    multitask.noteToolCall(workerId);
    const result = (await byName(tools, CHECK_WORKERS_TOOL).execute(
      {},
    )) as CheckWorkersToolResult;
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.rows[0]?.liveness, "stalled");
    assert.ok(result.summary.includes("liveness: stalled"));
  });

});
