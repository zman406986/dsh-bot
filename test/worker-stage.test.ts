import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkerStatus } from "../src/core/types.js";
import {
  deriveWorkerStage,
  WORKER_STAGES,
  type WorkerStage,
  type WorkerStageInput,
} from "../src/core/worker-stage.js";

/**
 * Ticket 171. The derivation is pure, so the table test below covers every
 * branch of it. The former `check_workers` wiring cases are gone with the
 * tool: stock `list_agents` has no stage field, and the derivation itself is
 * still the contract. No host, no clock, no LLM, no live run.
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
