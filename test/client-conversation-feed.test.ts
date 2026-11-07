/**
 * Client dormant-vehicle repairs (0.2.x API drift + crash guards).
 *
 * Pinned here, all offline (S8: no host, no browser, no LLM):
 *
 * 1. the conversation feed rides the CURRENT sessions shape — `retain` +
 *    `reference.ready` + `binding` — instead of the retired `open`/`binding`
 *    pair, and releases its reference on deselect/dispose;
 * 2. `subscribe()`'s return is only treated as a disposer when it is
 *    callable (a non-callable return must not make `dispose()` throw);
 * 3. the reducer refuses a non-object window instead of dereferencing it, so
 *    junk from a publisher cannot escape into a listener loop;
 * 4. a user-role `agent-message`/relay turn is a distinct `peer` item with
 *    its sender, not a dropped message and never the user's own words;
 * 5. `applyPresence` refuses non-object values before touching them;
 * 6. the steer prefill reads the view owner's selection (0.2.x has no feed
 *    `current`), and a throwing `sessions.scope` is an honest unavailability.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONVERSATION_FEED_SOURCE,
  bindConversationFeed,
} from "../src/client/conversation-feed.js";
import {
  createConversationStore,
  reduceConversationWindow,
  type ConversationWindowLike,
} from "../src/client/conversation-store.js";
import {
  bindCommandTransport,
  tryPrefillSteer,
} from "../src/client/actions.js";
import {
  createDispatcherShellStore,
  type DispatcherShellStore,
} from "../src/client/shell-store.js";
import type {
  ClientSessionBindingLike,
  ClientSessionReferenceLike,
  ClientSessionsLike,
} from "../src/client/context.js";
import {
  ROSTER_SNAPSHOT_SCHEMA_VERSION,
  type RosterSnapshot,
} from "../src/core/roster-snapshot.js";

/** One assistant text event. */
function assistantEvent(seq: number, text: string) {
  return {
    type: "event" as const,
    event: {
      type: "assistant/message",
      seq,
      time: seq,
      data: { message: { content: [{ type: "text", text }] } },
    },
  };
}

/** One `user/message` event with the given source. */
function userEvent(
  seq: number,
  source: unknown,
  text: string,
) {
  return {
    type: "event" as const,
    event: {
      type: "user/message",
      seq,
      time: seq,
      data: { source, content: [{ type: "text", text }] },
    },
  };
}

/** A live event-source fake (getSnapshot + subscribe). */
function createSource(initial: ConversationWindowLike): {
  source: {
    getSnapshot(): ConversationWindowLike;
    subscribe(listener: () => void): () => void;
  };
  publish(next: ConversationWindowLike): void;
  listenerCount(): number;
} {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    publish(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

/** A shell store with one selected session (the feed's driver). */
function shellWith(sessionId: string): DispatcherShellStore {
  const store = createDispatcherShellStore();
  store.upsertSessions([{ sessionId, title: "dispatcher" }]);
  store.select(sessionId);
  return store;
}

describe("conversation store — unreadable windows degrade, never throw", () => {
  const unreadable = [null, undefined, "window", 42, true] as const;

  it("reduceConversationWindow returns null for every non-object window", () => {
    for (const value of unreadable) {
      assert.equal(
        reduceConversationWindow(value as unknown as ConversationWindowLike),
        null,
      );
    }
    // An object without an entries array is unreadable too (existing rule).
    assert.equal(reduceConversationWindow({}), null);
    assert.equal(reduceConversationWindow({ entries: "nope" as never }), null);
  });

  it("applyWindow marks the session unavailable and still notifies every subscriber", () => {
    const store = createConversationStore();
    let first = 0;
    let second = 0;
    store.subscribe(() => {
      first += 1;
    });
    store.subscribe(() => {
      second += 1;
    });
    assert.doesNotThrow(() => {
      store.applyWindow("s-1", null as unknown as ConversationWindowLike);
    });
    assert.deepEqual(store.stateFor("s-1"), { kind: "unavailable" });
    assert.equal(first, 1);
    assert.equal(second, 1, "a junk window must not stop later listeners");
  });

  it("isolates subscribers: a throwing one neither stops later ones nor escapes", () => {
    const store = createConversationStore();
    let later = 0;
    store.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    store.subscribe(() => {
      later += 1;
    });
    assert.doesNotThrow(() => {
      store.applyWindow("s-1", { entries: [] });
    });
    assert.equal(later, 1, "the later subscriber still ran");
    assert.equal(store.stateFor("s-1").kind, "ready");
  });

  it("joins multiple text blocks as separate paragraphs", () => {
    const transcript = reduceConversationWindow({
      entries: [
        {
          type: "event",
          event: {
            type: "assistant/message",
            seq: 1,
            time: 1,
            data: {
              message: {
                content: [
                  { type: "text", text: "first paragraph" },
                  { type: "text", text: "second paragraph" },
                ],
              },
            },
          },
        },
      ],
    });
    const item = transcript?.items[0];
    assert.ok(item && item.kind === "assistant");
    assert.equal(item.text, "first paragraph\n\nsecond paragraph");
  });

  it("reads the tool-result error flag from the message (and data.error), not block[0]", () => {
    const toolCall = {
      type: "event" as const,
      event: {
        type: "tool/call",
        seq: 1,
        time: 1,
        data: { callId: "c-1", name: "read_file", arguments: "{}" },
      },
    };
    /** An error result whose MESSAGE carries `isError` and no `data.error`. */
    const messageError = reduceConversationWindow({
      entries: [
        toolCall,
        {
          type: "event",
          event: {
            type: "tool/result",
            seq: 2,
            time: 2,
            data: {
              message: {
                isError: true,
                source: { callId: "c-1" },
                content: [{ type: "tool-result", content: [] }],
              },
            },
          },
        },
      ],
    });
    const first = messageError?.items[0];
    assert.ok(first && first.kind === "tool");
    assert.equal(first.failed, true, "message.isError is the error flag");

    /** A structured failure carried only in `data.error`. */
    const dataError = reduceConversationWindow({
      entries: [
        toolCall,
        {
          type: "event",
          event: {
            type: "tool/result",
            seq: 2,
            time: 2,
            data: {
              error: { message: "tool exploded" },
              message: {
                source: { callId: "c-1" },
                content: [{ type: "tool-result", content: [] }],
              },
            },
          },
        },
      ],
    });
    const second = dataError?.items[0];
    assert.ok(second && second.kind === "tool");
    assert.equal(second.failed, true, "data.error is an error flag");
  });
});

describe("conversation store — peer-relay turns keep their sender", () => {
  it("renders an agent-message user turn as `peer`, not as the user", () => {
    const transcript = reduceConversationWindow({
      entries: [
        userEvent(1, { kind: "user" }, "please summarise"),
        userEvent(
          2,
          {
            kind: "agent-message",
            form: "relay",
            senderSessionId: "s-parent",
          },
          "worker 3 finished",
        ),
        // Synthetic context stays skipped: it is model-facing, not speech.
        userEvent(3, { kind: "runtime-context" }, "injected note"),
      ],
    });
    assert.ok(transcript);
    assert.deepEqual(
      transcript.items.map((item) => item.kind),
      ["user", "peer"],
    );
    const peer = transcript.items[1];
    assert.ok(peer && peer.kind === "peer");
    assert.equal(peer.text, "worker 3 finished");
    assert.equal(peer.senderSessionId, "s-parent");
  });

  it("accepts a relay source without a sender id (label-only peer turn)", () => {
    const transcript = reduceConversationWindow({
      entries: [userEvent(1, { kind: "agent-message", form: "relay" }, "hi")],
    });
    assert.equal(transcript?.items[0]?.kind, "peer");
    const peer = transcript?.items[0];
    assert.ok(peer && peer.kind === "peer");
    assert.equal(peer.senderSessionId, null);
  });
});

describe("conversation feed — 0.2.x retain/reference/binding shape", () => {
  it("retains the selected session, then follows the reference's binding", () => {
    const window = createSource({
      entries: [assistantEvent(1, "hello")],
      hasMore: false,
    });
    const calls: Array<{ target: string; source: string }> = [];
    let released = 0;
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => undefined,
      retain(target, options) {
        calls.push({ target, source: options.source });
        const reference: ClientSessionReferenceLike = {
          sessionId: target,
          binding: { eventSource: window.source },
          release() {
            released += 1;
          },
        };
        return reference;
      },
    };
    const conversation = createConversationStore();
    const shell = shellWith("s-1");
    const binding = bindConversationFeed(conversation, sessions, shell);

    assert.deepEqual(calls, [
      { target: "s-1", source: CONVERSATION_FEED_SOURCE },
    ]);
    assert.deepEqual(conversation.stateFor("s-1"), {
      kind: "ready",
      transcript: {
        items: [{ kind: "assistant", seq: 1, text: "hello", interrupted: false }],
        hasMore: false,
        running: false,
      },
    });

    // A window publication feeds the store without re-resolving the session.
    window.publish({ entries: [assistantEvent(1, "hello"), assistantEvent(2, "again")] });
    const state = conversation.stateFor("s-1");
    assert.ok(state.kind === "ready");
    assert.equal(state.transcript.items.length, 2);
    assert.equal(calls.length, 1, "selection did not move: no re-retain");

    binding.dispose();
    assert.equal(released, 1, "the held reference is released on dispose");
    assert.equal(window.listenerCount(), 0, "the window subscription is dropped");
  });

  it("waits for reference.ready when the binding only appears after the open", async () => {
    const window = createSource({ entries: [assistantEvent(7, "late")] });
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => undefined,
      retain: (target) => ({
        sessionId: target,
        ready: Promise.resolve<ClientSessionBindingLike>({
          eventSource: window.source,
        }),
        release() {},
      }),
    };
    const conversation = createConversationStore();
    const binding = bindConversationFeed(
      conversation,
      sessions,
      shellWith("s-1"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const state = conversation.stateFor("s-1");
    assert.ok(state.kind === "ready");
    assert.equal(state.transcript.items[0]?.kind, "assistant");
    binding.dispose();
  });

  it("a throwing retain degrades to honest unavailability (never a crash)", () => {
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => undefined,
      retain() {
        throw new Error("retain refused");
      },
    };
    const conversation = createConversationStore();
    assert.doesNotThrow(() =>
      bindConversationFeed(conversation, sessions, shellWith("s-1")),
    );
    assert.deepEqual(conversation.stateFor("s-1"), { kind: "unavailable" });
  });

  it("a runtime with neither retain nor binding is unavailable, not silently empty", () => {
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => undefined,
    };
    const conversation = createConversationStore();
    bindConversationFeed(conversation, sessions, shellWith("s-1"));
    assert.deepEqual(conversation.stateFor("s-1"), { kind: "unavailable" });
  });

  it("an uncallable subscribe return is contained (dispose never throws)", () => {
    const source = {
      getSnapshot: () => ({ entries: [assistantEvent(1, "hi")] }),
      // A host-shaped source whose subscribe returns a handle, not a function.
      subscribe: () => ({}) as unknown as () => void,
    };
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => undefined,
      retain: (target) => ({
        sessionId: target,
        binding: { eventSource: source },
        release() {},
      }),
    };
    const conversation = createConversationStore();
    const binding = bindConversationFeed(
      conversation,
      sessions,
      shellWith("s-1"),
    );
    assert.equal(conversation.stateFor("s-1").kind, "ready");
    assert.doesNotThrow(() => binding.dispose());
  });

  it("treats the provisional empty revision-0 window as waiting until ready settles", async () => {
    const window = createSource({
      entries: [],
      hasMore: false,
      revision: 0,
    });
    let resolveReady: ((value: ClientSessionBindingLike) => void) | undefined;
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => undefined,
      retain: (target) => ({
        sessionId: target,
        binding: { eventSource: window.source },
        ready: new Promise<ClientSessionBindingLike>((resolve) => {
          resolveReady = resolve;
        }),
        release() {},
      }),
    };
    const conversation = createConversationStore();
    const binding = bindConversationFeed(
      conversation,
      sessions,
      shellWith("s-1"),
    );
    // The empty revision-0 window is the not-yet-open reference, not an
    // empty transcript.
    assert.deepEqual(conversation.stateFor("s-1"), { kind: "waiting" });

    resolveReady?.({ eventSource: window.source });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(conversation.stateFor("s-1"), {
      kind: "ready",
      transcript: { items: [], hasMore: false, running: false },
    });
    binding.dispose();
  });

  it("marks unavailable when ready rejects, even though an eventSource was present", async () => {
    const window = createSource({ entries: [assistantEvent(1, "hello")] });
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => undefined,
      retain: (target) => ({
        sessionId: target,
        binding: { eventSource: window.source },
        ready: Promise.reject(new Error("initial open failed")),
        release() {},
      }),
    };
    const conversation = createConversationStore();
    const binding = bindConversationFeed(
      conversation,
      sessions,
      shellWith("s-1"),
    );
    // The provisional window may have been applied before the rejection…
    assert.equal(conversation.stateFor("s-1").kind, "ready");
    await new Promise((resolve) => setImmediate(resolve));
    // …but a failed open is the honest unavailable state, and the provisional
    // window subscription is dropped.
    assert.deepEqual(conversation.stateFor("s-1"), { kind: "unavailable" });
    assert.equal(window.listenerCount(), 0);
    binding.dispose();
  });

  it("a throwing conversation subscriber cannot turn the window into unavailable", () => {
    const window = createSource({ entries: [assistantEvent(1, "hello")] });
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => undefined,
      retain: (target) => ({
        sessionId: target,
        binding: { eventSource: window.source },
        release() {},
      }),
    };
    const conversation = createConversationStore();
    let later = 0;
    conversation.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    conversation.subscribe(() => {
      later += 1;
    });
    const binding = bindConversationFeed(
      conversation,
      sessions,
      shellWith("s-1"),
    );
    assert.doesNotThrow(() => {
      window.publish({ entries: [assistantEvent(2, "again")] });
    });
    assert.equal(later, 2, "both the attach sync and the publish reached it");
    assert.equal(
      conversation.stateFor("s-1").kind,
      "ready",
      "a listener failure is not an unreadable window",
    );
    binding.dispose();
  });

  it("a selection reentry during the initial apply keeps the nested unsubscribe", () => {
    const windowA = createSource({ entries: [assistantEvent(1, "from A")] });
    const windowB = createSource({ entries: [assistantEvent(2, "from B")] });
    const released: string[] = [];
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => undefined,
      retain(target) {
        return {
          sessionId: target,
          binding: {
            eventSource: target === "s-a" ? windowA.source : windowB.source,
          },
          release() {
            released.push(target);
          },
        };
      },
    };
    const conversation = createConversationStore();
    const shell = createDispatcherShellStore();
    shell.upsertSessions([
      { sessionId: "s-a", title: "A" },
      { sessionId: "s-b", title: "B" },
    ]);
    const binding = bindConversationFeed(conversation, sessions, shell);

    // A's initial apply notifies synchronously; the one-shot subscriber moves
    // selection to B inside the outer A attachment, so B attaches and
    // subscribes before the outer attach resumes.
    let armed = true;
    conversation.subscribe(() => {
      if (!armed) return;
      armed = false;
      shell.select("s-b");
    });

    shell.select("s-a");

    assert.equal(
      windowA.listenerCount(),
      0,
      "the obsolete outer A subscription is dropped",
    );
    assert.equal(
      windowB.listenerCount(),
      1,
      "the nested B attachment keeps its subscription",
    );
    assert.equal(conversation.stateFor("s-b").kind, "ready");

    binding.dispose();
    assert.equal(windowB.listenerCount(), 0, "dispose drops B's subscription");
    const beforeLatePublishA = conversation.stateFor("s-a");
    const beforeLatePublishB = conversation.stateFor("s-b");
    windowA.publish({ entries: [assistantEvent(3, "late A")] });
    windowB.publish({ entries: [assistantEvent(4, "late B")] });
    assert.deepEqual(
      conversation.stateFor("s-a"),
      beforeLatePublishA,
      "no borrowed source can feed the store after dispose",
    );
    assert.deepEqual(
      conversation.stateFor("s-b"),
      beforeLatePublishB,
      "no borrowed source can feed the store after dispose",
    );
    assert.deepEqual(released, ["s-a", "s-b"]);
  });

  it("a reentry that returns to the same session still drops the outer subscription", () => {
    const windowA = createSource({ entries: [assistantEvent(1, "from A")] });
    const windowB = createSource({ entries: [assistantEvent(2, "from B")] });
    const released: string[] = [];
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => undefined,
      retain(target) {
        return {
          sessionId: target,
          binding: {
            eventSource: target === "s-a" ? windowA.source : windowB.source,
          },
          release() {
            released.push(target);
          },
        };
      },
    };
    const conversation = createConversationStore();
    const shell = createDispatcherShellStore();
    shell.upsertSessions([
      { sessionId: "s-a", title: "A" },
      { sessionId: "s-b", title: "B" },
    ]);
    const binding = bindConversationFeed(conversation, sessions, shell);

    // B then back to A inside A's initial apply: the outermost attachment's
    // generation moved on even though the current session ended up A again.
    let armed = true;
    conversation.subscribe(() => {
      if (!armed) return;
      armed = false;
      shell.select("s-b");
      shell.select("s-a");
    });

    shell.select("s-a");

    assert.equal(
      windowA.listenerCount(),
      1,
      "only the nested A attachment remains subscribed",
    );
    assert.equal(windowB.listenerCount(), 0);
    binding.dispose();
    assert.equal(windowA.listenerCount(), 0);
    assert.deepEqual(released, ["s-a", "s-b", "s-a"]);
  });
});

describe("shell store — applyPresence refuses unparsed values", () => {
  const validSnapshot: RosterSnapshot = {
    schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
    dispatcherSessionId: "s-1",
    publishedAtMs: 0,
    workers: [
      {
        kind: "worker",
        workerId: "w-1",
        title: "Worker",
        status: "completed",
        todoId: null,
        startedAtMs: 0,
        toolCallCount: 1,
        delivered: false,
      },
    ],
    recentResult: null,
  };

  it("never dereferences null/undefined/primitive snapshots", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-1", title: "dispatcher" }]);
    for (const value of [null, undefined, "junk", 7, true]) {
      assert.doesNotThrow(() =>
        store.applyPresence(value as unknown as never),
      );
    }
    const row = store.getBox().state.rows.get("s-1");
    assert.equal(row?.presence, null, "junk leaves the row's honest absence");
    // A real snapshot still applies afterwards.
    store.applyPresence(validSnapshot);
    const applied = store.getBox().state.rows.get("s-1");
    assert.equal(applied?.presence?.needsYou, 1);
  });
});

describe("shell store — listener isolation and mirror hygiene", () => {
  const snapshotFor = (sessionId: string): RosterSnapshot => ({
    schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
    dispatcherSessionId: sessionId,
    publishedAtMs: 0,
    workers: [],
    recentResult: null,
  });

  it("isolates subscribers: a throwing one neither stops later ones nor escapes", () => {
    const store = createDispatcherShellStore();
    let later = 0;
    store.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    store.subscribe(() => {
      later += 1;
    });
    assert.doesNotThrow(() =>
      store.upsertSessions([{ sessionId: "s-1", title: "one" }]),
    );
    assert.equal(later, 1, "the later subscriber still ran");
  });

  it("drops a removed session's mirror instead of resurrecting it later", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "s-1", title: "one" },
      { sessionId: "s-2", title: "two" },
    ]);
    store.applyPresence(snapshotFor("s-1"));
    store.applyPresence(snapshotFor("s-2"));
    assert.equal(store.getBox().state.mirrors.has("s-1"), true);

    store.removeSessions(["s-1"]);
    assert.equal(
      store.getBox().state.mirrors.has("s-1"),
      false,
      "a removed session's mirror is stale by construction",
    );
    assert.equal(store.getBox().state.mirrors.has("s-2"), true);

    // A returning feed row starts clean rather than inheriting the old
    // presence/flag through the retained mirror.
    store.upsertSessions([{ sessionId: "s-1", title: "one again" }]);
    assert.equal(store.getBox().state.rows.get("s-1")?.presence, null);
    assert.equal(store.getBox().state.rows.get("s-1")?.dispatcher, false);
  });
});

describe("steer prefill — view-owned selection, guarded scope", () => {
  it("reads the caller's current session (0.2.x has no feed `current`)", () => {
    let draft = "";
    const sessions: ClientSessionsLike = {
      list: {
        // The retired shape is gone: a snapshot with no `current` at all.
        getSnapshot: () => ({ ids: ["s-1"], byId: {} }),
      },
      scope: () => ({}),
    };
    const outcome = tryPrefillSteer(
      {
        sessions: () => sessions,
        conversation: () => ({
          input: {
            for: () => ({
              setDraft(text: string) {
                draft = text;
              },
            }),
          },
        }),
        currentSessionId: () => "s-1",
      },
      "w-1",
    );
    assert.deepEqual(outcome, { kind: "prefilled" });
    assert.equal(draft, "/dispatcher-steer w-1 ");
  });

  it("contains a throwing sessions.scope as unavailability", () => {
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope() {
        throw new Error("cannot get property without inject");
      },
    };
    const outcome = tryPrefillSteer(
      {
        sessions: () => sessions,
        conversation: () => ({ input: { for: () => ({ setDraft() {} }) } }),
        currentSessionId: () => "s-1",
      },
      "w-1",
    );
    assert.deepEqual(outcome, { kind: "unavailable" });
  });

  it("sendPrompt contains a throwing scope as no-channel", async () => {
    const transport = bindCommandTransport({
      remote: () => undefined,
      sessions: () => ({
        list: { getSnapshot: () => ({ ids: [], byId: {} }) },
        scope() {
          throw new Error("scope read threw");
        },
      }),
    });
    assert.deepEqual(await transport.sendPrompt("s-1", "hello"), {
      kind: "no-channel",
    });
  });
});
