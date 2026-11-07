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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  projectDispatchCard,
  type SpawnToolCallRecord,
} from "../src/client/dispatch-card.js";
import { DispatchCardView } from "../src/client/dispatch-card-view.js";
import { localeDictionary } from "../src/client/overlay.js";

const t = (key: string): string => localeDictionary.en[key] ?? key;

/** Render the card to static markup (no DOM harness). */
function renderCard(card: Parameters<typeof DispatchCardView>[0]["card"]): string {
  return renderToStaticMarkup(createElement(DispatchCardView, { t, card }));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function visibleText(markup: string): string {
  return decodeEntities(
    markup
      .replace(/<style>[\s\S]*?<\/style>/g, "")
      .replace(/<details\b[\s\S]*?<\/details>/g, "")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function detailsText(markup: string): string {
  return decodeEntities(
    (markup.match(/<details\b[\s\S]*?<\/details>/g) ?? [])
      .join(" ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

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

describe("worker-dispatch card — readable status display", () => {
  it("leads with Started \"title\"; ids and the stream live in Details", () => {
    const card = projectDispatchCard({
      callId: "call-9",
      args: { stream_key: "todo-7", title: "Summarize RFCs" },
      result: {
        ok: true,
        worker_id: "063f41a2-9897-4936-95de-1cd3f2f76132",
        stream_key: "todo-7",
        title: "Summarize RFCs",
      },
    });
    assert.ok(card);
    const markup = renderCard(card);
    const visible = visibleText(markup);
    assert.equal(visible, 'Started "Summarize RFCs"');
    // The tool-call id is never the title.
    assert.equal(visible.includes("call-9"), false);
    // The FULL worker id, stream key and call id are details-only.
    assert.equal(visible.includes("063f41a2-9897"), false);
    assert.equal(visible.includes("todo-7"), false);
    const details = detailsText(markup);
    assert.ok(details.includes("063f41a2-9897-4936-95de-1cd3f2f76132"));
    assert.ok(details.includes("todo-7"));
    assert.ok(details.includes("call-9"));
    // The ungated gate row is gone.
    assert.equal(visible.includes("ungated"), false);
    assert.equal(visible.includes("Gate"), false);
    // The record contract still rides the data attribute.
    assert.match(markup, /data-gating="ungated"/);
  });

  it("leads a refusal with Couldn't start and a human cause", () => {
    const card = projectDispatchCard({
      callId: "call-2",
      args: { stream_key: "k", title: "Own the migration" },
      result: { ok: false, reason: "duplicate-stream-key", detail: "d" },
    });
    assert.ok(card);
    const visible = visibleText(renderCard(card));
    assert.equal(
      visible,
      'Couldn\'t start "Own the migration" — that stream key is already in use',
    );
    assert.equal(visible.includes("duplicate-stream-key"), false);
    assert.equal(visible.includes("outcome"), false);
  });

  it("names the worker generically when no title exists, never the call id", () => {
    const card = projectDispatchCard({
      callId: "call-3",
      args: {},
      result: {
        ok: true,
        worker_id: "063f41a2-9897-4936-95de-1cd3f2f76132",
      },
    });
    assert.ok(card);
    const visible = visibleText(renderCard(card));
    assert.equal(visible, "Started worker …6132");
    assert.equal(visible.includes("call-3"), false);
  });
});
