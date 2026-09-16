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
  effect: (dispose: () => void) => void;
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
  fire(name: string, payload: unknown): void;
  runCommand(inv: { commandId: string; agent: AgentLike }): void;
} {
  const disposers: Array<() => void> = [];
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const tables = new Map<string, Map<string, unknown>>();
  const registeredCommands: CommandDefinitionLike[] = [];
  const registeredTools: Array<{ name: string } & {
    execute: (args: unknown, exec?: unknown) => Promise<unknown>;
  }> = [];

  const fire = (name: string, payload: unknown) => {
    for (const cb of listeners.get(name) ?? []) {
      cb(payload as never);
    }
  };

  const ctx = {
    disposers,
    listeners,
    registeredCommands,
    registeredTools,
    effect(dispose: () => void) {
      disposers.push(dispose);
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
});
