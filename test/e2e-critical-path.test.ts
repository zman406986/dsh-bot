/**
 * Ticket 172 — the ONE end-to-end file.
 *
 * The single critical path, over the real plugin `apply()` and the real
 * command/tool surface: activate a dispatcher → spawn a worker → the worker
 * settles → the settle wake reaches the dispatcher → the dispatcher calls
 * `deliver_result`.
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
): RecordingAgent {
  const followups: unknown[] = [];
  return {
    session: { id, header: { parentSession: null, delegationDepth: 0 } },
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
}

function createCtx(agentsById: ReadonlyMap<string, AgentLike>): Ctx {
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
        let table = tables.get(MARKER_TABLE_NAME);
        if (table === undefined) {
          table = new Map<string, unknown>();
          tables.set(MARKER_TABLE_NAME, table);
        }
        const rows = table;
        return {
          name: "multitask_dispatcher",
          table: () => ({
            get: (key: string) => rows.get(key) as never,
            entries: () => rows.entries() as never,
            async put(key: string, value: unknown) {
              rows.set(key, value);
            },
            async delete(key: string) {
              return rows.delete(key);
            },
          }),
          async close() {},
        };
      },
    },
  };
  return ctx as unknown as Ctx;
}

/** Text of the first text block of a wake message. */
function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

// ── the one critical path ─────────────────────────────────────────────────

describe("critical path — activate, spawn, settle, wake, deliver", () => {
  it("records the result for the dispatcher's reply and closes the obligation", async () => {
    const agents = new Map<string, AgentLike>();
    const ctx = createCtx(agents);
    const dispatcher = recordingAgent("session-1", ctx.scopedTools);
    agents.set("session-1", dispatcher);

    // 1. Activate the dispatcher: the command binds the session and raises
    //    the tool surface.
    apply(ctx, volatileConfig({ enabled: true }));
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: dispatcher });
    await flushActivation();
    assert.ok(ctx.toolNames.includes("spawn_worker"), "activation raises the surface");
    assert.ok(ctx.toolNames.includes("deliver_result"));

    // 2. Spawn a worker. No todo_id given, so the core creates exactly one
    //    linked ledger entry — the obligation this path must discharge.
    const spawn = ctx.tool("spawn_worker");
    assert.ok(spawn);
    const spawned = (await spawn.execute({
      stream_key: "critical",
      title: "Critical path worker",
      prompt: "Do the one thing.",
    })) as { ok: boolean; worker_id?: string };
    assert.equal(spawned.ok, true);
    const workerId = spawned.worker_id;
    assert.ok(workerId);

    // The ledger link the spawn created is what delivery will later close.
    const check = ctx.tool("check_workers");
    assert.ok(check);
    const row = ((await check.execute({})) as {
      rows: Array<{ worker_id: string; todo_id: string | null; stage: string }>;
    }).rows[0];
    assert.ok(row);
    assert.equal(row.worker_id, workerId);
    assert.ok(row.todo_id, "a spawn without todo_id still creates the link");
    assert.equal(row.stage, "working");
    const todoId = row.todo_id;

    // 3. The worker settles on the host. Nothing has been delivered yet, so
    //    the todo must still be open.
    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "The one thing is done." }],
    });

    // 4. The settle reaches the dispatcher as a wake turn carrying the result.
    assert.equal(dispatcher.followups.length, 1, "one wake, not one per event");
    const wakeText = textOf(dispatcher.followups[0]);
    assert.match(wakeText, /The one thing is done\./);

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

    // 6. The obligation is closed: the result is recorded for the reply, so
    //    the worker is no longer waiting-for-delivery.
    const checked = (await check.execute({})) as {
      rows: Array<{ worker_id: string; status: string; stage: string }>;
    };
    assert.deepEqual(
      checked.rows.map((row) => ({ status: row.status, stage: row.stage })),
      [{ status: "completed", stage: "ended" }],
    );

    for (const dispose of ctx.disposers) dispose();
  });

  it("leaves the todo open when the worker errors until the dispatcher delivers", async () => {
    const agents = new Map<string, AgentLike>();
    const ctx = createCtx(agents);
    const dispatcher = recordingAgent("session-1", ctx.scopedTools);
    agents.set("session-1", dispatcher);

    apply(ctx, volatileConfig({ enabled: true }));
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: dispatcher });
    await flushActivation();

    const spawn = ctx.tool("spawn_worker");
    assert.ok(spawn);
    const spawned = (await spawn.execute({
      stream_key: "erroring",
      title: "Erroring worker",
      prompt: "Fail on purpose.",
    })) as { ok: boolean; worker_id?: string };
    assert.ok(spawned.worker_id);

    ctx.fire("subagent/end", {
      id: spawned.worker_id,
      stopReason: "error",
      lastAssistantMessage: [{ type: "text", text: "it broke" }],
    });

    // A settle, even a failed one, is a delivery obligation — it wakes.
    assert.equal(dispatcher.followups.length, 1);

    const check = ctx.tool("check_workers");
    assert.ok(check);
    const before = (await check.execute({})) as {
      rows: Array<{ status: string; stage: string }>;
    };
    assert.deepEqual(
      before.rows.map((row) => row.stage),
      ["waiting-for-delivery"],
      "an undelivered result keeps the worker in waiting-for-delivery",
    );

    for (const dispose of ctx.disposers) dispose();
  });

  it("refuses a duplicate stream key without spawning a second worker", async () => {
    const agents = new Map<string, AgentLike>();
    const ctx = createCtx(agents);
    const dispatcher = recordingAgent("session-1", ctx.scopedTools);
    agents.set("session-1", dispatcher);

    apply(ctx, volatileConfig({ enabled: true }));
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: dispatcher });
    await flushActivation();

    const spawn = ctx.tool("spawn_worker");
    assert.ok(spawn);
    const first = (await spawn.execute({
      stream_key: "same",
      title: "One",
      prompt: "First.",
    })) as { ok: boolean };
    assert.equal(first.ok, true);

    const second = (await spawn.execute({
      stream_key: "same",
      title: "Two",
      prompt: "Second.",
    })) as { ok: boolean; reason?: string };
    assert.equal(second.ok, false);
    assert.equal(second.reason, "duplicate-stream-key");

    for (const dispose of ctx.disposers) dispose();
  });
});
