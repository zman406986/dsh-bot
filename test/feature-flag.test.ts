/**
 * Ticket 12 — feature flag + profile split (ADR-0005).
 *
 * Unit tests, no network / LLM / real dsh host.
 * Covers: freeze semantics, disabled early-return, the volatile settings
 * form, policy gate, schema defaults.
 *
 * 0.2.1 has no settings registration API: the plugin's own Config schema IS
 * the form, keyed by its Loader row id (`SETTINGS_NAMESPACE`), and only
 * `.volatile()` fields appear or accept writes. These cases pin that shape.
 *
 * Fake-vs-host (ticket 91): the stub `commands.register` / `tools.register`
 * are fail-loud on a duplicate name, like the shipped `NamedEntries` tables
 * (`@deepseek-ai/dsh-commands/lib/index.js:82`,
 * `@deepseek-ai/dsh-tools/lib/index.js:2538`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Config, apply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import {
  assembleSessionPolicy,
} from "../src/core/policy/assembler.js";
import { SETTINGS_NAMESPACE } from "../src/adapter/settings-section.js";
import { DISPATCHER_START_COMMAND } from "../src/adapter/activation-command.js";
import { DISPATCHER_STEER_COMMAND } from "../src/adapter/steer-command.js";
import { DISPATCHER_RESOLVE_COMMAND } from "../src/adapter/resolve-command.js";
import { DISPATCHER_STOP_COMMAND } from "../src/adapter/stop-command.js";
import type {
  AdapterContext,
  CommandDefinitionLike,
} from "../src/adapter/cordis-dsh-host.js";

function createStubCtx(options?: {
  withTools?: boolean;
}): AdapterContext & {
  effect: (execute: () => unknown, label?: string) => unknown;
  disposers: Array<() => void>;
  listeners: Map<string, Array<(payload: never) => void>>;
  registeredTools: Array<{ name: string }>;
  registeredCommands: CommandDefinitionLike[];
} {
  const disposers: Array<() => void> = [];
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const tables = new Map<string, Map<string, unknown>>();
  const registeredTools: Array<{ name: string }> = [];
  const registeredCommands: CommandDefinitionLike[] = [];

  const ctx: ReturnType<typeof createStubCtx> = {
    disposers,
    listeners,
    registeredTools,
    registeredCommands,
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
        // Shipped rule (ticket 91): a duplicate command name throws
        // (dsh-commands lib/index.js:82, NamedEntries factory).
        if (registeredCommands.some((c) => c.name === definition.name)) {
          throw new Error(
            `command "${definition.name}" is already registered (for a ` +
              `per-agent variant, mount a command-injected plugin under ` +
              `that agent's \`agent.ctx\`)`,
          );
        }
        registeredCommands.push(definition);
        return () => {
          const at = registeredCommands.indexOf(definition);
          if (at >= 0) registeredCommands.splice(at, 1);
        };
      },
    },
    subagents: {
      async startActivation() {
        return { childId: "child-stub", dispose: async () => {} };
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

  if (options?.withTools === true) {
    (ctx as { tools?: unknown }).tools = {
      schemas: () => registeredTools,
      register(definition: { name: string }) {
        // Shipped rule (ticket 91): a duplicate tool name throws
        // (dsh-tools lib/index.js:2538, NamedEntries factory).
        if (registeredTools.some((t) => t.name === definition.name)) {
          throw new Error(
            `tool "${definition.name}" is already registered (for a ` +
              `per-agent variant, register through that agent's ` +
              `\`agent.ctx\` instead)`,
          );
        }
        registeredTools.push(definition);
        return () => {
          const at = registeredTools.findIndex((t) => t.name === definition.name);
          if (at >= 0) registeredTools.splice(at, 1);
        };
      },
    };
  }

  return ctx;
}

describe("feature flag — schema", () => {
  // 0.2.1: `.volatile()` makes every field parse to a stable reference, so the
  // value is read with `get()` — the same shape the host hands `apply`.
  it("Config({}) yields enabled: true (default)", () => {
    const parsed = Config({}) as { enabled: { get(): boolean } };
    assert.equal(parsed.enabled.get(), true);
  });

  it("Config({ enabled: false }) yields enabled: false", () => {
    const parsed = Config({ enabled: false }) as { enabled: { get(): boolean } };
    assert.equal(parsed.enabled.get(), false);
  });

  it("Config({ enabled: true }) yields enabled: true", () => {
    const parsed = Config({ enabled: true }) as { enabled: { get(): boolean } };
    assert.equal(parsed.enabled.get(), true);
  });

  it("defaults the inbox off and the rescan floor at 5000", () => {
    const parsed = Config({}) as {
      inboxEnabled: { get(): boolean };
      inboxDir: { get(): string };
      inboxRescanIntervalMs: { get(): number };
      wakeCoalesceWindowMs: { get(): number };
    };
    assert.equal(parsed.inboxEnabled.get(), false);
    assert.equal(parsed.inboxDir.get(), "");
    assert.equal(parsed.inboxRescanIntervalMs.get(), 5000);
    assert.equal(parsed.wakeCoalesceWindowMs.get(), 0);
  });
});

describe("feature flag — policy assembler gate", () => {
  it("assembleSessionPolicy(false) returns empty string", () => {
    assert.equal(assembleSessionPolicy(false), "");
  });

  it("assembleSessionPolicy(true) returns non-empty policy section", () => {
    const policy = assembleSessionPolicy(true);
    assert.ok(policy.length > 0);
    // Structural markers from the dispatcher policy section.
    assert.ok(policy.includes("##") || policy.includes("#"));
  });
});

describe("feature flag — disabled path is stock dsh", () => {
  it("apply with enabled:false does not register tools, listeners, or effects", () => {
    const ctx = createStubCtx({ withTools: true });
    apply(ctx, volatileConfig({ enabled: false }));
    assert.equal(ctx.disposers.length, 0);
    assert.equal(ctx.registeredTools.length, 0);
    assert.equal(ctx.listeners.size, 0);
  });

  it("apply with enabled:false does not wire session-start / status listeners", () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: false }));
    assert.ok(!ctx.listeners.has("agent/session-start"));
    assert.ok(!ctx.listeners.has("agent/status"));
    assert.ok(!ctx.listeners.has("subagent/end"));
  });
});

describe("feature flag — enabled path boots dormant (ticket 19)", () => {
  it("apply with enabled:true registers the command, no tools, no capture", () => {
    const ctx = createStubCtx({ withTools: true });
    apply(ctx, volatileConfig({ enabled: true }));
    // Dormant: the host commands are the visible affordances (ticket 22 added
    // dispatcher-steer; ticket 69 the resolve command; ticket 101 the stop
    // command; all gate on activation).
    assert.deepEqual(ctx.registeredCommands.map((c) => c.name), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
      DISPATCHER_RESOLVE_COMMAND,
      DISPATCHER_STOP_COMMAND,
    ]);
    // Tools are deferred to activation (design-16 §3.3).
    assert.equal(ctx.registeredTools.length, 0);
    // The session-start capture is deleted (ADR-0009).
    assert.equal(ctx.listeners.has("agent/session-start"), false);
    assert.ok(ctx.listeners.has("agent/status"));
    assert.ok(ctx.listeners.has("subagent/end"));
    // Command disposers + lifecycle cleanup.
    assert.equal(ctx.disposers.length, 5);
  });
});

describe("feature flag — freeze semantics (ADR-0005)", () => {
  it("mutating the enabled ref after apply does not change the dormant boot or activation", () => {
    const ctx = createStubCtx({ withTools: true });
    const config = volatileConfig({ enabled: true });
    apply(ctx, config);

    // Mid-session flip — forbidden live toggle, even via the host's own
    // volatile commit (the ref value changes; the frozen copy does not).
    config.enabled.set(false);

    // Boot state unchanged (freeze copied the primitive at apply entry):
    // the commands are still registered and the lifecycle still activates
    // with policy, because `enabled` was true when apply froze it.
    assert.equal(ctx.registeredCommands.length, 4);
    const lifecycleAgent = {
      session: { id: "s-1", header: { parentSession: null, delegationDepth: 0 } },
      followup() {},
      injected: [] as unknown[],
      inject(message: unknown) {
        this.injected.push(message);
      },
    };
    const start = ctx.registeredCommands[0];
    assert.ok(start);
    // The activation handler is synchronous.
    const result = start.handler({
      commandId: DISPATCHER_START_COMMAND,
      agent: lifecycleAgent,
    }) as { kind: string };
    assert.equal(result.kind, "success");
    // Policy injected despite the later config flip: the flag was frozen ON.
    assert.equal(lifecycleAgent.injected.length, 1);
  });

  it("disabled session stays disabled when the enabled ref is flipped to true", () => {
    const ctx = createStubCtx({ withTools: true });
    const config = volatileConfig({ enabled: false });
    apply(ctx, config);

    config.enabled.set(true);

    // Still stock: freeze captured false — no command, no tools, no listeners.
    assert.equal(ctx.disposers.length, 0);
    assert.equal(ctx.registeredTools.length, 0);
    assert.equal(ctx.registeredCommands.length, 0);
    assert.equal(ctx.listeners.size, 0);
  });
});

describe("feature flag — volatile settings form (0.2.1)", () => {
  it("every Config field is volatile, so the host form exposes and accepts it", () => {
    const dict = (Config as unknown as {
      dict: Record<string, { meta?: { volatile?: boolean } }>;
    }).dict;
    assert.deepEqual(Object.keys(dict).sort(), [
      "accessRequestTimeoutMs",
      "enabled",
      "inboxDir",
      "inboxEnabled",
      "inboxRescanIntervalMs",
      "microcompactEnabled",
      "wakeCoalesceWindowMs",
    ]);
    for (const [field, schema] of Object.entries(dict)) {
      assert.equal(
        schema.meta?.volatile,
        true,
        `Config field "${field}" must be volatile (0.2.1 rejects non-volatile writes)`,
      );
    }
  });

  it("the settings namespace is the Loader row id, not a registration argument", () => {
    assert.equal(SETTINGS_NAMESPACE, "multitask-dispatcher");
  });

  it("optional refs may be absent; apply falls back to the shipped defaults", () => {
    // The host always hands validated refs, but stub contexts (and a future
    // composition that omits a row-level config) may not. The optional chain
    // must not throw, and the inbox must stay off.
    const ctx = createStubCtx({ withTools: true });
    apply(ctx, { enabled: { get: () => true } });
    assert.equal(ctx.registeredCommands.length, 4);
    assert.ok(ctx.listeners.has("agent/status"));
  });
});

describe("feature flag — no off-while-running", () => {
  it("there is no API path that disables a running dispatcher mid-session", () => {
    // Structural guarantee: apply is the only entry, and it freezes the flag.
    // Volatile refs update live on the host, but the plugin only ever reads
    // one at apply time and never subscribes to `loader/volatile-update`. No
    // exported function mutates a running Multitask's enabled state, and the
    // command surface has no flag-off verb (the flag is frozen per session, ADR-0005;
    // ticket 101's /dispatcher-stop deactivates a session BINDING under
    // ADR-0021 decision 3 — it does not touch the flag or the core).
    const ctx = createStubCtx({ withTools: true });
    const config = volatileConfig({ enabled: true });
    apply(ctx, config);

    // Even a config mutation storm leaves the session intact.
    config.enabled.set(false);

    assert.equal(ctx.registeredCommands.length, 4);
    assert.equal(ctx.registeredCommands[0]?.name, DISPATCHER_START_COMMAND);
    assert.ok(ctx.listeners.has("agent/status"));
  });
});

describe("feature flag — host duplicate-registration rule (ticket 91)", () => {
  it("apply throws the host duplicate-command error when a command name is taken", () => {
    const ctx = createStubCtx();
    ctx.commands.register({
      name: DISPATCHER_STEER_COMMAND,
      description: "foreign claimant",
      handler: () => ({ kind: "success", text: "foreign" }),
    });

    assert.throws(
      () => apply(ctx, volatileConfig({ enabled: true })),
      new RegExp(`command "${DISPATCHER_STEER_COMMAND}" is already registered`),
    );
  });

  it("the tools registry throws the host duplicate-tool error on a taken name", () => {
    const ctx = createStubCtx({ withTools: true });
    const tools = ctx.tools as unknown as {
      register(definition: { name: string }): () => void;
    };
    tools.register({ name: "check_workers" });

    assert.throws(
      () => tools.register({ name: "check_workers" }),
      /tool "check_workers" is already registered/,
    );
  });
});
