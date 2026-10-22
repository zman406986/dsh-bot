/**
 * Ticket 19 — activation lifecycle end to end (ADR-0009, design-16 §3.3/§3.7).
 *
 * Offline only (S8): fake AdapterContext seams (commands + tools registry,
 * listener bus, storage stub) driving the real plugin apply() and the real
 * CordisDshHost. No network, no LLM, no running dsh.
 *
 * Fake-vs-host (ticket 91): the command and tool registries here (both the
 * plugin-level `ctx` and the per-agent scoped `agent.ctx.tools` surface) are
 * fail-loud on a duplicate name, like the shipped `NamedEntries` tables
 * (`@deepseek-ai/dsh-commands/lib/index.js:82`,
 * `@deepseek-ai/dsh-tools/lib/index.js:2538`). A double registration now
 * aborts the fake's apply/activation instead of silently overwriting.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import {
  DISPATCHER_START_ALREADY_HERE,
  DISPATCHER_RESOLVE_COMMAND,
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
        // Shipped rule: duplicate tool name throws
        // (dsh-tools lib/index.js:2538, NamedEntries factory).
        if (scoped.has(definition.name)) {
          throw new Error(
            `tool "${definition.name}" is already registered (for a ` +
              `per-agent variant, register through that agent's ` +
              `\`agent.ctx\` instead)`,
          );
        }
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
        // Shipped rule: duplicate command name throws
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
        // Shipped rule: duplicate tool name throws
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
    apply(ctx, volatileConfig({ enabled: false }));

    assert.deepEqual(ctx.commandNames(), []);
    assert.deepEqual(ctx.toolNames(), []);
    assert.equal(ctx.listenerCount(), 0);
    assert.equal(ctx.disposers.length, 0);
    // A simulated session-start is invisible to the plugin.
    ctx.fire("agent/session-start", { agent: createAgent("s-1") });
  });

  it("flag ON boots dormant: no capture, one command, no tools", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    // Stock dsh boot: the first top-level session is NOT repurposed.
    const agent = createAgent("s-1");
    ctx.fire("agent/session-start", { agent });
    assert.equal(agent.injected.length, 0);

    // The visible affordances are the host commands (ticket 22 added the
    // steer command, ticket 69 the resolve command; ticket 101's stop
    // command was withdrawn by ADR-0030 — ticket 129). All handlers gate on
    // activation where it matters.
    assert.deepEqual(ctx.commandNames(), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
      DISPATCHER_RESOLVE_COMMAND,
    ]);
    assert.deepEqual(ctx.toolNames(), []);
  });

  // Ticket 32: the dormant-registration matrix. Tickets 27–31 (snapshot v2,
  // panel sections, live activity, approval UX, restart rebuild) all landed
  // after this matrix was written; the dormant surface must remain exactly
  // the host commands with the passive listeners and no tool surface. The
  // negative assertions pin the absence, so a future ticket cannot quietly
  // register a dormant-visible surface.
  it("tickets 27–31 add no dormant-visible registration: no tools, no listeners beyond the passive five", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    assert.deepEqual(ctx.commandNames().sort(), [
      DISPATCHER_RESOLVE_COMMAND,
      DISPATCHER_STEER_COMMAND,
      // "dsh-bot" sorts after the dispatcher- names (ADR-0030 rename).
      DISPATCHER_START_COMMAND,
    ]);
    assert.deepEqual(ctx.toolNames(), []);
    // Two lifecycle listeners (agent/disposed, agent/status) + three host
    // listeners (subagent/end, session/event, agent/created — the worker
    // composition seam, passive until a spawn is in flight).
    assert.equal(ctx.listenerCount(), 5);
    // No dispatcher tool claims a dormant key: a stock caller sees stock.
    for (const name of [
      "spawn_worker",
      "check_workers",
      "steer_worker",
      "stop_worker",
      "deliver_result",
      "message_agent",
      "await_agent",
      "spawn_dispatcher",
      "request_access",
    ]) {
      assert.equal(ctx.tool(name), undefined, `${name} must not be dormant`);
    }
  });
});

describe("activation lifecycle — command behavior", () => {
  it("activation binds the parent once, injects policy once, registers tools", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });

    assert.deepEqual(result, { kind: "success", text: DISPATCHER_START_SUCCESS });
    assert.equal(agent.injected.length, 1);
    assert.ok(textOf(agent.injected[0]).includes("# Multitask dispatcher"));
    // Full dispatcher surface: eight tools (ticket 117 added await_agent,
    // ticket 118 added spawn_dispatcher) + request_access.
    assert.deepEqual(ctx.toolNames().sort(), [
      "await_agent",
      "check_workers",
      "deliver_result",
      "message_agent",
      "request_access",
      "spawn_dispatcher",
      "spawn_worker",
      "steer_worker",
      "stop_worker",
    ]);
  });

  it("second activation in the same chat succeeds with already-active copy", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
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
    assert.equal(ctx.toolNames().length, 9);
  });

  it("a second chat activates as its own dispatcher (ADR-0019: no single slot)", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    // Ticket 91: the LIVE shape — every agent loop mints `agent.ctx`
    // (dsh-agent-loop/lib/index.js:761-762 `this.ctx = this.scope.ctx`;
    // dsh-agent runtime-types.d.ts:149 makes `ctx` required), so each chat's
    // tool surface lands in its OWN scope layer and a second activation is
    // collision-free. Driving this with context-less stub agents instead
    // would take the plugin-level fallback, which is documented as the
    // single-dispatcher shape (src/plugin.ts:475-487) and is pinned as such
    // in the test below.
    const first = createScopedAgent("s-1");
    const second = createScopedAgent("s-2");

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
    // Each chat owns its own scoped tool surface — no cross-session names.
    assert.equal(first.ctx?.tools.registeredNames().length, 8);
    assert.equal(second.ctx?.tools.registeredNames().length, 8);
    assert.equal(ctx.toolNames().length, 1); // request_access, global by design
  });

  it("the context-less fallback is single-session: a second chat hits the host duplicate error (ticket 91)", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    // Context-less agents take the plugin-level global fallback
    // (src/plugin.ts:480-486). That shape holds ONE tool surface, so a second
    // dispatcher session collides on the same names. Live hosts cannot reach
    // this (every agent loop mints `agent.ctx`), but the offline suite must
    // not pretend the fallback scales: the shipped registry throws, and the
    // old permissive fake silently REPLACED the first session's closures
    // (mis-routing its calls). Pinned loud, not silent.
    const first = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first });
    assert.equal(ctx.toolNames().length, 9);

    assert.throws(
      () =>
        ctx.runCommand({
          commandId: DISPATCHER_START_COMMAND,
          agent: createAgent("s-2"),
        }),
      /tool "spawn_worker" is already registered/,
    );
  });

  it("activation in a child chat is refused with not-top-level copy", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
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
    apply(ctx, volatileConfig({ enabled: true }));

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
    apply(ctx, volatileConfig({ enabled: true }));
    assert.deepEqual(ctx.commandNames(), [
      "dsh-bot",
      "dispatcher-steer",
      "dispatcher-resolve",
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
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");

    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.equal(ctx.toolNames().length, 9);

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
    assert.equal(ctx.toolNames().length, 9);
  });

  it("dispose-all (HMR simulation) leaves no lingering binding or surface", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.equal(ctx.toolNames().length, 9);

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
  it("activation registers the eight tools in the agent's SCOPED surface; request_access stays global", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createScopedAgent("s-1");

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.deepEqual(result, { kind: "success", text: DISPATCHER_START_SUCCESS });

    // Eight dispatcher tools live in THIS agent's scope only…
    assert.deepEqual(
      agent.ctx?.tools.registeredNames().sort(),
      [
        "await_agent",
        "check_workers",
        "deliver_result",
        "message_agent",
        "spawn_dispatcher",
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
    apply(ctx, volatileConfig({ enabled: true }));
    const first = createScopedAgent("s-1");
    const second = createScopedAgent("s-2");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first });
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: second });

    // Two dispatcher sessions, two disjoint scoped surfaces.
    assert.equal(first.ctx?.tools.registeredNames().length, 8);
    assert.equal(second.ctx?.tools.registeredNames().length, 8);
    assert.deepEqual(ctx.toolNames(), ["request_access"]);
  });

  it("disposing one session unregisters its scoped set, not the sibling's", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const first = createScopedAgent("s-1");
    const second = createScopedAgent("s-2");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first });
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: second });

    ctx.fire("agent/disposed", { agent: first });

    assert.deepEqual(first.ctx?.tools.registeredNames(), []);
    assert.equal(second.ctx?.tools.registeredNames().length, 8);
    // request_access stays until the LAST dispatcher session ends.
    assert.deepEqual(ctx.toolNames(), ["request_access"]);
    ctx.fire("agent/disposed", { agent: second });
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("the retired execute-time gate no longer refuses other chats (fallback surface)", async () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
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
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });

    const check = ctx.tool("check_workers");
    assert.ok(check);

    const allowed = (await check.execute({}, undefined)) as { ok: boolean };
    assert.equal(allowed.ok, true);
  });

  it("workers spawned through the surface are host children of the activated chat", async () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
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
