/**
 * Ticket 100 — floating dispatcher window + stock-UI launcher (ADR-0021).
 *
 * Four layers, all offline:
 *
 * 1. PURE STORE (`floating-window-store.ts`): open/close/toggle, the
 *    default top-right placement, and the drag clamp — the window can
 *    never be dragged wholly off-screen, and a viewport smaller than the
 *    peek margin pins deterministically.
 * 2. REGISTRATION over the fake seams (the shell-mount/overlay pin
 *    style): apply registers exactly ONE `shell.overlay` entry — the
 *    launcher (unique `multitask-dispatcher-` id, additive list slot) —
 *    and the default posture STILL claims no `root` cell, no `main` cell,
 *    and never the shipped `conversation` page key (stock dsh stays
 *    primary; ADR-0021 decision 1).
 * 3. THE REAL DATA PATH: the launcher inject creates the floating
 *    window's shell mount at the composition's `mounts` push-site — the
 *    real `mountShellPage` machinery again — so the composition's feeds
 *    (approvals + per-session mirrors) reach the mount's own stores, and
 *    fiber teardown detaches them.
 * 4. CRASH ISOLATION, rendered (the ticket-88 jsdom harness): the window's
 *    own error boundary (`DispatcherWindowBoundary`) sits between the
 *    portal and the hosted shell, so a shell-tree crash renders the
 *    honest failed line while the window chrome and the launcher chip are
 *    untouched; the host's per-entry boundary stands underneath as the
 *    recorded second layer (dsh-capsule-seams.md Seam 1 — a crashing list
 *    entry abdicates, siblings and the app stand). Close + reopen mounts
 *    a fresh boundary (the store's `openEpoch`) and recovers.
 *
 * jsdom stands in for the DOM the host renderer provides (S8: no network,
 * no LLM, no live seam); pointer/drag events are dispatched as real DOM
 * events and clamped by the REAL store math.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── jsdom globals (before react-dom is used; the host renderer's stand-in)

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
(globalThis as Record<string, unknown>)["Event"] = dom.window.Event;
(globalThis as Record<string, unknown>)["Node"] = dom.window.Node;
(globalThis as Record<string, unknown>)["getComputedStyle"] =
  dom.window.getComputedStyle;
(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

import { act } from "react";
import { createElement } from "react";
import type { JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apply, applyClientModule } from "../src/client/index.js";
import type { ClientContext } from "../src/client/context.js";
import { createRosterStore } from "../src/client/roster-store.js";
import { createDispatcherShell } from "../src/client/shell.js";
import {
  createFloatingWindowStore,
  FLOATING_WINDOW_HEIGHT,
  FLOATING_WINDOW_MIN_PEEK,
  FLOATING_WINDOW_WIDTH,
  clampWindowPosition,
  defaultWindowPlacement,
} from "../src/client/floating-window-store.js";
import {
  DispatcherWindowBoundary,
  createLauncherChip,
  describeFloatingWindow,
  disposeWindowLayer,
} from "../src/client/floating-window.js";
import {
  LAUNCHER_ENTRY_ID,
  LOCALE_NAMESPACE,
  SHELL_OVERLAY_SLOT,
  ROSTER_ENTRY_ID,
  launcherOverlayRegistration,
  localeDictionary,
} from "../src/client/overlay.js";
import { SETTINGS_PLUGIN_ITEM_SLOT } from "../src/client/settings-card-store.js";
import { TOOL_CALL_TOOLVIEW_SLOT } from "../src/client/toolviews.js";
import {
  MAIN_PAGE_SLOT,
  ROOT_FRAME_SLOT,
  SHIPPED_MAIN_PAGE_KEY,
} from "../src/client/shell-mount.js";
import type { RosterSnapshot } from "../src/core/roster-snapshot.js";

const t = (key: string): string => localeDictionary.en[key] ?? key;

// ── 1. The pure placement store ───────────────────────────────────────────

describe("floating window store (ticket 100) — open/close/toggle and placement", () => {
  const VIEWPORT = { width: 1600, height: 900 };

  it("starts closed; open places it at the top-right with the peek clamp applied", () => {
    const store = createFloatingWindowStore();
    assert.equal(store.getBox().state.open, false);
    assert.equal(store.getBox().state.openEpoch, 0);

    store.open(VIEWPORT);
    const state = store.getBox().state;
    assert.equal(state.open, true);
    assert.equal(state.openEpoch, 1);
    assert.equal(state.width, FLOATING_WINDOW_WIDTH);
    assert.equal(state.height, FLOATING_WINDOW_HEIGHT);
    // Default: a margin offset from the viewport's top-right corner.
    assert.equal(state.x, VIEWPORT.width - FLOATING_WINDOW_WIDTH - 24);
    assert.equal(state.y, 24);
  });

  it("opening an open window is a no-op; close retains the position; toggle flips", () => {
    const store = createFloatingWindowStore();
    store.open(VIEWPORT);
    const first = store.getBox().state;
    store.open(VIEWPORT);
    assert.equal(store.getBox().state.openEpoch, 1, "no double-open");

    store.close();
    assert.equal(store.getBox().state.open, false);
    assert.equal(store.getBox().state.x, first.x, "position retained");

    store.toggle(VIEWPORT);
    assert.equal(store.getBox().state.open, true);
    assert.equal(store.getBox().state.openEpoch, 2, "each open bumps the epoch");
    assert.equal(store.getBox().state.x, first.x, "reopens where it was");

    store.toggle(VIEWPORT);
    assert.equal(store.getBox().state.open, false);
  });

  it("re-clamps the retained position against the NEW viewport on reopen", () => {
    const store = createFloatingWindowStore();
    store.open({ width: 1600, height: 900 });
    store.close();
    // The viewport shrank between sessions (window moved to a small screen).
    store.open({ width: 800, height: 600 });
    const state = store.getBox().state;
    assert.ok(
      state.x <= 800 - FLOATING_WINDOW_MIN_PEEK,
      "left edge keeps the peek strip on-screen",
    );
    assert.ok(state.y <= 600 - FLOATING_WINDOW_MIN_PEEK);
  });

  it("moveBy clamps: the window can never be dragged wholly off-screen", () => {
    const store = createFloatingWindowStore();
    store.open(VIEWPORT);
    // Drag far past the top-left corner.
    store.moveBy(-100_000, -100_000, VIEWPORT);
    const state = store.getBox().state;
    assert.equal(state.x, FLOATING_WINDOW_MIN_PEEK - FLOATING_WINDOW_WIDTH);
    assert.equal(state.y, 0);
    // …and far past the bottom-right corner.
    store.moveBy(200_000, 200_000, VIEWPORT);
    assert.equal(
      store.getBox().state.x,
      VIEWPORT.width - FLOATING_WINDOW_MIN_PEEK,
    );
    assert.equal(
      store.getBox().state.y,
      VIEWPORT.height - FLOATING_WINDOW_MIN_PEEK,
    );
  });

  it("moveBy is a no-op while closed and a no-op when the clamp absorbs the delta", () => {
    const store = createFloatingWindowStore();
    const before = store.getBox().state;
    store.moveBy(10, 10, VIEWPORT);
    assert.equal(store.getBox().state, before, "nothing moves while closed");

    store.open(VIEWPORT);
    // Pin the window at the right edge, then push further right: the clamp
    // absorbs the delta and NOTHING emits (the box reference is stable).
    store.moveBy(100_000, 0, VIEWPORT);
    const pinned = store.getBox().state;
    assert.equal(pinned.x, VIEWPORT.width - FLOATING_WINDOW_MIN_PEEK);
    store.moveBy(50, 0, VIEWPORT);
    assert.equal(store.getBox().state, pinned);
  });

  it("clampWindowPosition: a viewport smaller than the peek margin pins deterministically", () => {
    const pinned = clampWindowPosition(-1000, -1000, 760, 520, {
      width: 50,
      height: 50,
    });
    // The axis bounds collapse; the window pins at its clamped minimum with
    // the top edge on-screen — deterministic, no NaN.
    assert.deepEqual(pinned, {
      x: FLOATING_WINDOW_MIN_PEEK - FLOATING_WINDOW_WIDTH,
      y: 0,
    });
    // The pure default placement runs through the same rule.
    const placed = defaultWindowPlacement(
      { width: FLOATING_WINDOW_WIDTH, height: FLOATING_WINDOW_HEIGHT },
      { width: 50, height: 50 },
    );
    assert.deepEqual(placed, pinned);
  });

  it("subscribe fires on every state change; the disposer stops it", () => {
    const store = createFloatingWindowStore();
    let calls = 0;
    const dispose = store.subscribe(() => {
      calls += 1;
    });
    store.open(VIEWPORT);
    store.close();
    assert.equal(calls, 2);
    dispose();
    store.open(VIEWPORT);
    assert.equal(calls, 2);
  });
});

// ── 2. Registration over the fake seams (posture pin) ────────────────────

/**
 * Minimal client-face fake (scaffold/shell-mount style): effects collect
 * disposers; slots.inject records per-parent entries with the controller
 * semantics (teardown empties the record and disposes entries); locale
 * registers/binds for real. No `inject` (settingsScope) — the watch's
 * honest channel-missing branch is fine here; this suite pins REGISTRATION
 * and the mount's feed path, not the settings watch.
 */
function createClientCtx() {
  const locales = new Map<string, unknown>();
  const injects: Array<{ parent: string; entries: unknown[] }> = [];
  const injectControllers: Array<() => void> = [];
  const effectDisposers: Array<() => void> = [];

  const ctx = {
    effect(execute: () => unknown, label?: string) {
      void label;
      const returned = execute();
      const disposer: () => void =
        typeof returned === "function" ? returned : () => {};
      effectDisposers.push(disposer);
      return () => {};
    },
    slots: {
      inject(parent: string, callback: () => unknown) {
        const record = { parent, entries: [] as unknown[] };
        injects.push(record);
        callback();
        const controller = () => {
          const at = injects.indexOf(record);
          if (at >= 0) injects.splice(at, 1);
          record.entries.length = 0;
        };
        injectControllers.push(controller);
        return controller;
      },
      register(options: unknown, component: unknown) {
        const owner = injects.at(-1);
        assert.ok(owner, "slots.register outside of slots.inject (fake)");
        owner.entries.push({ options, component });
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
        return (key: string) => {
          const dict = locales.get(namespace) as
            | { en: Record<string, string> }
            | undefined;
          return dict?.en[key] ?? key;
        };
      },
    },
    // Test surface.
    locales,
    injects,
    runFiberTeardown() {
      for (const dispose of [...effectDisposers, ...injectControllers]) {
        dispose();
      }
    },
  };
  return ctx as typeof ctx & ClientContext & {
    locales: Map<string, unknown>;
    injects: Array<{ parent: string; entries: unknown[] }>;
    runFiberTeardown(): void;
  };
}

describe("floating window launcher — registration posture (ticket 100, ADR-0021)", () => {
  it("registers exactly ONE shell.overlay entry — the launcher; the capsule entry stays retired", () => {
    const ctx = createClientCtx();
    apply(ctx);

    const overlays = ctx.injects.filter(
      (record) => record.parent === SHELL_OVERLAY_SLOT,
    );
    assert.equal(overlays.length, 1, "one shell.overlay inject");
    const entries = overlays[0]!.entries as Array<{
      options: Record<string, unknown>;
      component: unknown;
    }>;
    assert.equal(entries.length, 1, "one additive entry: the launcher chip");
    assert.deepEqual(entries[0]!.options, launcherOverlayRegistration());
    assert.equal(
      (entries[0]!.options as { id: string }).id,
      LAUNCHER_ENTRY_ID,
    );
    assert.equal(typeof entries[0]!.component, "function");
    // The cancelled capsule's entry id never registers again (resolved 89;
    // the window hosts the WHOLE shell, not a chip info model).
    for (const record of ctx.injects) {
      for (const entry of record.entries as Array<{ options: { id?: string } }>) {
        assert.notEqual(entry.options.id, ROSTER_ENTRY_ID);
      }
    }
  });

  it("the default posture: launcher + floating window mount, STILL no `root`/`main` entry, never the shipped conversation key", () => {
    const ctx = createClientCtx();
    const composition = applyClientModule(ctx, createRosterStore());

    // Three declaration waits: toolviews (stock chat), settings card
    // (shipped settings tab), and the launcher (shell.overlay). Exactly the
    // additive slots; nothing of ours in dsh's layout.
    assert.equal(ctx.injects.length, 3);
    assert.deepEqual(
      ctx.injects.map((record) => record.parent).sort(),
      [SETTINGS_PLUGIN_ITEM_SLOT, SHELL_OVERLAY_SLOT, TOOL_CALL_TOOLVIEW_SLOT]
        .sort(),
    );
    assert.equal(ctx.injects.filter((r) => r.parent === ROOT_FRAME_SLOT).length, 0);
    assert.equal(ctx.injects.filter((r) => r.parent === MAIN_PAGE_SLOT).length, 0);
    for (const record of ctx.injects) {
      for (const entry of record.entries as Array<{
        options: { name: string; key?: string };
      }>) {
        assert.notEqual(entry.options.name, ROOT_FRAME_SLOT);
        assert.notEqual(entry.options.name, MAIN_PAGE_SLOT);
        if (entry.options.name === MAIN_PAGE_SLOT) {
          assert.notEqual(entry.options.key, SHIPPED_MAIN_PAGE_KEY);
        }
      }
    }

    // The floating window's shell mount EXISTS at the push-site (the real
    // mountShellPage machinery ran again).
    assert.equal(composition.mounts.length, 1);
  });

  it("fiber teardown (HMR) reverses the launcher too; re-apply restores it with no accumulation", () => {
    const ctx = createClientCtx();
    apply(ctx);
    assert.equal(ctx.injects.length, 3);
    ctx.runFiberTeardown();
    assert.equal(ctx.injects.length, 0);
    // The portal container lifecycle effect ran (offline: a no-op disposer).
    assert.doesNotThrow(() => disposeWindowLayer());
    apply(ctx);
    assert.equal(ctx.injects.length, 3);
    const overlays = ctx.injects.filter(
      (record) => record.parent === SHELL_OVERLAY_SLOT,
    );
    assert.equal(overlays.length, 1);
  });
});

// ── 3. The real data path through the composition's own feeds ────────────

function worker(
  workerId: string,
  status: RosterSnapshot["workers"][number]["status"],
): RosterSnapshot["workers"][number] {
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

describe("floating window mount — feeds attached from the composition, disposed with the fiber", () => {
  it("the mount's stores join the composition's feeds: publish → card + mirror on the window's shell", () => {
    const ctx = createClientCtx();
    const composition = applyClientModule(ctx, createRosterStore());
    const mount = composition.mounts[0]!;
    assert.equal(mount.approvals.getBox().state.kind, "unfed");

    // One channel publish carries BOTH families (the ticket-69/94 hub
    // contract); the real watch feeds each hub the SAME accepted document.
    const document = {
      roster: {
        schemaVersion: 4,
        dispatcherSessionId: "s-1",
        publishedAtMs: 1_000,
        workers: [worker("w-1", "running")],
        recentResult: null,
        pendingAsks: [
          {
            requestId: "req-1",
            workerId: "w-1",
            class: "tool",
            target: "run_tests",
            reason: "needs the suite",
            credentialName: "",
            parentSessionId: "s-1",
            createdAtMs: 1000,
          },
        ],
      },
      "roster.s-1": {
        schemaVersion: 4,
        dispatcherSessionId: "s-1",
        publishedAtMs: 1_000,
        workers: [worker("w-1", "running")],
        recentResult: null,
        pendingAsks: [],
      },
    };
    composition.approvalsFeed.applyChannelValue(document);
    composition.mirrorsFeed.applyChannelValue(document);

    // The approval card landed on the window mount's OWN store…
    const cards = mount.approvals.getBox().state;
    assert.equal(cards.kind, "ready");
    assert.equal(cards.kind === "ready" ? cards.cards.length : -1, 1);
    assert.equal(cards.kind === "ready" ? cards.cards[0]!.requestId : "", "req-1");
    // …and the mirror landed on the window mount's shell store (the
    // per-session mirror is the window sidebar's flag/presence input; the
    // rows themselves ride the sessions feed — mirrors never invent rows,
    // and this fake ships no sessions face).
    const mirror = mount.store.getBox().state.mirrors.get("s-1");
    assert.equal(mirror?.kind, "snapshot");
    assert.equal(
      mirror?.kind === "snapshot" ? mirror.snapshot.workers.length : -1,
      1,
    );
  });

  it("fiber teardown detaches the mount's stores from the hub (late publishes reach nothing)", () => {
    const ctx = createClientCtx();
    const composition = applyClientModule(ctx, createRosterStore());
    const mount = composition.mounts[0]!;
    composition.approvalsFeed.applyChannelValue({
      roster: {
        schemaVersion: 4,
        dispatcherSessionId: "s-1",
        publishedAtMs: 1_000,
        workers: [],
        recentResult: null,
        pendingAsks: [],
      },
    });
    assert.equal(mount.approvals.getBox().state.kind, "ready");

    ctx.runFiberTeardown();
    composition.approvalsFeed.applyChannelValue({
      roster: {
        schemaVersion: 4,
        dispatcherSessionId: "s-1",
        publishedAtMs: 2_000,
        workers: [],
        recentResult: null,
        pendingAsks: [],
      },
    });
    // Detached: the store keeps its last truth (the long-lived ticket-69
    // detach pin), never fed by a dead fiber.
    const after = mount.approvals.getBox().state;
    assert.equal(after.kind, "ready");
    assert.equal(
      after.kind === "ready" ? after.cards.length : -1,
      0,
      "the second publish (no asks) never arrived",
    );
  });
});

// ── 4. Crash isolation + window behavior, rendered (jsdom + react-dom) ───

const CHIP = '[data-launcher="dispatcher"]';
const WINDOW = '[data-window="dispatcher"]';
const FAILED = '[data-window="failed"]';
const DRAG = "[data-window-drag-handle='true']";
const CLOSE = ".multitask-dispatcher-fwin__close";

function query(selector: string): Element | null {
  return dom.window.document.querySelector(selector);
}

function click(element: Element): void {
  element.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}

/** Render one component tree into a fresh body container (the ticket-88 idiom). */
function renderTree(): { root: Root; container: HTMLElement } {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  return { root: createRoot(container), container };
}

/** A stand-in hosted shell (the re-hosted tree's marker, as the real one renders). */
function shellStub(): JSX.Element {
  return createElement("div", { "data-shell": "dispatcher" });
}

describe("floating window — rendered: chip toggles, window portals to body, close reopens", () => {
  it("the chip toggles the window; the window renders OUTSIDE the entry's container (body-level portal); close works", async () => {
    const store = createFloatingWindowStore();
    const Chip = createLauncherChip(t, store, shellStub());
    const { root, container } = renderTree();
    await act(async () => {
      root.render(createElement(Chip));
    });

    // Closed by default: the chip renders, the window does not.
    const chip = query(CHIP);
    assert.ok(chip, "the launcher chip renders");
    assert.equal(chip.getAttribute("aria-pressed"), "false");
    assert.equal(chip.textContent, localeDictionary.en["launcher.chip.label"]);
    assert.equal(query(WINDOW), null, "no window while closed");

    // Click: the window opens — portaled to the body-level layer, NOT a
    // descendant of the entry's own container (the DOM-technique pin).
    await act(async () => {
      click(chip);
    });
    const win = query(WINDOW);
    assert.ok(win, "the window opens on chip click");
    assert.ok(
      container.querySelector(WINDOW) === null,
      "the window is portaled OUT of the entry's container",
    );
    assert.equal(
      chip.getAttribute("aria-pressed"),
      "true",
      "chip reflects the open state",
    );
    assert.ok(query(DRAG), "the drag handle (titlebar) renders");
    assert.ok(query(CLOSE), "the close button renders");
    assert.ok(
      query(`${WINDOW} [data-shell="dispatcher"]`),
      "the re-hosted dispatcher shell renders inside the window",
    );

    // Close via the window's own button.
    await act(async () => {
      click(query(CLOSE)!);
    });
    assert.equal(query(WINDOW), null, "the window closes");
    assert.equal(
      query(CHIP)?.getAttribute("aria-pressed"),
      "false",
      "chip reflects the closed state",
    );

    // The chip reopens (epoch 2 — a fresh boundary mounts).
    await act(async () => {
      click(query(CHIP)!);
    });
    assert.ok(query(WINDOW), "the chip reopens the window");
    assert.equal(store.getBox().state.openEpoch, 2);

    await act(async () => {
      root.unmount();
    });
    disposeWindowLayer();
  });

  it("dragging the titlebar moves the window through the REAL store clamp", async () => {
    const store = createFloatingWindowStore();
    const Chip = createLauncherChip(t, store, shellStub());
    const { root } = renderTree();
    await act(async () => {
      root.render(createElement(Chip));
    });
    await act(async () => {
      click(query(CHIP)!);
    });
    const before = store.getBox().state;

    // pointerdown on the titlebar, then a large pointermove on window:
    // the same events the browser delivers.
    await act(async () => {
      query(DRAG)!.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 400,
          clientY: 40,
        }),
      );
    });
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.MouseEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: -5000,
          clientY: -5000,
        }),
      );
    });
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.MouseEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: -5000,
          clientY: -5000,
        }),
      );
    });

    const after = store.getBox().state;
    assert.equal(
      after.x,
      FLOATING_WINDOW_MIN_PEEK - FLOATING_WINDOW_WIDTH,
      "clamped at the left edge with the peek strip kept",
    );
    assert.equal(after.y, 0, "clamped at the top edge");
    assert.ok(after.x < before.x && after.y < before.y, "the drag moved it");

    // A right-click does not start a drag.
    await act(async () => {
      query(DRAG)!.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.MouseEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: 500,
          clientY: 500,
        }),
      );
    });
    assert.equal(store.getBox().state.x, after.x, "right-button drag ignored");

    await act(async () => {
      root.unmount();
    });
    disposeWindowLayer();
  });

  it("three monotonic pointermoves advance the window by the SUM of per-event deltas (no start-relative compounding)", async () => {
    const store = createFloatingWindowStore();
    const Chip = createLauncherChip(t, store, shellStub());
    const { root } = renderTree();
    await act(async () => {
      root.render(createElement(Chip));
    });
    await act(async () => {
      click(query(CHIP)!);
    });
    const before = store.getBox().state;

    // Down on the titlebar, then three small monotonic moves on window,
    // then up (the up is MANDATORY: it is what removes the window-level
    // listeners and keeps them from leaking into later tests).
    await act(async () => {
      query(DRAG)!.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 400,
          clientY: 40,
        }),
      );
    });
    for (const [clientX, clientY] of [
      [410, 50],
      [420, 60],
      [430, 70],
    ]) {
      await act(async () => {
        dom.window.dispatchEvent(
          new dom.window.MouseEvent("pointermove", {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
          }),
        );
      });
    }
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.MouseEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: 430,
          clientY: 70,
        }),
      );
    });

    const after = store.getBox().state;
    assert.equal(
      after.x,
      before.x + 30,
      "three 10px moves land 30px right: each pointermove must contribute " +
        "its OWN delta (relative to the previous move). On the compounding " +
        "bug the start-relative deltas 10+20+30 re-apply on top of the live " +
        "position and the window runs to before+60. Guard: monotonic in the " +
        "pointer, no clamp hit at this magnitude.",
    );
    assert.equal(
      after.y,
      before.y + 30,
      "same on the y axis: 30px down, not the compounding 60",
    );

    await act(async () => {
      root.unmount();
    });
    disposeWindowLayer();
  });
});

describe("floating window — crash isolation (the ticket's guarantee, rendered)", () => {
  it("boundary unit: getDerivedStateFromError flips to the fallback; the fallback is the honest line", () => {
    assert.deepEqual(
      DispatcherWindowBoundary.getDerivedStateFromError(new Error("boom")),
      { failed: true },
    );

    // Failed branch (drive the class directly — render is hook-free).
    const boundary = new DispatcherWindowBoundary({
      failed: "FAILED LINE",
      children: createElement("main"),
    });
    (boundary as { state: { failed: boolean } }).state = { failed: true };
    const fallback = boundary.render() as {
      props: { "data-window": string; children: string };
    };
    assert.equal(fallback.props["data-window"], "failed");
    assert.equal(fallback.props.children, "FAILED LINE");

    // Healthy branch: the children pass through UNCHANGED (identity).
    const child = createElement("section");
    const healthy = new DispatcherWindowBoundary({
      failed: "x",
      children: child,
    });
    (healthy as { state: { failed: boolean } }).state = { failed: false };
    assert.equal(healthy.render(), child);
  });

  it("a crashing shell tree renders the failed line INSIDE the window; chrome and chip survive (no error escapes)", async () => {
    const store = createFloatingWindowStore();
    let boom = true;
    const ThrowingShell = (): JSX.Element => {
      if (boom) throw new Error("shell exploded");
      return createElement("div", { "data-shell": "dispatcher" });
    };
    const Chip = createLauncherChip(t, store, createElement(ThrowingShell));
    const { root } = renderTree();
    await act(async () => {
      root.render(createElement(Chip));
    });
    await act(async () => {
      click(query(CHIP)!);
    });

    // The window opened; the shell crash is CONTAINED by our boundary:
    // the honest failed line renders, the window chrome is intact, and
    // NOTHING escaped to break the render tree (the chip is still there).
    assert.ok(query(WINDOW), "the window stays open");
    assert.ok(query(FAILED), "the honest failed line renders");
    assert.equal(
      query(FAILED)!.textContent,
      localeDictionary.en["launcher.window.failed"],
      "the fallback copy is the launcher.window.failed face",
    );
    assert.ok(
      query(`${WINDOW} ${FAILED}`),
      "the fallback renders in the window body",
    );
    assert.ok(query(DRAG), "the titlebar (drag) survives the crash");
    assert.ok(query(CLOSE), "the close button survives the crash");
    assert.ok(query(CHIP), "the launcher chip survives the crash");
    assert.equal(
      query(`${WINDOW} [data-shell="dispatcher"]`),
      null,
      "the crashed tree is not rendered",
    );

    // Close + reopen mounts a FRESH boundary (openEpoch key): a recovered
    // shell renders normally again — the crash is not permanent.
    await act(async () => {
      click(query(CLOSE)!);
    });
    boom = false;
    await act(async () => {
      click(query(CHIP)!);
    });
    assert.ok(query(WINDOW), "reopened");
    assert.equal(
      query(FAILED),
      null,
      "the fresh boundary shows no stale failure",
    );
    assert.ok(
      query(`${WINDOW} [data-shell="dispatcher"]`),
      "the (recovered) shell renders after reopen",
    );

    await act(async () => {
      root.unmount();
    });
    disposeWindowLayer();
  });

  it("the pure window tree places the boundary in the BODY, below the chrome (structural pin)", () => {
    const state = {
      open: true,
      openEpoch: 1,
      x: 10,
      y: 20,
      width: FLOATING_WINDOW_WIDTH,
      height: FLOATING_WINDOW_HEIGHT,
    };
    const chrome = { title: "T", close: "C", failed: "F" };
    const content = createElement("div", { id: "content" });
    const tree = describeFloatingWindow(
      state,
      chrome,
      { onClose: () => {}, onTitlebarPointerDown: () => {} },
      content,
      1,
    ) as unknown as {
      props: {
        children: [
          unknown,
          {
            props: {
              onPointerDown: unknown;
              children: [{ props: { children: string } }, unknown];
            };
          },
          {
            type: string;
            props: {
              children: { type: unknown; props: { failed: string; children: unknown } };
            };
          },
        ];
      };
    };
    // children[0] is the <style> element; children[1] the titlebar (drag
    // handle + close) — OUTSIDE the boundary; children[2] the body div
    // holding the boundary around exactly the hosted shell content.
    const titlebar = tree.props.children[1];
    assert.equal(typeof titlebar.props.onPointerDown, "function");
    assert.equal(titlebar.props.children[0]!.props.children, "T");
    const boundary = tree.props.children[2]!.props.children;
    assert.equal(boundary.type, DispatcherWindowBoundary);
    assert.equal(boundary.props.failed, "F");
    assert.equal(
      boundary.props.children,
      content,
      "the boundary wraps exactly the hosted shell",
    );
  });
});

// ── 5. The affordances INSIDE the window, rendered (ticket 102) ──────────
//
// Ticket 102's live report: "no way to summon new dispatcher/kill old ones
// in our floating window". Both seats were mounted and rendered — the defect
// was pure presentation (a hover-gated delete, an add section below the
// sidebar's fold). These pins render the REAL shell (not `shellStub`) inside
// the REAL window and assert the affordances are present, visible, and
// clickable, all scoped to the `WINDOW` selector so they prove placement
// inside the window rather than merely on the page.

describe("floating window — the summon/kill affordances render INSIDE the window (ticket 102)", () => {
  it("the delete seat is visible at rest and only on dispatcher rows; the add seat opens in place", async () => {
    const composition = applyClientModule(createClientCtx(), createRosterStore());
    const mount = composition.mounts[0]!;
    const Shell = createDispatcherShell(t, mount.store, mount.hosts);
    const store = createFloatingWindowStore();
    const Chip = createLauncherChip(t, store, createElement(Shell));
    const { root } = renderTree();
    await act(async () => {
      root.render(createElement(Chip));
    });
    await act(async () => {
      click(query(CHIP)!);
    });
    assert.ok(query(WINDOW), "the window opened");

    // The row set `bindShellSessionsFeed` would publish: one flagged
    // dispatcher row (killable) and one plain chat (an add candidate).
    await act(async () => {
      mount.store.upsertSessions([
        { sessionId: "s-disp", title: "Dispatcher", dispatcher: true },
        { sessionId: "s-plain", title: "Plain" },
      ]);
    });

    // ── the kill affordance ──
    const del = query(`${WINDOW} [data-delete-id="s-disp"]`);
    assert.ok(del, "the kill button renders inside the window");
    const actions = del.parentElement;
    assert.ok(actions, "the kill button has its row-actions parent");
    assert.notEqual(
      dom.window.getComputedStyle(actions).display,
      "none",
      "the kill affordance is visible at rest — its row-actions parent is " +
        "display:none again (ticket 102 regression: present but unkillable)",
    );
    assert.equal(
      query(`${WINDOW} [data-delete-id="s-plain"]`),
      null,
      "a non-dispatcher row carries no kill affordance",
    );

    // ── the summon affordance ──
    const toggle = query(`${WINDOW} [data-add-toggle]`);
    assert.ok(toggle, "the add toggle renders inside the window");
    assert.equal(toggle.getAttribute("data-add-toggle"), "closed");
    assert.equal(toggle.textContent, t("shell.add.label"));
    assert.equal(
      query(`${WINDOW} [data-add-id="s-plain"]`),
      null,
      "the picker is closed until the toggle is pressed",
    );
    await act(async () => {
      click(toggle);
    });
    assert.equal(
      query(`${WINDOW} [data-add-toggle]`)!.getAttribute("data-add-toggle"),
      "open",
      "the toggle opens in place",
    );
    const option = query(`${WINDOW} [data-add-id="s-plain"]`);
    assert.ok(option, "the add candidate renders inside the window");
    assert.equal(
      query(`${WINDOW} [data-add-id="s-disp"]`),
      null,
      "a flagged dispatcher row is not offered as a summon candidate",
    );

    await act(async () => {
      root.unmount();
    });
    disposeWindowLayer();
  });
});
