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
  FLOATING_WINDOW_MARGIN,
  FLOATING_WINDOW_MIN_HEIGHT,
  FLOATING_WINDOW_MIN_PEEK,
  FLOATING_WINDOW_MIN_WIDTH,
  FLOATING_WINDOW_WIDTH,
  clampWindowPosition,
  defaultWindowPlacement,
  maximizedWindowPlacement,
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

// ── 1b. The pure store — resize + maximize/restore (ticket 105) ──────────

describe("floating window store (ticket 105) — edge resize and maximize/restore", () => {
  const VIEWPORT = { width: 1600, height: 900 };

  it("resizeBy from the east face grows and shrinks width; the top-left corner stays", () => {
    const store = createFloatingWindowStore();
    store.open(VIEWPORT);
    // Off the default top-right placement so the east face has viewport
    // room to grow into.
    store.moveBy(-300, 0, VIEWPORT);
    const before = store.getBox().state;
    store.resizeBy("e", 100, 0, VIEWPORT);
    let after = store.getBox().state;
    assert.equal(after.width, before.width + 100, "east: width tracks +dx");
    assert.equal(after.x, before.x, "east: x stays");
    assert.equal(after.y, before.y, "east: y stays");
    assert.equal(after.height, before.height, "east: height untouched");
    store.resizeBy("e", -40, 0, VIEWPORT);
    after = store.getBox().state;
    assert.equal(after.width, before.width + 60, "each resizeBy applies its own delta");
  });

  it("resizeBy from the west face keeps the RIGHT edge put (x adjusts, width compensates)", () => {
    const store = createFloatingWindowStore();
    store.open(VIEWPORT);
    const before = store.getBox().state;
    const rightEdge = before.x + before.width;
    store.resizeBy("w", -80, 0, VIEWPORT);
    const after = store.getBox().state;
    assert.equal(after.width, before.width + 80, "dragging left edge left grows width");
    assert.equal(after.x, before.x - 80, "x follows the pointer");
    assert.equal(
      after.x + after.width,
      rightEdge,
      "the opposite (right) edge stays exactly put",
    );
  });

  it("resizeBy from the north face keeps the BOTTOM edge put; the south face keeps the top", () => {
    const store = createFloatingWindowStore();
    store.open(VIEWPORT);
    // Off the default top placement so the north face has room to grow up.
    store.moveBy(0, 100, VIEWPORT);
    const before = store.getBox().state;
    const bottomEdge = before.y + before.height;
    store.resizeBy("n", 0, -60, VIEWPORT);
    const grown = store.getBox().state;
    assert.equal(grown.height, before.height + 60);
    assert.equal(grown.y, before.y - 60);
    assert.equal(grown.y + grown.height, bottomEdge, "bottom edge stays put");
    store.resizeBy("s", 0, 25, VIEWPORT);
    const after = store.getBox().state;
    assert.equal(after.height, before.height + 85);
    assert.equal(after.y, before.y - 60, "south face: top edge stays");
  });

  it("resizeBy clamps at the minimum size and stops emitting once the clamp absorbs the delta", () => {
    const store = createFloatingWindowStore();
    store.open(VIEWPORT);
    const before = store.getBox().state;
    // West face driven far past the minimum: width pins at MIN_WIDTH, the
    // right edge stays put.
    store.resizeBy("w", 100_000, 0, VIEWPORT);
    const pinned = store.getBox().state;
    assert.equal(pinned.width, FLOATING_WINDOW_MIN_WIDTH);
    assert.equal(
      pinned.x + pinned.width,
      before.x + before.width,
      "right edge still put at the minimum",
    );
    // Further absorption emits NOTHING (the moveBy box-stability contract).
    store.resizeBy("w", 50, 0, VIEWPORT);
    assert.equal(store.getBox().state, pinned, "absorbed west delta: no emit");
    // East face driven far below the minimum.
    store.resizeBy("e", -100_000, 0, VIEWPORT);
    const pinnedEast = store.getBox().state;
    assert.equal(pinnedEast.width, FLOATING_WINDOW_MIN_WIDTH);
    store.resizeBy("e", -50, 0, VIEWPORT);
    assert.equal(store.getBox().state, pinnedEast, "absorbed east delta: no emit");
    // The same absorption on the vertical axis.
    store.resizeBy("s", 0, -100_000, VIEWPORT);
    const pinnedSouth = store.getBox().state;
    assert.equal(pinnedSouth.height, FLOATING_WINDOW_MIN_HEIGHT);
    store.resizeBy("sw", 0, -50, VIEWPORT);
    assert.equal(store.getBox().state, pinnedSouth, "absorbed south delta: no emit");
  });

  it("resizeBy clamps against the viewport: a face never crosses a viewport edge", () => {
    const store = createFloatingWindowStore();
    store.open(VIEWPORT);
    const before = store.getBox().state;
    store.resizeBy("e", 100_000, 0, VIEWPORT);
    const after = store.getBox().state;
    assert.equal(after.x, before.x);
    assert.equal(
      after.x + after.width,
      VIEWPORT.width,
      "the right edge lands exactly on the viewport's right edge",
    );
    store.resizeBy("s", 0, 100_000, VIEWPORT);
    const south = store.getBox().state;
    assert.equal(
      south.y + south.height,
      VIEWPORT.height,
      "the bottom edge lands exactly on the viewport's bottom edge",
    );
    // Pure math pin: the maximized fill runs through the same discipline.
    const fill = maximizedWindowPlacement(VIEWPORT);
    assert.deepEqual(
      fill,
      {
        x: FLOATING_WINDOW_MARGIN,
        y: FLOATING_WINDOW_MARGIN,
        width: VIEWPORT.width - 2 * FLOATING_WINDOW_MARGIN,
        height: VIEWPORT.height - 2 * FLOATING_WINDOW_MARGIN,
      },
      "maximizedWindowPlacement is the viewport minus the margin on all sides",
    );
    const tiny = maximizedWindowPlacement({ width: 100, height: 80 });
    assert.equal(tiny.width, FLOATING_WINDOW_MIN_WIDTH, "tiny viewport: width pins at the minimum");
    assert.equal(tiny.height, FLOATING_WINDOW_MIN_HEIGHT);
    assert.ok(tiny.x >= 0 && tiny.y >= 0, "position stays deterministic (no NaN)");
  });

  it("resizeBy is a no-op while closed and while maximized", () => {
    const store = createFloatingWindowStore();
    const closed = store.getBox().state;
    store.resizeBy("se", 10, 10, VIEWPORT);
    assert.equal(store.getBox().state, closed, "nothing resizes while closed");

    store.open(VIEWPORT);
    store.toggleMaximize(VIEWPORT);
    const maximized = store.getBox().state;
    assert.equal(maximized.maximized, true);
    store.resizeBy("se", 10, 10, VIEWPORT);
    assert.equal(
      store.getBox().state,
      maximized,
      "resize handles are inert while maximized (drag or the button leaves maximize)",
    );
  });

  it("toggleMaximize fills the viewport minus the margin on every side and flags maximized", () => {
    const store = createFloatingWindowStore();
    store.open(VIEWPORT);
    store.toggleMaximize(VIEWPORT);
    const after = store.getBox().state;
    assert.equal(after.maximized, true);
    assert.deepEqual(
      maximizedWindowPlacement(VIEWPORT),
      { x: after.x, y: after.y, width: after.width, height: after.height },
      "the live fill equals the pure placement math",
    );
    assert.equal(after.x, FLOATING_WINDOW_MARGIN);
    assert.equal(after.y, FLOATING_WINDOW_MARGIN);
    assert.equal(after.width, VIEWPORT.width - 2 * FLOATING_WINDOW_MARGIN);
    assert.equal(after.height, VIEWPORT.height - 2 * FLOATING_WINDOW_MARGIN);
  });

  it("the second toggle restores the exact prior geometry (position AND size)", () => {
    const store = createFloatingWindowStore();
    store.open(VIEWPORT);
    store.moveBy(-100, 30, VIEWPORT);
    const before = store.getBox().state;
    store.toggleMaximize(VIEWPORT);
    assert.equal(store.getBox().state.maximized, true);
    store.toggleMaximize(VIEWPORT);
    const restored = store.getBox().state;
    assert.equal(restored.maximized, false);
    assert.equal(restored.x, before.x);
    assert.equal(restored.y, before.y);
    assert.equal(restored.width, before.width);
    assert.equal(restored.height, before.height);
  });

  it("toggleMaximize is rejected while closed (no emit, mirroring moveBy)", () => {
    const store = createFloatingWindowStore();
    const before = store.getBox().state;
    store.toggleMaximize(VIEWPORT);
    assert.equal(store.getBox().state, before, "nothing maximizes while closed");
  });

  it("restore re-clamps the remembered POSITION against a shrunken viewport (size stays exact)", () => {
    const store = createFloatingWindowStore();
    store.open({ width: 1600, height: 900 });
    store.moveBy(-100, 30, VIEWPORT);
    const before = store.getBox().state;
    store.toggleMaximize(VIEWPORT);
    // The viewport shrank while maximized; restoring re-clamps the
    // remembered position (peek rule) and keeps the remembered SIZE exact.
    store.toggleMaximize({ width: 700, height: 500 });
    const restored = store.getBox().state;
    assert.equal(restored.maximized, false);
    assert.equal(restored.width, before.width, "remembered width is exact");
    assert.equal(restored.height, before.height, "remembered height is exact");
    assert.equal(
      restored.x,
      700 - FLOATING_WINDOW_MIN_PEEK,
      "x re-clamps so the peek strip stays on the shrunken viewport",
    );
    assert.ok(restored.y <= 500 - FLOATING_WINDOW_MIN_PEEK);
  });

  it("moveBy while maximized restores first, then applies the delta (drag-restore)", () => {
    const store = createFloatingWindowStore();
    store.open(VIEWPORT);
    const before = store.getBox().state;
    store.toggleMaximize(VIEWPORT);
    store.moveBy(30, 20, VIEWPORT);
    const after = store.getBox().state;
    assert.equal(after.maximized, false, "the drag leaves maximize");
    assert.equal(after.x, before.x + 30, "the delta applies to the RESTORED rect");
    assert.equal(after.y, before.y + 20);
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);
    // Subsequent moves behave like ordinary drags again.
    store.moveBy(5, 5, VIEWPORT);
    assert.equal(store.getBox().state.x, before.x + 35);
  });

  it("maximized persists across close/reopen: reopen re-fills the CURRENT viewport", () => {
    const store = createFloatingWindowStore();
    store.open({ width: 1600, height: 900 });
    store.toggleMaximize({ width: 1600, height: 900 });
    store.close();
    const closed = store.getBox().state;
    assert.equal(closed.maximized, true, "close keeps the maximized state");
    store.open({ width: 1000, height: 700 });
    const reopened = store.getBox().state;
    assert.equal(reopened.maximized, true);
    assert.equal(reopened.width, 1000 - 2 * FLOATING_WINDOW_MARGIN);
    assert.equal(reopened.height, 700 - 2 * FLOATING_WINDOW_MARGIN);
    assert.equal(reopened.x, FLOATING_WINDOW_MARGIN);
    // Restore still knows the ORIGINAL pre-maximize rect (re-clamped).
    store.toggleMaximize({ width: 1000, height: 700 });
    const restored = store.getBox().state;
    assert.equal(restored.maximized, false);
    assert.equal(restored.width, FLOATING_WINDOW_WIDTH, "the remembered size survives");
    assert.ok(
      restored.x <= 1000 - FLOATING_WINDOW_MIN_PEEK,
      "and its position re-clamps to the current viewport",
    );
  });

  it("a resize that keeps position valid: west-face absorption re-clamps through the drag rule", () => {
    // Sanity on the clampWindowPosition pass: resize math on an in-bounds
    // window never moves a valid position (the "then clamp" is identity).
    const store = createFloatingWindowStore();
    store.open(VIEWPORT);
    const before = store.getBox().state;
    store.resizeBy("w", 120, 0, VIEWPORT);
    const after = store.getBox().state;
    assert.deepEqual(
      clampWindowPosition(after.x, after.y, after.width, after.height, VIEWPORT),
      { x: after.x, y: after.y },
      "the post-resize position is already clamp-valid",
    );
    assert.equal(after.x + after.width, before.x + before.width);
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
const MAXIMIZE = "[data-window-maximize='true']";
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

// ── 4b. Resize handles + maximize/restore, rendered (ticket 105) ──────────
//
// The rendered face of the ticket: handles dispatch the SAME real DOM
// pointer events as the drag pins above and grow/shrink through the REAL
// store math; the maximize button toggles through the store and swaps its
// accessible state. All clamps come from the store — these pins only prove
// the component wires the right deltas to the right faces.

describe("floating window — resize handles and maximize/restore (ticket 105, rendered)", () => {
  /** jsdom's default window size — what `liveViewport()` sees here. */
  const VP = {
    width: dom.window.innerWidth,
    height: dom.window.innerHeight,
  };

  async function openWindow(): Promise<{ store: ReturnType<typeof createFloatingWindowStore>; root: Root }> {
    const store = createFloatingWindowStore();
    const Chip = createLauncherChip(t, store, shellStub());
    const { root } = renderTree();
    await act(async () => {
      root.render(createElement(Chip));
    });
    await act(async () => {
      click(query(CHIP)!);
    });
    return { store, root };
  }

  /** One pointerdown on an element + window moves + the mandatory up. */
  async function dragPointer(
    on: Element,
    downs: { clientX: number; clientY: number },
    moves: Array<{ clientX: number; clientY: number }>,
  ): Promise<void> {
    await act(async () => {
      on.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: downs.clientX,
          clientY: downs.clientY,
        }),
      );
    });
    for (const at of moves) {
      await act(async () => {
        dom.window.dispatchEvent(
          new dom.window.MouseEvent("pointermove", {
            bubbles: true,
            cancelable: true,
            clientX: at.clientX,
            clientY: at.clientY,
          }),
        );
      });
    }
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.MouseEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: moves.at(-1)?.clientX ?? downs.clientX,
          clientY: moves.at(-1)?.clientY ?? downs.clientY,
        }),
      );
    });
  }

  function handle(edge: string): Element | null {
    return query(`${WINDOW} [data-resize-edge='${edge}']`);
  }

  it("the five wired resize handles render inside the window; the north faces stay unwired", async () => {
    const { root } = await openWindow();
    for (const edge of ["e", "w", "s", "se", "sw"]) {
      assert.ok(handle(edge), `the ${edge} handle renders inside the window`);
    }
    // Deliberate: the titlebar owns the top strip (drag) and the
    // maximize/close buttons own the top-right corner — north faces would
    // steal drags or button clicks (recorded in the ticket comment).
    assert.equal(handle("n"), null, "no north handle");
    assert.equal(handle("ne"), null, "no north-east handle");
    assert.equal(handle("nw"), null, "no north-west handle");

    await act(async () => {
      root.unmount();
    });
    disposeWindowLayer();
  });

  it("dragging the east handle grows the window by the SUM of per-event deltas (no compounding)", async () => {
    const { store, root } = await openWindow();
    // Off the default top-right placement so the east face has room.
    store.moveBy(-200, 0, VP);
    const before = store.getBox().state;

    await dragPointer(
      handle("e")!,
      { clientX: before.x + before.width, clientY: 400 },
      [
        { clientX: before.x + before.width + 10, clientY: 400 },
        { clientX: before.x + before.width + 20, clientY: 400 },
        { clientX: before.x + before.width + 30, clientY: 400 },
      ],
    );

    const after = store.getBox().state;
    assert.equal(
      after.width,
      before.width + 30,
      "three 10px moves widen the window 30px — each pointermove contributes " +
        "its OWN delta (the ticket-103 drag rule, now on a resize face)",
    );
    assert.equal(after.x, before.x, "the top-left corner stays");
    assert.equal(after.height, before.height, "height untouched");

    await act(async () => {
      root.unmount();
    });
    disposeWindowLayer();
  });

  it("dragging the west handle moves x left while the right edge stays exactly put", async () => {
    const { store, root } = await openWindow();
    const before = store.getBox().state;
    const rightEdge = before.x + before.width;

    await dragPointer(
      handle("w")!,
      { clientX: before.x, clientY: 400 },
      [
        { clientX: before.x - 10, clientY: 400 },
        { clientX: before.x - 20, clientY: 400 },
        { clientX: before.x - 30, clientY: 400 },
      ],
    );

    const after = store.getBox().state;
    assert.equal(after.x, before.x - 30, "x tracks the pointer");
    assert.equal(after.width, before.width + 30, "width compensates");
    assert.equal(
      after.x + after.width,
      rightEdge,
      "the opposite (right) edge never moves",
    );

    await act(async () => {
      root.unmount();
    });
    disposeWindowLayer();
  });

  it("the maximize button toggles geometry and aria state through the store", async () => {
    const { store, root } = await openWindow();
    const before = store.getBox().state;
    const maximizeCopy = localeDictionary.en["launcher.window.maximize"];
    const restoreCopy = localeDictionary.en["launcher.window.restore"];

    const button = query(MAXIMIZE);
    assert.ok(button, "the maximize button renders in the titlebar");
    assert.equal(button.getAttribute("aria-label"), maximizeCopy);
    assert.equal(button.getAttribute("title"), maximizeCopy);
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(
      query(WINDOW)!.getAttribute("data-window-maximized"),
      null,
      "the maximized marker is absent at rest",
    );

    await act(async () => {
      click(button!);
    });
    const maximized = store.getBox().state;
    assert.equal(maximized.maximized, true);
    assert.equal(maximized.x, FLOATING_WINDOW_MARGIN);
    assert.equal(maximized.y, FLOATING_WINDOW_MARGIN);
    assert.equal(
      maximized.width,
      VP.width - 2 * FLOATING_WINDOW_MARGIN,
      "fills the viewport minus the margin",
    );
    assert.equal(maximized.height, VP.height - 2 * FLOATING_WINDOW_MARGIN);
    assert.equal(
      query(MAXIMIZE)!.getAttribute("aria-pressed"),
      "true",
      "aria state follows the store",
    );
    assert.equal(query(MAXIMIZE)!.getAttribute("aria-label"), restoreCopy);
    assert.equal(
      query(WINDOW)!.getAttribute("data-window-maximized"),
      "true",
      "the maximized marker lands on the root (the CSS inert-handles hook)",
    );

    await act(async () => {
      click(query(MAXIMIZE)!);
    });
    const restored = store.getBox().state;
    assert.equal(restored.maximized, false);
    assert.equal(restored.x, before.x, "exact prior geometry: x");
    assert.equal(restored.y, before.y, "y");
    assert.equal(restored.width, before.width, "width");
    assert.equal(restored.height, before.height, "height");
    assert.equal(query(MAXIMIZE)!.getAttribute("aria-pressed"), "false");
    assert.equal(query(MAXIMIZE)!.getAttribute("aria-label"), maximizeCopy);

    await act(async () => {
      root.unmount();
    });
    disposeWindowLayer();
  });

  it("dragging the titlebar while maximized restores first, then tracks the pointer (Windows-like)", async () => {
    const { store, root } = await openWindow();
    const before = store.getBox().state;
    await act(async () => {
      click(query(MAXIMIZE)!);
    });
    assert.equal(store.getBox().state.maximized, true);

    await dragPointer(
      query(DRAG)!,
      { clientX: 400, clientY: 40 },
      [{ clientX: 415, clientY: 50 }],
    );

    const after = store.getBox().state;
    assert.equal(after.maximized, false, "the first drag move leaves maximize");
    assert.equal(after.x, before.x + 15, "the delta applies to the RESTORED rect");
    assert.equal(after.y, before.y + 10);
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);

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
      maximized: false,
    };
    const chrome = {
      title: "T",
      close: "C",
      maximize: "M",
      restore: "R",
      failed: "F",
    };
    const content = createElement("div", { id: "content" });
    const tree = describeFloatingWindow(
      state,
      chrome,
      {
        onClose: () => {},
        onTitlebarPointerDown: () => {},
        onToggleMaximize: () => {},
        onResizePointerDown: () => {},
      },
      content,
      1,
    ) as unknown as {
      props: {
        children: [
          unknown,
          {
            props: {
              onPointerDown: unknown;
              children: [{ props: { children: string } }, unknown, unknown];
            };
          },
          {
            type: string;
            props: {
              children: { type: unknown; props: { failed: string; children: unknown } };
            };
          },
          ...Array<{ props: { "data-resize-edge": string } }>,
        ];
      };
    };
    // children[0] is the <style> element; children[1] the titlebar (drag
    // handle + maximize + close) — OUTSIDE the boundary; children[2] the
    // body div holding the boundary around exactly the hosted shell
    // content. Ticket 105 appends the resize handles AFTER the body
    // (children[3..]) — the pinned prefix stands.
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
    // The resize handles are the tail: five faces, e/w/s/se/sw (the north
    // faces stay unwired — the titlebar and buttons own the top strip).
    assert.equal(tree.props.children.length, 3 + 5);
    assert.deepEqual(
      tree.props.children
        .slice(3)
        .map((handle) => handle.props["data-resize-edge"]),
      ["e", "w", "s", "se", "sw"],
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

// ── 6. The right-click close menu, rendered (ticket 106) ─────────────────
//
// Ticket 106: right-click on a dispatcher row opens a minimal in-window
// context menu whose one item sends `/dispatcher-stop` (the close seat)
// after the SAME two-press arming the row's delete button uses. These pins
// render the REAL shell (with the REAL mount hosts) inside the REAL window
// and drive real DOM events: contextmenu opens — dispatcher rows only;
// first click arms, second click inside the window sends exactly once;
// outside pointer-down, Escape, scroll, and the row's own deactivation all
// dismiss. Stale-mirror LIVENESS is out of scope here (ticket 104 owns
// mirror honesty) — only the affordance-level hygiene is pinned.

function contextMenuAt(element: Element, clientX = 120, clientY = 90): void {
  element.dispatchEvent(
    new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX,
      clientY,
    }),
  );
}

function pointerDownAt(element: Element): void {
  element.dispatchEvent(
    new dom.window.MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    }),
  );
}

describe("floating window — right-click close menu on dispatcher rows (ticket 106)", () => {
  it("contextmenu opens only on dispatcher rows; two presses send /dispatcher-stop once; hygiene dismissals work", async () => {
    const executed: Array<{
      sessionId: string;
      line: string;
      attachments: readonly unknown[];
    }> = [];
    const ctx = createClientCtx();
    ctx.remote = {
      commands: {
        execute(
          sessionId: string,
          line: string,
          attachments: readonly unknown[],
        ) {
          executed.push({ sessionId, line, attachments });
          return Promise.resolve({ kind: "success", text: "ok" });
        },
      },
    };
    const composition = applyClientModule(ctx, createRosterStore());
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
    await act(async () => {
      mount.store.upsertSessions([
        { sessionId: "s-disp", title: "Dispatcher", dispatcher: true },
        { sessionId: "s-plain", title: "Plain" },
      ]);
    });

    const dispRow = query(`${WINDOW} [data-session-id="s-disp"]`);
    const plainRow = query(`${WINDOW} [data-session-id="s-plain"]`);
    assert.ok(dispRow && plainRow, "both rows render");

    // Right-click on the dispatcher row opens the menu, inside the window.
    await act(async () => {
      contextMenuAt(dispRow);
    });
    const menu = query(`${WINDOW} [data-row-menu="s-disp"]`);
    assert.ok(menu, "right-click on a dispatcher row opens the menu");
    assert.ok(
      query(WINDOW)!.contains(menu),
      "the menu is part of the window's tree (no body portal)",
    );
    assert.ok(
      menu.getAttribute("style")?.includes("left:") === true,
      "the menu is positioned near the cursor (inline left/top)",
    );
    const item = query(`${WINDOW} [data-row-menu-close="s-disp"]`);
    assert.ok(item, "the one menu item renders");
    assert.equal(item.getAttribute("data-armed"), "false");
    assert.equal(item.textContent, t("shell.row.close"));

    // Right-click on a NORMAL row: no menu. (A real right-click's
    // pointer-down lands first — which also dismisses the open menu.)
    await act(async () => {
      pointerDownAt(plainRow);
      contextMenuAt(plainRow);
    });
    assert.equal(
      query(`${WINDOW} [data-row-menu]`),
      null,
      "normal sessions ignore right-click; the outside pointer-down dismissed the open menu",
    );

    // Reopen; the first click ARMS only — no send.
    await act(async () => {
      contextMenuAt(dispRow);
    });
    const armedItem = query(`${WINDOW} [data-row-menu-close="s-disp"]`);
    assert.ok(armedItem);
    await act(async () => {
      click(armedItem);
    });
    assert.equal(armedItem.getAttribute("data-armed"), "true");
    assert.equal(armedItem.textContent, t("shell.row.close-confirm"));
    assert.deepEqual(executed, [], "arming never sends");

    // Second click inside the window sends the stop exactly once, verbatim.
    await act(async () => {
      click(armedItem);
    });
    await act(async () => {}); // let the transport's promise settle
    assert.deepEqual(executed, [
      { sessionId: "s-disp", line: "/dispatcher-stop", attachments: [] },
    ]);
    assert.equal(
      query(`${WINDOW} [data-row-menu]`),
      null,
      "the confirmed send closes the menu",
    );

    // Escape dismisses.
    await act(async () => {
      contextMenuAt(dispRow);
    });
    assert.ok(query(`${WINDOW} [data-row-menu="s-disp"]`));
    await act(async () => {
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
    });
    assert.equal(query(`${WINDOW} [data-row-menu]`), null, "Escape dismisses");

    // Scroll dismisses (capture-phase listener; scroll does not bubble).
    await act(async () => {
      contextMenuAt(dispRow);
    });
    assert.ok(query(`${WINDOW} [data-row-menu]`));
    await act(async () => {
      query(`${WINDOW} .multitask-dispatcher-shell__sidebar`)!.dispatchEvent(
        new dom.window.Event("scroll"),
      );
    });
    assert.equal(query(`${WINDOW} [data-row-menu]`), null, "scroll dismisses");

    // Row re-render honesty: the host's mirror clear (the recorded
    // deactivation) re-renders the row as a normal session, and an open
    // menu for it is gone — no stale menu on a former dispatcher. No
    // liveness is pinned here (ticket 104 owns mirror honesty).
    await act(async () => {
      contextMenuAt(dispRow);
    });
    assert.ok(query(`${WINDOW} [data-row-menu="s-disp"]`));
    await act(async () => {
      mount.store.applySessionMirror("s-disp", null);
    });
    assert.equal(
      query(`${WINDOW} [data-row-menu]`),
      null,
      "a row that stopped being a dispatcher loses its menu",
    );
    assert.equal(
      dispRow.getAttribute("data-dispatcher"),
      "false",
      "the row re-rendered as a normal session (mirror-derived, no optimistic flip)",
    );

    // The dethroned row no longer opens the menu either.
    await act(async () => {
      contextMenuAt(dispRow);
    });
    assert.equal(query(`${WINDOW} [data-row-menu]`), null);

    await act(async () => {
      root.unmount();
    });
    disposeWindowLayer();
  });
});
