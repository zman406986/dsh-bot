/**
 * Ticket 19 — activation lifecycle end to end (ADR-0009, design-16 §3.3/§3.7).
 *
 * Offline only (S8): fake AdapterContext seams (commands + tools registry,
 * listener bus, storage stub) driving the real plugin apply() and the real
 * CordisDshHost. No network, no LLM, no running dsh.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../src/plugin.js";
import {
  DISPATCHER_START_ALREADY_ELSEWHERE,
  DISPATCHER_START_ALREADY_HERE,
  DISPATCHER_START_COMMAND,
  DISPATCHER_START_DESCRIPTION,
  DISPATCHER_START_NOT_TOP_LEVEL,
  DISPATCHER_START_SUCCESS,
  DISPATCHER_START_UNRESOLVED,
  DISPATCHER_TOOL_GATE_REFUSAL,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
} from "../src/adapter/index.js";

interface TestAgent extends AgentLike {
  readonly injected: unknown[];
}

function createAgent(
  id: string,
  opts?: { topLevel?: boolean; withInject?: boolean },
): TestAgent {
  const topLevel = opts?.topLevel ?? true;
  const injected: unknown[] = [];
  const agent: TestAgent = {
    session: {
      id,
      header: topLevel
        ? { parentSession: null, delegationDepth: 0 }
        : { parentSession: "parent-x", delegationDepth: 1 },
    },
    followup() {},
    injected,
    ...(opts?.withInject === false
      ? {}
      : {
          inject(message: unknown) {
            injected.push(message);
          },
        }),
  };
  return agent;
}

function createFullCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const tables = new Map<string, Map<string, unknown>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const disposers: Array<() => void> = [];
  let nextChild = 1;

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
    }
  };

  const ctx = {
    effect(dispose: () => void) {
      disposers.push(dispose);
    },
    // Settings-section optional inject: no settings service in this stub.
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
            tables.set(`t${tables.size}`, t);
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
    commandNames: () => [...commands.keys()],
    toolNames: () => [...tools.keys()],
    tool: (name: string) => tools.get(name),
    listenerCount: () => {
      let total = 0;
      for (const list of listeners.values()) total += list.length;
      return total;
    },
    runCommand(
      invocation: { commandId: string; agent?: AgentLike },
    ): CommandResultLike {
      const command = commands.get(invocation.commandId);
      if (command === undefined) {
        throw new Error(`command not registered: ${invocation.commandId}`);
      }
      return command.handler(invocation as never) as CommandResultLike;
    },
  };
  return ctx as typeof ctx & AdapterContext;
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

describe("activation lifecycle — flag matrix (design-16 §3.7)", () => {
  it("flag OFF is fully inert: no command, no tools, no listeners", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: false });

    assert.deepEqual(ctx.commandNames(), []);
    assert.deepEqual(ctx.toolNames(), []);
    assert.equal(ctx.listenerCount(), 0);
    assert.equal(ctx.disposers.length, 0);
    // A simulated session-start is invisible to the plugin.
    ctx.fire("agent/session-start", { agent: createAgent("s-1") });
  });

  it("flag ON boots dormant: no capture, one command, no tools", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });

    // Stock dsh boot: the first top-level session is NOT repurposed.
    const agent = createAgent("s-1");
    ctx.fire("agent/session-start", { agent });
    assert.equal(agent.injected.length, 0);

    // The only visible affordance is the activation command.
    assert.deepEqual(ctx.commandNames(), [DISPATCHER_START_COMMAND]);
    assert.deepEqual(ctx.toolNames(), []);
  });
});

describe("activation lifecycle — command behavior", () => {
  it("activation binds the parent once, injects policy once, registers tools", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const agent = createAgent("s-1");

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });

    assert.deepEqual(result, { kind: "success", text: DISPATCHER_START_SUCCESS });
    assert.equal(agent.injected.length, 1);
    assert.ok(textOf(agent.injected[0]).includes("# Multitask dispatcher"));
    // Full dispatcher surface: five tools + request_access.
    assert.deepEqual(ctx.toolNames().sort(), [
      "check_workers",
      "deliver_result",
      "request_access",
      "spawn_worker",
      "steer_worker",
      "stop_worker",
    ]);
  });

  it("second activation in the same chat succeeds with already-active copy", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const agent = createAgent("s-1");

    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    const again = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });

    assert.deepEqual(again, {
      kind: "success",
      text: DISPATCHER_START_ALREADY_HERE,
    });
    // No re-bind, no re-inject, no duplicate tools.
    assert.equal(agent.injected.length, 1);
    assert.equal(ctx.toolNames().length, 6);
  });

  it("activation while active elsewhere is refused with error copy", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const first = createAgent("s-1");
    const second = createAgent("s-2");

    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first });
    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: second,
    });

    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_START_ALREADY_ELSEWHERE,
    });
    assert.equal(second.injected.length, 0);
    assert.equal(first.injected.length, 1);
  });

  it("activation in a child chat is refused with not-top-level copy", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const child = createAgent("child-1", { topLevel: false });

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: child,
    });

    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_START_NOT_TOP_LEVEL,
    });
    assert.equal(child.injected.length, 0);
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("an invocation without a resolvable agent is refused, never guessed", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
    });

    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_START_UNRESOLVED,
    });
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("the command is namespaced and advertises its description", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    assert.deepEqual(ctx.commandNames(), ["dispatcher-start"]);
    assert.equal(
      DISPATCHER_START_DESCRIPTION,
      "Turn this chat into the multitask dispatcher for this session.",
    );
  });
});

describe("activation lifecycle — deactivation and HMR", () => {
  it("agent/disposed unbinds; a later command re-activates fresh", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const agent = createAgent("s-1");

    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.equal(ctx.toolNames().length, 6);

    ctx.fire("agent/disposed", { agent });
    assert.deepEqual(ctx.toolNames(), []);

    // Re-consent is deliberate: another explicit command re-attaches.
    const again = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.deepEqual(again, {
      kind: "success",
      text: DISPATCHER_START_SUCCESS,
    });
    assert.equal(agent.injected.length, 2);
    assert.equal(ctx.toolNames().length, 6);
  });

  it("dispose-all (HMR simulation) leaves no lingering binding or surface", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.equal(ctx.toolNames().length, 6);

    for (const dispose of [...ctx.disposers]) {
      dispose();
    }

    assert.deepEqual(ctx.commandNames(), []);
    assert.deepEqual(ctx.toolNames(), []);
    assert.equal(ctx.listenerCount(), 0);
    // The command itself is unregistered: nothing lingers to activate with.
    assert.throws(
      () =>
        ctx.runCommand({
          commandId: DISPATCHER_START_COMMAND,
          agent,
        }),
      /command not registered/,
    );
  });
});

describe("activation lifecycle — dispatcher tool gate", () => {
  it("tools accept the activated chat and refuse other chats", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });

    const spawn = ctx.tool("spawn_worker");
    assert.ok(spawn);

    const refused = (await spawn.execute(
      { stream_key: "k", title: "T", prompt: "P" },
      { agent: { session: { id: "other-chat" } } },
    )) as { ok: boolean; reason: string; detail: string };
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "not-activated");
    assert.equal(refused.detail, DISPATCHER_TOOL_GATE_REFUSAL);

    const accepted = (await spawn.execute(
      { stream_key: "k", title: "T", prompt: "P" },
      { agent: { session: { id: "s-1" } } },
    )) as { ok: boolean };
    assert.equal(accepted.ok, true);
  });

  it("an unresolvable exec falls back to the activation-exists gate", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });

    const check = ctx.tool("check_workers");
    assert.ok(check);

    // No exec shape at all: the weaker documented gate applies — an
    // activation exists, so the call is not refused on shape grounds.
    const allowed = (await check.execute({}, undefined)) as { ok: boolean };
    assert.equal(allowed.ok, true);
  });

  it("workers spawned through the gate are host children of the activated chat", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });

    const spawn = ctx.tool("spawn_worker");
    assert.ok(spawn);
    const value = (await spawn.execute(
      { stream_key: "k", title: "T", prompt: "P" },
      { agent: { session: { id: "s-1" } } },
    )) as { ok: boolean; worker_id: string };
    assert.equal(value.ok, true);
    assert.match(value.worker_id, /^child-/);
  });
});
