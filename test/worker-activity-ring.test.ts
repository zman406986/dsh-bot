import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCordisDshHost,
  WORKER_ACTIVITY_RING_CAPACITY,
  WorkerActivityRing,
  type AdapterContext,
  type AgentLike,
  type ActivationSpecLike,
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

  it("keeps workers independent and empties out on clear", () => {
    // Memory bounds: the ring is the only thing holding activity text, so a
    // clear that misses a worker would leak it for the process lifetime.
    const ring = new WorkerActivityRing();
    ring.record("w1", "a", 1);
    ring.record("w2", "b", 2);
    assert.deepEqual(ring.recent("w1", 5).map((e) => e.phrase), ["a"]);
    assert.deepEqual(ring.recent("w2", 5).map((e) => e.phrase), ["b"]);
    assert.equal(ring.latest("never-recorded"), undefined);

    // Non-positive and non-finite limits answer empty, never the whole ring.
    for (const n of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(ring.recent("w1", n), [], `n=${String(n)}`);
    }

    ring.clear("w1");
    assert.deepEqual(ring.recent("w1", 5), []);
    assert.deepEqual(ring.recent("w2", 5).map((e) => e.phrase), ["b"], "clear hit a sibling");
    ring.clearAll();
    assert.deepEqual(ring.recent("w2", 5), []);
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
      async startActivation(spec: ActivationSpecLike) {
        void spec;
        const childId = `child-${nextChild++}`;
        return {
          childId,
          messageId: `msg-${childId}`,
          dispose: async () => {},
        };
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

});
