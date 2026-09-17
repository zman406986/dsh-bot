/**
 * Ticket 42 — the capsule's offline composition close-out (epic 35 §4–5).
 *
 * End-to-end over the SAME watch payload the browser module feeds both
 * stores (`index.ts`: one `settings.watch`, two honest readers): the roster
 * store (chip, activation row, sections, deliverables) plus the footer
 * store (persisted flag provenance). Dormant fixture → the activation pitch
 * is the panel; the activation flow's publish (the
 * `test/activation-lifecycle.test.ts` truth — the host mirrors a snapshot
 * into the plugin namespace under the `roster` key) → the whole activated
 * composition assembles from that one document.
 *
 * Also here: the footer view model + store contracts, the locale validator
 * over the FULL enlarged dictionary (identical en/zh key sets), and the
 * expanded×state matrix sweep. The no-stop guard's FINAL FORM (all capsule
 * view models) lives with ticket 31's guard in
 * `test/restart-honesty.test.ts`. Offline only (S8) — the real-browser
 * assertion of the assembled capsule stays ticket 33's pass.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPSULE_FOOTER_FLAG_OFF_KEY,
  CAPSULE_FOOTER_FLAG_ON_KEY,
  CAPSULE_FOOTER_SETTINGS_HINT_KEY,
  createCapsuleFooterStore,
  createCapsuleStore,
  describeCapsuleActivationRow,
  describeCapsuleChip,
  describeCapsuleDeliverables,
  describeCapsuleFooter,
  FLAG_SETTINGS_KEY,
  type CapsuleFooterStore,
} from "../src/client/capsule-store.js";
import { createDispatcherCapsule } from "../src/client/capsule.js";
import {
  localeDictionary,
  validateLocaleDictionary,
} from "../src/client/overlay.js";
import {
  createRosterStore,
  describeRosterPanel,
  ROSTER_STALE_RECHECK_MS,
  type RosterStore,
} from "../src/client/roster-store.js";
import {
  ROSTER_SETTINGS_KEY,
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

/** A v3 snapshot builder for composition fixtures. */
function snapshot(
  workers: RosterSnapshotWorker[],
  publishedAtMs = 1_000,
  recentResult: RosterSnapshot["recentResult"] = null,
): RosterSnapshot {
  return {
    schemaVersion: 3,
    dispatcherSessionId: "s-1",
    publishedAtMs,
    workers,
    recentResult,
  };
}

/**
 * A realistic watched namespace document: the persisted config (schema
 * `src/plugin.ts` `Config`) with the host-mirrored snapshot merged under
 * the `roster` key — exactly what the browser's one watch delivers.
 */
function document(
  flagEnabled: boolean,
  roster?: RosterSnapshot,
): Record<string, unknown> {
  return {
    [FLAG_SETTINGS_KEY]: flagEnabled,
    accessRequestTimeoutMs: 120_000,
    ...(roster === undefined ? {} : { [ROSTER_SETTINGS_KEY]: roster }),
  };
}

/**
 * The module's exact wiring under test: ONE watch payload, two readers
 * (`index.ts` calls both stores back-to-back with the same value).
 */
function publish(
  store: RosterStore,
  footer: CapsuleFooterStore,
  value: unknown,
): void {
  store.applyChannelValue(value);
  footer.applyChannelValue(value);
}

describe("capsule composition — dormant end-to-end (ticket 42 close-out)", () => {
  it("a config-only document leaves the panel the activation pitch, footer already provenanced", () => {
    const store = createRosterStore();
    const footer = createCapsuleFooterStore();
    publish(store, footer, document(true));

    // Feed truth: the channel is alive (config write seen), no snapshot yet.
    assert.equal(store.getBox().state.kind, "waiting");

    const now = 5_000;
    const chip = describeCapsuleChip(store.getBox().state, now);
    const activation = describeCapsuleActivationRow(store.getBox().state, now);
    const panel = describeRosterPanel(store.getBox().state, now);
    const deliverables = describeCapsuleDeliverables(
      store.getBox().state,
      now,
    );

    assert.deepEqual(chip, { dot: "dormant", workerCount: null, wakeCount: null });
    assert.equal(activation.composition, "dormant");
    assert.deepEqual(activation.affordance, {
      intent: "start",
      labelKey: "capsule.activation.start",
    });
    assert.equal(panel.kind, "loading", "the pitch IS the whole panel");
    assert.deepEqual(deliverables, { visible: false, count: null, excerpt: null });

    // Provenance does not wait for activation: the same document already
    // vouches for the persisted flag.
    assert.equal(footer.getBox().flagEnabled, true);
  });

  it("the dormant composition's ONLY affordance is the start intent — nothing else is actionable", () => {
    const store = createRosterStore();
    const footer = createCapsuleFooterStore();
    publish(store, footer, document(false));
    const activation = describeCapsuleActivationRow(
      store.getBox().state,
      5_000,
    );
    assert.equal(activation.affordance?.intent, "start");
    assert.equal(Object.keys(activation.affordance ?? {}).length, 2,
      "the affordance carries intent + label only");
  });
});

describe("capsule composition — activated end-to-end (ticket 42 close-out)", () => {
  const activated = () => {
    const store = createRosterStore();
    const footer = createCapsuleFooterStore();
    publish(
      store,
      footer,
      document(true, snapshot([
        row("w-run", "running", { toolCallCount: 3 }),
        row("w-done", "completed", { delivered: false }),
        row("w-old", "completed", { delivered: true }),
      ], 1_000, {
        workerId: "w-done",
        title: "Parser worker",
        text: "Finished the parse; 12 files touched.",
      })),
    );
    return { store, footer };
  };

  it("one published document assembles the whole composition coherently", () => {
    const { store, footer } = activated();
    const state = store.getBox().state;
    assert.equal(state.kind, "snapshot");
    const now = 1_000;

    const chip = describeCapsuleChip(state, now);
    const activation = describeCapsuleActivationRow(state, now);
    const panel = describeRosterPanel(state, now);
    const deliverables = describeCapsuleDeliverables(state, now);

    // Chip: active with the worker total; wake badge = the one owed result.
    assert.deepEqual(chip, { dot: "active", workerCount: 3, wakeCount: 1 });
    // Activation row: activated, stop INTENT affordance (never a control).
    assert.equal(activation.composition, "activated");
    assert.deepEqual(activation.affordance, {
      intent: "stop",
      labelKey: "capsule.activation.stop",
    });
    // Sections: all three, with honest placement.
    assert.equal(panel.kind, "rows");
    if (panel.kind === "rows") {
      const byId = new Map(panel.sections.map((s) => [s.id, s]));
      assert.deepEqual(
        byId.get("active")?.rows.map((r) => r.workerId),
        ["w-run"],
      );
      assert.deepEqual(
        byId.get("needs-you")?.rows.map((r) => r.workerId),
        ["w-done"],
        "landed-but-undelivered renders in Needs you",
      );
      assert.deepEqual(
        byId.get("finished")?.rows.map((r) => r.workerId),
        ["w-old"],
      );
    }
    // Deliverables line: visible with the snapshot's own excerpt.
    assert.equal(deliverables.visible, true);
    assert.equal(deliverables.count, 1);
    assert.equal(deliverables.excerpt?.workerId, "w-done");
    // Footer: the same document's persisted flag.
    assert.equal(footer.getBox().flagEnabled, true);
  });

  it("the delivery flip clears the deliverables line and the wake badge together (S6)", () => {
    const { store, footer } = activated();
    // The wake turn delivered; the host re-published the updated roster.
    publish(
      store,
      footer,
      document(true, snapshot([
        row("w-run", "running", { toolCallCount: 3 }),
        row("w-done", "completed", { delivered: true }),
        row("w-old", "completed", { delivered: true }),
      ], 2_000)),
    );
    const state = store.getBox().state;
    assert.deepEqual(describeCapsuleChip(state, 2_000), {
      dot: "active",
      workerCount: 3,
      wakeCount: 0,
    });
    assert.deepEqual(describeCapsuleDeliverables(state, 2_000), {
      visible: false,
      count: 0,
      excerpt: null,
    });
    // Composition otherwise unchanged; footer untouched by roster writes.
    assert.equal(describeCapsuleActivationRow(state, 2_000).composition, "activated");
    assert.equal(footer.getBox().flagEnabled, true);
  });

  it("an unrelated settings write (flag flip, no roster key) re-provenances the footer without churning the feed", () => {
    const { store, footer } = activated();
    publish(store, footer, document(false));
    assert.equal(footer.getBox().flagEnabled, false, "the flip is seen");
    const state = store.getBox().state;
    assert.equal(state.kind, "snapshot", "roster view keeps its snapshot");
    if (state.kind === "snapshot") {
      assert.equal(state.snapshot.publishedAtMs, 1_000, "untouched by the write");
    }
  });
});

describe("capsule composition — full matrix sweep (ticket 42 close-out)", () => {
  const fresh = snapshot([row("w", "running", { delivered: false })]);
  const states = [
    { label: "waiting", state: { kind: "waiting" as const }, now: 5_000 },
    {
      label: "fresh snapshot",
      state: { kind: "snapshot" as const, snapshot: fresh },
      now: 1_000,
    },
    {
      label: "stale snapshot",
      state: { kind: "snapshot" as const, snapshot: fresh },
      now: 1_000 + ROSTER_STALE_WINDOW_MS + 1,
    },
    { label: "invalid", state: { kind: "invalid" as const }, now: 5_000 },
    {
      label: "channel-missing",
      state: { kind: "channel-missing" as const },
      now: 5_000,
    },
  ];

  it("expansion is presentation-only: collapsed and expanded read identical data views", () => {
    for (const { label, state, now } of states) {
      const collapsed = createCapsuleStore();
      const expanded = createCapsuleStore();
      expanded.expand();
      for (const capsule of [collapsed, expanded]) {
        assert.deepEqual(
          describeCapsuleChip(state, now),
          describeCapsuleChip(state, now),
          `chip deterministic for ${label}`,
        );
        assert.deepEqual(
          describeCapsuleActivationRow(state, now),
          describeCapsuleActivationRow(state, now),
          `activation row deterministic for ${label}`,
        );
        assert.deepEqual(
          describeCapsuleDeliverables(state, now),
          describeCapsuleDeliverables(state, now),
          `deliverables deterministic for ${label}`,
        );
        // The capsule store's own state never mutates the data views.
        assert.deepEqual(
          {
            expanded: capsule.getBox().expanded,
            deliverablesOpen: capsule.getBox().deliverablesOpen,
          },
          { expanded: capsule === expanded, deliverablesOpen: false },
        );
      }
    }
  });

  it("every store kind maps to its honest composition, degraded kinds vouch for nothing", () => {
    for (const { label, state, now } of states) {
      const chip = describeCapsuleChip(state, now);
      const activation = describeCapsuleActivationRow(state, now);
      const deliverables = describeCapsuleDeliverables(state, now);
      if (label === "waiting") {
        assert.equal(activation.composition, "dormant");
      } else if (label === "fresh snapshot") {
        assert.equal(activation.composition, "activated");
      } else {
        assert.equal(activation.composition, "unavailable", label);
        assert.equal(activation.affordance, null, label);
      }
      if (activation.composition !== "activated") {
        assert.deepEqual(
          deliverables,
          { visible: false, count: null, excerpt: null },
          `${label} must not vouch for a deliverables line`,
        );
        assert.equal(chip.workerCount, null, label);
        assert.equal(chip.wakeCount, null, label);
      }
    }
  });
});

describe("capsule footer — view model + store (ticket 42)", () => {
  it("reads the persisted flag from a vouching document; degrades to omission otherwise", () => {
    assert.deepEqual(describeCapsuleFooter(document(true)), { flagEnabled: true });
    assert.deepEqual(describeCapsuleFooter(document(false)), { flagEnabled: false });
    // No document yet / broken payload / unreadable key: null (omit).
    assert.deepEqual(describeCapsuleFooter(undefined), { flagEnabled: null });
    assert.deepEqual(describeCapsuleFooter(null), { flagEnabled: null });
    assert.deepEqual(describeCapsuleFooter("junk"), { flagEnabled: null });
    assert.deepEqual(describeCapsuleFooter({}), { flagEnabled: null });
    assert.deepEqual(describeCapsuleFooter({ [FLAG_SETTINGS_KEY]: "yes" }), {
      flagEnabled: null,
    });
  });

  it("the store flips only on a real change; a non-vouching document never unsets the last value", () => {
    const footer = createCapsuleFooterStore();
    assert.deepEqual(footer.getBox(), { flagEnabled: null, version: 0 });

    footer.applyChannelValue(document(true));
    const on = footer.getBox();
    assert.deepEqual(on, { flagEnabled: true, version: 1 });

    footer.applyChannelValue(document(true));
    assert.equal(footer.getBox(), on, "same value keeps box identity");

    footer.applyChannelValue({});
    assert.equal(footer.getBox(), on, "non-vouching write does not unset");

    footer.applyChannelValue(document(false));
    assert.deepEqual(footer.getBox(), { flagEnabled: false, version: 2 });
  });

  it("subscribe notifies on real changes only; the disposer unsubscribes", () => {
    const footer = createCapsuleFooterStore();
    let notified = 0;
    const dispose = footer.subscribe(() => {
      notified += 1;
    });
    footer.applyChannelValue(document(true));
    footer.applyChannelValue(document(true));
    footer.applyChannelValue(document(false));
    assert.equal(notified, 2);
    dispose();
    footer.applyChannelValue(document(true));
    assert.equal(notified, 2);
  });

  it("the capsule factory accepts the footer seat and stays a render-only component function", () => {
    const t = (key: string) => key;
    const component = createDispatcherCapsule(
      t,
      createRosterStore(),
      createCapsuleStore(),
      () => {},
      undefined,
      undefined,
      createCapsuleFooterStore(),
    );
    assert.equal(typeof component, "function");
  });
});

describe("capsule composition — locale close-out (ticket 42)", () => {
  it("the FULL enlarged dictionary validates with identical en/zh key sets", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    assert.deepEqual(
      Object.keys(localeDictionary.en).sort(),
      Object.keys(localeDictionary.zh).sort(),
    );
  });

  it("the footer keys exist in both faces; the hint names the Settings path copy-only", () => {
    for (const key of [
      CAPSULE_FOOTER_FLAG_ON_KEY,
      CAPSULE_FOOTER_FLAG_OFF_KEY,
      CAPSULE_FOOTER_SETTINGS_HINT_KEY,
    ]) {
      assert.equal(typeof localeDictionary.en[key], "string", `en missing ${key}`);
      assert.equal(typeof localeDictionary.zh[key], "string", `zh missing ${key}`);
      assert.notEqual(localeDictionary.en[key], "", `en ${key} empty`);
      assert.notEqual(localeDictionary.zh[key], "", `zh ${key} empty`);
    }
    // Degraded seam 4: the path is NAMED, nothing navigates — a hint, not a
    // button; and it is honest about ADR-0005's next-chat effect.
    assert.match(
      localeDictionary.en[CAPSULE_FOOTER_SETTINGS_HINT_KEY] ?? "",
      /Settings → Multitask Dispatcher/,
    );
    assert.match(
      localeDictionary.en[CAPSULE_FOOTER_SETTINGS_HINT_KEY] ?? "",
      /new chats/,
    );
    assert.match(
      localeDictionary.zh[CAPSULE_FOOTER_SETTINGS_HINT_KEY] ?? "",
      /设置 → Multitask Dispatcher/,
    );
    assert.match(
      localeDictionary.zh[CAPSULE_FOOTER_SETTINGS_HINT_KEY] ?? "",
      /新会话/,
    );
    // The flag lines speak of the SETTING, never the live session state.
    assert.match(localeDictionary.en[CAPSULE_FOOTER_FLAG_ON_KEY] ?? "", /setting/i);
    assert.match(localeDictionary.en[CAPSULE_FOOTER_FLAG_OFF_KEY] ?? "", /setting/i);
    assert.match(localeDictionary.zh[CAPSULE_FOOTER_FLAG_ON_KEY] ?? "", /设置/);
    assert.match(localeDictionary.zh[CAPSULE_FOOTER_FLAG_OFF_KEY] ?? "", /设置/);
  });

  it("the stale-recheck cadence is unchanged: the footer adds no polling seam", () => {
    // The footer reads the same watch push; nothing new ticks. (Guard
    // against a future "refresh the footer" timer sneaking in.)
    assert.equal(ROSTER_STALE_RECHECK_MS, 10_000);
  });
});
