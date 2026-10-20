import assert from "node:assert/strict";
import { test } from "node:test";
import { createUnavailableLedger, registerRacoons, type RacoonsOptions, type RacoonsSession } from "../src/adapter/racoons.js";
import type { EngineInput, EngineResult } from "@racoons/core/engine/types.js";
import { pluginConfig } from "./support/plugin-config.js";

type Event = { seq: number; type: string; data: Record<string, unknown> };
function fakeSession(): RacoonsSession & { events: Event[]; writes: unknown[]; add(type: string, data: Record<string, unknown>): Event } {
  const events: Event[] = [];
  const nodes: Array<{ seq: number }> = [];
  const writes: unknown[] = [];
  return {
    id: "session-1", events, writes,
    get seq() { return events.length; },
    surface: { nodes },
    eventAt(seq) { return events.find(event => event.seq === seq); },
    add(type, data) {
      const event = { seq: events.length + 1, type, data };
      events.push(event); nodes.push({ seq: event.seq }); return event;
    },
    append(type, payload, options) {
      writes.push({ type, payload, options });
      const event = { seq: events.length + 1, type, data: payload as Record<string, unknown> };
      events.push(event);
      const surfaceOp = options.surfaceOp;
      if (surfaceOp.op === "replace") {
        const index = nodes.findIndex(node => node.seq === surfaceOp.startSeq);
        assert.ok(index >= 0);
        nodes.splice(index, 1, { seq: event.seq });
      } else nodes.push({ seq: event.seq });
      return event;
    },
  };
}
function fakeCtx() {
  const listeners = new Map<string, (...args: never[]) => void>();
  const cleanups: Array<() => void> = [];
  return {
    listeners,
    on(name: string, listener: (...args: never[]) => void) {
      listeners.set(name, listener); return () => { listeners.delete(name); };
    },
    effect(execute: () => () => void) { cleanups.push(execute()); },
    async emit(name: string, ...args: unknown[]) {
      const listener = listeners.get(name);
      if (listener !== undefined) await listener(...args as never[]);
    },
    dispose() { for (const cleanup of cleanups) cleanup(); },
  };
}
const result = (status: EngineResult["status"] = "unchanged"): EngineResult => ({ status, intentId: null, receipt: null, validation: null });
function setup(process?: (input: EngineInput) => Promise<EngineResult>, enabled = true,
  overrides: Partial<RacoonsOptions> = {}) {
  const ctx = fakeCtx();
  const session = fakeSession();
  const calls: EngineInput[] = [];
  const errors: unknown[] = [];
  const options: RacoonsOptions = {
    enabled: pluginConfig({ racoonsEnabled: enabled }).racoonsEnabled === true,
    shouldHandle: id => id === session.id,
    onError: error => errors.push(error),
    openLedger: async () => createUnavailableLedger(),
    createEngine: async () => ({ async process(input) {
      calls.push(input); return process === undefined ? result() : process(input);
    } }),
    ...overrides,
  };
  ctx.effect(() => registerRacoons(ctx, options));
  return { ctx, session, calls, errors };
}
const text = (value: string) => [{ type: "text", text: value }];
function tool(session: ReturnType<typeof fakeSession>, callId = "call-1") {
  session.add("assistant", { content: text(""), toolCalls: [{ id: callId }] });
  return session.add("tool/result", { callId, toolName: "read", content: text("first\nsecond\n") });
}

test("disabled registers no listeners; enabled registers both and disposes them", () => {
  const off = setup(undefined, false);
  assert.equal(off.ctx.listeners.size, 0);
  off.ctx.dispose();
  const on = setup();
  assert.deepEqual([...on.ctx.listeners.keys()].sort(), ["agent/pre-step", "session/event"]);
  on.ctx.dispose();
  assert.equal(on.ctx.listeners.size, 0);
});

test("an empty pre-step calls at-rest exactly once", async () => {
  const f = setup();
  try {
    await f.ctx.emit("agent/pre-step", { agent: { session: f.session } });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]?.kind, "at-rest");
    assert.equal(f.calls[0]?.kind === "at-rest" && f.calls[0].reason, "step");
  } finally { f.ctx.dispose(); }
});

test("observation writes nothing; next pre-step processes the entry then at-rest once", async () => {
  const f = setup();
  try {
    const event = tool(f.session);
    await f.ctx.emit("session/event", f.session, event);
    assert.equal(f.calls.length, 0);
    assert.equal(f.session.writes.length, 0);
    await f.ctx.emit("agent/pre-step", { agent: { session: f.session } });
    assert.deepEqual(f.calls.map(call => call.kind), ["entry", "at-rest"]);
    const entry = f.calls[0];
    assert.equal(entry?.kind === "entry" && entry.result.callId, "call-1");
    await f.ctx.emit("agent/pre-step", { agent: { session: f.session } });
    assert.deepEqual(f.calls.map(call => call.kind), ["entry", "at-rest", "at-rest"]);
  } finally { f.ctx.dispose(); }
});

test("engine throws are swallowed and the pending entry is retried", async () => {
  const f = setup(async () => { throw new Error("engine failure"); });
  try {
    await f.ctx.emit("session/event", f.session, tool(f.session));
    await assert.doesNotReject(f.ctx.emit("agent/pre-step", { agent: { session: f.session } }));
    await assert.doesNotReject(f.ctx.emit("agent/pre-step", { agent: { session: f.session } }));
    assert.deepEqual(f.calls.map(call => call.kind), ["entry", "entry"]);
    assert.equal(f.errors.length, 2);
  } finally { f.ctx.dispose(); }
});

test("a refused entry is recorded and is not retried", async () => {
  const f = setup(async input => result(input.kind === "entry" ? "rejected" : "unchanged"));
  try {
    const event = tool(f.session);
    await f.ctx.emit("session/event", f.session, event);
    await f.ctx.emit("agent/pre-step", { agent: { session: f.session } });
    await f.ctx.emit("session/event", f.session, event);
    await f.ctx.emit("agent/pre-step", { agent: { session: f.session } });
    assert.deepEqual(f.calls.map(call => call.kind), ["entry", "at-rest", "at-rest"]);
    assert.equal(f.session.writes.length, 0);
  } finally { f.ctx.dispose(); }
});

test("dispatcher predicate gates observation and pre-step", async () => {
  const f = setup(undefined, true, { shouldHandle: () => false });
  try {
    await f.ctx.emit("session/event", f.session, tool(f.session));
    await f.ctx.emit("agent/pre-step", { agent: { session: f.session } });
    assert.equal(f.calls.length, 0);
  } finally { f.ctx.dispose(); }
});

test("unknown outcome keeps the first entry pending and stops before later entries or at-rest", async () => {
  const f = setup(async () => result("recovery-pending"));
  try {
    await f.ctx.emit("session/event", f.session, tool(f.session));
    await f.ctx.emit("session/event", f.session, tool(f.session, "call-2"));
    await f.ctx.emit("agent/pre-step", { agent: { session: f.session } });
    await f.ctx.emit("agent/pre-step", { agent: { session: f.session } });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0]?.eventId, f.calls[1]?.eventId);
    assert.ok(f.calls.every(call => call.kind === "entry" && call.result.callId === "call-1"));
  } finally { f.ctx.dispose(); }
});

test("pending results are processed in sequence order", async () => {
  const f = setup();
  try {
    const first = tool(f.session);
    const second = tool(f.session, "call-2");
    await f.ctx.emit("session/event", f.session, second);
    await f.ctx.emit("session/event", f.session, first);
    await f.ctx.emit("agent/pre-step", { agent: { session: f.session } });
    assert.deepEqual(f.calls.map(call => call.kind === "entry" ? call.result.callId : call.kind),
      ["call-1", "call-2", "at-rest"]);
  } finally { f.ctx.dispose(); }
});

test("unavailable SQLite injects a refusing ledger and the listener never throws", async () => {
  const ctx = fakeCtx();
  const session = fakeSession();
  const errors: unknown[] = [];
  let checked = false;
  ctx.effect(() => registerRacoons(ctx, { enabled: true, shouldHandle: () => true,
    openLedger: async () => { throw new Error("SQLite absent"); }, onError: error => errors.push(error),
    createEngine: async ({ ledger }) => ({ async process() {
      await assert.rejects(ledger.prepare({} as never), /racoons ledger unavailable/);
      await assert.rejects(ledger.recall("missing"), /racoons ledger unavailable/);
      checked = true;
      return result("recovery-pending");
    } }),
  }));
  try {
    await assert.doesNotReject(ctx.emit("agent/pre-step", { agent: { session } }));
    assert.equal(session.writes.length, 0);
    assert.equal(checked, true);
    assert.ok(errors.some(error => error instanceof Error && error.message === "SQLite absent"));
    await assert.rejects(createUnavailableLedger().recall("missing"), /racoons ledger unavailable/);
  } finally { ctx.dispose(); }
});
