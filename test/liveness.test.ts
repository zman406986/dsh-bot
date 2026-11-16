import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveWorkerLiveness,
  WORKER_ACTIVE_WINDOW_MS,
  WORKER_STALL_THRESHOLD_MS,
  type WorkerLivenessInput,
} from "../src/core/liveness.js";

/**
 * Ticket 61 (register A-8, ADR-0018 exception D22): the liveness verdict is
 * a pure derivation. Every test passes `nowMs` explicitly — no real clock
 * anywhere (R1, S8).
 *
 * The former `check_workers` surfacing and end-to-end cases are gone with the
 * tool: stock `list_agents` has no liveness or activity field, so there is no
 * shipped projector left to pin. The derivation suite below is the contract.
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
