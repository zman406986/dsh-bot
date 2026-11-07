import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DshApplicationPort } from "racoons-dsh";
import type { DshRevertSession, DshSurfaceNode, DshTranscriptItem } from "racoons-dsh";

/**
 * Ticket 188 — a partial-retention entry write into a mixed [text, image]
 * result must keep the non-text block and its attachment reference. The
 * text-only control pins that the ordinary replacement still happens.
 */

const TEXT = "alpha\nbeta\ngamma\n";
const RESULT_ID = "dsh:s:result:c1";
const IMAGE = { type: "image", source: { kind: "attachment", attachmentId: "a1" } };
const encoder = new TextEncoder();

function resultData(content: unknown[]): Record<string, unknown> {
  return { turn: 1, step: 1,
    message: { role: "tool", toolCallId: "c1", content } };
}

function surfaceNode(data: Record<string, unknown>, content: unknown[]): DshSurfaceNode {
  return { id: RESULT_ID, seq: 1, type: "tool/result", callId: "c1",
    blocks: content.map(block => {
      const typed = block as { type: string; text?: string };
      return { type: typed.type, ...(typed.text === undefined ? {} : { text: typed.text }) };
    }),
    data };
}

function fixture(content: unknown[]): {
  port: DshApplicationPort; appends: Array<{ type: string; data: Readonly<Record<string, unknown>> }>;
} {
  const data = resultData(content);
  const node = surfaceNode(data, content);
  const ask: DshSurfaceNode = { id: "ask", seq: 2, type: "user/message",
    blocks: [{ type: "text", text: "keep?" }], data: {} };
  const answer: DshSurfaceNode = { id: "answer", seq: 3, type: "assistant/message",
    blocks: [{ type: "text", text: "kept" }], data: {} };
  const appends: Array<{ type: string; data: Readonly<Record<string, unknown>> }> = [];
  const session: DshRevertSession = {
    surface: () => [node, ask, answer],
    nextSeq: () => 9,
    append(type, appendData) {
      appends.push({ type, data: appendData });
      return { seq: 8 };
    },
  };
  const item: DshTranscriptItem = { id: RESULT_ID, role: "tool", callId: "c1",
    toolName: "read", turnOrdinal: 1, stepOrdinal: 1, bytes: encoder.encode(TEXT) };
  const port = new DshApplicationPort({ sessionId: "s", clock: { nowMs: () => 1 },
    transcript: [item], revert: session });
  return { port, appends };
}

function apply(port: DshApplicationPort): unknown {
  return port.applyEntryShape({ resultNodeId: RESULT_ID, askNodeId: "ask",
    answerNodeId: "answer", summary: "kept the first part" }, encoder.encode(TEXT));
}

describe("racoons partial retention on mixed content (ticket 188)", () => {
  it("keeps a non-text block and its attachment reference", () => {
    const { port, appends } = fixture([{ type: "text", text: TEXT }, IMAGE]);
    assert.equal((apply(port) as { status: string }).status, "applied");
    const written = appends.at(-1);
    assert.equal(written?.type, "tool/result");
    const content = (written?.data["message"] as { content: unknown[] }).content;
    assert.equal(content.length, 2, "the image block is not dropped");
    assert.deepEqual(content[1], IMAGE, "the attachment reference is byte-for-byte preserved");
  });

  it("still replaces a text-only result with the shaped turn alone", () => {
    const { port, appends } = fixture([{ type: "text", text: TEXT }]);
    assert.equal((apply(port) as { status: string }).status, "applied");
    const content = ((appends.at(-1)?.data["message"]) as { content: unknown[] }).content;
    assert.deepEqual(content.map(block => (block as { type: string }).type), ["text"]);
  });
});
