import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Config, apply, inject, name } from "../src/plugin.js";
import type { AdapterContext } from "../src/adapter/cordis-dsh-host.js";

function createStubCtx(): AdapterContext & {
  effect: (dispose: () => void) => void;
  inject: (
    services: readonly string[],
    callback: (child: Record<string, never>) => void,
  ) => void;
  disposers: Array<() => void>;
  listeners: Map<string, Array<(payload: never) => void>>;
} {
  const disposers: Array<() => void> = [];
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const tables = new Map<string, Map<string, unknown>>();

  return {
    disposers,
    listeners,
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
    ]);
    assert.ok(Config);
  });

  it("apply registers through ctx.effect and the disposer is callable", () => {
    const ctx = createStubCtx();

    apply(ctx, { enabled: true });
    // Worker access tool (T13) + lifecycle cleanup. Dispatcher tools need ctx.tools.
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

  it("apply wires session-start / status / subagent-end listeners", () => {
    const ctx = createStubCtx();
    apply(ctx, { enabled: true });
    assert.ok(ctx.listeners.get("agent/session-start"));
    assert.ok(ctx.listeners.get("agent/status"));
    assert.ok(ctx.listeners.get("agent/disposed"));
    assert.ok(ctx.listeners.get("subagent/end"));
  });

  it("apply registers the five dispatcher tools when ctx.tools.register exists", () => {
    const ctx = createStubCtx();
    const registered: Array<{ name: string }> = [];
    (ctx as { tools?: unknown }).tools = {
      schemas: () => registered,
      register(definition: { name: string }) {
        registered.push(definition);
        return () => {
          const at = registered.findIndex((t) => t.name === definition.name);
          if (at >= 0) registered.splice(at, 1);
        };
      },
    };

    apply(ctx, { enabled: true });
    // Five dispatcher tools (T11) + worker access tool (T13) + lifecycle cleanup.
    const names = registered.map((t) => t.name);
    for (const tool of [
      "spawn_worker",
      "check_workers",
      "steer_worker",
      "stop_worker",
      "deliver_result",
    ]) {
      assert.ok(names.includes(tool), `missing tool: ${tool}`);
    }
    assert.equal(ctx.disposers.length, names.length + 1);
  });
});
