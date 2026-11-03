/**
 * Ticket 123 — session-kind indicators (ADR-0024 rider + rider addendum),
 * extended by ticket 146 (the dispatcher mark is an animated bot portrait).
 *
 * Four claims pinned here:
 *
 * 1. **Kind resolution is a pure function over client-visible session
 *    facts.** Workers are `origin === 'subagent'` (durable header, ADR-0027
 *    §Settled 5); dispatchers are
 *    `projectionValues.sessionKind === 'dispatcher'` (the adapter's own
 *    projection, `src/adapter/session-kind-projection.ts`); everything else —
 *    including a missing or malformed row — is `normal`, which renders
 *    nothing.
 * 2. **Glyph rendering is fail-closed.** A worker glyph renders one marked
 *    span on a subagent session and `null` everywhere else; a dispatcher
 *    glyph mirrors that; a missing `sessionId`/`useSessions` renders `null`
 *    without calling a hook. The worker factory stays exported as retained
 *    machinery even though no seat composes it (see claim 3).
 * 3. **The composition registers one seat.** ADR-0024's 2026-10-18 rider
 *    licenses the `sidebar.session.row.leading` dispatcher cell, and it is
 *    again the only seat composed: ticket 140's
 *    `conversation.session.header.actions` chip was removed on 2026-10-28,
 *    when a summoned dispatcher became a top-level session with its own
 *    sidebar row. The WORKER marker is still declined (ticket 123 §B,
 *    2026-10-22): no seat composes `createSessionKindGlyph("worker", …)`.
 * 4. **The dispatcher mark is an inline SVG bot portrait with CSS motion**
 *    (ticket 146, owner ruling 2026-10-27): the wrapper's text body is gone,
 *    an `svg` is inside the mark, and the stylesheet carries `@keyframes`
 *    plus a `prefers-reduced-motion: reduce` override. jsdom cannot run
 *    animations, so the pins are structural only.
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
  DISPATCHER_GLYPH_ENTRY_ID,
  DISPATCHER_GLYPH_ORDER,
  SESSION_KIND_COPY_KEYS,
  SESSION_KIND_GLYPH_CSS,
  SIDEBAR_LEADING_SLOT,
  TEAM_LEADER_PROJECTION_VALUE,
  WORKER_GLYPH,
  createDispatcherClassGlyph,
  createSessionKindGlyph,
  dispatcherGlyphRegistration,
  isDispatcherKind,
  resolveSessionKind,
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

  it("identifies a SUMMONED dispatcher from the ticket-175 projection value", () => {
    assert.equal(
      resolveSessionKind({
        projectionValues: { sessionKind: TEAM_LEADER_PROJECTION_VALUE },
      }),
      "team-leader",
    );
    // The two dispatcher classes are distinct kinds, and both are dispatchers.
    assert.notEqual(TEAM_LEADER_PROJECTION_VALUE, DISPATCHER_PROJECTION_VALUE);
    assert.equal(isDispatcherKind("dispatcher"), true);
    assert.equal(isDispatcherKind("team-leader"), true);
    assert.equal(isDispatcherKind("worker"), false);
    assert.equal(isDispatcherKind("normal"), false);
  });

  it("an unknown projection value stays normal — never a guessed class", () => {
    // A value a later build adds must not be drawn as either class.
    assert.equal(
      resolveSessionKind({
        projectionValues: { sessionKind: "dispatcher-admiral" },
      }),
      "normal",
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

  it("no worker/header registration exists — that seat is not licensed", async () => {
    const sessionKind = await import("../src/client/session-kind.js");
    assert.equal(
      "workerGlyphRegistration" in sessionKind,
      false,
      "the header registration is gone, not merely uncomposed",
    );
    // The glyph itself and the worker copy stay: they are retained machinery
    // for a future ruling, not live surface.
    assert.equal(typeof sessionKind.WORKER_GLYPH, "string");
    assert.equal(
      sessionKind.SESSION_KIND_COPY_KEYS.worker,
      "indicator.worker",
    );
  });

  it("the two kinds' marks are distinct: the worker types a character, the dispatcher is drawn", async () => {
    const sessionKind = await import("../src/client/session-kind.js");
    // Ticket 146: the dispatcher body left the text-glyph seat — no text
    // constant is exported for it any more — while the retained worker marker
    // stays one character. The structural difference is rendered in the DOM
    // suite below.
    assert.equal(
      "DISPATCHER_GLYPH" in sessionKind,
      false,
      "the dispatcher mark is an SVG portrait, not a character",
    );
    assert.equal(WORKER_GLYPH.length, 1);
    assert.match(DISPATCHER_GLYPH_ENTRY_ID, /^multitask-dispatcher-/);
  });

  it("the glyph labels exist in both locale faces", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    for (const key of Object.values(SESSION_KIND_COPY_KEYS)) {
      assert.equal(typeof localeDictionary.en[key], "string", `en missing ${key}`);
      assert.equal(typeof localeDictionary.zh[key], "string", `zh missing ${key}`);
      assert.ok(localeDictionary.en[key]!.length > 0);
      assert.ok(localeDictionary.zh[key]!.length > 0);
    }
    // Ticket 177: the two dispatcher classes do not share a label — a screen
    // reader must be able to tell them apart, in both faces.
    assert.notEqual(
      localeDictionary.en["indicator.dispatcher"],
      localeDictionary.en["indicator.team-leader"],
    );
    assert.notEqual(
      localeDictionary.zh["indicator.dispatcher"],
      localeDictionary.zh["indicator.team-leader"],
    );
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
    // Ticket 146: the body is an inline SVG bot portrait, not a text glyph.
    const portrait = mark.querySelector("svg");
    assert.ok(portrait, "the mark carries an inline SVG portrait");
    assert.equal(portrait.getAttribute("width"), "16");
    assert.equal(portrait.getAttribute("height"), "16");
    assert.equal(portrait.getAttribute("aria-hidden"), "true");
    assert.equal(
      portrait.getAttribute("viewBox"),
      "0 0 16 16",
      "the drawing is authored on the 16×16 cell",
    );
    // The drawing is ours: eyes + head are present, so the portrait is not an
    // empty shell. No asset file, no data URI — inline shapes only.
    assert.ok(portrait.querySelectorAll("circle").length >= 1, "eyes drawn");
    assert.ok(portrait.querySelector("rect"), "head drawn");
    assert.equal(
      mark.querySelector("img"),
      null,
      "no raster/static asset smuggled in",
    );
    // The accessible name stays on the wrapper, so the wrapper's text content
    // is empty and the cell is glyph-only.
    assert.equal(mark.textContent, "");
    assert.equal(
      mark.getAttribute("aria-label"),
      localeDictionary.en["indicator.dispatcher"],
    );
    assert.equal(mark.getAttribute("role"), "img");
    await mounted.unmount();
  });

  it("the dispatcher mark differs structurally from the worker mark", async () => {
    const store = fakeUseSessions(
      snapshot({
        "s-disp": {
          projectionValues: { sessionKind: DISPATCHER_PROJECTION_VALUE },
        },
        "s-worker": { origin: "subagent" },
      }),
    );
    const DispatcherGlyph = createSessionKindGlyph("dispatcher", t);
    const WorkerGlyph = createSessionKindGlyph("worker", t);
    const dispatcher = await mount(
      createElement(DispatcherGlyph, {
        sessionId: "s-disp",
        useSessions: store.useSessions,
      }),
    );
    const worker = await mount(
      createElement(WorkerGlyph, {
        sessionId: "s-worker",
        useSessions: store.useSessions,
      }),
    );
    const dispatcherMark = dispatcher.container.querySelector(
      '[data-session-kind="dispatcher"]',
    );
    const workerMark = worker.container.querySelector(
      '[data-session-kind="worker"]',
    );
    assert.ok(dispatcherMark && workerMark);
    assert.notEqual(dispatcherMark.outerHTML, workerMark.outerHTML);
    assert.ok(dispatcherMark.querySelector("svg"), "dispatcher is drawn");
    assert.equal(workerMark.querySelector("svg"), null, "worker stays a character");
    assert.equal(workerMark.textContent, WORKER_GLYPH);
    await dispatcher.unmount();
    await worker.unmount();
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

  it("emits its own stylesheet; the reduced-motion override disables the motion", () => {
    // Ticket 146, structural only — jsdom cannot run animations, so the pins
    // are: our prefix everywhere, keyframes present, a reduced-motion
    // override that turns the animation off, and no raw colour literal.
    const bareClassSelectors = [
      ...SESSION_KIND_GLYPH_CSS.matchAll(/\.([a-zA-Z][\w-]*)/g),
    ]
      .map((match) => match[1])
      .filter((name) => !name.startsWith("multitask-dispatcher-"));
    assert.deepEqual(bareClassSelectors, [], "no shipped kit classes");

    const keyframes = [
      ...SESSION_KIND_GLYPH_CSS.matchAll(/@keyframes\s+([\w-]+)/g),
    ].map((match) => match[1]!);
    assert.deepEqual(
      [...keyframes].sort(),
      [
        "multitask-dispatcher-kind-glyph-blink",
        "multitask-dispatcher-kind-glyph-bob",
      ],
      "bob + blink keyframes, both prefixed",
    );

    // Every animation declaration names one of our keyframes, except the
    // reduced-motion override that switches motion off.
    const animations = [
      ...SESSION_KIND_GLYPH_CSS.matchAll(/animation:([^;}]+)/g),
    ].map((match) => match[1]!.trim());
    const running = animations.filter((value) => value !== "none");
    assert.equal(running.length, 2, "bob + blink: base animations only");
    for (const animation of running) {
      assert.match(animation, /^multitask-dispatcher-kind-glyph-/);
    }

    const reduced = SESSION_KIND_GLYPH_CSS.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\{([^}]*)\}/,
    );
    assert.ok(reduced, "the reduced-motion override exists");
    assert.match(reduced[1]!, /animation:none/);
    // Both animated parts are covered, so nothing keeps moving.
    assert.match(reduced[1]!, /multitask-dispatcher-kind-glyph__bot/);
    assert.match(reduced[1]!, /multitask-dispatcher-kind-glyph__eye/);

    // Theme contract (mirrors client-theme-tokens.test.ts's rules).
    assert.doesNotMatch(SESSION_KIND_GLYPH_CSS, /#[0-9a-fA-F]{3,8}\b/);
    assert.doesNotMatch(SESSION_KIND_GLYPH_CSS, /(?<![a-z])rgba?\(/);
    assert.doesNotMatch(SESSION_KIND_GLYPH_CSS, /hsla?\(/);
    assert.ok(!SESSION_KIND_GLYPH_CSS.includes("var(--dsw-alias-brand-primary)"));
    for (const token of SESSION_KIND_GLYPH_CSS.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)) {
      assert.match(token[1]!, /^--dsw-(alias|elevation)-[a-z0-9-]+$/);
    }
  });

  it("renders the stylesheet with the mark so the portrait is never unstyled", async () => {
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
    const style = mounted.container.querySelector("style");
    assert.ok(style, "the component emits its own <style>");
    assert.equal(style.textContent, SESSION_KIND_GLYPH_CSS);
    // The mark's own text body stays empty: the cell is glyph-only.
    const mark = mounted.container.querySelector('[data-session-kind="dispatcher"]');
    assert.ok(mark);
    assert.equal(mark.textContent, "");
    await mounted.unmount();
  });
});

describe("session-kind — two dispatcher classes (ticket 177)", () => {
  /** Both dispatcher rows in one snapshot, so one mount can compare them. */
  function classSnapshot(): SessionsSnapshotLike {
    return snapshot({
      "s-chief": {
        projectionValues: { sessionKind: DISPATCHER_PROJECTION_VALUE },
      },
      "s-leader": {
        projectionValues: { sessionKind: TEAM_LEADER_PROJECTION_VALUE },
      },
    });
  }

  it("the ONE composed cell marks both classes, each with its own portrait", async () => {
    const store = fakeUseSessions(classSnapshot());
    const Glyph = createDispatcherClassGlyph(t);
    const chief = await mount(
      createElement(Glyph, { sessionId: "s-chief", useSessions: store.useSessions }),
    );
    const leader = await mount(
      createElement(Glyph, { sessionId: "s-leader", useSessions: store.useSessions }),
    );

    const chiefMark = chief.container.querySelector(
      '[data-session-kind="dispatcher"]',
    );
    const leaderMark = leader.container.querySelector(
      '[data-session-kind="team-leader"]',
    );
    assert.ok(chiefMark, "the human-started class renders its own mark");
    assert.ok(leaderMark, "the summoned class renders its own mark");

    // Different pictures, not just different attributes: the two portraits
    // must not be the same drawing.
    const chiefSvg = chiefMark.querySelector("svg");
    const leaderSvg = leaderMark.querySelector("svg");
    assert.ok(chiefSvg, "chief of staff is drawn");
    assert.ok(leaderSvg, "team leader is drawn");
    assert.notEqual(chiefSvg.outerHTML, leaderSvg.outerHTML);

    // The silhouettes differ in a way the eye can see at 16px: the chief of
    // staff has a single antenna stem and round eyes, the team leader has a
    // flat banner bar and square eyes.
    assert.equal(
      chiefSvg.querySelectorAll("circle").length,
      3,
      "chief: one antenna dot + two round eyes",
    );
    assert.equal(
      leaderSvg.querySelectorAll("circle").length,
      0,
      "team leader: no round shapes at all",
    );

    // Each carries its own accessible name.
    assert.equal(
      chiefMark.getAttribute("aria-label"),
      localeDictionary.en["indicator.dispatcher"],
    );
    assert.equal(
      leaderMark.getAttribute("aria-label"),
      localeDictionary.en["indicator.team-leader"],
    );
    assert.notEqual(
      chiefMark.getAttribute("aria-label"),
      leaderMark.getAttribute("aria-label"),
    );

    // Both are glyph-only and both bring the shared stylesheet.
    assert.equal(chiefMark.textContent, "");
    assert.equal(leaderMark.textContent, "");
    assert.equal(
      chief.container.querySelector("style")?.textContent,
      SESSION_KIND_GLYPH_CSS,
    );
    assert.equal(
      leader.container.querySelector("style")?.textContent,
      SESSION_KIND_GLYPH_CSS,
      "the split adds no second stylesheet",
    );
    await chief.unmount();
    await leader.unmount();
  });

  it("the composed cell stays silent for a worker and a normal session", async () => {
    const store = fakeUseSessions(
      snapshot({
        "s-worker": { origin: "subagent" },
        "s-plain": { projectionValues: { sessionKind: null } },
      }),
    );
    const Glyph = createDispatcherClassGlyph(t);
    for (const sessionId of ["s-worker", "s-plain"]) {
      const mounted = await mount(
        createElement(Glyph, { sessionId, useSessions: store.useSessions }),
      );
      assert.equal(
        mounted.container.querySelector("[data-session-kind]"),
        null,
        `session ${sessionId}`,
      );
      await mounted.unmount();
    }
  });

  it("createSessionKindGlyph(\"dispatcher\") is now the chief-of-staff class ONLY", async () => {
    // The narrow factory is retained for a future single-class seat; it must
    // not silently draw the summoned class.
    const store = fakeUseSessions(classSnapshot());
    const ChiefGlyph = createSessionKindGlyph("dispatcher", t);
    const leader = await mount(
      createElement(ChiefGlyph, {
        sessionId: "s-leader",
        useSessions: store.useSessions,
      }),
    );
    assert.equal(leader.container.querySelector("[data-session-kind]"), null);
    await leader.unmount();

    const chief = await mount(
      createElement(ChiefGlyph, {
        sessionId: "s-chief",
        useSessions: store.useSessions,
      }),
    );
    assert.ok(chief.container.querySelector('[data-session-kind="dispatcher"]'));
    await chief.unmount();
  });

  it("the summoned class switches live when the projection value changes", async () => {
    // A cell settled before the mark source answered starts as nothing, then
    // resolves into the team-leader mark — the restart path.
    const store = fakeUseSessions(snapshot({ "s-later": {} }));
    const Glyph = createDispatcherClassGlyph(t);
    const mounted = await mount(
      createElement(Glyph, { sessionId: "s-later", useSessions: store.useSessions }),
    );
    assert.equal(mounted.container.querySelector("[data-session-kind]"), null);
    await act(async () => {
      store.publish(classSnapshot());
    });
    assert.equal(mounted.container.querySelector("[data-session-kind]"), null);
    await act(async () => {
      store.publish(
        snapshot({
          "s-later": {
            projectionValues: { sessionKind: TEAM_LEADER_PROJECTION_VALUE },
          },
        }),
      );
    });
    assert.ok(
      mounted.container.querySelector('[data-session-kind="team-leader"]'),
    );
    await mounted.unmount();
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
  it("registers the sidebar cell, one entry, and no header chip", () => {
    const ctx = createCompositionCtx();
    apply(ctx);

    const sidebar = ctx.injects.find(
      (record) => record.parent === SIDEBAR_LEADING_SLOT,
    );
    assert.ok(sidebar, "the dispatcher glyph injects into the sidebar cell");
    assert.equal(sidebar.entries.length, 1);
    assert.deepEqual(sidebar.entries[0]?.options, dispatcherGlyphRegistration());
    assert.equal(typeof sidebar.entries[0]?.component, "function");

    // The ticket-140 header chip was removed (2026-10-28): a summoned
    // dispatcher is a top-level session, so the sidebar cell marks it and a
    // header seat would double the mark.
    assert.equal(
      ctx.injects.find(
        (record) => record.parent === "conversation.session.header.actions",
      ),
      undefined,
      "no dispatcher chip in the conversation header",
    );
  });

  it("the composed component is bound to the dispatcher kind and the locale seat", async () => {
    const ctx = createCompositionCtx();
    apply(ctx);
    const sidebar = ctx.injects.find(
      (record) => record.parent === SIDEBAR_LEADING_SLOT,
    );
    const component = sidebar?.entries[0]?.component as
      | ((props: unknown) => unknown)
      | undefined;
    assert.ok(component);

    const store = fakeUseSessions(
      snapshot({
        "s-disp": {
          projectionValues: { sessionKind: DISPATCHER_PROJECTION_VALUE },
        },
        "s-worker": { origin: "subagent" },
        "s-plain": { projectionValues: { sessionKind: null } },
      }),
    );
    for (const [sessionId, expected] of [
      ["s-disp", true],
      ["s-worker", false],
      ["s-plain", false],
    ] as const) {
      const mounted = await mount(
        createElement(component, {
          sessionId,
          useSessions: store.useSessions,
        }),
      );
      const mark = mounted.container.querySelector(
        '[data-session-kind="dispatcher"]',
      );
      assert.equal(mark !== null, expected, `session ${sessionId}`);
      await mounted.unmount();
    }
  });
});
