/**
 * Ticket 88 — the conversation seat survives SELECTION (full-seat
 * composition, rendered).
 *
 * Live pass 4 (2026-09-19): clicking a session row in the elected frame
 * crashed the shell's render with Minified React error #300 and the host's
 * per-entry boundary abdicated the whole `root` cell to the stock frame.
 * Decoded against the vendored React 19.3 (facebook/react
 * scripts/error-codes/codes.json, v19.3.0): #300 = "Rendered fewer hooks
 * than expected. This may be caused by an accidental early return
 * statement." — the seat components were CALLED AS FUNCTIONS by the shell
 * (`hosts.onboarding()`, `hosts.conversation(id)` → `pane({sessionId})`,
 * `hosts.rosterPanel(id)` → `seatPanel()`), inlining their hooks into the
 * SHELL's own hook list, so the shell's hook count depended on the render
 * branch: no-selection = 1 (shell) + 2 (onboarding) hooks; selection drops
 * the onboarding seat → fewer hooks → #300.
 *
 * This suite renders the REAL composition — `mountShellPage`'s stores,
 * seats, and the `createDispatcherShell` frame — with react-dom against
 * jsdom, flips the selection the way the live click does (a real DOM click
 * on a sidebar row), and asserts the shell survives every transition:
 * onboarding → selected-with-history → plain session → back → removal
 * (deselect → onboarding remount). Host-faithful fakes model the verified
 * faces (`sessions.list`, `sessions.binding(id).eventSource`,
 * `sessions.scope(id).conversation.loadOlder`) — the 44/45/84/85 lesson.
 *
 * Everything here is offline (S8): jsdom only stands in for the DOM the
 * host's renderer provides; no network, no LLM, no live seam.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── jsdom globals (before react-dom is used; the host renderer's stand-in)

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

// react-dom reads these off the global scope. `navigator` already exists on
// Node >=21 as a read-only getter — redefine it (the host's client surface
// is a browser; the fake mirrors that).
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

// `act` discipline: react-dom must know this is a test environment.
(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ClientContext, ClientSessionsLike } from "../src/client/context.js";
import { mountShellPage } from "../src/client/index.js";
import { createDispatcherShell } from "../src/client/shell.js";
import {
  LOCALE_NAMESPACE,
  localeDictionary,
} from "../src/client/overlay.js";
import {
  createOnboardingStore,
  type OnboardingStore,
} from "../src/client/onboarding.js";
import type {
  ConversationEntryLike,
  ConversationWindowLike,
} from "../src/client/conversation-store.js";
import type { ShellFeedSnapshotLike } from "../src/client/shell-feed.js";
import type { RosterSnapshot } from "../src/core/roster-snapshot.js";
import type { WorkerStatus } from "../src/core/types.js";

// ── Host-faithful fakes (the verified faces; Finding 7 vocabulary)

let nextSeq = 100;
function event(type: string, data: unknown): ConversationEntryLike {
  return {
    type: "event",
    event: { type, seq: nextSeq++, time: 0, data },
  };
}

function userMessage(text: string): ConversationEntryLike {
  return event("user/message", {
    id: `m-${nextSeq}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

function assistantMessage(text: string): ConversationEntryLike {
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
  });
}

function toolCall(callId: string, name: string, args: unknown): ConversationEntryLike {
  return event("tool/call", {
    turn: 1,
    step: 1,
    callId,
    name,
    arguments: JSON.stringify(args),
  });
}

function toolResult(callId: string, resultText: string): ConversationEntryLike {
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
          content: [{ type: "text", text: resultText }],
        },
      ],
      source: { kind: "tool", callId },
    },
  });
}

function worker(workerId: string, status: WorkerStatus): RosterSnapshot["workers"][number] {
  return {
    kind: "worker",
    workerId,
    title: `Worker ${workerId}`,
    status,
    todoId: null,
    startedAtMs: 0,
    toolCallCount: 0,
    delivered: true,
    blocked: null,
  };
}

function dispatcherSnapshot(dispatcherSessionId: string): RosterSnapshot {
  return {
    schemaVersion: 4,
    dispatcherSessionId,
    publishedAtMs: 1_000,
    workers: [worker("w-1", "running")],
    recentResult: null,
      pendingAsks: [],
  };
}

/**
 * The sessions face the host serves: the sidebar list feed (live
 * subscribe/publish like `bindShellSessionsFeed` reads) plus per-session
 * bindings whose `eventSource` is an ObservableSnapshot window.
 *
 * Ticket 92 (live-found, 2026-09-19): the scope-addressed conversation face
 * is reached through the SERVICE-METHOD boundary, never the property read —
 * host citations:
 * - `sessions.scope(id)` → the Agent-scoped ctx, `dsh-api-session-controller
 *   lib/client.js:3254-3256` (tag minted by `createScope`,
 *   `lib/types/client/scope.js:27-36`).
 * - `scoped.get("conversation")` is the host's own scoped shape
 *   (`dsh-client-ui-conversation lib/client.js:16500-16506`
 *   `scopedConversation`, `:14375-14377` the queue dock).
 * - the PROPERTY read throws on the live host: the cordis context proxy
 *   resolves a service property by walking the FIBER chain from the accessing
 *   ctx (`cordis lib/index.js:672-694`) and the scope fiber injects nothing,
 *   so the walk reaches the root fiber and throws `cannot get property
 *   "conversation" without inject` (`:690`). The shipped `sendPrompt` died
 *   exactly there (ticket 92), so this fake throws the same way.
 */
function fakeSessions(initial: ShellFeedSnapshotLike) {
  const feedListeners = new Set<() => void>();
  let feed: ShellFeedSnapshotLike = initial;
  const windows = new Map<string, ConversationWindowLike>();
  const windowListeners = new Map<string, Set<() => void>>();
  /** Every prompt the scoped sink accepted (the send path's observable). */
  const sent: { sessionId: string; text: string }[] = [];

  const sessions: ClientSessionsLike = {
    list: {
      getSnapshot: () => feed,
      subscribe(listener: () => void) {
        feedListeners.add(listener);
        return () => feedListeners.delete(listener);
      },
    },
    scope: (id: string) => ({
      get(name: string): unknown {
        if (name !== "conversation") return undefined;
        return {
          loadOlder: () => Promise.resolve(),
          // The host's tag-bound sink: `scopeOf(this.ctx)` inside `send`
          // resolves THIS scope's id (client.js:3170-3181), so the fake only
          // accepts a call made through the scoped face.
          send: async (text: string) => {
            sent.push({ sessionId: id, text });
          },
        };
      },
      get conversation(): never {
        throw new Error(
          'cannot get property "conversation" without inject',
        );
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
    /** The prompts the scoped sink accepted (ticket 92's pin reads this). */
    sent,
    /** The host publishes a new sidebar list snapshot. */
    publishFeed(next: ShellFeedSnapshotLike) {
      feed = next;
      for (const listener of [...feedListeners]) listener();
    },
    /** The host opens/publishes one session's event window. */
    publishWindow(id: string, window: ConversationWindowLike) {
      windows.set(id, window);
      for (const listener of windowListeners.get(id) ?? []) listener();
    },
  };
}

/**
 * The minimal module context the shell mount reads: effect + locale +
 * sessions (the declared inject faces the mount path touches). Modeled on
 * the scaffold fake: effects run immediately and collect disposers.
 */
function createCompositionCtx(sessions: ClientSessionsLike) {
  const ctx = {
    effect(execute: () => unknown, label?: string) {
      void label;
      const returned = execute();
      const dispose = typeof returned === "function" ? returned : () => {};
      return dispose;
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
  return { ctx };
}

// ── The composition under test (real stores, real seats, real shell)

const SHELL = '[data-shell="dispatcher"]';
const CONV = '[data-pane="conversation"]';
const ROSTER = "[data-pane='right'] .multitask-dispatcher-roster-panel";

function query(selector: string): Element | null {
  return dom.window.document.querySelector(selector);
}

function clickRow(sessionId: string): void {
  const button = dom.window.document.querySelector(
    `button[data-session-id="${sessionId}"]`,
  );
  assert.ok(button, `row for ${sessionId} must be rendered`);
  button.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}

function mountComposition(sessions: ClientSessionsLike, onboarding: OnboardingStore) {
  const { ctx } = createCompositionCtx(sessions);
  // The REAL shell-page composition: feed bindings, conversation pane
  // factory, hosted roster panel seat, onboarding seat — the same
  // `mountShellPage` body the `main` page and the `root` frame register.
  const mount = mountShellPage(ctx, {
    store: onboarding,
    onSeen: () => {},
  });
  const Shell = createDispatcherShell(
    (key: string) => localeDictionary.en[key] ?? key,
    mount.store,
    mount.hosts,
  );
  const container = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(container);
  const root = createRoot(container);
  return { mount, Shell, root };
}

describe("shell seat composition survives selection (ticket 88)", () => {
  it("flips no-selection → selected-with-history → plain → back → removal without unmounting the shell", async () => {
    const fake = fakeSessions({
      ids: [],
      byId: {},
    });
    const onboarding = createOnboardingStore();
    const { mount, Shell, root } = mountComposition(fake.sessions, onboarding);

    // Boot: the elected frame renders the first-run onboarding seat in the
    // no-selection state (the live pass-4 state before the click).
    await act(async () => {
      root.render(createElement(Shell));
    });
    assert.ok(query(SHELL), "shell frame must stay mounted");
    const onboardingSeat = query("[data-onboarding]");
    assert.ok(onboardingSeat, "no-selection state hosts the onboarding seat");
    assert.equal(onboardingSeat.getAttribute("data-onboarding"), "beats");
    assert.equal(query(CONV), null, "no conversation seat before selection");
    assert.equal(query(ROSTER), null, "no roster before selection");

    // The host delivers one dispatcher session (mirror + history window)
    // and one plain session (a window with one turn).
    await act(async () => {
      mount.store.applySessionMirror("s-disp", dispatcherSnapshot("s-disp"));
      fake.publishFeed({
        ids: ["s-disp", "s-plain"],
        byId: {
          "s-disp": { id: "s-disp", displayTitle: "Dispatcher run" },
          "s-plain": { id: "s-plain", displayTitle: "Plain chat" },
        },
      });
      fake.publishWindow("s-disp", {
        entries: [
          userMessage("build the thing"),
          toolCall("call-1", "spawn_worker", { title: "w" }),
          toolResult("call-1", '{"outcome":"spawned"}'),
          assistantMessage("spawned the worker"),
        ],
        hasMore: false,
      });
      fake.publishWindow("s-plain", {
        entries: [userMessage("hello")],
        hasMore: false,
      });
    });
    assert.ok(query(SHELL), "shell survives feed updates");
    assert.ok(query("[data-onboarding]"), "still no-selection: onboarding");

    // THE LIVE CRASH: click the dispatcher session row. Before the fix this
    // re-render dropped the inlined onboarding hooks → React #300 → the
    // host abdicated the root cell. The shell must keep its seat instead.
    await act(async () => {
      clickRow("s-disp");
    });
    assert.ok(query(SHELL), "shell frame must survive selection (no #300)");
    assert.equal(query("[data-onboarding]"), null, "onboarding seat unmounted");
    assert.ok(query(CONV), "conversation seat mounted for the selected session");
    assert.ok(
      query(`${CONV} [data-role="user"]`),
      "history user turn renders",
    );
    assert.ok(
      query(`${CONV} [data-role="assistant"]`),
      "history assistant turn renders",
    );
    assert.ok(query(`${CONV} details[data-tool="spawn_worker"]`), "tool row renders");
    assert.ok(query(ROSTER), "hosted roster panel mounts for the mirrored session");
    assert.equal(
      query('button[data-session-id="s-disp"]')?.getAttribute("data-selected"),
      "true",
      "row reflects the selection",
    );

    // Switch to the plain session: the roster seat unmounts (no mirror →
    // the right pane hosts nothing) — historically the same hook-count
    // crash class on the flip back.
    await act(async () => {
      clickRow("s-plain");
    });
    assert.ok(query(SHELL), "shell survives switching to a plain session");
    assert.ok(query(CONV), "conversation seat rebinds to the plain session");
    assert.ok(
      query(`${CONV} [data-role="user"]`),
      "plain session's turn renders",
    );
    assert.equal(query(ROSTER), null, "no roster for a non-dispatcher session");

    // …and back: the roster seat remounts. Repeat the flip to shake out
    // any accumulated hook drift.
    for (let round = 0; round < 2; round += 1) {
      await act(async () => {
        clickRow("s-disp");
      });
      assert.ok(query(SHELL), `shell survives flip back (round ${round})`);
      assert.ok(query(ROSTER), `roster remounts (round ${round})`);
      await act(async () => {
        clickRow("s-plain");
      });
      assert.ok(query(SHELL), `shell survives flip away (round ${round})`);
      assert.equal(query(ROSTER), null, `roster unmounts again (round ${round})`);
    }

    // Feed removal of the selected session resets the selection: the shell
    // returns to the no-selection state and the onboarding seat REMOUNTS.
    await act(async () => {
      clickRow("s-disp");
      fake.publishFeed({
        ids: ["s-plain"],
        byId: { "s-plain": { id: "s-plain", displayTitle: "Plain chat" } },
      });
    });
    assert.ok(query(SHELL), "shell survives the removal reset");
    assert.ok(query("[data-onboarding]"), "onboarding seat remounts on deselect");
    assert.equal(query(CONV), null, "conversation seat unmounted with the selection");
    assert.equal(query(ROSTER), null, "roster unmounted with the selection");

    // The selection that started all of this also rode the host's open
    // verb — assert it was actually delivered (the guarded binding path).
    assert.equal(mount.store.getBox().state.selection.kind, "none");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders a selected session whose window is still mid-load without crashing, and fills it live", async () => {
    // The live click happened immediately after boot: the binding existed
    // (the session was staged by the click) but the window had not delivered
    // readable entries. Loading-state rendering had the thinnest coverage.
    // Host semantics: the binding's face exists, the snapshot is not yet an
    // entries-array window → the store's honest UNAVAILABLE (unreadable is
    // not empty); the pane never fabricates a transcript.
    const fake = fakeSessions({
      ids: ["s-late"],
      byId: { "s-late": { id: "s-late", displayTitle: "Late window" } },
    });
    // The staged session's window exists but carries nothing readable yet.
    fake.publishWindow("s-late", {});
    const onboarding = createOnboardingStore();
    const { mount, Shell, root } = mountComposition(fake.sessions, onboarding);

    await act(async () => {
      root.render(createElement(Shell));
    });
    await act(async () => {
      clickRow("s-late");
    });
    assert.ok(query(SHELL), "shell survives selecting a session mid-load");
    assert.ok(query(CONV), "conversation seat mounts while the window loads");
    assert.ok(
      query(`${CONV} [data-state="unavailable"]`),
      "honest unreadable-window copy, never a fabricated transcript",
    );
    await act(async () => {
      // The readable window arrives live (host push): the seat fills in.
      fake.publishWindow("s-late", {
        entries: [userMessage("hi")],
        hasMore: true,
      });
    });
    assert.ok(query(SHELL), "shell survives the live window publication");
    assert.ok(query(`${CONV} [data-role="user"]`), "late history renders live");
    assert.ok(query(`${CONV} button`), "hasMore affordance renders");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders pending while the seen read is in flight and settles on the document's arrival — never the flow (ticket 87)", async () => {
    // The live pass-4 reload-#1 ordering: the scope binds while the describe
    // read is on the wire (`loading`, no value) — the persisted seen record
    // stands but is NOT YET DELIVERED. Pre-fix the pane rendered the flow
    // from the fail-open default in that window (the observed re-show).
    const fake = fakeSessions({ ids: [], byId: {} });
    const onboarding = createOnboardingStore();
    onboarding.applySnapshot("loading", undefined);
    const { Shell, root } = mountComposition(fake.sessions, onboarding);

    await act(async () => {
      root.render(createElement(Shell));
    });
    const seat = query("[data-onboarding]");
    assert.ok(seat, "no-selection state hosts the onboarding seat");
    assert.equal(
      seat.getAttribute("data-onboarding"),
      "pending",
      "an in-flight read must buffer, not render the flow",
    );

    // The served document arrives through the SAME watch: the suppression
    // decision re-evaluates reactively — settled, never through a beats
    // render.
    await act(async () => {
      onboarding.applySnapshot("ready", { onboarding: { seen: true } });
    });
    assert.equal(
      query("[data-onboarding]")?.getAttribute("data-onboarding"),
      "settled",
      "the arrival settles the pane on the persisted record",
    );

    await act(async () => {
      root.unmount();
    });
  });
});

describe("copy-session-id affordance on dispatcher rows (ticket 70 chunk 3)", () => {
  it("renders on dispatcher rows only, shows the id verbatim, and copies it through the host seam", async () => {
    const fake = fakeSessions({
      ids: [],
      byId: {},
    });
    const onboarding = createOnboardingStore();
    const { ctx } = createCompositionCtx(fake.sessions);
    const mount = mountShellPage(ctx, {
      store: onboarding,
      onSeen: () => {},
    });
    // The clipboard seam the live composition would wire from the host;
    // the recorder stands in for it (the affordance is our only new host
    // touchpoint and must carry exactly the session id).
    const copied: string[] = [];
    const Shell = createDispatcherShell(
      (key: string) => localeDictionary.en[key] ?? key,
      mount.store,
      { ...mount.hosts, copyToClipboard: (text: string) => void copied.push(text) },
    );
    const container = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(Shell));
      mount.store.applySessionMirror("s-disp", dispatcherSnapshot("s-disp"));
      fake.publishFeed({
        ids: ["s-disp", "s-plain"],
        byId: {
          "s-disp": { id: "s-disp", displayTitle: "Dispatcher run" },
          "s-plain": { id: "s-plain", displayTitle: "Plain chat" },
        },
      });
    });

    // Dispatcher row: affordance present, id verbatim as its text and title.
    const copyButton = query('button[data-copy-id="s-disp"]');
    assert.ok(copyButton, "dispatcher row carries the copy-id affordance");
    assert.equal(copyButton.getAttribute("title"), "s-disp");
    assert.equal(copyButton.textContent, "s-disp");
    // Plain session: no affordance (it is not a peer address).
    assert.equal(
      query('button[data-copy-id="s-plain"]'),
      null,
      "non-dispatcher rows carry no id affordance",
    );

    await act(async () => {
      copyButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(copied, ["s-disp"]);

    await act(async () => {
      root.unmount();
    });
  });
});
