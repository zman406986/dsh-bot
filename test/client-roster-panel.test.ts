/**
 * Tickets 21 + 27 — client roster panel: store, view model, and apply()
 * wiring over fake client seams (client-face scaffold idioms from ticket 20;
 * presence view model per design-17 §4.1/§4.2/§7).
 *
 * Offline only (S8): no real Cordis, no browser, no DOM harness. Component
 * rendering stays covered by build success + typecheck; everything asserted
 * here is pure logic (store + view model + CSS/locale contracts) or
 * fake-seam registration.
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
  validateLocaleDictionary,
  type SlotRegistrationOptions,
} from "../src/client/overlay.js";
import {
  ROSTER_FINISHED_COUNT_KEY,
  ROSTER_SECTION_IDS,
  ROSTER_SECTION_KEYS,
  ROSTER_STALE_RECHECK_MS,
  createRosterStore,
  describeRosterPanel,
  formatRosterElapsed,
  formatRosterStartTime,
  formatTemplate,
  rosterGenericTitle,
  rosterKindLabel,
  rosterSectionFor,
  rosterStatusLabel,
  rosterStatusVisual,
  rosterViewCopyKey,
  type RosterPanelState,
  type RosterPanelView,
  type RosterRowView,
  type RosterStatusVisual,
} from "../src/client/roster-store.js";
import { ROSTER_PANEL_CSS } from "../src/client/panel.js";
import {
  ROSTER_SETTINGS_KEY,
  ROSTER_STALE_WINDOW_MS,
  ROSTER_STATUS_KEYS,
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

/** A v3 snapshot builder for feed tests. */
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

/** All rows across the three sections, in section order (ticket 28). */
function allRows(view: RosterPanelView): readonly RosterRowView[] {
  return view.kind === "rows"
    ? view.sections.flatMap((section) => section.rows)
    : [];
}

/** The rows of one section, or an empty list when the view has no sections. */
function rowsOf(view: RosterPanelView, id: string): readonly RosterRowView[] {
  return view.kind === "rows"
    ? (view.sections.find((section) => section.id === id)?.rows ?? [])
    : [];
}

/** The finished section's collapsed count, or 0 when it has no sections. */
function collapsedOf(view: RosterPanelView): number {
  return view.kind === "rows"
    ? (view.sections.find((section) => section.id === "finished")
        ?.collapsedCount ?? 0)
    : 0;
}

/**
 * Look a row up by id across all sections. Section order is the presentation
 * order, not the snapshot order, so tests that care about a specific row use
 * this instead of positional indexing.
 */
function rowById(view: RosterPanelView, workerId: string): RosterRowView | undefined {
  return allRows(view).find((candidate) => candidate.workerId === workerId);
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

describe("roster panel — view model degrades honestly (design-16 §6, design-17 §4.2)", () => {
  it("waiting renders loading (feed alive, nothing mirrored yet)", () => {
    assert.deepEqual(describeRosterPanel({ kind: "waiting" }, 5_000), {
      kind: "loading",
    });
  });

  it("channel-missing and invalid states render unavailable", () => {
    for (const state of [
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
    const workers = ROSTER_STATUS_KEYS.map((status, index) =>
      row(`w-${index}`, status, {
        todoId: index % 2 === 0 ? `todo-${index}` : null,
      }),
    );
    const view = describeRosterPanel(
      { kind: "snapshot", snapshot: snapshot(workers, 1_000) },
      1_100,
    );
    assert.equal(view.kind, "rows");
    const rows = allRows(view);
    assert.equal(rows.length, ROSTER_STATUS_KEYS.length);
    for (const [index, status] of ROSTER_STATUS_KEYS.entries()) {
      const rowView = rows[index];
      assert.ok(rowView);
      assert.equal(rowView.statusLabel, status);
      assert.equal(rowView.title, `Worker w-${index}`);
      assert.equal(rowView.todoId, index % 2 === 0 ? `todo-${index}` : null);
    }
  });

  it("an empty title falls back to the kind-typed generic label; the label mapping is identity", () => {
    assert.equal(rosterStatusLabel("steering"), "steering");
    const view = describeRosterPanel(
      {
        kind: "snapshot",
        snapshot: snapshot([row("w-1", "running", { title: "" })]),
      },
      1_000,
    );
    assert.equal(view.kind, "rows");
    assert.equal(allRows(view)[0]?.title, "worker w-1");
    assert.equal(allRows(view)[0]?.statusLabel, "running");
  });

  it("a snapshot past the stale window renders unavailable, not old data", () => {
    const state: RosterPanelState = {
      kind: "snapshot",
      snapshot: snapshot([row("w", "running")], 1_000),
    };
    assert.equal(describeRosterPanel(state, 1_000 + ROSTER_STALE_WINDOW_MS).kind, "rows");
    assert.equal(
      describeRosterPanel(state, 1_000 + ROSTER_STALE_WINDOW_MS + 1).kind,
      "unavailable",
    );
  });
});

describe("roster panel — presence view model (ticket 27, design-17 §4.1)", () => {
  it("maps the six FSM statuses onto dot/ring visuals: working rings, terminal do not", () => {
    assert.deepEqual(rosterStatusVisual("running"), "working");
    assert.deepEqual(rosterStatusVisual("steering"), "working");
    assert.deepEqual(rosterStatusVisual("spawned"), "starting");
    assert.deepEqual(rosterStatusVisual("completed"), "done");
    assert.deepEqual(rosterStatusVisual("error"), "failed");
    assert.deepEqual(rosterStatusVisual("aborted"), "stopped");
    const working: RosterStatusVisual[] = ROSTER_STATUS_KEYS.map(
      rosterStatusVisual,
    ).filter((visual) => visual === "working");
    assert.equal(working.length, 2, "exactly running+steering carry the ring");
  });

  it("marker precedence: blocked outranks landed; landed outranks plain finished", () => {
    const view = describeRosterPanel(
      {
        kind: "snapshot",
        snapshot: snapshot([
          row("w-blocked", "running", {
            blocked: { class: "tool", target: "edit_file" },
          }),
          row("w-landed", "completed", { delivered: false }),
          row("w-finished", "aborted", { delivered: true }),
          row("w-quiet", "running", {}),
        ]),
      },
      1_000,
    );
    assert.equal(view.kind, "rows");
    const blocked = rowById(view, "w-blocked");
    const landed = rowById(view, "w-landed");
    const finished = rowById(view, "w-finished");
    const quiet = rowById(view, "w-quiet");
    assert.deepEqual(blocked?.marker, {
      kind: "blocked",
      blocked: { class: "tool", target: "edit_file" },
    });
    assert.deepEqual(landed?.marker, { kind: "landed" });
    assert.equal(finished?.marker, null);
    assert.equal(finished?.finished, true);
    assert.equal(quiet?.marker, null);
    assert.equal(quiet?.finished, false);
  });

  it("a running worker with a pending ask shows blocked, not landed, even with an undelivered todo", () => {
    const view = describeRosterPanel(
      {
        kind: "snapshot",
        snapshot: snapshot([
          row("w", "running", {
            delivered: false,
            blocked: { class: "credential", target: "API_TOKEN" },
          }),
        ]),
      },
      1_000,
    );
    assert.equal(view.kind, "rows");
    assert.deepEqual(rowsOf(view, "needs-you")[0]?.marker, {
      kind: "blocked",
      blocked: { class: "credential", target: "API_TOKEN" },
    });
  });

  it("activity line math: elapsed is render-clock minus startedAtMs, clamped at zero", () => {
    const view = describeRosterPanel(
      {
        kind: "snapshot",
        snapshot: snapshot(
          [
            row("w-1", "running", { startedAtMs: 1_000, toolCallCount: 7 }),
            row("w-2", "spawned", { startedAtMs: 2_000, toolCallCount: 0 }),
            row("w-3", "steering", { startedAtMs: 500, toolCallCount: 12 }),
          ],
          // Publish inside the stale window of the render clock below.
          63_000,
        ),
      },
      // Render clock: 63.5s into the session.
      63_500,
    );
    assert.equal(view.kind, "rows");
    // All three are live rows, so they sit in Active in snapshot order.
    const active = rowsOf(view, "active");
    assert.equal(active[0]?.elapsedText, "1m 2s");
    assert.equal(active[0]?.toolCallCount, 7);
    assert.equal(active[1]?.elapsedText, "1m 1s");
    assert.equal(active[2]?.elapsedText, "1m 3s");

    // Clock skew (startedAtMs in the future of the render clock) clamps.
    const skew = describeRosterPanel(
      {
        kind: "snapshot",
        snapshot: snapshot([row("w", "running", { startedAtMs: 9_000 })]),
      },
      1_000,
    );
    assert.equal(skew.kind, "rows");
    assert.equal(rowsOf(skew, "active")[0]?.elapsedText, "0s");
  });

  it("elapsed text is compact and locale-neutral", () => {
    assert.equal(formatRosterElapsed(0), "0s");
    assert.equal(formatRosterElapsed(-5), "0s");
    assert.equal(formatRosterElapsed(42_000), "42s");
    assert.equal(formatRosterElapsed(122_000), "2m 2s");
    assert.equal(formatRosterElapsed(7_320_000), "2h 2m");
    assert.equal(formatRosterElapsed(97_200_000), "1d 3h");
  });

  it("template substitution fills {count}/{target} and leaves unknown placeholders visible", () => {
    assert.equal(
      formatTemplate("{count} tool calls", { count: "3" }),
      "3 tool calls",
    );
    assert.equal(
      formatTemplate('use the tool "{target}"', { target: "edit_file" }),
      'use the tool "edit_file"',
    );
    assert.equal(
      formatTemplate("{nonsense} {count}", { count: "1" }),
      "{nonsense} 1",
    );
  });

  it("the locale dictionary stays validator-clean with the ticket-27 keys in both faces", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    for (const key of [
      "roster.loading",
      "roster.landed",
      "roster.activity.toolcalls",
      "roster.blocked.tool",
      "roster.blocked.credential",
      "roster.blocked.network",
      "roster.blocked.filesystem",
      "roster.blocked.other",
    ]) {
      assert.equal(
        typeof localeDictionary.en[key],
        "string",
        `en missing ${key}`,
      );
      assert.equal(
        typeof localeDictionary.zh[key],
        "string",
        `zh missing ${key}`,
      );
    }
  });

  it("panel CSS is fully namespaced, ring-only animated, and reduced-motion safe", () => {
    // Every class selector and keyframe name carries our prefix.
    const bareClassSelectors = [
      ...ROSTER_PANEL_CSS.matchAll(/\.([a-zA-Z][\w-]*)/g),
    ]
      .map((match) => match[1])
      .filter((name) => !name.startsWith("multitask-dispatcher-"));
    assert.deepEqual(bareClassSelectors, [], "no shipped kit classes");
    assert.match(ROSTER_PANEL_CSS, /@keyframes multitask-dispatcher-roster-ring/);
    // The only animation is the working ring, and it degrades.
    const animations = [
      ...ROSTER_PANEL_CSS.matchAll(/animation:([^;]+);/g),
    ].map((match) => match[1].trim());
    assert.equal(animations.length, 2, "base animation + reduced-motion override");
    assert.match(animations[0] ?? "", /^multitask-dispatcher-roster-ring/);
    assert.match(ROSTER_PANEL_CSS, /prefers-reduced-motion/);
    assert.match(ROSTER_PANEL_CSS, /animation:none/);
  });
});

describe("roster panel — sections: Active / Needs you / Finished (ticket 28, design-17 §4.2)", () => {
  it("the partition is total: every FSM status × blocked × delivered lands in exactly one section", () => {
    const blockedCases = [null, { class: "tool", target: "shell" }] as const;
    for (const status of ROSTER_STATUS_KEYS) {
      for (const delivered of [true, false]) {
        for (const blocked of blockedCases) {
          const section = rosterSectionFor(status, blocked, delivered);
          // The rule in one assertion, checked for all 24 combinations.
          const expected =
            blocked !== null
              ? "needs-you"
              : status === "spawned" ||
                  status === "running" ||
                  status === "steering"
                ? "active"
                : delivered
                  ? "finished"
                  : "needs-you";
          assert.equal(
            section,
            expected,
            `${status} blocked=${blocked !== null} delivered=${delivered}`,
          );
        }
      }
    }
  });

  it("active covers exactly spawned/running/steering; terminal statuses never are", () => {
    for (const status of ROSTER_STATUS_KEYS) {
      const section = rosterSectionFor(status, null, true);
      assert.equal(
        section === "active",
        status === "spawned" || status === "running" || status === "steering",
        `active mismatch for ${status}`,
      );
    }
  });

  it("precedence: blocked outranks landed — a row that is both renders in Needs-you as blocked", () => {
    // Terminal, undelivered, AND blocked: the collision case.
    const section = rosterSectionFor(
      "completed",
      { class: "credential", target: "API_TOKEN" },
      false,
    );
    assert.equal(section, "needs-you");

    const view = describeRosterPanel(
      {
        kind: "snapshot",
        snapshot: snapshot([
          row("w-both", "completed", {
            delivered: false,
            blocked: { class: "credential", target: "API_TOKEN" },
          }),
        ]),
      },
      1_000,
    );
    assert.equal(view.kind, "rows");
    const both = rowById(view, "w-both");
    assert.equal(both?.section, "needs-you");
    // Blocked marker wins; the landed marker is suppressed.
    assert.deepEqual(both?.marker, {
      kind: "blocked",
      blocked: { class: "credential", target: "API_TOKEN" },
    });
    // And it is not hidden behind the finished count line.
    assert.equal(both?.collapsed, false);
    assert.equal(collapsedOf(view), 0);
  });

  it("landed (terminal, undelivered) is Needs-you and stays visible; delivered terminal is Finished", () => {
    const view = describeRosterPanel(
      {
        kind: "snapshot",
        snapshot: snapshot([
          row("w-landed", "completed", { delivered: false }),
          row("w-delivered", "completed", { delivered: true }),
          row("w-error-delivered", "error", { delivered: true }),
          row("w-aborted-landed", "aborted", { delivered: false }),
        ]),
      },
      1_000,
    );
    assert.equal(view.kind, "rows");
    assert.deepEqual(
      rowsOf(view, "needs-you").map((r) => r.workerId),
      ["w-landed", "w-aborted-landed"],
    );
    assert.equal(rowById(view, "w-landed")?.collapsed, false);
    // Delivered terminal rows are all in Finished, all collapsed.
    assert.deepEqual(
      rowsOf(view, "finished").map((r) => r.workerId),
      ["w-delivered", "w-error-delivered"],
    );
    assert.deepEqual(
      rowsOf(view, "finished").map((r) => r.collapsed),
      [true, true],
    );
    assert.equal(collapsedOf(view), 2);
  });

  it("collapsed finished count is exactly the delivered-terminal rows; landed rows never inflate it", () => {
    const view = describeRosterPanel(
      {
        kind: "snapshot",
        snapshot: snapshot([
          row("w-1", "running"),
          row("w-2", "completed", { delivered: true }),
          row("w-3", "error", { delivered: true }),
          row("w-4", "aborted", { delivered: false }),
          row("w-5", "completed", { delivered: false }),
        ]),
      },
      1_000,
    );
    assert.equal(collapsedOf(view), 2);
    // All rows remain queryable — collapse hides, it never drops.
    assert.equal(allRows(view).length, 5);
  });

  it("sections are always present in fixed order, empty ones included", () => {
    const view = describeRosterPanel(
      {
        kind: "snapshot",
        snapshot: snapshot([row("w", "running")]),
      },
      1_000,
    );
    assert.equal(view.kind, "rows");
    if (view.kind !== "rows") return;
    assert.deepEqual(
      view.sections.map((section) => section.id),
      [...ROSTER_SECTION_IDS],
    );
    assert.deepEqual(
      view.sections.map((section) => section.titleKey),
      ["roster.section.active", "roster.section.needs-you", "roster.section.finished"],
    );
    // No needs-you or finished rows in this fixture: empty, not absent.
    assert.deepEqual(rowsOf(view, "needs-you"), []);
    assert.deepEqual(rowsOf(view, "finished"), []);
    assert.equal(collapsedOf(view), 0);
  });

  it("section membership tracks the snapshot: a delivered flip moves the row out of Needs-you", () => {
    const base = row("w", "completed", { delivered: false });
    const before = describeRosterPanel(
      { kind: "snapshot", snapshot: snapshot([base]) },
      1_000,
    );
    assert.equal(rowById(before, "w")?.section, "needs-you");

    const after = describeRosterPanel(
      { kind: "snapshot", snapshot: snapshot([{ ...base, delivered: true }]) },
      1_000,
    );
    assert.equal(rowById(after, "w")?.section, "finished");
    assert.equal(rowById(after, "w")?.collapsed, true);
  });

  it("row detail line: start time on the client clock plus the kind-typed generic label", () => {
    const view = describeRosterPanel(
      {
        kind: "snapshot",
        snapshot: snapshot([
          row("w-titled", "running", { title: "Parser", startedAtMs: 1_000 }),
          row("w-untitled", "running", { title: "", startedAtMs: 1_000 }),
        ]),
      },
      2_000,
    );
    assert.equal(view.kind, "rows");
    const expectedStart = formatRosterStartTime(1_000);
    assert.match(expectedStart, /^\d{2}:\d{2}$/);
    assert.equal(rowById(view, "w-titled")?.startText, expectedStart);
    assert.equal(rowById(view, "w-titled")?.kindLabel, "worker");
    // Shipped title honored; generic fallback is kind + id, not the raw id.
    assert.equal(rowById(view, "w-titled")?.title, "Parser");
    assert.equal(rowById(view, "w-untitled")?.title, "worker w-untitled");
  });

  it("the kind label vocabulary is trivially extendable; an unknown kind forwards verbatim", () => {
    assert.equal(rosterKindLabel("worker"), "worker");
    assert.equal(rosterGenericTitle("worker", "w-3"), "worker w-3");
    // Future kinds need one map entry, not a second vocabulary: unknown
    // kinds render their own name rather than blanking the row.
    assert.equal(rosterKindLabel("background-command" as "worker"), "background-command");
    assert.equal(
      rosterGenericTitle("background-command" as "worker", "b-1"),
      "background-command b-1",
    );
  });

  it("snapshot-state vocabulary alignment: state → copy key, snapshot → sections (design-17 §4.2)", () => {
    assert.equal(rosterViewCopyKey({ kind: "loading" }), "roster.loading");
    assert.equal(rosterViewCopyKey({ kind: "empty" }), "roster.empty");
    assert.equal(rosterViewCopyKey({ kind: "unavailable" }), "roster.unavailable");
    assert.equal(
      rosterViewCopyKey({ kind: "rows", sections: [] }),
      null,
      "a ready snapshot renders sections, not a status line",
    );

    // The store's states map onto that vocabulary end to end.
    assert.equal(
      rosterViewCopyKey(describeRosterPanel({ kind: "waiting" }, 5_000)),
      "roster.loading",
    );
    assert.equal(
      rosterViewCopyKey(
        describeRosterPanel(
          { kind: "snapshot", snapshot: snapshot([], 1_000) },
          1_000,
        ),
      ),
      "roster.empty",
    );
    for (const state of [
      { kind: "channel-missing" },
      { kind: "invalid" },
    ] as const satisfies readonly RosterPanelState[]) {
      assert.equal(
        rosterViewCopyKey(describeRosterPanel(state, 5_000)),
        "roster.unavailable",
      );
    }
    // Stale snapshot → unavailable, the same copy as a missing channel.
    assert.equal(
      rosterViewCopyKey(
        describeRosterPanel(
          {
            kind: "snapshot",
            snapshot: snapshot([row("w", "running")], 1_000),
          },
          1_000 + ROSTER_STALE_WINDOW_MS + 1,
        ),
      ),
      "roster.unavailable",
    );
    // Every key the mapping produces exists in both faces.
    for (const key of [
      "roster.loading",
      "roster.empty",
      "roster.unavailable",
    ]) {
      assert.equal(typeof localeDictionary.en[key], "string", `en missing ${key}`);
      assert.equal(typeof localeDictionary.zh[key], "string", `zh missing ${key}`);
    }
  });

  it("the ticket-28 locale keys exist in both faces with identical key sets", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    const keys = [
      "roster.section.active",
      "roster.section.needs-you",
      "roster.section.finished",
      ROSTER_FINISHED_COUNT_KEY,
    ];
    for (const key of keys) {
      assert.equal(typeof localeDictionary.en[key], "string", `en missing ${key}`);
      assert.equal(typeof localeDictionary.zh[key], "string", `zh missing ${key}`);
      assert.notEqual(localeDictionary.en[key], "", `en ${key} empty`);
      assert.notEqual(localeDictionary.zh[key], "", `zh ${key} empty`);
    }
    // Section title keys resolve through the same map the view model exposes,
    // so a heading can never point at a missing dictionary entry.
    for (const id of ROSTER_SECTION_IDS) {
      const key = ROSTER_SECTION_KEYS[id];
      assert.equal(typeof localeDictionary.en[key], "string");
      assert.equal(typeof localeDictionary.zh[key], "string");
    }
    // The count line's {count} placeholder is real, not literal text.
    assert.match(localeDictionary.en[ROSTER_FINISHED_COUNT_KEY] ?? "", /\{count\}/);
    assert.match(localeDictionary.zh[ROSTER_FINISHED_COUNT_KEY] ?? "", /\{count\}/);
    assert.equal(
      formatTemplate(localeDictionary.en[ROSTER_FINISHED_COUNT_KEY] ?? "", {
        count: "3",
      }),
      "3 finished",
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
    const good = snapshot([row("w", "spawned", { title: "T" })]);
    store.applyChannelValue({ [ROSTER_SETTINGS_KEY]: good });
    assert.deepEqual(store.getBox().state, { kind: "snapshot", snapshot: good });

    store.applyChannelValue({
      [ROSTER_SETTINGS_KEY]: { ...good, schemaVersion: 42 },
    });
    assert.equal(store.getBox().state.kind, "invalid");

    // A v1 payload is equally invalid under the v3 contract (ticket 27/41).
    store.applyChannelValue({
      [ROSTER_SETTINGS_KEY]: {
        schemaVersion: 1,
        dispatcherSessionId: "s-1",
        publishedAtMs: 1,
        workers: [
          { workerId: "w", title: "T", status: "running", todoId: null },
        ],
      },
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

    // Host mirror lands under the roster key with two workers (v2 rows).
    const feed = snapshot([
      row("w-1", "running", { title: "Parser", startedAtMs: 1_000, toolCallCount: 4 }),
      row("w-2", "steering", {
        title: "Tester",
        todoId: "t-9",
        startedAtMs: 500,
        toolCallCount: 2,
      }),
    ]);
    ctx.fireSettingsWatch({ [ROSTER_SETTINGS_KEY]: feed });

    // The same store the panel component subscribes to now holds the rows.
    assert.deepEqual(store.getBox().state, { kind: "snapshot", snapshot: feed });
    const view = describeRosterPanel(store.getBox().state, 2_000);
    assert.ok(view.kind === "rows");
    const active = rowsOf(view, "active");
    assert.deepEqual(
      active.map((r) => [r.title, r.statusLabel, r.visual, r.todoId]),
      [
        ["Parser", "running", "working", null],
        ["Tester", "steering", "working", "t-9"],
      ],
    );
    assert.deepEqual(
      active.map((r) => [r.elapsedText, r.toolCallCount]),
      [
        ["1s", 4],
        ["1s", 2],
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
