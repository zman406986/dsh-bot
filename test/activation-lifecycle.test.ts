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
import {DISPATCHER_START_COMMAND, DISPATCHER_START_NOT_TOP_LEVEL, DISPATCHER_START_SUCCESS, DISPATCHER_START_UNRESOLVED, DISPATCHER_STEER_COMMAND, type AdapterContext, type AgentLike, type CommandDefinitionLike, type CommandResultLike, type ToolsLike} from "../src/adapter/index.js";

interface TestAgent extends AgentLike {
  readonly injected: unknown[];
}

/**
 * A per-agent scoped tool surface (ADR-0019): what the live host mints per
 * agent loop. Registrations here are visible only to THIS agent. The plugin
 * refuses the retired process-global fallback, so ordinary test agents carry
 * one.
 */
interface ScopedToolSurface extends ToolsLike {
  registeredNames(): string[];
  get(
    name: string,
  ): { execute: (args: unknown, exec?: unknown) => Promise<unknown> } | undefined;
}

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
      // Shipped rule: duplicate tool name throws
      // (dsh-tools lib/index.js:2538, NamedEntries factory).
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
    registeredNames: () => [...scoped.keys()],
    get: (name) => scoped.get(name),
  };
}

interface ScopedAgent extends TestAgent {
  readonly ctx?: {
    readonly tools: ScopedToolSurface;
  };
}

function createScopedAgent(id: string): ScopedAgent {
  return createAgent(id) as ScopedAgent;
}

function createAgent(
  id: string,
  opts?: { topLevel?: boolean; withInject?: boolean; withScopedTools?: boolean },
): TestAgent & { ctx?: { tools: ScopedToolSurface } } {
  const topLevel = opts?.topLevel ?? true;
  const injected: unknown[] = [];
  const withScoped = opts?.withScopedTools ?? true;
  const agent: TestAgent & { ctx?: { tools: ScopedToolSurface } } = {
    session: {
      id,
      header: topLevel
        ? { parentSession: null, delegationDepth: 0 }
        : { parentSession: "parent-x", delegationDepth: 1 },
    },
    followup() {},
    injected,
    ...(withScoped
      ? { ctx: { tools: createScopedTools() } }
      : {}),
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
      DISPATCHER_STEER_COMMAND,
      // "dsh-bot" sorts after the dispatcher- names (ADR-0030 rename).
      DISPATCHER_START_COMMAND,
    ]);
    assert.deepEqual(ctx.toolNames(), []);
    // Two lifecycle listeners (agent/disposed, agent/status) + four host
    // listeners (subagent/end, session/event, agent/created — the worker
    // composition seam, passive until a spawn is in flight — and agent/disposed,
    // the resumed-user-dispatcher release from ticket 163 defect 3). Owner
    // ruling 2026-11-05: the ticket-145 racoons mount adds four more, but only
    // when `racoonsEnabled` is on — the default product is racoons-free.
    assert.equal(ctx.listenerCount(), 6);
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
    // Full dispatcher surface in the agent's OWN scope: eight tools (ticket
    // 117 added await_agent, ticket 118 added spawn_dispatcher). Owner ruling
    // 2026-11-05: the ticket-145 per-session `recall` is absent by default —
    // racoons is off unless `racoonsEnabled` turns it on. Ticket 174 /
    // ADR-0033 removed the global `request_access`.
    assert.deepEqual(agent.ctx?.tools.registeredNames().sort(), [
      "await_agent",
      "check_workers",
      "deliver_result",
      "message_agent",
      "spawn_dispatcher",
      "spawn_worker",
      "steer_worker",
      "stop_worker",
    ]);
    // Nothing claims a process-global name.
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("the context-less path refuses the global fallback instead of leaking tools", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    // A host without `agent.ctx.tools` is a wiring bug. The plugin must not
    // register the dispatcher tools on the process-global registry (that
    // exposed them to every session and closed over one session id).
    const first = createAgent("s-1", { withScopedTools: false });
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first });
    assert.deepEqual(ctx.toolNames(), []);
    assert.equal(first.injected.length, 1, "activation itself still stands");

    // A second bare session is not a duplicate registration (nothing was
    // registered at all).
    const second = createAgent("s-2", { withScopedTools: false });
    assert.doesNotThrow(() =>
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: second }),
    );
    assert.deepEqual(ctx.toolNames(), []);
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

});

describe("activation lifecycle — deactivation and HMR", () => {
  it("agent/disposed unbinds; a later command re-activates fresh", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");

    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.equal(agent.ctx?.tools.registeredNames().length, 8);

    ctx.fire("agent/disposed", { agent });
    assert.deepEqual(agent.ctx?.tools.registeredNames(), []);

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
    assert.equal(agent.ctx?.tools.registeredNames().length, 8);
  });

  it("dispose-all (HMR simulation) leaves no lingering binding or surface", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.equal(agent.ctx?.tools.registeredNames().length, 8);

    for (const dispose of [...ctx.disposers]) {
      dispose();
    }

    assert.deepEqual(ctx.commandNames(), []);
    assert.deepEqual(agent.ctx?.tools.registeredNames(), []);
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
  it("activation registers the eight tools in the agent's SCOPED surface, with no global tool", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createScopedAgent("s-1");

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.deepEqual(result, { kind: "success", text: DISPATCHER_START_SUCCESS });

    // The eight dispatcher tools live in THIS agent's scope only. Owner
    // ruling 2026-11-05: the ticket-145 per-session `recall` is absent by
    // default — racoons is off unless `racoonsEnabled` turns it on.
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
    // …and nothing claims a global name (ticket 174 / ADR-0033 removed the
    // one global `request_access`).
    assert.deepEqual(ctx.toolNames(), []);
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
    // The sibling's surface is untouched, and no global tool exists to leak
    // past a session (ticket 174 / ADR-0033 removed `request_access`).
    assert.deepEqual(ctx.toolNames(), []);
    ctx.fire("agent/disposed", { agent: second });
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("workers spawned through the surface are host children of the activated chat", async () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });

    const spawn = agent.ctx?.tools.get("spawn_worker");
    assert.ok(spawn);
    const value = (await spawn.execute(
      { stream_key: "k", title: "T", prompt: "P" },
      { agent: { session: { id: "s-1" } } },
    )) as { ok: boolean; worker_id: string };
    assert.equal(value.ok, true);
    assert.match(value.worker_id, /^child-/);
  });
});
