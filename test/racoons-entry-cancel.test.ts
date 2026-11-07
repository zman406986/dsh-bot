import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRacoonsPlugin } from "racoons-dsh";
import type {
  DshLlmChunk, DshLlmService, DshMountContext, DshMountEvent, DshMountSession,
} from "racoons-dsh";

/**
 * Ticket 189 — the registered pre-step listener must forward its caller's
 * AbortSignal into the pending entry ask. Aborting releases the hook, writes
 * no ask/apply turns and starts no second queued ask; the non-aborted control
 * still applies its keep-all answer.
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
        const at = nodes.indexOf(op.startSeq);
        if (at >= 0) nodes.splice(at, 1, seq);
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

function scriptStep(session: ReturnType<typeof fakeSession>, step: number): void {
  session.append("turn/start", { turn: 1 });
  session.append("step/start", { turn: 1, step });
  session.append("system/message", { turn: 1, step, message: { role: "system",
    content: [{ type: "text", text: "sys" }], source: { kind: "system-prompt" }, id: "sys" } },
  { surfaceOp: "append" });
  session.append("user/message", { content: [{ type: "text", text: `task ${String(step)}` }],
    source: { kind: "user" }, role: "user", id: `user-${String(step)}` }, { surfaceOp: "append" });
  const callId = `c${String(step)}`;
  session.append("tool/call", { turn: 1, step, callId, name: "read", arguments: "{}" });
  session.append("assistant/message", { turn: 1, step, message: { role: "assistant",
    source: { kind: "model", provider: "stub", model: "stub" },
    content: [{ type: "tool-call", id: callId, name: "read", arguments: "{}" }],
    id: `asst-${callId}` } }, { surfaceOp: "append" });
  session.append("tool/result", { turn: 1, step, message: { role: "tool",
    source: { kind: "tool", callId }, toolCallId: callId,
    content: [{ type: "text", text: `body ${String(step)}\n` }], isError: false,
    id: `result-${callId}` } }, { surfaceOp: "append" });
  session.append("step/end", { turn: 1, step });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function abortOf(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
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
  readonly bus: ReturnType<typeof createBus>;
  readonly session: ReturnType<typeof fakeSession>;
  readonly gate: ReturnType<typeof deferred<void>>;
  readonly started: ReturnType<typeof deferred<void>>;
  readonly journal: Array<Record<string, unknown>>;
  readonly signals: Array<AbortSignal | undefined>;
  streams(): number;
  hook(signal: AbortSignal): Promise<unknown>;
}

async function harness(): Promise<Harness> {
  const gate = deferred<void>();
  const started = deferred<void>();
  const journal: Array<Record<string, unknown>> = [];
  const signals: Array<AbortSignal | undefined> = [];
  let streams = 0;
  const llm: DshLlmService = {
    stream(options) {
      streams += 1;
      if (streams === 1) started.resolve();
      const signal = options.signal;
      signals.push(signal);
      return (async function* emit(): AsyncGenerator<DshLlmChunk> {
        // A real host stream ends when its request signal aborts. This stub
        // also emits a VALID answer on that path: the late answer must be
        // ignored by the caller-side guard, not turned into entry effects.
        await Promise.race([gate.promise, abortOf(signal)]);
        yield { type: "text-delta", index: 0, text: "{\"keepall\":true}" };
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
  const session = fakeSession("s189");
  scriptStep(session, 1);
  scriptStep(session, 2);
  for (const event of session.log) bus.fireSync("session/event", session, event);
  await bus.fire("llm/stream", {
    sessionId: session.id, provider: "stub", model: "stub",
    system: "sys", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "task" }] }],
  }, () => (async function* none(): AsyncGenerator<never> {})());
  return { bus, session, gate, started, journal, signals, streams: () => streams,
    hook: (signal) => bus.fire("agent/pre-step",
      { agent: { session }, messages: [], turn: 1, step: 3, signal }, () => ({ kind: "enter" })) };
}

describe("racoons entry ask cancellation (ticket 189)", () => {
  it("aborts the pending ask, releases the hook and starts no later ask", async () => {
    const run = await harness();
    const controller = new AbortController();
    const hook = run.hook(controller.signal);
    await run.started.promise;
    const before = run.session.log.length;
    controller.abort();
    let settled = false;
    const completion = await Promise.race([
      hook.then(() => { settled = true; return "done"; }),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);
    try {
      assert.equal(completion, "done", "abort promptly releases the pre-step hook");
      assert.equal(run.signals[0]?.aborted, true, "the caller signal reaches the ask stream");
      assert.equal(run.streams(), 1, "no later queued ask starts after abort");
      assert.equal(run.session.log.length, before, "the late answer writes no ask or apply turn");
    } finally {
      run.gate.resolve();
      if (!settled) await hook;
    }
  });

  it("still applies the answer when the caller never aborts", async () => {
    const run = await harness();
    const hook = run.hook(new AbortController().signal);
    await run.started.promise;
    run.gate.resolve();
    await hook;
    assert.ok(run.streams() >= 1, "the ask ran");
    assert.ok(run.journal.some((record) => record["kind"] === "entry-apply"
      && record["status"] === "rewound" && record["action"] === "keepall"),
    "the keep-all answer applies through the normal path");
  });
});
