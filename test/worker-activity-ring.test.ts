import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCordisDshHost,
  WORKER_ACTIVITY_RING_CAPACITY,
  WorkerActivityRing,
  type AdapterContext,
  type AgentLike,
  type ContinuableStartSpecLike,
} from "../src/adapter/cordis-dsh-host.js";

/** Deterministic ring unit tests: controlled atMs, no clock dependence. */
function entry(phrase: string, atMs: number): [string, number] {
  return [phrase, atMs];
}

describe("WorkerActivityRing helper (ticket 110)", () => {
  it("keeps the last 5 entries per worker, evicting the oldest", () => {
    const ring = new WorkerActivityRing();
    ring.record("w", "p1", 1);
    ring.record("w", "p2", 2);
    ring.record("w", "p3", 3);
    assert.deepEqual(ring.recent("w", 5).map((e) => e.phrase), ["p3", "p2", "p1"]);

    ring.record("w", "p4", 4);
    ring.record("w", "p5", 5);
    ring.record("w", "p6", 6);
    ring.record("w", "p7", 7);

    const phrases = ring.recent("w", 5).map((e) => e.phrase);
    assert.equal(phrases.length, WORKER_ACTIVITY_RING_CAPACITY);
    // p1 and p2 were evicted; the rest survive in insertion order reversed.
    assert.deepEqual(phrases, ["p7", "p6", "p5", "p4", "p3"]);
    assert.equal(ring.latest("w")?.phrase, "p7");
    assert.equal(ring.latest("w")?.atMs, 7);
  });

  it("keeps per-worker rings independent", () => {
    const ring = new WorkerActivityRing();
    ring.record("w1", "a1", 1);
    ring.record("w2", "b1", 2);
    ring.record("w2", "b2", 3);

    assert.deepEqual(ring.recent("w1", 5).map((e) => e.phrase), ["a1"]);
    assert.deepEqual(ring.recent("w2", 5).map((e) => e.phrase), ["b2", "b1"]);

    ring.clear("w1");
    assert.equal(ring.recent("w1", 5).length, 0);
    assert.equal(ring.latest("w2")?.phrase, "b2", "clear(w1) leaves w2 alone");
  });

  it("latest is the newest entry, undefined before anything is recorded", () => {
    const ring = new WorkerActivityRing();
    assert.equal(ring.latest("w"), undefined);
    ring.record("w", ...entry("first", 10));
    ring.record("w", ...entry("second", 20));
    assert.equal(ring.latest("w")?.phrase, "second");
    assert.equal(ring.latest("w")?.atMs, 20);
  });

  it("recent slices newest-first for n below the ring size", () => {
    const ring = new WorkerActivityRing();
    ring.record("w", "p1", 1);
    ring.record("w", "p2", 2);
    ring.record("w", "p3", 3);

    assert.deepEqual(ring.recent("w", 2).map((e) => e.phrase), ["p3", "p2"]);
    assert.deepEqual(ring.recent("w", 1).map((e) => e.phrase), ["p3"]);
    // n larger than the ring yields the whole ring, newest-first.
    assert.deepEqual(ring.recent("w", 99).map((e) => e.phrase), ["p3", "p2", "p1"]);
  });

  it("recent is empty for n <= 0, non-finite n, and unknown workers", () => {
    const ring = new WorkerActivityRing();
    ring.record("w", "p1", 1);

    assert.equal(ring.recent("w", 0).length, 0);
    assert.equal(ring.recent("w", -1).length, 0);
    assert.equal(ring.recent("w", Number.NaN).length, 0);
    assert.equal(ring.recent("w", Number.POSITIVE_INFINITY).length, 0);
    assert.equal(ring.recent("unknown", 5).length, 0);
  });

  it("clear drops one worker; clearAll drops everything", () => {
    const ring = new WorkerActivityRing();
    ring.record("w1", "a", 1);
    ring.record("w2", "b", 2);

    ring.clear("w1");
    assert.equal(ring.latest("w1"), undefined);
    assert.equal(ring.latest("w2")?.phrase, "b");

    ring.clearAll();
    assert.equal(ring.latest("w2"), undefined);
    assert.equal(ring.recent("w2", 5).length, 0);
  });
});

interface RecordedCall {
  [key: string]: unknown;
}

function createAgent(id: string): AgentLike {
  return {
    session: {
      id,
      header: { parentSession: undefined, delegationDepth: 0 },
    },
    followup() {},
  };
}

/** Minimal stub ctx — the same firehose-driving shape adapter-cordis tests use. */
function createStubCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  let nextChild = 1;

  const ctx: AdapterContext & {
    fire(name: string, ...payloads: unknown[]): void;
  } = {
    fire(name: string, ...payloads: unknown[]) {
      for (const cb of listeners.get(name) ?? []) {
        (cb as (...args: unknown[]) => void)(...payloads);
      }
    },
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((c) => c !== cb),
        );
      };
    },
    subagents: {
      async startContinuable(spec: ContinuableStartSpecLike) {
        void spec;
        const childId = `child-${nextChild++}`;
        return { childId, messageId: `msg-${childId}` };
      },
      interrupt() {},
      async sendMessage() {
        return "mid";
      },
    },
    agents: {
      get() {
        return undefined;
      },
    },
    jobs: {
      list() {
        return [];
      },
    },
    storageDomain: {
      async open() {
        throw new Error("not used in these tests");
      },
    },
  };

  return ctx;
}

/** Fire a `session/event` the way the host bus does: (session, event). */
function fireSessionEvent(
  ctx: ReturnType<typeof createStubCtx>,
  sessionId: string,
  event: unknown,
): void {
  ctx.fire("session/event", { id: sessionId }, event);
}

function toolCallEvent(name: string, args: unknown): unknown {
  return {
    type: "tool/call",
    data: {
      turn: 1,
      step: 2,
      callId: "call-1",
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

/** Bind a parent and spawn one worker; returns the host and its worker id. */
async function spawnOneWorker(ctx: ReturnType<typeof createStubCtx>) {
  const host = createCordisDshHost(ctx);
  host.bindParent(createAgent("disp-1"), "disp-1");
  const workerId = await host.spawnWorker("Do the thing.", {
    parentSessionId: "disp-1",
    streamKey: "s1",
    title: "Thing",
  });
  return { host, workerId };
}

describe("CordisDshHost activity ring over the firehose (ticket 110)", () => {
  it("records successive tool/call phrases newest-first; recentActivities slices", async () => {
    const ctx = createStubCtx();
    const { host, workerId } = await spawnOneWorker(ctx);
    assert.equal(host.recentActivities(workerId, 5).length, 0);

    fireSessionEvent(ctx, workerId, toolCallEvent("bash", { command: "first" }));
    fireSessionEvent(ctx, workerId, toolCallEvent("sed", { script: "second" }));
    fireSessionEvent(ctx, workerId, toolCallEvent("grep", { pattern: "third" }));

    const all = host.recentActivities(workerId, 5);
    assert.deepEqual(
      all.map((e) => e.phrase),
      ["grep: third", "sed: second", "bash: first"],
      "newest-first, full breadcrumb retained",
    );
    for (const e of all) {
      assert.equal(typeof e.atMs, "number");
    }

    const two = host.recentActivities(workerId, 2);
    assert.deepEqual(two.map((e) => e.phrase), ["grep: third", "sed: second"]);

    assert.equal(host.recentActivities(workerId, 0).length, 0);
    assert.equal(host.recentActivities("not-ours", 5).length, 0);
  });

  it("recentActivity/lastActivityAtMs still read the newest entry (backward compat)", async () => {
    const ctx = createStubCtx();
    const { host, workerId } = await spawnOneWorker(ctx);

    fireSessionEvent(ctx, workerId, toolCallEvent("bash", { command: "first" }));
    fireSessionEvent(ctx, workerId, toolCallEvent("grep", { pattern: "second" }));

    assert.equal(host.recentActivity(workerId), "grep: second");
    const newest = host.recentActivities(workerId, 5)[0];
    assert.equal(host.lastActivityAtMs(workerId), newest?.atMs);
  });

  it("the firehose ring stays bounded at 5 with oldest-evicted order", async () => {
    const ctx = createStubCtx();
    const { host, workerId } = await spawnOneWorker(ctx);

    for (let i = 1; i <= 7; i += 1) {
      fireSessionEvent(ctx, workerId, toolCallEvent("bash", { command: `step-${i}` }));
    }

    const all = host.recentActivities(workerId, 10);
    assert.equal(all.length, WORKER_ACTIVITY_RING_CAPACITY);
    assert.deepEqual(
      all.map((e) => e.phrase),
      [
        "bash: step-7",
        "bash: step-6",
        "bash: step-5",
        "bash: step-4",
        "bash: step-3",
      ],
    );
  });

  it("settle retains the digest breadcrumb; single-entry accessors go null", async () => {
    const ctx = createStubCtx();
    const { host, workerId } = await spawnOneWorker(ctx);
    fireSessionEvent(ctx, workerId, toolCallEvent("bash", { command: "go" }));
    fireSessionEvent(ctx, workerId, toolCallEvent("grep", { pattern: "go" }));

    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "ok" }],
    });
    // Ticket 110 phase 2: the wake composes AFTER the settle, so the
    // breadcrumb survives it for the digest to read, newest-first.
    assert.deepEqual(
      host.recentActivities(workerId, 5).map((e) => e.phrase),
      ["grep: go", "bash: go"],
    );
    // Ticket 29 honesty is unchanged: a settled worker has no LIVE
    // activity — the check-row accessors read null, never stale phrases.
    assert.equal(host.recentActivity(workerId), null);
    assert.equal(host.lastActivityAtMs(workerId), null);

    // Aborted settles retain the breadcrumb the same way.
    const secondId = await host.spawnWorker("again", {
      parentSessionId: "disp-1",
      streamKey: "s2",
      title: "t2",
    });
    fireSessionEvent(ctx, secondId, toolCallEvent("bash", { command: "go" }));
    ctx.fire("subagent/end", { id: secondId, stopReason: "aborted" });
    assert.equal(host.recentActivities(secondId, 5).length, 1);
    assert.equal(host.recentActivity(secondId), null);
    assert.equal(host.lastActivityAtMs(secondId), null);
  });

  it("dispose clears every ring and stops recording", async () => {
    const ctx = createStubCtx();
    const { host, workerId } = await spawnOneWorker(ctx);
    fireSessionEvent(ctx, workerId, toolCallEvent("bash", { command: "go" }));
    assert.equal(host.recentActivities(workerId, 5).length, 1);

    host.dispose();
    assert.equal(host.recentActivities(workerId, 5).length, 0);
    fireSessionEvent(ctx, workerId, toolCallEvent("bash", { command: "after dispose" }));
    assert.equal(host.recentActivities(workerId, 5).length, 0);
  });
});
