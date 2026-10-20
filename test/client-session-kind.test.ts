/**
 * Ticket 123 — session-kind indicators (ADR-0024 rider + rider addendum).
 *
 * Three claims pinned here:
 *
 * 1. **Kind resolution is a pure function over client-visible session
 *    facts.** Workers are `origin === 'subagent'` (durable header, ADR-0027
 *    §Settled 5); dispatchers would be
 *    `projectionValues.agentPreset === 'multitask-dispatcher'` (ADR-0027
 *    §Settled 4, conditional); everything else — including a missing or
 *    malformed row — is `normal`, which renders nothing.
 * 2. **Glyph rendering is fail-closed.** A worker glyph renders one marked
 *    span on a subagent session and `null` everywhere else; a dispatcher
 *    glyph mirrors that; a missing `sessionId`/`useSessions` renders `null`
 *    without calling a hook.
 * 3. **The composition is exactly ONE additive header entry.** The sidebar
 *    `sidebar.session.row.leading` seat is NOT composed, because no durable
 *    dispatcher identity exists on dsh 0.2.1-rc.2 today (verified: no
 *    `multitask-dispatcher` preset row in `dsh --profile web|multitask
 *    --dump-config`; every durable session header carries
 *    `"agentPreset":"standard"`). Shipping a glyph that can never fire would
 *    mislabel nothing but claim a capability that does not exist.
 *
 * Rendering is jsdom + react-dom (the established `test/client-*.test.ts`
 * idiom). Everything is offline (S8): no network, no LLM, no live seam.
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
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  configurable: true,
});

import { act, createElement, useSyncExternalStore } from "react";
const { createRoot } = await import("react-dom/client");

import { apply } from "../src/client/index.js";
import type { ClientContext } from "../src/client/context.js";
import {
  LOCALE_NAMESPACE,
  localeDictionary,
  validateLocaleDictionary,
} from "../src/client/overlay.js";
import {
  DISPATCHER_PROJECTION_KEY,
  DISPATCHER_PROJECTION_VALUE,
  DISPATCHER_GLYPH,
  DISPATCHER_GLYPH_ENTRY_ID,
  DISPATCHER_GLYPH_ORDER,
  HEADER_ACTIONS_SLOT,
  SESSION_KIND_COPY_KEYS,
  SIDEBAR_LEADING_SLOT,
  WORKER_GLYPH,
  WORKER_GLYPH_ENTRY_ID,
  WORKER_GLYPH_ORDER,
  createSessionKindGlyph,
  dispatcherGlyphRegistration,
  resolveSessionKind,
  workerGlyphRegistration,
  type SessionsSnapshotLike,
  type UseSessionsLike,
} from "../src/client/session-kind.js";

const t = (key: string): string => localeDictionary.en[key] ?? key;

/** One session-list snapshot with the given rows. */
function snapshot(
  rows: Record<string, Record<string, unknown>>,
): SessionsSnapshotLike {
  return { byId: rows };
}

/** A `useSessions` stand-in backed by a real external store. */
function fakeUseSessions(initial: SessionsSnapshotLike): {
  useSessions: UseSessionsLike;
  publish(next: SessionsSnapshotLike): void;
} {
  const listeners = new Set<() => void>();
  let current = initial;
  const useSessions: UseSessionsLike = (selector) =>
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => selector(current),
    );
  return {
    useSessions,
    publish(next) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Mount one element into a fresh container and return the container. */
async function mount(element: ReturnType<typeof createElement>): Promise<{
  container: HTMLElement;
  root: ReturnType<typeof createRoot>;
  unmount(): Promise<void>;
}> {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    root,
    async unmount() {
      await act(async () => root.unmount());
    },
  };
}

describe("session-kind — pure resolution", () => {
  it("identifies a worker from the durable `origin: 'subagent'` header fact", () => {
    assert.equal(resolveSessionKind({ origin: "subagent" }), "worker");
  });

  it("identifies a dispatcher from the projection value ADR-0027 names", () => {
    assert.equal(
      resolveSessionKind({
        projectionValues: { sessionKind: DISPATCHER_PROJECTION_VALUE },
      }),
      "dispatcher",
    );
  });

  it("renders normal for an ordinary session", () => {
    assert.equal(
      resolveSessionKind({ projectionValues: { sessionKind: null } }),
      "normal",
    );
    assert.equal(resolveSessionKind({}), "normal");
    assert.equal(resolveSessionKind({ origin: "something-else" }), "normal");
  });

  it("origin wins over preset — a worker inherits its dispatcher's preset", () => {
    // ADR-0027 §Settled 5: workers inherit the parent's preset, so a
    // preset-first check would label a worker as a dispatcher.
    assert.equal(
      resolveSessionKind({
        origin: "subagent",
        projectionValues: { sessionKind: DISPATCHER_PROJECTION_VALUE },
      }),
      "worker",
    );
  });

  it("fails closed on missing, malformed, and wrong-typed facts", () => {
    assert.equal(resolveSessionKind(undefined), "normal");
    assert.equal(resolveSessionKind(null), "normal");
    assert.equal(
      resolveSessionKind({ projectionValues: null } as never),
      "normal",
    );
    assert.equal(
      resolveSessionKind({ projectionValues: "standard" } as never),
      "normal",
    );
    assert.equal(
      resolveSessionKind({
        projectionValues: { sessionKind: 42 },
      } as never),
      "normal",
    );
  });
});

describe("session-kind — registration contracts", () => {
  it("the worker glyph is an additive LIST entry in the header actions band", () => {
    const registration = workerGlyphRegistration();
    assert.deepEqual(registration, {
      name: HEADER_ACTIONS_SLOT,
      id: WORKER_GLYPH_ENTRY_ID,
      order: WORKER_GLYPH_ORDER,
      locale: LOCALE_NAMESPACE,
    });
    // List entries are keyed by `id`; no identity-axis collision with the
    // stock `subagent-catalog` (order 10) or `job-list` (order 20).
    assert.ok(registration.order < 10);
    assert.notEqual(registration.id, "subagent-catalog");
  });

  it("the dispatcher cell contract targets the sidebar leading slot, higher than the stock schedule mark", () => {
    const registration = dispatcherGlyphRegistration();
    assert.deepEqual(registration, {
      name: SIDEBAR_LEADING_SLOT,
      id: DISPATCHER_GLYPH_ENTRY_ID,
      order: DISPATCHER_GLYPH_ORDER,
      locale: LOCALE_NAMESPACE,
    });
    // The stock schedule plugin occupies the same 16px cell at order 10
    // (`dsh-client-ui-schedule/lib/client.js:7528`); a higher order keeps it
    // in front and never shadows it.
    assert.ok(registration.order > 10);
  });

  it("the two glyphs and entry ids are distinct and plugin-prefixed", () => {
    assert.notEqual(DISPATCHER_GLYPH, WORKER_GLYPH);
    assert.notEqual(DISPATCHER_GLYPH_ENTRY_ID, WORKER_GLYPH_ENTRY_ID);
    assert.match(DISPATCHER_GLYPH_ENTRY_ID, /^multitask-dispatcher-/);
    assert.match(WORKER_GLYPH_ENTRY_ID, /^multitask-dispatcher-/);
  });

  it("the glyph labels exist in both locale faces", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    for (const key of Object.values(SESSION_KIND_COPY_KEYS)) {
      assert.equal(typeof localeDictionary.en[key], "string", `en missing ${key}`);
      assert.equal(typeof localeDictionary.zh[key], "string", `zh missing ${key}`);
      assert.ok(localeDictionary.en[key]!.length > 0);
      assert.ok(localeDictionary.zh[key]!.length > 0);
    }
  });
});

describe("session-kind — worker glyph rendering (jsdom)", () => {
  it("renders the worker mark on a subagent session", async () => {
    const store = fakeUseSessions(snapshot({ "s-worker": { origin: "subagent" } }));
    const WorkerGlyph = createSessionKindGlyph("worker", t);
    const mounted = await mount(
      createElement(WorkerGlyph, {
        sessionId: "s-worker",
        useSessions: store.useSessions,
      }),
    );
    const mark = mounted.container.querySelector(
      '[data-session-kind="worker"]',
    );
    assert.ok(mark, "the worker mark renders");
    assert.equal(mark.textContent, WORKER_GLYPH);
    assert.equal(mark.getAttribute("role"), "img");
    assert.equal(
      mark.getAttribute("aria-label"),
      localeDictionary.en["indicator.worker"],
    );
    await mounted.unmount();
  });

  it("renders nothing for a normal session", async () => {
    const store = fakeUseSessions(
      snapshot({ "s-plain": { projectionValues: { sessionKind: null } } }),
    );
    const WorkerGlyph = createSessionKindGlyph("worker", t);
    const mounted = await mount(
      createElement(WorkerGlyph, {
        sessionId: "s-plain",
        useSessions: store.useSessions,
      }),
    );
    assert.equal(mounted.container.querySelector("[data-session-kind]"), null);
    assert.equal(mounted.container.textContent, "");
    await mounted.unmount();
  });

  it("renders nothing for a session the snapshot does not know yet", async () => {
    const store = fakeUseSessions(snapshot({}));
    const WorkerGlyph = createSessionKindGlyph("worker", t);
    const mounted = await mount(
      createElement(WorkerGlyph, {
        sessionId: "s-unknown",
        useSessions: store.useSessions,
      }),
    );
    assert.equal(mounted.container.querySelector("[data-session-kind]"), null);
    await mounted.unmount();
  });

  it("appears when the snapshot learns the session (live selector)", async () => {
    const store = fakeUseSessions(snapshot({}));
    const WorkerGlyph = createSessionKindGlyph("worker", t);
    const mounted = await mount(
      createElement(WorkerGlyph, {
        sessionId: "s-later",
        useSessions: store.useSessions,
      }),
    );
    assert.equal(mounted.container.querySelector("[data-session-kind]"), null);
    await act(async () => {
      store.publish(snapshot({ "s-later": { origin: "subagent" } }));
    });
    assert.ok(mounted.container.querySelector('[data-session-kind="worker"]'));
    await mounted.unmount();
  });

  it("fails closed when the renderer hands no session id or no hook", async () => {
    const store = fakeUseSessions(snapshot({ "s-x": { origin: "subagent" } }));
    const WorkerGlyph = createSessionKindGlyph("worker", t);
    for (const props of [{}, { sessionId: "s-x" }, { useSessions: store.useSessions }]) {
      const mounted = await mount(createElement(WorkerGlyph, props));
      assert.equal(mounted.container.querySelector("[data-session-kind]"), null);
      await mounted.unmount();
    }
  });
});

describe("session-kind — dispatcher glyph rendering (jsdom)", () => {
  it("renders the dispatcher mark on a dispatcher session", async () => {
    const store = fakeUseSessions(
      snapshot({
        "s-disp": {
          projectionValues: { sessionKind: DISPATCHER_PROJECTION_VALUE },
        },
      }),
    );
    const DispatcherGlyph = createSessionKindGlyph("dispatcher", t);
    const mounted = await mount(
      createElement(DispatcherGlyph, {
        sessionId: "s-disp",
        useSessions: store.useSessions,
      }),
    );
    const mark = mounted.container.querySelector(
      '[data-session-kind="dispatcher"]',
    );
    assert.ok(mark, "the dispatcher mark renders");
    assert.equal(mark.textContent, DISPATCHER_GLYPH);
    // One character is the only safe fit for the stock 16px cell.
    assert.equal(DISPATCHER_GLYPH.length, 1);
    assert.equal(
      mark.getAttribute("aria-label"),
      localeDictionary.en["indicator.dispatcher"],
    );
    await mounted.unmount();
  });

  it("renders nothing on a worker or a normal session", async () => {
    const store = fakeUseSessions(
      snapshot({
        "s-worker": { origin: "subagent" },
        "s-plain": { projectionValues: { sessionKind: null } },
      }),
    );
    const DispatcherGlyph = createSessionKindGlyph("dispatcher", t);
    for (const sessionId of ["s-worker", "s-plain"]) {
      const mounted = await mount(
        createElement(DispatcherGlyph, {
          sessionId,
          useSessions: store.useSessions,
        }),
      );
      assert.equal(mounted.container.querySelector("[data-session-kind]"), null);
      await mounted.unmount();
    }
  });
});

// ── The composition (the fake mirrors test/client-toolviews.test.ts's seam)

interface FakeEntry {
  options: Record<string, unknown>;
  component: unknown;
}

function createCompositionCtx() {
  const locales = new Map<string, unknown>();
  const injects: Array<{ parent: string; entries: FakeEntry[] }> = [];
  const ctx = {
    effect(execute: () => unknown) {
      const returned = execute();
      void returned;
      return () => {};
    },
    slots: {
      inject(parent: string, callback: () => unknown) {
        const record = { parent, entries: [] as FakeEntry[] };
        injects.push(record);
        callback();
        return () => {
          const at = injects.indexOf(record);
          if (at >= 0) injects.splice(at, 1);
        };
      },
      register(rawOptions: unknown, component: unknown) {
        const owner = injects.at(-1);
        assert.ok(owner, "slots.register outside of slots.inject (fake)");
        owner.entries.push({
          options: { ...(rawOptions as Record<string, unknown>) },
          component,
        });
        return () => {};
      },
    },
    locale: {
      register(namespace: string, dictionary: unknown) {
        locales.set(namespace, dictionary);
        return () => {
          locales.delete(namespace);
        };
      },
      bind(namespace: string) {
        return (key: string) =>
          (locales.get(namespace) as { en: Record<string, string> } | undefined)
            ?.en[key] ?? key;
      },
    },
    injects,
    locales,
  };
  return ctx as typeof ctx & ClientContext;
}

describe("session-kind — the default composition", () => {
  it("registers the worker header entry and the dispatcher sidebar cell", () => {
    const ctx = createCompositionCtx();
    apply(ctx);

    const header = ctx.injects.find(
      (record) => record.parent === HEADER_ACTIONS_SLOT,
    );
    assert.ok(header, "the worker glyph injects into the header actions band");
    assert.equal(header.entries.length, 1);
    assert.deepEqual(header.entries[0]?.options, workerGlyphRegistration());
    assert.equal(typeof header.entries[0]?.component, "function");

    // The dispatcher identity is real now: the adapter's `sessionKind`
    // projection marks an activated dispatcher durably, so the sidebar cell
    // carries a glyph that can actually fire.
    const sidebar = ctx.injects.find(
      (record) => record.parent === SIDEBAR_LEADING_SLOT,
    );
    assert.ok(sidebar, "the dispatcher glyph injects into the sidebar cell");
    assert.equal(sidebar.entries.length, 1);
    assert.deepEqual(sidebar.entries[0]?.options, dispatcherGlyphRegistration());
    assert.equal(typeof sidebar.entries[0]?.component, "function");
  });

  it("the composed component is bound to the worker kind and the locale seat", async () => {
    const ctx = createCompositionCtx();
    apply(ctx);
    const header = ctx.injects.find(
      (record) => record.parent === HEADER_ACTIONS_SLOT,
    );
    const component = header?.entries[0]?.component as
      | ((props: unknown) => unknown)
      | undefined;
    assert.ok(component);

    const store = fakeUseSessions(
      snapshot({
        "s-worker": { origin: "subagent" },
        "s-plain": { projectionValues: { sessionKind: null } },
      }),
    );
    for (const [sessionId, expected] of [
      ["s-worker", true],
      ["s-plain", false],
    ] as const) {
      const mounted = await mount(
        createElement(component, {
          sessionId,
          useSessions: store.useSessions,
        }),
      );
      const mark = mounted.container.querySelector('[data-session-kind="worker"]');
      assert.equal(mark !== null, expected, `session ${sessionId}`);
      await mounted.unmount();
    }
  });
});
