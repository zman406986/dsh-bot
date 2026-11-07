import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  AWAIT_DEFAULT_TIMEOUT_MS,
  AWAIT_MAX_TIMEOUT_MS,
  MAX_CONCURRENT_WAITS,
  SETTLE_RING_SIZE,
  createSettleRecords,
  resolveAwaitTarget,
  validateAwaitTimeout,
} from "../src/core/settle-records.js";
import type { AwaitWorkerOutcome } from "../src/core/settle-records.js";
import { REPORT_CLAMP_CHARS } from "../src/core/report-clamp.js";
import type { SpawnResult, WorkerRecord } from "../src/core/types.js";

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

async function spawnWorker(
  multitask: Multitask,
  parentSessionId = "session-1",
  streamKey = "stream-1",
): Promise<string> {
  return unwrapSpawn(
    await multitask.spawnWorker({
      parentSessionId,
      streamKey,
      title: "Await subject",
      prompt: "Do the work.",
    }),
  );
}

interface FakeTimerEntry {
  readonly ms: number;
  fired: boolean;
  cancelled: boolean;
  fire(): void;
}

/** Manual clock + scheduler seams so no test waits on a real timer. */
function manualAwaitSeams(startMs = 1_000_000): {
  now: () => number;
  schedule: (fn: () => void, ms: number) => () => void;
  readonly scheduled: readonly FakeTimerEntry[];
  advance(step: number): void;
} {
  let currentMs = startMs;
  const scheduled: FakeTimerEntry[] = [];
  return {
    now: () => currentMs,
    schedule: (fn, ms) => {
      const entry: FakeTimerEntry = {
        ms,
        fired: false,
        cancelled: false,
        fire: () => {
          if (!entry.cancelled) {
            entry.fired = true;
            fn();
          }
        },
      };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    scheduled,
    advance: (step) => {
      currentMs += step;
    },
  };
}

function fakeWorker(parentSessionId: string): WorkerRecord {
  return {
    workerId: "w",
    parentSessionId,
    streamKey: "s",
    title: "t",
    status: "running",
    startedAtMs: 0,
    toolCallCount: 0,
    transcriptRef: null,
    todoId: null,
    redriveAttempts: 0,
  };
}

/** A report string of exactly `chars` characters. */
function longReport(chars: number): string {
  return "r".repeat(chars);
}

describe("settle record ring (ticket 115)", () => {
  it("the settle path records the clamped result before any waiter exists", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnWorker(multitask);
    host.fireSettled({
      workerId,
      status: "completed",
      report: longReport(10_000),
      transcriptRef: "child-1",
    });
    const record = multitask.settleRecords.lookup("session-1", workerId);
    assert.ok(record !== undefined);
    assert.equal(record.workerId, workerId);
    assert.equal(record.status, "completed");
    // Clamped by the wake-side clamp rule; the marker carries the transcript.
    assert.ok(record.resultText.startsWith("r".repeat(REPORT_CLAMP_CHARS)));
    assert.ok(record.resultText.includes("[report truncated: 4000 of 10000 characters."));
    assert.ok(record.resultText.includes("Full transcript: child-1"));
    assert.equal(typeof record.settledAtMs, "number");
  });

  it("the record outlives the wake drain — a wait after the wake still reads it", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnWorker(multitask);
    host.fireSettled({ workerId, status: "completed", report: "done" });
    const record = multitask.settleRecords.lookup("session-1", workerId);
    assert.ok(record !== undefined);
    // The wake was drained; the record must not depend on the wake.
    assert.ok(multitask.drainWake("session-1") !== undefined);
    const outcome = await multitask.settleRecords.wait("session-1", workerId, 0);
    assert.deepEqual(outcome, {
      ok: true,
      status: "settled",
      workerStatus: "completed",
      result: "done",
      settledAtMs: record.settledAtMs,
      waitedMs: 0,
    });
  });

  it("evicts the oldest record past the ring bound of 64", () => {
    const records = createSettleRecords();
    for (let i = 1; i <= SETTLE_RING_SIZE + 1; i++) {
      records.record("session-1", {
        workerId: `w-${i}`,
        status: "completed",
        resultText: `result ${i}`,
        settledAtMs: i,
      });
    }
    assert.equal(records.lookup("session-1", "w-1"), undefined);
    assert.ok(records.lookup("session-1", "w-2") !== undefined);
    assert.equal(records.lookup("session-1", "w-65")?.resultText, "result 65");
    // A sibling session's ring is independent and unaffected.
    assert.equal(records.lookup("session-2", "w-2"), undefined);
  });
});

describe("await wait engine (ticket 115)", () => {
  it("settled-before-wait with timeout 0 returns the record immediately", async () => {
    const host = new FakeDshHost();
    const seams = manualAwaitSeams();
    const multitask = createMultitask(host, { awaits: { now: seams.now, schedule: seams.schedule } });
    const workerId = await spawnWorker(multitask);
    host.fireSettled({ workerId, status: "completed", report: "finished" });
    const outcome = await multitask.settleRecords.wait("session-1", workerId, 0);
    assert.ok(outcome.ok && outcome.status === "settled");
    assert.equal(outcome.workerStatus, "completed");
    assert.equal(outcome.result, "finished");
    assert.equal(outcome.waitedMs, 0);
    // A non-blocking read arms no timer and registers no waiter.
    assert.equal(seams.scheduled.length, 0);
    assert.equal(multitask.settleRecords.waiterCount("session-1"), 0);
  });

  it("settle during the wait resolves it with the clamped result and cancels the timer", async () => {
    const host = new FakeDshHost();
    const seams = manualAwaitSeams();
    const multitask = createMultitask(host, { awaits: { now: seams.now, schedule: seams.schedule } });
    const workerId = await spawnWorker(multitask);
    const pending = multitask.settleRecords.wait("session-1", workerId, 30_000);
    assert.equal(seams.scheduled.length, 1);
    assert.equal(multitask.settleRecords.waiterCount("session-1"), 1);
    seams.advance(40);
    host.fireSettled({
      workerId,
      status: "completed",
      report: longReport(10_000),
    });
    const outcome = await pending;
    assert.ok(outcome.ok && outcome.status === "settled");
    assert.equal(outcome.waitedMs, 40);
    assert.ok(outcome.result.includes("[report truncated: 4000 of 10000 characters."));
    assert.equal(outcome.settledAtMs, multitask.settleRecords.lookup("session-1", workerId)?.settledAtMs);
    // The losing timer did not survive the win.
    assert.equal(seams.scheduled[0]?.cancelled, true);
    assert.equal(multitask.settleRecords.waiterCount("session-1"), 0);
    // Wake composition is untouched: the settle wake still arrives.
    const drained = multitask.drainWake("session-1");
    assert.ok(drained !== undefined);
    assert.deepEqual(
      drained.wake.settledWorkers.map((worker) => worker.workerId),
      [workerId],
    );
  });

  it("timeout returns still-running and a later settle is not lost", async () => {
    const host = new FakeDshHost();
    const seams = manualAwaitSeams();
    const multitask = createMultitask(host, { awaits: { now: seams.now, schedule: seams.schedule } });
    const workerId = await spawnWorker(multitask);
    const pending = multitask.settleRecords.wait("session-1", workerId, 30_000);
    seams.advance(30_000);
    seams.scheduled[0]?.fire();
    const outcome = await pending;
    assert.deepEqual(outcome, { ok: true, status: "still-running", waitedMs: 30_000 });
    assert.equal(multitask.settleRecords.waiterCount("session-1"), 0);
    // The late settle is still recorded — a later read sees it.
    host.fireSettled({ workerId, status: "completed", report: "late but kept" });
    const after = await multitask.settleRecords.wait("session-1", workerId, 0);
    assert.ok(after.ok && after.status === "settled");
    assert.equal(after.result, "late but kept");
  });

  it("times out as gone when the agent is dead and no settle was recorded", async () => {
    // A dead worker with no record must never read as "still running" — the
    // honest answer is that it is gone.
    const host = new FakeDshHost();
    const seams = manualAwaitSeams();
    let aliveChecks = 0;
    const multitask = createMultitask(host, {
      awaits: { now: seams.now, schedule: seams.schedule },
      isAgentAlive: () => {
        aliveChecks += 1;
        return false;
      },
    });
    const workerId = await spawnWorker(multitask);
    const pending = multitask.settleRecords.wait("session-1", workerId, 1_000);
    seams.advance(1_000);
    seams.scheduled[0]?.fire();
    assert.equal((await pending as { status: string }).status, "gone");
    assert.equal(aliveChecks, 1, "the liveness check runs exactly once");
  });

  it("a pre-aborted signal returns released and schedules no timer", async () => {
    const host = new FakeDshHost();
    const seams = manualAwaitSeams();
    const multitask = createMultitask(host, { awaits: { now: seams.now, schedule: seams.schedule } });
    const workerId = await spawnWorker(multitask);
    const controller = new AbortController();
    controller.abort();
    const outcome = await multitask.settleRecords.wait(
      "session-1",
      workerId,
      30_000,
      controller.signal,
    );
    assert.deepEqual(outcome, { ok: true, status: "released", reason: "stopped", waitedMs: 0 });
    assert.equal(seams.scheduled.length, 0);
    assert.equal(multitask.settleRecords.waiterCount("session-1"), 0);
  });

  it("an abort during the wait returns released and leaves no timer", async () => {
    const host = new FakeDshHost();
    const seams = manualAwaitSeams();
    const multitask = createMultitask(host, { awaits: { now: seams.now, schedule: seams.schedule } });
    const workerId = await spawnWorker(multitask);
    const controller = new AbortController();
    const pending = multitask.settleRecords.wait(
      "session-1",
      workerId,
      30_000,
      controller.signal,
    );
    assert.equal(seams.scheduled.length, 1);
    seams.advance(5);
    controller.abort();
    const outcome = await pending;
    assert.deepEqual(outcome, { ok: true, status: "released", reason: "stopped", waitedMs: 5 });
    assert.equal(seams.scheduled[0]?.cancelled, true);
    assert.equal(multitask.settleRecords.waiterCount("session-1"), 0);
  });

  it("the fifth concurrent waiter is refused too-many-waits", async () => {
    const host = new FakeDshHost();
    const seams = manualAwaitSeams();
    const multitask = createMultitask(host, { awaits: { now: seams.now, schedule: seams.schedule } });
    const workerIds: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_WAITS; i++) {
      workerIds.push(await spawnWorker(multitask, "session-1", `stream-${i}`));
    }
    for (const workerId of workerIds) {
      void multitask.settleRecords.wait("session-1", workerId, 30_000);
    }
    assert.equal(multitask.settleRecords.waiterCount("session-1"), MAX_CONCURRENT_WAITS);
    const fifthWorker = await spawnWorker(multitask, "session-1", "stream-fifth");
    const fifth = await multitask.settleRecords.wait("session-1", fifthWorker, 30_000);
    assert.equal(fifth.ok, false);
    assert.ok(!fifth.ok);
    assert.equal(fifth.reason, "too-many-waits");
    assert.equal(typeof fifth.detail, "string");
    assert.equal(multitask.settleRecords.waiterCount("session-1"), MAX_CONCURRENT_WAITS);
    // A sibling session is not blocked by this session's cap.
    const otherWorker = await spawnWorker(multitask, "session-2", "stream-other");
    void multitask.settleRecords.wait("session-2", otherWorker, 30_000);
    assert.equal(multitask.settleRecords.waiterCount("session-2"), 1);
  });

  it("cancelWaits releases the session's waiters and cancels their timers; siblings keep theirs", async () => {
    const host = new FakeDshHost();
    const seams = manualAwaitSeams();
    const multitask = createMultitask(host, { awaits: { now: seams.now, schedule: seams.schedule } });
    const workerA = await spawnWorker(multitask, "session-1", "stream-a");
    const workerB = await spawnWorker(multitask, "session-1", "stream-b");
    const otherWorker = await spawnWorker(multitask, "session-2", "stream-other");
    const pendingA = multitask.settleRecords.wait("session-1", workerA, 30_000);
    const pendingB = multitask.settleRecords.wait("session-1", workerB, 30_000);
    const pendingOther = multitask.settleRecords.wait("session-2", otherWorker, 30_000);
    seams.advance(7);
    multitask.cancelWaits("session-1");
    assert.deepEqual(await pendingA, { ok: true, status: "released", reason: "stopped", waitedMs: 7 });
    assert.deepEqual(await pendingB, { ok: true, status: "released", reason: "stopped", waitedMs: 7 });
    assert.equal(multitask.settleRecords.waiterCount("session-1"), 0);
    // Session-2's waiter and its timer survive; it still settles normally.
    assert.equal(multitask.settleRecords.waiterCount("session-2"), 1);
    host.fireSettled({ workerId: otherWorker, status: "completed", report: "sibling fine" });
    const other = await pendingOther;
    assert.equal(other.ok, true);
    assert.ok(other.ok);
    assert.equal(other.status, "settled");
    // Cap bookkeeping freed: a new waiter can register for the cancelled session.
    void multitask.settleRecords.wait("session-1", workerA, 30_000);
    assert.equal(multitask.settleRecords.waiterCount("session-1"), 1);
    multitask.cancelWaits("session-1");
  });

});

describe("timeout and target validation (awaitWorker building blocks, ticket 115)", () => {
  it("validateAwaitTimeout applies the bounds table", () => {
    assert.deepEqual(validateAwaitTimeout(undefined), {
      ok: true,
      timeoutMs: AWAIT_DEFAULT_TIMEOUT_MS,
    });
    assert.deepEqual(validateAwaitTimeout(0), { ok: true, timeoutMs: 0 });
    assert.deepEqual(validateAwaitTimeout(30_000), { ok: true, timeoutMs: 30_000 });
    assert.deepEqual(validateAwaitTimeout(AWAIT_MAX_TIMEOUT_MS), {
      ok: true,
      timeoutMs: AWAIT_MAX_TIMEOUT_MS,
    });
    const over = validateAwaitTimeout(AWAIT_MAX_TIMEOUT_MS + 1);
    assert.ok(!over.ok);
    assert.equal(over.reason, "invalid-timeout");
    const negative = validateAwaitTimeout(-1);
    assert.ok(!negative.ok);
    assert.equal(negative.reason, "invalid-timeout");
    const nan = validateAwaitTimeout(Number.NaN);
    assert.ok(!nan.ok);
    assert.equal(nan.reason, "invalid-timeout");
    const infinite = validateAwaitTimeout(Number.POSITIVE_INFINITY);
    assert.ok(!infinite.ok);
    assert.equal(infinite.reason, "invalid-timeout");
  });

  it("resolveAwaitTarget refuses self before any lookup", () => {
    const resolution = resolveAwaitTarget({
      callerSessionId: "session-1",
      targetId: "session-1",
      getWorker: () => fakeWorker("session-1"),
    });
    assert.ok(resolution.kind === "refused");
    assert.equal(resolution.outcome.reason, "self-target");
  });
  it("resolveAwaitTarget accepts the caller's own worker", () => {
    const resolution = resolveAwaitTarget({
      callerSessionId: "session-1",
      targetId: "w-1",
      getWorker: (id) => (id === "w-1" ? fakeWorker("session-1") : undefined),
    });
    assert.deepEqual(resolution, { kind: "worker" });
  });

  it("resolveAwaitTarget refuses another session's worker as unknown-target", () => {
    const resolution = resolveAwaitTarget({
      callerSessionId: "session-1",
      targetId: "w-other",
      getWorker: () => fakeWorker("session-2"),
    });
    assert.ok(resolution.kind === "refused");
    assert.equal(resolution.outcome.reason, "unknown-target");
  });

  it("resolveAwaitTarget refuses a live dispatcher as not-awaitable", () => {
    const resolution = resolveAwaitTarget({
      callerSessionId: "session-1",
      targetId: "session-2",
      getWorker: () => undefined,
      isLiveDispatcherSession: (id) => id === "session-2",
    });
    assert.ok(resolution.kind === "refused");
    assert.equal(resolution.outcome.reason, "not-awaitable");
  });

  it("resolveAwaitTarget refuses an unknown id as unknown-target, with or without the port", () => {
    for (const isLiveDispatcherSession of [undefined, () => false]) {
      const resolution = resolveAwaitTarget({
        callerSessionId: "session-1",
        targetId: "nobody",
        getWorker: () => undefined,
        ...(isLiveDispatcherSession !== undefined ? { isLiveDispatcherSession } : {}),
      });
      assert.ok(resolution.kind === "refused");
      assert.equal(resolution.outcome.reason, "unknown-target");
    }
  });
});

function assertRefused(
  outcome: AwaitWorkerOutcome,
  reason: "unknown-target" | "self-target" | "not-awaitable" | "too-many-waits" | "invalid-timeout",
): void {
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, reason);
  assert.equal(typeof outcome.detail, "string");
}

describe("Multitask.awaitWorker (ticket 115, second half)", () => {
  it("an omitted timeout takes the 30,000 ms default", async () => {
    const host = new FakeDshHost();
    const seams = manualAwaitSeams();
    const multitask = createMultitask(host, { awaits: { now: seams.now, schedule: seams.schedule } });
    const workerId = await spawnWorker(multitask);
    void multitask.awaitWorker("session-1", workerId, undefined);
    assert.equal(seams.scheduled.length, 1);
    assert.equal(seams.scheduled[0]?.ms, AWAIT_DEFAULT_TIMEOUT_MS);
    multitask.cancelWaits("session-1");
  });

  it("refuses an unknown id, and another session's worker, as unknown-target", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    assertRefused(await multitask.awaitWorker("session-1", "nobody", 0), "unknown-target");
    const foreignWorker = await spawnWorker(multitask, "session-2", "stream-foreign");
    assertRefused(
      await multitask.awaitWorker("session-1", foreignWorker, 0),
      "unknown-target",
    );
  });

  it("refuses a live dispatcher session as not-awaitable", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host, {
      isLiveDispatcherSession: (id) => id === "session-2",
    });
    assertRefused(await multitask.awaitWorker("session-1", "session-2", 0), "not-awaitable");
  });

  it("refuses the fifth concurrent waiter with too-many-waits", async () => {
    const host = new FakeDshHost();
    const seams = manualAwaitSeams();
    const multitask = createMultitask(host, { awaits: { now: seams.now, schedule: seams.schedule } });
    const workerIds: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_WAITS; i++) {
      workerIds.push(await spawnWorker(multitask, "session-1", `stream-${i}`));
    }
    for (const workerId of workerIds) {
      void multitask.awaitWorker("session-1", workerId, 30_000);
    }
    assert.equal(multitask.settleRecords.waiterCount("session-1"), MAX_CONCURRENT_WAITS);
    const fifthWorker = await spawnWorker(multitask, "session-1", "stream-fifth");
    assertRefused(
      await multitask.awaitWorker("session-1", fifthWorker, 30_000),
      "too-many-waits",
    );
    assert.equal(multitask.settleRecords.waiterCount("session-1"), MAX_CONCURRENT_WAITS);
    multitask.cancelWaits("session-1");
  });

});
