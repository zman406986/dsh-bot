/**
 * Ticket 147 — a USER-STARTED (generation-1) dispatcher comes back as a
 * dispatcher after a dsh restart.
 *
 * ## The reported bug
 *
 * The owner's chat was activated with `/dsh-bot`, dsh restarted, and the first
 * request in the reopened chat produced the host's own "Tools updated" notice
 * listing the activated-dispatcher surface as removed — the visible symptom
 * that the whole scoped set had vanished. The old notice named the retired
 * dispatcher verbs; that list is history, and this file no longer pins its
 * text (only that no notice is produced on a clean resume).
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
 *   `"dispatcher"` re-activates on `agent/created`: the custom scoped tools
 *   (`DISPATCHER_TOOL_NAMES`) and exactly one policy inject.
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
import { createCordisDshHost } from "../src/adapter/cordis-dsh-host.js";
import { volatileConfig } from "./support/plugin-config.js";
import {DISPATCHER_START_COMMAND, SESSION_KIND_PROJECTION_KEY, RESTART_DEGRADED_NOTICE, type AgentLike, type CommandDefinitionLike, type CommandResultLike, type SessionProjectionChildLike, type SessionProjectionDefinitionLike, type SessionKindProjectionState, type ToolsLike} from "../src/adapter/index.js";
import type { DurableWorkerMarker } from "../src/core/durability.js";
import { DISPATCHER_TOOL_NAMES } from "../src/core/policy/prompts.js";

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
    stateOf(session: unknown, key: string): SessionKindProjectionState | undefined {
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
    inject(
      services: readonly string[],
      callback: (child: SessionProjectionChildLike) => void,
    ) {
      void services;
      callback(
        projections == null ? {} : { sessionProjections: projections },
      );
    },
    // The guarded READ route (cordis `ctx.get`).
    get(name: string) {
      if (name === "sessionProjections") return projections ?? undefined;
      // Ticket 163 defect 4: `sessionController` is deliberately NOT answered
      // here. On a live cordis context it is a service property, and reading
      // it is what `readSessionController` must survive.
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
            // The stub's table map is shared across logical tables, so its
            // values are opaque; this view is only ever read as markers.
            return {
              get: (key: string) =>
                rows.get(key) as DurableWorkerMarker | undefined,
              entries: () =>
                rows.entries() as IterableIterator<
                  [string, DurableWorkerMarker]
                >,
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

/**
 * The CUSTOM tools registered on the dispatcher's OWN scope (racoons off by
 * default), derived from the one const. The stock agent verbs (`subagent`,
 * `list_agents`, `send_message`, `interrupt_agent`) are mounted by the
 * preset, and this harness mounts no preset — so the scoped set is exactly the
 * custom three, and that is also the full surface (ticket 174 / ADR-0033
 * removed the global `request_access`).
 */
const DISPATCHER_SCOPED_TOOLS: string[] = [...DISPATCHER_TOOL_NAMES].sort();

/** A top-level resumed chat: no parent, depth 0 — `isTopLevel`'s shape. */
const TOP_LEVEL_HEADER = { parentSession: null, delegationDepth: 0 } as const;

describe("ticket 147 — a user-started dispatcher re-activates after restart", () => {
  it("a resumed generation-1 dispatcher gets its custom tools back, one policy, no degraded notice", async () => {
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
      second.projections?.definitionFor(SESSION_KIND_PROJECTION_KEY),
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

    // The exact surface the owner saw removed is back: the custom scoped set.
    assert.deepEqual(resumed.scopedTools.names().sort(), DISPATCHER_SCOPED_TOOLS);
    assert.deepEqual(second.globalToolNames(), []);
    assert.equal(
      resumed.scopedTools.names().length + second.globalToolNames().length,
      DISPATCHER_SCOPED_TOOLS.length,
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

});

/**
 * Ticket 163 defect 3 — `resumedUserDispatchers` must not outlive the
 * activation it stands for.
 *
 * The guard deduplicates repeat ANNOUNCEMENTS of one live session. Kept past
 * disposal it did two wrong things: a same-process re-announcement skipped
 * re-activation entirely (leaving the session with no scoped tools and no
 * policy), and the set grew for the whole process.
 */
describe("ticket 163 defect 3 — a disposed dispatcher re-activates on re-announcement", () => {
  it("regains its scoped tools and policy after dispose + re-announce", async () => {
    const ctx = createCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const session = createSession("chat-1", TOP_LEVEL_HEADER);
    appendDispatcherStart(session, "cmd-1");

    // First announcement: the resumed dispatcher activates. The SAME object is
    // announced and later disposed — the lifecycle matches disposals by object
    // identity, so a copy would deactivate nothing.
    const first = createAgent("chat-1", TOP_LEVEL_HEADER);
    const firstAnnounced = {
      ...first,
      session: { ...first.session, ...session },
    };
    ctx.fire("agent/created", {
      agent: firstAnnounced,
      source: "resume",
    });
    await drain();
    assert.deepEqual(first.scopedTools.names().sort(), DISPATCHER_SCOPED_TOOLS);
    assert.equal(first.injected.length, 1);

    // The session is disposed — the UI delete affordance, or the host
    // re-creating the session. Its activation (and its surface) is gone.
    ctx.fire("agent/disposed", { agent: firstAnnounced });
    await drain();
    assert.deepEqual(first.scopedTools.names(), []);

    // …and re-announced in the SAME process. This is the case the never-cleared
    // guard silently swallowed: it still held "chat-1", so the host returned
    // before re-activating and the session came back with nothing.
    const second = createAgent("chat-1", TOP_LEVEL_HEADER);
    const secondAnnounced = {
      ...second,
      session: { ...second.session, ...session },
    };
    ctx.fire("agent/created", {
      agent: secondAnnounced,
      source: "resume",
    });
    await drain();

    assert.deepEqual(
      second.scopedTools.names().sort(),
      DISPATCHER_SCOPED_TOOLS,
      "the re-announced session got its scoped tools back",
    );
    assert.equal(second.injected.length, 1, "and exactly one policy inject");
    assert.ok(textOf(second.injected[0]).includes("# Multitask dispatcher"));
  });

  it("a repeat announcement WITHOUT disposure is still deduplicated", async () => {
    // The guard's real job must survive the fix: the same live session
    // announced twice activates once, so no duplicate tool registration throws
    // and no second policy is injected.
    const ctx = createCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const session = createSession("chat-1", TOP_LEVEL_HEADER);
    appendDispatcherStart(session, "cmd-1");

    const agent = createAgent("chat-1", TOP_LEVEL_HEADER);
    const payload = {
      agent: { ...agent, session: { ...agent.session, ...session } },
      source: "resume",
    };
    ctx.fire("agent/created", payload);
    await drain();
    ctx.fire("agent/created", payload);
    await drain();

    assert.deepEqual(agent.scopedTools.names().sort(), DISPATCHER_SCOPED_TOOLS);
    assert.equal(agent.injected.length, 1, "one activation, one policy");
  });
});

/**
 * Ticket 163 defect 4 — `ctx.sessionController` is read through ONE guarded
 * accessor, and a deployment without the service degrades to the parent route
 * instead of throwing.
 *
 * The reviewed code did `return ctx.sessionController;` AFTER a guarded
 * `ctx.get`, outside any `try`. On a live cordis context that property read
 * throws for a service the context never injected, so `sendMessage` — the
 * caller the ticket names — propagated the cordis error instead of reaching
 * the pre-ADR-0032 parent→child fallback. These tests build the host directly
 * and make the property read throw, which is the only way to tell the two
 * behaviours apart.
 */
describe("ticket 163 defect 4 — sessionController is read through one guarded accessor", () => {
  /** A minimal structural ctx whose `sessionController` READ throws. */
  function createFacadelessCtx() {
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    const ctx = {
      get(name: string): unknown {
        void name;
        // Nothing answers `get`, so the accessor falls through to the property.
        return undefined;
      },
      on(name: string, cb: (payload: never) => void) {
        const list = listeners.get(name) ?? [];
        list.push(cb as (payload: unknown) => void);
        listeners.set(name, list);
        return () => {
          listeners.set(
            name,
            (listeners.get(name) ?? []).filter(
              (entry) => entry !== (cb as (payload: unknown) => void),
            ),
          );
        };
      },
      /** Test surface: deliver a host event to the registered listeners. */
      fire(name: string, payload: unknown) {
        for (const cb of [...(listeners.get(name) ?? [])]) {
          cb(payload);
        }
      },
      subagents: {
        async startActivation() {
          throw new Error("not used");
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
            table: () => ({
              get: () => undefined,
              entries: () => new Map().entries(),
              async put() {},
              async delete() {
                return false;
              },
            }),
            async close() {},
          };
        },
      },
    };
    // The hazard, modelled exactly: cordis throws at property ACCESS.
    Object.defineProperty(ctx, "sessionController", {
      configurable: true,
      get(): never {
        throw new Error(
          "sessionController is not injected into this context (simulated cordis throw)",
        );
      },
    });
    return ctx;
  }

  it("sendMessage degrades to the parent route instead of throwing the cordis error", async () => {
    const host = createCordisDshHost(createFacadelessCtx() as never);

    // No facade, no recorded worker, so the parent route cannot resolve a
    // sender either. THAT refusal is the correct outcome — it proves control
    // reached the fallback instead of dying on the property read.
    const caught = await host.sendMessage("some-worker", "hello").then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.ok(caught instanceof Error);
    assert.match(caught.message, /^CordisDshHost: /);
    assert.match(caught.message, /no parent agent bound/);
    assert.ok(
      !/sessionController is not injected/.test(caught.message),
      "the simulated cordis throw must never escape the accessor",
    );
  });

  it("sendMessage never routes a worker through the peer facade", async () => {
    // Worker sessions carry `origin: "subagent"`, and the host's session
    // facade refuses that shape by design (`session/agent-busy`, "use subagent
    // delivery for this child session"). Subagent delivery is the worker route
    // even when a facade is mounted — consulting it is the crash.
    const resolved: string[] = [];
    const ctx = createFacadelessCtx() as Record<string, unknown>;
    ctx["get"] = (name: string) =>
      name === "sessionController"
        ? {
            async resolveAgent(sessionId: string) {
              resolved.push(sessionId);
              return { error: new Error("session is owned by subagent routing") };
            },
          }
        : undefined;
    const host = createCordisDshHost(ctx as never);

    const caught = await host.sendMessage("some-worker", "carry on").then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.deepEqual(resolved, [], "the peer facade must not be asked");
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /no parent agent bound/);
  });

  it("a marked non-live dispatcher wake survives the throwing property read and stays parked", async () => {
    // The reachable path: `sendMessage` no longer reads the facade, but
    // `resumeDormantDispatcher` does. A marked session that is not live is a
    // wake, and the guarded accessor must answer "no facade" instead of
    // letting the cordis property-read throw escape.
    const ctx = createFacadelessCtx();
    const host = createCordisDshHost(ctx as never, {
      markers: {
        listDispatcherMarks() {
          return [{ sessionId: "chat-cold" }];
        },
      } as never,
    });
    await host.refreshDispatcherMarks();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      await host.requestDispatcherWakeup("chat-cold");
      await drain();
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(
      !warnings.some((line) => line.includes("sessionController is not injected")),
      "the simulated cordis throw must never escape the accessor",
    );
    assert.ok(
      warnings.some((line) => line.includes("is undeliverable")),
      "the wake degrades honestly instead of claiming a resume",
    );

    // Parked, not dropped: the next announcement still delivers it once.
    const followed: unknown[] = [];
    const resumed = {
      session: {
        id: "chat-cold",
        header: { parentSession: null, delegationDepth: 0 },
      },
      followup(message: unknown) {
        followed.push(message);
      },
      inject() {},
    };
    ctx.fire("agent/created", { agent: resumed, source: "resume" });
    await drain();
    assert.equal(followed.length, 1, "the parked wake is still an obligation");
  });
});
