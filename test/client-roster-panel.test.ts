/**
 * Ticket 21 — client roster panel: store, view model, and apply() wiring
 * over fake client seams (client-face scaffold idioms from ticket 20).
 *
 * Offline only (S8): no real Cordis, no browser, no DOM harness. Component
 * rendering stays covered by build success + typecheck; everything asserted
 * here is pure logic (store + view model) or fake-seam registration.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  apply,
  applyClientModule,
  inject as clientInject,
} from "../src/client/index.js";
import type { ClientContext } from "../src/client/context.js";
import {
  LOCALE_NAMESPACE,
  ROSTER_ENTRY_ID,
  localeDictionary,
  rosterOverlayRegistration,
  SHELL_OVERLAY_SLOT,
  type SlotRegistrationOptions,
} from "../src/client/overlay.js";
import {
  ROSTER_STALE_RECHECK_MS,
  createRosterStore,
  describeRosterPanel,
  rosterStatusLabel,
  type RosterPanelState,
} from "../src/client/roster-store.js";
import {
  ROSTER_SETTINGS_KEY,
  ROSTER_STALE_WINDOW_MS,
  ROSTER_STATUS_KEYS,
  type RosterSnapshot,
} from "../src/core/roster-snapshot.js";
import type { WorkerStatus } from "../src/core/types.js";

/** A v1 snapshot builder for feed tests. */
function snapshot(
  workers: Array<{
    workerId: string;
    title: string;
    status: WorkerStatus;
    todoId: string | null;
  }>,
  publishedAtMs = 1_000,
): RosterSnapshot {
  return {
    schemaVersion: 1,
    dispatcherSessionId: "s-1",
    publishedAtMs,
    workers,
  };
}

/** Fake the client face (see test/client-face-scaffold.test.ts for the idiom),
 * extended with the optional settings inject/watch seam. */
function createClientCtx(options?: { withSettings?: boolean }) {
  const locales = new Map<string, unknown>();
  const injects: Array<{
    parent: string;
    entries: Array<{ options: SlotRegistrationOptions; component: unknown }>;
  }> = [];
  const injectControllers: Array<() => void> = [];
  const effectDisposers: Array<() => void> = [];
  let watchCallback: ((value: unknown) => void) | undefined;
  let watchDisposed = 0;
  const withSettings = options?.withSettings ?? true;

  const ctx = {
    effect(execute: () => unknown, label?: string) {
      void label;
      const returned = execute();
      const disposer: () => void =
        typeof returned === "function" ? returned : () => {};
      effectDisposers.push(disposer);
      return () => {};
    },
    inject(services: readonly string[], callback: (child: unknown) => void) {
      if (services.includes("settings") && withSettings) {
        callback({
          settings: {
            watch(_namespace: string, onChange: (value: unknown) => void) {
              watchCallback = onChange;
              return () => {
                watchDisposed += 1;
              };
            },
          },
        });
      }
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
      register(options: SlotRegistrationOptions, component: unknown) {
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
    fireSettingsWatch(value: unknown) {
      assert.ok(watchCallback, "settings watch was never installed");
      watchCallback(value);
    },
    watchDisposedCount: () => watchDisposed,
    runFiberTeardown() {
      for (const dispose of [...effectDisposers, ...injectControllers]) {
        dispose();
      }
    },
  };
  return ctx as typeof ctx & ClientContext & {
    fireSettingsWatch(value: unknown): void;
    watchDisposedCount(): number;
    runFiberTeardown(): void;
  };
}

describe("roster panel — view model degrades honestly (design-16 §6)", () => {
  it("waiting, channel-missing, and invalid states all render unavailable", () => {
    for (const state of [
      { kind: "waiting" },
      { kind: "channel-missing" },
      { kind: "invalid" },
    ] as const satisfies readonly RosterPanelState[]) {
      assert.deepEqual(describeRosterPanel(state, 5_000), { kind: "unavailable" });
    }
  });

  it("a fresh empty snapshot renders the empty state", () => {
    const view = describeRosterPanel(
      { kind: "snapshot", snapshot: snapshot([], 1_000) },
      1_000 + ROSTER_STALE_WINDOW_MS,
    );
    assert.deepEqual(view, { kind: "empty" });
  });

  it("a fresh roster renders rows with verbatim core FSM status labels", () => {
    const workers = ROSTER_STATUS_KEYS.map((status, index) => ({
      workerId: `w-${index}`,
      title: `Worker ${index}`,
      status,
      todoId: index % 2 === 0 ? `todo-${index}` : null,
    }));
    const view = describeRosterPanel(
      { kind: "snapshot", snapshot: snapshot(workers, 1_000) },
      1_100,
    );
    assert.equal(view.kind, "rows");
    if (view.kind !== "rows") return;
    assert.equal(view.rows.length, ROSTER_STATUS_KEYS.length);
    for (const [index, row] of view.rows.entries()) {
      assert.equal(row.statusLabel, ROSTER_STATUS_KEYS[index]);
      assert.equal(row.title, `Worker ${index}`);
      assert.equal(row.todoId, index % 2 === 0 ? `todo-${index}` : null);
    }
  });

  it("an empty title falls back to the worker id; the label mapping is identity", () => {
    assert.equal(rosterStatusLabel("steering"), "steering");
    const view = describeRosterPanel(
      {
        kind: "snapshot",
        snapshot: snapshot([
          { workerId: "w-1", title: "", status: "running", todoId: null },
        ]),
      },
      1_000,
    );
    assert.deepEqual(view, {
      kind: "rows",
      rows: [
        { workerId: "w-1", title: "w-1", statusLabel: "running", todoId: null },
      ],
    });
  });

  it("a snapshot past the stale window renders unavailable, not old data", () => {
    const state: RosterPanelState = {
      kind: "snapshot",
      snapshot: snapshot(
        [{ workerId: "w", title: "T", status: "running", todoId: null }],
        1_000,
      ),
    };
    assert.equal(describeRosterPanel(state, 1_000 + ROSTER_STALE_WINDOW_MS).kind, "rows");
    assert.equal(
      describeRosterPanel(state, 1_000 + ROSTER_STALE_WINDOW_MS + 1).kind,
      "unavailable",
    );
  });
});

describe("roster panel — store applies the settings-watch feed", () => {
  it("starts waiting; unrelated settings writes leave the state untouched", () => {
    const store = createRosterStore();
    assert.equal(store.getBox().state.kind, "waiting");

    store.applyChannelValue({ enabled: false, accessRequestTimeoutMs: 1 });
    assert.equal(store.getBox().state.kind, "waiting");

    // Non-object payloads are a broken feed, not an unrelated write.
    store.applyChannelValue(null);
    assert.equal(store.getBox().state.kind, "invalid");
  });

  it("a roster payload becomes the snapshot; a malformed one marks invalid", () => {
    const store = createRosterStore();
    const good = snapshot([
      { workerId: "w", title: "T", status: "spawned", todoId: null },
    ]);
    store.applyChannelValue({ [ROSTER_SETTINGS_KEY]: good });
    assert.deepEqual(store.getBox().state, { kind: "snapshot", snapshot: good });

    store.applyChannelValue({
      [ROSTER_SETTINGS_KEY]: { ...good, schemaVersion: 42 },
    });
    assert.equal(store.getBox().state.kind, "invalid");
  });

  it("subscribe fires on semantic change; refresh re-renders without new data", () => {
    const store = createRosterStore();
    let notified = 0;
    const dispose = store.subscribe(() => {
      notified += 1;
    });

    store.applyChannelValue({ [ROSTER_SETTINGS_KEY]: snapshot([]) });
    const versionBefore = store.getBox().version;
    store.refresh();
    assert.equal(store.getBox().version, versionBefore + 1);
    assert.equal(notified, 2);

    dispose();
    store.refresh();
    assert.equal(notified, 2, "disposer unsubscribes");

    // The staleness recheck tick is slower than the stale window.
    assert.ok(ROSTER_STALE_RECHECK_MS < ROSTER_STALE_WINDOW_MS);
  });
});

describe("roster panel — apply() wires the fallback data path and the overlay entry", () => {
  /** The shell.overlay inject record, whatever the module also registers. */
  function overlayInject(ctx: ReturnType<typeof createClientCtx>) {
    const record = ctx.injects.find(
      (candidate) => candidate.parent === SHELL_OVERLAY_SLOT,
    );
    assert.ok(record, "shell.overlay inject missing");
    return record;
  }

  it("registers locale, one roster overlay entry, and the settings watch", () => {
    const ctx = createClientCtx();
    apply(ctx);

    // Ticket 24 adds a second inject (tool.call.toolview); the roster
    // contract stays: one overlay entry with the builder's options.
    const overlay = overlayInject(ctx);
    assert.equal(overlay.entries.length, 1);
    assert.deepEqual(overlay.entries[0]?.options, rosterOverlayRegistration());
    assert.equal(typeof overlay.entries[0]?.component, "function");
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));
  });

  it("namespaced entry id, shipped list slot, low order, plugin-id locale", () => {
    const options = rosterOverlayRegistration();
    assert.equal(ROSTER_ENTRY_ID, "multitask-dispatcher-roster");
    assert.equal(options.id, ROSTER_ENTRY_ID);
    assert.equal(options.name, SHELL_OVERLAY_SLOT);
    assert.ok(options.order < 0, "low order sorts the quiet roster early");
    assert.equal(options.locale, "multitask-dispatcher");
  });

  it("the data-fallback path feeds the panel: watch payload becomes rows", () => {
    const ctx = createClientCtx();
    const store = createRosterStore();
    applyClientModule(ctx, store);

    // Host mirror lands under the roster key with two workers.
    ctx.fireSettingsWatch({
      [ROSTER_SETTINGS_KEY]: snapshot([
        { workerId: "w-1", title: "Parser", status: "running", todoId: null },
        { workerId: "w-2", title: "Tester", status: "steering", todoId: "t-9" },
      ]),
    });

    // The same store the panel component subscribes to now holds the rows.
    assert.deepEqual(store.getBox().state, {
      kind: "snapshot",
      snapshot: snapshot([
        { workerId: "w-1", title: "Parser", status: "running", todoId: null },
        { workerId: "w-2", title: "Tester", status: "steering", todoId: "t-9" },
      ]),
    });
    const view = describeRosterPanel(store.getBox().state, 1_000);
    assert.ok(view.kind === "rows");
    assert.deepEqual(
      view.rows.map((row) => [row.title, row.statusLabel, row.todoId]),
      [
        ["Parser", "running", null],
        ["Tester", "steering", "t-9"],
      ],
    );

    // The rendered entry is bound to the plugin's copy seat.
    const t = ctx.locale.bind(LOCALE_NAMESPACE);
    assert.equal(t("roster.title"), "Workers");
  });

  it("a garbage feed flips the panel to the unavailable copy, never a hang", () => {
    const ctx = createClientCtx();
    apply(ctx);
    ctx.fireSettingsWatch({ [ROSTER_SETTINGS_KEY]: { broken: true } });
    const view = describeRosterPanel({ kind: "invalid" }, 1_000);
    assert.deepEqual(view, { kind: "unavailable" });
    // The copy exists in both faces for the degraded state.
    assert.equal(typeof localeDictionary.en["roster.unavailable"], "string");
    assert.equal(typeof localeDictionary.zh["roster.unavailable"], "string");
  });

  it("no settings service at all: channel-missing, panel unavailable", () => {
    const ctx = createClientCtx({ withSettings: false });
    apply(ctx);
    assert.deepEqual(describeRosterPanel({ kind: "channel-missing" }, 0), {
      kind: "unavailable",
    });
  });

  it("no inject capability: channel-missing without throwing", () => {
    const ctx = createClientCtx();
    delete (ctx as { inject?: unknown }).inject;
    assert.doesNotThrow(() => apply(ctx));
  });

  it("fiber teardown (HMR) disposes the settings watch; re-apply registers one fresh", () => {
    const ctx = createClientCtx();
    apply(ctx);
    assert.equal(ctx.injects.length, 2);
    assert.equal(ctx.watchDisposedCount(), 0);

    ctx.runFiberTeardown();
    assert.equal(ctx.injects.length, 0);
    assert.equal(ctx.watchDisposedCount(), 1);
    assert.equal(ctx.locales.has(LOCALE_NAMESPACE), false);

    // Post-HMR fiber: no duplicate accumulation.
    apply(ctx);
    assert.equal(ctx.injects.length, 2);
    assert.equal(ctx.watchDisposedCount(), 1);
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));
  });
});

describe("roster panel — module-level Cordis inject list", () => {
  it("binds slots and locale; settings stays a runtime-optional inject", () => {
    assert.deepEqual([...clientInject], ["slots", "locale"]);
  });
});
