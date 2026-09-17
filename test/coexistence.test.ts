/**
 * Ticket 25 — coexistence close-out for the ticket-16 UI effort
 * (design-16 §5 namespacing/conflict rules; Findings 1/2/5 of
 * docs/research/dsh-plugin-ui-patterns.md).
 *
 * A simulated SECOND plugin registers on the SAME seam types the dispatcher
 * now uses — host: settings namespace, slash commands, global tools; client:
 * locale namespace, the `shell.overlay` list slot, the keyed
 * `tool.call.toolview` slot — and the tests prove no cross-interference:
 *
 * - boot-once claims (settings namespace, command name) fail LOUD on a
 *   duplicate and never corrupt the first claimant (Finding 1
 *   `settings namespace "X" is already registered`, dsh-settings
 *   lib/index.js:283; Finding 2 duplicate-command throw, dsh-commands
 *   lib/index.js:82);
 * - list slots stay additive with order-sorted entries and unique prefixed
 *   ids; keyed cells stay per-key (foreign keys unaffected — Finding 5);
 * - unloading ONE plugin's fiber (HMR) leaves the other intact.
 *
 * Plus the dormant-state matrix check end to end at the plugin boundary
 * (design-16 §3.7): flag ON + not activated = stock experience — no capture
 * on session-start, no policy inject, stock tool surface.
 *
 * Offline only (S8): fake AdapterContext / client seams with the shipped
 * fail-loud semantics, driving the REAL plugin apply() on both faces
 * (idioms from test/activation-lifecycle.test.ts and
 * test/client-face-scaffold.test.ts). No network, no LLM, no running dsh.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply as applyDispatcherHost } from "../src/plugin.js";
import {
  DISPATCHER_START_COMMAND,
  DISPATCHER_START_SUCCESS,
  DISPATCHER_STEER_COMMAND,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
} from "../src/adapter/index.js";
import { ROSTER_SETTINGS_KEY } from "../src/core/roster-snapshot.js";
import { apply as applyDispatcherClient } from "../src/client/index.js";
import type { ClientContext } from "../src/client/context.js";
import {
  LOCALE_NAMESPACE,
  rosterOverlayRegistration,
  SHELL_OVERLAY_SLOT,
  type SlotRegistrationOptions,
} from "../src/client/overlay.js";
import {
  TOOLVIEW_TOOL_NAMES,
  TOOL_CALL_TOOLVIEW_SLOT,
  toolviewRegistration,
} from "../src/client/toolviews.js";

/**
 * The simulated foreign plugin's registration plan. Every name lives under
 * its own `foreign-helper` namespace so a collision with the dispatcher is
 * a real seam event, never an accident of naming.
 */
const FOREIGN = {
  settingsNs: "foreign-helper",
  localeNs: "foreign-helper",
  command: "foreign-helper-greet",
  tool: "foreign_helper_ping",
  overlayEntryId: "foreign-helper-panel",
  overlayOrder: 25,
} as const;

/** The foreign host command's exact success result. */
const FOREIGN_COMMAND_RESULT: CommandResultLike = {
  kind: "success",
  text: "foreign-helper: greeted.",
};

/** The foreign tool's exact result shape. */
const FOREIGN_TOOL_RESULT = { ok: true, source: "foreign-helper" };

/* ------------------------------------------------------------------ *
 * Host-face fake (AdapterContext) — shipped fail-loud seam semantics. *
 * ------------------------------------------------------------------ */

interface TestAgent extends AgentLike {
  readonly injected: unknown[];
}

function createAgent(
  id: string,
  opts?: { topLevel?: boolean },
): TestAgent {
  const topLevel = opts?.topLevel ?? true;
  const injected: unknown[] = [];
  return {
    session: {
      id,
      header: topLevel
        ? { parentSession: null, delegationDepth: 0 }
        : { parentSession: "parent-x", delegationDepth: 1 },
    },
    followup() {},
    inject(message: unknown) {
      injected.push(message);
    },
    injected,
  };
}

/**
 * Fake the host face the way the shipped registries behave:
 *
 * - `settings.installSection` throws
 *   `settings namespace "X" is already registered` on a duplicate claim and
 *   registers the namespace-removal disposer on the CALLING plugin's fiber
 *   (Finding 1: "disposing that fiber removes the namespace");
 * - `commands.register` throws
 *   `command "X" is already registered …` on a duplicate name; the disposer
 *   unregisters only its own definition (Finding 2);
 * - `tools.register` coexists by unique name and returns the exact disposer
 *   (the contract the deferred dispatcher surface relies on).
 *
 * Each `applyHostPlugin` call records the disposers created during it as a
 * per-plugin "fiber" so a test can unload one plugin (HMR) and leave the
 * other intact.
 */
function createHostCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const settingDocs = new Map<string, Record<string, unknown>>();
  const settingWatchers = new Map<string, Set<(value: unknown) => void>>();
  const settingScopes = new Map<string, unknown>();
  const disposers: Array<() => void> = [];
  let nextChild = 1;

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
    }
  };

  const settingsProvider = {
    installSection(
      _owner: unknown,
      ns: string,
      _schema: unknown,
      entry: unknown,
      _hooks: unknown,
    ) {
      void _owner;
      void _schema;
      void _hooks;
      if (settingDocs.has(ns)) {
        throw new Error(`settings namespace "${ns}" is already registered`);
      }
      settingDocs.set(ns, { ...(entry as Record<string, unknown>) });
      const watchers = new Set<(value: unknown) => void>();
      settingWatchers.set(ns, watchers);
      // Finding 1 lifecycle: the namespace dies with the claiming fiber.
      disposers.push(() => {
        settingDocs.delete(ns);
        settingWatchers.delete(ns);
        settingScopes.delete(ns);
      });
      const scope = {
        get: () => settingDocs.get(ns),
        watch(onChange: (value: unknown) => void) {
          watchers.add(onChange);
          return () => {
            watchers.delete(onChange);
          };
        },
        update(value: unknown) {
          const current = settingDocs.get(ns);
          if (current === undefined) return; // namespace already disposed
          const next = { ...current, ...(value as Record<string, unknown>) };
          settingDocs.set(ns, next);
          for (const onChange of [...watchers]) onChange(next);
        },
        replace(value: unknown) {
          if (!settingDocs.has(ns)) return;
          settingDocs.set(ns, value as Record<string, unknown>);
          for (const onChange of [...watchers]) onChange(value);
        },
      };
      settingScopes.set(ns, scope);
      return scope;
    },
  };

  const ctx = {
    effect(dispose: () => void) {
      disposers.push(dispose);
    },
    inject(services: readonly string[], cb: (child: unknown) => void) {
      if (services.includes("settings")) cb({ settings: settingsProvider });
    },
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
        if (commands.has(definition.name)) {
          throw new Error(
            `command "${definition.name}" is already registered (for a ` +
              `per-agent variant, mount a command-injected plugin under that ` +
              `agent's agent.ctx)`,
          );
        }
        commands.set(definition.name, definition);
        // Finding 2 lifecycle: the shipped registry attaches the unbind to
        // the CALLING plugin's fiber itself (layers.effect), so registering
        // is enough to be HMR-reversible.
        const unregister = () => {
          if (commands.get(definition.name) === definition) {
            commands.delete(definition.name);
          }
        };
        disposers.push(unregister);
        return unregister;
      },
    },
    tools: {
      schemas: () => [...tools.keys()].map((name) => ({ name })),
      register(definition: {
        name: string;
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      }) {
        tools.set(definition.name, definition);
        const unregister = () => {
          if (tools.get(definition.name) === definition) {
            tools.delete(definition.name);
          }
        };
        disposers.push(unregister);
        return unregister;
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
            return {
              get: () => undefined,
              entries: () => [] as never,
              async put() {},
              async delete() {
                return true;
              },
            };
          },
          async close() {},
          name: "stub",
        };
      },
    },
    // Test surface.
    fire,
    disposers,
    commandNames: () => [...commands.keys()],
    toolNames: () => [...tools.keys()],
    tool: (name: string) => tools.get(name),
    settingDoc: (ns: string) => settingDocs.get(ns),
    hasSettingsNamespace: (ns: string) => settingDocs.has(ns),
    settingScope: (ns: string) => settingScopes.get(ns) as {
      get(): unknown;
      watch(onChange: (value: unknown) => void): () => void;
      update(value: unknown): void;
    },
    runCommand(invocation: {
      commandId: string;
      agent?: AgentLike;
      rawInput?: string;
    }): CommandResultLike {
      const command = commands.get(invocation.commandId);
      if (command === undefined) {
        throw new Error(`command not registered: ${invocation.commandId}`);
      }
      return command.handler(invocation as never) as CommandResultLike;
    },
  };
  return ctx as typeof ctx & AdapterContext & {
    fire(name: string, payload: unknown): void;
    disposers: Array<() => void>;
    commandNames(): string[];
    toolNames(): string[];
    tool(name: string):
      | { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
      | undefined;
    settingDoc(ns: string): Record<string, unknown> | undefined;
    hasSettingsNamespace(ns: string): boolean;
    settingScope(ns: string): {
      get(): unknown;
      watch(onChange: (value: unknown) => void): () => void;
      update(value: unknown): void;
    };
    runCommand(invocation: {
      commandId: string;
      agent?: AgentLike;
      rawInput?: string;
    }): CommandResultLike;
  };
}

/**
 * Apply a host plugin and capture the disposers created during it as that
 * plugin's fiber, so a test can HMR-unload exactly one side (Cordis unload
 * runs a fiber's disposers; nothing registered by the other plugin is in
 * this range).
 */
function applyHostPluginInFiber(
  ctx: ReturnType<typeof createHostCtx>,
  applyFn: (ctx: never, config?: unknown) => void,
  config?: unknown,
): { dispose(): void } {
  const mark = ctx.disposers.length;
  (applyFn as (ctx: unknown, config?: unknown) => void)(ctx, config);
  // Capture the range NOW (not at dispose time) so disposers registered by
  // LATER plugins are never swept into this fiber's unload.
  const owned = ctx.disposers.slice(mark);
  return {
    dispose() {
      for (const dispose of owned.reverse()) dispose();
    },
  };
}

/** The foreign host plugin: same seam types, foreign namespace. */
function applyForeignHostPlugin(
  ctx: ReturnType<typeof createHostCtx>,
): void {
  ctx.inject(["settings"], (child: unknown) => {
    const settings = (
      child as {
        settings?: {
          installSection(
            owner: unknown,
            ns: string,
            schema: unknown,
            entry: unknown,
            hooks: unknown,
          ): unknown;
        };
      }
    ).settings;
    settings?.installSection(ctx, FOREIGN.settingsNs, {}, { enabled: true }, {});
  });
  ctx.commands.register({
    name: FOREIGN.command,
    description: "Foreign plugin greeting command.",
    handler: () => FOREIGN_COMMAND_RESULT,
  });
  ctx.tools.register({
    name: FOREIGN.tool,
    execute: async () => FOREIGN_TOOL_RESULT,
  });
}

/* -------------------------------------------------------------------- *
 * Client-face fake (ClientContext) — per-fiber slot/locale collection. *
 * -------------------------------------------------------------------- */

function createClientCtx() {
  const locales = new Map<string, unknown>();
  const injects: Array<{
    parent: string;
    entries: Array<{ options: unknown; component: unknown }>;
  }> = [];
  const injectControllers: Array<() => void> = [];
  const effectDisposers: Array<() => void> = [];

  const ctx = {
    effect(execute: () => unknown, label?: string) {
      void label;
      const returned = execute();
      const disposer: () => void =
        typeof returned === "function" ? returned : () => {};
      effectDisposers.push(disposer);
      return () => {};
    },
    slots: {
      inject(parent: string, callback: () => unknown) {
        const record = { parent, entries: [] };
        injects.push(record);
        callback();
        const controller = () => {
          const at = injects.indexOf(record);
          if (at >= 0) injects.splice(at, 1);
          record.entries.length = 0;
        };
        injectControllers.push(controller);
        return controller;
      },
      register(options: unknown, component: unknown) {
        const owner = injects.at(-1);
        assert.ok(owner, "slots.register outside of slots.inject (fake)");
        owner.entries.push({ options, component });
        return () => {};
      },
    },
    locale: {
      register(namespace: string, dictionary: unknown) {
        locales.set(namespace, dictionary);
        return () => {
          locales.delete(namespace);
        };
      },
      bind(namespace: string) {
        return (key: string) => {
          const dict = locales.get(namespace) as
            | { en: Record<string, string> }
            | undefined;
          return dict?.en[key] ?? key;
        };
      },
    },
    // Test surface.
    locales,
    injects,
    effectDisposers,
    injectControllers,
    entriesAt(parent: string) {
      return injects
        .filter((record) => record.parent === parent)
        .flatMap((record) => record.entries);
    },
    runFiberTeardown() {
      for (const dispose of [...effectDisposers, ...injectControllers]) {
        dispose();
      }
      effectDisposers.length = 0;
      injectControllers.length = 0;
    },
  };
  return ctx as typeof ctx & ClientContext & {
    locales: Map<string, unknown>;
    injects: Array<{
      parent: string;
      entries: Array<{ options: unknown; component: unknown }>;
    }>;
    effectDisposers: Array<() => void>;
    injectControllers: Array<() => void>;
    entriesAt(parent: string): Array<{
      options: unknown;
      component: unknown;
    }>;
    runFiberTeardown(): void;
  };
}

/**
 * Apply a client module and capture its effect disposers + inject
 * controllers as that module's fiber, so a test can HMR-swap exactly one
 * plugin's client face and leave the other's entries intact.
 */
function applyClientPluginInFiber(
  ctx: ReturnType<typeof createClientCtx>,
  applyFn: (ctx: never) => void,
): { dispose(): void } {
  const effectMark = ctx.effectDisposers.length;
  const controllerMark = ctx.injectControllers.length;
  (applyFn as (ctx: unknown) => void)(ctx);
  // Capture the ranges NOW (not at dispose time) so registrations by LATER
  // modules are never swept into this fiber's unload.
  const ownedEffects = ctx.effectDisposers.slice(effectMark);
  const ownedControllers = ctx.injectControllers.slice(controllerMark);
  return {
    dispose() {
      for (const dispose of ownedControllers.reverse()) dispose();
      for (const dispose of ownedEffects.reverse()) dispose();
    },
  };
}

/** The foreign client plugin: locale + overlay entry + one keyed toolview. */
function applyForeignClientPlugin(ctx: ReturnType<typeof createClientCtx>) {
  ctx.effect(() =>
    ctx.locale.register(FOREIGN.localeNs, {
      en: { "panel.title": "Helper" },
      zh: { "panel.title": "助手" },
    }),
  );
  ctx.slots.inject(SHELL_OVERLAY_SLOT, () => {
    ctx.slots.register(
      {
        name: SHELL_OVERLAY_SLOT,
        id: FOREIGN.overlayEntryId,
        order: FOREIGN.overlayOrder,
        locale: FOREIGN.localeNs,
      },
      function ForeignPanel() {},
    );
  });
  ctx.slots.inject(TOOL_CALL_TOOLVIEW_SLOT, () => {
    ctx.slots.register(
      { name: TOOL_CALL_TOOLVIEW_SLOT, key: FOREIGN.tool, locale: FOREIGN.localeNs },
      function ForeignToolview() {},
    );
  });
}

describe("coexistence — host face: fail-loud claims (Findings 1 and 2)", () => {
  /** Route a claim through ctx.inject, exactly how a live plugin installs. */
  function claimNamespace(ctx: ReturnType<typeof createHostCtx>, ns: string) {
    return () =>
      ctx.inject(["settings"], (child) => {
        (
          child as {
            settings?: {
              installSection(
                owner: unknown,
                ns: string,
                schema: unknown,
                entry: unknown,
                hooks: unknown,
              ): unknown;
            };
          }
        ).settings?.installSection({}, ns, {}, {}, {});
      });
  }

  it("both plugins register on the same seam types without interference", () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    applyDispatcherHost(ctx, { enabled: true });

    // Settings namespaces: one per plugin, both present.
    assert.ok(ctx.hasSettingsNamespace(FOREIGN.settingsNs));
    assert.ok(ctx.hasSettingsNamespace("multitask-dispatcher"));

    // Commands: ours `dispatcher-`-prefixed (design-16 §5), foreign's its own.
    assert.deepEqual(ctx.commandNames().sort(), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
      FOREIGN.command,
    ]);

    // Tools: dormant dispatcher registers none — foreign's alone (stock).
    assert.deepEqual(ctx.toolNames(), [FOREIGN.tool]);
  });

  it("a duplicate settings namespace fails loud; the first claimant stays live", () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    applyDispatcherHost(ctx, { enabled: true });

    // A latecomer tries to claim OUR namespace (Finding 1 duplicate rule).
    assert.throws(
      claimNamespace(ctx, "multitask-dispatcher"),
      /settings namespace "multitask-dispatcher" is already registered/,
    );

    // …and the same fail-loud rule protects the foreign plugin's claim.
    assert.throws(
      claimNamespace(ctx, FOREIGN.settingsNs),
      new RegExp(
        `settings namespace "${FOREIGN.settingsNs}" is already registered`,
      ),
    );

    // The first claimant is uncorrupted: its scope still reads, writes, and
    // notifies watchers under the namespace it owns.
    const scope = ctx.settingScope(FOREIGN.settingsNs);
    const seen: unknown[] = [];
    scope.watch((value) => seen.push(value));
    scope.update({ greeting: "hi" });
    assert.equal(
      (ctx.settingDoc(FOREIGN.settingsNs) as { greeting?: string }).greeting,
      "hi",
    );
    assert.equal(seen.length, 1);
  });

  it("a duplicate command name fails loud; the first claimant's handler stays live", () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    applyDispatcherHost(ctx, { enabled: true });

    // A latecomer tries to register over both plugins' command names.
    for (const name of [DISPATCHER_START_COMMAND, FOREIGN.command]) {
      assert.throws(
        () =>
          ctx.commands.register({
            name,
            description: "interloper",
            handler: () => ({ kind: "error", text: "interloper" }),
          }),
        new RegExp(`command "${name}" is already registered`),
      );
    }

    // The ORIGINAL handlers still own their names: activation still works…
    const agent = createAgent("s-1");
    assert.deepEqual(
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent }),
      { kind: "success", text: DISPATCHER_START_SUCCESS },
    );

    // …and the foreign command still routes to the foreign handler.
    assert.deepEqual(
      ctx.runCommand({ commandId: FOREIGN.command, agent }),
      FOREIGN_COMMAND_RESULT,
    );
  });
});

describe("coexistence — dormant state at the plugin boundary (design-16 §3.7)", () => {
  it("flag ON + not activated: session-start captures nothing; stock tool surface", () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    applyDispatcherHost(ctx, { enabled: true });

    // The first top-level session is NOT repurposed: no policy inject, no
    // capture, no dispatcher tools — the surface stays stock (foreign's only).
    const agent = createAgent("s-1");
    ctx.fire("agent/session-start", { agent });
    assert.equal(agent.injected.length, 0);
    assert.deepEqual(ctx.toolNames(), [FOREIGN.tool]);

    // The dormant affordances are exactly the two `dispatcher-` commands.
    assert.deepEqual(ctx.commandNames().sort(), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
      FOREIGN.command,
    ]);
  });

  it("activation raises the dispatcher surface without disturbing the foreign plugin", async () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    applyDispatcherHost(ctx, { enabled: true });

    const agent = createAgent("s-1");
    assert.deepEqual(
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent }),
      { kind: "success", text: DISPATCHER_START_SUCCESS },
    );

    // Ticket 31: the on-activation publish lands after the async durability
    // rebuild — drain the queued chain before reading the mirrored snapshot.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Six dispatcher tools alongside the foreign tool — no clobbering.
    assert.deepEqual(ctx.toolNames().sort(), [
      "check_workers",
      "deliver_result",
      FOREIGN.tool,
      "request_access",
      "spawn_worker",
      "steer_worker",
      "stop_worker",
    ]);

    // The foreign tool still executes as the foreign one.
    assert.deepEqual(
      await ctx.tool(FOREIGN.tool)?.execute({}, undefined),
      FOREIGN_TOOL_RESULT,
    );

    // The process-global tool surface means a NON-activated chat sees the
    // dispatcher tools too — the documented gate refuses it (design-16 §3.8).
    const refused = (await ctx.tool("spawn_worker")?.execute(
      { stream_key: "k", title: "T", prompt: "P" },
      { agent: { session: { id: "some-other-chat" } } },
    )) as { ok: boolean; reason: string };
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "not-activated");

    // The roster snapshot mirrors into OUR namespace only; the foreign
    // plugin's settings document is untouched.
    assert.ok(
      (ctx.settingDoc("multitask-dispatcher") as Record<string, unknown>)[
        ROSTER_SETTINGS_KEY
      ],
      "roster snapshot published under the dispatcher namespace",
    );
    assert.deepEqual(ctx.settingDoc(FOREIGN.settingsNs), { enabled: true });
  });

  it("dispatcher fiber unload (HMR) leaves the foreign plugin intact", async () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    const dispatcherFiber = applyHostPluginInFiber(
      ctx,
      applyDispatcherHost as never,
      { enabled: true },
    );
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.equal(ctx.toolNames().length, 7); // six ours + one foreign

    // HMR: dispose ONLY the dispatcher fiber.
    dispatcherFiber.dispose();

    // Everything the dispatcher registered is gone — dormant commands,
    // activated tools, listeners, and (Finding 1) its settings namespace.
    assert.deepEqual(ctx.commandNames(), [FOREIGN.command]);
    assert.deepEqual(ctx.toolNames(), [FOREIGN.tool]);
    assert.equal(ctx.hasSettingsNamespace("multitask-dispatcher"), false);

    // The foreign plugin is fully functional.
    assert.ok(ctx.hasSettingsNamespace(FOREIGN.settingsNs));
    assert.deepEqual(
      ctx.runCommand({ commandId: FOREIGN.command, agent }),
      FOREIGN_COMMAND_RESULT,
    );
    assert.deepEqual(
      await ctx.tool(FOREIGN.tool)?.execute({}, undefined),
      FOREIGN_TOOL_RESULT,
    );

    // The disposed dispatcher refuses to double as a zombie: its command is
    // unregistered, so a stale invocation cannot re-activate it.
    assert.throws(
      () => ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent }),
      /command not registered/,
    );
  });

  it("foreign fiber unload leaves the dispatcher intact and activatable", () => {
    const ctx = createHostCtx();
    const foreignFiber = applyHostPluginInFiber(
      ctx,
      applyForeignHostPlugin as never,
    );
    applyDispatcherHost(ctx, { enabled: true });

    foreignFiber.dispose();
    assert.deepEqual(ctx.commandNames().sort(), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);
    assert.ok(ctx.hasSettingsNamespace("multitask-dispatcher"));
    assert.equal(ctx.hasSettingsNamespace(FOREIGN.settingsNs), false);

    // The dispatcher still activates cleanly next to the departed plugin.
    const agent = createAgent("s-1");
    assert.deepEqual(
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent }),
      { kind: "success", text: DISPATCHER_START_SUCCESS },
    );
    assert.equal(ctx.toolNames().length, 6);
  });
});

describe("coexistence — client face: additive lists and keyed cells (Finding 5)", () => {
  it("shell.overlay holds both plugins' entries additively, order-sorted", () => {
    const ctx = createClientCtx();
    applyForeignClientPlugin(ctx);
    applyDispatcherClient(ctx);

    const entries = ctx.entriesAt(SHELL_OVERLAY_SLOT);
    // Additive: BOTH plugins' entries coexist in the same list slot —
    // neither registration replaced or evicted the other's.
    assert.equal(entries.length, 2);
    const options = entries.map((e) => e.options as SlotRegistrationOptions);
    // Finding 5 list rule: the UI sorts by `order ?? 0` — applying that
    // documented rule puts ours (quiet status surface, low order) first.
    const sorted = [...options].sort((a, b) => a.order - b.order);
    assert.deepEqual(
      sorted.map((o) => [o.id, o.order]),
      [
        [rosterOverlayRegistration().id, rosterOverlayRegistration().order],
        [FOREIGN.overlayEntryId, FOREIGN.overlayOrder],
      ],
    );
    // Ids are unique and per-plugin prefixed (design-16 §5).
    assert.match(sorted[0]!.id, /^multitask-dispatcher-/);
    assert.match(sorted[1]!.id, /^foreign-helper-/);
    assert.notEqual(sorted[0]!.id, sorted[1]!.id);
    // Each entry renders its own plugin's component.
    assert.notEqual(entries[0]!.component, entries[1]!.component);
  });

  it("tool.call.toolview: foreign key cell unaffected by the five dispatcher keys", () => {
    const ctx = createClientCtx();
    applyForeignClientPlugin(ctx);
    applyDispatcherClient(ctx);

    const entries = ctx.entriesAt(TOOL_CALL_TOOLVIEW_SLOT);
    assert.equal(entries.length, TOOLVIEW_TOOL_NAMES.length + 1);
    const keys = entries.map(
      (e) => (e.options as { key?: string }).key,
    );
    // Keyed cells: unique keys, foreign key present and unmolested.
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.includes(FOREIGN.tool));
    for (const name of TOOLVIEW_TOOL_NAMES) {
      assert.ok(keys.includes(name));
    }
    // Each key maps to its own plugin's registration and component.
    const foreignEntry = entries.find(
      (e) => (e.options as { key?: string }).key === FOREIGN.tool,
    );
    assert.deepEqual(foreignEntry?.options, {
      name: TOOL_CALL_TOOLVIEW_SLOT,
      key: FOREIGN.tool,
      locale: FOREIGN.localeNs,
    });
    for (const name of TOOLVIEW_TOOL_NAMES) {
      const ours = entries.find((e) => (e.options as { key?: string }).key === name);
      assert.deepEqual(ours?.options, toolviewRegistration(name));
      assert.notEqual(ours?.component, foreignEntry?.component);
    }
  });

  it("locale namespaces coexist; bind resolves per namespace", () => {
    const ctx = createClientCtx();
    applyForeignClientPlugin(ctx);
    applyDispatcherClient(ctx);

    assert.deepEqual([...ctx.locales.keys()].sort(), [
      FOREIGN.localeNs,
      LOCALE_NAMESPACE,
    ]);
    assert.equal(ctx.locale.bind(FOREIGN.localeNs)("panel.title"), "Helper");
    assert.equal(
      ctx.locale.bind(LOCALE_NAMESPACE)("roster.title"),
      "Workers",
    );
    // No key bleed between namespaces.
    assert.equal(ctx.locale.bind(FOREIGN.localeNs)("roster.title"), "roster.title");
    assert.equal(ctx.locale.bind(LOCALE_NAMESPACE)("panel.title"), "panel.title");
  });

  it("HMR of one client fiber leaves the other plugin's entries intact", () => {
    const ctx = createClientCtx();
    const dispatcherFiber = applyClientPluginInFiber(ctx, applyDispatcherClient);
    const foreignFiber = applyClientPluginInFiber(ctx, applyForeignClientPlugin);

    // Unload ONLY the dispatcher's client fiber (HMR swap).
    dispatcherFiber.dispose();
    assert.deepEqual(ctx.entriesAt(SHELL_OVERLAY_SLOT).map((e) => (e.options as SlotRegistrationOptions).id), [
      FOREIGN.overlayEntryId,
    ]);
    assert.deepEqual(
      ctx.entriesAt(TOOL_CALL_TOOLVIEW_SLOT).map((e) => (e.options as { key?: string }).key),
      [FOREIGN.tool],
    );
    assert.deepEqual([...ctx.locales.keys()], [FOREIGN.localeNs]);

    // The fresh post-HMR fiber re-registers cleanly — no duplication of the
    // foreign plugin's entries.
    applyDispatcherClient(ctx);
    assert.equal(ctx.entriesAt(SHELL_OVERLAY_SLOT).length, 2);
    assert.equal(ctx.entriesAt(TOOL_CALL_TOOLVIEW_SLOT).length, TOOLVIEW_TOOL_NAMES.length + 1);
    assert.deepEqual([...ctx.locales.keys()].sort(), [FOREIGN.localeNs, LOCALE_NAMESPACE]);

    // Unloading the foreign fiber afterwards removes exactly its own entries.
    foreignFiber.dispose();
    assert.equal(ctx.entriesAt(SHELL_OVERLAY_SLOT).length, 1);
    assert.deepEqual(
      ctx.entriesAt(SHELL_OVERLAY_SLOT).map((e) => (e.options as SlotRegistrationOptions).id),
      [rosterOverlayRegistration().id],
    );
    assert.equal(ctx.entriesAt(TOOL_CALL_TOOLVIEW_SLOT).length, TOOLVIEW_TOOL_NAMES.length);
    assert.deepEqual([...ctx.locales.keys()], [LOCALE_NAMESPACE]);
  });
});
