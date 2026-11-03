/**
 * Ticket 69 §3.2 — the worker-dispatch card projection, frozen as ticket 81's
 * rendering contract. Offline only (S8): a pure function over spawn tool-call
 * records; the component rendering itself stays covered by build + typecheck.
 *
 * This file was `approval-cards.test.ts` and covered two families. Ticket 174
 * / ADR-0033 removed the access-ask family (and its projection module) with
 * the worker access-ask feature; the dispatch card has no dependency on it and
 * keeps its pins here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  projectDispatchCard,
  type SpawnToolCallRecord,
} from "../src/client/dispatch-card.js";

describe("worker-dispatch card projection (frozen §3.2, replay-safe)", () => {
  const spawned: SpawnToolCallRecord = {
    callId: "call-1",
    args: {
      stream_key: "todo-7",
      title: "Summarize RFCs",
      prompt: "...",
    },
    result: {
      ok: true,
      worker_id: "w-9",
      stream_key: "todo-7",
      title: "Summarize RFCs",
      ack: "Started ...",
    },
  };

  it("projects a settled spawn into the frozen card", () => {
    assert.deepEqual(projectDispatchCard(spawned), {
      cardKind: "worker-dispatch",
      toolCallId: "call-1",
      streamKey: "todo-7",
      title: "Summarize RFCs",
      outcome: { kind: "spawned", workerId: "w-9" },
      // Ticket 174 / ADR-0033: the review-posture gate is gone, so every
      // record projects the ungated value.
      gating: "ungated",
    });
  });

  it("replay-safe: the same record projects the identical card, every time", () => {
    assert.deepEqual(projectDispatchCard(spawned), projectDispatchCard(spawned));
    assert.deepEqual(projectDispatchCard(spawned), projectDispatchCard(spawned));
  });

  it("projects a refused spawn and its reason", () => {
    assert.deepEqual(
      projectDispatchCard({
        callId: "call-2",
        args: { stream_key: "k", title: "T" },
        result: { ok: false, reason: "duplicate-stream-key", detail: "d" },
      }),
      {
        cardKind: "worker-dispatch",
        toolCallId: "call-2",
        streamKey: "k",
        title: "T",
        outcome: { kind: "refused", reason: "duplicate-stream-key" },
        gating: "ungated",
      },
    );
  });

  it("renders no card for an unsettled call or an unreadable result", () => {
    assert.equal(
      projectDispatchCard({ callId: "c", args: {}, result: null }),
      null,
    );
    assert.equal(
      projectDispatchCard({ callId: "c", args: {}, result: { ok: "maybe" } }),
      null,
    );
    assert.equal(
      projectDispatchCard({
        callId: "c",
        args: {},
        result: { ok: true, worker_id: "" },
      }),
      null,
    );
  });
});
