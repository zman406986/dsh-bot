/**
 * Ticket 38 — capsule chip: the collapsed presence projection + expand/
 * collapse in the existing `shell.overlay` entry (ADR-0013; seams research
 * seam 1).
 *
 * Offline only (S8): pure view-model assertions over the store kinds and
 * staleness, the expansion store's transition table, registration identity
 * (exactly ONE entry, unchanged id), and the locale/CSS contracts. Component
 * rendering stays covered by build success + typecheck, same as the panel.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../src/client/index.js";
import type { ClientContext } from "../src/client/context.js";
import {
  LOCALE_NAMESPACE,
  ROSTER_ENTRY_ID,
  SHELL_OVERLAY_SLOT,
  localeDictionary,
  rosterOverlayRegistration,
  validateLocaleDictionary,
} from "../src/client/overlay.js";
import {
  CAPSULE_CHIP_OPEN_KEY,
  CAPSULE_CHIP_WAKE_KEY,
  CAPSULE_CHIP_WORKERS_KEY,
  CAPSULE_COLLAPSE_KEY,
  CAPSULE_DELIVERABLES_COLLAPSE_KEY,
  CAPSULE_DELIVERABLES_COUNT_KEY,
  CAPSULE_DELIVERABLES_EXPAND_KEY,
  CAPSULE_DELIVERABLES_LABEL_KEY,
  CAPSULE_DOT_KEYS,
  createCapsuleStore,
  describeCapsuleChip,
  describeCapsuleDeliverables,
  type CapsuleChipDot,
} from "../src/client/capsule-store.js";
import { CAPSULE_CSS } from "../src/client/capsule.js";
import {
  ROSTER_STALE_WINDOW_MS,
  type RosterSnapshot,
  type RosterSnapshotWorker,
} from "../src/core/roster-snapshot.js";
import type { WorkerStatus } from "../src/core/types.js";

/** A v2 roster row with honest defaults; overrides keep tests terse. */
function row(
  workerId: string,
  status: WorkerStatus,
  overrides: Partial<RosterSnapshotWorker> = {},
): RosterSnapshotWorker {
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
    ...overrides,
  };
}

/** A v3 snapshot builder for chip view-model tests. */
function snapshot(
  workers: RosterSnapshotWorker[],
  publishedAtMs = 1_000,
): RosterSnapshot {
  return {
    schemaVersion: 3,
    dispatcherSessionId: "s-1",
    publishedAtMs,
    workers,
    recentResult: null,
  };
}

/**
 * Minimal fake client face for registration-identity assertions: enough of
 * the scaffold seams for `apply()` (no settings service — the data path
 * degrades to channel-missing without throwing, which is exactly the
 * dormant-chip pre-activation face).
 */
function createChipCtx() {
  const injects: Array<{
    parent: string;
    entries: Array<{ options: unknown; component: unknown }>;
  }> = [];
  const controllers: Array<() => void> = [];
  const locales = new Map<string, unknown>();
  const ctx = {
    effect(execute: () => unknown) {
      execute();
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
        controllers.push(controller);
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
    injects,
    locales,
    runFiberTeardown() {
      for (const dispose of [...controllers]) dispose();
    },
  };
  return ctx as typeof ctx & ClientContext;
}

describe("capsule chip — dot-state mapping over store kinds + staleness (ticket 38)", () => {
  it("waiting maps dormant: feed alive, nothing observed — the pre-activation face", () => {
    assert.deepEqual(describeCapsuleChip({ kind: "waiting" }, 5_000), {
      dot: "dormant",
      workerCount: null,
      wakeCount: null,
    });
  });

  it("a fresh snapshot maps active with the worker total", () => {
    const view = describeCapsuleChip(
      {
        kind: "snapshot",
        snapshot: snapshot([row("w-1", "running"), row("w-2", "steering")]),
      },
      1_000,
    );
    assert.deepEqual(view, { dot: "active", workerCount: 2, wakeCount: 0 });
  });

  it("a fresh empty snapshot stays active at zero: activation observed, no workers", () => {
    const view = describeCapsuleChip(
      { kind: "snapshot", snapshot: snapshot([]) },
      1_000,
    );
    assert.deepEqual(view, { dot: "active", workerCount: 0, wakeCount: 0 });
  });

  it("a stale snapshot maps error and vouches for no counts; exactly-at-window stays fresh", () => {
    const state = {
      kind: "snapshot",
      snapshot: snapshot([row("w", "running", { delivered: false })]),
    } as const;
    // Boundary: exactly the window is fresh (mirrors isRosterSnapshotStale).
    assert.equal(
      describeCapsuleChip(state, 1_000 + ROSTER_STALE_WINDOW_MS).dot,
      "active",
    );
    const stale = describeCapsuleChip(state, 1_000 + ROSTER_STALE_WINDOW_MS + 1);
    assert.deepEqual(stale, { dot: "error", workerCount: null, wakeCount: null });
  });

  it("invalid and channel-missing map error: degraded, never a fake count", () => {
    for (const state of [
      { kind: "channel-missing" },
      { kind: "invalid" },
    ] as const) {
      assert.deepEqual(describeCapsuleChip(state, 5_000), {
        dot: "error",
        workerCount: null,
        wakeCount: null,
      });
    }
  });

  it("the dot vocabulary is exactly three states, all with locale keys", () => {
    const states = [
      { kind: "waiting" },
      { kind: "channel-missing" },
      { kind: "invalid" },
      {
        kind: "snapshot",
        snapshot: snapshot([row("w", "running")]),
      },
    ] as const;
    const seen = new Set<CapsuleChipDot>();
    for (const state of states) {
      const dot = describeCapsuleChip(state, 1_000).dot;
      seen.add(dot);
      assert.ok(
        dot === "dormant" || dot === "active" || dot === "error",
        `unknown dot state ${dot}`,
      );
      assert.equal(typeof localeDictionary.en[CAPSULE_DOT_KEYS[dot]], "string");
    }
    // All store kinds together exercise every state.
    assert.deepEqual([...seen].sort(), ["active", "dormant", "error"]);
  });
});

describe("capsule chip — worker count + wake badge (ticket 38)", () => {
  it("worker count renders only in active; dormant and error hide it", () => {
    assert.equal(
      describeCapsuleChip({ kind: "waiting" }, 5_000).workerCount,
      null,
    );
    assert.equal(
      describeCapsuleChip({ kind: "channel-missing" }, 5_000).workerCount,
      null,
    );
    assert.equal(
      describeCapsuleChip(
        {
          kind: "snapshot",
          snapshot: snapshot([row("w", "running")], 1_000),
        },
        1_000 + ROSTER_STALE_WINDOW_MS + 1,
      ).workerCount,
      null,
    );
    assert.equal(
      describeCapsuleChip(
        { kind: "snapshot", snapshot: snapshot([row("w", "spawned")]) },
        1_000,
      ).workerCount,
      1,
    );
  });

  it("the wake badge counts settled-and-undelivered workers only", () => {
    const view = describeCapsuleChip(
      {
        kind: "snapshot",
        snapshot: snapshot([
          // Settled + undelivered: counted.
          row("w-1", "completed", { delivered: false }),
          row("w-2", "aborted", { delivered: false }),
          row("w-3", "error", { delivered: false }),
          // Settled + delivered: not owed, not counted.
          row("w-4", "completed", { delivered: true }),
          // Unsettled (running) — even undelivered, not counted.
          row("w-5", "running", { delivered: false }),
        ]),
      },
      1_000,
    );
    assert.equal(view.dot, "active");
    assert.equal(view.workerCount, 5);
    assert.equal(view.wakeCount, 3);
  });

  it("wake-badge threshold: 0 hides, N>0 carries the exact count", () => {
    const none = describeCapsuleChip(
      { kind: "snapshot", snapshot: snapshot([row("w", "running")]) },
      1_000,
    );
    assert.equal(none.wakeCount, 0, "nothing owed — badge hidden at render");

    const some = describeCapsuleChip(
      {
        kind: "snapshot",
        snapshot: snapshot([
          row("w-1", "completed", { delivered: false }),
          row("w-2", "completed", { delivered: false }),
        ]),
      },
      1_000,
    );
    assert.equal(some.wakeCount, 2);
  });

  it("a blocked-but-unsettled worker never inflates the wake badge", () => {
    const view = describeCapsuleChip(
      {
        kind: "snapshot",
        snapshot: snapshot([
          row("w-blocked", "running", {
            delivered: false,
            blocked: { class: "tool", target: "edit_file" },
          }),
        ]),
      },
      1_000,
    );
    assert.equal(view.dot, "active");
    assert.equal(view.wakeCount, 0);
  });
});

describe("capsule chip — the capsule's own expansion store (ticket 38, ADR-0013)", () => {
  it("defaults collapsed (chip and deliverables excerpt both closed)", () => {
    const capsule = createCapsuleStore();
    assert.deepEqual(capsule.getBox(), {
      expanded: false,
      deliverablesOpen: false,
      version: 0,
    });
  });

  it("expand/collapse/toggle follow the transitions; no-ops keep box identity", () => {
    const capsule = createCapsuleStore();
    capsule.expand();
    assert.equal(capsule.getBox().expanded, true);
    const opened = capsule.getBox();
    capsule.expand();
    assert.equal(capsule.getBox(), opened, "expand when open is a no-op");
    capsule.collapse();
    assert.equal(capsule.getBox().expanded, false);
    const closed = capsule.getBox();
    capsule.collapse();
    assert.equal(capsule.getBox(), closed, "collapse when closed is a no-op");

    capsule.toggle();
    assert.equal(capsule.getBox().expanded, true);
    capsule.toggle();
    assert.equal(capsule.getBox().expanded, false);
  });

  it("toggleDeliverables flips the excerpt disclosure without touching the chip (ticket 41)", () => {
    const capsule = createCapsuleStore();
    capsule.toggleDeliverables();
    const open = capsule.getBox();
    assert.equal(open.deliverablesOpen, true);
    assert.equal(open.expanded, false, "the chip's own state is untouched");
    assert.equal(open.version, 1);
    capsule.toggleDeliverables();
    assert.equal(capsule.getBox().deliverablesOpen, false);
    capsule.expand();
    assert.equal(capsule.getBox().deliverablesOpen, false, "independent disclosures");
  });

  it("state survives re-renders: identity changes only on a real transition", () => {
    const capsule = createCapsuleStore();
    const before = capsule.getBox();
    capsule.expand();
    const after = capsule.getBox();
    assert.notEqual(after, before);
    assert.equal(after.version, before.version + 1);
    assert.equal(after.expanded, true);
  });

  it("subscribe notifies on change only; the disposer unsubscribes", () => {
    const capsule = createCapsuleStore();
    let notified = 0;
    const dispose = capsule.subscribe(() => {
      notified += 1;
    });
    capsule.expand();
    capsule.expand();
    capsule.toggleDeliverables();
    capsule.toggleDeliverables();
    assert.equal(notified, 3);
    dispose();
    capsule.collapse();
    assert.equal(notified, 3);
  });
});

describe("capsule deliverables line — count math over terminal × delivered (ticket 41)", () => {
  it("counts exactly the settled-undelivered workers: completed/error/aborted × delivered", () => {
    const view = describeCapsuleDeliverables(
      {
        kind: "snapshot",
        snapshot: snapshot([
          row("w-1", "completed", { delivered: false }),
          row("w-2", "error", { delivered: false }),
          row("w-3", "aborted", { delivered: true }),
          row("w-4", "completed", { delivered: true }),
          row("w-5", "running", { delivered: false }),
          row("w-6", "spawned", { delivered: false }),
        ]),
      },
      1_000,
    );
    // Only w-1 and w-2 owe the user a delivery (S6).
    assert.equal(view.visible, true);
    assert.equal(view.count, 2);
  });

  it("count 0 hides the line entirely; the chip's wake math stays shared, not duplicated", () => {
    const view = describeCapsuleDeliverables(
      {
        kind: "snapshot",
        snapshot: snapshot([
          row("w-1", "completed", { delivered: true }),
          row("w-2", "running", { delivered: false }),
        ]),
      },
      1_000,
    );
    assert.deepEqual(view, { visible: false, count: 0, excerpt: null });
  });

  it("the delivered flip clears the line (S6 visible proof)", () => {
    const before = describeCapsuleDeliverables(
      {
        kind: "snapshot",
        snapshot: snapshot([row("w-1", "completed", { delivered: false })]),
      },
      1_000,
    );
    assert.equal(before.visible, true);
    assert.equal(before.count, 1);

    const after = describeCapsuleDeliverables(
      {
        kind: "snapshot",
        snapshot: snapshot([row("w-1", "completed", { delivered: true })]),
      },
      1_000,
    );
    assert.deepEqual(after, { visible: false, count: 0, excerpt: null });
  });

  it("a fresh snapshot's recentResult excerpt rides through verbatim", () => {
    const excerpt = {
      workerId: "w-1",
      title: "Parser worker",
      text: "Finished the parse; 12 files touched.",
    };
    const view = describeCapsuleDeliverables(
      {
        kind: "snapshot",
        snapshot: {
          ...snapshot([row("w-1", "completed", { delivered: false })]),
          recentResult: excerpt,
        },
      },
      1_000,
    );
    assert.equal(view.visible, true);
    assert.deepEqual(view.excerpt, excerpt);
  });

  it("a landed row with no honest excerpt renders count-only (excerpt null, no invented text)", () => {
    const view = describeCapsuleDeliverables(
      {
        kind: "snapshot",
        snapshot: snapshot([row("w-1", "completed", { delivered: false })]),
      },
      1_000,
    );
    assert.equal(view.visible, true);
    assert.equal(view.count, 1);
    assert.equal(view.excerpt, null);
  });

  it("degraded and stale feeds vouch for nothing: line hidden, count null", () => {
    const state = {
      kind: "snapshot",
      snapshot: snapshot([row("w", "completed", { delivered: false })]),
    } as const;
    assert.equal(
      describeCapsuleDeliverables(state, 1_000 + ROSTER_STALE_WINDOW_MS + 1)
        .visible,
      false,
    );
    assert.equal(
      describeCapsuleDeliverables(state, 1_000 + ROSTER_STALE_WINDOW_MS + 1)
        .count,
      null,
    );
    for (const kind of ["channel-missing", "invalid", "waiting"] as const) {
      const view = describeCapsuleDeliverables({ kind }, 5_000);
      assert.deepEqual(view, { visible: false, count: null, excerpt: null });
    }
  });
});

describe("capsule deliverables line — locale contract (ticket 41)", () => {
  it("the four keys exist in BOTH faces; the count is a template, never a literal", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    const keys = [
      CAPSULE_DELIVERABLES_LABEL_KEY,
      CAPSULE_DELIVERABLES_COUNT_KEY,
      CAPSULE_DELIVERABLES_EXPAND_KEY,
      CAPSULE_DELIVERABLES_COLLAPSE_KEY,
    ];
    for (const key of keys) {
      assert.equal(typeof localeDictionary.en[key], "string", `en missing ${key}`);
      assert.equal(typeof localeDictionary.zh[key], "string", `zh missing ${key}`);
      assert.notEqual(localeDictionary.en[key], "", `en ${key} empty`);
      assert.notEqual(localeDictionary.zh[key], "", `zh ${key} empty`);
    }
    assert.match(localeDictionary.en[CAPSULE_DELIVERABLES_COUNT_KEY] ?? "", /\{count\}/);
    assert.match(localeDictionary.zh[CAPSULE_DELIVERABLES_COUNT_KEY] ?? "", /\{count\}/);
  });

  it("the label wording is honest S6 copy: undelivered, not 'complete'", () => {
    assert.match(localeDictionary.en[CAPSULE_DELIVERABLES_LABEL_KEY] ?? "", /[Uu]ndelivered/);
    assert.match(localeDictionary.zh[CAPSULE_DELIVERABLES_LABEL_KEY] ?? "", /未送达/);
  });
});

describe("capsule chip — registration identity: one entry, unchanged id", () => {
  it("the shell.overlay registration options are untouched by ticket 38", () => {
    assert.deepEqual(rosterOverlayRegistration(), {
      name: "shell.overlay",
      id: "multitask-dispatcher-roster",
      order: -10,
      locale: "multitask-dispatcher",
    });
    assert.equal(ROSTER_ENTRY_ID, "multitask-dispatcher-roster");
  });

  it("apply still registers exactly ONE shell.overlay entry, now the capsule", () => {
    const ctx = createChipCtx();
    apply(ctx);
    const overlay = ctx.injects.find(
      (record) => record.parent === SHELL_OVERLAY_SLOT,
    );
    assert.ok(overlay, "shell.overlay inject missing");
    assert.equal(overlay.entries.length, 1, "exactly one overlay entry");
    const entry = overlay.entries[0];
    assert.ok(entry);
    assert.deepEqual(entry.options, rosterOverlayRegistration());
    assert.equal(typeof entry.component, "function");
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));

    // Fiber teardown reverses the entry; a fresh fiber re-registers one.
    ctx.runFiberTeardown();
    assert.equal(ctx.injects.length, 0);
    apply(ctx);
    const again = ctx.injects.find(
      (record) => record.parent === SHELL_OVERLAY_SLOT,
    );
    assert.equal(again?.entries.length, 1);
  });
});

describe("capsule chip — locale + CSS contracts (ticket 38)", () => {
  it("the enlarged dictionary validates; every capsule key exists in both faces", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    const keys = [
      CAPSULE_CHIP_OPEN_KEY,
      CAPSULE_CHIP_WORKERS_KEY,
      CAPSULE_CHIP_WAKE_KEY,
      CAPSULE_COLLAPSE_KEY,
      ...Object.values(CAPSULE_DOT_KEYS),
    ];
    for (const key of keys) {
      assert.equal(typeof localeDictionary.en[key], "string", `en missing ${key}`);
      assert.equal(typeof localeDictionary.zh[key], "string", `zh missing ${key}`);
      assert.notEqual(localeDictionary.en[key], "", `en ${key} empty`);
      assert.notEqual(localeDictionary.zh[key], "", `zh ${key} empty`);
    }
    // The count texts are templates, not literals.
    assert.match(localeDictionary.en[CAPSULE_CHIP_WORKERS_KEY] ?? "", /\{count\}/);
    assert.match(localeDictionary.zh[CAPSULE_CHIP_WORKERS_KEY] ?? "", /\{count\}/);
    assert.match(localeDictionary.en[CAPSULE_CHIP_WAKE_KEY] ?? "", /\{count\}/);
    assert.match(localeDictionary.zh[CAPSULE_CHIP_WAKE_KEY] ?? "", /\{count\}/);
  });

  it("capsule CSS is fully namespaced and animation-free (the ring stays the panel's)", () => {
    const bareClassSelectors = [
      ...CAPSULE_CSS.matchAll(/\.([a-zA-Z][\w-]*)/g),
    ]
      .map((match) => match[1])
      .filter((name) => !name.startsWith("multitask-dispatcher-"));
    assert.deepEqual(bareClassSelectors, [], "no shipped kit classes");
    assert.ok(!CAPSULE_CSS.includes("animation"), "skeleton stays static");
  });
});
