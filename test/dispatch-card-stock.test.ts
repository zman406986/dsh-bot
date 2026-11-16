/**
 * Lane UI1: the worker-dispatch card after the stock-subagent swap.
 *
 * The stock `subagent` tool replaced the retired `spawn_worker` command, but
 * the card is a PROJECTION over durable tool-call records, not a replacement
 * toolview (the host renders the stock row itself). These pins keep the new
 * wire shape and the historical one honest.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  projectDispatchCard,
  SUBAGENT_TOOL,
  type SpawnToolCallRecord,
} from "../src/client/dispatch-card.js";
import { reduceConversationWindow } from "../src/client/conversation-store.js";
import { SPAWN_WORKER_TOOL } from "../src/core/policy/prompts.js";

const STOCK_CALL_ID = "call-stock-1";
const STOCK_DESCRIPTION = "Audit the widget";
const STOCK_PROMPT = "Read every widget and report the odd ones.";
const STOCK_MODEL = "provider/model-x";
const STOCK_WORKER_ID = "sub-9";

const stockRecord: SpawnToolCallRecord = {
  toolName: SUBAGENT_TOOL,
  callId: STOCK_CALL_ID,
  args: {
    description: STOCK_DESCRIPTION,
    prompt: STOCK_PROMPT,
    model: STOCK_MODEL,
  },
  result: { kind: "activation", subagentId: STOCK_WORKER_ID },
};

describe("dispatch card — stock subagent records", () => {
  it("maps description to title, prompt to task, and subagentId to the worker", () => {
    assert.deepEqual(projectDispatchCard(stockRecord), {
      cardKind: "worker-dispatch",
      toolCallId: STOCK_CALL_ID,
      streamKey: null,
      title: STOCK_DESCRIPTION,
      task: STOCK_PROMPT,
      model: STOCK_MODEL,
      outcome: { kind: "spawned", workerId: STOCK_WORKER_ID },
      gating: "ungated",
    });
  });

  it("accepts the bare {subagentId} result and renders no card for malformed ones", () => {
    assert.deepEqual(
      projectDispatchCard({
        ...stockRecord,
        args: { description: STOCK_DESCRIPTION, prompt: STOCK_PROMPT },
        result: { subagentId: STOCK_WORKER_ID },
      }),
      {
        cardKind: "worker-dispatch",
        toolCallId: STOCK_CALL_ID,
        streamKey: null,
        title: STOCK_DESCRIPTION,
        task: STOCK_PROMPT,
        model: null,
        outcome: { kind: "spawned", workerId: STOCK_WORKER_ID },
        gating: "ungated",
      },
    );
    // Success only when the result parses; otherwise no card, never a broken
    // one (the host's stock row still covers the call).
    assert.equal(
      projectDispatchCard({
        ...stockRecord,
        result: { kind: "activation" },
      }),
      null,
    );
    assert.equal(
      projectDispatchCard({ ...stockRecord, result: { subagentId: "" } }),
      null,
    );
    assert.equal(
      projectDispatchCard({ ...stockRecord, result: { kind: "other", subagentId: "x" } }),
      null,
    );
    assert.equal(
      projectDispatchCard({ ...stockRecord, result: "not-a-record" }),
      null,
    );
  });

  it("wires a stock call+result through the conversation reduction", () => {
    const transcript = reduceConversationWindow({
      entries: [
        {
          type: "event",
          event: {
            type: "tool/call",
            seq: 1,
            time: 0,
            data: {
              callId: STOCK_CALL_ID,
              name: SUBAGENT_TOOL,
              arguments: JSON.stringify(stockRecord.args),
            },
          },
        },
        {
          type: "event",
          event: {
            type: "tool/result",
            seq: 2,
            time: 0,
            data: {
              meta: stockRecord.result,
              message: {
                source: { callId: STOCK_CALL_ID },
                content: [],
              },
            },
          },
        },
      ],
    });
    assert.ok(transcript !== null);
    const item = transcript.items[0];
    if (item === undefined || item.kind !== "tool") {
      assert.fail("the stock call+result must reduce to one tool item");
    }
    assert.equal(item.dispatch?.title, STOCK_DESCRIPTION);
    assert.equal(item.dispatch?.task, STOCK_PROMPT);
    assert.deepEqual(item.dispatch?.outcome, {
      kind: "spawned",
      workerId: STOCK_WORKER_ID,
    });
  });
});

describe("dispatch card — historical spawn_worker records", () => {
  const legacy: SpawnToolCallRecord = {
    toolName: SPAWN_WORKER_TOOL,
    callId: "call-old-1",
    args: { stream_key: "todo-7", title: "Summarize RFCs", prompt: "..." },
    result: {
      ok: true,
      worker_id: "w-9",
      stream_key: "todo-7",
      title: "Summarize RFCs",
    },
  };

  it("keeps the frozen spawn and refusal mapping, adding no stock fields", () => {
    assert.deepEqual(projectDispatchCard(legacy), {
      cardKind: "worker-dispatch",
      toolCallId: "call-old-1",
      streamKey: "todo-7",
      title: "Summarize RFCs",
      outcome: { kind: "spawned", workerId: "w-9" },
      gating: "ungated",
    });
    assert.deepEqual(
      projectDispatchCard({
        ...legacy,
        callId: "call-old-2",
        args: { stream_key: "k", title: "T" },
        result: { ok: false, reason: "duplicate-stream-key", detail: "d" },
      }),
      {
        cardKind: "worker-dispatch",
        toolCallId: "call-old-2",
        streamKey: "k",
        title: "T",
        outcome: { kind: "refused", reason: "duplicate-stream-key" },
        gating: "ungated",
      },
    );
  });
});
