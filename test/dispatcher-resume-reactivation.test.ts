/**
 * Ticket 147 — a USER-STARTED (generation-1) dispatcher comes back as a
 * dispatcher after a dsh restart.
 *
 * ## The reported bug
 *
 * The owner's chat was activated with `/dsh-bot`, dsh restarted, and the first
 * request in the reopened chat produced the host's own notice
 * "Tools updated / 10 removed: await_agent, check_workers, deliver_result,
 * message_agent, recall, request_access, spawn_dispatcher, spawn_worker,
 * steer_worker, stop_worker" — the exact activated-dispatcher surface.
 *
 * The activation set lives in memory only (`parent-agent.ts` `sessions` map),
 * the durable `dispatcher_sessions` mark is written only for SPAWNED children
 * (and rejects generation 1), and the `agent/created` listener used to return
 * immediately for a parentless session. So the identity survived the restart
 * (the `sessionKind` projection did) while the tool surface did not.
 *
 * ## What this file pins
 *
 * - A parentless session whose durable `sessionKind` projection says
 *   `"dispatcher"` re-activates on `agent/created`: the 9 scoped tools
 *   (`DISPATCHER_TOOL_SET`) plus the global refcounted `request_access` — the
 *   10 tools whose absence the owner saw — and exactly one policy inject.
 * - The projection is read through the REAL registered unit
 *   (`registerSessionKindProjection`), folding the REAL host command events
 *   (`command/run` + `command/done` for `dsh-bot`) out of the session log, so
 *   the test proves the durable seam rather than a hand-returned boolean.
 * - A normal (non-dispatcher) parentless session resumes DORMANT: no tools, no
 *   policy.
 * - Idempotency: a repeated announcement, and a session already active in this
 *   process, add nothing twice.
 * - Fail-closed: a projection that throws, or a projection that is absent,
 *   activates nothing. A deeper-than-top-level parentless session is not a
 *   chat the user could have activated and is left alone.
 * - No `RESTART_DEGRADED_NOTICE`: the marker store opens cleanly in this
 *   harness (ticket 149's defect is covered by
 *   `test/storage-json-v1-compat.test.ts`), so the resumed activation reports
 *   nothing degraded.
 *
 * Offline only: stub contexts, stub scoped tool registries, real plugin
 * `apply()`, real host, real core.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import {
  DISPATCHER_START_COMMAND,
  SESSION_KIND_PROJECTION_KEY,
  SESSION_KIND_PROJECTION_DEFINITION,
  RESTART_DEGRADED_NOTICE,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
  type SessionProjectionDefinitionLike,
  type SessionKindProjectionState,
  type ToolsLike,
} from "../src/adapter/index.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await tick();
}

/** Text of an injected plugin context message (policy / notice). */
function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

interface ScopedTool {
  name: string;
  execute: (args: unknown, exec?: unknown) => Promise<unknown>;
}

interface ScopedTools extends ToolsLike {
  names(): string[];
}

/** A per-agent scoped tool registry, shaped like the live host's. */
function createScopedTools(): ScopedTools {
  const scoped = new Map<string, ScopedTool>();
  return {
    schemas: () => [...scoped.keys()].map((name) => ({ name })),
    register(definition: unknown) {
      const def = definition as ScopedTool;
      if (scoped.has(def.name)) {
        throw new Error(`tool "${def.name}" is already registered`);
      }
      scoped.set(def.name, def);
      return () => {
        scoped.delete(def.name);
      };
    },
    names: () => [...scoped.keys()],
  };
}

interface StubAgent extends AgentLike {
  readonly injected: unknown[];
  readonly scopedTools: ScopedTools;
}

function createAgent(
  id: string,
  header: { parentSession?: unknown; delegationDepth?: number; origin?: "subagent" } = {},
): StubAgent {
  const injected: unknown[] = [];
  const scopedTools = createScopedTools();
  return {
    session: { id, header },
    injected,
    scopedTools,
    followup() {},
    inject(message: unknown) {
      injected.push(message);
    },
    ctx: { tools: scopedTools },
  };
}

// ── the durable side: a session log plus the REAL projection unit ──────────

interface LoggedEvent {
  readonly type: string;
  readonly data: unknown;
  readonly seq: number;
}

/** The structural `Session` view the projection fold needs. */
interface StubSession {
  readonly id: string;
  readonly header: Record<string, unknown>;
  readonly inheritedEventCount: number;
  readonly events: LoggedEvent[];
  snapshotEvents(): readonly LoggedEvent[];
  eventAt(seq: number): LoggedEvent | undefined;
}

function createSession(id: string, header: Record<string, unknown> = {}): StubSession {
  const events: LoggedEvent[] = [];
  return {
    id,
    header,
    inheritedEventCount: 0,
    events,
    snapshotEvents: () => [...events],
    eventAt: (seq: number) => events[seq],
  };
}

/** Append one committed event, the way the host's log does. */
function appendEvent(
  session: StubSession,
  type: string,
  data: unknown,
): void {
  session.events.push({ type, data, seq: session.events.length });
}

/** The host command's durable pair (dsh-commands appends both). */
function appendDispatcherStart(session: StubSession, commandId: string): void {
  appendEvent(session, "command/run", {
    commandId,
    name: DISPATCHER_START_COMMAND,
    args: "",
    source: "user",
  });
  appendEvent(session, "command/done", { commandId, kind: "success" });
}

/**
 * A projection registry that behaves like the installed one for the parts
 * this ticket touches: `register` is an effect, `stateOf` lazily folds the
 * registered unit over the session's log (a cell, like
 * `dsh-session-projection/lib/index.js:126-131` + `buildCell`), and an
 * unregistered key answers `undefined`.
 */
function createProjectionRegistry(options?: { throwOnRead?: boolean }) {
  const definitions = new Map<
    string,
    SessionProjectionDefinitionLike<SessionKindProjectionState>
  >();
  const cells = new WeakMap<
    object,
    Map<string, { state: SessionKindProjectionState; observedSeq: number }>
  >();
  let registers = 0;
  return {
    get registers() {
      return registers;
    },
    definitionFor(key: string) {
      return definitions.get(key);
    },
    register(definition: SessionProjectionDefinitionLike<SessionKindProjectionState>) {
      registers += 1;
      definitions.set(definition.key, definition);
      return () => {
        definitions.delete(definition.key);
      };
    },
    stateOf(session: unknown, key: string): unknown {
      if (options?.throwOnRead === true) {
        throw new Error("projection fold exploded");
      }
      const definition = definitions.get(key);
      if (definition === undefined) return undefined;
      const view = session as StubSession;
      let cellsForSession = cells.get(view);
      if (cellsForSession === undefined) {
        cellsForSession = new Map();
        cells.set(view, cellsForSession);
      }
      let cell = cellsForSession.get(key);
      if (cell === undefined) {
        let state = definition.init(view.header, view.inheritedEventCount);
        for (const event of view.snapshotEvents()) {
          state = definition.apply(state, event);
        }
        cell = {
          state,
          observedSeq: view.snapshotEvents().at(-1)?.seq ?? -1,
        };
        cellsForSession.set(key, cell);
      }
      return cell.state;
    },
  };
}

// ── the plugin context stub ────────────────────────────────────────────────

type ProjectionRegistry = ReturnType<typeof createProjectionRegistry>;

/**
 * Structural ctx for one simulated dsh process. Storage tables are passed in
 * so a restart can share them; everything else is per-process, which is the
 * restart shape the ticket is about.
 */
function createCtx(options?: {
  storage?: Map<string, Map<string, unknown>>;
  projections?: ProjectionRegistry | null;
}) {
  const storage = options?.storage ?? new Map<string, Map<string, unknown>>();
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const globalTools = new Map<string, ScopedTool>();
  const disposers: Array<() => void> = [];
  const projections =
    options !== undefined && "projections" in options
      ? options.projections
      : createProjectionRegistry();

  const ctx = {
    effect(execute: () => unknown, label?: string) {
      void label;
      const result = execute();
      if (typeof result === "function") {
        disposers.push(result as () => void);
        return;
      }
      if (
        typeof result === "object" &&
        result !== null &&
        Symbol.iterator in result
      ) {
        for (const step of result as Iterable<unknown>) {
          if (typeof step === "function") disposers.push(step as () => void);
        }
      }
    },
    // The real registration route: the plugin asks for the optional service
    // and registers the unit on the child it gets back.
    inject(services: readonly string[], callback: (child: unknown) => void) {
      void services;
      callback({ sessionProjections: projections ?? undefined });
    },
    // The guarded READ route (cordis `ctx.get`).
    get(name: string) {
      if (name === "sessionProjections") return projections ?? undefined;
      return undefined;
    },
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((entry) => entry !== cb),
        );
      };
    },
    commands: {
      register(definition: CommandDefinitionLike) {
        if (commands.has(definition.name)) {
          throw new Error(`command "${definition.name}" is already registered`);
        }
        commands.set(definition.name, definition);
        return () => {
          commands.delete(definition.name);
        };
      },
    },
    tools: {
      schemas: () => [...globalTools.keys()].map((name) => ({ name })),
      register(definition: unknown) {
        const def = definition as ScopedTool;
        if (globalTools.has(def.name)) {
          throw new Error(`tool "${def.name}" is already registered`);
        }
        globalTools.set(def.name, def);
        return () => {
          globalTools.delete(def.name);
        };
      },
    },
    subagents: {
      async startActivation() {
        return { childId: "child-stub", dispose: async () => {} };
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
          table(name: string) {
            let table = storage.get(name);
            if (table === undefined) {
              table = new Map<string, unknown>();
              storage.set(name, table);
            }
            const rows = table;
            return {
              get: (key: string) => rows.get(key),
              entries: () => rows.entries(),
              async put(key: string, value: unknown) {
                rows.set(key, value);
              },
              async delete(key: string) {
                return rows.delete(key);
              },
            };
          },
          async close() {},
        };
      },
    },
    // Test surface
    fire(name: string, payload: unknown) {
      for (const cb of [...(listeners.get(name) ?? [])]) {
        (cb as (arg: unknown) => void)(payload);
      }
    },
    runCommand(invocation: { commandId: string; agent?: AgentLike }): CommandResultLike {
      const command = commands.get(invocation.commandId);
      if (command === undefined) {
        throw new Error(`command not registered: ${invocation.commandId}`);
      }
      return command.handler(invocation as never) as CommandResultLike;
    },
    projections,
    disposers,
    globalToolNames: () => [...globalTools.keys()],
  };
  return ctx;
}

/** The 9 tools registered on the dispatcher's OWN scope (ticket 145 recall). */
const DISPATCHER_SCOPED_TOOLS = [
  "await_agent",
  "check_workers",
  "deliver_result",
  "message_agent",
  "recall",
  "spawn_dispatcher",
  "spawn_worker",
  "steer_worker",
  "stop_worker",
];

/** The reported surface: the 9 scoped tools plus the global `request_access`. */
const DISPATCHER_FULL_SURFACE = [
  "await_agent",
  "check_workers",
  "deliver_result",
  "message_agent",
  "recall",
  "request_access",
  "spawn_dispatcher",
  "spawn_worker",
  "steer_worker",
  "stop_worker",
];

/** A top-level resumed chat: no parent, depth 0 — `isTopLevel`'s shape. */
const TOP_LEVEL_HEADER = { parentSession: null, delegationDepth: 0 } as const;

describe("ticket 147 — a user-started dispatcher re-activates after restart", () => {
  it("a resumed generation-1 dispatcher gets its 10 tools back, one policy, no degraded notice", async () => {
    // ── first process: the owner runs /dsh-bot in a normal chat ─────────
    const storage = new Map<string, Map<string, unknown>>();
    const first = createCtx({ storage });
    apply(first, volatileConfig({ enabled: true }));

    const session = createSession("chat-1", TOP_LEVEL_HEADER);
    const original = createAgent("chat-1", TOP_LEVEL_HEADER);
    appendDispatcherStart(session, "cmd-1");
    const activated = first.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: original,
    });
    assert.deepEqual(activated.kind, "success");
    assert.deepEqual(original.scopedTools.names().sort(), DISPATCHER_SCOPED_TOOLS);
    await drain();

    // ── dsh restarts ────────────────────────────────────────────────────
    // Fresh plugin, fresh host, fresh in-memory activation set. The session
    // LOG survives (it is the durable thing), and so do the storage tables.
    const second = createCtx({ storage });
    apply(second, volatileConfig({ enabled: true }));

    // Dormant boot is untouched: the plugin registered the projection unit,
    // and no tool surface exists before a session is announced.
    assert.ok(
      second.projections.definitionFor(SESSION_KIND_PROJECTION_KEY),
      "apply registers the real sessionKind unit",
    );
    assert.deepEqual(second.globalToolNames(), []);

    const resumed = createAgent("chat-1", TOP_LEVEL_HEADER);
    // The host announces the resumed session — parentless, as a top-level
    // chat is. This is the listener that used to return early.
    second.fire("agent/created", {
      agent: { ...resumed, session: { ...resumed.session, ...session } },
      source: "resume",
    });
    await drain();

    // The exact surface the owner saw removed: 9 scoped + request_access.
    assert.deepEqual(resumed.scopedTools.names().sort(), DISPATCHER_SCOPED_TOOLS);
    assert.deepEqual(second.globalToolNames(), ["request_access"]);
    assert.equal(
      resumed.scopedTools.names().length + second.globalToolNames().length,
      DISPATCHER_FULL_SURFACE.length,
    );

    // Policy came back exactly once, and activation did not report degraded
    // storage (ticket 149's defect is the other half, pinned separately).
    assert.equal(resumed.injected.length, 1);
    assert.ok(textOf(resumed.injected[0]).includes("# Multitask dispatcher"));
    assert.ok(
      resumed.injected.every((message) => !textOf(message).includes(RESTART_DEGRADED_NOTICE)),
      "no degraded-store notice on a clean marker store",
    );
  });

  it("a normal (non-dispatcher) session resumes dormant: no tools, no policy", async () => {
    const second = createCtx();
    apply(second, volatileConfig({ enabled: true }));

    // A session whose log holds no `/dsh-bot` pair — an ordinary chat.
    const session = createSession("chat-plain", TOP_LEVEL_HEADER);
    appendEvent(session, "user/message", { role: "user" });
    const resumed = createAgent("chat-plain", TOP_LEVEL_HEADER);

    second.fire("agent/created", {
      agent: { ...resumed, session: { ...resumed.session, ...session } },
      source: "resume",
    });
    await drain();

    assert.deepEqual(resumed.scopedTools.names(), []);
    assert.deepEqual(second.globalToolNames(), []);
    assert.equal(resumed.injected.length, 0);
  });

  it("a repeated announcement does not double-register or double-inject", async () => {
    const second = createCtx();
    apply(second, volatileConfig({ enabled: true }));
    const session = createSession("chat-1", TOP_LEVEL_HEADER);
    appendDispatcherStart(session, "cmd-1");
    const resumed = createAgent("chat-1", TOP_LEVEL_HEADER);
    const announced = {
      agent: { ...resumed, session: { ...resumed.session, ...session } },
      source: "resume",
    };

    second.fire("agent/created", announced);
    await drain();
    second.fire("agent/created", announced);
    await drain();

    // The scoped registry throws on a duplicate name, so a double
    // registration could not pass silently.
    assert.deepEqual(resumed.scopedTools.names().sort(), DISPATCHER_SCOPED_TOOLS);
    assert.equal(resumed.injected.length, 1);
    assert.equal(second.projections.registers, 1);
  });

  it("a session already active in this process is left alone when re-announced", async () => {
    const ctx = createCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("chat-1", TOP_LEVEL_HEADER);
    const session = createSession("chat-1", TOP_LEVEL_HEADER);
    appendDispatcherStart(session, "cmd-1");

    // Activated by the command in THIS process, then re-announced.
    assert.deepEqual(
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent }).kind,
      "success",
    );
    await drain();
    ctx.fire("agent/created", {
      agent: { ...agent, session: { ...agent.session, ...session } },
      source: "resume",
    });
    await drain();

    assert.equal(agent.injected.length, 1);
    assert.deepEqual(agent.scopedTools.names().sort(), DISPATCHER_SCOPED_TOOLS);
    assert.deepEqual(ctx.globalToolNames(), ["request_access"]);
  });

  it("a projection that throws activates nothing (fail-closed)", async () => {
    const projections = createProjectionRegistry({ throwOnRead: true });
    const ctx = createCtx({ projections });
    apply(ctx, volatileConfig({ enabled: true }));
    const session = createSession("chat-1", TOP_LEVEL_HEADER);
    appendDispatcherStart(session, "cmd-1");
    const resumed = createAgent("chat-1", TOP_LEVEL_HEADER);

    ctx.fire("agent/created", {
      agent: { ...resumed, session: { ...resumed.session, ...session } },
      source: "resume",
    });
    await drain();

    assert.deepEqual(resumed.scopedTools.names(), []);
    assert.equal(resumed.injected.length, 0);
  });

  it("no projection registry at all means the pre-147 dormant behavior", async () => {
    const ctx = createCtx({ projections: null });
    apply(ctx, volatileConfig({ enabled: true }));
    const session = createSession("chat-1", TOP_LEVEL_HEADER);
    appendDispatcherStart(session, "cmd-1");
    const resumed = createAgent("chat-1", TOP_LEVEL_HEADER);

    ctx.fire("agent/created", {
      agent: { ...resumed, session: { ...resumed.session, ...session } },
      source: "resume",
    });
    await drain();

    assert.deepEqual(resumed.scopedTools.names(), []);
    assert.equal(resumed.injected.length, 0);
  });

  it("a parentless session deeper than top level is not activated", async () => {
    const ctx = createCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const session = createSession("chat-1", { parentSession: null, delegationDepth: 1 });
    appendDispatcherStart(session, "cmd-1");
    const resumed = createAgent("chat-1", { parentSession: null, delegationDepth: 1 });

    ctx.fire("agent/created", {
      agent: { ...resumed, session: { ...resumed.session, ...session } },
      source: "resume",
    });
    await drain();

    assert.deepEqual(resumed.scopedTools.names(), []);
    assert.equal(resumed.injected.length, 0);
  });

  it("the real projection unit is the identity source (state, not a wire guess)", () => {
    // The fold the host runs: an unanswered `command/run` does NOT mark a
    // dispatcher; the paired success does. This is the same unit the resume
    // seam reads, pinned here so the test cannot pass on a hand-returned flag.
    const unpaired = createSession("s-unpaired");
    appendEvent(unpaired, "command/run", {
      commandId: "cmd-x",
      name: DISPATCHER_START_COMMAND,
      args: "",
      source: "user",
    });
    const failed = createSession("s-failed");
    appendEvent(failed, "command/run", {
      commandId: "cmd-y",
      name: DISPATCHER_START_COMMAND,
      args: "",
      source: "user",
    });
    appendEvent(failed, "command/done", { commandId: "cmd-y", kind: "error" });
    const ok = createSession("s-ok");
    appendDispatcherStart(ok, "cmd-z");

    const fold = (session: StubSession): SessionKindProjectionState => {
      let state = SESSION_KIND_PROJECTION_DEFINITION.init(
        session.header,
        session.inheritedEventCount,
      );
      for (const event of session.snapshotEvents()) {
        state = SESSION_KIND_PROJECTION_DEFINITION.apply(state, event);
      }
      return state;
    };
    assert.equal(fold(unpaired).active, false);
    assert.equal(fold(failed).active, false);
    assert.equal(fold(ok).active, true);
  });
});
