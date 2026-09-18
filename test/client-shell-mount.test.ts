/**
 * Ticket 78 — wrapper shell STAGING mount (ADR-0020 slice 2, staging half).
 *
 * Offline only (S8): the staging registration contracts pinned over fakes in
 * the established overlay/toolview style — inject → register, one entry, id
 * stability — plus the page-open decision and the pure root fail-safe model.
 * The `root` election itself (frame swap, HMR fiber behavior,
 * fallback-on-crash in a real browser) is live-only (tickets 45/33) and is
 * deliberately NOT claimed here; this suite pins that NOTHING registers into
 * `root` yet (the cutover waits for ticket 80's conversation surface).
 *
 * No browser, no network, no real Cordis — the fake mirrors the shipped
 * effect/inject semantics the scaffold suite documents (cordis
 * lib/index.js:1168, 1141-1143).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply, mountShellPage } from "../src/client/index.js";
import type {
  ClientContext,
  ClientLayoutLike,
  ClientSessionsLike,
} from "../src/client/context.js";
import {
  LOCALE_NAMESPACE,
  ROSTER_ENTRY_ID,
  SHELL_OVERLAY_SLOT,
  localeDictionary,
  rosterOverlayRegistration,
} from "../src/client/overlay.js";
import {
  MAIN_PAGE_SLOT,
  ROOT_FRAME_SLOT,
  SHELL_LAUNCHER_ENTRY_ID,
  SHELL_LAUNCHER_LABEL_KEY,
  SHELL_LAUNCHER_OVERLAY_ORDER,
  SHELL_PAGE_KEY,
  SHELL_ROOT_DYNAMIC_PRIORITY,
  SHIPPED_MAIN_PAGE_KEY,
  openShellPage,
  shellCellWinner,
  shellLauncherRegistration,
  shellPageRegistration,
  shellSeatHostsPanel,
  shellSeatPanelState,
  type ShellCellEntry,
} from "../src/client/shell-mount.js";
import { createDispatcherShellStore } from "../src/client/shell-store.js";
import type { ShellFeedSnapshotLike } from "../src/client/shell-feed.js";
import type { RosterSnapshot } from "../src/core/roster-snapshot.js";
import type { WorkerStatus } from "../src/core/types.js";

/** A snapshot worker with honest defaults; overrides keep tests terse. */
function worker(
  workerId: string,
  status: WorkerStatus,
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

function snapshot(
  workers: RosterSnapshot["workers"],
  dispatcherSessionId = "s-1",
): RosterSnapshot {
  return {
    schemaVersion: 3,
    dispatcherSessionId,
    publishedAtMs: 1_000,
    workers,
    recentResult: null,
  };
}

/**
 * Fake the client face the way the shipped Cordis runtime behaves (same
 * semantics as the scaffold suite's fake), plus optional `sessions` and
 * `layout` faces for the shell composition.
 */
function createMountCtx(services: {
  sessions?: ClientSessionsLike;
  layout?: ClientLayoutLike;
} = {}) {
  const locales = new Map<string, unknown>();
  const injects: Array<{
    parent: string;
    entries: Array<{ options: unknown; component: unknown }>;
  }> = [];
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
        const record = { parent, entries: [] };
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
    sessions: services.sessions,
    layout: services.layout,
    // Test surface.
    locales,
    injects,
    runFiberTeardown() {
      for (const dispose of [...effectDisposers, ...injectControllers]) {
        dispose();
      }
    },
  };
  return ctx as typeof ctx & ClientContext & { runFiberTeardown(): void };
}

/** Sessions-feed fake: snapshot swaps + open-verb recording + dispose counts. */
function createSessionsFake(initial: ShellFeedSnapshotLike = {}) {
  let current = initial;
  const listeners = new Set<() => void>();
  const openCalls: string[] = [];
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const sessions: ClientSessionsLike = {
    list: {
      getSnapshot: () => current,
      subscribe(listener) {
        subscribeCount += 1;
        listeners.add(listener);
        return () => {
          unsubscribeCount += 1;
          listeners.delete(listener);
        };
      },
    },
    scope: () => undefined,
    open(id) {
      openCalls.push(id);
    },
  };
  return {
    sessions,
    openCalls,
    emit(next: ShellFeedSnapshotLike) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
    counts() {
      return { subscribeCount, unsubscribeCount };
    },
  };
}

/** Layout fake: records selectPanel calls, or throws like the host does. */
function createLayoutFake(mode: "ok" | "throws" = "ok") {
  const calls: string[] = [];
  const layout: ClientLayoutLike = {
    selectPanel(panelId: string) {
      if (mode === "throws") {
        throw new Error(
          `layout.selectPanel: main panel "${panelId}" is not registered`,
        );
      }
      calls.push(panelId);
    },
  };
  return { layout, calls };
}

describe("shell staging mount — registration contracts (ticket 78)", () => {
  it("pins the keyed `main` page registration: dsh-owned slot, our key, stable", () => {
    assert.equal(MAIN_PAGE_SLOT, "main");
    assert.deepEqual(shellPageRegistration(), {
      name: "main",
      key: "multitask-dispatcher-shell",
      locale: "multitask-dispatcher",
    });
    // Id stability: the same contract on every call — the launcher opens
    // exactly the key this registration claims.
    assert.deepEqual(shellPageRegistration(), shellPageRegistration());
  });

  it("never claims the shipped conversation key; the key is plugin-prefixed", () => {
    assert.equal(SHIPPED_MAIN_PAGE_KEY, "conversation");
    assert.notEqual(SHELL_PAGE_KEY, SHIPPED_MAIN_PAGE_KEY);
    assert.match(SHELL_PAGE_KEY, /^multitask-dispatcher-/);
    assert.equal(shellPageRegistration().key, SHELL_PAGE_KEY);
  });

  it("pins the launcher overlay registration: own id, ordered beside the capsule", () => {
    assert.deepEqual(shellLauncherRegistration(), {
      name: "shell.overlay",
      id: "multitask-dispatcher-shell-launcher",
      order: -11,
      locale: "multitask-dispatcher",
    });
    assert.equal(SHELL_LAUNCHER_OVERLAY_ORDER, -11);
    // Coexistence by unique id: the launcher is NOT the roster entry.
    assert.notEqual(SHELL_LAUNCHER_ENTRY_ID, ROSTER_ENTRY_ID);
    assert.deepEqual(rosterOverlayRegistration(), {
      name: "shell.overlay",
      id: ROSTER_ENTRY_ID,
      order: -10,
      locale: LOCALE_NAMESPACE,
    });
  });

  it("the launcher label reuses existing shell copy — no new locale key", () => {
    assert.equal(SHELL_LAUNCHER_LABEL_KEY, "shell.title");
    assert.equal(typeof localeDictionary.en["shell.title"], "string");
    assert.equal(typeof localeDictionary.zh["shell.title"], "string");
  });
});

describe("shell staging mount — apply() over the fake seams", () => {
  function findInject(
    ctx: ReturnType<typeof createMountCtx>,
    parent: string,
  ) {
    const record = ctx.injects.find((candidate) => candidate.parent === parent);
    assert.ok(record, `${parent} inject missing`);
    return record;
  }

  it("registers exactly one `main` entry with the pinned options and a component", () => {
    const ctx = createMountCtx();
    apply(ctx);
    const main = findInject(ctx, MAIN_PAGE_SLOT);
    assert.equal(main.entries.length, 1, "one `main` page entry");
    const entry = main.entries[0]!;
    assert.deepEqual(entry.options, shellPageRegistration());
    assert.equal(typeof entry.component, "function");
  });

  it("registers the launcher as a second additive shell.overlay entry; the capsule entry is untouched", () => {
    const ctx = createMountCtx();
    apply(ctx);
    const overlayRecords = ctx.injects.filter(
      (record) => record.parent === SHELL_OVERLAY_SLOT,
    );
    assert.equal(overlayRecords.length, 2, "capsule + launcher injects");
    const allOverlay = overlayRecords.flatMap((record) => record.entries);
    assert.equal(allOverlay.length, 2, "two additive overlay entries");
    const byId = allOverlay.map((e) => (e.options as { id: string }).id);
    assert.ok(byId.includes(ROSTER_ENTRY_ID));
    assert.ok(byId.includes(SHELL_LAUNCHER_ENTRY_ID));
    const launcher = allOverlay.find(
      (e) => (e.options as { id: string }).id === SHELL_LAUNCHER_ENTRY_ID,
    )!;
    assert.deepEqual(launcher.options, shellLauncherRegistration());
    assert.equal(typeof launcher.component, "function");
    // The capsule's own registration contract is byte-for-byte the old one.
    const capsule = allOverlay.find(
      (e) => (e.options as { id: string }).id === ROSTER_ENTRY_ID,
    )!;
    assert.deepEqual(capsule.options, rosterOverlayRegistration());
  });

  it("flips nothing into `root` — the election stays with the cutover slice", () => {
    const ctx = createMountCtx();
    apply(ctx);
    assert.equal(
      ctx.injects.find((record) => record.parent === ROOT_FRAME_SLOT),
      undefined,
      "no `root` inject in staging",
    );
    for (const record of ctx.injects) {
      for (const entry of record.entries) {
        assert.notEqual(
          (entry.options as { name: string }).name,
          ROOT_FRAME_SLOT,
          "no entry registered into the root slot",
        );
      }
    }
  });

  it("fiber teardown (HMR) reverses every staging registration; re-apply restores the identity", () => {
    const ctx = createMountCtx();
    apply(ctx);
    // Five declaration waits: shell.overlay (capsule), tool.call.toolview,
    // settings.plugin.item, the launcher's shell.overlay, and `main`.
    assert.equal(ctx.injects.length, 5);
    assert.equal(findInject(ctx, MAIN_PAGE_SLOT).entries.length, 1);

    ctx.runFiberTeardown();
    assert.equal(ctx.injects.length, 0);

    // A fresh fiber (post-HMR apply) registers the same contract again —
    // same slot, same key, no accumulation.
    apply(ctx);
    assert.equal(ctx.injects.length, 5);
    const main = ctx.injects.find(
      (record) => record.parent === MAIN_PAGE_SLOT,
    );
    assert.deepEqual(main?.entries[0]?.options, shellPageRegistration());
  });
});

describe("shell staging mount — openShellPage decision", () => {
  it("degrades to no-layout when the layout service is absent", () => {
    assert.deepEqual(openShellPage(undefined, SHELL_PAGE_KEY), {
      kind: "no-layout",
    });
    assert.deepEqual(openShellPage({} as ClientLayoutLike, SHELL_PAGE_KEY), {
      kind: "no-layout",
    });
  });

  it("opens through the host verb with the exact page key", () => {
    const { layout, calls } = createLayoutFake();
    assert.deepEqual(openShellPage(layout, SHELL_PAGE_KEY), {
      kind: "opened",
    });
    assert.deepEqual(calls, [SHELL_PAGE_KEY]);
  });

  it("contains the host's throw on an unregistered panel as an honest outcome", () => {
    const { layout, calls } = createLayoutFake("throws");
    assert.deepEqual(openShellPage(layout, SHELL_PAGE_KEY), {
      kind: "panel-not-registered",
    });
    assert.deepEqual(calls, []);
  });
});

describe("shell staging mount — live mounting path (mountShellPage)", () => {
  it("binds the sessions feed: initial sync, live upserts, and removals", () => {
    const feed = createSessionsFake({
      ids: ["s-1"],
      byId: { "s-1": { id: "s-1", displayTitle: "One" } },
    });
    const ctx = createMountCtx({ sessions: feed.sessions });
    const mount = mountShellPage(ctx);

    const rows = () =>
      mount.store.getBox().state.order.map(
        (id) => mount.store.getBox().state.rows.get(id)!.title,
      );
    assert.deepEqual(rows(), ["One"]);

    feed.emit({
      ids: ["s-1", "s-2"],
      byId: {
        "s-1": { id: "s-1", displayTitle: "One" },
        "s-2": { id: "s-2", displayTitle: "Two" },
      },
    });
    assert.deepEqual(rows(), ["One", "Two"]);

    feed.emit({ ids: ["s-2"], byId: { "s-2": { id: "s-2", displayTitle: "Two" } } });
    assert.deepEqual(rows(), ["Two"]);
    assert.equal(feed.counts().subscribeCount, 1);
  });

  it("selection rides the guarded open verb: known ids open, unknown ids are refused", () => {
    const feed = createSessionsFake({
      ids: ["s-1"],
      byId: { "s-1": { id: "s-1", displayTitle: "One" } },
    });
    const ctx = createMountCtx({ sessions: feed.sessions });
    const mount = mountShellPage(ctx);

    mount.hosts.onSelectSession!("s-1");
    assert.deepEqual(mount.store.getBox().state.selection, {
      kind: "session",
      sessionId: "s-1",
    });
    assert.deepEqual(feed.openCalls, ["s-1"]);

    // Unknown id: no store change, no host call (the host's open fails loud
    // on unknown ids — the guard comes first).
    mount.hosts.onSelectSession!("s-ghost");
    assert.deepEqual(feed.openCalls, ["s-1"]);
    assert.deepEqual(mount.store.getBox().state.selection, {
      kind: "session",
      sessionId: "s-1",
    });
  });

  it("projects the selected session's mirror into the hosted panel seat", () => {
    const feed = createSessionsFake({
      ids: ["s-1", "s-2"],
      byId: {
        "s-1": { id: "s-1", displayTitle: "One" },
        "s-2": { id: "s-2", displayTitle: "Two" },
      },
    });
    const ctx = createMountCtx({ sessions: feed.sessions });
    const mount = mountShellPage(ctx);

    // Dispatcher snapshot for s-1 (raw mirror value, as the settings channel
    // delivers it); s-2 stays a plain chat.
    mount.store.applySessionMirror("s-1", snapshot([worker("w-1", "running")]));

    mount.hosts.onSelectSession!("s-1");
    assert.equal(mount.seat.getBox().state.kind, "snapshot");
    // The host gate (pure) says "panel hosted"; the element itself is React
    // render territory (S8: never invoked offline).
    assert.ok(
      shellSeatHostsPanel(mount.store.getBox().state.mirrors.get("s-1")),
      "panel hosted for the dispatcher session",
    );

    // A plain chat hosts NO panel — never an invented roster.
    mount.store.select("s-2");
    mount.hosts.onSelectSession!("s-2");
    assert.equal(mount.seat.getBox().state.kind, "waiting");
    assert.equal(mount.hosts.rosterPanel!("s-2"), null);
  });

  it("a corrupt mirror keeps the panel hosted on its honest unavailable copy", () => {
    const feed = createSessionsFake({
      ids: ["s-1"],
      byId: { "s-1": { id: "s-1", displayTitle: "One" } },
    });
    const ctx = createMountCtx({ sessions: feed.sessions });
    const mount = mountShellPage(ctx);
    mount.store.applySessionMirror("s-1", { junk: true });
    mount.hosts.onSelectSession!("s-1");
    assert.equal(mount.seat.getBox().state.kind, "invalid");
    assert.ok(
      shellSeatHostsPanel(mount.store.getBox().state.mirrors.get("s-1")),
      "the corrupt-mirror session stays hosted on its unavailable copy",
    );
  });

  it("a cleared mirror (deactivation) hosts no panel at all", () => {
    const feed = createSessionsFake({
      ids: ["s-1"],
      byId: { "s-1": { id: "s-1", displayTitle: "One" } },
    });
    const ctx = createMountCtx({ sessions: feed.sessions });
    const mount = mountShellPage(ctx);
    mount.store.applySessionMirror("s-1", snapshot([worker("w-1", "running")]));
    mount.hosts.onSelectSession!("s-1");
    mount.store.applySessionMirror("s-1", null);
    assert.equal(mount.hosts.rosterPanel!("s-1"), null);
  });

  it("degrades honestly without the sessions service: empty store, no throw", () => {
    const ctx = createMountCtx();
    const mount = mountShellPage(ctx);
    assert.deepEqual(mount.store.getBox().state.order, []);
    assert.equal(mount.seat.getBox().state.kind, "waiting");
    assert.equal(mount.hosts.rosterPanel!("s-1"), null);
    assert.doesNotThrow(() => mount.hosts.onSelectSession!("s-1"));
  });

  it("fiber teardown unsubscribes the feed and stops the seat projection", () => {
    const feed = createSessionsFake({
      ids: ["s-1"],
      byId: { "s-1": { id: "s-1", displayTitle: "One" } },
    });
    const ctx = createMountCtx({ sessions: feed.sessions });
    const mount = mountShellPage(ctx);
    assert.deepEqual(mount.store.getBox().state.order, ["s-1"]);

    ctx.runFiberTeardown();
    assert.equal(feed.counts().unsubscribeCount, 1);

    // A post-teardown feed notification touches nothing (the binding is gone).
    feed.emit({ ids: [], byId: {} });
    assert.deepEqual(mount.store.getBox().state.order, ["s-1"]);
  });
});

describe("shell staging mount — seat projection primitives", () => {
  const parsed = snapshot([worker("w-1", "running")]);

  it("no mirror or a cleared mirror hosts nothing", () => {
    assert.equal(shellSeatPanelState(undefined), null);
    assert.deepEqual(shellSeatPanelState({ kind: "cleared" }), null);
  });

  it("a corrupt mirror maps to the panel's invalid (unavailable-copy) state", () => {
    assert.deepEqual(shellSeatPanelState({ kind: "unavailable" }), {
      kind: "invalid",
    });
  });

  it("a parsed mirror maps to the snapshot state, panel rules untouched", () => {
    const state = shellSeatPanelState({ kind: "snapshot", snapshot: parsed });
    assert.deepEqual(state, { kind: "snapshot", snapshot: parsed });
  });
});

describe("root fail-safe — the cutover's election contract (pinned, not registered)", () => {
  const shipped: ShellCellEntry = {
    entryId: "dsh-app-frame",
    // The shipped frame's priority value is dsh-owned; only "higher than any
    // dynamic registration" is contract (registry.d.ts:24-27).
    priority: 10,
  };
  const ours: ShellCellEntry = {
    entryId: "multitask-dispatcher-shell-frame",
    priority: SHELL_ROOT_DYNAMIC_PRIORITY,
  };

  it("names the cutover slot; the staging registration never touches it", () => {
    assert.equal(ROOT_FRAME_SLOT, "root");
    assert.notEqual(MAIN_PAGE_SLOT, ROOT_FRAME_SLOT);
  });

  it("an empty cell has no winner", () => {
    assert.equal(shellCellWinner([]), null);
  });

  it("the dynamic entry wins the cell exactly while it stays live", () => {
    assert.equal(shellCellWinner([ours, shipped]), ours);
    assert.equal(shellCellWinner([shipped, ours]), ours);
  });

  it("abdication falls back to the shipped frame — ADR-0020's fail-safe", () => {
    const crashed: ShellCellEntry = { ...ours, abdicated: true };
    assert.equal(shellCellWinner([crashed, shipped]), shipped);
  });

  it("an abdicated shipped frame hands the live dynamic entry the cell", () => {
    const crashedShipped: ShellCellEntry = { ...shipped, abdicated: true };
    assert.equal(shellCellWinner([ours, crashedShipped]), ours);
  });

  it("all entries abdicated: no winner (the cell's honest error state)", () => {
    assert.equal(
      shellCellWinner([
        { ...ours, abdicated: true },
        { ...shipped, abdicated: true },
      ]),
      null,
    );
  });
});
