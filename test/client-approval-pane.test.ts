/**
 * Ticket 81 — approval cards in the wrapper: the conversation reduction's
 * worker-dispatch attachment (presentation-time, replay-safe), the card
 * copy helpers (shared roster vocabulary, verbatim decision provenance),
 * the pane's approvals seat, and the CSS/copy contracts (token-only, en+zh).
 *
 * Offline only (S8): fakes stand in for the host; component rendering stays
 * covered by build + typecheck (the factories are smoke-pinned, never
 * rendered). The live resolve transport is ticket 69's L1 lane — its
 * honest no-seat copy is asserted here at the pure-helper level.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  reduceConversationWindow,
  type ConversationEntryLike,
} from "../src/client/conversation-store.js";
import {
  ACCESS_PROMPT_ALLOW,
  ACCESS_PROMPT_ALWAYS_ALLOW,
  ACCESS_PROMPT_DENY,
  APPROVAL_LOCATION_LOCAL,
} from "../src/adapter/index.js";
import {
  APPROVAL_CARD_CLASS,
  APPROVAL_CARD_CSS,
  APPROVAL_CARD_KEYS,
  accessAskCardTitle,
  createApprovalCardsSection,
  decisionDetailText,
  decisionStatusLabel,
} from "../src/client/approval-pane.js";
import { createApprovalCardsStore } from "../src/client/approval-cards.js";
import {
  createConversationPane,
  CONVERSATION_CSS,
} from "../src/client/conversation.js";
import { createConversationStore } from "../src/client/conversation-store.js";
import {
  localeDictionary,
  validateLocaleDictionary,
} from "../src/client/overlay.js";
import { formatTemplate } from "../src/client/roster-store.js";

// ── Fixtures (session/event-shaped payloads, Finding 7 vocabulary)

let nextSeq = 500;
function event(type: string, data: unknown): ConversationEntryLike {
  return {
    type: "event",
    event: { type, seq: nextSeq++, time: 0, data },
  };
}

function spawnCall(callId: string, args: unknown): ConversationEntryLike {
  return event("tool/call", {
    callId,
    name: "spawn_worker",
    arguments: JSON.stringify(args),
  });
}

function toolResult(callId: string, payload: unknown): ConversationEntryLike {
  return event("tool/result", {
    message: {
      role: "tool",
      source: { kind: "tool", callId },
      content: [
        {
          type: "tool-result",
          isError: false,
          content: [{ type: "text", text: JSON.stringify(payload) }],
        },
      ],
    },
  });
}

describe("ticket 81 — worker-dispatch cards ride the conversation reduction", () => {
  it("a settled spawn record carries the frozen dispatch card", () => {
    const window = {
      entries: [
        spawnCall("c-1", { stream_key: "todo-7", title: "Summarize RFCs" }),
        toolResult("c-1", {
          ok: true,
          worker_id: "w-9",
          stream_key: "todo-7",
          title: "Summarize RFCs",
          ack: "Started ...",
        }),
      ],
    };
    const transcript = reduceConversationWindow(window);
    assert.ok(transcript);
    const item = transcript.items.find((row) => row.kind === "tool");
    assert.ok(item && item.kind === "tool");
    assert.deepEqual(item.dispatch, {
      cardKind: "worker-dispatch",
      toolCallId: "c-1",
      streamKey: "todo-7",
      title: "Summarize RFCs",
      outcome: { kind: "spawned", workerId: "w-9" },
      gating: "ungated",
    });
  });

  it("replay-safe: re-reducing the same window yields the identical card", () => {
    const window = {
      entries: [
        spawnCall("c-1", { stream_key: "s", title: "T" }),
        toolResult("c-1", {
          ok: false,
          reason: "auto-review-refused",
          detail: "refused",
        }),
      ],
    };
    const first = reduceConversationWindow(window);
    const second = reduceConversationWindow(window);
    assert.deepEqual(
      first?.items.map((item) => (item.kind === "tool" ? item.dispatch : null)),
      second?.items.map((item) => (item.kind === "tool" ? item.dispatch : null)),
    );
    const item = first?.items.find((row) => row.kind === "tool");
    assert.equal(item?.kind === "tool" && item.dispatch?.gating, "approval-refused");
  });

  it("non-spawn tools and unsettled calls carry no dispatch card", () => {
    const window = {
      entries: [
        event("tool/call", {
          callId: "c-2",
          name: "check_workers",
          arguments: JSON.stringify({}),
        }),
        spawnCall("c-3", { title: "unsettled" }),
      ],
    };
    const transcript = reduceConversationWindow(window);
    assert.ok(transcript);
    for (const item of transcript.items) {
      assert.ok(item.kind !== "tool" || item.dispatch === null);
    }
  });
});

describe("ticket 81 — card copy helpers (shared vocabulary, verbatim truth)", () => {
  const t = (key: string): string =>
    (localeDictionary.en as Record<string, string>)[key] ?? key;

  it("the card title reuses the roster blocked vocabulary per class", () => {
    const store = createApprovalCardsStore();
    store.applyRelayTruth(
      [
        {
          workerId: "w-1",
          requestId: "req-1",
          body: {
            class: "tool",
            target: "write_file",
            reason: "needs to write outside the workspace",
          },
          createdAtMs: 1,
          parentSessionId: "s-1",
          status: "pending",
        },
      ],
      [],
    );
    const state = store.getBox().state;
    assert.equal(state.kind, "ready");
    const card = state.cards[0];
    assert.ok(card);
    assert.equal(
      accessAskCardTitle(t, card),
      formatTemplate(t("roster.blocked.tool"), { target: "write_file" }),
    );
    assert.ok(accessAskCardTitle(t, card).includes("write_file"));
  });

  it("decision provenance renders verbatim: policy-denied keeps the self-naming detail", () => {
    const store = createApprovalCardsStore();
    store.applyRelayTruth([], [
      {
        kind: "access-resolved",
        workerId: "w-1",
        title: "w-1",
        decision: {
          kind: "deny",
          reason: "policy-denied",
          detail: 'auto-review posture denied tool "write_file"',
        },
        body: {
          class: "tool",
          target: "write_file",
          reason: "needs to write outside the workspace",
        },
      },
    ]);
    const state = store.getBox().state;
    assert.equal(state.kind, "ready");
    const card = state.cards[0];
    assert.ok(card);
    assert.equal(decisionStatusLabel(card), "policy-denied");
    assert.equal(
      decisionDetailText(card),
      'auto-review posture denied tool "write_file"',
    );
  });

  it("pending cards carry ticket 30's option set as data", () => {
    const store = createApprovalCardsStore();
    store.applyRelayTruth(
      [
        {
          workerId: "w-1",
          requestId: "req-1",
          body: { class: "network", target: "example.com", reason: "" },
          createdAtMs: 1,
          parentSessionId: "s-1",
          status: "pending",
        },
      ],
      [],
    );
    const state = store.getBox().state;
    assert.equal(state.kind, "ready");
    assert.deepEqual(
      state.cards[0]?.optionSet.map((option) => option.label),
      [ACCESS_PROMPT_ALLOW, ACCESS_PROMPT_ALWAYS_ALLOW, ACCESS_PROMPT_DENY],
    );
    assert.equal(state.cards[0]?.locationLine, APPROVAL_LOCATION_LOCAL);
    assert.equal(decisionStatusLabel(state.cards[0]!), null);
  });
});

describe("ticket 81 — pane seat, CSS and copy contracts", () => {
  it("the approval CSS is token-only: no hex, no animation, namespaced classes", () => {
    assert.doesNotMatch(APPROVAL_CARD_CSS, /#[0-9a-fA-F]{3,8}\b/, "hex literal");
    assert.doesNotMatch(APPROVAL_CARD_CSS, /@keyframes|animation\s*:/);
    // Every top-level class selector carries our namespaced prefix.
    const selectors = [...APPROVAL_CARD_CSS.matchAll(/^\.([a-z-]+)/gm)].map(
      (match) => match[1],
    );
    assert.ok(selectors.length > 0);
    for (const selector of selectors) {
      assert.equal(selector, APPROVAL_CARD_CLASS, selector);
    }
    void CONVERSATION_CSS;
  });

  it("every new chrome key exists in BOTH locale faces (en + zh)", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    for (const key of Object.values(APPROVAL_CARD_KEYS)) {
      assert.ok(key in localeDictionary.en, `en missing ${key}`);
      assert.ok(key in localeDictionary.zh, `zh missing ${key}`);
      assert.ok(localeDictionary.en[key]!.length > 0);
      assert.ok(localeDictionary.zh[key]!.length > 0);
    }
  });

  it("the section factory binds unfed and empty-ready stores (no render offline; hooks need React)", () => {
    const t = (key: string): string => key;
    const unfed = createApprovalCardsSection(t, {
      cards: createApprovalCardsStore(),
    });
    assert.equal(typeof unfed, "function");
    const empty = createApprovalCardsStore();
    empty.applyRelayTruth([], []);
    const section = createApprovalCardsSection(t, { cards: empty });
    assert.equal(typeof section, "function");
  });

  it("the pane factory accepts the approvals seat (smoke; rendering is build + typecheck)", () => {
    const t = (key: string): string => key;
    const pane = createConversationPane(
      t,
      createConversationStore(),
      { onSend: async () => ({ kind: "no-channel" }), onLoadOlder: () => {} },
      { cards: createApprovalCardsStore() },
    );
    assert.equal(typeof pane, "function");
    const paneWithout = createConversationPane(
      t,
      createConversationStore(),
      { onSend: async () => ({ kind: "no-channel" }), onLoadOlder: () => {} },
    );
    assert.equal(typeof paneWithout, "function");
  });
});
