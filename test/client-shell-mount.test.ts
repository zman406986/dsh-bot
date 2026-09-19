/**
 * Ticket 78 — wrapper shell mount (ADR-0020 slice 2: staging contracts +
 * the CUTOVER's root-frame election).
 *
 * Offline only (S8): the registration contracts pinned over fakes in
 * the established overlay/toolview style — inject → register, one entry, id
 * stability — plus the page-open decision and the pure root fail-safe model.
 * The `root` election's REGISTRATION is pinned here (one dynamic entry,
 * contract options incl. the explicit shadowing priority — ticket 85,
 * collision-throwing fakes, unload abdication over fakes); the election's
 * LIVE half (frame swap, HMR fiber behavior, fallback-on-crash in a real
 * browser) is live-only (tickets 45/33) and is deliberately NOT claimed
 * here.
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
  createShellLauncherLayout,
  openShellPage,
  shellCellWinner,
  shellLauncherRegistration,
  shellPageRegistration,
  shellRootRegistration,
  shellSeatHostsPanel,
  shellSeatPanelState,
  type ShellCellEntry,
} from "../src/client/shell-mount.js";
import { createDispatcherShellStore } from "../src/client/shell-store.js";
import type { ConversationWindowLike } from "../src/client/conversation-store.js";
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
 *
 * Ticket 85 (2026-09-19): the slots fake models the shipped SlotCore
 * registry's collision rule — one global cell per slot name, entries kept
 * sorted ASCENDING by `(priority ?? 0)`, and `register` THROWS on a
 * same-(priority ?? 0) collision along the entry's identity axis (single:
 * every entry; keyed: same `key`; list: same `id`) with the host's error
 * wording ("… at priority N — register at a different priority to shadow it
 * (lowest renders)"). An absent priority defaults to 0 exactly like the
 * shipped code, so the ticket-85 live crash (no-priority root register vs
 * the shipped frame) now fails offline. The per-entry dispose (register's
 * return, run by the inject controller on fiber teardown) removes the entry,
 * so unload/HMR frees the cell like the shipped registry's cascade.
 * (dsh-web-frontend `dist/assets/index-BKQ_L1z6.js`, SlotCore.register +
 * `entriesOfSlot`, minified.)
 */
function createMountCtx(services: {
  sessions?: ClientSessionsLike;
  layout?: ClientLayoutLike;
} = {}) {
  const locales = new Map<string, unknown>();
  const cells = new Map<
    string,
    Array<{
      options: Record<string, unknown>;
      component: unknown;
      dispose(): void;
    }>
  >();
  const injects: Array<{
    parent: string;
    entries: Array<{
      options: Record<string, unknown>;
      component: unknown;
      dispose(): void;
    }>;
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
        const record = { parent, entries: [] as typeof injects[number]["entries"] };
        injects.push(record);
        callback();
        const controller = () => {
          const at = injects.indexOf(record);
          if (at >= 0) injects.splice(at, 1);
          for (const entry of record.entries.splice(0)) entry.dispose();
        };
        injectControllers.push(controller);
        return controller;
      },
      register(rawOptions: unknown, component: unknown) {
        const owner = injects.at(-1);
        assert.ok(owner, "slots.register outside of slots.inject (fake)");
        const options = rawOptions as {
          name: string;
          key?: string;
          id?: string;
          priority?: number;
        };
        assert.equal(
          typeof options.name,
          "string",
          "slot options need a string `name` (fake)",
        );
        const cell = cells.get(options.name) ?? [];
        cells.set(options.name, cell);
        const priority = options.priority ?? 0;
        const collision = cell.find((entry) => {
          const other = entry.options as {
            key?: string;
            id?: string;
            priority?: number;
          };
          if (options.key !== undefined) {
            return other.key === options.key && (other.priority ?? 0) === priority;
          }
          if (options.id !== undefined) {
            return other.id === options.id && (other.priority ?? 0) === priority;
          }
          return (other.priority ?? 0) === priority;
        });
        if (collision !== undefined) {
          // Host wording per kind (SlotCore.register's single/keyed/list
          // cases; the registrant suffix is omitted — the fake has none).
          const kind =
            options.key !== undefined
              ? "keyed slot"
              : options.id !== undefined
                ? "list slot"
                : "single slot";
          const axis =
            options.key !== undefined
              ? ` for key "${options.key}"`
              : options.id !== undefined
                ? ` with id "${options.id}"`
                : "";
          throw new Error(
            `${kind} "${options.name}" already has a registration${axis} ` +
              `at priority ${priority} — register at a different priority ` +
              `to shadow it (lowest renders)`,
          );
        }
        const entry = {
          options: { ...rawOptions } as Record<string, unknown>,
          component,
          dispose: () => {},
        };
        cell.push(entry);
        // Insert-time ascending (priority ?? 0) sort, stable for ties —
        // first registered first — exactly the shipped registry's order.
        cell.sort(
          (a, b) =>
            ((a.options.priority as number | undefined) ?? 0) -
            ((b.options.priority as number | undefined) ?? 0),
        );
        entry.dispose = () => {
          const ownerAt = owner.entries.indexOf(entry);
          if (ownerAt >= 0) owner.entries.splice(ownerAt, 1);
          const cellAt = cell.indexOf(entry);
          if (cellAt >= 0) cell.splice(cellAt, 1);
        };
        owner.entries.push(entry);
        return entry.dispose;
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
    /** The slot's live cell in host election order (ascending priority). */
    slotCell(name: string) {
      return (cells.get(name) ?? []).map((entry) => ({ ...entry.options }));
    },
    runFiberTeardown() {
      for (const dispose of [...effectDisposers, ...injectControllers]) {
        dispose();
      }
    },
  };
  return ctx as typeof ctx & ClientContext & {
    runFiberTeardown(): void;
    slotCell(name: string): Array<Record<string, unknown>>;
  };
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

  it("pins the launcher overlay registration as RETIRED pure data — own id, ordered beside the capsule", () => {
    // The launcher registration CONTRACT stays exported as the retired
    // vehicle's pure data (the 65/66/73 lane owns disposition); nothing
    // registers it since the cutover (pinned above).
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

  it("registers NO shell.overlay entries — capsule and launcher retired at the cutover", () => {
    const ctx = createMountCtx();
    apply(ctx);
    // The cutover ends the capsule era (ticket 78's second AC): the roster
    // capsule's additive entry AND the staging launcher chip's entry stop
    // registering — no `shell.overlay` inject controller exists at all.
    // Their sources stay as retired-vehicle assets (the 65/66/73 lane owns
    // dead-code disposition).
    const overlayRecords = ctx.injects.filter(
      (record) => record.parent === SHELL_OVERLAY_SLOT,
    );
    assert.equal(overlayRecords.length, 0, "no shell.overlay injects");
    for (const record of ctx.injects) {
      for (const entry of record.entries) {
        assert.notEqual(
          (entry.options as { id?: string }).id,
          ROSTER_ENTRY_ID,
          "the capsule entry must not register",
        );
        assert.notEqual(
          (entry.options as { id?: string }).id,
          SHELL_LAUNCHER_ENTRY_ID,
          "the launcher entry must not register",
        );
      }
    }
  });

  it("registers exactly one `root` entry — the cutover's dynamic election", () => {
    const ctx = createMountCtx();
    apply(ctx);
    const roots = ctx.injects.filter(
      (record) => record.parent === ROOT_FRAME_SLOT,
    );
    assert.equal(roots.length, 1, "one `root` inject controller");
    assert.equal(roots[0]!.entries.length, 1, "one dynamic root entry");
    const entry = roots[0]!.entries[0]!;
    assert.deepEqual(entry.options, shellRootRegistration());
    assert.equal(typeof entry.component, "function");
    // The single-slot shape: no `id`, no `key`, and — since ticket 85
    // (2026-09-19) — the EXPLICIT shadowing priority. The cutover's original
    // no-priority options defaulted to 0, collided with the shipped frame's
    // own effective 0 (dsh-client-ui-layout lib/client.js:524-531 registers
    // `{name: "root", …}` with no priority), and the shipped register THREW,
    // killing the whole loader entry (live pass 3).
    assert.deepEqual(entry.options, {
      name: "root",
      locale: "multitask-dispatcher",
      priority: -1,
    });
    assert.deepEqual(shellRootRegistration(), shellRootRegistration());
    // The shipped `conversation` main key is still never claimed — the
    // election shadows the FRAME, never a keyed page.
    for (const record of ctx.injects) {
      for (const other of record.entries) {
        const options = other.options as { name: string; key?: string };
        if (options.name === MAIN_PAGE_SLOT) {
          assert.notEqual(options.key, SHIPPED_MAIN_PAGE_KEY);
        }
      }
    }
  });

  it("the constant IS the registration's priority and is below the shipped frame's 0 (ticket 85)", () => {
    // The ticket-78 cutover shipped SHELL_ROOT_DYNAMIC_PRIORITY as a model
    // constant only; ticket 85 threads it onto the options AND flips it to
    // the verified direction: the shipped SlotCore keeps entries sorted
    // ascending by `(priority ?? 0)` and renders the first live entry
    // ("lowest renders"), so shadowing the frame requires a value BELOW its
    // effective 0 — and equal to it THROWS.
    assert.equal(SHELL_ROOT_DYNAMIC_PRIORITY, -1);
    assert.equal(
      shellRootRegistration().priority,
      SHELL_ROOT_DYNAMIC_PRIORITY,
      "the live registration carries the constant",
    );
    assert.ok(
      shellRootRegistration().priority < 0,
      "strictly below the shipped frame's effective priority 0",
    );
  });

  it("the fake models the host collision: a no-priority `root` register THROWS at priority 0 (the ticket-85 live crash, offline)", () => {
    const ctx = createMountCtx();
    // Seed the cell the way the shipped runtime stands: the AppFrame already
    // in `root` at its effective priority 0 (its registration carries no
    // priority; dsh-client-ui-layout lib/client.js:524-531).
    ctx.slots.inject(ROOT_FRAME_SLOT, () => {
      ctx.slots.register({ name: ROOT_FRAME_SLOT }, function ShippedAppFrame() {});
    });
    // The pre-85 registration shape — options WITHOUT a priority, what
    // `shellRootRegistration` shipped at the cutover — must fail loudly
    // OFFLINE (the 84/85 lesson: fakes teach the host's contract, not a
    // gentler one). The live pass-3 loader entry died on exactly this throw.
    assert.throws(
      () =>
        ctx.slots.inject(ROOT_FRAME_SLOT, () => {
          ctx.slots.register({ name: ROOT_FRAME_SLOT }, function Latecomer() {});
        }),
      /single slot "root" already has a registration at priority 0 — register at a different priority to shadow it \(lowest renders\)/,
    );
    // An EXPLICIT same-priority registration collides too — the host rule is
    // the priority VALUE, not the field's absence.
    assert.throws(
      () =>
        ctx.slots.inject(ROOT_FRAME_SLOT, () => {
          ctx.slots.register(
            { name: ROOT_FRAME_SLOT, priority: 0 },
            function SamePriority() {},
          );
        }),
      /already has a registration at priority 0/,
    );
    // …and a different priority shadows instead of throwing — the shipped
    // contract the cutover's -1 rides.
    assert.doesNotThrow(() =>
      ctx.slots.inject(ROOT_FRAME_SLOT, () => {
        ctx.slots.register(
          { name: ROOT_FRAME_SLOT, priority: -1 },
          function Shadow() {},
        );
      }),
    );
  });

  it("the explicit priority shadows the seeded frame; the cell order and shellCellWinner agree with the host rule", () => {
    const ctx = createMountCtx();
    ctx.slots.inject(ROOT_FRAME_SLOT, () => {
      ctx.slots.register({ name: ROOT_FRAME_SLOT }, function ShippedAppFrame() {});
    });
    // With the explicit -1 there is no collision: the register succeeds and
    // shadows the frame.
    apply(ctx);
    assert.deepEqual(ctx.slotCell(ROOT_FRAME_SLOT), [
      // Ascending (priority ?? 0) — ours first, the shipped frame second:
      // the host's insert-time stable sort (SlotCore.register).
      { name: "root", locale: "multitask-dispatcher", priority: -1 },
      { name: "root" },
    ]);
    // The pure election decision over the host-shaped cell (first live
    // entry in ascending priority order) picks ours exactly as the shipped
    // `entriesOfSlot` scan would.
    const cellEntries: ShellCellEntry[] = ctx
      .slotCell(ROOT_FRAME_SLOT)
      .map((options, index) => ({
        entryId: `cell-${index}`,
        priority: (options.priority as number | undefined) ?? 0,
      }));
    assert.equal(shellCellWinner(cellEntries)?.priority, -1);

    // Teardown (unload/HMR) frees the cell — both fibers' controllers sweep
    // their entries — and a fresh apply registers -1 again with no stale
    // collision (the freed cell cannot throw).
    ctx.runFiberTeardown();
    assert.deepEqual(ctx.slotCell(ROOT_FRAME_SLOT), []);
    assert.doesNotThrow(() => apply(ctx));
    assert.equal(ctx.slotCell(ROOT_FRAME_SLOT).length, 1);
    assert.equal(
      (
        ctx.slotCell(ROOT_FRAME_SLOT)[0] as { priority?: number }
      ).priority,
      SHELL_ROOT_DYNAMIC_PRIORITY,
    );
  });

  it("unload abdicates the cell: teardown empties `root`; the shipped frame is the surviving winner", () => {
    const ctx = createMountCtx();
    apply(ctx);
    assert.equal(
      ctx.injects.filter((record) => record.parent === ROOT_FRAME_SLOT)
        .length,
      1,
    );

    // The caller's-fiber cascade (registry.d.ts:77-83) sweeps the entry with
    // the fiber: nothing of ours stays live in the single cell.
    ctx.runFiberTeardown();
    assert.equal(ctx.injects.length, 0);

    // The documented election over the surviving cell hands it back to the
    // shipped app frame (the pure model of the abdicated dynamic entry).
    // Ticket 85 (2026-09-19): the shipped frame's effective priority is 0 —
    // verified (its registration carries none; `?? 0`), not just "ours to
    // guess" — and ours is the explicit -1.
    const ours: ShellCellEntry = {
      entryId: "multitask-dispatcher-shell-frame",
      priority: SHELL_ROOT_DYNAMIC_PRIORITY,
      abdicated: true,
    };
    const shipped: ShellCellEntry = { entryId: "dsh-app-frame", priority: 0 };
    assert.equal(shellCellWinner([ours, shipped]), shipped);
  });

  it("fiber teardown (HMR) reverses every registration incl. the dynamic root entry; re-apply restores the identity", () => {
    const ctx = createMountCtx();
    apply(ctx);
    // Four declaration waits: tool.call.toolview, settings.plugin.item,
    // `main` (the staging page registration, retained), and `root` (the
    // cutover's frame election). The capsule + launcher shell.overlay
    // injects retired at the cutover.
    assert.equal(ctx.injects.length, 4);
    assert.equal(findInject(ctx, MAIN_PAGE_SLOT).entries.length, 1);
    assert.equal(findInject(ctx, ROOT_FRAME_SLOT).entries.length, 1);

    ctx.runFiberTeardown();
    assert.equal(ctx.injects.length, 0);

    // A fresh fiber (post-HMR apply) registers the same contract again —
    // same slot, same key, no accumulation.
    apply(ctx);
    assert.equal(ctx.injects.length, 4);
    const main = ctx.injects.find(
      (record) => record.parent === MAIN_PAGE_SLOT,
    );
    assert.deepEqual(main?.entries[0]?.options, shellPageRegistration());
    const root = ctx.injects.find(
      (record) => record.parent === ROOT_FRAME_SLOT,
    );
    assert.deepEqual(root?.entries[0]?.options, shellRootRegistration());
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

describe("shell staging mount — host inject guard semantics (ticket 84)", () => {
  /** Guard proxy: undeclared service reads throw like the real host proxy. */
  function guardCtx(ctx: ClientContext): ClientContext {
    const declared = new Set([
      "slots",
      "locale",
      "sessions",
      "remote",
      "conversation",
    ]);
    const faces = new Set([
      "slots",
      "locale",
      "sessions",
      "remote",
      "conversation",
      "layout",
      "settingsScope",
    ]);
    return new Proxy(ctx as unknown as Record<string, unknown>, {
      get(target, prop, receiver) {
        if (
          typeof prop === "string" &&
          faces.has(prop) &&
          !declared.has(prop)
        ) {
          throw new Error(`cannot get property "${prop}" without inject`);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as ClientContext;
  }

  it("the layout cell feeds the click: absent → no-layout, delivered → opened", () => {
    const launcherLayout = createShellLauncherLayout(SHELL_PAGE_KEY);
    assert.deepEqual(launcherLayout.open(), { kind: "no-layout" });
    const { layout, calls } = createLayoutFake();
    launcherLayout.setFace(layout);
    assert.deepEqual(launcherLayout.open(), { kind: "opened" });
    assert.deepEqual(calls, [SHELL_PAGE_KEY]);
    // Teardown drops the face; the click degrades again — never throws.
    launcherLayout.setFace(undefined);
    assert.deepEqual(launcherLayout.open(), { kind: "no-layout" });
  });

  it("apply() never bare-reads the optional layout face — even when a fake hands one", () => {
    // The live-pass-2 kill: `ctx.layout` was read bare (at click time) and
    // the host's context proxy threw. The launcher that watched `layout`
    // retired at the cutover, so the module no longer requests the face at
    // all — but the guard contract must hold regardless: over a context
    // that throws on exactly that read — with a layout fake SITTING on the
    // context, so only a bare read can reach it — the composition must
    // still apply cleanly.
    const { layout } = createLayoutFake();
    const ctx = createMountCtx({ layout });
    const guarded = guardCtx(ctx);
    assert.throws(
      () => (guarded as unknown as { layout: unknown }).layout,
      { message: 'cannot get property "layout" without inject' },
      "guard self-check: a bare layout read must throw",
    );
    assert.doesNotThrow(() => apply(guarded));
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

describe("root fail-safe — the cutover's election contract (pure model + unload path)", () => {
  const shipped: ShellCellEntry = {
    entryId: "dsh-app-frame",
    // Ticket 85 (2026-09-19): the shipped frame's effective priority is 0 —
    // it registers `{name: "root", …}` with no priority and the shipped
    // SlotCore defaults `(priority ?? 0)` (dsh-client-ui-layout
    // lib/client.js:524-531 + the web frontend's SlotCore.register; also
    // pinned by the live pass-3 error text "already has a registration at
    // priority 0").
    priority: 0,
  };
  const ours: ShellCellEntry = {
    entryId: "multitask-dispatcher-shell-frame",
    priority: SHELL_ROOT_DYNAMIC_PRIORITY,
  };

  it("names the cutover slot; the keyed main page is a different slot", () => {
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

describe("shell conversation surface mount (ticket 80, Finding 7 seam)", () => {
  /** Sessions face with binding-capable event windows (the verified seam). */
  function createBindingSessionsFake(windows: Map<string, ConversationWindowLike>) {
    const subscriptions: string[] = [];
    const unsubscriptions: string[] = [];
    const openCalls: string[] = [];
    const sessions: ClientSessionsLike = {
      list: {
        getSnapshot: () => ({
          ids: [...windows.keys()],
          // The ticket-79 projection skips ids without a delivered summary,
          // so the fake delivers rows for every windowed session.
          byId: Object.fromEntries(
            [...windows.keys()].map((id) => [id, { id, displayTitle: id }]),
          ),
        }),
        subscribe: () => () => {},
      },
      scope: () => undefined,
      open(id) {
        openCalls.push(id);
      },
      binding(id) {
        if (!windows.has(id)) return undefined;
        return {
          eventSource: {
            getSnapshot: () => windows.get(id) ?? {},
            subscribe() {
              subscriptions.push(id);
              return () => {
                unsubscriptions.push(id);
              };
            },
          },
        };
      },
    };
    return { sessions, openCalls, subscriptions, unsubscriptions };
  }

  it("the mount exposes the conversation store and the pane host seat", () => {
    const ctx = createMountCtx();
    const mount = mountShellPage(ctx);
    assert.equal(typeof mount.conversation.subscribe, "function");
    assert.equal(typeof mount.hosts.conversation, "function");
    // Never invoked offline (hooks need a renderer; S8 discipline).
    assert.deepEqual(mount.conversation.stateFor("s-1"), { kind: "waiting" });
  });

  it("selecting a session feeds its event window into the conversation store", () => {
    const windows = new Map<string, ConversationWindowLike>([
      ["s-1", { entries: [] }],
    ]);
    const fake = createBindingSessionsFake(windows);
    const ctx = createMountCtx({ sessions: fake.sessions });
    const mount = mountShellPage(ctx);

    mount.hosts.onSelectSession!("s-1");
    assert.deepEqual(fake.openCalls, ["s-1"]); // staging (ticket 79's ride-along)
    assert.deepEqual(fake.subscriptions, ["s-1"]);
    assert.equal(mount.conversation.stateFor("s-1").kind, "ready");

    ctx.runFiberTeardown();
    assert.deepEqual(fake.unsubscriptions, ["s-1"]);
  });

  it("a runtime whose sessions face has no binding degrades to honest unavailability", () => {
    const feed = createSessionsFake({
      ids: ["s-1"],
      byId: { "s-1": { id: "s-1", displayTitle: "One" } },
    });
    const ctx = createMountCtx({ sessions: feed.sessions });
    const mount = mountShellPage(ctx);
    mount.hosts.onSelectSession!("s-1");
    assert.deepEqual(mount.conversation.stateFor("s-1"), {
      kind: "unavailable",
    });
    assert.doesNotThrow(() => ctx.runFiberTeardown());
  });

  it("without the sessions service at all, the pane stays waiting and teardown is clean", () => {
    const ctx = createMountCtx();
    const mount = mountShellPage(ctx);
    mount.hosts.onSelectSession!("s-1");
    assert.deepEqual(mount.conversation.stateFor("s-1"), { kind: "waiting" });
    assert.doesNotThrow(() => ctx.runFiberTeardown());
  });
});
