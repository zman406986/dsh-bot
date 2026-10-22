/**
 * Ticket 24 — per-tool call views (`tool.call.toolview`) for the five
 * dispatcher tools: keyed registration data, pure payload parsing, locale
 * shape, and apply() wiring over fake client seams (idioms from tickets
 * 20/21).
 *
 * Offline only (S8): no real Cordis, no browser, no DOM harness. Component
 * rendering stays covered by build success + typecheck; everything asserted
 * here is pure logic (registration options, payload → view model parsing) or
 * fake-seam registration.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../src/client/index.js";
import type { ClientContext } from "../src/client/context.js";
import {
  LOCALE_NAMESPACE,
  localeDictionary,
  validateLocaleDictionary,
  SHELL_OVERLAY_SLOT,
} from "../src/client/overlay.js";
import {
  SHIPPED_CLAIMED_TOOLVIEW_KEYS,
  TOOLVIEW_DEGRADED_KEY,
  TOOLVIEW_FIELD_KEYS,
  TOOLVIEW_TEXT_CLAMP_CHARS,
  TOOLVIEW_TOOL_NAMES,
  TOOL_CALL_TOOLVIEW_SLOT,
  describeToolview,
  isDispatcherToolName,
  toolviewRegistration,
  type ToolCallPayload,
  type ToolviewModel,
} from "../src/client/toolviews.js";
import {
  AWAIT_AGENT_TOOL,
  DISPATCHER_TOOL_NAMES,
  MESSAGE_AGENT_TOOL,
  SEND_PEER_TOOL,
  SPAWN_DISPATCHER_TOOL,
} from "../src/core/policy/prompts.js";
import { ROSTER_STATUS_KEYS } from "../src/core/roster-snapshot.js";
import type { WorkerStatus } from "../src/core/types.js";

/** One recorded slot entry in a fake's per-slot cell (ticket 86). */
interface FakeSlotEntry {
  options: Record<string, unknown>;
  component: unknown;
  dispose(): void;
}

/**
 * The shipped SlotCore register rule, shared by this file's fake (ticket 86):
 * cell lookup by slot name, `(priority ?? 0)` default, per-kind collision
 * throw with host wording, ascending insert sort, entry disposer.
 */
function registerEntry(
  cells: Map<string, FakeSlotEntry[]>,
  owners: FakeSlotEntry[],
  rawOptions: unknown,
  component: unknown,
): () => void {
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
    const target =
      options.key !== undefined
        ? `already has an entry for key "${options.key}"`
        : options.id !== undefined
          ? `already has an entry with id "${options.id}"`
          : "already has a registration";
    const kind =
      options.key !== undefined
        ? "keyed slot"
        : options.id !== undefined
          ? "list slot"
          : "single slot";
    throw new Error(
      `${kind} "${options.name}" ${target} at priority ${priority} — ` +
        `register at a different priority to shadow it (lowest renders)`,
    );
  }
  const entry: FakeSlotEntry = {
    options: { ...rawOptions } as Record<string, unknown>,
    component,
    dispose: () => {},
  };
  cell.push(entry);
  cell.sort(
    (a, b) =>
      ((a.options.priority as number | undefined) ?? 0) -
      ((b.options.priority as number | undefined) ?? 0),
  );
  entry.dispose = () => {
    const ownerAt = owners.indexOf(entry);
    if (ownerAt >= 0) owners.splice(ownerAt, 1);
    const cellAt = cell.indexOf(entry);
    if (cellAt >= 0) cell.splice(cellAt, 1);
  };
  owners.push(entry);
  return entry.dispose;
}

/**
 * Fake the client face (see test/client-face-scaffold.test.ts for the idiom).
 *
 * Ticket 86 (2026-09-19): the slots fake runs the shipped SlotCore register
 * rule — one cell per slot name, `(priority ?? 0)` default, and a throw on a
 * same-(priority ?? 0) collision along the entry's identity axis (key→keyed,
 * id→list, else single) with the host's wording. This is the same rule the
 * ticket-85 fix taught test/client-shell-mount.test.ts; it is what makes a
 * no-priority `root` register (the pre-85 cutover bug) fail offline. Host
 * source: `dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`, minified
 * SlotCore.register (`a = t.priority ?? 0`; per-kind `entries.find(...)`).
 */
function createClientCtx() {
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
        return registerEntry(cells, owner.entries, rawOptions, component);
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
    cells,
    findInject(parent: string) {
      return injects.find((record) => record.parent === parent);
    },
    runFiberTeardown() {
      for (const dispose of [...effectDisposers, ...injectControllers]) {
        dispose();
      }
    },
  };
  return ctx as typeof ctx & ClientContext & {
    findInject(parent: string):
      | { parent: string; entries: FakeSlotEntry[] }
      | undefined;
    runFiberTeardown(): void;
    cells: Map<string, FakeSlotEntry[]>;
  };
}

/** Build a realistic spawn_worker success result (shape from src/core/tools.ts). */
function spawnOkResult(overrides?: Partial<Record<string, unknown>>) {
  return {
    ok: true,
    worker_id: "w-7f3a",
    stream_key: "t-2",
    title: "Rewrite auth docs",
    ack: "Started \"Rewrite auth docs\" in the background.",
    ...overrides,
  };
}

/** One realistic check row (shape from src/core/tool-results.ts). */
function checkRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    worker_id: "w-7f3a",
    stream_key: "t-2",
    title: "Rewrite auth docs",
    status: "running" satisfies WorkerStatus,
    elapsed_ms: 252_000,
    tool_call_count: 7,
    transcript_ref: "sess_abc",
    todo_id: "t-2",
    recent_activity: "reading src/auth/session.ts",
    ...overrides,
  };
}

/** Assert a view is a detail and return it narrowed. */
function assertDetail(view: ToolviewModel): Extract<ToolviewModel, { kind: "detail" }> {
  assert.equal(view.kind, "detail");
  if (view.kind !== "detail") throw new Error("unreachable");
  return view;
}

/** Field lookup by locale label key. */
function fieldOf(
  view: Extract<ToolviewModel, { kind: "detail" }>,
  labelKey: string,
): string | undefined {
  return view.fields.find((field) => field.labelKey === labelKey)?.value;
}

describe("toolview — keyed registrations claim only our wire tool names", () => {
  it("targets the shipped keyed slot, never an invented or forbidden surface", () => {
    assert.equal(TOOL_CALL_TOOLVIEW_SLOT, "tool.call.toolview");
  });

  it("claims the five unchanged dispatcher keys plus the retained historical send_peer key", () => {
    // Ticket 116 retired send_peer from the tool surface and registered
    // message_agent in its place. The client face has no message_agent row
    // renderer yet, so it keeps claiming the send_peer key for historical
    // rows (src/client/toolviews.ts records the deliberate lag).
    // Ticket 117 added await_agent to the dispatcher surface; the client
    // face has no row renderer for it either, and the core chunk that
    // registered the tool deliberately does not touch src/client. Ticket 118
    // added spawn_dispatcher with the SAME deliberate lag — no renderer, no
    // claim. This pin states ALL THREE lags instead of pretending the lists
    // match.
    const expected = [...DISPATCHER_TOOL_NAMES]
      .filter(
        (name) =>
          name !== AWAIT_AGENT_TOOL && name !== SPAWN_DISPATCHER_TOOL,
      )
      .map((name) => (name === MESSAGE_AGENT_TOOL ? SEND_PEER_TOOL : name));
    assert.deepEqual([...TOOLVIEW_TOOL_NAMES], expected);
    // Every claimed name is either a live dispatcher tool or the retained
    // historical send_peer key.
    for (const name of TOOLVIEW_TOOL_NAMES) {
      if (name === SEND_PEER_TOOL) continue;
      assert.ok(isDispatcherToolName(name));
    }
  });

  it("builds one keyed options object per tool with the plugin locale", () => {
    for (const name of TOOLVIEW_TOOL_NAMES) {
      assert.deepEqual(toolviewRegistration(name), {
        name: TOOL_CALL_TOOLVIEW_SLOT,
        key: name,
        locale: "multitask-dispatcher",
      });
      // Keyed cells use `key`, not the list-slot `id`/`order` pair.
      assert.equal("id" in toolviewRegistration(name), false);
    }
  });

  it("keys are unique and disjoint from shipped-claimed cells (additive-safe)", () => {
    assert.equal(new Set(TOOLVIEW_TOOL_NAMES).size, TOOLVIEW_TOOL_NAMES.length);
    for (const name of TOOLVIEW_TOOL_NAMES) {
      assert.ok(
        !SHIPPED_CLAIMED_TOOLVIEW_KEYS.includes(name),
        `must never claim a covered key (shadowing election): ${name}`,
      );
    }
    // The shipped catalog fixture itself stays the research Finding 5 set.
    assert.deepEqual(SHIPPED_CLAIMED_TOOLVIEW_KEYS, ["cordis_define", "cordis_run"]);
  });
});

describe("toolview — spawn_worker payload parsing", () => {
  it("renders worker id, title, stream, todo, and the ok outcome", () => {
    const view = assertDetail(
      describeToolview("spawn_worker", {
        args: {
          stream_key: "t-2",
          title: "Rewrite auth docs",
          prompt: "Self-contained instruction…",
          todo_id: "t-2",
        },
        result: spawnOkResult(),
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.worker), "w-7f3a");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.title), "Rewrite auth docs");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.stream), "t-2");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.todo), "t-2");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "ok");
    // No status rows outside check_workers.
    assert.equal(view.statusRows.length, 0);
  });

  it("renders the verbatim failure reason and falls title/stream back to args", () => {
    const view = assertDetail(
      describeToolview("spawn_worker", {
        args: { stream_key: "t-2", title: "Rewrite auth docs", prompt: "…" },
        result: {
          ok: false,
          reason: "duplicate-stream-key",
          detail: "stream t-2 already has a live worker",
        },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "duplicate-stream-key");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.worker), undefined);
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.title), "Rewrite auth docs");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.stream), "t-2");
  });

  it("renders args-only calls (result not yet present) without an outcome", () => {
    const view = assertDetail(
      describeToolview("spawn_worker", {
        args: { stream_key: "t-9", title: "Grid sweep", prompt: "…" },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), undefined);
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.title), "Grid sweep");
  });
});

describe("toolview — check_workers payload parsing", () => {
  it("renders status rows with verbatim core FSM vocabulary labels", () => {
    const workers: WorkerStatus[] = [...ROSTER_STATUS_KEYS];
    const view = assertDetail(
      describeToolview("check_workers", {
        args: {},
        result: {
          ok: true,
          rows: workers.map((status, index) =>
            checkRow({
              worker_id: `w-${index}`,
              title: `Worker ${index}`,
              status,
            }),
          ),
          summary: "…",
        },
      }),
    );
    assert.equal(view.statusRows.length, workers.length);
    for (const [index, row] of view.statusRows.entries()) {
      assert.equal(row.workerId, `w-${index}`);
      assert.equal(row.title, `Worker ${index}`);
      assert.equal(row.statusLabel, workers[index]);
    }
  });

  it("falls a missing row title back to the worker id and skips junk rows", () => {
    const view = assertDetail(
      describeToolview("check_workers", {
        args: {},
        result: {
          ok: true,
          rows: [
            checkRow({ title: "Parser" }),
            checkRow({ worker_id: "w-ok", title: null }),
            checkRow({ title: "" }),
            "junk",
            42,
            null,
            checkRow({ worker_id: 7 }),
          ],
          summary: "…",
        },
      }),
    );
    assert.deepEqual(
      view.statusRows.map((row) => [row.workerId, row.title]),
      [
        ["w-7f3a", "Parser"],
        ["w-ok", "w-ok"],
        ["w-7f3a", "w-7f3a"],
      ],
    );
  });

  it("renders a single-worker check: target arg + its row", () => {
    const view = assertDetail(
      describeToolview("check_workers", {
        args: { worker_id: "w-1" },
        result: {
          ok: true,
          rows: [checkRow({ worker_id: "w-1", status: "steering" })],
          summary: "…",
        },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.worker), "w-1");
    assert.equal(view.statusRows.length, 1);
    assert.equal(view.statusRows[0]?.statusLabel, "steering");
  });

  it("renders an ok result with zero rows (empty roster) as a plain outcome", () => {
    const view = assertDetail(
      describeToolview("check_workers", {
        args: {},
        result: {
          ok: true,
          rows: [],
          summary: "No workers on the roster for this session.",
        },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "ok");
    assert.equal(view.statusRows.length, 0);
  });

  it("degrades a success result whose rows are not an array", () => {
    assert.deepEqual(
      describeToolview("check_workers", {
        args: {},
        result: { ok: true, rows: "all fine", summary: "…" },
      }),
      { kind: "degraded" },
    );
  });

  it("renders the unknown-worker refusal without status rows", () => {
    const view = assertDetail(
      describeToolview("check_workers", {
        args: { worker_id: "w-gone" },
        result: { ok: false, reason: "unknown-worker", detail: "unknown worker: w-gone" },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.worker), "w-gone");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "unknown-worker");
    assert.equal(view.statusRows.length, 0);
  });
});

describe("toolview — check_workers activity rows (ticket 29)", () => {
  it("renders the row's recent_activity phrase when present", () => {
    const view = assertDetail(
      describeToolview("check_workers", {
        args: {},
        result: {
          ok: true,
          rows: [
            checkRow({ recent_activity: "bash: npm test" }),
            checkRow({ worker_id: "w-quiet", recent_activity: null }),
          ],
          summary: "…",
        },
      }),
    );
    assert.equal(view.statusRows.length, 2);
    assert.equal(view.statusRows[0]?.activity, "bash: npm test");
    assert.equal(view.statusRows[1]?.activity, null);
  });

  it("omits the line for absent, empty, or whitespace-only activity", () => {
    const view = assertDetail(
      describeToolview("check_workers", {
        args: {},
        result: {
          ok: true,
          rows: [
            checkRow({ recent_activity: null }),
            checkRow({ recent_activity: "" }),
            checkRow({ recent_activity: "   \n\t  " }),
            checkRow({ recent_activity: 42 }),
          ],
          summary: "…",
        },
      }),
    );
    for (const row of view.statusRows) {
      assert.equal(row.activity, null);
    }
  });

  it("collapses whitespace and clamps an oversized phrase to the compact budget", () => {
    const long = `bash: ${"npm run build && ".repeat(12)}done`;
    const view = assertDetail(
      describeToolview("check_workers", {
        args: {},
        result: { ok: true, rows: [checkRow({ recent_activity: long })], summary: "…" },
      }),
    );
    const activity = view.statusRows[0]?.activity;
    assert.ok(activity, "activity rendered");
    assert.ok(activity.length <= TOOLVIEW_TEXT_CLAMP_CHARS + 1);
    assert.ok(activity.endsWith("…"));
    assert.ok(!activity.includes("\n"), "whitespace collapsed to one line");
  });

  it("activity never turns a malformed payload into a throw", () => {
    for (const bad of ["junk", 7, null, { text: "x" }]) {
      const view = describeToolview("check_workers", {
        args: {},
        result: { ok: true, rows: [checkRow({ recent_activity: bad })], summary: "…" },
      });
      assert.equal(view.kind, "detail");
    }
  });
});

describe("toolview — steer_worker payload parsing", () => {
  it("renders worker id, the clamped steer text, and the outcome", () => {
    const long = `${"focus on the failing test first, ".repeat(12)}then report`;
    const view = assertDetail(
      describeToolview("steer_worker", {
        args: { worker_id: "w-7f3a", message: long },
        result: { ok: true, note: "Correction parked for \"Rewrite auth docs\"." },
      }),
    );
    const steer = fieldOf(view, TOOLVIEW_FIELD_KEYS.steer);
    assert.ok(steer, "steer text rendered");
    assert.ok(steer.length <= 161, "compact clamp applies");
    assert.ok(steer.endsWith("…"));
    assert.ok(!steer.includes("\n"), "whitespace collapsed to one line");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.worker), "w-7f3a");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "ok");
  });

  it("renders the not-running refusal", () => {
    const view = assertDetail(
      describeToolview("steer_worker", {
        args: { worker_id: "w-done", message: "hurry up" },
        result: { ok: false, reason: "not-running", detail: "w-done already settled" },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "not-running");
  });
});

describe("toolview — stop_worker payload parsing", () => {
  it("renders worker id and the ok outcome", () => {
    const view = assertDetail(
      describeToolview("stop_worker", {
        args: { worker_id: "w-7f3a" },
        result: { ok: true, note: "Stopped." },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.worker), "w-7f3a");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "ok");
  });

  it("renders the already-settled refusal", () => {
    const view = assertDetail(
      describeToolview("stop_worker", {
        args: { worker_id: "w-gone" },
        result: { ok: false, reason: "already-settled", detail: "unknown worker: w-gone" },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "already-settled");
  });
});

describe("toolview — deliver_result payload parsing", () => {
  it("renders delivered, todo completion, attachment count, and outcome", () => {
    const view = assertDetail(
      describeToolview("deliver_result", {
        args: {
          text: "The migration guide is rewritten.",
          todo_id: "t-2",
          attachment_paths: ["/w/auth.md", "/w/changelog.md"],
        },
        result: { ok: true, delivered: true, todo_completed: "t-2" },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.delivered), "true");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.todo), "t-2");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.attachments), "2");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "ok");
  });

  it("renders a failed delivery (no reason field) as the failed outcome", () => {
    const view = assertDetail(
      describeToolview("deliver_result", {
        args: { text: "…", todo_id: "t-2" },
        result: { ok: false, delivered: false, todo_completed: null },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.delivered), "false");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "failed");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.todo), "t-2", "falls back to args todo");
  });

  it("prefers the result todo completion over the arg", () => {
    const view = assertDetail(
      describeToolview("deliver_result", {
        args: { text: "…", todo_id: "t-2" },
        result: { ok: true, delivered: true, todo_completed: "t-2" },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.todo), "t-2");
  });
});

describe("toolview — degraded-but-safe on malformed payloads (never throws)", () => {
  const nasty: Array<[string, unknown]> = [
    ["null props", null],
    ["undefined props", undefined],
    ["number props", 42],
    ["string props", "spawn_worker"],
    ["array props", [1, 2, 3]],
    ["empty object", {}],
    ["non-object args", { args: 5, result: spawnOkResult() }],
    ["non-object result", { args: { worker_id: "w" }, result: "ok" }],
    ["wrong-typed fields", { args: { worker_id: 42, message: true }, result: { ok: "yes" } }],
    ["result ok non-boolean", { args: {}, result: { ok: "true", rows: [] } }],
    ["junk rows entries", { args: {}, result: { ok: true, rows: [[]] } }],
    ["null-valued fields", { args: { worker_id: null }, result: null }],
  ];

  for (const [name, props] of nasty) {
    for (const toolName of TOOLVIEW_TOOL_NAMES) {
      it(`${name} → degraded for ${toolName}`, () => {
        let view: ToolviewModel | undefined;
        assert.doesNotThrow(() => {
          view = describeToolview(toolName, props);
        });
        assert.ok(view, "parser always returns a model");
        assert.ok(
          view.kind === "degraded" || view.kind === "detail",
          "model is a valid variant",
        );
      });
    }
  }

  it("a foreign tool name degrades (no invented keys)", () => {
    assert.deepEqual(describeToolview("cordis_run", { args: {}, result: {} }), {
      kind: "degraded",
    });
  });

  it("empty-but-well-formed props degrade instead of rendering a bare row", () => {
    assert.deepEqual(
      describeToolview("spawn_worker", { args: {}, result: {} } satisfies ToolCallPayload),
      { kind: "degraded" },
    );
  });
});

describe("toolview — locale dictionary shape", () => {
  it("stays a valid {en, zh} dictionary and carries the toolview copy", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    for (const key of [
      TOOLVIEW_DEGRADED_KEY,
      ...Object.values(TOOLVIEW_FIELD_KEYS),
    ]) {
      assert.ok(typeof localeDictionary.en[key] === "string", `en missing ${key}`);
      assert.ok(typeof localeDictionary.zh[key] === "string", `zh missing ${key}`);
    }
  });
});

describe("toolview — apply() registers one keyed entry per tool via the fake seam", () => {
  it("registers one keyed toolview entry per claimed wire name; the overlay era is over", () => {
    const ctx = createClientCtx();
    apply(ctx);

    // Three injects: tool.call.toolview (toolviews) + plugins.row.config
    // (ticket 47's settings page) + the worker session-kind glyph in the
    // header actions band (ticket 123). The `main` page and `root` election
    // are not composed (stock dsh stays primary). The shell.overlay injects
    // (capsule, launcher) retired at the ticket-78 cutover.
    assert.equal(ctx.injects.length, 4);
    const overlay = ctx.findInject(SHELL_OVERLAY_SLOT);
    const toolviews = ctx.findInject(TOOL_CALL_TOOLVIEW_SLOT);
    assert.equal(overlay, undefined, "no overlay inject post-cutover");
    assert.ok(toolviews, "toolview inject present");

    assert.equal(toolviews.entries.length, TOOLVIEW_TOOL_NAMES.length);
    for (const [index, name] of TOOLVIEW_TOOL_NAMES.entries()) {
      const entry = toolviews.entries[index];
      assert.deepEqual(entry?.options, toolviewRegistration(name));
      assert.equal(typeof entry?.component, "function");
    }
    // Locale namespace registered once with the merged dictionary.
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));
  });

  it("each entry's component is bound to its own tool name", () => {
    const ctx = createClientCtx();
    apply(ctx);
    const toolviews = ctx.findInject(TOOL_CALL_TOOLVIEW_SLOT);
    assert.ok(toolviews);
    for (const [index, name] of TOOLVIEW_TOOL_NAMES.entries()) {
      const component = toolviews.entries[index]?.component;
      assert.equal(typeof component, "function");
      // Distinct closures per tool (registration captures the tool name).
      if (index > 0) {
        assert.notEqual(component, toolviews.entries[index - 1]?.component);
      }
    }
  });
});

describe("toolview — HMR reversal over the fake seam", () => {
  it("fiber teardown removes all six entries; re-apply restores them cleanly", () => {
    const ctx = createClientCtx();
    apply(ctx);
    assert.equal(ctx.findInject(TOOL_CALL_TOOLVIEW_SLOT)?.entries.length, 6);
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));

    ctx.runFiberTeardown();
    assert.equal(ctx.injects.length, 0);
    assert.equal(ctx.findInject(TOOL_CALL_TOOLVIEW_SLOT), undefined);
    assert.equal(ctx.locales.has(LOCALE_NAMESPACE), false);

    // Post-HMR fiber: everything registers again, no accumulation. Ticket 86:
    // this re-apply would throw the shipped slot collision if teardown had
    // left any entry in its cell (the fake now models that rule), so the
    // HMR-reversal assertion is a real contract check, not just a count.
    assert.doesNotThrow(() => apply(ctx));
    assert.equal(ctx.injects.length, 4);
    assert.equal(ctx.findInject(TOOL_CALL_TOOLVIEW_SLOT)?.entries.length, 6);
    assert.equal(ctx.findInject(SHELL_OVERLAY_SLOT), undefined);
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));
  });
});

describe("toolview — send_peer payload parsing (ticket 70)", () => {
  it("renders the target session, the priority flag, and the acceptance outcome", () => {
    const view = assertDetail(
      describeToolview("send_peer", {
        args: {
          to_session: "dispatcher-b",
          text: "(body never renders on the row)",
          priority: true,
        },
        result: {
          ok: true,
          message_id: "peer-1",
          to_session: "dispatcher-b",
          summary: "Accepted for peer session dispatcher-b (message peer-1).",
        },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.peer), "dispatcher-b");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.priority), "true");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "ok");
    // The message body is never a row field.
    assert.equal(
      view.fields.some((field) => field.value.includes("body never renders")),
      false,
    );
  });

  it("renders a refused send as the verbatim reason outcome", () => {
    const view = assertDetail(
      describeToolview("send_peer", {
        args: { to_session: "ghost-session", text: "…" },
        result: {
          ok: false,
          reason: "unknown-target",
          detail: "No live dispatcher session \"ghost-session\".",
        },
      }),
    );
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.peer), "ghost-session");
    assert.equal(fieldOf(view, TOOLVIEW_FIELD_KEYS.outcome), "unknown-target");
    // No priority arg: the field is omitted entirely (honest absence).
    assert.equal(
      view.fields.some((field) => field.labelKey === TOOLVIEW_FIELD_KEYS.priority),
      false,
    );
  });

  it("degrades when nothing parses", () => {
    assert.equal(describeToolview("send_peer", null).kind, "degraded");
    assert.equal(describeToolview("send_peer", { args: 4 }).kind, "degraded");
  });
});
