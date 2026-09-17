/**
 * Ticket 22 — /dispatcher-steer host command routing into the existing core
 * steer queue (design-16 §4.3).
 *
 * Offline only (S8): fake AdapterContext seams (commands + tools registry,
 * listener bus, storage stub) driving the real plugin apply(), the real
 * CordisDshHost, and the real Multitask core. No network, no LLM, no
 * running dsh. test/steer-queue.test.ts keeps covering queue semantics —
 * these tests cover the command as an input path onto that queue.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../src/plugin.js";
import {
  DISPATCHER_START_COMMAND,
  DISPATCHER_STEER_COMMAND,
  DISPATCHER_STEER_DESCRIPTION,
  DISPATCHER_STEER_INPUT_HINT,
  DISPATCHER_STEER_NOT_ACTIVE,
  DISPATCHER_STEER_NOT_DISPATCHER,
  DISPATCHER_STEER_USAGE,
  dispatcherSteerNotRunning,
  dispatcherSteerSuccess,
  dispatcherSteerUnknownWorker,
  parseSteerInput,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
} from "../src/adapter/index.js";

function createAgent(
  id: string,
  opts?: { topLevel?: boolean },
): AgentLike {
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
        tools.set(definition.name, definition);
        return () => {
          tools.delete(definition.name);
        };
      },
    },
    subagents: {
      async startContinuable() {
        const childId = `child-${nextChild++}`;
        return { childId, messageId: `msg-${childId}` };
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
    /** Spawn a worker through the real dispatcher tool surface. */
    spawnWorker: async (sessionId: string): Promise<string> => {
      const spawn = tools.get("spawn_worker");
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
      const check = tools.get("check_workers");
      assert.ok(check);
      const value = (await check.execute(
        { worker_id: workerId },
        { agent: { session: { id: sessionId } } },
      )) as { ok: boolean; rows: Array<{ status: string }> };
      assert.equal(value.ok, true);
      assert.equal(value.rows.length, 1);
      return value.rows[0].status;
    },
    sentMessages,
  };
  return ctx as typeof ctx & AdapterContext;
}

async function activateWithRunningWorker(ctx: ReturnType<typeof createFullCtx>) {
  const agent = createAgent("s-1");
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
  it("flag OFF registers no steer command (fully inert)", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: false });
    assert.deepEqual(ctx.commandNames(), []);
  });

  it("flag ON registers dispatcher-start and dispatcher-steer exactly once", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    assert.deepEqual(ctx.commandNames(), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
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
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);
  });

  it("the command is namespaced under the dispatcher- prefix", () => {
    assert.equal(DISPATCHER_STEER_COMMAND, "dispatcher-steer");
    assert.match(DISPATCHER_STEER_COMMAND, /^dispatcher-/);
    assert.equal(
      DISPATCHER_STEER_DESCRIPTION,
      "Send a mid-run instruction to a running worker. The most recent " +
        "instruction wins.",
    );
    assert.equal(DISPATCHER_STEER_INPUT_HINT, "worker id, then your instruction");
  });
});

describe("steer command — activation gate", () => {
  it("refuses while dormant with not-active copy", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });

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

  it("refuses an invocation without a resolvable chat while dormant", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });

    const result = await ctx.runCommand({
      commandId: DISPATCHER_STEER_COMMAND,
      rawInput: "child-1 do the thing",
    });
    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_STEER_NOT_ACTIVE,
    });
  });

  it("refuses a different chat than the activated dispatcher", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    await ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: createAgent("s-1"),
    });

    const result = await ctx.runCommand({
      commandId: DISPATCHER_STEER_COMMAND,
      agent: createAgent("s-2"),
      rawInput: "child-1 do the thing",
    });
    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_STEER_NOT_DISPATCHER,
    });
  });

  it("refuses a non-top-level chat (a child chat never holds the activation)", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
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
  it("splits the first token as worker id and the rest as instruction", () => {
    assert.deepEqual(parseSteerInput("child-1 focus on the failing test"), {
      workerId: "child-1",
      instruction: "focus on the failing test",
    });
    assert.deepEqual(parseSteerInput("  child-1   first   "), {
      workerId: "child-1",
      instruction: "first",
    });
  });

  it("rejects missing, blank, or instruction-less input", () => {
    assert.equal(parseSteerInput(undefined), null);
    assert.equal(parseSteerInput(""), null);
    assert.equal(parseSteerInput("   "), null);
    assert.equal(parseSteerInput("child-1"), null);
    assert.equal(parseSteerInput("child-1    "), null);
  });

  it("refuses empty instructions with usage copy", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    await ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: createAgent("s-1"),
    });

    for (const rawInput of [undefined, "", "   ", "child-1"]) {
      const result = await ctx.runCommand({
        commandId: DISPATCHER_STEER_COMMAND,
        agent: createAgent("s-1"),
        rawInput,
      });
      assert.deepEqual(result, { kind: "error", text: DISPATCHER_STEER_USAGE });
    }
  });
});

describe("steer command — routes into the existing core steer queue", () => {
  it("queues the instruction, flips running → steering, returns success copy", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
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
    apply(ctx, { enabled: true });
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
    assert.equal(ctx.sentMessages[0].targetId, workerId);
    assert.match(ctx.sentMessages[0].text, /\[Parent correction\]/);
    assert.match(ctx.sentMessages[0].text, /focus on the failing test first/);
    // Delivery completes the steering step: back to running.
    assert.equal(await ctx.workerStatus(workerId, "s-1"), "running");
  });

  it("keeps core last-wins: two queued steers deliver only the latest", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const { workerId } = await activateWithRunningWorker(ctx);

    const first = await ctx.runCommand({
      commandId: DISPATCHER_STEER_COMMAND,
      agent: createAgent("s-1"),
      rawInput: `${workerId} first instruction`,
    });
    assert.equal(first.kind, "success");
    // Worker is now steering; a second steer re-parks the slot without
    // re-interrupting (core semantics — untouched by the command).
    const second = await ctx.runCommand({
      commandId: DISPATCHER_STEER_COMMAND,
      agent: createAgent("s-1"),
      rawInput: `${workerId} second instruction`,
    });
    assert.equal(second.kind, "success");

    ctx.endWorkerTurn(workerId);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(ctx.sentMessages.length, 1);
    assert.match(ctx.sentMessages[0].text, /second instruction/);
    assert.doesNotMatch(ctx.sentMessages[0].text, /first instruction/);
  });
});

describe("steer command — core refusal vocabulary", () => {
  it("refuses an unknown worker with the core's unknown-worker mapping", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    await ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: createAgent("s-1"),
    });

    const result = await ctx.runCommand({
      commandId: DISPATCHER_STEER_COMMAND,
      agent: createAgent("s-1"),
      rawInput: "nope-1 do the thing",
    });
    assert.deepEqual(result, {
      kind: "error",
      text: dispatcherSteerUnknownWorker("nope-1"),
    });
  });

  it("refuses a settled worker with the core's not-running mapping", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
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
  it("dispose-all unregisters the command; nothing lingers", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    await activateWithRunningWorker(ctx);
    assert.deepEqual(ctx.commandNames(), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);

    for (const dispose of [...ctx.disposers]) {
      dispose();
    }

    assert.deepEqual(ctx.commandNames(), []);
    await assert.rejects(
      () =>
        ctx.runCommand({
          commandId: DISPATCHER_STEER_COMMAND,
          agent: createAgent("s-1"),
          rawInput: "child-1 do the thing",
        }),
      /command not registered/,
    );
  });
});
