/**
 * Tickets 21 + 27 + 41 — roster snapshot projection + settings-namespace
 * data path (host half; design-16 §4.2, design-17 §4.1/§6).
 *
 * Offline only (S8): FakeDshHost + createMultitask with the roster observer,
 * pure projection/parse/staleness checks (v3 wire contract; v1/v2 rejected
 * fail-closed), the deliverables-line excerpt (bounded, most-recent,
 * cleared at the delivered transition), the settings-owner-scope channel,
 * and the real plugin apply() publishing through a fake settings provider
 * on activation and on roster-affecting transitions (now including
 * access-ask park). No network, no LLM, no running dsh.
 *
 * Fake-vs-host (ticket 91): the settings-provider fake's `commands.register`
 * and `tools.register` throw on a duplicate name with the shipped wording
 * (`@deepseek-ai/dsh-commands/lib/index.js:82`,
 * `@deepseek-ai/dsh-tools/lib/index.js:2538`).
 *
 * Fake-vs-host (ticket 93): the settings-provider fake models the shipped
 * scope contract — `register(ns, schema, options?)` returns the owner scope
 * (`@deepseek-ai/dsh-settings/lib/index.js:281-315`) while
 * `installSection(...)` returns VOID (`:327-343`;
 * `lib/types/index.d.ts:228`) — the shape whose absence starved this channel
 * live (zero `roster.*` keys).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import {
  createMultitask,
  type MultitaskOptions,
} from "../src/core/multitask.js";
import { createInMemoryDurability } from "../src/core/durability.js";
import { RECENT_RESULT_EXCERPT_CHARS } from "../src/core/report-clamp.js";
import {ROSTER_SETTINGS_KEY, ROSTER_SNAPSHOT_SCHEMA_VERSION, ROSTER_STALE_WINDOW_MS, isRosterSnapshotStale, parseRosterSnapshot, projectRosterSnapshot, type RosterSnapshot} from "../src/core/roster-snapshot.js";
import {sessionOfRosterKey} from "../src/adapter/roster-channel.js";
import {
  DISPATCHER_START_COMMAND,
  type AdapterContext,
  type AgentLike,
  type ToolsLike,
} from "../src/adapter/index.js";
import { apply as pluginApply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";

function makeCore(
  observer?: (sessionId: string) => void,
  durability: ReturnType<typeof createInMemoryDurability> = createInMemoryDurability(),
) {
  const host = new FakeDshHost();
  const multitask = createMultitask(host, {
    durability,
    ...(observer === undefined ? {} : { onRosterChanged: observer }),
  });
  return { host, durability, multitask };
}

describe("roster snapshot — projection is a pure core projection (ticket 21)", () => {
  it("projects the presence row: id, title, FSM status, todo link, clock, count, delivered", async () => {
    const { host, multitask } = makeCore();
    const todo = multitask.createTodo({
      sessionId: "s-1",
      title: "Write the parser",
    });
    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "stream-a",
      title: "Parser worker",
      prompt: "do things",
      todoId: todo.id,
    });
    assert.equal(spawn.ok, true);
    const workerId = spawn.ok ? spawn.workerId : "";
    const summary = multitask.listWorkers("s-1")[0];
    assert.ok(summary);
    const snapshot = projectRosterSnapshot(
      "s-1",
      multitask.listWorkers("s-1"),
      1_000,
      { todos: multitask.listTodos("s-1") },
    );
    assert.equal(snapshot.schemaVersion, ROSTER_SNAPSHOT_SCHEMA_VERSION);
    assert.equal(snapshot.dispatcherSessionId, "s-1");
    assert.equal(snapshot.publishedAtMs, 1_000);
    assert.equal(snapshot.workers.length, 1);
    assert.deepEqual(snapshot.workers[0], {
      kind: "worker",
      workerId,
      title: "Parser worker",
      status: "spawned",
      todoId: todo.id,
      startedAtMs: summary.startedAtMs,
      toolCallCount: 0,
      // Linked todo exists and has not been delivered — landed marker fuel.
      delivered: false,
    });
  });

});

describe("roster snapshot — v2 presence fields join existing core truth (ticket 27)", () => {
  it("delivered follows the ledger: no todo → true; linked todo → false until markDelivered", async () => {
    const { host, multitask } = makeCore();
    const todo = multitask.createTodo({ sessionId: "s-1", title: "T" });
    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
      todoId: todo.id,
    });
    const workerId = spawn.ok ? spawn.workerId : "";
    host.fireSettled({ workerId, status: "completed", report: "done" });

    const sources = () => ({ todos: multitask.listTodos("s-1") });
    const before = projectRosterSnapshot(
      "s-1",
      multitask.listWorkers("s-1"),
      1_000,
      sources(),
    );
    assert.equal(before.workers[0]?.delivered, false);

    assert.equal(multitask.markDelivered(todo.id), true);
    const after = projectRosterSnapshot(
      "s-1",
      multitask.listWorkers("s-1"),
      1_000,
      sources(),
    );
    assert.equal(after.workers[0]?.delivered, true);
  });

});

describe("roster snapshot — core observer fires on roster-affecting transitions", () => {
  it("fires on spawn, first turn, steer transitions, settle, abort, reconcile, drain", async () => {
    const seen: string[] = [];
    const { host, multitask } = makeCore((sessionId) => seen.push(sessionId));

    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
    });
    assert.equal(spawn.ok, true);
    const workerId = spawn.ok ? spawn.workerId : "";

    multitask.noteTurnStarted(workerId); // spawned → running
    multitask.noteSteerReceived(workerId); // running → steering
    multitask.noteSteerInjected(workerId); // steering → running
    host.fireSettled({
      workerId,
      status: "completed",
      report: "done",
      transcriptRef: workerId,
    });
    // The plugin no longer enqueues a settle wake: the host's stock completion
    // notice opens the parent turn, and this rig has no notice. Feed the bus
    // directly (its API is kept for redrive/external-job wakes) so the drain
    // below still has a wake to observe.
    multitask.wakeBus.enqueueWorkerSettled({
      parentSessionId: "s-1",
      workerId,
      status: "completed",
      title: "T",
      resultText: "done",
    });
    multitask.reconcileTodos("s-1");
    multitask.drainWake("s-1");

    // Every accepted transition above notified exactly once, session-scoped.
    assert.deepEqual(seen, [
      "s-1", // spawn
      "s-1", // turn started
      "s-1", // steer received
      "s-1", // steer injected
      "s-1", // settle
      "s-1", // reconcile
      "s-1", // drain
    ]);
    assert.equal(multitask.getWorker(workerId)?.status, "completed");
  });

  it("fires on accepted abort but not on refused/reflected transitions", async () => {
    const seen: string[] = [];
    const { host, multitask } = makeCore((sessionId) => seen.push(sessionId));

    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-9",
      streamKey: "k",
      title: "T",
      prompt: "P",
    });
    const workerId = spawn.ok ? spawn.workerId : "";
    const before = seen.length;

    multitask.noteTurnStarted("unknown-worker"); // ignored: no notify
    multitask.noteTurnStarted(workerId);
    multitask.noteTurnStarted(workerId); // illegal second time: no notify
    assert.equal(seen.length - before, 1);

    const abort = await multitask.abortWorker(workerId);
    assert.equal(abort.ok, true);
    assert.deepEqual(seen.at(-1), "s-9");

    // Post-abort settle is dropped (never revive): no further notification.
    host.fireSettled({ workerId, status: "completed", report: "late" });
    assert.equal(seen.at(-1), "s-9");
  });

  it("rebuild notifies only when terminal workers are restored onto the roster", async () => {
    const seen: string[] = [];
    // Construct markers directly to control restored vs unknown-state.
    const durability = createInMemoryDurability();
    durability.writeWorkerMarker({
      workerId: "w-done",
      parentSessionId: "s-1",
      streamKey: "done-k",
      title: "Done",
      status: "completed",
      transcriptRef: "w-done",
      todoId: null,
      startedAtMs: 1,
      updatedAtMs: 2,
    });
    durability.writeWorkerMarker({
      workerId: "w-live",
      parentSessionId: "s-1",
      streamKey: "live-k",
      title: "Live",
      status: "running",
      transcriptRef: null,
      todoId: null,
      startedAtMs: 1,
      updatedAtMs: 2,
    });
    const { multitask } = makeCore(
      (sessionId) => seen.push(sessionId),
      durability,
    );
    const report = await multitask.rebuildFromDurability("s-1");
    assert.equal(report.restored.length, 1);
    assert.equal(report.unknownState.length, 1);
    // Unknown-state rows never land on the roster: exactly one notification.
    assert.deepEqual(seen, ["s-1"]);
    assert.equal(multitask.getWorker("w-live"), undefined);
    assert.equal(multitask.getWorker("w-done")?.status, "completed");
  });

});

describe("roster snapshot — deliverables excerpt (ticket 41, schema v3)", () => {
  const landedRow = {
    workerId: "w-1",
    parentSessionId: "s-1",
    streamKey: "k",
    title: "Parser worker",
    status: "completed" as const,
    startedAtMs: 10,
    elapsedMs: 0,
    toolCallCount: 1,
    transcriptRef: null,
    todoId: "todo-1",
  };
  const landedTodo = {
    id: "todo-1",
    sessionId: "s-1",
    title: "T",
    status: "in_progress" as const,
    streamKey: "k",
    workerId: "w-1",
    delivered: false,
    redriveAttempts: 0,
    disposition: null,
    dispositionReason: null,
    external: null,
    createdAtMs: 0,
    updatedAtMs: 0,
  };

  it("projects the settled-undelivered worker's excerpt through the seat", () => {
    const snapshot = projectRosterSnapshot(
      "s-1",
      [landedRow],
      1_000,
      { todos: [landedTodo], recentResultOf: () => ({ text: "All done.", settledAtMs: 500 }) },
    );
    assert.deepEqual(snapshot.recentResult, {
      workerId: "w-1",
      title: "Parser worker",
      text: "All done.",
    });
    // And the excerpt survives the defensive parse unchanged.
    assert.deepEqual(parseRosterSnapshot(snapshot)?.recentResult, snapshot.recentResult);
  });

  it("picks the MOST RECENTLY SETTLED landed worker, not the first roster row", () => {
    const early = { ...landedRow, workerId: "w-early", todoId: "todo-e" };
    const late = {
      ...landedRow,
      workerId: "w-late",
      title: "Later worker",
      todoId: "todo-l",
    };
    const snapshot = projectRosterSnapshot(
      "s-1",
      [early, late],
      1_000,
      {
        todos: [
          { ...landedTodo, id: "todo-e", workerId: "w-early", delivered: false },
          { ...landedTodo, id: "todo-l", workerId: "w-late", delivered: false },
        ],
        recentResultOf: (workerId) =>
          workerId === "w-early"
            ? { text: "early report", settledAtMs: 100 }
            : { text: "late report", settledAtMs: 900 },
      },
    );
    assert.equal(snapshot.recentResult?.workerId, "w-late");
    assert.equal(snapshot.recentResult?.text, "late report");
  });

  it("clamps an over-long report to the shared excerpt bound (ellipsis included)", () => {
    const snapshot = projectRosterSnapshot(
      "s-1",
      [landedRow],
      1_000,
      {
        todos: [landedTodo],
        recentResultOf: () => ({
          text: "x".repeat(RECENT_RESULT_EXCERPT_CHARS + 500),
          settledAtMs: 500,
        }),
      },
    );
    assert.equal(snapshot.recentResult?.text.length, RECENT_RESULT_EXCERPT_CHARS);
    assert.ok(snapshot.recentResult?.text.endsWith("…"));
  });

  it("never speaks for delivered rows or workers still running", () => {
    const delivered = projectRosterSnapshot(
      "s-1",
      [landedRow],
      1_000,
      {
        // The delivered flip: same row, ledger says delivered.
        todos: [{ ...landedTodo, delivered: true }],
        recentResultOf: () => ({ text: "All done.", settledAtMs: 500 }),
      },
    );
    assert.equal(delivered.recentResult, null, "delivered transition clears the line");

    const running = projectRosterSnapshot(
      "s-1",
      [{ ...landedRow, status: "running" as const }],
      1_000,
      {
        todos: [landedTodo],
        recentResultOf: () => ({ text: "All done.", settledAtMs: 500 }),
      },
    );
    assert.equal(running.recentResult, null);
  });

  it("parse fail-closed matrix: v1 AND v2 payloads, missing/malformed/unbounded excerpts all fail to null", () => {
    const valid = projectRosterSnapshot("s-1", [], 1_000);
    assert.equal(valid.recentResult, null);

    // The version rule design-17 §4.1 accepted for v1→v2 applies unchanged
    // to v2→v3: old payloads fail the whole snapshot, the panel degrades.
    const v2 = { ...valid, schemaVersion: 2 };
    assert.equal(parseRosterSnapshot(v1Payload()), null, "v1 fails parse");
    assert.equal(parseRosterSnapshot(v2), null, "v2 fails parse under v3");

    // The field must EXIST on a v3 envelope — the projection always writes it.
    const missing = { ...valid } as Record<string, unknown>;
    delete missing.recentResult;
    assert.equal(parseRosterSnapshot(missing), null, "missing key fails closed");

    const malformed: unknown[] = [
      "done",
      42,
      {},
      { workerId: "", title: "T", text: "x" },
      { workerId: "w-1", title: 7, text: "x" },
      { workerId: "w-1", title: "T" },
      { workerId: "w-1", title: "T", text: "" },
      { workerId: "w-1", title: "T", text: "y".repeat(RECENT_RESULT_EXCERPT_CHARS + 1) },
    ];
    for (const recentResult of malformed) {
      assert.equal(
        parseRosterSnapshot({ ...valid, recentResult }),
        null,
        `malformed recentResult must fail the whole snapshot: ${JSON.stringify(recentResult).slice(0, 40)}`,
      );
    }

    // Exactly-at-bound text parses; null stays the valid "nothing owed".
    const atBound = parseRosterSnapshot({
      ...valid,
      recentResult: {
        workerId: "w-1",
        title: "T",
        text: "z".repeat(RECENT_RESULT_EXCERPT_CHARS),
      },
    });
    assert.equal(atBound?.recentResult?.text.length, RECENT_RESULT_EXCERPT_CHARS);
    assert.equal(parseRosterSnapshot({ ...valid, recentResult: null })?.recentResult, null);
  });

  function v1Payload(): unknown {
    return {
      schemaVersion: 1,
      dispatcherSessionId: "s-1",
      publishedAtMs: 1_000,
      workers: [
        { workerId: "w", title: "T", status: "running", todoId: null },
      ],
    };
  }
});

describe("roster snapshot — parse and staleness (v3 wire contract)", () => {
  const valid: RosterSnapshot = projectRosterSnapshot("s-1", [], 1_000);

  it("round-trips a projected v3 snapshot", () => {
    const populated = projectRosterSnapshot(
      "s-1",
      [
        {
          workerId: "w-1",
          parentSessionId: "s-1",
          streamKey: "k",
          title: "T",
          status: "steering",
          startedAtMs: 10,
          elapsedMs: 0,
          toolCallCount: 3,
          transcriptRef: null,
          todoId: "todo-1",
        },
      ],
      1_000,
      {
        todos: [
          {
            id: "todo-1",
            sessionId: "s-1",
            title: "T",
            status: "in_progress",
            streamKey: "k",
            workerId: "w-1",
            delivered: false,
            redriveAttempts: 0,
            disposition: null,
            dispositionReason: null,
            external: null,
            createdAtMs: 0,
            updatedAtMs: 0,
          },
        ],
      },
    );
    assert.deepEqual(parseRosterSnapshot(populated), populated);
  });

  it("rejects a v1 payload cleanly — the panel degrades, never half-renders", () => {
    const v1 = {
      schemaVersion: 1,
      dispatcherSessionId: "s-1",
      publishedAtMs: 1_000,
      workers: [
        { workerId: "w", title: "T", status: "running", todoId: null },
      ],
    };
    assert.equal(parseRosterSnapshot(v1), null, "v1 version bump fails parse");
    // A v1 row grafted into a v2 envelope is still broken: no kind field.
    assert.equal(
      parseRosterSnapshot({ ...valid, workers: v1.workers }),
      null,
    );
  });

  it("rejects wrong shape, version skew, bad clocks, unknown kinds/statuses, and malformed rows", () => {
    assert.equal(parseRosterSnapshot(null), null);
    assert.equal(parseRosterSnapshot("nope"), null);
    assert.equal(
      parseRosterSnapshot({ ...valid, schemaVersion: 99 }),
      null,
      "version skew must fail the whole snapshot honestly",
    );
    assert.equal(
      parseRosterSnapshot({ ...valid, publishedAtMs: Number.NaN }),
      null,
    );
    assert.equal(
      parseRosterSnapshot({ ...valid, dispatcherSessionId: 7 }),
      null,
    );
    assert.equal(parseRosterSnapshot({ ...valid, workers: "no" }), null);
    const v2Row = {
      kind: "worker",
      workerId: "w",
      title: "T",
      status: "running",
      todoId: null,
      startedAtMs: 0,
      toolCallCount: 0,
      delivered: true,
    };
    assert.equal(
      parseRosterSnapshot({
        ...valid,
        workers: [{ ...v2Row, status: "zombie" }],
      }),
      null,
    );
    assert.equal(
      parseRosterSnapshot({
        ...valid,
        workers: [{ ...v2Row, kind: "robot" }],
      }),
      null,
      "unknown producer kind fails closed (conflict 6)",
    );
    assert.equal(
      parseRosterSnapshot({
        ...valid,
        workers: [v2Row],
      })?.workers[0]?.kind,
      "worker",
    );
  });

  it("rejects malformed presence fields (ticket 27 fail-closed)", () => {
    const v2Row = {
      kind: "worker",
      workerId: "w",
      title: "T",
      status: "running",
      todoId: null,
      startedAtMs: 0,
      toolCallCount: 0,
      delivered: true,
    };
    const withRow = (row: Record<string, unknown>) =>
      parseRosterSnapshot({ ...valid, workers: [row] });

    // Clocks and counts must be finite, sane numbers.
    assert.equal(withRow({ ...v2Row, startedAtMs: Number.NaN }), null);
    assert.equal(withRow({ ...v2Row, startedAtMs: Number.POSITIVE_INFINITY }), null);
    assert.equal(withRow({ ...v2Row, startedAtMs: -1 }), null);
    assert.equal(withRow({ ...v2Row, toolCallCount: 1.5 }), null);
    assert.equal(withRow({ ...v2Row, toolCallCount: -3 }), null);
    assert.equal(withRow({ ...v2Row, delivered: "yes" }), null);
  });

  it("rejects a v4 payload — the version bump at ticket 174 fails parse", () => {
    // v4 carried `pendingAsks` and a per-row `blocked`; both are gone in v5,
    // and the version gate is the ONLY thing that must reject the old shape.
    assert.equal(parseRosterSnapshot({ ...valid, schemaVersion: 4 }), null);
    assert.equal(parseRosterSnapshot({ ...valid, schemaVersion: 5 }) !== null, true);
  });

  it("staleness boundary: exactly at the window is fresh, beyond is stale", () => {
    assert.equal(isRosterSnapshotStale(valid, 1_000 + ROSTER_STALE_WINDOW_MS), false);
    assert.equal(
      isRosterSnapshotStale(valid, 1_000 + ROSTER_STALE_WINDOW_MS + 1),
      true,
    );
    assert.equal(isRosterSnapshotStale(valid, 1_000, 500), false);
    assert.equal(isRosterSnapshotStale(valid, 1_501, 500), true);
  });

  it("exposes the settings document key the channel mirrors under", () => {
    assert.equal(ROSTER_SETTINGS_KEY, "roster");
  });
});

describe("roster snapshot — mirror key grammar (0.2.1: no settings channel)", () => {
  // 0.2.1 rejects undeclared settings keys and has no scope-registration API,
  // so the write channel is gone. The client read-sides still parse the key
  // family, so the grammar stays and is pinned here.
  it("only the dotted prefix is a session mirror", () => {
    assert.equal(sessionOfRosterKey("rosterx"), null);
    assert.equal(sessionOfRosterKey(""), null);
    assert.equal(sessionOfRosterKey("roster."), "");
  });
});

/**
 * Fake AdapterContext with a settings provider (the activation-lifecycle
 * idiom plus the roster channel's owner scope). Offline: no Cordis, no dsh.
 */
function createSettingsAwareCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<
    string,
    { handler: (invocation: unknown) => unknown }
  >();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  let nextChild = 1;

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
    }
  };

  const ctx = {
    // Cordis effect contract (ticket 44): `execute` runs at apply; whatever
    // it returns (or a generator yields) is the unload disposer — dropped
    // here because these tests never unload the fiber. Draining the iterator
    // is what runs a generator effect's body (lazy until iterated).
    effect(execute: () => unknown) {
      const result = execute();
      if (
        typeof result === "object" &&
        result !== null &&
        Symbol.iterator in result
      ) {
        for (const step of result as Iterable<unknown>) void step;
      }
    },
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
    },
    commands: {
      register(definition: { name: string; handler: (invocation: unknown) => unknown }) {
        // Shipped rule (ticket 91): duplicate command name throws
        // (dsh-commands lib/index.js:82, NamedEntries factory).
        if (commands.has(definition.name)) {
          throw new Error(
            `command "${definition.name}" is already registered (for a ` +
              `per-agent variant, mount a command-injected plugin under ` +
              `that agent's \`agent.ctx\`)`,
          );
        }
        commands.set(definition.name, definition);
      },
    },
    tools: {
      schemas: () => [...tools.keys()].map((name) => ({ name })),
      register(definition: {
        name: string;
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      }) {
        // Shipped rule (ticket 91): duplicate tool name throws
        // (dsh-tools lib/index.js:2538, NamedEntries factory).
        if (tools.has(definition.name)) {
          throw new Error(
            `tool "${definition.name}" is already registered (for a ` +
              `per-agent variant, register through that agent's ` +
              `\`agent.ctx\` instead)`,
          );
        }
        tools.set(definition.name, definition);
        return () => {
          tools.delete(definition.name);
        };
      },
    },
    subagents: {
      async startActivation() {
        const childId = `child-${nextChild++}`;
        return {
          childId,
          messageId: `msg-${childId}`,
          dispose: async () => {},
        };
      },
      interrupt() {},
      async sendMessage() {
        return "msg-stub";
      },
    },
    agents: { get: () => undefined },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        return {
          table() {
            const t = new Map<string, unknown>();
            return {
              get: (key: string) => t.get(key) as never,
              entries: () => t.entries() as never,
              async put(key: string, value: unknown) {
                t.set(key, value);
              },
              async delete(key: string) {
                return t.delete(key);
              },
            };
          },
          async close() {},
          name: "stub",
        };
      },
    },
    fire,
    listeners,
    tool: (name: string) => tools.get(name),
    runCommand(commandId: string, agent?: AgentLike): unknown {
      const command = commands.get(commandId);
      assert.ok(command, `command not registered: ${commandId}`);
      return command.handler({
        commandId,
        ...(agent === undefined ? {} : { agent }),
      });
    },
  };
  return ctx as typeof ctx & AdapterContext & {
    fire(name: string, payload: unknown): void;
    tool(name: string): { execute: (args: unknown, exec?: unknown) => Promise<unknown> } | undefined;
    runCommand(commandId: string, agent?: AgentLike): unknown;
    readonly listeners: Map<string, unknown[]>;
  };
}

interface ScopedToolSurface extends ToolsLike {
  register(definition: unknown): () => void;
  get(
    name: string,
  ): { execute: (args: unknown, exec?: unknown) => Promise<unknown> } | undefined;
}

/**
 * ADR-0019: every live agent loop mints a scoped tool surface. The plugin
 * refuses the process-global fallback, so the fake agent carries one.
 */
function createScopedTools(): ScopedToolSurface {
  const scoped = new Map<
    string,
    { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  return {
    schemas: () => [...scoped.keys()].map((name) => ({ name })),
    register(definition: unknown) {
      const tool = definition as {
        name: string;
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      };
      if (scoped.has(tool.name)) {
        throw new Error(`tool "${tool.name}" is already registered`);
      }
      scoped.set(tool.name, tool);
      return () => {
        scoped.delete(tool.name);
      };
    },
    get: (name) => scoped.get(name),
  };
}

function topLevelAgent(id: string): AgentLike & {
  readonly scopedTools: ScopedToolSurface;
} {
  const scopedTools = createScopedTools();
  return {
    session: {
      id,
      header: { parentSession: null, delegationDepth: 0 },
    },
    followup() {},
    ctx: { tools: scopedTools },
    scopedTools,
  };
}

/**
 * The child the STOCK `subagent` tool creates: no reserved id, so the host
 * learns it at `agent/created` from the header its provider wrote. The scope
 * records what the host's worker composition applies (persona + barrier).
 */
function stockWorkerChild(parentSessionId: string): {
  agent: AgentLike;
  sections: string[];
  restrictions: Array<{ deny?: readonly string[] }>;
} {
  const sections: string[] = [];
  const restrictions: Array<{ deny?: readonly string[] }> = [];
  const agent = {
    session: {
      id: "stock-child-1",
      header: {
        parentSession: parentSessionId,
        delegationDepth: 1,
        origin: "subagent",
      },
    },
    followup() {},
    ctx: {
      systemPrompt: {
        section(section: { name: string }) {
          sections.push(section.name);
          return () => {};
        },
        getSectionOrder() {
          return 0;
        },
      },
      tools: {
        schemas() {
          return [
            { name: "subagent" },
            { name: "list_agents" },
            { name: "deliver_result" },
            { name: "read" },
          ];
        },
        restrict(filter: { deny?: readonly string[] }) {
          restrictions.push(filter);
          return () => {};
        },
        register() {
          return () => {};
        },
      },
    },
  } as unknown as AgentLike;
  return { agent, sections, restrictions };
}

describe("roster snapshot — no settings-document publish (0.2.1)", () => {
  /**
   * 0.2.1 rejects undeclared settings keys, so the plugin no longer mirrors
   * snapshots into its settings document. The projection itself is still the
   * one roster view (pinned above); these cases pin the removed path's
   * replacement contract: activating and spawning touch no settings scope,
   * and the dispatcher commands still work without one.
   */
  async function flushActivation(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it("activation and a stock worker spawn succeed on a host with no settings service at all", async () => {
    const ctx = createSettingsAwareCtx();
    pluginApply(ctx, volatileConfig({ enabled: true }));

    const agent = topLevelAgent("s-1");
    const result = ctx.runCommand(
      DISPATCHER_START_COMMAND,
      agent,
    ) as { kind: string };
    assert.equal(result.kind, "success");
    await flushActivation();

    // The model-facing spawn is the host's stock `subagent`: model its
    // announcement the way that provider does — `agent/created` with the
    // child header it wrote. The host recognises and adopts it as a worker;
    // no custom spawn tool exists, and no settings namespace is touched.
    const child = stockWorkerChild("s-1");
    ctx.fire("agent/created", { agent: child.agent });

    // Composition is the proof the announcement was adopted: the worker
    // persona section and the tool barrier landed on the child's own scope.
    assert.deepEqual(child.sections, ["deployment:persona-prefix"]);
    assert.equal(child.restrictions.length, 1);
    assert.ok(
      child.restrictions[0]?.deny?.includes("deliver_result"),
      "the child is barriered against the dispatcher surface",
    );
  });

});

// Ticket 91's fail-loud duplicate-registration pin lives in
// test/plugin-scaffold.test.ts: it is one host rule, pinned once.
