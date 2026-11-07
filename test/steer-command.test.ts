/**
 * Ticket 22 — /dispatcher-steer host command routing into the existing core
 * steer queue (design-16 §4.3).
 *
 * Offline only (S8): fake AdapterContext seams (commands + tools registry,
 * listener bus, storage stub) driving the real plugin apply(), the real
 * CordisDshHost, and the real Multitask core. No network, no LLM, no
 * running dsh. test/steer-queue.test.ts keeps covering queue semantics —
 * these tests cover the command as an input path onto that queue.
 *
 * Fake-vs-host (ticket 91): the fake `commands.register` / `tools.register`
 * throw on a duplicate name with the shipped wording
 * (`@deepseek-ai/dsh-commands/lib/index.js:82`,
 * `@deepseek-ai/dsh-tools/lib/index.js:2538`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import {DISPATCHER_START_COMMAND, DISPATCHER_STEER_COMMAND, DISPATCHER_STEER_COPY_EN, DISPATCHER_STEER_COPY_ZH, DISPATCHER_STEER_DESCRIPTION, DISPATCHER_STEER_INPUT_HINT, DISPATCHER_STEER_NOT_ACTIVE, DISPATCHER_STEER_NOT_DISPATCHER, createDispatcherSteerCommand, dispatcherSteerCopy, dispatcherSteerNotRunning, dispatcherSteerSuccess, parseSteerInput, type AdapterContext, type AgentLike, type CommandDefinitionLike, type CommandResultLike, type ToolsLike} from "../src/adapter/index.js";

interface ScopedToolSurface extends ToolsLike {
  register(definition: unknown): () => void;
  get(
    name: string,
  ): { execute: (args: unknown, exec?: unknown) => Promise<unknown> } | undefined;
}

interface ScopedAgent extends AgentLike {
  readonly ctx: { readonly tools: ScopedToolSurface };
}

/**
 * ADR-0019: the live host mints a scoped tool surface per agent. The plugin
 * refuses the retired process-global fallback, so test agents carry one.
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
        throw new Error(
          `tool "${tool.name}" is already registered (for a ` +
            `per-agent variant, register through that agent's ` +
            `\`agent.ctx\` instead)`,
        );
      }
      scoped.set(tool.name, tool);
      return () => {
        scoped.delete(tool.name);
      };
    },
    get: (name) => scoped.get(name),
  };
}

function createAgent(
  id: string,
  opts?: { topLevel?: boolean },
): ScopedAgent {
  const topLevel = opts?.topLevel ?? true;
  return {
    session: {
      id,
      header: topLevel
        ? { parentSession: null, delegationDepth: 0 }
        : { parentSession: "parent-x", delegationDepth: 1 },
    },
    followup() {},
    inject() {},
    ctx: { tools: createScopedTools() },
  };
}

interface SentMessage {
  readonly targetId: unknown;
  readonly text: string;
}

function createFullCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const disposers: Array<() => void> = [];
  const sentMessages: SentMessage[] = [];
  let nextChild = 1;
  /**
   * ADR-0019: the plugin registers the dispatcher tools on the activated
   * agent's own scope. These helpers read that surface; there is no global
   * registry fallback to read.
   */
  let scopedAgent: ScopedAgent | null = null;

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
    }
  };

  const ctx = {
    // Cordis effect contract (ticket 44): `execute` runs at apply; a returned
    // function — or each value a generator yields — is the unload disposer.
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
    inject() {},
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((c) => c !== cb),
        );
      };
    },
    commands: {
      register(definition: CommandDefinitionLike) {
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
        return () => {
          commands.delete(definition.name);
        };
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
      async sendMessage(
        _sender: unknown,
        targetId: unknown,
        content: Array<{ text?: string }>,
      ) {
        sentMessages.push({
          targetId,
          text: content.map((block) => block.text ?? "").join(""),
        });
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
    // Test surface
    fire,
    disposers,
    commandNames: () => [...commands.keys()].sort(),
    command: (name: string) => commands.get(name),
    tool: (name: string) => tools.get(name),
    runCommand: async (
      invocation: { commandId: string; agent?: AgentLike; rawInput?: string },
    ): Promise<CommandResultLike> => {
      const command = commands.get(invocation.commandId);
      if (command === undefined) {
        throw new Error(`command not registered: ${invocation.commandId}`);
      }
      return command.handler(invocation as never) as CommandResultLike;
    },
    /** Remember the agent whose scoped surface this activation serves. */
    setActiveAgent: (agent: ScopedAgent): void => {
      scopedAgent = agent;
    },
    /** Spawn a worker through the real dispatcher tool surface. */
    spawnWorker: async (sessionId: string): Promise<string> => {
      const spawn = scopedAgent?.ctx.tools.get("spawn_worker");
      assert.ok(spawn);
      const value = (await spawn.execute(
        { stream_key: "k", title: "T", prompt: "P" },
        { agent: { session: { id: sessionId } } },
      )) as { ok: boolean; worker_id: string };
      assert.equal(value.ok, true);
      return value.worker_id;
    },
    /** Drive the worker FSM spawned → running through the status wiring. */
    startWorkerTurn: (workerId: string): void => {
      fire("agent/status", {
        agent: { session: { id: workerId } },
        status: "running",
      });
    },
    /** Fire the worker idle step boundary (the core's steer delivery point). */
    endWorkerTurn: (workerId: string): void => {
      fire("agent/status", {
        agent: { session: { id: workerId } },
        status: "idle",
      });
    },
    /** Read the live roster row for a worker through check_workers. */
    workerStatus: async (
      workerId: string,
      sessionId: string,
    ): Promise<string> => {
      const check = scopedAgent?.ctx.tools.get("check_workers");
      assert.ok(check);
      const value = (await check.execute(
        { worker_id: workerId },
        { agent: { session: { id: sessionId } } },
      )) as { ok: boolean; rows: Array<{ status: string }> };
      assert.equal(value.ok, true);
      assert.equal(value.rows.length, 1);
      const row = value.rows[0];
      assert.ok(row);
      return row.status;
    },
    sentMessages,
  };
  return ctx as typeof ctx & AdapterContext;
}

async function activateWithRunningWorker(ctx: ReturnType<typeof createFullCtx>) {
  const agent = createAgent("s-1");
  ctx.setActiveAgent(agent);
  const activation = await ctx.runCommand({
    commandId: DISPATCHER_START_COMMAND,
    agent,
  });
  assert.equal(activation.kind, "success");
  const workerId = await ctx.spawnWorker("s-1");
  ctx.startWorkerTurn(workerId);
  assert.equal(await ctx.workerStatus(workerId, "s-1"), "running");
  return { agent, workerId };
}

describe("steer command — flag matrix and registration", () => {
  it("flag ON registers dsh-bot and dispatcher-steer exactly once", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    assert.deepEqual(ctx.commandNames(), [
          DISPATCHER_STEER_COMMAND,
      // "dsh-bot" sorts after the dispatcher- names (ADR-0030 rename); the
      // withdrawn dispatcher-stop (ticket 101) is gone (ticket 129).
      DISPATCHER_START_COMMAND,
    ]);

    const steer = ctx.command(DISPATCHER_STEER_COMMAND);
    assert.ok(steer);
    assert.equal(steer.description, DISPATCHER_STEER_DESCRIPTION);
    // Input hint advertised per the Finding 2 contract (design-16 §6).
    assert.deepEqual(steer.input, { hint: DISPATCHER_STEER_INPUT_HINT });

    // Re-activation never duplicates the registration.
    const agent = createAgent("s-1");
    void ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    void ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.deepEqual(ctx.commandNames(), [
          DISPATCHER_STEER_COMMAND,
      // "dsh-bot" sorts after the dispatcher- names (ADR-0030 rename).
      DISPATCHER_START_COMMAND,
    ]);
  });

});

describe("steer command — activation gate", () => {
  it("refuses while dormant with not-active copy", async () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const result = await ctx.runCommand({
      commandId: DISPATCHER_STEER_COMMAND,
      agent: createAgent("s-1"),
      rawInput: "child-1 do the thing",
    });
    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_STEER_NOT_ACTIVE,
    });
  });

  it("refuses a non-top-level chat (a child chat never holds the activation)", async () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    await ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: createAgent("s-1"),
    });

    // Activation refuses non-top-level chats, so a child chat can only ever
    // miss the session-equality gate — the refusal is the same copy.
    const result = await ctx.runCommand({
      commandId: DISPATCHER_STEER_COMMAND,
      agent: createAgent("child-9", { topLevel: false }),
      rawInput: "child-1 do the thing",
    });
    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_STEER_NOT_DISPATCHER,
    });
  });
});

describe("steer command — payload parsing", () => {
  it("splits the first token as the worker id and rejects malformed input", () => {
    assert.deepEqual(parseSteerInput("child-1 focus on the failing test"), {
      workerId: "child-1",
      instruction: "focus on the failing test",
    });
    assert.deepEqual(parseSteerInput("  child-1   first   "), {
      workerId: "child-1",
      instruction: "first",
    });
    for (const bad of [undefined, "", "   ", "child-1"]) {
      assert.equal(parseSteerInput(bad), null, `accepted: ${String(bad)}`);
    }
  });
});

describe("steer command — routes into the existing core steer queue", () => {
  it("queues the instruction, flips running → steering, returns success copy", async () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const { workerId } = await activateWithRunningWorker(ctx);

    const result = await ctx.runCommand({
      commandId: DISPATCHER_STEER_COMMAND,
      agent: createAgent("s-1"),
      rawInput: `${workerId} focus on the failing test first`,
    });

    assert.deepEqual(result, {
      kind: "success",
      text: dispatcherSteerSuccess(workerId),
    });
    assert.equal(await ctx.workerStatus(workerId, "s-1"), "steering");
    // Nothing delivered yet: delivery happens at the step boundary.
    assert.equal(ctx.sentMessages.length, 0);
  });

  it("delivers the parked steer at the step boundary as a parent correction", async () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const { workerId } = await activateWithRunningWorker(ctx);
    await ctx.runCommand({
      commandId: DISPATCHER_STEER_COMMAND,
      agent: createAgent("s-1"),
      rawInput: `${workerId} focus on the failing test first`,
    });

    ctx.endWorkerTurn(workerId);
    // The steer-injected transition lands after the sendMessage promise
    // resolves — give the microtask queue a tick.
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(ctx.sentMessages.length, 1);
    const sent = ctx.sentMessages[0];
    assert.ok(sent);
    assert.equal(sent.targetId, workerId);
    assert.match(sent.text, /\[Parent correction\]/);
    assert.match(sent.text, /focus on the failing test first/);
    // Delivery completes the steering step: back to running.
    assert.equal(await ctx.workerStatus(workerId, "s-1"), "running");
  });

});

describe("steer command — core refusal vocabulary", () => {
  it("refuses a settled worker with the core's not-running mapping", async () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const { workerId } = await activateWithRunningWorker(ctx);

    // Worker settles completed through the real host settle path.
    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "done" }],
    });
    assert.equal(await ctx.workerStatus(workerId, "s-1"), "completed");

    const result = await ctx.runCommand({
      commandId: DISPATCHER_STEER_COMMAND,
      agent: createAgent("s-1"),
      rawInput: `${workerId} one more thing`,
    });
    assert.deepEqual(result, {
      kind: "error",
      text: dispatcherSteerNotRunning(workerId),
    });
    assert.equal(ctx.sentMessages.length, 0);
  });
});

describe("steer command — HMR reversal", () => {
  it("dispose-all unregisters the steer command; nothing lingers", async () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    await activateWithRunningWorker(ctx);
    for (const dispose of [...ctx.disposers]) dispose();
    assert.equal(ctx.commandNames().includes(DISPATCHER_STEER_COMMAND), false);
  });
});

// Ticket 91's fail-loud duplicate-registration pin lives in
// test/plugin-scaffold.test.ts: it is one host rule, pinned once.

describe("steer command — localized copy (EN + ZH)", () => {
  it("the EN face is the shipped copy, byte-identical", () => {
    assert.equal(DISPATCHER_STEER_COPY_EN.description, DISPATCHER_STEER_DESCRIPTION);
    assert.equal(DISPATCHER_STEER_COPY_EN.inputHint, DISPATCHER_STEER_INPUT_HINT);
    assert.equal(DISPATCHER_STEER_COPY_EN.notActive, DISPATCHER_STEER_NOT_ACTIVE);
    assert.equal(DISPATCHER_STEER_COPY_EN.notDispatcher, DISPATCHER_STEER_NOT_DISPATCHER);
    assert.equal(
      DISPATCHER_STEER_COPY_EN.success("w-1"),
      dispatcherSteerSuccess("w-1"),
    );
    assert.equal(
      DISPATCHER_STEER_COPY_EN.notRunning("w-1"),
      dispatcherSteerNotRunning("w-1"),
    );
    assert.equal(dispatcherSteerCopy(undefined), DISPATCHER_STEER_COPY_EN);
    assert.equal(dispatcherSteerCopy("en"), DISPATCHER_STEER_COPY_EN);
  });

  it("answers a successful steer with ZH copy", async () => {
    const command = createDispatcherSteerCommand({
      ctx: {} as AdapterContext,
      activeSessionIds: () => ["s-1"],
      steer: async () => ({ ok: true }),
      language: () => "zh",
    });
    const result = await command.handler({
      agent: { session: { id: "s-1" } },
      rawInput: "w-1 先处理失败的测试",
    } as never);
    assert.deepEqual(result, {
      kind: "success",
      text: DISPATCHER_STEER_COPY_ZH.success("w-1"),
    });
    assert.equal(DISPATCHER_STEER_COPY_ZH.success("w-1"), "已为 w-1 排队纠偏。");
  });

  it("answers a refusal with ZH copy and never a raw reason enum", async () => {
    const command = createDispatcherSteerCommand({
      ctx: {} as AdapterContext,
      activeSessionIds: () => ["s-1"],
      steer: async () => ({
        ok: false,
        reason: "unknown-worker",
        detail: "unknown worker: w-gone",
      }),
      language: () => "zh",
    });
    const result = await command.handler({
      agent: { session: { id: "s-1" } },
      rawInput: "w-gone 继续",
    } as never);
    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_STEER_COPY_ZH.unknownWorker("w-gone"),
    });
    assert.equal(String(result.text).includes("unknown-worker"), false);
  });

  it("localizes the dormant/not-active faces too", async () => {
    const dormant = createDispatcherSteerCommand({
      ctx: {} as AdapterContext,
      activeSessionIds: () => [],
      steer: async () => ({ ok: true }),
      language: () => "zh",
    });
    const notActive = await dormant.handler({
      agent: { session: { id: "s-1" } },
      rawInput: "w-1 继续",
    } as never);
    assert.deepEqual(notActive, {
      kind: "error",
      text: DISPATCHER_STEER_COPY_ZH.notActive,
    });
    assert.doesNotMatch(DISPATCHER_STEER_COPY_ZH.notActive, /dispatcher is active/i);
  });
});
