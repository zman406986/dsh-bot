import assert from "node:assert/strict";
import { test } from "node:test";
import { registerRacoons, type RacoonsSession } from "../src/adapter/racoons.js";
import { DEFAULT_CONFIG } from "@racoons/core/config.js";
import type { Ledger, LedgerEntry, RecallRecord } from "@racoons/core/ledger/types.js";

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
  return {
    on(name: string, listener: (...args: never[]) => void) {
      listeners.set(name, listener); return () => { listeners.delete(name); };
    },
    async emit(name: string, ...args: unknown[]) {
      const listener = listeners.get(name);
      if (listener !== undefined) await listener(...args as never[]);
    },
  };
}
function fakeLedger() {
  const entries: LedgerEntry[] = [];
  const archives = new Map<string, RecallRecord>();
  let intents = 0;
  const ledger: Ledger = {
    async prepare(application) {
      for (const archive of application.archives) archives.set(archive.recall.id, structuredClone(archive.recall));
      return { intentId: `intent-${++intents}`, sessionId: application.sessionId,
        eventId: application.eventId, baseRevision: application.baseRevision,
        applicationSha256: application.applicationSha256 };
    },
    async append(event) {
      const prior = entries.find(entry => entry.event.eventKey === event.eventKey);
      if (prior !== undefined) return structuredClone(prior);
      const entry = { sequence: entries.length + 1, event: structuredClone(event) };
      entries.push(entry);
      return structuredClone(entry);
    },
    async *events(sessionId) {
      for (const entry of structuredClone(entries)) if (entry.event.sessionId === sessionId) yield entry;
    },
    async recall(id) {
      const record = archives.get(id);
      if (record === undefined) throw new Error("Recall not found");
      return structuredClone(record);
    },
    async close() {},
  };
  return { ledger, entries, archives };
}
const text = (value: string) => [{ type: "text", text: value }];

test("the real engine caps a staged result with explicit thresholds and archives the original", async () => {
  const ctx = fakeCtx();
  const session = fakeSession();
  const { ledger, entries, archives } = fakeLedger();
  const errors: unknown[] = [];
  const config = { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds, capBytes: 16, capHeadBytes: 6 } };
  const dispose = registerRacoons(ctx, { enabled: true, shouldHandle: () => true,
    config, openLedger: async () => ledger, onError: error => errors.push(error) });
  try {
    session.add("assistant", { content: text(""), toolCalls: [{ id: "large-call" }] });
    const original = "first\n" + "body\n".repeat(200);
    const event = session.add("tool/result", { callId: "large-call", toolName: "read", content: text(original) });
    await ctx.emit("session/event", session, event);
    assert.equal(session.writes.length, 0);
    await ctx.emit("agent/pre-step", { agent: { session } });
    assert.deepEqual(errors, []);
    assert.equal(session.writes.length, 1);
    const currentSeq = session.surface.nodes[1]?.seq;
    assert.notEqual(currentSeq, event.seq);
    const visible = session.events.find(value => value.seq === currentSeq);
    const content = visible?.data["content"] as Array<{ type: string; text: string }>;
    assert.equal(content[0]?.type, "text");
    assert.match(content[0]?.text ?? "", /^first\n\[Capped:/);
    assert.equal(archives.size, 1);
    const archive = [...archives.values()][0];
    assert.deepEqual(archive?.parts[0]?.bytes, new TextEncoder().encode(original));
    assert.ok(entries.some(entry => entry.event.kind === "applied"));
    await ctx.emit("agent/pre-step", { agent: { session } });
    assert.equal(session.writes.length, 1);
  } finally { dispose(); }
});

test("the real engine appends one seal for a closed episode with explicit miss evidence", async () => {
  const ctx = fakeCtx();
  const session = fakeSession();
  const { ledger, entries } = fakeLedger();
  const errors: unknown[] = [];
  const dispose = registerRacoons(ctx, { enabled: true, shouldHandle: () => true,
    openLedger: async () => ledger, onError: error => errors.push(error),
    evidenceFor: () => ({ toolName: "search", target: { key: "needle", label: "needle" },
      result: { complete: true, failed: false, paths: [{ path: "src/a.ts", matchCount: 0 }] } }),
  });
  try {
    session.add("user", { content: text("find needle") });
    session.add("assistant", { content: text(""), toolCalls: [{ id: "search-call" }] });
    const event = session.add("tool/result", { callId: "search-call", toolName: "search", content: text("opaque output") });
    await ctx.emit("session/event", session, event);
    await ctx.emit("agent/pre-step", { agent: { session } });
    assert.equal(session.writes.length, 0);
    session.add("user", { content: text("next turn") });
    await ctx.emit("agent/pre-step", { agent: { session } });
    assert.deepEqual(errors, []);
    assert.equal(session.writes.length, 1);
    assert.deepEqual(session.writes[0] && (session.writes[0] as { options: unknown }).options,
      { surfaceOp: { op: "append" } });
    assert.ok(entries.some(entry => entry.event.kind === "applied"));
    await ctx.emit("agent/pre-step", { agent: { session } });
    assert.equal(session.writes.length, 1);
  } finally { dispose(); }
});
