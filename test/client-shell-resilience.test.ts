/**
 * Shell resilience + conversation-pane repairs (jsdom, offline S8).
 *
 * Pinned here:
 *
 * 1. every seat (conversation, roster panel, onboarding) has its own error
 *    boundary: one throwing seat renders one honest failure line and the
 *    rest of the shell entry stays mounted (the shell entry itself never
 *    goes dark);
 * 2. the sidebar's staleness clock TICKS with the panel's cadence (and is
 *    cleaned up), so a live snapshot ages into "presence unavailable"
 *    without waiting for an unrelated store emit;
 * 3. a peer-relay turn renders with a peer role and its sender;
 * 4. streaming assistant text keeps its DOM identity while deltas arrive
 *    (the key is `attemptId`, not the per-chunk `seq`).
 *
 * Rendering uses jsdom + react-dom (the established `test/client-*.test.ts`
 * idiom). Everything is offline: no network, no host, no LLM.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

// ── jsdom globals BEFORE react-dom initializes (the host renderer's stand-in)

import { createRequire } from "node:module";

// jsdom ships no type declarations and @types/jsdom is not a dependency (DOM
// tests run through tsx, which does not typecheck), so describe the surface
// this file uses locally and load the package through require.
const loadCjs = createRequire(import.meta.url);
const { JSDOM } = loadCjs("jsdom") as {
  JSDOM: new (
    html?: string,
    options?: { url?: string; pretendToBeVisual?: boolean },
  ) => { window: Window };
};

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

(globalThis as Record<string, unknown>)["window"] = dom.window;
(globalThis as Record<string, unknown>)["document"] = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  configurable: true,
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

import {
  SHELL_CLASS,
  SHELL_CSS,
  createDispatcherShell,
} from "../src/client/shell.js";
import {
  createDispatcherShellStore,
  type DispatcherShellStore,
} from "../src/client/shell-store.js";
import {
  CONVERSATION_CLASS,
  CONVERSATION_KEYS,
  conversationItemKey,
  createConversationPane,
  type ConversationSendOutcome,
} from "../src/client/conversation.js";
import {
  createConversationStore,
  type ConversationWindowLike,
} from "../src/client/conversation-store.js";
import { ROSTER_STALE_RECHECK_MS, createRosterStore } from "../src/client/roster-store.js";
import { createRosterPanel } from "../src/client/panel.js";
import {
  ROSTER_SNAPSHOT_SCHEMA_VERSION,
  ROSTER_STALE_WINDOW_MS,
  type RosterSnapshot,
} from "../src/core/roster-snapshot.js";
import { localeDictionary } from "../src/client/overlay.js";

const t = (key: string): string => localeDictionary.en[key] ?? key;

/** Mount one element into a fresh container and return the container. */
async function mount(element: ReturnType<typeof createElement>): Promise<{
  container: HTMLElement;
  unmount(): Promise<void>;
}> {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** A shell store with one listed (and optionally selected) session. */
function shellStore(selected: boolean): DispatcherShellStore {
  const store = createDispatcherShellStore();
  store.upsertSessions([{ sessionId: "s-1", title: "Dispatcher one" }]);
  if (selected) store.select("s-1");
  return store;
}

/** Silence React's expected error logging while a boundary test runs. */
async function withoutErrorLog<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

describe("shell — per-seat failure boundaries (jsdom)", () => {
  it("a throwing conversation seat renders one failure line, not a dead shell", async () => {
    await withoutErrorLog(async () => {
      const Shell = createDispatcherShell(t, shellStore(true), {
        conversation: () => {
          throw new Error("conversation seat exploded");
        },
      });
      const mounted = await mount(createElement(Shell));
      const failure = mounted.container.querySelector(
        `.${SHELL_CLASS}__seat-failed`,
      );
      assert.ok(failure, "the failed seat renders its honest line");
      assert.equal(failure.textContent, t("shell.seat.failed"));
      assert.ok(
        mounted.container.querySelector(`.${SHELL_CLASS}__sidebar`),
        "the sidebar survives a failed main seat",
      );
      assert.ok(
        mounted.container.querySelector(`.${SHELL_CLASS}__main-header`),
        "the selected session's header survives",
      );
      await mounted.unmount();
    });
  });

  it("a throwing roster seat leaves the conversation seat rendering", async () => {
    await withoutErrorLog(async () => {
      const Shell = createDispatcherShell(t, shellStore(true), {
        conversation: () =>
          createElement("div", { "data-seat": "conversation" }, "hello"),
        rosterPanel: () => {
          throw new Error("roster seat exploded");
        },
      });
      const mounted = await mount(createElement(Shell));
      assert.ok(
        mounted.container.querySelector('[data-seat="conversation"]'),
        "the conversation seat still renders",
      );
      const right = mounted.container.querySelector('[data-pane="right"]');
      assert.ok(right?.querySelector(`.${SHELL_CLASS}__seat-failed`));
      await mounted.unmount();
    });
  });

  it("a throwing onboarding seat leaves the sidebar usable", async () => {
    await withoutErrorLog(async () => {
      const Shell = createDispatcherShell(t, shellStore(false), {
        onboarding: () => {
          throw new Error("onboarding seat exploded");
        },
      });
      const mounted = await mount(createElement(Shell));
      const failure = mounted.container.querySelector(
        `.${SHELL_CLASS}__seat-failed`,
      );
      assert.ok(failure, "the onboarding seat fails alone");
      assert.ok(mounted.container.querySelector(`.${SHELL_CLASS}__list`));
      await mounted.unmount();
    });
  });
});

describe("shell — sidebar copy-id reachability (jsdom)", () => {
  it("keeps the copy affordance focusable and names it with the session id", async () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "s-1", title: "Dispatcher one", dispatcher: true },
      { sessionId: "s-2", title: "Dispatcher two", dispatcher: true },
    ]);
    store.select("s-1");
    const Shell = createDispatcherShell(t, store);
    const mounted = await mount(createElement(Shell));

    const copy = mounted.container.querySelector<HTMLButtonElement>(
      `.${SHELL_CLASS}__row-copy[data-copy-id="s-1"]`,
    );
    assert.ok(copy, "the dispatcher row renders its copy affordance");
    assert.equal(copy.getAttribute("title"), "s-1");
    assert.equal(
      copy.getAttribute("aria-label"),
      `${t("shell.row.copy-id")}: s-1`,
      "the accessible name carries the row's own session id",
    );

    const selected = mounted.container.querySelector(
      `.${SHELL_CLASS}__row[data-session-id="s-1"]`,
    );
    assert.equal(selected?.getAttribute("aria-current"), "true");
    const unselected = mounted.container.querySelector(
      `.${SHELL_CLASS}__row[data-session-id="s-2"]`,
    );
    assert.equal(unselected?.getAttribute("aria-current"), null);

    await mounted.unmount();
  });

  it("styles the copy affordance as visually hidden but focusable, revealed by focus-within", () => {
    const rule =
      SHELL_CSS.match(/\.multitask-dispatcher-shell__row-copy\{[^}]*\}/)?.[0] ??
      "";
    assert.ok(rule, "the copy rule exists");
    assert.doesNotMatch(
      rule,
      /display\s*:\s*none/,
      "display:none makes the control unreachable by keyboard",
    );
    assert.match(rule, /clip-path\s*:\s*inset\(50%\)/, "visually hidden, not removed");
    assert.match(
      SHELL_CSS,
      /li:focus-within \.multitask-dispatcher-shell__row-copy/,
      "focusing the copy button (or anything in the row) reveals it",
    );
  });

  /** Install/remove the browser clipboard stub the default writer reaches. */
  function stubClipboard(
    writeText: ((text: string) => Promise<void>) | undefined,
  ): void {
    if (writeText === undefined) {
      delete (navigator as { clipboard?: unknown }).clipboard;
      return;
    }
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  }

  /** Let a rejected promise settle so an escaped rejection is observable. */
  async function settleFailures(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it("contains a rejected default browser clipboard write and keeps the id readable", async (ctx) => {
    stubClipboard(() => Promise.reject(new Error("clipboard denied")));
    ctx.after(() => stubClipboard(undefined));
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    ctx.after(() => process.off("unhandledRejection", onUnhandled));

    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "s-1", title: "Dispatcher one", dispatcher: true },
    ]);
    const Shell = createDispatcherShell(t, store);
    const mounted = await mount(createElement(Shell));
    ctx.after(async () => {
      await mounted.unmount();
    });

    const copy = mounted.container.querySelector<HTMLButtonElement>(
      `.${SHELL_CLASS}__row-copy[data-copy-id="s-1"]`,
    );
    assert.ok(copy, "the copy affordance renders");
    await act(async () => {
      copy.click();
    });
    await settleFailures();

    assert.deepEqual(
      rejections,
      [],
      "the browser rejection is observed, never left unhandled",
    );
    assert.equal(copy.textContent, "s-1", "the id stays readable");
    assert.equal(copy.getAttribute("title"), "s-1", "the title still names the id");
  });

  it("contains an injected writer's synchronous throw at the copy boundary", async (ctx) => {
    const reported: string[] = [];
    const onError = (event: Event): void => {
      reported.push((event as ErrorEvent).message);
      event.preventDefault();
    };
    dom.window.addEventListener("error", onError);
    ctx.after(() => dom.window.removeEventListener("error", onError));

    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "s-1", title: "Dispatcher one", dispatcher: true },
    ]);
    const Shell = createDispatcherShell(t, store, {
      copyToClipboard: () => {
        throw new Error("clipboard exploded");
      },
    });
    const mounted = await mount(createElement(Shell));
    ctx.after(async () => {
      await mounted.unmount();
    });

    const copy = mounted.container.querySelector<HTMLButtonElement>(
      `.${SHELL_CLASS}__row-copy[data-copy-id="s-1"]`,
    );
    assert.ok(copy, "the copy affordance renders");
    await act(async () => {
      copy.click();
    });

    assert.deepEqual(reported, [], "the writer's throw is contained by the click");
    assert.equal(copy.textContent, "s-1", "the id stays readable");
    assert.equal(copy.getAttribute("title"), "s-1");
  });

  it("contains an injected writer's rejected promise at the copy boundary", async (ctx) => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    ctx.after(() => process.off("unhandledRejection", onUnhandled));

    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "s-1", title: "Dispatcher one", dispatcher: true },
    ]);
    const Shell = createDispatcherShell(t, store, {
      copyToClipboard: () => Promise.reject(new Error("clipboard denied")),
    });
    const mounted = await mount(createElement(Shell));
    ctx.after(async () => {
      await mounted.unmount();
    });

    const copy = mounted.container.querySelector<HTMLButtonElement>(
      `.${SHELL_CLASS}__row-copy[data-copy-id="s-1"]`,
    );
    assert.ok(copy, "the copy affordance renders");
    await act(async () => {
      copy.click();
    });
    await settleFailures();

    assert.deepEqual(
      rejections,
      [],
      "the writer's rejection is observed, never left unhandled",
    );
    assert.equal(copy.textContent, "s-1", "the id stays readable");
  });
});

describe("conversation composer — focus and accessible naming (jsdom)", () => {
  it("labels the textarea Message, keeps it mounted read-only while sending, and restores focus", async () => {
    let finishSend: ((outcome: ConversationSendOutcome) => void) | undefined;
    const conversation = createConversationStore();
    const Pane = createConversationPane(t, conversation, {
      onSend: () =>
        new Promise<ConversationSendOutcome>((resolve) => {
          finishSend = resolve;
        }),
      onLoadOlder: () => {},
    });
    const mounted = await mount(createElement(Pane, { sessionId: "s-1" }));

    const textarea = mounted.container.querySelector<HTMLTextAreaElement>(
      `.${CONVERSATION_CLASS}__input`,
    );
    assert.ok(textarea);
    assert.equal(
      textarea.getAttribute("aria-label"),
      t(CONVERSATION_KEYS.message),
      "the field names itself, not the send button",
    );
    assert.notEqual(textarea.getAttribute("aria-label"), t(CONVERSATION_KEYS.send));

    // Type a message the way a controlled textarea receives it.
    await act(async () => {
      // jsdom installs the DOM constructors on its window, not on Node's
      // globals; the local Window typing above only names `document`.
      const domWindow = dom.window as unknown as {
        HTMLTextAreaElement: { prototype: HTMLTextAreaElement };
        Event: typeof Event;
      };
      const setter = Object.getOwnPropertyDescriptor(
        domWindow.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "hello");
      textarea.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
    });
    assert.equal(textarea.value, "hello");

    const send = mounted.container.querySelector<HTMLButtonElement>(
      `.${CONVERSATION_CLASS}__send`,
    );
    assert.ok(send);
    await act(async () => {
      send.click();
    });

    // The composer stays focusable while the wire call is in flight.
    assert.equal(textarea.disabled, false, "a disabled field loses focus");
    assert.equal(textarea.readOnly, true);
    assert.equal(textarea.getAttribute("aria-busy"), "true");

    await act(async () => {
      finishSend?.({ kind: "failed" });
    });

    assert.equal(textarea.readOnly, false);
    const status = mounted.container.querySelector(
      `.${CONVERSATION_CLASS}__status[role="status"]`,
    );
    assert.ok(status, "the failure line is a live status region");
    assert.equal(status.textContent, t(CONVERSATION_KEYS.sendFailed));
    assert.equal(
      textarea.getAttribute("aria-describedby"),
      status.id,
      "the textarea is described by the failure line",
    );
    assert.equal(
      dom.window.document.activeElement,
      textarea,
      "focus returns to the composer after the send settles",
    );

    await mounted.unmount();
  });
});

describe("shell — the sidebar presence clock ticks (jsdom)", () => {
  it("ages a fresh snapshot into 'presence unavailable' without a store emit", async () => {
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const store = createDispatcherShellStore();
      store.upsertSessions([{ sessionId: "s-1", title: "Dispatcher one" }]);
      const snapshot: RosterSnapshot = {
        schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
        dispatcherSessionId: "s-1",
        // Fresh at mount: 5 s inside the stale window.
        publishedAtMs: Date.now() - (ROSTER_STALE_WINDOW_MS - 5_000),
        workers: [
          {
            kind: "worker",
            workerId: "w-1",
            title: "Worker",
            status: "completed",
            todoId: null,
            startedAtMs: 0,
            toolCallCount: 0,
            delivered: false,
          },
        ],
        recentResult: null,
      };
      store.applyPresence(snapshot);
      const Shell = createDispatcherShell(t, store);
      const mounted = await mount(createElement(Shell));
      const chipText = () => mounted.container.textContent ?? "";
      assert.match(chipText(), /1 needs you/);

      // The tick passes the stale window with NO store change: only the
      // clock re-render can turn the snapshot into honest unavailability.
      offset += ROSTER_STALE_RECHECK_MS;
      await act(async () => {
        mock.timers.tick(ROSTER_STALE_RECHECK_MS);
      });
      assert.match(chipText(), /presence unavailable/);
      assert.doesNotMatch(chipText(), /1 needs you/);
      await mounted.unmount();
    } finally {
      mock.timers.reset();
      Date.now = realNow;
    }
  });
});

describe("conversation pane — peer relay and streaming identity (jsdom)", () => {
  /** One relayed user-role message (another dispatcher's report). */
  function relayWindow(text: string): ConversationWindowLike {
    return {
      entries: [
        {
          type: "event",
          event: {
            type: "user/message",
            seq: 1,
            time: 1,
            data: {
              source: {
                kind: "agent-message",
                form: "relay",
                senderSessionId: "s-parent",
              },
              content: [{ type: "text", text }],
            },
          },
        },
      ],
    };
  }

  function pane() {
    const conversation = createConversationStore();
    const Pane = createConversationPane(t, conversation, {
      onSend: async () => ({ kind: "sent" }),
      onLoadOlder: () => {},
    });
    return { conversation, Pane };
  }

  it("renders a peer turn with its role and sender, never as the user", async () => {
    const { conversation, Pane } = pane();
    conversation.applyWindow("s-1", relayWindow("worker 2 finished"));
    const mounted = await mount(createElement(Pane, { sessionId: "s-1" }));
    const item = mounted.container.querySelector('[data-role="peer"]');
    assert.ok(item, "the relay turn renders as a peer item");
    assert.ok(
      (item.textContent ?? "").includes(t(CONVERSATION_KEYS.rolePeer)),
      "the peer role is labelled",
    );
    // The full sender id is details/title only — the visible line says who
    // the message is from, never an opaque session id.
    assert.equal(
      item.getAttribute("title"),
      "s-parent",
      "the sender id lives in the title attribute",
    );
    assert.equal(
      (item.textContent ?? "").includes("s-parent"),
      false,
      "the sender id never renders in the visible line",
    );
    assert.equal(
      mounted.container.querySelector('[data-role="user"]'),
      null,
      "the relay turn is never rendered as the user's own words",
    );
    await mounted.unmount();
  });

  it("keeps one DOM item for a streaming attempt while deltas advance seq", async () => {
    // The reducer rewrites `seq` on every accumulated delta; the key must
    // ignore that or the item remounts chunk by chunk.
    const first: ConversationWindowLike = {
      entries: [
        {
          type: "transient",
          event: {
            type: "assistant/live-chunk",
            seq: 1,
            time: 1,
            data: { attemptId: "attempt-1", chunk: { type: "text-delta", text: "hel" } },
          },
        },
      ],
    };
    const second: ConversationWindowLike = {
      entries: [
        ...(first.entries ?? []),
        {
          type: "transient",
          event: {
            type: "assistant/live-chunk",
            seq: 9,
            time: 9,
            data: { attemptId: "attempt-1", chunk: { type: "text-delta", text: "lo" } },
          },
        },
      ],
    };

    const { conversation, Pane } = pane();
    conversation.applyWindow("s-1", first);
    const mounted = await mount(createElement(Pane, { sessionId: "s-1" }));
    const before = mounted.container.querySelector(
      `.${CONVERSATION_CLASS}__item[data-role="assistant"]`,
    );
    assert.ok(before, "the streaming item renders");

    await act(async () => {
      conversation.applyWindow("s-1", second);
    });
    const after = mounted.container.querySelector(
      `.${CONVERSATION_CLASS}__item[data-role="assistant"]`,
    );
    assert.equal(after, before, "the same DOM node is updated in place");
    assert.match(after?.textContent ?? "", /hello/);
    await mounted.unmount();
  });

  it("keys a streaming item by attemptId alone", () => {
    assert.equal(
      conversationItemKey({
        kind: "assistant-streaming",
        seq: 1,
        attemptId: "attempt-1",
        text: "a",
      }),
      conversationItemKey({
        kind: "assistant-streaming",
        seq: 42,
        attemptId: "attempt-1",
        text: "a lot more",
      }),
    );
    assert.notEqual(
      conversationItemKey({
        kind: "assistant-streaming",
        seq: 1,
        attemptId: "attempt-1",
        text: "",
      }),
      conversationItemKey({
        kind: "assistant-streaming",
        seq: 1,
        attemptId: "attempt-2",
        text: "",
      }),
    );
  });

  it("shows the load-older control on a ready empty page that still has history", async () => {
    const conversation = createConversationStore();
    conversation.applyWindow("s-1", { entries: [], hasMore: true });
    const olderRequests: string[] = [];
    const Pane = createConversationPane(t, conversation, {
      onSend: async () => ({ kind: "sent" }),
      onLoadOlder: (sessionId) => {
        olderRequests.push(sessionId);
      },
    });
    const mounted = await mount(createElement(Pane, { sessionId: "s-1" }));

    assert.ok(
      mounted.container.querySelector(
        `.${CONVERSATION_CLASS}__notice[data-state="empty"]`,
      ),
      "the empty page still explains itself",
    );
    const more = mounted.container.querySelector<HTMLButtonElement>(
      `.${CONVERSATION_CLASS}__more`,
    );
    assert.ok(more, "older history remains, so the control must render");
    assert.equal(more.textContent, t(CONVERSATION_KEYS.more));
    await act(async () => {
      more.click();
    });
    assert.deepEqual(
      olderRequests,
      ["s-1"],
      "activating it requests the pane's own session",
    );
    await mounted.unmount();
  });

  it("omits the load-older control on a ready empty page with no history", async () => {
    const conversation = createConversationStore();
    conversation.applyWindow("s-1", { entries: [], hasMore: false });
    const Pane = createConversationPane(t, conversation, {
      onSend: async () => ({ kind: "sent" }),
      onLoadOlder: () => {},
    });
    const mounted = await mount(createElement(Pane, { sessionId: "s-1" }));

    assert.ok(
      mounted.container.querySelector(
        `.${CONVERSATION_CLASS}__notice[data-state="empty"]`,
      ),
      "the empty notice renders",
    );
    assert.equal(
      mounted.container.querySelector(`.${CONVERSATION_CLASS}__more`),
      null,
      "no older history means no load-older control",
    );
    await mounted.unmount();
  });
});

describe("roster panel — readable status row (jsdom)", () => {
  it("renders title, one human status, facts, and hides the raw todo id", async () => {
    const now = Date.now();
    const store = createRosterStore();
    store.set({
      kind: "snapshot",
      snapshot: {
        schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
        dispatcherSessionId: "s-1",
        publishedAtMs: now,
        workers: [
          {
            kind: "worker",
            workerId: "063f41a2-9897-4936-95de-1cd3f2f76132",
            title: "Add guards",
            status: "running",
            todoId: "todo-7",
            startedAtMs: now - 185_000,
            toolCallCount: 1,
            delivered: false,
          },
        ],
        recentResult: null,
      },
    });
    const Panel = createRosterPanel(t, store);
    const mounted = await mount(createElement(Panel));
    const row = mounted.container.querySelector(
      ".multitask-dispatcher-roster-panel__row",
    );
    assert.ok(row);
    const text = row.textContent ?? "";
    assert.match(text, /Add guards/);
    assert.match(text, /Working/);
    assert.match(text, /3m 5s/);
    assert.match(text, /1 tool call/);
    assert.match(text, /started \d{2}:\d{2}/);
    // The raw status and todo id are data attributes, never visible words.
    assert.equal(row.getAttribute("data-status"), "running");
    assert.equal(row.getAttribute("data-todo-id"), "todo-7");
    assert.equal(text.includes("running"), false);
    assert.equal(text.includes("todo-7"), false);
    // The full worker id is never visible either.
    assert.equal(text.includes("063f41a2-9897"), false);
    assert.equal(
      (text.match(/Working/g) ?? []).length,
      1,
      "status is rendered exactly once",
    );
    await mounted.unmount();
  });
});
