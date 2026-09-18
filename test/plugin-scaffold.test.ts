import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Config, apply, inject, name } from "../src/plugin.js";
import {
  DISPATCHER_START_COMMAND,
  DISPATCHER_STEER_COMMAND,
} from "../src/adapter/index.js";
import type {
  AdapterContext,
  AgentLike,
  CommandDefinitionLike,
} from "../src/adapter/cordis-dsh-host.js";

function createAgent(id: string): AgentLike {
  return {
    session: { id, header: { parentSession: null, delegationDepth: 0 } },
    followup() {},
    inject() {},
  };
}

function createStubCtx(): AdapterContext & {
  effect: (execute: () => unknown, label?: string) => unknown;
  inject: (
    services: readonly string[],
    callback: (child: Record<string, never>) => void,
  ) => void;
  disposers: Array<() => void>;
  listeners: Map<string, Array<(payload: never) => void>>;
  commands: {
    register(definition: CommandDefinitionLike): () => void;
  };
  registeredCommands: CommandDefinitionLike[];
  registeredTools: Array<{ name: string }>;
  /** Variadic: some buses pass extra args (session/event is two-arg). */
  fire(name: string, ...payloads: unknown[]): void;
  runCommand(inv: { commandId: string; agent: AgentLike }): void;
} {
  const disposers: Array<() => void> = [];
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const tables = new Map<string, Map<string, unknown>>();
  const registeredCommands: CommandDefinitionLike[] = [];
  const registeredTools: Array<{ name: string } & {
    execute: (args: unknown, exec?: unknown) => Promise<unknown>;
  }> = [];

  const fire = (name: string, ...payloads: unknown[]) => {
    for (const cb of listeners.get(name) ?? []) {
      (cb as (...args: unknown[]) => void)(...payloads);
    }
  };

  const ctx = {
    disposers,
    listeners,
    registeredCommands,
    registeredTools,
    // Cordis effect contract (ticket 44): `execute` runs at apply; a returned
    // function — or each value a generator yields — is the unload disposer.
    // (The old inverted fake collected the passed function itself, which hid
    // the live self-unregister bug: a regression to `ctx.effect(disposer)`
    // now fails the registered-command assertions below.)
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
    // No settings service in this stub — Cordis-style optional inject no-ops.
    inject() {},
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        const remaining = (listeners.get(name) ?? []).filter((c) => c !== cb);
        listeners.set(name, remaining);
      };
    },
    commands: {
      register(definition: CommandDefinitionLike) {
        registeredCommands.push(definition);
        return () => {
          const at = registeredCommands.indexOf(definition);
          if (at >= 0) registeredCommands.splice(at, 1);
        };
      },
    },
    tools: {
      schemas: () => registeredTools.map((tool) => ({ name: tool.name })),
      register(definition: { name: string } & {
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      }) {
        registeredTools.push(definition);
        return () => {
          const at = registeredTools.indexOf(definition);
          if (at >= 0) registeredTools.splice(at, 1);
        };
      },
    },
    fire,
    runCommand(inv: { commandId: string; agent: AgentLike }) {
      const command = registeredCommands.find(
        (c) => c.name === inv.commandId,
      );
      if (command === undefined) {
        throw new Error(`command not registered: ${inv.commandId}`);
      }
      void command.handler(inv);
    },
    subagents: {
      async startContinuable() {
        return { childId: "child-stub" };
      },
      interrupt() {},
      async sendMessage() {
        return "msg-stub";
      },
    },
    agents: {
      get() {
        return undefined;
      },
    },
    jobs: {
      list() {
        return [];
      },
    },
    storageDomain: {
      async open() {
        const name = "multitask_dispatcher";
        let table = tables.get("worker_markers");
        if (table === undefined) {
          table = new Map();
          tables.set("worker_markers", table);
        }
        const t = table;
        return {
          table() {
            return {
              get(key: string) {
                return t.get(key) as never;
              },
              entries() {
                return t.entries() as never;
              },
              async put(key: string, value: unknown) {
                t.set(key, value);
              },
              async delete(key: string) {
                return t.delete(key);
              },
            };
          },
          async close() {},
          name,
        };
      },
    },
  };
  return ctx as typeof ctx & AdapterContext;
}

describe("plugin scaffold", () => {
  it("exports the Cordis plugin contract", () => {
    assert.equal(name, "multitask-dispatcher");
    assert.deepEqual(inject, [
      "subagents",
      "agents",
      "jobs",
      "storageDomain",
      "tools",
      "commands",
      "userQuestions",
    ]);
    assert.ok(Config);
  });

  it("apply registers through ctx.effect and the disposer is callable", () => {
    const ctx = createStubCtx();

    apply(ctx, { enabled: true });
    // Activation command + lifecycle cleanup (+ tools after activation).
    assert.ok(ctx.disposers.length >= 1);
    assert.doesNotThrow(() => {
      for (const dispose of ctx.disposers) dispose();
    });
  });

  it("apply is a no-op when disabled", () => {
    const ctx = createStubCtx();

    apply(ctx, { enabled: false });
    assert.equal(ctx.disposers.length, 0);
  });

  it("dormant apply wires passive listeners without session-start capture", () => {
    const ctx = createStubCtx();
    apply(ctx, { enabled: true });
    // Ticket 19: the agent/session-start capture is deleted.
    assert.equal(ctx.listeners.has("agent/session-start"), false);
    assert.ok(ctx.listeners.get("agent/status"));
    assert.ok(ctx.listeners.get("agent/disposed"));
    assert.ok(ctx.listeners.get("subagent/end"));
  });

  it("dormant apply registers the host commands, no tools", () => {
    const ctx = createStubCtx();
    apply(ctx, { enabled: true });
    assert.deepEqual(ctx.registeredCommands.map((c) => c.name), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);
    // Deferred to activation (ticket 19): the tool surface stays stock.
    assert.equal(ctx.registeredTools.length, 0);
  });

  it("command registration survives apply (cordis effect contract, ticket 44)", () => {
    const ctx = createStubCtx();
    apply(ctx, { enabled: true });
    // The contract-faithful fake runs `execute` at apply exactly like live
    // cordis: a plugin that handed the register DISPOSER to `ctx.effect`
    // would invoke it right here and silently unregister the command — the
    // live 2026-09-18 re-pass bug (ticket 44). Both commands must still be
    // present, and each effect must have contributed exactly one real
    // cleanup (two registrations + the teardown), so an HMR dispose-all
    // unregisters everything through the collected disposers.
    assert.deepEqual(ctx.registeredCommands.map((c) => c.name), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);
    assert.equal(ctx.disposers.length, 3);
    for (const dispose of [...ctx.disposers]) dispose();
    assert.equal(ctx.registeredCommands.length, 0);
  });

  it("command activation registers the tool surface; dispose reverses it", async () => {
    const ctx = createStubCtx();
    apply(ctx, { enabled: true });

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));

    // Five dispatcher tools (T11) + worker access tool (T13).
    const names = ctx.registeredTools.map((t) => t.name);
    for (const tool of [
      "spawn_worker",
      "check_workers",
      "steer_worker",
      "stop_worker",
      "deliver_result",
      "request_access",
    ]) {
      assert.ok(names.includes(tool), `missing tool: ${tool}`);
    }

    // Session end unbinds and unregisters the tool surface.
    ctx.fire("agent/disposed", { agent });
    assert.equal(ctx.registeredTools.length, 0);

    // Re-activation registers a fresh surface.
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.registeredTools.length, 6);
  });

  it("dispatcher tools refuse non-activated calling sessions", async () => {
    const ctx = createStubCtx();
    apply(ctx, { enabled: true });

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));

    const spawn = ctx.registeredTools.find((t) => t.name === "spawn_worker");
    assert.ok(spawn);

    // A different chat's exec shape is refused with structured copy.
    const refused = (await spawn.execute(
      { stream_key: "s", title: "T", prompt: "P" },
      { agent: { session: { id: "session-2" } } },
    )) as { ok: boolean; detail: string };
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /dispatcher-start/);

    // The activated chat's exec shape passes through to the core.
    const ok = (await spawn.execute(
      { stream_key: "s", title: "T", prompt: "P" },
      { agent: { session: { id: "session-1" } } },
    )) as { ok: boolean };
    assert.equal(ok.ok, true);
  });

  it("dispose-all (HMR) unregisters the command, tools, and listeners", async () => {
    const ctx = createStubCtx();
    apply(ctx, { enabled: true });

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.registeredTools.length, 6);

    for (const dispose of ctx.disposers) dispose();

    assert.equal(ctx.registeredCommands.length, 0);
    assert.equal(ctx.registeredTools.length, 0);
    for (const cbs of ctx.listeners.values()) {
      assert.equal(cbs.length, 0);
    }
    // A later session-start still captures nothing.
    ctx.fire("agent/session-start", { agent: createAgent("session-2") });
  });

  it("a firehose tool/call advances the count check_workers shows (ticket 75)", async () => {
    const ctx = createStubCtx();
    apply(ctx, { enabled: true });

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));

    const spawn = ctx.registeredTools.find((t) => t.name === "spawn_worker");
    assert.ok(spawn);
    const spawned = (await spawn.execute(
      { stream_key: "s", title: "T", prompt: "P" },
      { agent: { session: { id: "session-1" } } },
    )) as { ok: boolean };
    assert.equal(spawned.ok, true);

    // Synthetic `session/event` firehose delivery, two-arg like the live bus.
    const toolCall = (name: string) => ({
      type: "tool/call",
      data: { name, arguments: JSON.stringify({ command: "npm test" }) },
    });
    ctx.fire("session/event", { id: "child-stub" }, toolCall("bash"));
    ctx.fire("session/event", { id: "child-stub" }, toolCall("grep"));
    // Unowned and non-tool deliveries must not move the count.
    ctx.fire("session/event", { id: "stranger" }, toolCall("bash"));
    ctx.fire("session/event", { id: "child-stub" }, { type: "turn/start" });

    const check = ctx.registeredTools.find((t) => t.name === "check_workers");
    assert.ok(check);
    const value = (await check.execute(
      {},
      { agent: { session: { id: "session-1" } } },
    )) as {
      ok: boolean;
      rows: Array<{ worker_id: string; tool_call_count: number; liveness: string | null }>;
    };
    assert.equal(value.ok, true);
    assert.equal(value.rows.length, 1);
    assert.equal(value.rows[0]?.worker_id, "child-stub");
    assert.equal(value.rows[0]?.tool_call_count, 2);
    // Fresh observed activity reads active — the quiet→active flip the
    // count wiring enables (previously the count could never advance).
    assert.equal(value.rows[0]?.liveness, "active");
  });
});
