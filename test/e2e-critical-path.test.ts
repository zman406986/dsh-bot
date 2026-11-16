/**
 * Ticket 172 — the ONE end-to-end file.
 *
 * The single critical path, over the real plugin `apply()` and the real
 * command/tool surface: activate a dispatcher → start a worker through the
 * stock `subagent` tool (the preset's four agent verbs are mounted by the
 * test) → the worker settles (the stock completion notice is the one
 * parent-visible result; the plugin opens no settle wake) → the dispatcher
 * calls `deliver_result`.
 *
 * Stock-subagent refactor: the five custom worker verbs (`spawn_worker`,
 * `check_workers`, `steer_worker`, `stop_worker`, `await_agent`) are
 * retired. This file therefore asserts the CURRENT surface — the three custom
 * verbs plus the stock `subagent` / `list_agents` / `send_message` /
 * `interrupt_agent` — and reads the spawned worker's linked todo off the
 * durable marker (the same row a restart rebuilds from) instead of a roster
 * tool. No removed name is ever registered or called here.
 *
 * The live plugin wires no separate user-facing send channel, so delivery is
 * conversational (ADR-0009): the dispatcher's own reply is the channel. The
 * result is recorded with `channel: "reply"`, the todo is marked done, and the
 * user receives the text when the dispatcher states it. The rendered row must
 * never claim the user already saw it.
 *
 * Offline only (S8): a fake host context, no Cordis, no browser, no network,
 * no LLM. Everything else in `test/` is a unit test of a pure module; this file
 * is the only whole-chain rehearsal.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import {
  DISPATCHER_START_COMMAND,
  MARKER_TABLE_NAME,
  type ActivationSpecLike,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
} from "../src/adapter/index.js";
// `CreateAgentOptionsLike` is exported by the host module but not re-exported
// through the adapter barrel, so the test reaches the declaring module directly.
import type { CreateAgentOptionsLike } from "../src/adapter/cordis-dsh-host.js";
import { DISPATCHER_TOOL_NAMES } from "../src/core/policy/prompts.js";
import type { DurableWorkerMarker } from "../src/core/durability.js";

// ── fake host ─────────────────────────────────────────────────────────────

 /** Drain the async activation/rebuild chain queued by apply (ticket 31). */
async function flushActivation(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}

/** Structural per-agent tool surface (the host's `agent.ctx.tools`). */
interface ScopedToolRegistry {
  schemas(scope?: unknown): ReadonlyArray<{ readonly name: string }>;
  register(definition: {
    name: string;
    execute: (args: unknown, exec?: unknown) => Promise<unknown>;
  }): () => void;
}

interface RecordingAgent extends AgentLike {
  readonly followups: unknown[];
  readonly ctx?: { readonly tools: ScopedToolRegistry };
}

function recordingAgent(
  id: string,
  scopedTools?: ScopedToolRegistry,
  header: {
    parentSession: unknown;
    delegationDepth: number;
    origin?: unknown;
  } = { parentSession: null, delegationDepth: 0 },
): RecordingAgent {
  const followups: unknown[] = [];
  return {
    session: { id, header },
    followup(message: unknown) {
      followups.push(message);
    },
    inject() {},
    followups,
    ...(scopedTools !== undefined ? { ctx: { tools: scopedTools } } : {}),
  };
}

interface Ctx extends AdapterContext {
  effect(execute: () => unknown): void;
  fire(name: string, ...payloads: unknown[]): void;
  runCommand(invocation: { commandId: string; agent: AgentLike }): void;
  tool(name: string):
    | { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
    | undefined;
  readonly registeredCommands: CommandDefinitionLike[];
  readonly toolNames: string[];
  readonly activationCalls: ActivationSpecLike[];
  readonly createCalls: CreateAgentOptionsLike[];
  readonly disposers: Array<() => void>;
  /** The scoped surface every test agent must carry (ADR-0019). */
  readonly scopedTools: ScopedToolRegistry;
  /**
   * Mount the preset's four stock agent verbs on the dispatcher's own scope.
   * A live preset does this, not this plugin; the fake `subagent` starts a
   * child the same way the host's stock tool does — an `agent/created`
   * announcement with the child's header, never a call into the plugin.
   */
  mountStockAgentTools(parentSessionId: string): void;
  /** The durable worker marker (the row a restart rebuild reads). */
  marker(workerId: string): DurableWorkerMarker | undefined;
}

function createCtx(agentsById: Map<string, AgentLike>): Ctx {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands: CommandDefinitionLike[] = [];
  const tools: Array<{
    name: string;
    execute: (args: unknown, exec?: unknown) => Promise<unknown>;
  }> = [];
  const disposers: Array<() => void> = [];
  const activationCalls: ActivationSpecLike[] = [];
  const createCalls: CreateAgentOptionsLike[] = [];
  const tables = new Map<string, Map<string, unknown>>();

  const fire = (name: string, ...payloads: unknown[]) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      (cb as (...args: unknown[]) => void)(...payloads);
    }
  };

  const registerTool = (definition: {
    name: string;
    execute: (args: unknown, exec?: unknown) => Promise<unknown>;
  }): (() => void) => {
    if (tools.some((t) => t.name === definition.name)) {
      throw new Error(`tool "${definition.name}" is already registered`);
    }
    tools.push(definition);
    return () => {
      const at = tools.indexOf(definition);
      if (at >= 0) tools.splice(at, 1);
    };
  };

  // ADR-0019: the plugin registers dispatcher tools on the ACTIVATED agent's
  // own scoped surface, never on the plugin-level one. The registry writes
  // into the same list `ctx.tool(name)` reads, so the test surface is the
  // agent's surface.
  const scopedTools: ScopedToolRegistry = {
    schemas: () => tools.map((t) => ({ name: t.name })),
    register: registerTool,
  };

  const tableFor = (name: string): Map<string, unknown> => {
    let table = tables.get(name);
    if (table === undefined) {
      table = new Map<string, unknown>();
      tables.set(name, table);
    }
    return table;
  };

  /** A child scope shaped like a per-agent host context (worker barrier seam). */
  const stockChildScope = {
    schemas: () => [{ name: "deliver_result" }],
    register: () => () => {},
    restrict: () => () => {},
  };

  let nextStockChild = 0;
  /**
   * Announce a child the way the host's stock `subagent` tool does: the
   * child is created by the preset, then `agent/created` carries its header.
   * The plugin never sees a spawn call; adoption is the host's `header`
   * evidence (`origin: "subagent"` + parent + depth), exactly the stock path.
   */
  const announceStockChild = (
    parentSessionId: string,
    label: string,
  ): string => {
    nextStockChild += 1;
    const id = `stock-worker-${nextStockChild}`;
    const child = recordingAgent(id, stockChildScope, {
      parentSession: parentSessionId,
      delegationDepth: 1,
      origin: "subagent",
    });
    agentsById.set(id, child);
    fire("agent/created", { agent: child, source: "startup", label });
    return id;
  };

  const ctx = {
    disposers,
    activationCalls,
    createCalls,
    scopedTools,
    get registeredCommands() {
      return commands;
    },
    get toolNames() {
      return tools.map((t) => t.name);
    },
    fire,
    mountStockAgentTools(parentSessionId: string) {
      if (tools.some((t) => t.name === "subagent")) return;
      scopedTools.register({
        name: "subagent",
        async execute(args: unknown) {
          const input = (args ?? {}) as { description?: unknown; prompt?: unknown };
          const label =
            typeof input.description === "string" ? input.description : "";
          return { ok: true, childId: announceStockChild(parentSessionId, label) };
        },
      });
      for (const name of ["list_agents", "send_message", "interrupt_agent"]) {
        scopedTools.register({
          name,
          async execute() {
            return { ok: true };
          },
        });
      }
    },
    marker(workerId: string) {
      return tableFor(MARKER_TABLE_NAME).get(workerId) as
        | DurableWorkerMarker
        | undefined;
    },
    tool: (name: string) => tools.find((t) => t.name === name),
    runCommand(invocation: { commandId: string; agent: AgentLike }) {
      const command = commands.find((c) => c.name === invocation.commandId);
      if (command === undefined) {
        throw new Error(`command not registered: ${invocation.commandId}`);
      }
      void command.handler(invocation as never);
    },
    // Cordis effect contract: `execute` runs at apply; a returned function is
    // the unload disposer.
    effect(execute: () => unknown) {
      const result = execute();
      if (typeof result === "function") {
        disposers.push(result as () => void);
        return;
      }
      if (typeof result === "object" && result !== null && Symbol.iterator in result) {
        for (const step of result as Iterable<unknown>) {
          if (typeof step === "function") disposers.push(step as () => void);
        }
      }
    },
    inject() {},
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(name, (listeners.get(name) ?? []).filter((c) => c !== cb));
      };
    },
    commands: {
      register(definition: CommandDefinitionLike) {
        if (commands.some((c) => c.name === definition.name)) {
          throw new Error(`command "${definition.name}" is already registered`);
        }
        commands.push(definition);
        return () => {
          const at = commands.indexOf(definition);
          if (at >= 0) commands.splice(at, 1);
        };
      },
    },
    tools: {
      schemas: () => tools.map((t) => ({ name: t.name })),
      register: registerTool,
    },
    subagents: {
      async startActivation(spec: ActivationSpecLike) {
        activationCalls.push(spec);
        return { childId: "child-stub", dispose: async () => {} };
      },
      interrupt() {},
      async sendMessage() {
        return "msg-stub";
      },
    },
    agents: { get: (id: unknown) => agentsById.get(String(id)) },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        return {
          name: "multitask_dispatcher",
          // One map per table NAME: a worker marker and its worker-session
          // row are different records (a shared map would overwrite one with
          // the other and hide the linked todo this file reads).
          async table(name: string) {
            const rows = tableFor(name);
            return {
              get: (key: string) => rows.get(key) as never,
              entries: () => rows.entries() as never,
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
  };
  return ctx as unknown as Ctx;
}

// ── the one critical path ─────────────────────────────────────────────────

/** The preset's stock agent verbs — mounted by the preset, never by us. */
const STOCK_AGENT_TOOL_NAMES = [
  "subagent",
  "list_agents",
  "send_message",
  "interrupt_agent",
] as const;

/** The five model-facing worker verbs retired by the stock-subagent refactor. */
const REMOVED_WORKER_TOOL_NAMES = [
  "spawn_worker",
  "check_workers",
  "steer_worker",
  "stop_worker",
  "await_agent",
] as const;

/**
 * The current dispatcher plane: the three custom verbs plus the preset's four
 * stock agent verbs, with no removed name registered at any point.
 */
function assertDispatcherToolSurface(ctx: Ctx): void {
  for (const name of [...DISPATCHER_TOOL_NAMES, ...STOCK_AGENT_TOOL_NAMES]) {
    assert.ok(
      ctx.toolNames.includes(name),
      `${name} must be on the dispatcher plane`,
    );
  }
  for (const name of REMOVED_WORKER_TOOL_NAMES) {
    assert.equal(
      ctx.toolNames.includes(name),
      false,
      `${name} is retired and must never be registered`,
    );
  }
}

describe("critical path — activate, stock spawn, settle, deliver", () => {
  it("records the result for the dispatcher's reply and closes the obligation", async () => {
    const agents = new Map<string, AgentLike>();
    const ctx = createCtx(agents);
    const dispatcher = recordingAgent("session-1", ctx.scopedTools);
    agents.set("session-1", dispatcher);
    // The preset mounts its four agent verbs on this dispatcher's scope; the
    // plugin adds only its three custom verbs beside them.
    ctx.mountStockAgentTools("session-1");

    // 1. Activate the dispatcher: the command binds the session and raises
    //    the tool surface.
    apply(ctx, volatileConfig({ enabled: true }));
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: dispatcher });
    await flushActivation();
    assertDispatcherToolSurface(ctx);

    // 2. Start a worker through the stock `subagent` tool. The fake announces
    //    the child exactly as the host's stock tool does; the plugin's host
    //    adopts it from the child header (never from a spawn_worker call).
    const subagent = ctx.tool("subagent");
    assert.ok(subagent);
    const spawned = (await subagent.execute({
      description: "Critical path worker",
      prompt: "Do the one thing.",
    })) as { ok: boolean; childId?: string };
    assert.equal(spawned.ok, true);
    const workerId = spawned.childId;
    assert.ok(workerId);

    // The adoption created exactly one linked ledger entry. It is read off
    // the durable marker — the same row a restart rebuilds from.
    await flushActivation();
    const spawnMarker = ctx.marker(workerId);
    assert.ok(spawnMarker, "stock adoption writes the durable worker marker");
    assert.equal(spawnMarker.workerId, workerId);
    assert.equal(spawnMarker.status, "spawned");
    const todoId = spawnMarker.todoId;
    assert.ok(todoId, "a stock adoption still creates the ledger link");

    // 3. The worker settles on the host. Nothing has been delivered yet, so
    //    the todo must still be open.
    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "The one thing is done." }],
    });
    await flushActivation();

    // 4. The plugin opens no wake turn for the settle: the stock completion
    //    notice (source kind subagent-settled) is the one parent-visible
    //    result. The obligation marker survives, still pointing at the todo.
    assert.equal(dispatcher.followups.length, 0, "no plugin settle wake");
    const settledMarker = ctx.marker(workerId);
    assert.equal(settledMarker?.status, "completed");
    assert.equal(
      settledMarker?.todoId,
      todoId,
      "the completed worker is still owed a delivery",
    );

    // 5. The dispatcher calls deliver_result. This plugin wires no separate
    //    user-facing send, so the dispatcher's own reply is the channel: the
    //    result is recorded, the ledger item closes, and the tool says to
    //    state the text in that reply.
    const deliver = ctx.tool("deliver_result");
    assert.ok(deliver);
    const delivered = (await deliver.execute({
      text: "The one thing is done.",
      todo_id: todoId,
    })) as {
      ok: boolean;
      delivered: boolean;
      channel?: string;
      todo_completed: string | null;
      reason?: string;
      detail?: string;
    };
    assert.deepEqual(
      {
        ok: delivered.ok,
        delivered: delivered.delivered,
        channel: delivered.channel,
        todo: delivered.todo_completed,
      },
      { ok: true, delivered: true, channel: "reply", todo: todoId },
    );
    assert.match(delivered.detail ?? "", /say it in your reply/i);

    // 6. The obligation is closed: delivery drops the durable marker, so no
    //    restart can re-open an already-delivered result.
    await flushActivation();
    assert.equal(
      ctx.marker(workerId),
      undefined,
      "delivery drops the delivery-obligation marker",
    );

    for (const dispose of ctx.disposers) dispose();
  });

  it("leaves the todo open when the worker errors until the dispatcher delivers", async () => {
    const agents = new Map<string, AgentLike>();
    const ctx = createCtx(agents);
    const dispatcher = recordingAgent("session-1", ctx.scopedTools);
    agents.set("session-1", dispatcher);
    ctx.mountStockAgentTools("session-1");

    apply(ctx, volatileConfig({ enabled: true }));
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: dispatcher });
    await flushActivation();

    const subagent = ctx.tool("subagent");
    assert.ok(subagent);
    const spawned = (await subagent.execute({
      description: "Erroring worker",
      prompt: "Fail on purpose.",
    })) as { ok: boolean; childId?: string };
    assert.equal(spawned.ok, true);
    const workerId = spawned.childId;
    assert.ok(workerId);
    await flushActivation();
    const spawnMarker = ctx.marker(workerId);
    assert.ok(spawnMarker?.todoId);
    const todoId = spawnMarker.todoId;

    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "error",
      lastAssistantMessage: [{ type: "text", text: "it broke" }],
    });
    await flushActivation();

    // A settle, even a failed one, is a delivery obligation — but the plugin
    // opens no wake for it. The marker keeps the obligation open, so the
    // dispatcher still has to deliver the failure.
    assert.equal(dispatcher.followups.length, 0, "no plugin settle wake");
    const settled = ctx.marker(workerId);
    assert.ok(settled, "an error still owes a delivery");
    assert.equal(settled.status, "error");
    assert.equal(
      settled.todoId,
      todoId,
      "an undelivered result keeps its ledger link",
    );

    for (const dispose of ctx.disposers) dispose();
  });

  it("adopts each stock child once: the retired stream-key refusal has no stock counterpart", async () => {
    const agents = new Map<string, AgentLike>();
    const ctx = createCtx(agents);
    const dispatcher = recordingAgent("session-1", ctx.scopedTools);
    agents.set("session-1", dispatcher);
    ctx.mountStockAgentTools("session-1");

    apply(ctx, volatileConfig({ enabled: true }));
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: dispatcher });
    await flushActivation();

    const subagent = ctx.tool("subagent");
    assert.ok(subagent);
    const first = (await subagent.execute({
      description: "One",
      prompt: "First.",
    })) as { ok: boolean; childId?: string };
    assert.equal(first.ok, true);
    const firstId = first.childId;
    assert.ok(firstId);
    await flushActivation();
    const firstTodo = ctx.marker(firstId)?.todoId;
    assert.ok(firstTodo);

    // The stock runtime has no stream-key slot, so its duplicate-key refusal
    // retired with spawn_worker. The invariant that survives is identity:
    // the same child announced again is the same worker, never a second one.
    const child = agents.get(firstId);
    assert.ok(child);
    ctx.fire("agent/created", { agent: child, source: "startup" });
    await flushActivation();
    assert.equal(
      ctx.marker(firstId)?.todoId,
      firstTodo,
      "a repeat announcement adds no second worker or todo",
    );

    // A second stock spawn is a distinct child and a distinct obligation.
    const second = (await subagent.execute({
      description: "Two",
      prompt: "Second.",
    })) as { ok: boolean; childId?: string };
    assert.equal(second.ok, true);
    const secondId = second.childId;
    assert.ok(secondId);
    assert.notEqual(secondId, firstId);
    await flushActivation();
    const secondTodo = ctx.marker(secondId)?.todoId;
    assert.ok(secondTodo);
    assert.notEqual(secondTodo, firstTodo);

    for (const dispose of ctx.disposers) dispose();
  });
});
