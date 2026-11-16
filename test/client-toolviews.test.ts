/**
 * Per-tool call views (`tool.call.toolview`) for the dispatcher tools —
 * readable-status anatomy. The three live custom tools are `deliver_result`,
 * `message_agent` and `spawn_dispatcher`; the five retired dispatcher verbs
 * and `send_peer` are kept as historical parsers for old transcripts.
 *
 * Offline only (S8): no real Cordis, no browser, no DOM harness. Everything
 * asserted here is pure logic (registration options, payload → view model
 * parsing) or fake-seam registration, plus static markup produced by
 * `react-dom/server` (no DOM) so the three-level row — primary sentence,
 * facts, nested Details — cannot regress unnoticed.
 *
 * The owner's reported paste forms are pinned as a negative: `Agent <uuid> /
 * Delivered as peer / Outcome ok` and `Delivered true / Todo todo-7 /
 * Outcome ok` can never appear again.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { apply } from "../src/client/index.js";
import type { ClientContext } from "../src/client/context.js";
import {
  LOCALE_NAMESPACE,
  SHELL_OVERLAY_SLOT,
  localeDictionary,
} from "../src/client/overlay.js";
import {
  TOOLVIEW_DETAIL_KEYS,
  TOOLVIEW_TOOL_NAMES,
  TOOL_CALL_TOOLVIEW_SLOT,
  describeToolview,
  isDispatcherToolName,
  refusalCauseKey,
  toolviewRegistration,
  type ToolviewFact,
  type ToolviewModel,
} from "../src/client/toolviews.js";
import { createToolviewComponent } from "../src/client/toolview-panel.js";
import { TOOLVIEW_CLASS, TOOLVIEW_CSS } from "../src/client/toolview-styles.js";
import {
  AWAIT_AGENT_TOOL,
  CHECK_WORKERS_TOOL,
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
  MESSAGE_AGENT_TOOL,
  SEND_PEER_TOOL,
  SPAWN_DISPATCHER_TOOL,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
} from "../src/core/policy/prompts.js";
import { ROSTER_STATUS_KEYS } from "../src/core/roster-snapshot.js";
import type { WorkerStatus } from "../src/core/types.js";
import {
  formatCount,
  formatTemplate,
} from "../src/client/status-format.js";

type DetailView = Extract<ToolviewModel, { kind: "detail" }>;

const EN = localeDictionary.en;
const t = (key: string): string => EN[key] ?? key;

/** Resolve one fact exactly as the renderer does. */
function factText(fact: ToolviewFact): string {
  switch (fact.kind) {
    case "text":
      return fact.text;
    case "copy":
      return formatTemplate(t(fact.key), fact.values);
    case "count":
      return formatCount(t, fact.keyBase, fact.count);
  }
}

/** Resolve the primary sentence exactly as the renderer does. */
function primaryOf(view: DetailView): string {
  const values: Record<string, string> = { ...view.primaryValues };
  if (view.causeKey !== null) values["cause"] = t(view.causeKey);
  if (view.subject === null && view.subjectKey !== null) {
    values["subject"] = t(view.subjectKey);
  }
  return formatTemplate(t(view.primaryKey), values);
}

function factsOf(view: DetailView): string[] {
  return view.facts.map(factText);
}

function detailsOf(view: DetailView): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const detail of view.details) {
    const list = map.get(detail.labelKey) ?? [];
    list.push(detail.value);
    map.set(detail.labelKey, list);
  }
  return map;
}

function detailFirst(view: DetailView, labelKey: string): string | undefined {
  return detailsOf(view).get(labelKey)?.[0];
}

/** Assert a view is a detail and return it narrowed. */
function assertDetail(view: ToolviewModel): DetailView {
  assert.equal(view.kind, "detail");
  if (view.kind !== "detail") throw new Error("unreachable");
  return view;
}

/** One recorded slot entry in a fake's per-slot cell (ticket 86). */
interface FakeSlotEntry {
  options: Record<string, unknown>;
  component: unknown;
  dispose(): void;
}

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

function createClientCtx() {
  const locales = new Map<string, unknown>();
  const cells = new Map<string, FakeSlotEntry[]>();
  const injects: Array<{
    parent: string;
    entries: FakeSlotEntry[];
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
        const record = { parent, entries: [] as FakeSlotEntry[] };
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

describe("toolview — keyed registrations claim only our wire tool names", () => {
  it("claims the three live dispatcher tools plus the historical keys", () => {
    // The five dispatcher verbs removed by the stock-subagent refactor have no
    // renderer on the dispatcher surface any more, but old transcripts still
    // carry their rows. The client keeps parsing them (`send_peer` set the
    // same precedent): a key that never fires simply degrades. Only the three
    // live names may claim dispatcher-tool status.
    const live = [...DISPATCHER_TOOL_NAMES];
    const historical = [
      SPAWN_WORKER_TOOL,
      CHECK_WORKERS_TOOL,
      STEER_WORKER_TOOL,
      STOP_WORKER_TOOL,
      AWAIT_AGENT_TOOL,
      SEND_PEER_TOOL,
    ];
    assert.deepEqual(
      [...TOOLVIEW_TOOL_NAMES].sort(),
      [...live, ...historical].sort(),
      "the claimed key set drifted from live + historical",
    );
    for (const name of live) {
      assert.ok(
        isDispatcherToolName(name),
        `live dispatcher tool is not claimed: ${name}`,
      );
    }
    for (const name of historical) {
      assert.equal(
        isDispatcherToolName(name),
        false,
        `retired tool still claims dispatcher status: ${name}`,
      );
    }
    // TODO(stock-subagent refactor): if src/client/toolviews.ts drops the five
    // retired dispatcher keys from TOOLVIEW_TOOL_NAMES, shrink this fixture to
    // the three live names + send_peer and delete the historical describes.
  });
});

describe("toolview — spawn_worker (historical parser)", () => {
  it("leads with Started \"title\", one worker fact, and full ids in details", () => {
    const view = assertDetail(
      describeToolview(SPAWN_WORKER_TOOL, {
        args: {
          stream_key: "t-2",
          title: "Rewrite auth docs",
          prompt: "(never renders)",
          todo_id: "t-2",
        },
        result: spawnOkResult(),
      }),
    );
    assert.equal(view.state, "starting");
    assert.equal(primaryOf(view), 'Started "Rewrite auth docs"');
    assert.equal(view.subject, "Rewrite auth docs");
    assert.deepEqual(factsOf(view), ["worker 7f3a", "todo t-2"]);
    assert.equal(detailFirst(view, TOOLVIEW_DETAIL_KEYS.worker), "w-7f3a");
    assert.equal(detailFirst(view, TOOLVIEW_DETAIL_KEYS.stream), "t-2");
    assert.equal(detailFirst(view, TOOLVIEW_DETAIL_KEYS.todo), "t-2");
    // The ack (which embeds the prompt) never reaches the row.
    assert.equal(
      JSON.stringify(view).includes("never renders"),
      false,
    );
    assert.equal(view.statusRows.length, 0);
  });

  it("maps a duplicate-stream-key refusal to a human sentence, raw enum in details", () => {
    const view = assertDetail(
      describeToolview(SPAWN_WORKER_TOOL, {
        args: { stream_key: "t-2", title: "Rewrite auth docs", prompt: "…" },
        result: { ok: false, reason: "duplicate-stream-key", detail: "…" },
      }),
    );
    assert.equal(view.state, "failed");
    assert.equal(
      primaryOf(view),
      "Couldn't start \"Rewrite auth docs\" — that stream key is already in use. Nothing was started.",
    );
    assert.equal(view.causeKey, "toolview.cause.duplicate-stream-key");
    assert.equal(
      detailFirst(view, TOOLVIEW_DETAIL_KEYS.reason),
      "duplicate-stream-key",
    );
    assert.deepEqual(factsOf(view), []);
  });

  it("degrades to the worker short ref when no title exists anywhere", () => {
    const view = assertDetail(
      describeToolview(SPAWN_WORKER_TOOL, {
        args: {},
        result: {
          ok: true,
          worker_id: "063f41a2-9897-4936-95de-1cd3f2f76132",
          stream_key: "k",
        },
      }),
    );
    assert.equal(primaryOf(view), "Started worker …6132");
    assert.equal(
      primaryOf(view).startsWith("session-"),
      false,
      "never leads with session-",
    );
    assert.doesNotMatch(primaryOf(view), /^[0-9a-f]{8}-/i, "never leads with a UUID");
  });

  it("renders an unsettled call from its arguments without inventing an outcome", () => {
    const view = assertDetail(
      describeToolview(SPAWN_WORKER_TOOL, {
        args: { title: "Rewrite auth docs", stream_key: "t-2" },
        result: null,
      }),
    );
    assert.equal(view.state, "starting");
    assert.equal(primaryOf(view), 'Starting "Rewrite auth docs"');
    assert.equal(view.causeKey, null);
    assert.deepEqual(factsOf(view), []);
  });
});

describe("toolview — check_workers (historical parser)", () => {
  it("renders a summary line and one readable row per worker", () => {
    const workers: WorkerStatus[] = [...ROSTER_STATUS_KEYS];
    const view = assertDetail(
      describeToolview(CHECK_WORKERS_TOOL, {
        args: {},
        result: {
          ok: true,
          summary: "…",
          rows: workers.map((status, index) =>
            checkRow({
              worker_id: `w-${index}`,
              title: `Worker ${index}`,
              status,
            }),
          ),
        },
      }),
    );
    assert.equal(view.state, "done");
    assert.equal(primaryOf(view), `Checked ${workers.length} workers`);
    assert.equal(view.statusRows.length, workers.length);
    const words = [
      "starting",
      "working",
      "adjusting",
      "done",
      "failed",
      "stopped",
    ];
    for (const [index, row] of view.statusRows.entries()) {
      assert.equal(row.workerId, `w-${index}`);
      assert.equal(row.title, `Worker ${index}`);
      // Raw core vocabulary stays available for data-status…
      assert.equal(row.statusLabel, workers[index]);
      // …while exactly one human word renders.
      assert.equal(row.statusWordKey, `status.${words[index]}`);
    }
    // One outcome signal: the summary sentence. There is no Outcome field.
    assert.equal("outcome" in TOOLVIEW_DETAIL_KEYS, false);
  });

  it("orders a row title → status → facts → activity → short ref", () => {
    const view = assertDetail(
      describeToolview(CHECK_WORKERS_TOOL, {
        args: {},
        result: { ok: true, rows: [checkRow()] },
      }),
    );
    const row = view.statusRows[0];
    assert.ok(row);
    assert.equal(row.title, "Rewrite auth docs");
    assert.equal(t(row.statusWordKey ?? ""), "Working");
    assert.deepEqual(row.facts.map(factText), ["4m 12s", "7 tool calls"]);
    assert.equal(row.activity, "reading src/auth/session.ts");
    assert.equal(row.shortRef, "worker 7f3a");
    assert.equal(
      detailFirst(view, TOOLVIEW_DETAIL_KEYS.worker),
      "w-7f3a",
      "full id lives in details",
    );
    assert.equal(detailFirst(view, TOOLVIEW_DETAIL_KEYS.stream), "t-2");
    assert.equal(detailFirst(view, TOOLVIEW_DETAIL_KEYS.transcript), "sess_abc");
  });

  it("pluralizes one tool call, omits zero, and says no workers for an empty roster", () => {
    const one = assertDetail(
      describeToolview(CHECK_WORKERS_TOOL, {
        args: {},
        result: {
          ok: true,
          rows: [checkRow({ tool_call_count: 1, elapsed_ms: 1_000 })],
        },
      }),
    );
    assert.deepEqual(one.statusRows[0]?.facts.map(factText), [
      "1s",
      "1 tool call",
    ]);

    const zero = assertDetail(
      describeToolview(CHECK_WORKERS_TOOL, {
        args: {},
        result: { ok: true, rows: [checkRow({ tool_call_count: 0 })] },
      }),
    );
    assert.deepEqual(zero.statusRows[0]?.facts.map(factText), ["4m 12s"]);

    const empty = assertDetail(
      describeToolview(CHECK_WORKERS_TOOL, {
        args: {},
        result: { ok: true, rows: [] },
      }),
    );
    assert.equal(primaryOf(empty), "No workers on the roster.");
  });

  it("falls a missing row title back to the short ref and skips junk rows", () => {
    const view = assertDetail(
      describeToolview(CHECK_WORKERS_TOOL, {
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
        },
      }),
    );
    assert.deepEqual(
      view.statusRows.map((row) => [row.workerId, row.title]),
      [
        ["w-7f3a", "Parser"],
        ["w-ok", "worker ok"],
        ["w-7f3a", "worker 7f3a"],
      ],
    );
  });

  it("degrades a success result whose rows are not an array", () => {
    assert.deepEqual(
      describeToolview(CHECK_WORKERS_TOOL, {
        args: {},
        result: { ok: true, rows: "all fine", summary: "…" },
      }),
      { kind: "degraded" },
    );
  });

  it("maps the unknown-worker fence without fabricating status rows", () => {
    const view = assertDetail(
      describeToolview(CHECK_WORKERS_TOOL, {
        args: { worker_id: "w-gone" },
        result: { ok: false, reason: "unknown-worker", detail: "…" },
      }),
    );
    assert.equal(
      primaryOf(view),
      "Couldn't check the roster — no worker with that id in this chat.",
    );
    assert.equal(view.statusRows.length, 0);
    assert.equal(
      detailFirst(view, TOOLVIEW_DETAIL_KEYS.reason),
      "unknown-worker",
    );
  });
});

describe("toolview — steer_worker (historical parser)", () => {
  it("leads with the title, keeps the instruction as one fact", () => {
    const long = `${"focus on the failing test first, ".repeat(12)}then report`;
    const view = assertDetail(
      describeToolview(STEER_WORKER_TOOL, {
        args: { worker_id: "w-7f3a", message: long },
        result: { ok: true, worker_id: "w-7f3a", title: "Rewrite auth docs" },
      }),
    );
    assert.equal(view.state, "adjusting");
    assert.equal(primaryOf(view), "Steer queued for Rewrite auth docs");
    assert.equal(view.facts.length, 1);
    const instruction = factText(view.facts[0]!);
    assert.ok(instruction.length <= 161, "compact clamp applies");
    assert.ok(instruction.endsWith("…"));
    assert.ok(!instruction.includes("\n"), "whitespace collapsed to one line");
    assert.equal(detailFirst(view, TOOLVIEW_DETAIL_KEYS.worker), "w-7f3a");
  });

  it("degrades an old transcript (no display title) to the worker short ref", () => {
    const view = assertDetail(
      describeToolview(STEER_WORKER_TOOL, {
        args: { worker_id: "w-7f3a", message: "focus" },
        result: { ok: true },
      }),
    );
    assert.equal(primaryOf(view), "Steer queued for worker 7f3a");
    assert.equal(view.subject, "worker 7f3a");
  });

  it("maps not-running honestly and adds the dormant fact only when true", () => {
    const refused = assertDetail(
      describeToolview(STEER_WORKER_TOOL, {
        args: { worker_id: "w-7f3a", message: "focus" },
        result: { ok: false, reason: "not-running", detail: "…" },
      }),
    );
    assert.equal(
      primaryOf(refused),
      "Couldn't steer worker 7f3a — that worker has already finished. Nothing was queued.",
    );

    const dormant = assertDetail(
      describeToolview(STEER_WORKER_TOOL, {
        args: { worker_id: "w-dormant", message: "focus" },
        result: { ok: true, worker_id: "w-dormant", dormant: true },
      }),
    );
    assert.deepEqual(dormant.facts.map(factText), [
      "focus",
      "its session is resuming",
    ]);
  });
});

describe("toolview — stop_worker (historical parser)", () => {
  it("renders the stopped sentence and the mode in details", () => {
    const view = assertDetail(
      describeToolview(STOP_WORKER_TOOL, {
        args: { worker_id: "w-7f3a" },
        result: {
          ok: true,
          worker_id: "w-7f3a",
          title: "Rewrite auth docs",
          mode: "stopped",
        },
      }),
    );
    assert.equal(view.state, "stopped");
    assert.equal(primaryOf(view), "Stopped Rewrite auth docs");
    assert.equal(detailFirst(view, TOOLVIEW_DETAIL_KEYS.mode), "stopped");
  });

  it("names the released hold path instead of claiming a stop", () => {
    const view = assertDetail(
      describeToolview(STOP_WORKER_TOOL, {
        args: { worker_id: "w-held" },
        result: { ok: true, worker_id: "w-held", mode: "released-hold" },
      }),
    );
    assert.equal(primaryOf(view), "Released the stream held by worker held");
  });

  it("maps already-settled to a human cause", () => {
    const view = assertDetail(
      describeToolview(STOP_WORKER_TOOL, {
        args: { worker_id: "w-7f3a" },
        result: { ok: false, reason: "already-settled", detail: "…" },
      }),
    );
    assert.equal(
      primaryOf(view),
      "Couldn't stop worker 7f3a — that worker has already finished. Nothing changed.",
    );
  });
});

describe("toolview — deliver_result", () => {
  it("turns delivered:true into a sentence; todo and attachments become facts", () => {
    const view = assertDetail(
      describeToolview(DELIVER_RESULT_TOOL, {
        args: {
          text: "The migration guide is rewritten.",
          todo_id: "todo-7",
          attachment_paths: ["/w/auth.md", "/w/changelog.md"],
        },
        result: { ok: true, delivered: true, todo_completed: "todo-7" },
      }),
    );
    assert.equal(view.state, "done");
    assert.equal(primaryOf(view), "Delivered to you");
    assert.deepEqual(factsOf(view), ["todo 7 completed", "2 attachments"]);
    assert.equal(
      JSON.stringify(view).includes("true"),
      false,
      "no boolean ever renders as text",
    );
    assert.equal(detailFirst(view, TOOLVIEW_DETAIL_KEYS.todo), "todo-7");
  });

  it("channel:'reply' records the result instead of claiming it was delivered", () => {
    // ADR-0009: with no wired send channel the dispatcher's own reply is the
    // channel, so the user has not read anything yet. `delivered: true` means
    // the obligation was recorded, never that the text arrived.
    const view = assertDetail(
      describeToolview(DELIVER_RESULT_TOOL, {
        args: { text: "The migration guide is rewritten.", todo_id: "todo-7" },
        result: {
          ok: true,
          delivered: true,
          channel: "reply",
          todo_completed: "todo-7",
          todo_title: "Rewrite auth docs",
        },
      }),
    );
    assert.equal(view.state, "done");
    assert.equal(primaryOf(view), "Result recorded — it arrives in the reply");
    assert.deepEqual(factsOf(view), ['todo "Rewrite auth docs" marked done']);
    assert.notEqual(primaryOf(view), "Delivered to you");
  });

  it("an explicit-send result keeps the delivered copy", () => {
    const view = assertDetail(
      describeToolview(DELIVER_RESULT_TOOL, {
        args: { text: "Done.", todo_id: "todo-7" },
        result: {
          ok: true,
          delivered: true,
          channel: "send",
          todo_completed: "todo-7",
        },
      }),
    );
    assert.equal(primaryOf(view), "Delivered to you");
    assert.deepEqual(factsOf(view), ["todo 7 completed"]);
  });

  it("turns delivered:false into an honest refusal and omits todo_completed:null", () => {
    const view = assertDetail(
      describeToolview(DELIVER_RESULT_TOOL, {
        args: { text: "…", todo_id: "todo-7" },
        result: { ok: false, delivered: false, todo_completed: null },
      }),
    );
    assert.equal(view.state, "failed");
    assert.equal(
      primaryOf(view),
      "Couldn't deliver — the send failed. Nothing reached the user.",
    );
    assert.deepEqual(factsOf(view), []);
    assert.equal(
      JSON.stringify(view).includes("false"),
      false,
      "no boolean ever renders as text",
    );
    assert.equal(
      detailsOf(view).get(TOOLVIEW_DETAIL_KEYS.todo)?.join(","),
      "todo-7",
      "the argument todo is still the details truth",
    );
  });

  it("maps no-delivery-channel to its own cause", () => {
    const view = assertDetail(
      describeToolview(DELIVER_RESULT_TOOL, {
        args: { text: "…" },
        result: {
          ok: false,
          delivered: false,
          todo_completed: null,
          reason: "no-delivery-channel",
        },
      }),
    );
    assert.equal(
      primaryOf(view),
      "Couldn't deliver — this build has no way to send to you. Nothing reached the user.",
    );
  });
});

describe("toolview — send_peer (historical parser)", () => {
  it("renders the target, the priority fact, and details without the body", () => {
    const view = assertDetail(
      describeToolview(SEND_PEER_TOOL, {
        args: {
          to_session: "dispatcher-b",
          text: "(body never renders on the row)",
          priority: true,
        },
        result: {
          ok: true,
          message_id: "peer-1",
          to_session: "dispatcher-b",
        },
      }),
    );
    assert.equal(primaryOf(view), "Sent to dispatcher b");
    assert.deepEqual(factsOf(view), ["priority"]);
    assert.equal(
      detailFirst(view, TOOLVIEW_DETAIL_KEYS.target),
      "dispatcher-b",
    );
    assert.equal(detailFirst(view, TOOLVIEW_DETAIL_KEYS.message), "peer-1");
    assert.equal(JSON.stringify(view).includes("body never renders"), false);
  });

  it("omits priority:false and maps unknown-target to the dispatcher fence", () => {
    const view = assertDetail(
      describeToolview(SEND_PEER_TOOL, {
        args: { to_session: "ghost-session", text: "…", priority: false },
        result: { ok: false, reason: "unknown-target", detail: "…" },
      }),
    );
    assert.deepEqual(factsOf(view), []);
    assert.equal(
      primaryOf(view),
      "Couldn't send to dispatcher ghost-session — no dispatcher with that id in this chat. Nothing was sent.",
    );
    assert.doesNotMatch(primaryOf(view), /another dispatcher/);
  });
});

describe("toolview — message_agent", () => {
  it("renders the target title, the lane fact, and omits priority:false", () => {
    const view = assertDetail(
      describeToolview(MESSAGE_AGENT_TOOL, {
        args: {
          target: "worker-7",
          text: "(body never renders on the row)",
          priority: false,
        },
        result: {
          ok: true,
          target: "worker-7",
          delivered_as: "steer",
          message_id: "msg-1",
        },
      }),
    );
    assert.equal(primaryOf(view), "Message sent to worker 7");
    assert.deepEqual(factsOf(view), ["in the worker lane"]);
    assert.equal(detailFirst(view, TOOLVIEW_DETAIL_KEYS.message), "msg-1");
    assert.equal(detailFirst(view, TOOLVIEW_DETAIL_KEYS.mode), "steer");
    assert.equal(JSON.stringify(view).includes("body never renders"), false);
  });

  it("uses the adapter display title and kind for a dispatcher target", () => {
    const view = assertDetail(
      describeToolview(MESSAGE_AGENT_TOOL, {
        args: { target: "session-d5c7e1f0-1111-2222-3333-4444555593a7" },
        result: {
          ok: true,
          target: "session-d5c7e1f0-1111-2222-3333-4444555593a7",
          delivered_as: "peer",
          message_id: "msg-2",
          display: {
            subject: {
              kind: "dispatcher",
              id: "session-d5c7e1f0-1111-2222-3333-4444555593a7",
              title: "Auth lead",
            },
          },
        },
      }),
    );
    assert.equal(primaryOf(view), "Message sent to Auth lead");
    assert.deepEqual(factsOf(view), ["in the peer lane"]);
    assert.equal(
      detailFirst(view, TOOLVIEW_DETAIL_KEYS.target),
      "session-d5c7e1f0-1111-2222-3333-4444555593a7",
    );
  });

  it("degrades an old transcript to an agent short ref and maps the fence", () => {
    const view = assertDetail(
      describeToolview(MESSAGE_AGENT_TOOL, {
        args: { target: "ghost", text: "…" },
        result: { ok: false, reason: "unknown-target", detail: "…" },
      }),
    );
    assert.equal(
      primaryOf(view),
      "Couldn't message agent ghost — no agent with that id in this chat. Nothing was sent.",
    );
    assert.doesNotMatch(primaryOf(view), /another dispatcher/);
  });

  it("degrades a wrong-typed target instead of rendering a junk row", () => {
    assert.equal(
      describeToolview(MESSAGE_AGENT_TOOL, {
        args: { target: 42 },
        result: { ok: "yes", delivered_as: true },
      }).kind,
      "degraded",
    );
  });
});

describe("toolview — await_agent (historical parser)", () => {
  it("is about wait state only: never echoes a result excerpt", () => {
    const view = assertDetail(
      describeToolview(AWAIT_AGENT_TOOL, {
        args: { target: "worker-3", timeout_ms: 30000 },
        result: {
          ok: true,
          status: "settled",
          target: "worker-3",
          worker_status: "completed",
          result: "(this report must never reach the row)",
          settled_at_ms: 1_700_000_000_000,
          waited_ms: 1200,
          summary: "…",
        },
      }),
    );
    assert.equal(view.state, "done");
    assert.equal(primaryOf(view), "worker 3 finished");
    assert.deepEqual(factsOf(view), ["waited 1s"]);
    assert.equal(JSON.stringify(view).includes("this report"), false);
    assert.equal(
      detailFirst(view, TOOLVIEW_DETAIL_KEYS.status),
      "settled",
    );
    assert.equal(
      detailFirst(view, TOOLVIEW_DETAIL_KEYS.mode),
      "completed",
    );
    assert.equal(
      detailFirst(view, TOOLVIEW_DETAIL_KEYS.settled),
      "1700000000000",
    );
  });

  it("maps terminal worker statuses onto done / failed / stopped", () => {
    const statuses = [
      ["completed", "done"],
      ["error", "failed"],
      ["aborted", "stopped"],
    ] as const;
    for (const [workerStatus, state] of statuses) {
      const view = assertDetail(
        describeToolview(AWAIT_AGENT_TOOL, {
          args: { target: "worker-3" },
          result: {
            ok: true,
            status: "settled",
            target: "worker-3",
            worker_status: workerStatus,
            result: "…",
            waited_ms: 0,
          },
        }),
      );
      assert.equal(view.state, state, workerStatus);
    }
  });

  it("names the racer and keeps the worker-running fact for a released wait", () => {
    const view = assertDetail(
      describeToolview(AWAIT_AGENT_TOOL, {
        args: { target: "worker-3" },
        result: {
          ok: true,
          status: "released",
          target: "worker-3",
          reason: "user-message",
          waited_ms: 500,
        },
      }),
    );
    assert.equal(view.state, "stopped");
    assert.equal(primaryOf(view), "Stopped waiting for worker 3");
    assert.deepEqual(factsOf(view), [
      "you said something",
      "the worker keeps running",
    ]);
  });

  it("renders still-running and gone as their own sentences", () => {
    const working = assertDetail(
      describeToolview(AWAIT_AGENT_TOOL, {
        args: { target: "worker-3" },
        result: {
          ok: true,
          status: "still-running",
          target: "worker-3",
          waited_ms: 30000,
        },
      }),
    );
    assert.equal(working.state, "working");
    assert.equal(primaryOf(working), "worker 3 is still running");

    const gone = assertDetail(
      describeToolview(AWAIT_AGENT_TOOL, {
        args: { target: "worker-3" },
        result: { ok: true, status: "gone", target: "worker-3", waited_ms: 0 },
      }),
    );
    assert.equal(gone.state, "failed");
    assert.equal(primaryOf(gone), "No result for worker 3 — it is gone");
  });

  it("maps not-awaitable to the peer explanation", () => {
    const view = assertDetail(
      describeToolview(AWAIT_AGENT_TOOL, {
        args: { target: "dispatcher-b" },
        result: {
          ok: false,
          reason: "not-awaitable",
          detail: "Dispatchers are peers and cannot be awaited.",
        },
      }),
    );
    assert.equal(
      primaryOf(view),
      "Couldn't wait for dispatcher b — a dispatcher is a peer, not a worker.",
    );
  });

  it("degrades a wrong-typed status instead of rendering a junk row", () => {
    assert.equal(
      describeToolview(AWAIT_AGENT_TOOL, {
        args: { target: 42 },
        result: { ok: true, status: 7, target: {} },
      }).kind,
      "degraded",
    );
  });
});

describe("toolview — spawn_dispatcher", () => {
  it("leads with Summoned \"title\" and puts the session id in details", () => {
    const view = assertDetail(
      describeToolview(SPAWN_DISPATCHER_TOOL, {
        args: {
          title: "Own the auth migration",
          prompt: "(handoff prompt never renders on the row)",
        },
        result: {
          ok: true,
          dispatcher_id: "sess_child",
          title: "Own the auth migration",
        },
      }),
    );
    assert.equal(view.state, "starting");
    assert.equal(primaryOf(view), 'Summoned "Own the auth migration"');
    assert.deepEqual(factsOf(view), ["dispatcher sess_child"]);
    assert.equal(
      detailFirst(view, TOOLVIEW_DETAIL_KEYS.dispatcher),
      "sess_child",
    );
    assert.equal(JSON.stringify(view).includes("handoff prompt"), false);
  });

  it("renders the args-only pending call and a host refusal", () => {
    const before = assertDetail(
      describeToolview(SPAWN_DISPATCHER_TOOL, {
        args: { title: "Own the auth migration", prompt: "…" },
        result: null,
      }),
    );
    assert.equal(primaryOf(before), 'Summoning "Own the auth migration"');
    assert.equal(before.causeKey, null);

    const refused = assertDetail(
      describeToolview(SPAWN_DISPATCHER_TOOL, {
        args: { title: "Too deep", prompt: "…" },
        result: { ok: false, reason: "host-refused", detail: "maxDepth reached" },
      }),
    );
    assert.equal(
      primaryOf(refused),
      "Couldn't summon \"Too deep\" — the host refused to start it. Nothing was started.",
    );
    assert.equal(
      detailFirst(refused, TOOLVIEW_DETAIL_KEYS.reason),
      "host-refused",
    );
  });

  it("degrades a wrong-typed dispatcher id instead of rendering a junk row", () => {
    assert.equal(
      describeToolview(SPAWN_DISPATCHER_TOOL, {
        args: { title: 9 },
        result: { ok: "yes", dispatcher_id: ["sess"], title: null },
      }).kind,
      "degraded",
    );
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

  for (const toolName of TOOLVIEW_TOOL_NAMES) {
    it(`degrades safely instead of throwing for ${toolName}`, () => {
      for (const [name, props] of nasty) {
        let view: ToolviewModel | undefined;
        assert.doesNotThrow(() => {
          view = describeToolview(toolName, props);
        }, `${name} threw`);
        assert.ok(view, "parser always returns a model");
        assert.ok(
          view.kind === "degraded" || view.kind === "detail",
          `${name}: model is a valid variant`,
        );
      }
    });
  }
});

describe("toolview — refusal cause mapping is total and human", () => {
  it("maps every reason enum to a dictionary key", () => {
    const cases: Array<[string, string, string]> = [
      [SPAWN_WORKER_TOOL, "duplicate-stream-key", "toolview.cause.duplicate-stream-key"],
      [SPAWN_WORKER_TOOL, "unknown-todo-id", "toolview.cause.unknown-todo-id"],
      [SPAWN_WORKER_TOOL, "todo-already-linked", "toolview.cause.todo-already-linked"],
      [CHECK_WORKERS_TOOL, "unknown-worker", "toolview.cause.unknown-worker"],
      [STEER_WORKER_TOOL, "unknown-worker", "toolview.cause.unknown-worker"],
      [STEER_WORKER_TOOL, "not-running", "toolview.cause.not-running"],
      [STOP_WORKER_TOOL, "already-settled", "toolview.cause.already-settled"],
      [DELIVER_RESULT_TOOL, "unknown-target", "toolview.cause.unknown-todo"],
      [DELIVER_RESULT_TOOL, "no-delivery-channel", "toolview.cause.no-delivery-channel"],
      [MESSAGE_AGENT_TOOL, "unknown-target", "toolview.cause.unknown-agent"],
      [MESSAGE_AGENT_TOOL, "self-target", "toolview.cause.self-target"],
      [MESSAGE_AGENT_TOOL, "not-running", "toolview.cause.not-running"],
      [MESSAGE_AGENT_TOOL, "inbox-full", "toolview.cause.inbox-full"],
      [MESSAGE_AGENT_TOOL, "rate-limited", "toolview.cause.rate-limited"],
      [MESSAGE_AGENT_TOOL, "invalid-envelope", "toolview.cause.invalid-envelope"],
      [AWAIT_AGENT_TOOL, "unknown-target", "toolview.cause.unknown-worker"],
      [AWAIT_AGENT_TOOL, "self-target", "toolview.cause.self-target"],
      [AWAIT_AGENT_TOOL, "not-awaitable", "toolview.cause.not-awaitable"],
      [AWAIT_AGENT_TOOL, "too-many-waits", "toolview.cause.too-many-waits"],
      [AWAIT_AGENT_TOOL, "invalid-timeout", "toolview.cause.invalid-timeout"],
      [SPAWN_DISPATCHER_TOOL, "invalid-args", "toolview.cause.invalid-args"],
      [SPAWN_DISPATCHER_TOOL, "host-refused", "toolview.cause.host-refused"],
      [SEND_PEER_TOOL, "unknown-target", "toolview.cause.unknown-dispatcher"],
      [SEND_PEER_TOOL, "self-target", "toolview.cause.self-target"],
      [SEND_PEER_TOOL, "inbox-full", "toolview.cause.inbox-full"],
      [SEND_PEER_TOOL, "message-id-reuse", "toolview.cause.message-id-reuse"],
      [SEND_PEER_TOOL, "invalid-envelope", "toolview.cause.invalid-envelope"],
    ];
    for (const [tool, reason, key] of cases) {
      assert.equal(refusalCauseKey(tool, reason), key, `${tool}/${reason}`);
      assert.equal(typeof EN[key], "string", `missing copy ${key}`);
      assert.notEqual(EN[key], "", `empty copy ${key}`);
    }
    // Unknown enums still get an honest generic phrase, never a raw enum.
    assert.equal(refusalCauseKey(STEER_WORKER_TOOL, "brand-new"), "toolview.cause.failed");
    assert.equal(refusalCauseKey(STEER_WORKER_TOOL, null), null);
  });
});

describe("toolview — apply() registers one keyed entry per tool via the fake seam", () => {
  it("registers one keyed toolview entry per claimed wire name", () => {
    const ctx = createClientCtx();
    apply(ctx);
    assert.equal(ctx.injects.length, 3);
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
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));
  });
});

describe("toolview — rendered anatomy (static markup)", () => {
  function renderToolview(toolName: string, props: unknown): string {
    const Component = createToolviewComponent(toolName, t);
    return renderToStaticMarkup(createElement(Component, props));
  }

  /** The row's visible text WITHOUT the nested Details area. */
  function visibleText(markup: string): string {
    return markup
      .replace(/<style>[\s\S]*?<\/style>/g, "")
      .replace(/<details\b[\s\S]*?<\/details>/g, "")
      .replace(/<\/?(?:div|ul|li|span)\b[^>]*>/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  function detailsText(markup: string): string {
    return (markup.match(/<details\b[\s\S]*?<\/details>/g) ?? [])
      .join(" ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  const spawnCall = {
    phase: "result",
    block: {
      kind: "tool-result",
      callId: "c-169",
      name: SPAWN_WORKER_TOOL,
      args: { stream_key: "launcher-staleness-guard" },
      call: null,
      content: [{ type: "text", text: "ok" }],
      isError: false,
      meta: {
        ok: true,
        worker_id: "063f41a2-9897-4936-95de-1cd3f2f76132",
        title: "Add stale-build guards to both launchers",
        stream_key: "launcher-staleness-guard",
      },
    },
  };

  it("renders one primary sentence, facts, then a nested Details dl", () => {
    const markup = renderToolview(SPAWN_WORKER_TOOL, spawnCall);
    assert.ok(markup.includes(`.${TOOLVIEW_CLASS}__primary{`), "stylesheet rendered");
    assert.match(
      markup,
      /<div class="multitask-dispatcher-toolview__primary">Started &quot;Add stale-build guards to both launchers&quot;<\/div>/,
    );
    assert.match(
      markup,
      /<div class="multitask-dispatcher-toolview__facts">worker …6132<\/div>/,
    );
    assert.match(
      markup,
      /<details class="multitask-dispatcher-toolview__details"><summary>Details<\/summary><dl>/,
    );
    // The full id and stream key live ONLY in details.
    assert.equal(visibleText(markup).includes("063f41a2-9897"), false);
    assert.equal(visibleText(markup).includes("launcher-staleness-guard"), false);
    assert.ok(detailsText(markup).includes("063f41a2-9897-4936-95de-1cd3f2f76132"));
    assert.ok(detailsText(markup).includes("launcher-staleness-guard"));
    // No field-label/value pairs survive the old anatomy.
    assert.equal(markup.includes("data-field-label"), false);
    assert.equal(markup.includes("data-field-value"), false);
  });

  it("renders the check row title → status → facts → activity → short ref", () => {
    const markup = renderToolview(CHECK_WORKERS_TOOL, {
      args: {},
      result: {
        ok: true,
        rows: [
          {
            worker_id: "063f41a2-9897-4936-95de-1cd3f2f76132",
            title: "Add stale-build guards to both launchers",
            status: "completed",
            elapsed_ms: 252_000,
            tool_call_count: 7,
            recent_activity: "wrote two launcher guards",
            stream_key: "t-2",
            transcript_ref: "sess_abc",
          },
        ],
      },
    });
    const visible = visibleText(markup);
    assert.match(visible, /^Checked 1 worker /);
    assert.match(
      visible,
      /Add stale-build guards to both launchers Done 4m 12s · 7 tool calls wrote two launcher guards worker …6132$/,
    );
    // Raw status is the data attribute; the word is localized.
    assert.match(markup, /data-status="completed"/);
    assert.match(markup, />Done</);
    assert.equal((visible.match(/Done/g) ?? []).length, 1, "status never duplicates");
    assert.equal(visible.includes("completed"), false, "raw enum never renders");
  });

  it("renders plural counts from copy (1 tool call / 2 tool calls)", () => {
    const one = renderToolview(CHECK_WORKERS_TOOL, {
      args: {},
      result: { ok: true, rows: [checkRow({ tool_call_count: 1 })] },
    });
    assert.match(visibleText(one), /1 tool call\b/);
    const two = renderToolview(CHECK_WORKERS_TOOL, {
      args: {},
      result: { ok: true, rows: [checkRow({ tool_call_count: 2 })] },
    });
    assert.match(visibleText(two), /2 tool calls\b/);
  });

  it("the reported paste style can no longer appear (message_agent)", () => {
    const markup = renderToolview(MESSAGE_AGENT_TOOL, {
      args: {
        target: "063f41a2-9897-4936-95de-1cd3f2f76132",
        text: "…",
        priority: false,
      },
      result: {
        ok: true,
        target: "063f41a2-9897-4936-95de-1cd3f2f76132",
        delivered_as: "peer",
        message_id: "msg-1",
      },
    });
    const visible = visibleText(markup);
    assert.doesNotMatch(visible, /\bAgent\b/);
    assert.doesNotMatch(visible, /Delivered as/);
    assert.doesNotMatch(visible, /\bOutcome\b/);
    assert.doesNotMatch(visible, /063f41a2-9897/);
    assert.doesNotMatch(visible, /\btrue\b|\bfalse\b/);
    // The UUID is allowed in details.
    assert.ok(detailsText(markup).includes("063f41a2-9897-4936-95de-1cd3f2f76132"));
  });

  it("the reported paste style can no longer appear (deliver_result)", () => {
    const markup = renderToolview(DELIVER_RESULT_TOOL, {
      args: { text: "…", todo_id: "todo-7" },
      result: { ok: true, delivered: true, todo_completed: "todo-7" },
    });
    const visible = visibleText(markup);
    assert.doesNotMatch(visible, /Delivered true/);
    assert.doesNotMatch(visible, /\bTodo\b/);
    assert.doesNotMatch(visible, /\bOutcome\b/);
    assert.doesNotMatch(visible, /\btrue\b|\bfalse\b/);
    assert.match(visible, /Delivered to you/);
    assert.match(visible, /todo 7 completed/);
  });

  it("the degraded row still renders its honest line", () => {
    const markup = renderToolview(SPAWN_WORKER_TOOL, { phase: "result", block: null });
    assert.equal(
      markup
        .replace(/<style>[\s\S]*?<\/style>/g, "")
        .replace(/<[^>]*>/g, "")
        .trim(),
      EN["toolview.degraded"],
    );
  });

  it("every claimed tool renders a primary sentence and no legacy field pairs", () => {
    const payloads: Record<string, unknown> = {
      [SPAWN_WORKER_TOOL]: spawnCall,
      [CHECK_WORKERS_TOOL]: {
        args: {},
        result: { ok: true, rows: [] },
      },
      [STEER_WORKER_TOOL]: {
        args: { worker_id: "w-1", message: "check the logs" },
        result: { ok: true, worker_id: "w-1", title: "Worker one" },
      },
      [STOP_WORKER_TOOL]: {
        args: { worker_id: "w-1" },
        result: { ok: true, worker_id: "w-1", title: "Worker one", mode: "stopped" },
      },
      [DELIVER_RESULT_TOOL]: {
        args: { todo_id: "t-2", attachment_paths: ["a"] },
        result: { ok: true, delivered: true, todo_completed: "t-2" },
      },
      [MESSAGE_AGENT_TOOL]: {
        args: { target: "w-1", priority: true },
        result: {
          ok: true,
          target: "w-1",
          delivered_as: "steer",
          message_id: "msg-1",
        },
      },
      [AWAIT_AGENT_TOOL]: {
        args: { target: "w-1" },
        result: {
          ok: true,
          target: "w-1",
          status: "settled",
          worker_status: "completed",
          waited_ms: 1,
        },
      },
      [SPAWN_DISPATCHER_TOOL]: {
        args: { title: "second chair" },
        result: { ok: true, dispatcher_id: "d-1", title: "second chair" },
      },
      [SEND_PEER_TOOL]: {
        args: { to_session: "s-2", priority: false },
        result: { ok: true, to_session: "s-2", message_id: "m-1" },
      },
    };
    assert.deepEqual(
      Object.keys(payloads).sort(),
      [...TOOLVIEW_TOOL_NAMES].sort(),
      "the fixture set drifted from the claimed keys",
    );
    for (const toolName of TOOLVIEW_TOOL_NAMES) {
      const markup = renderToolview(toolName, payloads[toolName]);
      const primary = markup.match(
        /multitask-dispatcher-toolview__primary">([^<]*)</,
      )?.[1];
      assert.ok(primary, `${toolName} rendered no primary sentence`);
      assert.ok(primary.length > 0, `${toolName} rendered a blank primary`);
      assert.notEqual(primary, primary.toUpperCase(), `${toolName}: unresolved key`);
      assert.equal(primary.includes("toolview."), false, `${toolName}: primary key did not resolve`);
      assert.equal(primary.includes("status."), false, `${toolName}: status key did not resolve`);
      const visible = visibleText(markup);
      assert.equal(visible.includes("toolview."), false, `${toolName}: a fact/detail key did not resolve`);
      assert.equal(markup.includes("data-field-label"), false, `${toolName}: legacy field anatomy`);
      assert.match(
        markup,
        /multitask-dispatcher-toolview__details/,
        `${toolName}: no details area`,
      );
    }
  });

  it("the stylesheet defines the new anatomy with a gap and block layout", () => {
    assert.ok(TOOLVIEW_CSS.trim().length > 0, "row stylesheet is empty");
    assert.match(TOOLVIEW_CSS, /__primary\{[^}]*font-weight/);
    assert.match(TOOLVIEW_CSS, /__facts\{[^}]*overflow-wrap/);
    assert.match(TOOLVIEW_CSS, /__details dl\{[^}]*grid/);
    assert.match(TOOLVIEW_CSS, /__row\{[^}]*display:flex/);
    assert.match(TOOLVIEW_CSS, /__row\{[^}]*gap:/);
  });
});
