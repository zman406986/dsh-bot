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
  DISPATCHER_START_ALREADY_HERE,
  DISPATCHER_START_COMMAND,
  DISPATCHER_START_DESCRIPTION,
  DISPATCHER_START_NOT_TOP_LEVEL,
  DISPATCHER_START_SUCCESS,
  DISPATCHER_START_UNRESOLVED,
  DISPATCHER_STEER_COMMAND,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
  type ToolsLike,
} from "../src/adapter/index.js";

interface TestAgent extends AgentLike {
  readonly injected: unknown[];
}

/**
 * A per-agent scoped tool surface (ADR-0019): what the live host mints per
 * agent loop. Registrations here are visible only to THIS agent.
 */
interface ScopedAgent extends TestAgent {
  readonly ctx?: {
    readonly tools: ToolsLike & {
      registeredNames(): string[];
    };
  };
}

function createScopedAgent(id: string): ScopedAgent {
  const agent = createAgent(id) as ScopedAgent;
  const scoped = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  agent.ctx = {
    tools: {
      schemas: () => [...scoped.keys()].map((name) => ({ name })),
      register(definition: {
        name: string;
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      }) {
        scoped.set(definition.name, definition);
        return () => {
          scoped.delete(definition.name);
        };
      },
      registeredNames: () => [...scoped.keys()],
    },
  };
  return agent;
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
    // Cordis effect contract (ticket 44): `execute` runs at apply; a returned
    // function — or each value a generator yields — is the unload disposer.
    // (The old inverted fake collected the passed function itself, which hid
    // the live self-unregister bug.)
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

    // The visible affordances are the host commands (ticket 22 added the
    // steer command; its handler gates on activation).
    assert.deepEqual(ctx.commandNames(), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);
    assert.deepEqual(ctx.toolNames(), []);
  });

  // Ticket 32: the dormant-registration matrix. Tickets 27–31 (snapshot v2,
  // panel sections, live activity, approval UX, restart rebuild) all landed
  // after this matrix was written; the dormant surface must remain exactly
  // the two commands with the passive listeners and no tool surface. The
  // negative assertions pin the absence, so a future ticket cannot quietly
  // register a dormant-visible surface.
  it("tickets 27–31 add no dormant-visible registration: no tools, no listeners beyond the passive four", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });

    assert.deepEqual(ctx.commandNames().sort(), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);
    assert.deepEqual(ctx.toolNames(), []);
    // Two lifecycle listeners (agent/disposed, agent/status) + two host
    // listeners (subagent/end, session/event) — unchanged by 27–31.
    assert.equal(ctx.listenerCount(), 4);
    // No dispatcher tool claims a dormant key: a stock caller sees stock.
    for (const name of [
      "spawn_worker",
      "check_workers",
      "steer_worker",
      "stop_worker",
      "deliver_result",
      "request_access",
    ]) {
      assert.equal(ctx.tool(name), undefined, `${name} must not be dormant`);
    }
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

  it("a second chat activates as its own dispatcher (ADR-0019: no single slot)", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const first = createAgent("s-1");
    const second = createAgent("s-2");

    assert.deepEqual(ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first }), {
      kind: "success",
      text: DISPATCHER_START_SUCCESS,
    });
    // ADR-0019 retired the `already-active-elsewhere` refusal: each chat
    // activates its own dispatcher session with its own policy inject.
    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: second,
    });

    assert.deepEqual(result, {
      kind: "success",
      text: DISPATCHER_START_SUCCESS,
    });
    assert.equal(second.injected.length, 1);
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

  it("the commands are namespaced and advertise their descriptions", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    assert.deepEqual(ctx.commandNames(), [
      "dispatcher-start",
      "dispatcher-steer",
    ]);
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

describe("activation lifecycle — dispatcher tool surface (ADR-0019)", () => {
  it("activation registers the five tools in the agent's SCOPED surface; request_access stays global", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const agent = createScopedAgent("s-1");

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.deepEqual(result, { kind: "success", text: DISPATCHER_START_SUCCESS });

    // Five dispatcher tools live in THIS agent's scope only…
    assert.deepEqual(
      agent.ctx?.tools.registeredNames().sort(),
      [
        "check_workers",
        "deliver_result",
        "spawn_worker",
        "steer_worker",
        "stop_worker",
      ],
    );
    // …and only request_access claims a global name (its callers are workers).
    assert.deepEqual(ctx.toolNames(), ["request_access"]);
  });

  it("a scoped dispatcher's tools never appear in a sibling chat's surface", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const first = createScopedAgent("s-1");
    const second = createScopedAgent("s-2");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first });
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: second });

    // Two dispatcher sessions, two disjoint scoped surfaces.
    assert.equal(first.ctx?.tools.registeredNames().length, 5);
    assert.equal(second.ctx?.tools.registeredNames().length, 5);
    assert.deepEqual(ctx.toolNames(), ["request_access"]);
  });

  it("disposing one session unregisters its scoped set, not the sibling's", () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const first = createScopedAgent("s-1");
    const second = createScopedAgent("s-2");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first });
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: second });

    ctx.fire("agent/disposed", { agent: first });

    assert.deepEqual(first.ctx?.tools.registeredNames(), []);
    assert.equal(second.ctx?.tools.registeredNames().length, 5);
    // request_access stays until the LAST dispatcher session ends.
    assert.deepEqual(ctx.toolNames(), ["request_access"]);
    ctx.fire("agent/disposed", { agent: second });
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("the retired execute-time gate no longer refuses other chats (fallback surface)", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });

    const spawn = ctx.tool("spawn_worker");
    assert.ok(spawn);

    // ADR-0019 retired the gate: this ctx-less agent fell back to the global
    // surface, and execution routes to the session that registered the tool
    // (s-1). The per-agent scope is the live host's visibility fence.
    const routed = (await spawn.execute(
      { stream_key: "k", title: "T", prompt: "P" },
      { agent: { session: { id: "other-chat" } } },
    )) as { ok: boolean };
    assert.equal(routed.ok, true);

    const accepted = (await spawn.execute(
      { stream_key: "k2", title: "T", prompt: "P" },
      { agent: { session: { id: "s-1" } } },
    )) as { ok: boolean };
    assert.equal(accepted.ok, true);
  });

  it("an unresolvable exec still reaches the core", async () => {
    const ctx = createFullCtx();
    apply(ctx, { enabled: true });
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });

    const check = ctx.tool("check_workers");
    assert.ok(check);

    const allowed = (await check.execute({}, undefined)) as { ok: boolean };
    assert.equal(allowed.ok, true);
  });

  it("workers spawned through the surface are host children of the activated chat", async () => {
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
