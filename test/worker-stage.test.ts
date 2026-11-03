import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";
import { CHECK_WORKERS_TOOL } from "../src/core/policy/prompts.js";
import type { CheckWorkersToolResult } from "../src/core/tool-results.js";
import { createDispatcherTools } from "../src/core/tools.js";
import type { SpawnResult, WorkerStatus } from "../src/core/types.js";
import {
  deriveWorkerStage,
  WORKER_STAGES,
  type WorkerStage,
  type WorkerStageInput,
} from "../src/core/worker-stage.js";

/**
 * Ticket 171. The derivation is pure, so the table test below covers every
 * branch of it; the second test proves `check_workers` actually passes the
 * argument and renders it. No host, no clock, no LLM, no live run.
 */

type LinkedTodo = WorkerStageInput["linkedTodo"];

/**
 * The five ledger shapes the table distinguishes. Each label is the case's
 * whole meaning: `undefined` (no structural link), a delivered item, and
 * three undelivered items whose `status` differs where it matters.
 */
const TODO_CASES: Array<{ readonly label: string; readonly linkedTodo: LinkedTodo }> = [
  { label: "no-link", linkedTodo: undefined },
  { label: "delivered", linkedTodo: { delivered: true, status: "completed" } },
  { label: "in_progress-undelivered", linkedTodo: { delivered: false, status: "in_progress" } },
  { label: "completed-undelivered", linkedTodo: { delivered: false, status: "completed" } },
  { label: "lost-undelivered", linkedTodo: { delivered: false, status: "lost" } },
] as const;

const STATUSES: readonly WorkerStatus[] = [
  "spawned",
  "running",
  "steering",
  "completed",
  "error",
  "aborted",
] as const;

/**
 * The expectation table, written out per combination — NOT derived from the
 * implementation. Every row here is the ticket's four-row table read by hand:
 *
 * 1. terminal + an undelivered, non-lost/non-cancelled linked item
 *                          → waiting-for-delivery
 * 2. spawned | running | steering → working
 * 3. terminal, nothing owed       → ended
 *
 * Ticket 174 / ADR-0033 removed the `waiting-for-answer` row with the worker
 * access-ask feature, so the table no longer varies on `awaitingAnswer`.
 */
const EXPECTED: Record<WorkerStatus, Record<string, WorkerStage>> = {
  spawned: {
    "no-link": "working",
    delivered: "working",
    "in_progress-undelivered": "working",
    "completed-undelivered": "working",
    "lost-undelivered": "working",
  },
  running: {
    "no-link": "working",
    delivered: "working",
    "in_progress-undelivered": "working",
    "completed-undelivered": "working",
    "lost-undelivered": "working",
  },
  steering: {
    "no-link": "working",
    delivered: "working",
    "in_progress-undelivered": "working",
    "completed-undelivered": "working",
    "lost-undelivered": "working",
  },
  completed: {
    "no-link": "ended",
    delivered: "ended",
    "in_progress-undelivered": "waiting-for-delivery",
    "completed-undelivered": "waiting-for-delivery",
    "lost-undelivered": "ended",
  },
  error: {
    "no-link": "ended",
    delivered: "ended",
    "in_progress-undelivered": "waiting-for-delivery",
    "completed-undelivered": "waiting-for-delivery",
    "lost-undelivered": "ended",
  },
  aborted: {
    "no-link": "ended",
    delivered: "ended",
    "in_progress-undelivered": "waiting-for-delivery",
    "completed-undelivered": "waiting-for-delivery",
    "lost-undelivered": "ended",
  },
};

describe("worker stage — the derivation table", () => {
  it("covers 6 statuses × 5 ledger cases, and is total", () => {
    let checked = 0;
    for (const status of STATUSES) {
      for (const todoCase of TODO_CASES) {
        const expected = EXPECTED[status][todoCase.label];
        assert.ok(
          expected !== undefined,
          `expectation table is missing ${status} / ${todoCase.label}`,
        );
        const actual = deriveWorkerStage({
          status,
          linkedTodo: todoCase.linkedTodo,
        });
        assert.equal(
          actual,
          expected,
          `${status} · ${todoCase.label}`,
        );
        // Totality: the return value is always one of the three words.
        assert.ok(
          WORKER_STAGES.includes(actual),
          `${String(actual)} is not one of WORKER_STAGES`,
        );
        checked += 1;
      }
    }
    assert.equal(checked, 30);
    assert.deepEqual(WORKER_STAGES, [
      "waiting-for-delivery",
      "working",
      "ended",
    ]);
    // The `cancelled` half of row 2's exclusion. A cancelled item is pruned
    // by the core, so this shape is defensive — same as row 1's ordering.
    assert.equal(
      deriveWorkerStage({
        status: "completed",
        linkedTodo: { delivered: false, status: "cancelled" },
      }),
      "ended",
    );
    // A pending item with no worker is not a worker, but the shape is total:
    // an undelivered pending link on a terminal worker reads as owed.
    assert.equal(
      deriveWorkerStage({
        status: "completed",
        linkedTodo: { delivered: false, status: "pending" },
      }),
      "waiting-for-delivery",
    );
  });
});

describe("worker stage — check_workers wiring", () => {
  it("renders waiting-for-delivery until the result is delivered, then ended", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const tools = createDispatcherTools({
      multitask,
      getSessionId: () => "session-1",
    });
    multitask.createTodo({
      sessionId: "session-1",
      id: "t-1",
      title: "Rewrite auth docs",
    });
    const spawn: SpawnResult = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "t-1",
      title: "Rewrite auth docs",
      prompt: "Go.",
      todoId: "t-1",
    });
    assert.ok(spawn.ok, spawn.ok ? "" : spawn.detail);
    if (!spawn.ok) return;
    multitask.noteTurnStarted(spawn.workerId);
    host.fireSettled({
      workerId: spawn.workerId,
      status: "completed",
      report: "Done.",
    });

    const check = tools.find((tool) => tool.name === CHECK_WORKERS_TOOL);
    assert.ok(check, `missing tool: ${CHECK_WORKERS_TOOL}`);
    if (check === undefined) return;

    const owed = (await check.execute({})) as CheckWorkersToolResult;
    assert.ok(owed.ok);
    if (!owed.ok) return;
    assert.equal(owed.rows.length, 1);
    assert.equal(owed.rows[0]?.stage, "waiting-for-delivery");
    assert.ok(owed.summary.includes("stage: waiting-for-delivery"));

    // Two calls prove the join is live, not hard-coded.
    assert.ok(multitask.markDelivered("t-1"));
    const settled = (await check.execute({})) as CheckWorkersToolResult;
    assert.ok(settled.ok);
    if (!settled.ok) return;
    assert.equal(settled.rows[0]?.stage, "ended");
    assert.ok(settled.summary.includes("stage: ended"));
    assert.ok(!settled.summary.includes("stage: waiting-for-delivery"));
  });
});
