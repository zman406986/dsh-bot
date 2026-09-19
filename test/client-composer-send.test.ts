/**
 * Ticket 92 — the wrapper composer's send path over the REAL composition
 * (live-found 2026-09-19, pass 5: clicking `.multitask-dispatcher-conv__send`
 * produced `发送失败——消息未送达。` and spent no model turn).
 *
 * The defect was the scope addressing: `sendPrompt` read the conversation
 * service as a PROPERTY off the session-scope context
 * (`sessions.scope(id).conversation`), which the live host cannot serve — the
 * cordis context proxy resolves a service property by walking the FIBER chain
 * from the accessing context (`cordis lib/index.js:672-694`), the scope fiber
 * is the no-op `agentScope` plugin (it injects nothing,
 * `dsh-api-session-controller lib/types/client/scope.js:21-36`), so the walk
 * reaches the root fiber and throws `cannot get property "conversation"
 * without inject` (`:690`). The host's own scoped shape is the SERVICE-METHOD
 * boundary (`dsh-client-ui-conversation lib/client.js:16500-16506`
 * `scopedConversation`, `:14375-14377` the queue dock):
 * `sessions.scope(id).get("conversation")` — which still rebinds `this.ctx`
 * to the scoped context, so the sink's own `scopeOf(this.ctx)` tag check
 * (`:3170-3181`) finds the session id.
 *
 * This suite renders the real `mountShellPage` composition (real stores, real
 * pane, real transport) with react-dom against jsdom and drives the composer
 * the way a user does: type, click send, press Enter. The fakes model the
 * host contract above — the property read throws exactly as it does live, so
 * a regression to the shipped shape fails here instead of live.
 *
 * Everything is offline (S8): jsdom stands in for the host renderer; no
 * network, no LLM, no live seam.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── jsdom globals BEFORE react-dom initializes (the host renderer's stand-in)

import { JSDOM } from "jsdom";

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
(globalThis as Record<string, unknown>)["MouseEvent"] = dom.window.MouseEvent;
(globalThis as Record<string, unknown>)["KeyboardEvent"] =
  dom.window.KeyboardEvent;
(globalThis as Record<string, unknown>)["Event"] = dom.window.Event;
(globalThis as Record<string, unknown>)["Node"] = dom.window.Node;
(globalThis as Record<string, unknown>)["getComputedStyle"] =
  dom.window.getComputedStyle;
(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

import { act, createElement } from "react";
// react-dom is imported DYNAMICALLY and only now: its module init decides
// whether the textarea `input` event is delegated, and imported before
// `document` exists React drops it — then no typing ever reaches the
// composer's `onChange` (verified against the installed react-dom 19.3).
const { createRoot } = await import("react-dom/client");

import type { ClientContext, ClientSessionsLike } from "../src/client/context.js";
import { mountShellPage } from "../src/client/index.js";
import { createDispatcherShell } from "../src/client/shell.js";
import { localeDictionary } from "../src/client/overlay.js";
import { createOnboardingStore } from "../src/client/onboarding.js";
import type { ConversationWindowLike } from "../src/client/conversation-store.js";
import type { ShellFeedSnapshotLike } from "../src/client/shell-feed.js";

// ── The host-faithful sessions fake (the ticket-92 contract, cited above)

function fakeSessions() {
  const feedListeners = new Set<() => void>();
  let feed: ShellFeedSnapshotLike = { ids: [], byId: {} };
  const windows = new Map<string, ConversationWindowLike>();
  const windowListeners = new Map<string, Set<() => void>>();
  /** Every prompt the scoped sink accepted, and every page it pulled. */
  const sent: { sessionId: string; text: string }[] = [];
  const olderPulls: string[] = [];

  const sessions: ClientSessionsLike = {
    list: {
      getSnapshot: () => feed,
      subscribe(listener: () => void) {
        feedListeners.add(listener);
        return () => feedListeners.delete(listener);
      },
    },
    scope: (id: string) => ({
      // The host's own scoped shape: `scoped.get("conversation")`.
      get(name: string): unknown {
        if (name !== "conversation") return undefined;
        return {
          // The tag-bound sink: only a call made through THIS scoped face
          // lands (the host checks `scopeOf(this.ctx)` inside `send`).
          send: async (text: string) => {
            sent.push({ sessionId: id, text });
          },
          loadOlder: async () => {
            olderPulls.push(id);
          },
        };
      },
      // The live host throws here — the shipped shape died on this read.
      get conversation(): never {
        throw new Error('cannot get property "conversation" without inject');
      },
    }),
    binding(id: string) {
      if (!windows.has(id)) return undefined;
      return {
        eventSource: {
          getSnapshot: () => windows.get(id) ?? {},
          subscribe(listener: () => void) {
            let set = windowListeners.get(id);
            if (set === undefined) {
              set = new Set();
              windowListeners.set(id, set);
            }
            set.add(listener);
            return () => set.delete(listener);
          },
        },
      };
    },
  };

  return {
    sessions,
    sent,
    olderPulls,
    publishFeed(next: ShellFeedSnapshotLike) {
      feed = next;
      for (const listener of [...feedListeners]) listener();
    },
    publishWindow(id: string, window: ConversationWindowLike) {
      windows.set(id, window);
      for (const listener of windowListeners.get(id) ?? []) listener();
    },
  };
}

/** The minimal module context `mountShellPage` reads (effect + sessions + locale). */
function createCompositionCtx(sessions: ClientSessionsLike) {
  return {
    effect(execute: () => unknown, label?: string) {
      void label;
      const returned = execute();
      return typeof returned === "function" ? returned : () => {};
    },
    sessions,
    locale: {
      register: () => () => {},
      bind(namespace: string) {
        void namespace;
        return (key: string) => localeDictionary.en[key] ?? key;
      },
    },
  } as unknown as ClientContext;
}

// ── Driving the rendered composer

function query(selector: string): Element | null {
  return dom.window.document.querySelector(selector);
}

/**
 * Type into the composer the way a browser does: the NATIVE value setter
 * (React installs an own value tracker on the node, so a plain assignment
 * never reaches `onChange`) plus the bubbling `input` event React delegates.
 */
function typeInto(field: Element, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  assert.ok(setter, "the textarea value setter must exist");
  setter.call(field, text);
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function pressEnter(field: Element, shiftKey = false): void {
  field.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function mountSelectedSession() {
  const fake = fakeSessions();
  const ctx = createCompositionCtx(fake.sessions);
  const mount = mountShellPage(ctx, { store: createOnboardingStore(), onSeen: () => {} });
  const Shell = createDispatcherShell(
    (key: string) => localeDictionary.en[key] ?? key,
    mount.store,
    mount.hosts,
  );
  const container = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Shell));
    fake.publishFeed({
      ids: ["s-plain"],
      byId: { "s-plain": { id: "s-plain", displayTitle: "Plain chat" } },
    });
    fake.publishWindow("s-plain", {
      entries: [
        {
          type: "event",
          event: {
            type: "user/message",
            seq: 1,
            time: 0,
            data: {
              id: "m-1",
              role: "user",
              content: [{ type: "text", text: "hello" }],
              source: { kind: "user" },
            },
          },
        },
      ],
      hasMore: true,
    });
    mount.store.select("s-plain");
  });
  const textarea = query(".multitask-dispatcher-conv__input");
  assert.ok(textarea, "the composer textarea renders for the selected session");
  return { fake, root, textarea };
}

describe("composer send over the real composition (ticket 92)", () => {
  it("hands the typed prompt to the session-scoped sink on click", async () => {
    const { fake, root, textarea } = await mountSelectedSession();
    await act(async () => {
      typeInto(textarea, "ship it");
    });
    const send = query(".multitask-dispatcher-conv__send");
    assert.ok(send, "the send button renders");
    assert.equal(
      send.hasAttribute("disabled"),
      false,
      "send enables on non-blank text",
    );

    await act(async () => {
      send.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    assert.deepEqual(
      fake.sent,
      [{ sessionId: "s-plain", text: "ship it" }],
      "the prompt reached the scoped sink with the right session",
    );
    // A resolved send clears the draft (the host owns the journal, A4) and
    // shows no failure line — the honest copy is for real failures only.
    assert.equal((textarea as HTMLTextAreaElement).value, "");
    assert.equal(query(".multitask-dispatcher-conv__status"), null);

    await act(async () => {
      root.unmount();
    });
  });

  it("submits on plain Enter, keeps Shift+Enter for the line break", async () => {
    const { fake, root, textarea } = await mountSelectedSession();
    await act(async () => {
      typeInto(textarea, "first line");
    });

    await act(async () => {
      pressEnter(textarea, true);
    });
    assert.deepEqual(fake.sent, [], "Shift+Enter must not send");

    await act(async () => {
      pressEnter(textarea);
    });
    assert.deepEqual(
      fake.sent,
      [{ sessionId: "s-plain", text: "first line" }],
      "plain Enter submits (the shipped composer's own gesture)",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("the older-pages affordance rides the same scoped method boundary", async () => {
    const { fake, root } = await mountSelectedSession();
    const more = query(".multitask-dispatcher-conv__more");
    assert.ok(more, "the affordance renders while the window reports hasMore");

    await act(async () => {
      more.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    assert.deepEqual(
      fake.olderPulls,
      ["s-plain"],
      "the scoped loadOlder verb was reached and called",
    );

    await act(async () => {
      root.unmount();
    });
  });
});
