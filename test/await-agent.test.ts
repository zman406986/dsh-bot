/**
 * Ticket 117 / ADR-0025 — `await_agent`, the ONE bounded wait.
 *
 * What these pins hold:
 * 1. The tool routes into ticket 115's existing core (`Multitask.awaitWorker`
 *    → `settleRecords.wait`). No second wait mechanism, no host poll.
 * 2. Wire shape is SNAKE_CASE, mapped once from the core's camelCase:
 *    `worker_status`, `settled_at_ms`, `waited_ms`. A timeout is a normal
 *    outcome (`ok: true`, `status: "still-running"`), never an error.
 * 3. Bounds: default 30,000 ms; 0–120,000 accepted; `timeout_ms: 0` is a
 *    non-blocking status read that arms no timer and registers no waiter.
 * 4. Worker targets only. A dispatcher session refuses `not-awaitable` and
 *    the copy says to message it and end the turn. This is the cycle rule: a
 *    refusal, not a timeout.
 * 5. Refusals are the closed vocabulary: `unknown-target`, `self-target`,
 *    `not-awaitable`, `too-many-waits`, `invalid-timeout` — each surfaced
 *    with `{ok:false, reason, detail}` and nothing else.
 * 6. `exec.signal` reaches the wait: an abort resolves `released` /
 *    `stopped` and leaves no timer. Session deactivation uses the same
 *    `cancelWaits` path (no duplicate mechanism here).
 * 7. Registration: the tool is on the dispatcher surface and DENIED for
 *    workers.
 *
 * Manual clock + scheduler only (S8 offline lane): no real timers, no host.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  createDispatcherTools,
  readExecSignal,
  type DispatcherToolDef,
} from "../src/core/tools.js";
import {
  AWAIT_AGENT_TOOL,
  DISPATCHER_TOOL_NAMES,
} from "../src/core/policy/prompts.js";
import {
  AWAIT_DEFAULT_TIMEOUT_MS,
  AWAIT_INVALID_TIMEOUT_DETAIL,
  AWAIT_MAX_TIMEOUT_MS,
  MAX_CONCURRENT_WAITS,
  SETTLE_RING_SIZE,
} from "../src/core/settle-records.js";
import type { AwaitAgentToolResult } from "../src/core/tool-results.js";
import { REPORT_CLAMP_CHARS } from "../src/core/report-clamp.js";
import {
  buildWorkerToolFilter,
  WORKER_DENIED_TOOL_CANDIDATES,
} from "../src/worker/tool-barrier.js";

const SESSION = "session-1";
const PEER_SESSION = "session-2";

interface FakeTimerEntry {
  readonly ms: number;
  fired: boolean;
  cancelled: boolean;
  fire(): void;
}

/** Manual clock + scheduler seams so no test waits on a real timer. */
function manualSeams(startMs = 1_000_000): {
  now: () => number;
  schedule: (fn: () => void, ms: number) => () => void;
  readonly scheduled: FakeTimerEntry[];
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

type Seams = ReturnType<typeof manualSeams>;

interface Rig {
  readonly host: FakeDshHost;
  readonly multitask: Multitask;
  readonly seams: Seams;
  readonly tools: DispatcherToolDef[];
  readonly awaitAgent: DispatcherToolDef;
  readonly exec: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<AwaitAgentToolResult>;
}

function rig(options?: {
  isLive?: (sessionId: string) => boolean;
  isAgentAlive?: (workerId: string) => boolean;
}): Rig {
  const host = new FakeDshHost();
  const seams = manualSeams();
  const multitask = createMultitask(host, {
    ...(options?.isLive !== undefined
      ? { isLiveDispatcherSession: options.isLive }
      : {}),
    ...(options?.isAgentAlive !== undefined
      ? { isAgentAlive: options.isAgentAlive }
      : {}),
    // Ticket 115 seams: the ONLY timers in play, both manual.
    awaits: { now: seams.now, schedule: seams.schedule },
  });
  const tools = createDispatcherTools({
    multitask,
    getSessionId: () => SESSION,
  });
  const awaitAgent = tools.find((tool) => tool.name === AWAIT_AGENT_TOOL);
  assert.ok(awaitAgent, "await_agent is registered on the dispatcher surface");
  return {
    host,
    multitask,
    seams,
    tools,
    awaitAgent,
    exec: (args, exec) =>
      awaitAgent.execute(args, exec) as Promise<AwaitAgentToolResult>,
  };
}

async function spawnWorker(
  multitask: Multitask,
  parentSessionId: string = SESSION,
  streamKey: string = "stream-1",
): Promise<string> {
  const spawned = await multitask.spawnWorker({
    parentSessionId,
    streamKey,
    title: "Await subject",
    prompt: "Do the work.",
  });
  assert.ok(spawned.ok, spawned.ok ? "" : spawned.detail);
  if (!spawned.ok) throw new Error("unreachable");
  return spawned.workerId;
}

function refused(
  result: AwaitAgentToolResult,
  reason:
    | "unknown-target"
    | "self-target"
    | "not-awaitable"
    | "too-many-waits"
    | "invalid-timeout",
): Extract<AwaitAgentToolResult, { ok: false }> {
  assert.equal(result.ok, false, `expected refusal ${reason}, got ok`);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, reason);
  assert.equal(typeof result.detail, "string");
  assert.ok(result.detail.length > 0);
  // The refusal carries no success fields at all.
  assert.deepEqual(Object.keys(result).sort(), ["detail", "ok", "reason"]);
  return result;
}

describe("ticket 117 — settled outcomes (record reads, no polling)", () => {
  it("timeout_ms 0 on a settled record returns settled with the clamped result", async () => {
    const r = rig();
    const workerId = await spawnWorker(r.multitask);
    r.host.fireSettled({
      workerId,
      status: "completed",
      report: "r".repeat(10_000),
      transcriptRef: "child-1",
    });

    const result = await r.exec({ target: workerId, timeout_ms: 0 });
    assert.ok(result.ok);
    if (!result.ok || result.status !== "settled") {
      throw new Error("unreachable");
    }
    assert.equal(result.target, workerId);
    assert.equal(result.worker_status, "completed");
    assert.equal(result.waited_ms, 0);
    assert.equal(typeof result.settled_at_ms, "number");
    assert.equal(
      result.settled_at_ms,
      r.multitask.settleRecords.lookup(SESSION, workerId)?.settledAtMs,
    );
    // Clamped by the settle path, exactly as the wake path clamps it.
    assert.ok(result.result.startsWith("r".repeat(REPORT_CLAMP_CHARS)));
    assert.ok(
      result.result.includes("[report truncated: 4000 of 10000 characters."),
    );
    // A non-blocking read arms no timer and registers no waiter.
    assert.equal(r.seams.scheduled.length, 0);
    assert.equal(r.multitask.settleRecords.waiterCount(SESSION), 0);
    // The model-facing summary carries the result itself: the host renders
    // only this text, so "its result is above" would be a lie.
    assert.ok(result.summary.includes("[report truncated: 4000 of 10000 characters."));
  });

  it("a settle landing during the wait resolves it and cancels the timer", async () => {
    const r = rig();
    const workerId = await spawnWorker(r.multitask);

    const pending = r.exec({ target: workerId, timeout_ms: 30_000 });
    assert.equal(r.seams.scheduled.length, 1);
    assert.equal(r.multitask.settleRecords.waiterCount(SESSION), 1);
    r.seams.advance(40);
    r.host.fireSettled({ workerId, status: "completed", report: "finished" });

    const result = await pending;
    assert.ok(result.ok);
    if (!result.ok || result.status !== "settled") {
      throw new Error("unreachable");
    }
    assert.equal(result.worker_status, "completed");
    assert.equal(result.result, "finished");
    assert.equal(result.waited_ms, 40);
    // The losing racer is cleaned up: no live timer, no waiter.
    assert.equal(r.seams.scheduled[0]?.cancelled, true);
    assert.equal(r.multitask.settleRecords.waiterCount(SESSION), 0);
    // The settle wake still arrives — the wait never consumed it.
    assert.ok(r.multitask.drainWake(SESSION) !== undefined);
  });

  it("error and aborted settles surface their own worker_status", async () => {
    const r = rig();
    const errorWorker = await spawnWorker(r.multitask, SESSION, "stream-e");
    r.host.fireSettled({ workerId: errorWorker, status: "error", report: "boom" });
    const errorResult = await r.exec({ target: errorWorker, timeout_ms: 0 });
    assert.ok(errorResult.ok);
    if (!errorResult.ok || errorResult.status !== "settled") {
      throw new Error("unreachable");
    }
    assert.equal(errorResult.worker_status, "error");
    assert.equal(errorResult.result, "boom");
    assert.ok(errorResult.summary.includes("not a successful finish"));

    const abortedWorker = await spawnWorker(r.multitask, SESSION, "stream-a");
    r.host.fireSettled({
      workerId: abortedWorker,
      status: "aborted",
      report: "stopped mid-way",
    });
    const abortedResult = await r.exec({ target: abortedWorker, timeout_ms: 0 });
    assert.ok(abortedResult.ok);
    if (!abortedResult.ok || abortedResult.status !== "settled") {
      throw new Error("unreachable");
    }
    assert.equal(abortedResult.worker_status, "aborted");
  });

  it("the ring still bounds memory: a 65th settle evicts the oldest record", async () => {
    const r = rig();
    const workers: string[] = [];
    for (let i = 0; i < SETTLE_RING_SIZE + 1; i++) {
      workers.push(await spawnWorker(r.multitask, SESSION, `stream-${i}`));
    }
    for (const workerId of workers) {
      r.host.fireSettled({ workerId, status: "completed", report: workerId });
    }
    // The tool reads the record, so an evicted one reads as still-running
    // (worker alive) rather than inventing a result.
    const oldest = await r.exec({ target: workers[0] as string, timeout_ms: 0 });
    assert.ok(oldest.ok);
    if (!oldest.ok) throw new Error("unreachable");
    assert.equal(oldest.status, "still-running");
    const newest = await r.exec({
      target: workers[workers.length - 1] as string,
      timeout_ms: 0,
    });
    assert.ok(newest.ok);
    if (!newest.ok || newest.status !== "settled") {
      throw new Error("unreachable");
    }
    assert.equal(newest.result, workers[workers.length - 1]);
  });
});

describe("ticket 117 — timeout outcomes (a timeout is not an error)", () => {
  it("times out as still-running and the record survives for a later read", async () => {
    const r = rig();
    const workerId = await spawnWorker(r.multitask);

    const pending = r.exec({ target: workerId, timeout_ms: 30_000 });
    r.seams.advance(30_000);
    r.seams.scheduled[0]?.fire();

    const result = await pending;
    assert.ok(result.ok);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.status, "still-running");
    assert.equal(result.waited_ms, 30_000);
    assert.equal(result.target, workerId);
    assert.equal(r.multitask.settleRecords.waiterCount(SESSION), 0);
    // Nothing invented: a timeout does not write a record.
    assert.equal(r.multitask.settleRecords.lookup(SESSION, workerId), undefined);

    // A late settle is not lost: the record is written and readable.
    r.host.fireSettled({ workerId, status: "completed", report: "late but kept" });
    assert.ok(r.multitask.settleRecords.lookup(SESSION, workerId) !== undefined);
    const after = await r.exec({ target: workerId, timeout_ms: 0 });
    assert.ok(after.ok);
    if (!after.ok || after.status !== "settled") {
      throw new Error("unreachable");
    }
    assert.equal(after.result, "late but kept");
  });

  it("reports gone when the agent is dead and no settle was recorded", async () => {
    const r = rig({
      // The fake host names workers fake-worker-N; treat that as dead.
      isAgentAlive: (workerId) => !workerId.startsWith("fake-worker"),
    });
    const workerId = await spawnWorker(r.multitask);

    const pending = r.exec({ target: workerId, timeout_ms: 30_000 });
    r.seams.advance(30_000);
    r.seams.scheduled[0]?.fire();

    const result = await pending;
    assert.ok(result.ok);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.status, "gone");
    assert.equal(result.waited_ms, 30_000);
    assert.deepEqual(Object.keys(result).sort(), [
      "ok",
      "status",
      "summary",
      "target",
      "waited_ms",
    ]);
    assert.ok(result.summary.includes("outcome is unknown"));
  });

  it("an omitted timeout takes the 30,000 ms default", async () => {
    const r = rig();
    const workerId = await spawnWorker(r.multitask);
    void r.exec({ target: workerId });
    assert.equal(r.seams.scheduled.length, 1);
    assert.equal(r.seams.scheduled[0]?.ms, AWAIT_DEFAULT_TIMEOUT_MS);
    r.multitask.cancelWaits(SESSION);
  });

  it("accepts the boundary timeouts (0 and 120,000) and refuses past the max", async () => {
    const r = rig();
    const workerId = await spawnWorker(r.multitask);

    const zero = await r.exec({ target: workerId, timeout_ms: 0 });
    assert.equal(zero.ok, true);

    const atMax = r.exec({ target: workerId, timeout_ms: AWAIT_MAX_TIMEOUT_MS });
    assert.equal(r.seams.scheduled.length, 1);
    assert.equal(r.seams.scheduled[0]?.ms, AWAIT_MAX_TIMEOUT_MS);
    r.multitask.cancelWaits(SESSION);
    assert.equal((await atMax).ok, true);

    const over = await r.exec({
      target: workerId,
      timeout_ms: AWAIT_MAX_TIMEOUT_MS + 1,
    });
    const refusal = refused(over, "invalid-timeout");
    assert.ok(refusal.detail.includes("120000"));
    // Nothing was armed for the refused call.
    assert.equal(r.multitask.settleRecords.waiterCount(SESSION), 0);
  });

  it("refuses a non-number timeout_ms and a negative one as invalid-timeout", async () => {
    const r = rig();
    const workerId = await spawnWorker(r.multitask);

    for (const timeout_ms of ["5000", -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await r.exec({ target: workerId, timeout_ms });
      refused(result, "invalid-timeout");
    }
    // A non-number never reaches the core, so it arms nothing.
    assert.equal(r.seams.scheduled.length, 0);
    // The wrong-typed refusal uses the one shared bound copy.
    const typed = await r.exec({ target: workerId, timeout_ms: "5000" });
    assert.ok(!typed.ok);
    if (typed.ok) throw new Error("unreachable");
    assert.equal(typed.detail, AWAIT_INVALID_TIMEOUT_DETAIL);
  });
});

describe("ticket 117 — released outcomes (abort and deactivation)", () => {
  it("an abort during the wait resolves released/stopped and leaves no timer", async () => {
    const r = rig();
    const workerId = await spawnWorker(r.multitask);
    const controller = new AbortController();

    const pending = r.exec(
      { target: workerId, timeout_ms: 30_000 },
      { signal: controller.signal },
    );
    assert.equal(r.seams.scheduled.length, 1);
    r.seams.advance(5);
    controller.abort();

    const result = await pending;
    assert.ok(result.ok);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.status, "released");
    if (result.status !== "released") throw new Error("unreachable");
    assert.equal(result.reason, "stopped");
    assert.equal(result.waited_ms, 5);
    assert.equal(r.seams.scheduled[0]?.cancelled, true);
    assert.equal(r.multitask.settleRecords.waiterCount(SESSION), 0);
    // The worker was NOT stopped — only the wait was (status is still
    // non-terminal and no interrupt was issued).
    assert.ok(!["completed", "error", "aborted"].includes(
      r.multitask.getWorker(workerId)?.status ?? "",
    ));
    assert.equal(r.host.interruptCalls.length, 0);
  });

  it("a pre-aborted signal resolves released at once and arms no timer", async () => {
    const r = rig();
    const workerId = await spawnWorker(r.multitask);
    const controller = new AbortController();
    controller.abort();

    const result = await r.exec(
      { target: workerId, timeout_ms: 30_000 },
      { signal: controller.signal },
    );
    assert.ok(result.ok);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.status, "released");
    assert.equal(r.seams.scheduled.length, 0);
  });

  it("session deactivation releases the wait through the shared cancelWaits path", async () => {
    const r = rig();
    const workerId = await spawnWorker(r.multitask);

    const pending = r.exec({ target: workerId, timeout_ms: 30_000 });
    r.seams.advance(9);
    // The plugin calls exactly this on deactivation (ticket 115 wiring).
    r.multitask.cancelWaits(SESSION);

    const result = await pending;
    assert.ok(result.ok);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.status, "released");
    if (result.status !== "released") throw new Error("unreachable");
    assert.equal(result.reason, "stopped");
    assert.equal(result.waited_ms, 9);
    assert.equal(r.seams.scheduled[0]?.cancelled, true);
    assert.equal(r.multitask.settleRecords.waiterCount(SESSION), 0);
  });

  it("the snake_case released shape is exactly the ticket's", async () => {
    const r = rig();
    const workerId = await spawnWorker(r.multitask);
    const controller = new AbortController();
    const pending = r.exec(
      { target: workerId, timeout_ms: 30_000 },
      { signal: controller.signal },
    );
    controller.abort();
    const result = await pending;
    assert.ok(result.ok);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(Object.keys(result).sort(), [
      "ok",
      "reason",
      "status",
      "summary",
      "target",
      "waited_ms",
    ]);
  });
});

describe("ticket 117 — refusals (closed vocabulary, refusal not timeout)", () => {
  it("refuses a live dispatcher session as not-awaitable and says message it", async () => {
    const r = rig({ isLive: (sessionId) => sessionId === PEER_SESSION });
    const result = await r.exec({ target: PEER_SESSION, timeout_ms: 30_000 });
    const refusal = refused(result, "not-awaitable");
    // The ticket's copy requirement: message it and END THE TURN.
    assert.ok(refusal.detail.includes("message_agent"));
    assert.ok(refusal.detail.includes("end the turn"));
    // A refusal arms nothing — this is not a wait that gave up.
    assert.equal(r.seams.scheduled.length, 0);
    assert.equal(r.multitask.settleRecords.waiterCount(SESSION), 0);
  });

  it("refuses the caller's own session as self-target", async () => {
    const r = rig();
    refused(await r.exec({ target: SESSION, timeout_ms: 0 }), "self-target");
  });

  it("refuses an unknown id and another session's worker as unknown-target", async () => {
    const r = rig();
    refused(await r.exec({ target: "nobody", timeout_ms: 0 }), "unknown-target");
    const foreign = await spawnWorker(r.multitask, PEER_SESSION, "stream-foreign");
    refused(await r.exec({ target: foreign, timeout_ms: 0 }), "unknown-target");
  });

  it("refuses the fifth concurrent waiter as too-many-waits", async () => {
    const r = rig();
    const workers: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_WAITS; i++) {
      workers.push(await spawnWorker(r.multitask, SESSION, `stream-${i}`));
    }
    const pendings = workers.map((workerId) =>
      r.exec({ target: workerId, timeout_ms: 30_000 }),
    );
    assert.equal(r.multitask.settleRecords.waiterCount(SESSION), MAX_CONCURRENT_WAITS);

    const fifthWorker = await spawnWorker(r.multitask, SESSION, "stream-fifth");
    const refusal = refused(
      await r.exec({ target: fifthWorker, timeout_ms: 30_000 }),
      "too-many-waits",
    );
    assert.ok(refusal.detail.includes("already being awaited"));
    assert.equal(r.multitask.settleRecords.waiterCount(SESSION), MAX_CONCURRENT_WAITS);

    // Once one wait ends, the slot is reusable through the same tool.
    r.host.fireSettled({
      workerId: workers[0] as string,
      status: "completed",
      report: "first done",
    });
    await pendings[0];
    assert.equal(r.multitask.settleRecords.waiterCount(SESSION), MAX_CONCURRENT_WAITS - 1);
    const nowOk = await r.exec({ target: fifthWorker, timeout_ms: 0 });
    assert.equal(nowOk.ok, true);
    r.multitask.cancelWaits(SESSION);
    await Promise.all(pendings);
  });
});

describe("ticket 117 — wire shape and exec seam", () => {
  it("pins the snake_case fields and the absence of camelCase ones", async () => {
    const r = rig();
    const workerId = await spawnWorker(r.multitask);
    r.host.fireSettled({ workerId, status: "completed", report: "done" });
    const result = await r.exec({ target: workerId, timeout_ms: 0 });
    assert.ok(result.ok);
    if (!result.ok || result.status !== "settled") {
      throw new Error("unreachable");
    }
    assert.deepEqual(Object.keys(result).sort(), [
      "ok",
      "result",
      "settled_at_ms",
      "status",
      "summary",
      "target",
      "waited_ms",
      "worker_status",
    ]);
    // The core's camelCase names must never leak onto the wire.
    const wire = result as unknown as Record<string, unknown>;
    for (const camel of ["workerStatus", "settledAtMs", "waitedMs", "worker_id"]) {
      assert.equal(camel in wire, false, `${camel} leaked onto the wire`);
    }
  });

  it("readExecSignal reads a structural signal and ignores anything else", () => {
    const controller = new AbortController();
    assert.equal(readExecSignal(undefined), undefined);
    assert.equal(readExecSignal(null), undefined);
    assert.equal(readExecSignal({}), undefined);
    assert.equal(readExecSignal({ signal: "nonsense" }), undefined);
    assert.equal(readExecSignal({ signal: { aborted: true } }), undefined);
    assert.equal(readExecSignal({ signal: controller.signal }), controller.signal);
  });
});

describe("ticket 117 — registration and the worker barrier", () => {
  it("is registered on the dispatcher surface, in DISPATCHER_TOOL_NAMES order", () => {
    const r = rig();
    assert.deepEqual(
      r.tools.map((tool) => tool.name),
      [...DISPATCHER_TOOL_NAMES],
    );
    assert.ok(DISPATCHER_TOOL_NAMES.includes(AWAIT_AGENT_TOOL));
    assert.equal(AWAIT_AGENT_TOOL, "await_agent");
  });

  it("declares target required and timeout_ms optional, both provider-valid", () => {
    const r = rig();
    const parameters = r.awaitAgent.parameters as {
      type: string;
      additionalProperties: boolean;
      properties: Record<string, { type: string; required?: boolean }>;
    };
    assert.equal(parameters.type, "object");
    assert.equal(parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(parameters.properties).sort(), [
      "target",
      "timeout_ms",
    ]);
    assert.equal(parameters.properties.target?.required, true);
    assert.equal(parameters.properties.timeout_ms?.required, false);
    assert.equal(parameters.properties.target?.type, "string");
    assert.equal(parameters.properties.timeout_ms?.type, "number");
    assert.ok(r.awaitAgent.description.length > 20);
  });

  it("is denied for workers — the cycle rule needs it never to reach a scope", () => {
    assert.ok(WORKER_DENIED_TOOL_CANDIDATES.includes(AWAIT_AGENT_TOOL));
    const known = new Set([...DISPATCHER_TOOL_NAMES, "bash"]);
    const filter = buildWorkerToolFilter(known);
    assert.ok(filter.deny.includes(AWAIT_AGENT_TOOL));
    assert.ok(!filter.deny.includes("bash"));
  });

  it("the summary text of every outcome is non-empty model-facing copy", async () => {
    const r = rig({ isLive: (sessionId) => sessionId === PEER_SESSION });
    const workerId = await spawnWorker(r.multitask);
    r.host.fireSettled({ workerId, status: "completed", report: "the result" });
    const settled = await r.exec({ target: workerId, timeout_ms: 0 });
    assert.ok(settled.ok);
    if (!settled.ok) throw new Error("unreachable");
    // The model gets the result text, not a pointer to it.
    assert.ok(settled.summary.includes("the result"));

    const running = await r.exec({
      target: await spawnWorker(r.multitask, SESSION, "stream-run"),
      timeout_ms: 0,
    });
    assert.ok(running.ok);
    if (running.ok) assert.ok(running.summary.length > 20);

    // A refusal surfaces as detail (renderStructured's `detail` branch).
    const refusal = await r.exec({ target: PEER_SESSION, timeout_ms: 0 });
    if (refusal.ok) throw new Error("unreachable");
    assert.ok(refusal.detail.length > 20);
  });
});
