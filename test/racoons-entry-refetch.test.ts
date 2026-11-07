import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRacoonsPlugin } from "racoons-dsh";
import type {
  DshLlmChunk, DshLlmService, DshMountContext, DshMountEvent, DshMountSession,
} from "racoons-dsh";

/**
 * Ticket 237 — one captured refetch is one occurrence. The observation and the
 * later entry answer carry different event ids but the SAME landed result node;
 * only the result node may key refetch accounting. A genuinely later fetch is a
 * different result node and must still report.
 */

interface FakeEvent extends DshMountEvent {
  readonly type: string;
  readonly seq: number;
  readonly data?: unknown;
  readonly surfaceOp?: unknown;
  readonly sourceEventSeqs?: readonly number[];
}

function fakeSession(id: string): DshMountSession & {
  readonly log: FakeEvent[];
  readonly surface: { nodes: number[] };
} {
  const log: FakeEvent[] = [];
  const nodes: number[] = [];
  const session = {
    id,
    log,
    surface: { nodes },
    get seq() { return log.length; },
    eventAt: (seq: number) => log[seq],
    append(type: string, data: unknown, options: Record<string, unknown> = {}) {
      const seq = log.length;
      const surfaceOp = options["surfaceOp"];
      if (surfaceOp === "append") nodes.push(seq);
      else if (surfaceOp !== undefined) {
        const op = surfaceOp as { startSeq: number; endSeq: number };
        const start = nodes.indexOf(op.startSeq);
        const end = nodes.indexOf(op.endSeq);
        if (start < 0 || end < 0) throw new Error("surface replace out of range");
        nodes.splice(start, end - start + 1, seq);
      }
      const event: FakeEvent = Object.freeze({
        type, seq, data: Object.freeze(structuredClone(data)),
        ...(surfaceOp === undefined ? {} : { surfaceOp }),
        ...(options["sourceEventSeqs"] === undefined
          ? {} : { sourceEventSeqs: options["sourceEventSeqs"] as number[] }),
      });
      log.push(event);
      return event;
    },
    requestHeader: () => ({ config: { provider: "stub", model: "stub" } }),
  };
  return session;
}

const encoder = new TextEncoder();
const BODY = Array.from({ length: 240 }, (_, index) =>
  `row ${String(index)} ${"x".repeat(36)}`).join("\n");

function appendStep(session: ReturnType<typeof fakeSession>, step: number, callId: string): void {
  if (step === 1) session.append("turn/start", { turn: 1 });
  session.append("step/start", { turn: 1, step });
  if (step === 1) {
    session.append("system/message", { turn: 1, step, message: { role: "system",
      content: [{ type: "text", text: "sys" }], source: { kind: "system-prompt" }, id: "sys" } },
    { surfaceOp: "append" });
  }
  session.append("user/message", { content: [{ type: "text", text: `task ${String(step)}` }],
    source: { kind: "user" }, role: "user", id: `user-${String(step)}` }, { surfaceOp: "append" });
  session.append("tool/call", { turn: 1, step, callId, name: "read", arguments: "{}" });
  session.append("assistant/message", { turn: 1, step, message: { role: "assistant",
    source: { kind: "model", provider: "stub", model: "stub" },
    content: [{ type: "tool-call", id: callId, name: "read", arguments: "{}" }],
    id: `asst-${callId}` } }, { surfaceOp: "append" });
  session.append("tool/result", { turn: 1, step, message: { role: "tool",
    source: { kind: "tool", callId }, toolCallId: callId,
    content: [{ type: "text", text: BODY }], isError: false, id: `result-${callId}` } },
  { surfaceOp: "append" });
  session.append("step/end", { turn: 1, step });
}

type Listener = (...args: never[]) => unknown;

function createBus(): {
  on(name: string, listener: Listener): () => void;
  fire(name: string, ...args: unknown[]): Promise<unknown>;
  fireSync(name: string, ...args: unknown[]): void;
} {
  const listeners = new Map<string, Listener[]>();
  return {
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      return () => {};
    },
    async fire(name, ...args) {
      let result: unknown;
      for (const listener of [...(listeners.get(name) ?? [])]) {
        result = await (listener as (...values: unknown[]) => unknown)(...args);
      }
      return result;
    },
    fireSync(name, ...args) {
      for (const listener of [...(listeners.get(name) ?? [])]) {
        (listener as (...values: unknown[]) => unknown)(...args);
      }
    },
  };
}

interface Harness {
  readonly session: ReturnType<typeof fakeSession>;
  step(step: number, callId: string): Promise<void>;
  refetches(): Array<{ sourceSha256: string; recallId: string; fetchedBytes: number }>;
  readonly journal: Array<Record<string, unknown>>;
}

async function harness(): Promise<Harness> {
  const journal: Array<Record<string, unknown>> = [];
  const answers = ['{"forgetall":"archived source"}'];
  let streams = 0;
  const llm: DshLlmService = {
    stream() {
      const answer = answers[streams] ?? '{"keepall":true}';
      streams += 1;
      return (async function* emit(): AsyncGenerator<DshLlmChunk> {
        yield { type: "text-delta", index: 0, text: answer };
        yield { type: "finish", reason: "stop" };
      })();
    },
  };
  const bus = createBus();
  const ctx = { ...bus, llm, get: () => undefined } as unknown as DshMountContext;
  const plugin = createRacoonsPlugin({
    config: { floorBytes: 1 },
    storage: { databasePath: ":memory:" },
    journal: (record) => { journal.push(record as unknown as Record<string, unknown>); },
  });
  await plugin.apply(ctx, {});
  const session = fakeSession("s237");
  const lastSeen = { length: 0 };
  const step = async (number: number, callId: string): Promise<void> => {
    appendStep(session, number, callId);
    for (const event of session.log.slice(lastSeen.length)) {
      bus.fireSync("session/event", session, event);
    }
    lastSeen.length = session.log.length;
    await bus.fire("llm/stream", {
      sessionId: session.id, provider: "stub", model: "stub", system: "sys", tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "task" }] }],
    }, () => (async function* none(): AsyncGenerator<never> {})());
    await bus.fire("agent/pre-step",
      { agent: { session }, messages: [], turn: 1, step: number + 1,
        signal: new AbortController().signal }, () => ({ kind: "enter" }));
  };
  const refetches = (): Array<{ sourceSha256: string; recallId: string; fetchedBytes: number }> =>
    journal.flatMap((record) => {
      if (record["kind"] !== "telemetry") return [];
      const event = record["event"] as { kind?: string } | undefined;
      return event?.kind === "refetch"
        ? [event as unknown as { sourceSha256: string; recallId: string; fetchedBytes: number }]
        : [];
    });
  return { session, step, refetches, journal };
}

const SOURCE_SHA256 = (await import("node:crypto")).createHash("sha256")
  .update(encoder.encode(BODY)).digest("hex");

describe("racoons entry refetch accounting (ticket 237)", () => {
  it("counts one observation+answer occurrence and still reports a later fetch", async () => {
    const run = await harness();
    await run.step(1, "c1");
    assert.ok(run.journal.some((record) => record["kind"] === "entry-apply"
      && record["status"] === "landed" && record["action"] === "forgetall"),
    "the first answer archived the source");
    assert.equal(run.refetches().length, 0, "the original fetch is not a refetch");

    await run.step(2, "c2");
    const first = run.refetches();
    assert.equal(first.length, 1,
      "the observation and its answer report one refetch for the same landed result");
    assert.equal(first[0]?.sourceSha256, SOURCE_SHA256);
    assert.ok((first[0]?.fetchedBytes ?? 0) > 0);

    await run.step(3, "c3");
    assert.equal(run.refetches().length, 2,
      "a separate later fetch of the same bytes is its own occurrence");
  });
});
