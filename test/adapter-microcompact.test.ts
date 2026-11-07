/**
 * Ticket 124 — deterministic microcompact, adapter half (ADR-0029).
 *
 * Drives `runMicrocompactPass` against a fake session that mirrors the real
 * dsh surface contract: `surface.nodes` lists current nodes, `eventAt(seq)`
 * reads one event, `append(...)` assigns the next seq and applies the surface
 * op. That is enough to prove the wiring without a host:
 *
 * 1. Below the ratio: no append, no boundary row.
 * 2. Missing/implausible window: no append, no boundary, a stated reason.
 * 3. A due pass clears only old tool results, keeps the newest N, and writes a
 *    `compaction/prune` shadow price IMMEDIATELY before each replacement.
 * 4. The boundary row is written once, AFTER the replacements, and carries what
 *    resume needs.
 * 5. A repeat pass over the same session is a no-op (already-cleared nodes),
 *    and a second genuine pass bumps `passSeq` instead of duplicating a row.
 * 6. An open native `compaction/start` blocks the pass — ours never fights the
 *    host's own compaction.
 * 7. The listener never throws: a failing meter or a failing store leaves the
 *    step green and writes nothing.
 *
 * Offline only (S8).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLEARED_TOOL_RESULT_TEXT,
  MICROCOMPACT_KEEP_NEWEST,
  MICROCOMPACT_TRIGGER_RATIO,
} from "../src/core/microcompact.js";
import type { CompactionBoundary } from "../src/core/durability.js";
import {MICROCOMPACT_EVENT, registerMicrocompact, runMicrocompactPass, type BoundaryStoreLike, type MicrocompactContextLike, type MicrocompactPassOutcome, type MicrocompactSessionLike, type TokenMeterLike} from "../src/adapter/microcompact.js";

const WINDOW = 1_000_000;
const THRESHOLD = Math.floor(WINDOW * MICROCOMPACT_TRIGGER_RATIO);

/** A message shape the estimator sees. */
interface FakeMessage {
  readonly id: string;
  readonly role: string;
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly source?: { readonly kind: string; readonly callId?: string };
  readonly toolCallId?: string;
}

/** One log event in the fake session. */
interface FakeEvent {
  readonly seq: number;
  readonly type: string;
  readonly data?: unknown;
}

/**
/**
 * Fake session that applies single-node replacements the way dsh does
 * (`dsh-session/lib/index.js:463-468`): the replacement is SPLICED IN at the
 * shadowed node's surface position, so surface order survives even though the
 * replacement's log seq is higher.
 */
function createFakeSession(
  nodes: readonly {
    seq: number;
    type: string;
    message?: FakeMessage;
  }[],
): MicrocompactSessionLike & {
  readonly events: FakeEvent[];
  readonly surfaceNodes: number[];
  appendLog: Array<{ type: string; data: unknown; opts: unknown }>;
  setWindow(window: number | undefined): void;
} {
  const events: FakeEvent[] = [];
  const surfaceNodes: number[] = [];
  const appendLog: Array<{ type: string; data: unknown; opts: unknown }> = [];
  let window: number | undefined = WINDOW;

  for (const entry of nodes) {
    events.push({
      seq: entry.seq,
      type: entry.type,
      data: entry.message === undefined ? {} : { message: entry.message },
    });
    surfaceNodes.push(entry.seq);
  }
  // Pad the log so `seq` past the highest node seq is well defined.
  const baseSeq = events.length === 0 ? 0 : Math.max(...surfaceNodes) + 1;

  const session = {
    id: "session-1",
    get seq() {
      return events.length === 0 ? baseSeq : Math.max(baseSeq, events.length);
    },
    surface: {
      get nodes() {
        return surfaceNodes;
      },
    },
    eventAt(seq: number) {
      return events.find((event) => event.seq === seq);
    },
    requestContext() {
      return window === undefined ? undefined : { contextWindow: window };
    },
    append(type: string, data: unknown, opts?: unknown) {
      const seq = events.length;
      events.push({ seq, type, data });
      appendLog.push({ type, data, opts });
      if (type !== "compaction/prune") {
        const op = opts as
          | { surfaceOp?: { op: string; startSeq: number } }
          | undefined;
        if (op?.surfaceOp?.op === "replace") {
          const target = surfaceNodes.indexOf(op.surfaceOp.startSeq);
          if (target >= 0) surfaceNodes.splice(target, 1, seq);
        } else if (op !== undefined) {
          surfaceNodes.push(seq);
        }
      }
      return { seq };
    },
    events,
    surfaceNodes,
    appendLog,
    setWindow(next: number | undefined) {
      window = next;
    },
  };
  return session;
}

/** A meter priced at 4 chars/token, like `dsh-token-meter`'s heuristic. */
function createFakeMeter(totalTokens: number): TokenMeterLike & {
  setTotalTokens(next: number): void;
  measureCalls: number;
} {
  let total = totalTokens;
  let measureCalls = 0;
  const price = (message: FakeMessage): number => {
    let tokens = 4; // role framing
    for (const block of message.content) {
      tokens += Math.ceil(block.text.length / 4) + 4;
    }
    return tokens;
  };
  return {
    get measureCalls() {
      return measureCalls;
    },
    setTotalTokens(next: number) {
      total = next;
    },
    measure(session: unknown) {
      measureCalls += 1;
      const fake = session as {
        surface: { nodes: readonly number[] };
        eventAt(seq: number): { data?: { message?: FakeMessage } } | undefined;
      };
      return {
        totalTokens: total,
        nodes: fake.surface.nodes.map((seq) => {
          const event = fake.eventAt(seq);
          const message = event?.data?.message;
          const tokens = message === undefined ? 4 : price(message);
          return { seq, tokens, heuristicTokens: tokens };
        }),
      };
    },
    estimateMessage(message: unknown) {
      return price(message as FakeMessage);
    },
  };
}

/** Boundary store over a plain map, mirroring the adapter's table. */
function createFakeBoundaryStore(): {
  rows: Map<string, CompactionBoundary>;
  writes: CompactionBoundary[];
  writeCompactionBoundary(boundary: CompactionBoundary): void;
  readCompactionBoundary(sessionId: string): CompactionBoundary | undefined;
} {
  const rows = new Map<string, CompactionBoundary>();
  const writes: CompactionBoundary[] = [];
  return {
    rows,
    writes,
    writeCompactionBoundary(boundary) {
      writes.push(boundary);
      rows.set(boundary.sessionId, boundary);
    },
    readCompactionBoundary(sessionId) {
      return rows.get(sessionId);
    },
  };
}

/** Tool-result message of `chars` characters. */
function toolMessage(seq: number, chars: number): FakeMessage {
  return {
    id: `m-${seq}`,
    role: "tool",
    content: [{ type: "text", text: "x".repeat(chars) }],
    source: { kind: "tool", callId: `call-${seq}` },
    toolCallId: `call-${seq}`,
  };
}

/** A surface with a system node, a user node and `toolCount` tool results. */
function baseSurface(toolCount: number, chars = 16_000) {
  const nodes: Array<{ seq: number; type: string; message?: FakeMessage }> = [
    {
      seq: 0,
      type: "system/message",
      message: { id: "sys", role: "system", content: [{ type: "text", text: "sys" }] },
    },
    {
      seq: 1,
      type: "user/message",
      message: { id: "u1", role: "user", content: [{ type: "text", text: "do work" }] },
    },
  ];
  for (let i = 0; i < toolCount; i += 1) {
    nodes.push({
      seq: 2 + i,
      type: "tool/result",
      message: toolMessage(2 + i, chars),
    });
  }
  nodes.push({
    seq: 2 + toolCount,
    type: "assistant/message",
    message: {
      id: "a1",
      role: "assistant",
      content: [{ type: "text", text: "working" }],
    },
  });
  return nodes;
}

const OPTIONS = {
  enabled: true,
  ratio: MICROCOMPACT_TRIGGER_RATIO,
  now: () => 1_700_000_000_000,
};

describe("microcompact pass (ticket 124)", () => {
  it("does nothing and says why when the window is unavailable", async () => {
    const session = createFakeSession(baseSurface(10));
    session.setWindow(undefined);
    const meter = createFakeMeter(THRESHOLD + 1);
    const store = createFakeBoundaryStore();

    const outcome = await runMicrocompactPass(OPTIONS, meter, store, session);
    assert.equal(outcome.compacted, false);
    assert.equal(outcome.reason, "window-unavailable");
    assert.equal(session.appendLog.length, 0);
    assert.equal(store.writes.length, 0);
  });

  it("clears only old tool results and keeps the newest N", async () => {
    const session = createFakeSession(baseSurface(9));
    const store = createFakeBoundaryStore();

    const outcome = await runMicrocompactPass(
      OPTIONS,
      createFakeMeter(THRESHOLD + 10_000),
      store,
      session,
    );
    assert.equal(outcome.compacted, true);
    assert.equal(outcome.reason, "ratio-met");

    const toolSeqs = [2, 3, 4, 5, 6, 7, 8, 9, 10];
    const newest = toolSeqs.slice(-MICROCOMPACT_KEEP_NEWEST);
    const replaced = outcome.boundary?.clearedSeqs ?? [];
    assert.ok(replaced.length > 0);
    for (const seq of newest) {
      assert.ok(
        !replaced.includes(seq),
        `newest tool result ${seq} must survive`,
      );
    }
    for (const seq of replaced) {
      assert.ok(toolSeqs.includes(seq), `${seq} must be an old tool result`);
    }
    // Only tool/result events were replaced; the user/system/assistant nodes
    // never appear in an append.
    const replacementTypes = session.appendLog
      .filter((entry) => entry.type === "tool/result")
      .map((entry) => (entry.opts as { surfaceOp: { startSeq: number } }).surfaceOp.startSeq);
    assert.deepEqual(replacementTypes, replaced);
  });

  it("replaces the content with the single placeholder and keeps tool identity", async () => {
    const session = createFakeSession(baseSurface(8));
    const store = createFakeBoundaryStore();
    await runMicrocompactPass(
      OPTIONS,
      createFakeMeter(THRESHOLD + 1),
      store,
      session,
    );

    const replacements = session.appendLog.filter(
      (entry) => entry.type === "tool/result",
    );
    assert.ok(replacements.length > 0);
    for (const entry of replacements) {
      const data = entry.data as { message: FakeMessage };
      assert.deepEqual(data.message.content, [
        { type: "text", text: CLEARED_TOOL_RESULT_TEXT },
      ]);
      assert.equal(data.message.role, "tool");
      assert.ok(
        typeof data.message.toolCallId === "string" &&
          data.message.toolCallId.startsWith("call-"),
        "the tool call identity survives the clear",
      );
      assert.deepEqual(data.message.source, {
        kind: "tool",
        callId: data.message.toolCallId,
      });
    }
  });

  it("writes the boundary once, after every replacement", async () => {
    const session = createFakeSession(baseSurface(8));
    const store = createFakeBoundaryStore();
    const outcome = await runMicrocompactPass(
      OPTIONS,
      createFakeMeter(THRESHOLD + 1),
      store,
      session,
    );

    assert.equal(store.writes.length, 1, "one rollback unit, one row");
    const boundary = store.writes[0];
    assert.ok(boundary);
    assert.equal(boundary.status, "applied");
    assert.equal(boundary.layer, "microcompact");
    assert.equal(boundary.trigger, "ratio");
    assert.equal(boundary.sessionId, "session-1");
    assert.equal(boundary.passSeq, 1);
    assert.equal(boundary.windowTokens, WINDOW);
    assert.equal(boundary.thresholdTokens, THRESHOLD);
    assert.equal(boundary.keepNewest, MICROCOMPACT_KEEP_NEWEST);
    assert.equal(boundary.ratio, MICROCOMPACT_TRIGGER_RATIO);
    assert.equal(
      boundary.clearedCount,
      boundary.clearedSeqs.length,
      "the row describes exactly what it replaced",
    );
    assert.deepEqual(
      boundary.replacementSeqs.length,
      boundary.clearedSeqs.length,
    );
    assert.equal(boundary.clearedBytes, boundary.clearedCount * 16_000);
    assert.ok(boundary.clearedChars > 0);
    assert.ok(boundary.freedTokens >= 8_192);
    // The row describes the LAST landed replacement — the resume cut.
    assert.equal(
      boundary.boundarySeq,
      boundary.replacementSeqs.at(-1),
      "boundarySeq is the last replacement's log seq",
    );
    assert.ok(
      session.eventAt(boundary.boundarySeq) !== undefined,
      "the resume cut names a real log event",
    );
    assert.deepEqual(outcome.boundary, boundary);
  });

  it("a repeat pass over the same surface clears nothing new", async () => {
    const session = createFakeSession(baseSurface(8));
    const store = createFakeBoundaryStore();
    const meter = createFakeMeter(THRESHOLD + 1);

    await runMicrocompactPass(OPTIONS, meter, store, session);
    const firstAppends = session.appendLog.length;

    const second = await runMicrocompactPass(OPTIONS, meter, store, session);
    assert.equal(second.compacted, false);
    assert.equal(second.reason, "nothing-eligible");
    assert.equal(
      session.appendLog.length,
      firstAppends,
      "no new appends on an already-compacted surface",
    );
    assert.equal(store.writes.length, 1, "no second boundary row");
  });

  it("declines while a native compaction holds the surface", async () => {
    const session = createFakeSession(baseSurface(10));
    session.append("compaction/start", { compactionId: "c1", turn: 1 });
    const store = createFakeBoundaryStore();

    const outcome = await runMicrocompactPass(
      OPTIONS,
      createFakeMeter(THRESHOLD + 1),
      store,
      session,
    );
    assert.equal(outcome.compacted, false);
    assert.equal(outcome.reason, "native-compaction-active");
    assert.equal(store.writes.length, 0);
  });

  it("a closed native compaction does not block the pass", async () => {
    const session = createFakeSession(baseSurface(10));
    session.append("compaction/start", { compactionId: "c1", turn: 1 });
    session.append("compaction/end", { compactionId: "c1", turn: 1 });
    const store = createFakeBoundaryStore();

    const outcome = await runMicrocompactPass(
      OPTIONS,
      createFakeMeter(THRESHOLD + 1),
      store,
      session,
    );
    assert.equal(outcome.compacted, true);
  });

  it("declines when there is no boundary store", async () => {
    const session = createFakeSession(baseSurface(8));
    const outcome = await runMicrocompactPass(
      OPTIONS,
      createFakeMeter(THRESHOLD + 1),
      undefined,
      session,
    );
    assert.equal(outcome.compacted, false);
    assert.equal(outcome.reason, "no-boundary-store");
    assert.equal(session.appendLog.length, 0);
  });

  it("leaves non-dispatcher sessions alone through the gate", async () => {
    const session = createFakeSession(baseSurface(8));
    const outcome = await runMicrocompactPass(
      { ...OPTIONS, shouldHandle: () => false },
      createFakeMeter(THRESHOLD + 1),
      createFakeBoundaryStore(),
      session,
    );
    assert.equal(outcome.compacted, false);
    assert.equal(session.appendLog.length, 0);
  });
});

describe("microcompact boundary round-trip (ticket 124)", () => {
  it("the placeholder is what the reader sees after a pass", async () => {
    const session = createFakeSession(baseSurface(8));
    const store = createFakeBoundaryStore();
    const outcome = await runMicrocompactPass(
      OPTIONS,
      createFakeMeter(THRESHOLD + 1),
      store,
      session,
    );

    // Re-derive the current surface: the replaced nodes point at nodes whose
    // content is the placeholder.
    for (const seq of session.surfaceNodes) {
      const event = session.eventAt(seq);
      if (event?.type !== "tool/result") continue;
      const data = event.data as { message: FakeMessage };
      const cleared = data.message.content[0]?.text === CLEARED_TOOL_RESULT_TEXT;
      if (cleared) continue;
      assert.ok(
        !outcome.boundary?.clearedSeqs.includes(seq),
        "no cleared original may still sit on the surface",
      );
    }
  });
});

describe("microcompact boundary read failure (durability)", () => {
  /**
   * A failed boundary read is NOT "there is no previous boundary": treating
   * the two alike would reset `passSeq` to 1 and overwrite the session's only
   * row. The pass must skip, apply nothing, and keep the counter monotonic
   * once the read works again.
   */
  it("skips instead of overwriting the only row when the read fails", async () => {
    const session = createFakeSession(baseSurface(8));
    const rows = new Map<string, CompactionBoundary>();
    const writes: CompactionBoundary[] = [];
    let failRead = true;
    const store = {
      writeCompactionBoundary(boundary: CompactionBoundary) {
        writes.push(boundary);
        rows.set(boundary.sessionId, boundary);
      },
      readCompactionBoundary(sessionId: string) {
        if (failRead) throw new Error("store unavailable");
        return rows.get(sessionId);
      },
    };
    // A previous pass already recorded passSeq 7.
    rows.set("session-1", {
      sessionId: "session-1",
      passSeq: 7,
    } as CompactionBoundary);
    const meter = createFakeMeter(THRESHOLD + 1);

    const failed = await runMicrocompactPass(OPTIONS, meter, store, session);
    assert.equal(failed.compacted, false);
    assert.equal(failed.reason, "boundary-read-failed");
    assert.equal(writes.length, 0, "no row was written");
    assert.equal(rows.get("session-1")?.passSeq, 7, "the only row survives");
    assert.equal(session.appendLog.length, 0, "nothing was applied");

    // Once the read recovers, the pass continues from the stored counter.
    failRead = false;
    const retried = await runMicrocompactPass(OPTIONS, meter, store, session);
    assert.equal(retried.compacted, true);
    assert.equal(retried.boundary?.passSeq, 8);
    assert.equal(writes.length, 1);
  });
});

describe("microcompact listener (ticket 124)", () => {
  /** Minimal bus fake: one listener per event name. */
  function createBus(): MicrocompactContextLike & {
    fire(payload: unknown): Promise<unknown>;
    readonly names: string[];
    readonly nextCalls: number;
  } {
    const listeners = new Map<string, (payload: never, next: () => Promise<unknown>) => unknown>();
    const names: string[] = [];
    let nextCalls = 0;
    return {
      names,
      get nextCalls() {
        return nextCalls;
      },
      on(name: string, listener: never) {
        names.push(name);
        listeners.set(name, listener);
        return () => {
          listeners.delete(name);
        };
      },
      async fire(payload: unknown) {
        const listener = listeners.get(MICROCOMPACT_EVENT);
        assert.ok(listener, "no pre-step listener registered");
        return listener(payload as never, async () => {
          nextCalls += 1;
          return { kind: "enter", messages: [] };
        });
      },
    };
  }

  it("registers on agent/pre-step and passes the decision through next()", async () => {
    const bus = createBus();
    const session = createFakeSession(baseSurface(8));
    const store = createFakeBoundaryStore();
    const dispose = registerMicrocompact(
      bus,
      { ...OPTIONS, shouldHandle: () => true },
      store,
      () => createFakeMeter(THRESHOLD + 1),
    );
    assert.deepEqual(bus.names, [MICROCOMPACT_EVENT]);
    const decision = await bus.fire({ agent: { session } });
    assert.deepEqual(decision, { kind: "enter", messages: [] });
    assert.equal(store.writes.length, 1);
    assert.doesNotThrow(() => dispose());
  });

  it("does nothing at all when disabled", async () => {
    const bus = createBus();
    registerMicrocompact(
      bus,
      { ...OPTIONS, enabled: false },
      createFakeBoundaryStore(),
      () => createFakeMeter(THRESHOLD + 1),
    );
    assert.deepEqual(bus.names, []);
  });

  /**
   * A compaction pass is best-effort context hygiene: no input it does not
   * understand may ever fail the model step.
   */
  it("never fails the step when the meter throws", async () => {
    const bus = createBus();
    const session = createFakeSession(baseSurface(8));
    registerMicrocompact(
      bus,
      { ...OPTIONS, shouldHandle: () => true },
      createFakeBoundaryStore(),
      () =>
        ({
          measure() {
            throw new Error("no meter today");
          },
        }) as never,
    );
    await assert.doesNotReject(() => bus.fire({ agent: { session } }));
  });

  /**
   * Ticket 265: a pass that is already past its trigger check and waiting on
   * the boundary read must not resume appending after its registration was
   * disposed. The gate is a manually controlled readCompactionBoundary, so
   * teardown lands exactly while the pass is suspended at its only await.
   */
  describe("listener lifetime (ticket 265)", () => {
    /** A boundary store whose read parks until the test releases it. */
    function createGatedStore(): {
      readonly store: BoundaryStoreLike;
      readonly started: Promise<void>;
      readonly writes: CompactionBoundary[];
      release(boundary?: CompactionBoundary): void;
    } {
      const writes: CompactionBoundary[] = [];
      let signalStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = () => resolve();
      });
      let releaseRead: ((boundary: CompactionBoundary | undefined) => void) | undefined;
      return {
        started,
        writes,
        release(boundary) {
          releaseRead?.(boundary);
        },
        store: {
          writeCompactionBoundary(boundary) {
            writes.push(boundary);
          },
          readCompactionBoundary() {
            signalStarted?.();
            return new Promise<CompactionBoundary | undefined>((resolve) => {
              releaseRead = resolve;
            });
          },
        },
      };
    }

    it("cancels a pending pass on disposal and appends nothing when the read resumes", async () => {
      const bus = createBus();
      const session = createFakeSession(baseSurface(8));
      const gated = createGatedStore();
      const outcomes: MicrocompactPassOutcome[] = [];
      const dispose = registerMicrocompact(
        bus,
        {
          ...OPTIONS,
          // Still eligible at disposal: cancellation must come from the
          // registration lifetime, not only from a changed gate.
          shouldHandle: () => true,
          onOutcome: (outcome) => outcomes.push(outcome),
        },
        gated.store,
        () => createFakeMeter(THRESHOLD + 1),
      );

      const pending = bus.fire({ agent: { session } });
      await gated.started;
      assert.equal(
        session.appendLog.length,
        0,
        "the pass is parked at the boundary read before any append",
      );

      // Teardown: publish cancellation, then unregister the listener, exactly
      // as plugin unload does before the boundary store is disposed.
      dispose();
      gated.release(undefined);

      const decision = await pending;
      assert.deepEqual(decision, { kind: "enter", messages: [] });
      assert.equal(bus.nextCalls, 1, "the pre-step continuation still runs once");
      assert.equal(
        session.appendLog.length,
        0,
        "no compaction/prune or replacement may land after disposal",
      );
      assert.equal(gated.writes.length, 0, "no boundary row after disposal");
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]?.compacted, false);
      assert.equal(outcomes[0]?.reason, "cancelled");
    });

    it("declines when dispatcher eligibility is lost while the read is pending", async () => {
      const bus = createBus();
      const session = createFakeSession(baseSurface(8));
      const gated = createGatedStore();
      const outcomes: MicrocompactPassOutcome[] = [];
      let eligible = true;

      registerMicrocompact(
        bus,
        {
          ...OPTIONS,
          shouldHandle: () => eligible,
          onOutcome: (outcome) => outcomes.push(outcome),
        },
        gated.store,
        () => createFakeMeter(THRESHOLD + 1),
      );

      const pending = bus.fire({ agent: { session } });
      await gated.started;
      eligible = false;
      gated.release(undefined);
      await pending;

      assert.equal(
        session.appendLog.length,
        0,
        "a deactivated dispatcher's session is not rewritten",
      );
      assert.equal(gated.writes.length, 0);
      assert.equal(outcomes[0]?.reason, "disabled");
    });
  });
});
