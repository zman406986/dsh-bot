/**
 * Ticket 12 — feature flag + profile split (ADR-0005).
 *
 * Unit tests, no network / LLM / real dsh host.
 * Covers: freeze semantics, disabled early-return, settings always installed,
 * onChange runtime no-op, policy gate, schema defaults.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Config, apply } from "../src/plugin.js";
import {
  assembleSessionPolicy,
} from "../src/core/policy/assembler.js";
import {
  installMultitaskSettingsSection,
  SETTINGS_NAMESPACE,
  type SettingsProviderLike,
  type SettingsSectionHooksLike,
} from "../src/adapter/settings-section.js";
import { DISPATCHER_START_COMMAND } from "../src/adapter/activation-command.js";
import type {
  AdapterContext,
  CommandDefinitionLike,
} from "../src/adapter/cordis-dsh-host.js";

interface StubSettingsCall {
  ns: string;
  schema: unknown;
  entry: unknown;
  hooks: SettingsSectionHooksLike<unknown>;
}

function createStubCtx(options?: {
  withTools?: boolean;
  withSettings?: boolean;
}): AdapterContext & {
  effect: (dispose: () => void) => void;
  inject: (
    services: readonly string[],
    callback: (child: { settings?: SettingsProviderLike }) => void,
  ) => void;
  disposers: Array<() => void>;
  listeners: Map<string, Array<(payload: never) => void>>;
  settingsCalls: StubSettingsCall[];
  registeredTools: Array<{ name: string }>;
  registeredCommands: CommandDefinitionLike[];
  settings?: SettingsProviderLike;
} {
  const disposers: Array<() => void> = [];
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const tables = new Map<string, Map<string, unknown>>();
  const settingsCalls: StubSettingsCall[] = [];
  const registeredTools: Array<{ name: string }> = [];
  const registeredCommands: CommandDefinitionLike[] = [];

  const ctx: ReturnType<typeof createStubCtx> = {
    disposers,
    listeners,
    settingsCalls,
    registeredTools,
    registeredCommands,
    effect(dispose: () => void) {
      disposers.push(dispose);
    },
    inject(services, callback) {
      if (services.includes("settings") && ctx.settings !== undefined) {
        callback(ctx);
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
        registeredCommands.push(definition);
        return () => {
          const at = registeredCommands.indexOf(definition);
          if (at >= 0) registeredCommands.splice(at, 1);
        };
      },
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

  if (options?.withTools === true) {
    (ctx as { tools?: unknown }).tools = {
      schemas: () => registeredTools,
      register(definition: { name: string }) {
        registeredTools.push(definition);
        return () => {
          const at = registeredTools.findIndex((t) => t.name === definition.name);
          if (at >= 0) registeredTools.splice(at, 1);
        };
      },
    };
  }

  if (options?.withSettings === true) {
    ctx.settings = {
      installSection(owner, ns, schema, entry, hooks) {
        settingsCalls.push({ ns, schema, entry, hooks });
      },
    };
  }

  return ctx;
}

describe("feature flag — schema", () => {
  it("Config({}) yields enabled: true (default)", () => {
    const parsed = Config({}) as { enabled: boolean };
    assert.equal(parsed.enabled, true);
  });

  it("Config({ enabled: false }) yields enabled: false", () => {
    const parsed = Config({ enabled: false }) as { enabled: boolean };
    assert.equal(parsed.enabled, false);
  });

  it("Config({ enabled: true }) yields enabled: true", () => {
    const parsed = Config({ enabled: true }) as { enabled: boolean };
    assert.equal(parsed.enabled, true);
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
    apply(ctx, { enabled: false });
    assert.equal(ctx.disposers.length, 0);
    assert.equal(ctx.registeredTools.length, 0);
    assert.equal(ctx.listeners.size, 0);
  });

  it("apply with enabled:false does not wire session-start / status listeners", () => {
    const ctx = createStubCtx();
    apply(ctx, { enabled: false });
    assert.ok(!ctx.listeners.has("agent/session-start"));
    assert.ok(!ctx.listeners.has("agent/status"));
    assert.ok(!ctx.listeners.has("subagent/end"));
  });
});

describe("feature flag — enabled path boots dormant (ticket 19)", () => {
  it("apply with enabled:true registers the command, no tools, no capture", () => {
    const ctx = createStubCtx({ withTools: true });
    apply(ctx, { enabled: true });
    // Dormant: the activation command is the only visible affordance.
    assert.deepEqual(
      ctx.registeredCommands.map((c) => c.name),
      [DISPATCHER_START_COMMAND],
    );
    // Tools are deferred to activation (design-16 §3.3).
    assert.equal(ctx.registeredTools.length, 0);
    // The session-start capture is deleted (ADR-0009).
    assert.equal(ctx.listeners.has("agent/session-start"), false);
    assert.ok(ctx.listeners.has("agent/status"));
    assert.ok(ctx.listeners.has("subagent/end"));
    // Command disposer + lifecycle cleanup.
    assert.equal(ctx.disposers.length, 2);
  });
});

describe("feature flag — freeze semantics (ADR-0005)", () => {
  it("mutating config.enabled after apply does not change the dormant boot or activation", () => {
    const ctx = createStubCtx({ withTools: true });
    const config = { enabled: true };
    apply(ctx, config);

    // Mid-session flip — forbidden live toggle.
    config.enabled = false;

    // Boot state unchanged (freeze copied the primitive at apply entry):
    // the command is still registered and the lifecycle still activates
    // with policy, because `enabled` was true when apply froze it.
    assert.equal(ctx.registeredCommands.length, 1);
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

  it("disabled session stays disabled when config.enabled is flipped to true", () => {
    const ctx = createStubCtx({ withTools: true });
    const config = { enabled: false };
    apply(ctx, config);

    config.enabled = true;

    // Still stock: freeze captured false — no command, no tools, no listeners.
    assert.equal(ctx.disposers.length, 0);
    assert.equal(ctx.registeredTools.length, 0);
    assert.equal(ctx.registeredCommands.length, 0);
    assert.equal(ctx.listeners.size, 0);
  });
});

describe("feature flag — settings section always installed", () => {
  it("settings section is installed when enabled:true", () => {
    const ctx = createStubCtx({ withSettings: true });
    apply(ctx, { enabled: true });
    assert.equal(ctx.settingsCalls.length, 1);
    assert.equal(ctx.settingsCalls[0]?.ns, SETTINGS_NAMESPACE);
  });

  it("settings section is installed when enabled:false", () => {
    const ctx = createStubCtx({ withSettings: true });
    apply(ctx, { enabled: false });
    assert.equal(ctx.settingsCalls.length, 1);
    assert.equal(ctx.settingsCalls[0]?.ns, SETTINGS_NAMESPACE);
  });

  it("install is a no-op when ctx.settings is absent", () => {
    const ctx = createStubCtx();
    assert.doesNotThrow(() => {
      apply(ctx, { enabled: true });
    });
  });

  it("installMultitaskSettingsSection uses the multitask-dispatcher namespace", () => {
    const calls: StubSettingsCall[] = [];
    const ctx = {
      inject(
        services: readonly string[],
        callback: (child: { settings?: SettingsProviderLike }) => void,
      ) {
        if (services.includes("settings")) callback(ctx);
      },
      settings: {
        installSection(
          _owner: unknown,
          ns: string,
          schema: unknown,
          entry: unknown,
          hooks: SettingsSectionHooksLike<unknown>,
        ) {
          calls.push({ ns, schema, entry, hooks });
        },
      },
    };
    installMultitaskSettingsSection(ctx, Config, { enabled: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.ns, "multitask-dispatcher");
  });
});

describe("feature flag — onChange is a runtime no-op", () => {
  it("calling onChange after a true-start does not tear down the session", () => {
    const ctx = createStubCtx({ withTools: true, withSettings: true });
    apply(ctx, { enabled: true });

    const hooks = ctx.settingsCalls[0]?.hooks;
    assert.ok(hooks);
    assert.equal(typeof hooks.onChange, "function");

    // Simulate a settings UI write that persists enabled:false for next session.
    hooks.onChange?.();

    // Running session unchanged: no teardown, command still present.
    assert.equal(ctx.registeredCommands.length, 1);
    assert.equal(ctx.disposers.length, 2);
    assert.ok(ctx.listeners.has("agent/status"));
  });

  it("setSource thunk is accepted and does not reconfigure the frozen flag", () => {
    const ctx = createStubCtx({ withSettings: true });
    apply(ctx, { enabled: true });

    const hooks = ctx.settingsCalls[0]?.hooks;
    assert.ok(hooks);
    // Provider may call setSource with a live thunk; we ignore it.
    assert.doesNotThrow(() => {
      hooks.setSource?.(() => ({ enabled: false }));
    });
    // Session still enabled-path wired (dormant with command).
    assert.equal(ctx.registeredCommands.length, 1);
  });
});

describe("feature flag — no off-while-running", () => {
  it("there is no API path that disables a running dispatcher mid-session", () => {
    // Structural guarantee: apply is the only entry, and it freezes the flag.
    // The settings onChange callback is a no-op (tested above). No exported
    // function mutates a running Multitask's enabled state, and the command
    // surface has no deactivate verb (activation is once per session).
    const ctx = createStubCtx({ withTools: true, withSettings: true });
    apply(ctx, { enabled: true });
    const hooks = ctx.settingsCalls[0]?.hooks;

    // Even a full onChange + setSource storm leaves the session intact.
    hooks?.setSource?.(() => ({ enabled: false }));
    hooks?.onChange?.();
    hooks?.onChange?.();

    assert.equal(ctx.registeredCommands.length, 1);
    assert.equal(ctx.registeredCommands[0]?.name, DISPATCHER_START_COMMAND);
    assert.ok(ctx.listeners.has("agent/status"));
  });
});
