import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createRacoonsPort, type RacoonsSession } from "../src/adapter/racoons.js";
import type { ApplyRequest } from "@racoons/core/engine/types.js";

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
const text = (value: string) => [{ type: "text", text: value }];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function appendRequest(bridge: ReturnType<typeof createRacoonsPort>): Promise<ApplyRequest> {
  const bytes = new TextEncoder().encode("record");
  // Port tests deliberately probe the boundary with a branded-request fixture.
  const application = { sessionId: "session-1", eventId: "event-1",
    baseRevision: (await bridge.port.snapshot()).revision, phase: "at-rest", mode: "append",
    applicationSha256: "digest", replacements: [], appendRecords: [{ recordId: "record-1", bytes, sha256: hash(bytes) }],
    archives: [], sealedEpisodeIds: [], createdAtMs: 1 } as unknown as ApplyRequest["application"];
  return { application, intent: { intentId: "intent-1", sessionId: application.sessionId,
    eventId: application.eventId, baseRevision: application.baseRevision, applicationSha256: application.applicationSha256 } };
}

test("port refuses a stale host revision before writing", async () => {
  const session = fakeSession();
  const bridge = createRacoonsPort(session);
  bridge.refresh();
  const request = await appendRequest(bridge);
  session.add("user", { content: text("changed") });
  assert.deepEqual(await bridge.port.apply(request), { status: "not-applied", reason: "stale-revision" });
  assert.equal(session.writes.length, 0);
});

test("same intent yields one receipt and one host append", async () => {
  const session = fakeSession();
  const bridge = createRacoonsPort(session);
  bridge.refresh();
  const request = await appendRequest(bridge);
  const [first, second] = await Promise.all([bridge.port.apply(request), bridge.port.apply(request)]);
  assert.equal(first.status, "applied");
  assert.deepEqual(first, second);
  assert.equal(session.writes.length, 1);
  assert.deepEqual(await bridge.port.lookupReceipt(request.intent.intentId), first);
});

test("entry publication uses one replacement with source provenance and one receipt", async () => {
  const session = fakeSession();
  session.add("assistant", { content: text(""), toolCalls: [{ id: "call-1" }] });
  const event = session.add("tool/result", { callId: "call-1", toolName: "read", content: text("first\nsecond\n") });
  const bridge = createRacoonsPort(session);
  bridge.refresh();
  const bytes = new TextEncoder().encode("first\nsecond\n");
  const source = { nodeId: `${session.id}:${event.seq}`, sha256: hash(bytes), byteLength: bytes.length };
  const node = bridge.stage({ seq: event.seq, callId: "call-1", role: "tool/result", bytes,
    evidence: { kind: "read", target: null, paths: [], source, sourceRecallId: null } });
  const output = new TextEncoder().encode("first\nmarker");
  const application = { sessionId: session.id, eventId: `${session.id}:entry:${event.seq}`,
    baseRevision: (await bridge.port.snapshot()).revision, phase: "entry", mode: "entry",
    applicationSha256: "digest", replacements: [{ source, bytes: output, sha256: hash(output),
      retainedCopies: [], generatedRanges: [], evidenceRecallId: "recall-1" }],
    appendRecords: [], archives: [], sealedEpisodeIds: [], createdAtMs: 1 } as unknown as ApplyRequest["application"];
  const request = { application, intent: { intentId: "entry-intent", sessionId: session.id,
    eventId: application.eventId, baseRevision: application.baseRevision, applicationSha256: application.applicationSha256 } };
  assert.equal(node.sha256, source.sha256);
  const first = await bridge.port.apply(request);
  assert.equal(first.status, "applied");
  assert.deepEqual(await bridge.port.apply(request), first);
  assert.equal(session.writes.length, 1);
  assert.deepEqual(session.writes[0], { type: "tool/result",
    payload: { ...event.data, content: text("first\nmarker") },
    options: { surfaceOp: { op: "replace", startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] } });
  // Original engine input survives a host success before ledger confirmation.
  bridge.endPass();
  bridge.refresh();
  assert.deepEqual(bridge.stage({ seq: event.seq, callId: "call-1", role: "tool/result", bytes,
    evidence: node.evidence }), node);
  bridge.finish(application.eventId);
  const visible = (await bridge.port.snapshot()).nodes.find(value => value.id === source.nodeId);
  assert.equal(visible?.kind, "tool-result");
  if (visible?.kind === "tool-result") {
    assert.equal(visible.evidence.sourceRecallId, "recall-1");
    assert.deepEqual(visible.bytes, output);
  }
});

test("a host throw is unknown and cannot duplicate a publication", async () => {
  const session = fakeSession();
  let attempts = 0;
  session.append = () => { attempts += 1; throw new Error("uncertain append"); };
  const bridge = createRacoonsPort(session, () => true, undefined, () => {});
  bridge.refresh();
  const request = await appendRequest(bridge);
  assert.deepEqual(await bridge.port.apply(request), { status: "unknown" });
  assert.deepEqual(await bridge.port.apply(request), { status: "unknown" });
  assert.deepEqual(await bridge.port.lookupReceipt(request.intent.intentId), { status: "unknown" });
  assert.equal(attempts, 1);
});

test("a return without a visible surface change cannot create an applied receipt", async () => {
  const session = fakeSession();
  let attempts = 0;
  session.append = () => { attempts += 1; return { seq: session.seq + 1 }; };
  const bridge = createRacoonsPort(session, () => true, undefined, () => {});
  bridge.refresh();
  const request = await appendRequest(bridge);
  assert.deepEqual(await bridge.port.apply(request), { status: "unknown" });
  assert.deepEqual(await bridge.port.apply(request), { status: "unknown" });
  assert.equal(attempts, 1);
});
