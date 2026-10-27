/**
 * Ticket 80 — wrapper conversation surface (ADR-0020 slice 4): the
 * turn-model reduction from the session event window to a text-only
 * transcript, the conversation store's honest states, the selection-driven
 * window binding, the scoped pagination request, and the pane's CSS/copy
 * contracts.
 *
 * Offline only (S8): the seam shapes mirror the verified host faces
 * (`wrapper-vehicle-seams.md` Finding 7 — `sessions.binding(id).eventSource`,
 * `SessionEventWindow`, scoped `IConversation.loadOlder`); fakes stand in
 * for the host. Component rendering stays covered by build + typecheck (the
 * pane factory is smoke-pinned, never rendered). Live streaming behavior
 * waits for the live lane and is deliberately not claimed here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createConversationStore,
  reduceConversationWindow,
  type ConversationEntryLike,
  type ConversationWindowLike,
} from "../src/client/conversation-store.js";
import {
  bindConversationFeed,
  requestOlder,
} from "../src/client/conversation-feed.js";
import { bindCommandTransport } from "../src/client/actions.js";
import {
  CONVERSATION_CSS,
  CONVERSATION_CLASS,
  CONVERSATION_KEYS,
  createConversationPane,
  describeComposer,
  sendOutcomeCopyKey,
  type ConversationActions,
} from "../src/client/conversation.js";
import { PEER_WAKE_SECTION_HEADINGS } from "../src/core/policy/prompts.js";
import { createDispatcherShellStore } from "../src/client/shell-store.js";
import type { ClientSessionsLike } from "../src/client/context.js";
import {
  LOCALE_NAMESPACE,
  localeDictionary,
  validateLocaleDictionary,
} from "../src/client/overlay.js";

// ── Fixture builders (session/event-shaped payloads, Finding 7 vocabulary)

let nextSeq = 100;
function event(
  type: string,
  data: unknown,
  overrides: Partial<{ seq: number }> = {},
): ConversationEntryLike {
  return {
    type: "event",
    event: { type, seq: overrides.seq ?? nextSeq++, time: 0, data },
  };
}

function userMessage(text: string, kind = "user"): ConversationEntryLike {
  return event("user/message", {
    id: `m-${nextSeq}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind },
  });
}

function assistantMessage(
  text: string,
  overrides: Partial<{ interrupted: boolean }> = {},
): ConversationEntryLike {
  return event("assistant/message", {
    turn: 1,
    step: 1,
    message: {
      id: `a-${nextSeq}`,
      role: "assistant",
      content: [{ type: "text", text }],
      source: { kind: "model", provider: "p", model: "m" },
    },
    stream: [],
    interrupted: overrides.interrupted === true ? true : undefined,
  });
}

function toolCall(
  callId: string,
  name: string,
  args: unknown,
): ConversationEntryLike {
  return event("tool/call", {
    turn: 1,
    step: 1,
    callId,
    name,
    arguments: JSON.stringify(args),
  });
}

function toolResult(
  callId: string,
  resultText: string,
  isError = false,
): ConversationEntryLike {
  return event("tool/result", {
    turn: 1,
    step: 1,
    message: {
      id: `r-${nextSeq}`,
      role: "user",
      content: [
        { type: "tool-result", toolCallId: callId, isError, content: [{ type: "text", text: resultText }] },
      ],
      source: { kind: "tool", callId },
    },
  });
}

function chunk(
  attemptId: string,
  text: string,
): ConversationEntryLike {
  return {
    type: "transient",
    event: {
      type: "assistant/live-chunk",
      seq: nextSeq++,
      time: 0,
      data: {
        attemptId,
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", index: 0, text },
      },
    },
  };
}

// ── Reduction

describe("conversation reduction — replay turns (ticket 80)", () => {
  it("reduces user + assistant turns from the window, in order", () => {
    const transcript = reduceConversationWindow({
      entries: [
        userMessage("spawn a worker for the report"),
        assistantMessage("Spawned; I will report when it lands."),
      ],
    });
    assert.ok(transcript, "reducible window");
    assert.deepEqual(
      transcript.items.map((item) => [item.kind, "text" in item ? item.text : ""]),
      [
        ["user", "spawn a worker for the report"],
        ["assistant", "Spawned; I will report when it lands."],
      ],
    );
    assert.equal(transcript.hasMore, false);
    assert.equal(transcript.running, false);
  });

  it("joins multiple text blocks and keeps the interrupted marker", () => {
    const transcript = reduceConversationWindow({
      entries: [
        event("user/message", {
          role: "user",
          content: [
            { type: "text", text: "one " },
            { type: "text", text: "two" },
          ],
          source: { kind: "user" },
        }),
        assistantMessage("partial", { interrupted: true }),
      ],
    });
    assert.ok(transcript);
    assert.equal(transcript.items[0]?.kind, "user");
    assert.equal(
      transcript.items[0]?.kind === "user" ? transcript.items[0].text : "",
      "one two",
    );
    const assistant = transcript.items[1];
    assert.equal(assistant?.kind, "assistant");
    assert.equal(
      assistant?.kind === "assistant" ? assistant.interrupted : null,
      true,
    );
  });

  it("skips non-user user-role sources (synthetic context is not the user's speech)", () => {
    const transcript = reduceConversationWindow({
      entries: [
        userMessage("injected context", "plugin"),
        userMessage("goal round", "model"),
        userMessage("the real prompt"),
      ],
    });
    assert.ok(transcript);
    assert.deepEqual(
      transcript.items.map((item) => (item.kind === "user" ? item.text : "?")),
      ["the real prompt"],
    );
  });

  it("never presents an injected peer wake turn as the user's speech (ticket 70 chunk 3)", () => {
    // The peer wake is a HIDDEN dispatcher turn: the host injects its
    // other-assistant cue + body as model-facing context in a non-user
    // user-role message. The reduction must skip it wholesale — the
    // machinery copy never renders as chat, and it never reads as the
    // user speaking (the tier's one presentation rule).
    const peerCue = `${PEER_WAKE_SECTION_HEADINGS[0]}

This turn was opened by the peer inbox.`;
    const transcript = reduceConversationWindow({
      entries: [
        userMessage("what should I change?"),
        userMessage(peerCue, "plugin"),
        event("assistant/message", {
          turn: 1,
          step: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I can look into it." }],
            source: { kind: "model", provider: "p", model: "m" },
          },
        }),
      ],
    });
    assert.ok(transcript);
    const userTexts = transcript.items
      .filter((item) => item.kind === "user")
      .map((item) => (item.kind === "user" ? item.text : ""));
    assert.deepEqual(userTexts, ["what should I change?"]);
    // The cue text appears NOWHERE in the reduced transcript.
    const rendered = JSON.stringify(transcript.items);
    assert.equal(rendered.includes("Peer message"), false);
    assert.equal(rendered.includes("peer inbox"), false);
    // Peer traffic, if ever shown, is a tool row (historical send_peer rows
    // and, since ticket 152, message_agent rows each get their own row) —
    // never a fabricated user/assistant bubble.
  });

  it("omits text-less assistant messages (tool-call-only steps) instead of empty bubbles", () => {
    const transcript = reduceConversationWindow({
      entries: [
        event("assistant/message", {
          turn: 1,
          step: 1,
          message: {
            role: "assistant",
            content: [],
            source: { kind: "model", provider: "p", model: "m" },
          },
        }),
      ],
    });
    assert.ok(transcript);
    assert.deepEqual(transcript.items, []);
  });

  it("skips the log/derived-only vocabulary (U-C: no timeline cards)", () => {
    const transcript = reduceConversationWindow({
      entries: [
        event("turn/start", { turn: 1 }),
        event("system/message", { turn: 1, step: 1, message: {} }),
        event("request/header", { header: {}, reason: "initial" }),
        event("assistant/attempt", { turn: 1, step: 1, stream: [] }),
        event("session/end-seed", {}),
        event("totally/unknown", {}),
        assistantMessage("visible"),
        event("turn/end", { turn: 1, reason: { kind: "completed" } }),
      ],
    });
    assert.ok(transcript);
    assert.deepEqual(
      transcript.items.map((item) => item.kind),
      ["assistant"],
    );
  });

  it("an unreadable window (entries not an array) reduces to null", () => {
    assert.equal(reduceConversationWindow({}), null);
    assert.equal(reduceConversationWindow({ entries: undefined }), null);
    assert.equal(
      reduceConversationWindow({ entries: "junk" as never }),
      null,
    );
  });

  it("junk envelopes are skipped, never normalized into turns", () => {
    const transcript = reduceConversationWindow({
      entries: [
        { type: "event", event: { type: "user/message" } as never },
        { type: "event", event: null as never },
        { type: "event", event: { type: "user/message", seq: "x", data: {} } as never },
        userMessage("fine"),
      ],
    });
    assert.ok(transcript);
    assert.equal(transcript.items.length, 1);
  });

  it("hasMore passes through; absent means false", () => {
    assert.equal(
      reduceConversationWindow({
        entries: [],
        hasMore: true,
      })?.hasMore,
      true,
    );
    assert.equal(
      reduceConversationWindow({ entries: [], hasMore: false })?.hasMore,
      false,
    );
    assert.equal(reduceConversationWindow({ entries: [] })?.hasMore, false);
  });
});

describe("conversation reduction — tool rows (ticket 24 re-host)", () => {
  it("pairs tool/call with tool/result by callId and re-hosts the ticket-24 view model", () => {
    const transcript = reduceConversationWindow({
      entries: [
        toolCall("c-1", "spawn_worker", { title: "Report", todo_id: "t-1" }),
        toolResult("c-1", JSON.stringify({ ok: true, worker_id: "w-9" })),
      ],
    });
    assert.ok(transcript);
    const item = transcript.items[0];
    assert.equal(item?.kind, "tool");
    if (item?.kind !== "tool") return;
    assert.equal(item.callId, "c-1");
    assert.equal(item.toolName, "spawn_worker");
    assert.equal(item.settled, true);
    assert.equal(item.failed, false);
    assert.equal(item.view.kind, "detail");
    if (item.view.kind !== "detail") return;
    assert.deepEqual(
      item.view.fields.map((field) => [field.labelKey, field.value]),
      [
        ["toolview.field.worker", "w-9"],
        ["toolview.field.title", "Report"],
        ["toolview.field.todo", "t-1"],
        ["toolview.field.outcome", "ok"],
      ],
    );
  });

  it("a call without its result renders as an unsettled (running) row", () => {
    const transcript = reduceConversationWindow({
      entries: [toolCall("c-1", "check_workers", {})],
    });
    assert.ok(transcript);
    const item = transcript.items[0];
    assert.equal(item?.kind, "tool");
    assert.equal(item?.kind === "tool" ? item.settled : null, false);
    assert.equal(item?.kind === "tool" ? item.view.kind : null, "degraded");
  });

  it("an error result marks the row failed", () => {
    const transcript = reduceConversationWindow({
      entries: [
        toolCall("c-1", "stop_worker", { worker_id: "w-1" }),
        toolResult("c-1", JSON.stringify({ ok: false, reason: "gone" }), true),
      ],
    });
    const item = transcript?.items[0];
    assert.equal(item?.kind === "tool" ? item.failed : null, true);
    const view = item?.kind === "tool" ? item.view : null;
    assert.equal(view?.kind, "detail");
    assert.ok(
      view?.kind === "detail"
        ? view.fields.some((f) => f.value === "gone")
        : false,
    );
  });

  it("an unparsable result degrades to the safe row — never a fabricated field", () => {
    const transcript = reduceConversationWindow({
      entries: [
        toolCall("c-1", "spawn_worker", {}),
        toolResult("c-1", "plain prose, not JSON"),
      ],
    });
    const item = transcript?.items[0];
    assert.equal(item?.kind === "tool" ? item.view.kind : null, "degraded");
  });

  it("pairs via the first block's toolCallId when the source lacks callId", () => {
    const transcript = reduceConversationWindow({
      entries: [
        toolCall("c-2", "steer_worker", { worker_id: "w-1" }),
        event("tool/result", {
          turn: 1,
          step: 1,
          message: {
            id: "r-x",
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: "c-2",
                isError: false,
                content: [
                  { type: "text", text: JSON.stringify({ ok: true }) },
                ],
              },
            ],
          },
        }),
      ],
    });
    const item = transcript?.items[0];
    assert.equal(item?.kind === "tool" ? item.settled : null, true);
  });

  it("foreign tools degrade (ticket 24 claimed only the five dispatcher tools)", () => {
    const transcript = reduceConversationWindow({
      entries: [
        toolCall("c-1", "read_file", { path: "x" }),
        toolResult("c-1", JSON.stringify({ ok: true })),
      ],
    });
    const item = transcript?.items[0];
    assert.equal(item?.kind === "tool" ? item.toolName : null, "read_file");
    assert.equal(item?.kind === "tool" ? item.view.kind : null, "degraded");
  });
});

/**
 * Ticket 81 (live pass 5, Session B-2 FINDING 2) — the durable record as the
 * LIVE HOST shapes it, not as the earlier offline fixtures assumed. Host
 * facts (dsh-agent-loop/lib/index.js:697-712 `appendToolResult`,
 * dsh-llm/lib/index.js:94 `createToolResultMessage`, dsh-tools
 * lib/index.js:3428 `createSuccessResult`): the `tool/result` event data
 * carries `message` (source.callId + ONE `tool-result` block whose content
 * is the tool's RENDERED text — for `spawn_worker` that is the ack prose,
 * never JSON) and `meta` ONLY when the tool defines
 * `output.presentationMeta`. The structured `value` is never serialized.
 */
function hostToolResult(
  callId: string,
  renderedText: string,
  meta: unknown,
): ConversationEntryLike {
  return event("tool/result", {
    turn: 1,
    step: 1,
    message: {
      id: `r-${nextSeq}`,
      role: "user",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          isError: false,
          content: [{ type: "text", text: renderedText }],
        },
      ],
      source: { kind: "tool", callId },
    },
    ...(meta !== undefined ? { meta } : {}),
  });
}

describe("conversation reduction — dispatch card over the LIVE durable record (ticket 81 FINDING 2)", () => {
  const ACK =
    "Started \"Report\" in the background (worker w-9, stream s-1).";

  it("with presentationMeta, a settled spawn projects its worker-dispatch card", () => {
    const transcript = reduceConversationWindow({
      entries: [
        toolCall("c-1", "spawn_worker", {
          stream_key: "s-1",
          title: "Report",
          prompt: "Do the thing.",
        }),
        hostToolResult("c-1", ACK, {
          ok: true,
          worker_id: "w-9",
          stream_key: "s-1",
          title: "Report",
        }),
      ],
    });
    assert.ok(transcript);
    const item = transcript.items[0];
    assert.equal(item?.kind, "tool");
    if (item?.kind !== "tool") return;
    // The tool row still renders the parsed outcome beside the card.
    assert.equal(item.view.kind, "detail");
    assert.equal(item.dispatch?.cardKind, "worker-dispatch");
    assert.equal(item.dispatch?.outcome.kind, "spawned");
    assert.equal(item.dispatch?.outcome.kind === "spawned"
      ? item.dispatch.outcome.workerId
      : null, "w-9");
    assert.equal(item.dispatch?.gating, "ungated");
    assert.equal(item.dispatch?.title, "Report");
    assert.equal(item.dispatch?.streamKey, "s-1");
    assert.equal(item.dispatch?.toolCallId, "c-1");
  });

  it("a posture-gated spawn carries gating: approval-allowed from the record's own marker", () => {
    const transcript = reduceConversationWindow({
      entries: [
        toolCall("c-1", "spawn_worker", { title: "Gated" }),
        hostToolResult("c-1", ACK, {
          ok: true,
          worker_id: "w-9",
          stream_key: "s-1",
          title: "Gated",
          gated: true,
        }),
      ],
    });
    const item = transcript?.items[0];
    assert.equal(
      item?.kind === "tool" ? item.dispatch?.gating : null,
      "approval-allowed",
    );
  });

  it("a refused spawn projects the refusal outcome from the meta record", () => {
    const transcript = reduceConversationWindow({
      entries: [
        toolCall("c-1", "spawn_worker", { title: "Refused" }),
        hostToolResult(
          "c-1",
          "Refused: auto-review-refused — unavailable",
          { ok: false, reason: "auto-review-refused", detail: "unavailable" },
        ),
      ],
    });
    const item = transcript?.items[0];
    assert.equal(item?.kind === "tool" ? item.settled : null, true);
    // A structured refusal is the tool's own RETURN value (isError false):
    // the refusal lives in the record (`ok:false` + reason), not in the
    // message's error flag.
    assert.equal(item?.kind === "tool" ? item.failed : null, false);
    assert.equal(item?.kind === "tool" ? item.dispatch?.outcome.kind : null, "refused");
    assert.equal(
      item?.kind === "tool" && item.dispatch?.outcome.kind === "refused"
        ? item.dispatch.outcome.reason
        : null,
      "auto-review-refused",
    );
    assert.equal(
      item?.kind === "tool" ? item.dispatch?.gating : null,
      "approval-refused",
    );
  });

  it("REGRESSION PIN (the B-2 live shape: rendered ack only, no meta) degrades honestly — no card, no fabricated fields", () => {
    // This is EXACTLY what Session B-2's two settled spawns produced: the
    // pre-fix adapter shipped no presentationMeta, so the durable record
    // carried only the ack prose. The reducer must never fabricate a card or
    // fields from prose — and the fix is the adapter attaching meta, not a
    // client-side guess.
    const transcript = reduceConversationWindow({
      entries: [
        toolCall("c-1", "spawn_worker", {
          stream_key: "s-1",
          title: "Report",
          prompt: "Do the thing.",
        }),
        hostToolResult("c-1", ACK, undefined),
      ],
    });
    assert.ok(transcript);
    const item = transcript.items[0];
    assert.equal(item?.kind === "tool" ? item.settled : null, true);
    assert.equal(item?.kind === "tool" ? item.dispatch : null, null);
    // The row still shows the ARGS-derived fields (title/stream) but carries
    // no outcome and no worker id — nothing is invented from the prose ack.
    if (item?.kind === "tool" && item.view.kind === "detail") {
      const labels = item.view.fields.map((f) => f.labelKey);
      assert.ok(!labels.includes("toolview.field.worker"));
      assert.ok(!labels.includes("toolview.field.outcome"));
    }
  });
});

describe("conversation reduction — streaming + running (ticket 80)", () => {
  it("accumulates text deltas in place as ONE streaming item per attempt", () => {
    const window: ConversationWindowLike = {
      entries: [
        userMessage("go"),
        chunk("att-1", "Hel"),
        chunk("att-1", "lo"),
      ],
      hasMore: false,
    };
    const transcript = reduceConversationWindow(window);
    assert.ok(transcript);
    assert.deepEqual(
      transcript.items.map((item) => item.kind),
      ["user", "assistant-streaming"],
    );
    const stream = transcript.items[1];
    assert.equal(
      stream?.kind === "assistant-streaming" ? stream.text : "",
      "Hello",
    );
    assert.equal(
      stream?.kind === "assistant-streaming" ? stream.attemptId : "",
      "att-1",
    );
    assert.equal(transcript.running, true);
  });

  it("a non-text first chunk still opens the honest working row", () => {
    const transcript = reduceConversationWindow({
      entries: [
        {
          type: "transient",
          event: {
            type: "assistant/live-chunk",
            seq: 1,
            time: 0,
            data: {
              attemptId: "att-1",
              turn: 1,
              step: 1,
              chunk: { type: "block-start", index: 0, blockType: "text" },
            },
          },
        },
      ],
    });
    assert.ok(transcript);
    assert.equal(transcript.items.length, 1);
    assert.equal(transcript.items[0]?.kind, "assistant-streaming");
    assert.equal(transcript.running, true);
  });

  it("the durable settlement supersedes the transients (host replaces the rows)", () => {
    // While streaming: the window carries transient rows → one streaming item.
    const streaming = reduceConversationWindow({
      entries: [userMessage("go"), chunk("att-1", "Hel")],
    });
    assert.deepEqual(
      streaming?.items.map((item) => item.kind),
      ["user", "assistant-streaming"],
    );
    // Post-settle: the host REPLACED the attempt's transient rows with the
    // durable assistant/message; the same reduction recomputed over the new
    // window shows the settled turn — nothing to clean up client-side.
    const settled = reduceConversationWindow({
      entries: [userMessage("go"), assistantMessage("Hello, settled.")],
    });
    assert.deepEqual(
      settled?.items.map((item) => item.kind),
      ["user", "assistant"],
    );
    assert.equal(settled?.running, false);
  });

  it("running derives from an open turn/start even without streaming rows", () => {
    const open = reduceConversationWindow({
      entries: [event("turn/start", { turn: 3 })],
    });
    assert.equal(open?.running, true);
    const closed = reduceConversationWindow({
      entries: [
        event("turn/start", { turn: 3 }),
        event("turn/end", { turn: 3, reason: { kind: "completed" } }),
      ],
    });
    assert.equal(closed?.running, false);
  });
});

// ── Store

describe("conversation store — honest states (ticket 80)", () => {
  it("waiting before any window, ready after a reducible one", () => {
    const store = createConversationStore();
    assert.deepEqual(store.stateFor("s-1"), { kind: "waiting" });
    store.applyWindow("s-1", { entries: [userMessage("hi")] });
    const state = store.stateFor("s-1");
    assert.equal(state.kind, "ready");
    assert.equal(
      state.kind === "ready" ? state.transcript.items.length : -1,
      1,
    );
  });

  it("an unreadable window is unavailable — empty and unreadable are different facts", () => {
    const store = createConversationStore();
    store.applyWindow("s-1", { entries: "junk" as never });
    assert.deepEqual(store.stateFor("s-1"), { kind: "unavailable" });
  });

  it("a well-formed EMPTY window is ready with zero items (not unavailable)", () => {
    const store = createConversationStore();
    store.applyWindow("s-1", { entries: [] });
    const state = store.stateFor("s-1");
    assert.equal(state.kind, "ready");
    assert.equal(
      state.kind === "ready" ? state.transcript.items.length : -1,
      0,
    );
  });

  it("markUnavailable degrades; per-session states are isolated; junk ids refused", () => {
    const store = createConversationStore();
    store.applyWindow("s-1", { entries: [userMessage("hi")] });
    store.applyWindow("s-2", { entries: [userMessage("other")] });
    store.markUnavailable("s-1");
    assert.deepEqual(store.stateFor("s-1"), { kind: "unavailable" });
    assert.equal(store.stateFor("s-2").kind, "ready");
    store.applyWindow("", { entries: [] });
    store.markUnavailable("");
    assert.deepEqual(store.stateFor(""), { kind: "waiting" });
  });

  it("emits only while subscribed; the count is exact", () => {
    const store = createConversationStore();
    let notifications = 0;
    const dispose = store.subscribe(() => {
      notifications += 1;
    });
    store.applyWindow("s-1", { entries: [] });
    store.applyWindow("s-1", { entries: [userMessage("hi")] });
    assert.equal(notifications, 2);
    dispose();
    store.applyWindow("s-1", { entries: [] });
    assert.equal(notifications, 2);
  });
});

// ── Feed binding

describe("conversation feed binding — selection-driven windows (ticket 80)", () => {
  function fakeSessions(sources: Map<string, ConversationWindowLike>) {
    const subscriptions: string[] = [];
    const unsubscriptions: string[] = [];
    const listeners = new Map<string, Set<() => void>>();
    const face: ClientSessionsLike = {
      list: {
        getSnapshot: () => ({ ids: [...sources.keys()] }),
        subscribe: () => () => {},
      },
      scope: () => undefined,
      binding(id) {
        if (!sources.has(id)) return undefined;
        return {
          eventSource: {
            getSnapshot: () => sources.get(id) ?? {},
            subscribe(listener: () => void) {
              subscriptions.push(id);
              let set = listeners.get(id);
              if (set === undefined) {
                set = new Set();
                listeners.set(id, set);
              }
              set.add(listener);
              return () => {
                unsubscriptions.push(id);
                set.delete(listener);
              };
            },
          },
        };
      },
    };
    return {
      face,
      subscriptions: () => subscriptions,
      unsubscriptions: () => unsubscriptions,
      /** The host publishes a new window snapshot for a session. */
      publish(id: string, window: ConversationWindowLike) {
        sources.set(id, window);
        for (const listener of listeners.get(id) ?? []) listener();
      },
    };
  }

  it("follows the shell selection: applies now, subscribes live, moves on change", () => {
    const sources = new Map<string, ConversationWindowLike>([
      ["s-1", { entries: [userMessage("one")] }],
      ["s-2", { entries: [userMessage("two")] }],
    ]);
    const fake = fakeSessions(sources);
    const shell = createDispatcherShellStore();
    shell.upsertSessions([
      { sessionId: "s-1", title: "One" },
      { sessionId: "s-2", title: "Two" },
    ]);
    const conversation = createConversationStore();
    const binding = bindConversationFeed(conversation, fake.face, shell);

    // No selection: nothing loaded.
    assert.equal(conversation.stateFor("s-1").kind, "waiting");

    shell.select("s-1");
    assert.equal(conversation.stateFor("s-1").kind, "ready");
    assert.deepEqual(fake.subscriptions(), ["s-1"]);

    // Live window publication lands in the store (the host pushes a new
    // snapshot; the binding re-applies through its sync closure).
    fake.publish("s-1", {
      entries: [userMessage("one"), assistantMessage("ok")],
    });
    const state = conversation.stateFor("s-1");
    assert.equal(
      state.kind === "ready" ? state.transcript.items.length : -1,
      2,
    );

    // Selection move: the previous window unsubscribes, the next applies.
    shell.select("s-2");
    assert.deepEqual(fake.subscriptions(), ["s-1", "s-2"]);
    assert.deepEqual(fake.unsubscriptions(), ["s-1"]);
    assert.equal(conversation.stateFor("s-2").kind, "ready");

    // Deselect (feed removal): nothing is subscribed.
    shell.removeSessions(["s-2"]);
    assert.deepEqual(fake.unsubscriptions(), ["s-1", "s-2"]);
    assert.equal(conversation.stateFor("s-2").kind, "ready"); // last state kept

    binding.dispose();
    assert.deepEqual(fake.unsubscriptions(), ["s-1", "s-2"]);
  });

  it("a session without a binding face degrades to unavailable — never an empty transcript", () => {
    const fake = fakeSessions(new Map()); // binding() is undefined for every id
    const shell = createDispatcherShellStore();
    shell.upsertSessions([{ sessionId: "s-x", title: "X" }]);
    const conversation = createConversationStore();
    const binding = bindConversationFeed(conversation, fake.face, shell);
    shell.select("s-x");
    assert.deepEqual(conversation.stateFor("s-x"), { kind: "unavailable" });
    binding.dispose();
  });

  it("a binding without an eventSource degrades the same way", () => {
    const shell = createDispatcherShellStore();
    shell.upsertSessions([{ sessionId: "s-y", title: "Y" }]);
    const conversation = createConversationStore();
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: ["s-y"] }) },
      scope: () => undefined,
      binding: () => ({}),
    };
    const binding = bindConversationFeed(conversation, sessions, shell);
    shell.select("s-y");
    assert.deepEqual(conversation.stateFor("s-y"), { kind: "unavailable" });
    binding.dispose();
  });

  it("no selection movement: no re-resolution (rows updates do not churn subscriptions)", () => {
    const sources = new Map<string, ConversationWindowLike>([
      ["s-1", { entries: [] }],
    ]);
    const fake = fakeSessions(sources);
    const shell = createDispatcherShellStore();
    shell.upsertSessions([
      { sessionId: "s-1", title: "One" },
      { sessionId: "s-2", title: "Two" },
    ]);
    const conversation = createConversationStore();
    const binding = bindConversationFeed(conversation, fake.face, shell);
    shell.select("s-1");
    // Row/title updates re-emit the shell store without touching selection.
    shell.upsertSessions([{ sessionId: "s-1", title: "One renamed" }]);
    assert.deepEqual(fake.subscriptions(), ["s-1"]);
    binding.dispose();
  });

  it("dispose unsubscribes the shell and the window", () => {
    const sources = new Map<string, ConversationWindowLike>([
      ["s-1", { entries: [] }],
    ]);
    const fake = fakeSessions(sources);
    const shell = createDispatcherShellStore();
    shell.upsertSessions([{ sessionId: "s-1", title: "One" }]);
    const conversation = createConversationStore();
    const binding = bindConversationFeed(conversation, fake.face, shell);
    shell.select("s-1");
    assert.equal(fake.subscriptions().length, 1);
    binding.dispose();
    // Selecting after dispose touches nothing (the shell subscription is gone).
    shell.select("s-1");
    shell.removeSessions(["s-1"]);
    assert.equal(fake.subscriptions().length, 1);
    assert.equal(fake.unsubscriptions().length, 1);
  });
});

// ── Scoped pagination request

describe("requestOlder — the scoped loadOlder() verb (ticket 80)", () => {
  /**
   * The host-faithful scope fake (ticket 92, live-found 2026-09-19): the
   * scoped conversation face is reached through the SERVICE-METHOD boundary
   * `scoped.get("conversation")` (`dsh-client-ui-conversation
   * lib/client.js:16500-16506`, `:14375-14377`), while the PROPERTY read
   * throws exactly as the live host does — the cordis context proxy resolves
   * a service property by walking the fiber chain (`cordis lib/index.js
   * :672-694`) and the scope fiber injects nothing, so the walk dies at the
   * root fiber with `cannot get property "conversation" without inject`
   * (`:690`). The verb is only valid as a METHOD of the returned face
   * (detached references lose the host's tracker rebinding).
   */
  function scopeFake(record: {
    loadCalls: string[];
    reject?: boolean;
    withLoadOlder?: boolean;
  }): ClientSessionsLike {
    return {
      list: { getSnapshot: () => ({}) },
      scope(id: string) {
        return {
          get(name: string): unknown {
            if (name !== "conversation") return undefined;
            return {
              async send(text: string) {
                void text;
              },
              ...(record.withLoadOlder === false
                ? {}
                : {
                    async loadOlder() {
                      record.loadCalls.push(id);
                      if (record.reject === true) {
                        throw new Error("business failure");
                      }
                    },
                  }),
            };
          },
          get conversation(): never {
            throw new Error(
              'cannot get property "conversation" without inject',
            );
          },
        };
      },
    };
  }

  it("calls the scoped verb for the session", async () => {
    const record: { loadCalls: string[] } = { loadCalls: [] };
    const sessions = scopeFake(record);
    assert.doesNotThrow(() => requestOlder(sessions, "s-1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(record.loadCalls, ["s-1"]);
  });

  it("absent scope, sink, or verb is a silent no-op (honest absence)", async () => {
    const record: { loadCalls: string[] } = { loadCalls: [] };
    const noScope = scopeFake(record);
    const noConversationVerb: ClientSessionsLike = {
      list: { getSnapshot: () => ({}) },
      scope: () => undefined,
    };
    const withoutVerb = scopeFake({ ...record, withLoadOlder: false });
    assert.doesNotThrow(() => requestOlder(undefined, "s-1"));
    assert.doesNotThrow(() => requestOlder(noConversationVerb, "s-1"));
    assert.doesNotThrow(() => requestOlder(withoutVerb, "s-1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(record.loadCalls, []);
  });

  it("a rejecting verb is contained — never a crash, the window stays the truth", async () => {
    const record: { loadCalls: string[] } = { loadCalls: [] };
    const sessions = scopeFake({ ...record, reject: true });
    assert.doesNotThrow(() => requestOlder(sessions, "s-1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(record.loadCalls, ["s-1"]);
  });
});

// ── The scoped send path (ticket 92, live-found)

describe("sendPrompt — the session-scoped plain-prompt sink (ticket 40, shape corrected by ticket 92)", () => {
  /**
   * The host-faithful sessions fake (ticket 92): `sessions.scope(id)` is the
   * Agent-scoped context (`dsh-api-session-controller lib/client.js
   * :3254-3256`) and the conversation face is reached through the
   * SERVICE-METHOD boundary (`dsh-client-ui-conversation lib/client.js
   * :16500-16506`, `:14375-14377`). The PROPERTY read throws exactly as the
   * live host does (`cordis lib/index.js:672-694` → `:690`), and a root-scope
   * read throws the host's own scope error (`dsh-client-ui-conversation
   * lib/client.js:3177-3181`) — the shape that killed the live composer send
   * on pass 5.
   */
  function scopedSendFake(
    sent: { sessionId: string; text: string }[],
  ): ClientSessionsLike {
    return {
      list: { getSnapshot: () => ({}) },
      scope: (id: string) => ({
        get(name: string): unknown {
          if (name !== "conversation") return undefined;
          return {
            // The host's tag-bound sink: `scopeOf(this.ctx)` resolves THIS
            // scope's id, so only a call made through the scoped face lands.
            send: async (text: string) => {
              sent.push({ sessionId: id, text });
            },
          };
        },
        get conversation(): never {
          throw new Error('cannot get property "conversation" without inject');
        },
      }),
    };
  }

  it("reaches the sink through the scope's service-method boundary", async () => {
    const sent: { sessionId: string; text: string }[] = [];
    const transport = bindCommandTransport({
      remote: () => undefined,
      sessions: () => scopedSendFake(sent),
    });
    assert.deepEqual(await transport.sendPrompt("s-1", "hello"), {
      kind: "sent",
    });
    assert.deepEqual(sent, [{ sessionId: "s-1", text: "hello" }]);
  });

  it("no scope and no reachable service are honest no-channel outcomes", async () => {
    const sent: { sessionId: string; text: string }[] = [];
    const noScope: ClientSessionsLike = {
      list: { getSnapshot: () => ({}) },
      scope: () => undefined,
    };
    const noService: ClientSessionsLike = {
      list: { getSnapshot: () => ({}) },
      scope: () => ({ get: () => undefined }),
    };
    assert.deepEqual(
      await bindCommandTransport({
        remote: () => undefined,
        sessions: () => noScope,
      }).sendPrompt("s-1", "hello"),
      { kind: "no-channel" },
    );
    assert.deepEqual(
      await bindCommandTransport({
        remote: () => undefined,
        sessions: () => noService,
      }).sendPrompt("s-1", "hello"),
      { kind: "no-channel" },
    );
    assert.deepEqual(
      await bindCommandTransport({
        remote: () => undefined,
        sessions: () => undefined,
      }).sendPrompt("s-1", "hello"),
      { kind: "no-channel" },
    );
    assert.deepEqual(sent, []);
  });
});

// ── Pane contracts

describe("conversation pane — CSS + copy contracts (ticket 80, ticket 49's discipline)", () => {
  it("carries no raw colour literal — every colour is a host token", () => {
    assert.doesNotMatch(CONVERSATION_CSS, /#[0-9a-fA-F]{3,8}\b/);
    assert.doesNotMatch(CONVERSATION_CSS, /(?<![a-z])rgba?\(/);
    assert.doesNotMatch(CONVERSATION_CSS, /hsla?\(/);
    const tokens = [
      ...new Set(
        [...CONVERSATION_CSS.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map(
          (m) => m[1]!,
        ),
      ),
    ];
    assert.ok(tokens.length > 0, "no tokens referenced at all");
    const allowed = new Set([
      "--dsw-alias-bg-layer-1",
      "--dsw-alias-border-l3",
      "--dsw-alias-interactive-bg-hover",
      "--dsw-alias-label-tertiary",
      "--dsw-alias-state-business-primary",
      "--dsw-alias-state-error-primary",
      "--dsw-alias-state-warn-primary",
    ]);
    for (const token of tokens) {
      assert.ok(allowed.has(token), `token ${token} is not in the evidenced set`);
    }
  });

  it("namespaces every class and ships no animation at all", () => {
    const foreign = [...CONVERSATION_CSS.matchAll(/\.([a-z-][a-z0-9_-]*)/g)]
      .map((m) => m[1]!)
      .filter((name) => !name.startsWith("multitask-dispatcher-"));
    assert.deepEqual(foreign, []);
    assert.doesNotMatch(CONVERSATION_CSS, /@keyframes|animation:/);
    assert.match(
      CONVERSATION_CSS.trim(),
      new RegExp(`^\\.${CONVERSATION_CLASS}\\{`),
    );
  });

  it("the copy vocabulary exists in BOTH faces and carries no stop affordance", () => {
    const keys = Object.values(CONVERSATION_KEYS);
    assert.ok(keys.length >= 14, "conversation copy keys missing");
    for (const key of keys) {
      assert.match(key, /^shell\.conv\.[a-z0-9-]+$/);
      assert.ok(key in localeDictionary.en, `${key} missing from en face`);
      assert.ok(key in localeDictionary.zh, `${key} missing from zh face`);
    }
    // Area 7 conformity: no stop/cancel affordance copy anywhere.
    for (const key of keys) {
      const copy = (localeDictionary.en[key] ?? "").toLowerCase();
      assert.doesNotMatch(copy, /\bstop\b|cancel/, `${key} suggests a stop`);
    }
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
  });
});

describe("conversation pane — composer states (ticket 80's offline constraint)", () => {
  it("send is enabled exactly with non-blank text and no send in flight", () => {
    assert.equal(describeComposer({ text: "hello", sending: false }).canSend, true);
    // Blank or whitespace-only text: disabled (no empty prompts admitted).
    assert.equal(describeComposer({ text: "", sending: false }).canSend, false);
    assert.equal(describeComposer({ text: "   ", sending: false }).canSend, false);
    // In flight: disabled regardless of text.
    assert.equal(describeComposer({ text: "hello", sending: true }).canSend, false);
  });

  it("the button copy flips to the honest in-flight line while sending", () => {
    assert.equal(
      describeComposer({ text: "x", sending: false }).labelKey,
      "shell.conv.send",
    );
    assert.equal(
      describeComposer({ text: "x", sending: true }).labelKey,
      "shell.conv.sending",
    );
  });

  it("outcomes map to honest copy: silence on sent, lines on failure", () => {
    assert.equal(sendOutcomeCopyKey({ kind: "sent" }), null);
    assert.equal(
      sendOutcomeCopyKey({ kind: "no-channel" }),
      "shell.conv.no-channel",
    );
    assert.equal(
      sendOutcomeCopyKey({ kind: "failed" }),
      "shell.conv.send-failed",
    );
  });
});

describe("conversation pane — factory smoke (ticket 80, S8)", () => {
  it("exposes a component factory bound to store + actions (wiring smoke)", () => {
    const t = (key: string) => localeDictionary.en[key] ?? key;
    const store = createConversationStore();
    const actions: ConversationActions = {
      onSend: async () => ({ kind: "sent" }),
      onLoadOlder: () => {},
    };
    const pane = createConversationPane(t, store, actions);
    assert.equal(typeof pane, "function");
  });
});
