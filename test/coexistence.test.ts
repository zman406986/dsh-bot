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
import { volatileConfig } from "./support/plugin-config.js";
import {
  DISPATCHER_RESOLVE_COMMAND,
  DISPATCHER_START_COMMAND,
  DISPATCHER_START_SUCCESS,
  DISPATCHER_STEER_COMMAND,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
} from "../src/adapter/index.js";
import {
  apply as applyDispatcherClient,
  inject as clientInject,
} from "../src/client/index.js";
import type { ClientContext } from "../src/client/context.js";
import {
  LOCALE_NAMESPACE,
  SHELL_OVERLAY_SLOT,
  type SlotRegistrationOptions,
} from "../src/client/overlay.js";
import {
  MAIN_PAGE_SLOT,
  ROOT_FRAME_SLOT,
} from "../src/client/shell-mount.js";
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
 * - `settings.register(ns, schema, {base})` returns the owner scope and
 *   `settings.installSection` returns VOID (ticket 93: the live host's
 *   installSection discards the scope, dsh-settings lib/index.js:327-343,
 *   types :228; register is the scope-returning API, :281-315); a duplicate
 *   claim of one namespace throws
 *   `settings namespace "X" is already registered` and registers the
 *   namespace-removal disposer on the CALLING plugin's fiber
 *   (Finding 1: "disposing that fiber removes the namespace");
 * - `commands.register` throws
 *   `command "X" is already registered …` on a duplicate name; the disposer
 *   unregisters only its own definition (Finding 2);
 * - `tools.register` throws `tool "X" is already registered …` on a
 *   duplicate name (ticket 91; dsh-tools lib/index.js:2538) and otherwise
 *   coexists by unique name, returning the exact disposer (the contract the
 *   deferred dispatcher surface relies on).
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
    /**
     * Host shape (ticket 93): the SCOPE-RETURNING API
     * (`@deepseek-ai/dsh-settings/lib/index.js:281-315`).
     */
    register(ns: string, _schema: unknown, options?: { base?: unknown }) {
      return claimNamespace(ns, options?.base);
    },
    /**
     * Host shape (ticket 93): `installSection(owner, ns, schema, entry,
     * hooks)` returns VOID — it claims the namespace through `register` and
     * DISCARDS the scope (`dsh-settings/lib/index.js:327-343`; the shipped
     * type is `installSection(…): void`, `lib/types/index.d.ts:228`). The
     * composition `entry` becomes the base layer, exactly as `register`'s
     * `options.base` does.
     */
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
      claimNamespace(ns, entry);
    },
  };

  /** One namespace claim: duplicate THROWS, the scope watches the doc. */
  function claimNamespace(
    ns: string,
    base: unknown,
  ): {
    get(): unknown;
    watch(onChange: (value: unknown) => void): () => void;
    update(value: unknown): Promise<void>;
    replace(value: unknown): Promise<void>;
  } {
    if (settingDocs.has(ns)) {
      throw new Error(`settings namespace "${ns}" is already registered`);
    }
    settingDocs.set(ns, { ...(base as Record<string, unknown>) });
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
      // The host scope's writes are ASYNC (dsh-settings
      // lib/types/index.d.ts:105-108); the document updates synchronously
      // inside, exactly as the host's queued write does before it resolves.
      async update(value: unknown) {
        const current = settingDocs.get(ns);
        if (current === undefined) return; // namespace already disposed
        const next = { ...current, ...(value as Record<string, unknown>) };
        settingDocs.set(ns, next);
        for (const onChange of [...watchers]) onChange(next);
      },
      async replace(value: unknown) {
        if (!settingDocs.has(ns)) return;
        settingDocs.set(ns, value as Record<string, unknown>);
        for (const onChange of [...watchers]) onChange(value);
      },
    };
    settingScopes.set(ns, scope);
    return scope;
  }

  const ctx = {
    // Cordis effect contract (ticket 44): `execute` runs at apply; a returned
    // function — or each value a generator yields — is the unload disposer.
    // (The host-half fake must mirror live cordis, like the client-half fake
    // below already does.)
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
          // Verbatim shipped wording (dsh-commands lib/index.js:82).
          throw new Error(
            `command "${definition.name}" is already registered (for a ` +
              `per-agent variant, mount a command-injected plugin under ` +
              `that agent's \`agent.ctx\`)`,
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
        // Ticket 91: the tool registry is fail-loud on a duplicate name too
        // (dsh-tools lib/index.js:2538, same NamedEntries factory) — a
        // second plugin claiming a tool name must not silently replace the
        // first's definition.
        if (tools.has(definition.name)) {
          throw new Error(
            `tool "${definition.name}" is already registered (for a ` +
              `per-agent variant, register through that agent's ` +
              `\`agent.ctx\` instead)`,
          );
        }
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

/**
 * Ticket 85 (2026-09-19): the slots fake models the shipped SlotCore
 * registry's collision rule — one global cell per slot name, entries kept
 * sorted ASCENDING by `(priority ?? 0)`, and `register` THROWS on a
 * same-(priority ?? 0) collision along the entry's identity axis (single:
 * every entry; keyed: same `key`; list: same `id`) with the host's error
 * wording ("… at priority N — register at a different priority to shadow it
 * (lowest renders)"). An absent priority defaults to 0 exactly like the
 * shipped code, so the ticket-85 live crash (no-priority root register vs
 * the shipped frame) now fails offline. The per-entry dispose (register's
 * return, run by the inject controller on fiber teardown) removes the entry,
 * so unload/HMR frees the cell like the shipped registry's cascade.
 * (dsh-web-frontend `dist/assets/index-BKQ_L1z6.js`, SlotCore.register +
 * `entriesOfSlot`, minified.)
 */
function createClientCtx() {
  const locales = new Map<string, unknown>();
  const cells = new Map<
    string,
    Array<{
      options: Record<string, unknown>;
      component: unknown;
      dispose(): void;
    }>
  >();
  const injects: Array<{
    parent: string;
    entries: Array<{
      options: Record<string, unknown>;
      component: unknown;
      dispose(): void;
    }>;
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
        const record = { parent, entries: [] as typeof injects[number]["entries"] };
        injects.push(record);
        callback();
        const controller = () => {
          const at = injects.indexOf(record);
          if (at >= 0) injects.splice(at, 1);
          for (const entry of record.entries.splice(0)) entry.dispose();
        };
        injectControllers.push(controller);
        return controller;
      },
      register(rawOptions: unknown, component: unknown) {
        const owner = injects.at(-1);
        assert.ok(owner, "slots.register outside of slots.inject (fake)");
        const options = rawOptions as {
          name: string;
          key?: string;
          id?: string;
          priority?: number;
        };
        assert.equal(
          typeof options.name,
          "string",
          "slot options need a string `name` (fake)",
        );
        const cell = cells.get(options.name) ?? [];
        cells.set(options.name, cell);
        const priority = options.priority ?? 0;
        const collision = cell.find((entry) => {
          const other = entry.options as {
            key?: string;
            id?: string;
            priority?: number;
          };
          if (options.key !== undefined) {
            return other.key === options.key && (other.priority ?? 0) === priority;
          }
          if (options.id !== undefined) {
            return other.id === options.id && (other.priority ?? 0) === priority;
          }
          return (other.priority ?? 0) === priority;
        });
        if (collision !== undefined) {
          // Host wording per kind, verbatim from SlotCore.register (the
          // registrant suffix is omitted — the fake has none): single says
          // "already has a registration", keyed "already has an entry for
          // key", list "already has an entry with id". Ticket 86 corrected
          // the keyed/list text (it had reused the single-slot phrasing).
          const target =
            options.key !== undefined
              ? `already has an entry for key "${options.key}"`
              : options.id !== undefined
                ? `already has an entry with id "${options.id}"`
                : "already has a registration";
          const kind =
            options.key !== undefined
              ? "keyed slot"
              : options.id !== undefined
                ? "list slot"
                : "single slot";
          throw new Error(
            `${kind} "${options.name}" ${target} at priority ${priority} — ` +
              `register at a different priority to shadow it (lowest renders)`,
          );
        }
        const entry = {
          options: { ...rawOptions } as Record<string, unknown>,
          component,
          dispose: () => {},
        };
        cell.push(entry);
        // Insert-time ascending (priority ?? 0) sort, stable for ties —
        // first registered first — exactly the shipped registry's order.
        cell.sort(
          (a, b) =>
            ((a.options.priority as number | undefined) ?? 0) -
            ((b.options.priority as number | undefined) ?? 0),
        );
        entry.dispose = () => {
          const ownerAt = owner.entries.indexOf(entry);
          if (ownerAt >= 0) owner.entries.splice(ownerAt, 1);
          const cellAt = cell.indexOf(entry);
          if (cellAt >= 0) cell.splice(cellAt, 1);
        };
        owner.entries.push(entry);
        return entry.dispose;
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
    /** The slot's live cell in host election order (ascending priority). */
    slotCell(name: string) {
      return (cells.get(name) ?? []).map((entry) => ({ ...entry.options }));
    },
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
  // Ticket 84: the fake models the host's inject guard — a plugin reading a
  // service property outside its declared inject list throws the context
  // proxy's `cannot get property "X" without inject`. Both client faces
  // exercised here (the dispatcher's and the foreign helper's) must read
  // only declared faces.
  const declared = new Set<string>([...clientInject]);
  const serviceFaces = new Set([
    "slots",
    "locale",
    "sessions",
    "remote",
    // Ticket 102b: the nested face is its own entry under the full dotted
    // name — the resolver matches inject entries by exact string and never
    // dot-splits.
    "remote.commands",
    "conversation",
    "configForms",
  ]);
  return new Proxy(ctx as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (
        typeof prop === "string" &&
        serviceFaces.has(prop) &&
        !declared.has(prop)
      ) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as typeof ctx & ClientContext & {
    locales: Map<string, unknown>;
    injects: Array<{
      parent: string;
      entries: Array<{ options: unknown; component: unknown }>;
    }>;
    effectDisposers: Array<() => void>;
    injectControllers: Array<() => void>;
    slotCell(name: string): Array<Record<string, unknown>>;
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
  /**
   * Route a claim through ctx.inject, exactly how a live plugin installs.
   * Ticket 93: the product claims through `register` (the scope-returning
   * API); `installSection` is modeled too, as the void convenience the host
   * ships for read-only consumers.
   */
  function claimNamespace(ctx: ReturnType<typeof createHostCtx>, ns: string) {
    return () =>
      ctx.inject(["settings"], (child) => {
        (
          child as {
            settings?: {
              register(ns: string, schema: unknown, options?: unknown): unknown;
            };
          }
        ).settings?.register(ns, {}, {});
      });
  }

  function claimViaInstallSection(
    ctx: ReturnType<typeof createHostCtx>,
    ns: string,
  ) {
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
    applyDispatcherHost(ctx, volatileConfig({ enabled: true }));

    // Settings namespaces: only the foreign plugin claims one. dsh 0.2.1 has
    // no registration API — our form is the plugin's own Config schema, keyed
    // by the Loader row id, so there is nothing to claim.
    assert.ok(ctx.hasSettingsNamespace(FOREIGN.settingsNs));
    assert.equal(ctx.hasSettingsNamespace("multitask-dispatcher"), false);

    // Commands: ours `dispatcher-`-prefixed (design-16 §5), foreign's its own.
    assert.deepEqual(ctx.commandNames().sort(), [
      DISPATCHER_RESOLVE_COMMAND,
      DISPATCHER_STEER_COMMAND,
      // "dsh-bot" sorts after the dispatcher- names (ADR-0030 rename).
      DISPATCHER_START_COMMAND,
      FOREIGN.command,
    ]);

    // Tools: dormant dispatcher registers none — foreign's alone (stock).
    assert.deepEqual(ctx.toolNames(), [FOREIGN.tool]);
  });

  it("a duplicate settings namespace fails loud; the first claimant stays live", () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    applyDispatcherHost(ctx, volatileConfig({ enabled: true }));

    // A latecomer cannot take the foreign plugin's namespace (Finding 1
    // duplicate rule). Our plugin claims none, so there is nothing of ours
    // to defend here.
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

  it("installSection returns void (ticket 93) but still claims the namespace", () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);

    // The host's convenience install DISCARDS the scope
    // (dsh-settings lib/index.js:327-343; types :228) — a product that
    // reads its return value gets `undefined`, exactly as live.
    const claimed = claimViaInstallSection(ctx, "third-party");
    claimed();
    assert.ok(ctx.hasSettingsNamespace("third-party"));
    // …and the duplicate rule still fires for the same namespace.
    assert.throws(
      claimViaInstallSection(ctx, "third-party"),
      /settings namespace "third-party" is already registered/,
    );
    // The foreign plugin's own claim (through installSection) is likewise
    // protected from a `register` latecomer.
    assert.throws(
      claimNamespace(ctx, FOREIGN.settingsNs),
      new RegExp(
        `settings namespace "${FOREIGN.settingsNs}" is already registered`,
      ),
    );
  });

  it("a duplicate command name fails loud; the first claimant's handler stays live", () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    applyDispatcherHost(ctx, volatileConfig({ enabled: true }));

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

  it("a duplicate tool name fails loud; the first claimant's definition stays live (ticket 91)", async () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    applyDispatcherHost(ctx, volatileConfig({ enabled: true }));

    // Activate so the dispatcher's own tool names are on the surface.
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));

    // A latecomer tries to register over both plugins' tool names.
    for (const name of ["spawn_worker", FOREIGN.tool]) {
      assert.throws(
        () =>
          ctx.tools.register({
            name,
            execute: async () => ({ ok: false }),
          }),
        new RegExp(`tool "${name}" is already registered`),
      );
    }

    // The first claimant's definition is untouched: the dispatcher tool still
    // executes (it was not replaced by the interloper).
    const spawn = ctx.tool("spawn_worker");
    assert.ok(spawn);
    const value = (await spawn.execute(
      { stream_key: "s", title: "T", prompt: "P" },
      { agent: { session: { id: "s-1" } } },
    )) as { ok: boolean };
    assert.equal(value.ok, true);
  });
});

describe("coexistence — dormant state at the plugin boundary (design-16 §3.7)", () => {
  it("flag ON + not activated: session-start captures nothing; stock tool surface", () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    applyDispatcherHost(ctx, volatileConfig({ enabled: true }));

    // The first top-level session is NOT repurposed: no policy inject, no
    // capture, no dispatcher tools — the surface stays stock (foreign's only).
    const agent = createAgent("s-1");
    ctx.fire("agent/session-start", { agent });
    assert.equal(agent.injected.length, 0);
    assert.deepEqual(ctx.toolNames(), [FOREIGN.tool]);

    // The dormant affordances are exactly the `dispatcher-` commands.
    assert.deepEqual(ctx.commandNames().sort(), [
      DISPATCHER_RESOLVE_COMMAND,
      DISPATCHER_STEER_COMMAND,
      // "dsh-bot" sorts after the dispatcher- names (ADR-0030 rename).
      DISPATCHER_START_COMMAND,
      FOREIGN.command,
    ]);
  });

  it("activation raises the dispatcher surface without disturbing the foreign plugin", async () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    applyDispatcherHost(ctx, volatileConfig({ enabled: true }));

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

    // The dispatcher surface (eight tools since ticket 118 + request_access
    // + the ticket-145 per-session recall, which this context-less agent
    // takes on the plugin-level fallback) alongside the foreign tool — no
    // clobbering.
    assert.deepEqual(ctx.toolNames().sort(), [
      "await_agent",
      "check_workers",
      "deliver_result",
      FOREIGN.tool,
      "message_agent",
      "recall",
      "request_access",
      "spawn_dispatcher",
      "spawn_worker",
      "steer_worker",
      "stop_worker",
    ]);

    // The foreign tool still executes as the foreign one.
    assert.deepEqual(
      await ctx.tool(FOREIGN.tool)?.execute({}, undefined),
      FOREIGN_TOOL_RESULT,
    );

    // ADR-0019 retired the process-global execute-time gate. This agent
    // carries no scoped ctx, so the five tools registered through the
    // plugin-level FALLBACK surface and an out-of-scope exec is no longer
    // refused — it routes to the session that registered the tool. (Live
    // hosts register per agent scope, where an out-of-scope caller cannot
    // see the tool at all — the strictly stronger fence.)
    const crossCaller = (await ctx.tool("spawn_worker")?.execute(
      { stream_key: "k", title: "T", prompt: "P" },
      { agent: { session: { id: "some-other-chat" } } },
    )) as { ok: boolean } | undefined;
    assert.equal(crossCaller?.ok, true);

    // The roster mirror has no channel on 0.2.1 (undeclared settings keys are
    // rejected), so our namespace is never created and the foreign plugin's
    // settings document stays untouched.
    assert.equal(ctx.hasSettingsNamespace("multitask-dispatcher"), false);
    assert.deepEqual(ctx.settingDoc(FOREIGN.settingsNs), { enabled: true });
  });

  it("dispatcher fiber unload (HMR) leaves the foreign plugin intact", async () => {
    const ctx = createHostCtx();
    applyForeignHostPlugin(ctx);
    const dispatcherFiber = applyHostPluginInFiber(
      ctx,
      applyDispatcherHost as never,
      volatileConfig({ enabled: true }),
    );
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.equal(ctx.toolNames().length, 11); // ten ours + one foreign

    // HMR: dispose ONLY the dispatcher fiber.
    dispatcherFiber.dispose();

    // Everything the dispatcher registered is gone — dormant commands,
    // activated tools, and listeners.
    assert.deepEqual(ctx.commandNames(), [FOREIGN.command]);
    assert.deepEqual(ctx.toolNames(), [FOREIGN.tool]);

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
    applyDispatcherHost(ctx, volatileConfig({ enabled: true }));

    foreignFiber.dispose();
    assert.deepEqual(ctx.commandNames().sort(), [
      DISPATCHER_RESOLVE_COMMAND,
      DISPATCHER_STEER_COMMAND,
      // "dsh-bot" sorts after the dispatcher- names (ADR-0030 rename).
      DISPATCHER_START_COMMAND,
    ]);
    assert.ok(ctx.hasSettingsNamespace("multitask-dispatcher") === false);
    assert.equal(ctx.hasSettingsNamespace(FOREIGN.settingsNs), false);

    // The dispatcher still activates cleanly next to the departed plugin.
    const agent = createAgent("s-1");
    assert.deepEqual(
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent }),
      { kind: "success", text: DISPATCHER_START_SUCCESS },
    );
    assert.equal(ctx.toolNames().length, 10);
  });
});

describe("coexistence — client face: additive lists and keyed cells (Finding 5)", () => {
  it("the dispatcher registers NOTHING into dsh's layout cells (`root`/`main`); foreign modules untouched", () => {
    const ctx = createClientCtx();
    applyForeignClientPlugin(ctx);
    const dispatcherFiber = applyClientPluginInFiber(
      ctx,
      applyDispatcherClient,
    );

    // Ticket 99 (2026-09-20, ADR-0021): the displacement registrations left
    // the default posture — no `root` election (the ticket-78 cutover's
    // dynamic entry, retired) and no keyed full-cell `main` page (the
    // ticket-78 staging registration, retired). Stock dsh is the primary UI
    // and is never displaced; the foreign module must not sneak in either.
    const layoutInjects = ctx.injects.filter(
      (record) =>
        record.parent === ROOT_FRAME_SLOT || record.parent === MAIN_PAGE_SLOT,
    );
    assert.equal(layoutInjects.length, 0, "no layout injects from anyone");
    for (const record of ctx.injects) {
      for (const entry of record.entries) {
        const name = (entry.options as { name: string }).name;
        assert.notEqual(name, ROOT_FRAME_SLOT, "no `root` entry");
        assert.notEqual(name, MAIN_PAGE_SLOT, "no `main` entry");
      }
    }
    // Additive/keyed coexistence still holds: the dispatcher's toolviews
    // (serving the stock chat) plus the foreign toolview, and the two
    // locale namespaces.
    assert.equal(
      ctx.entriesAt(TOOL_CALL_TOOLVIEW_SLOT).length,
      TOOLVIEW_TOOL_NAMES.length + 1,
    );
    assert.deepEqual([...ctx.locales.keys()].sort(), [
      FOREIGN.localeNs,
      LOCALE_NAMESPACE,
    ]);

    // Unload (HMR) of ONLY the dispatcher fiber removes exactly its own
    // registrations while every foreign registration stays as it was.
    dispatcherFiber.dispose();
    assert.deepEqual(
      ctx.injects.filter(
        (record) =>
          record.parent === ROOT_FRAME_SLOT ||
          record.parent === MAIN_PAGE_SLOT,
      ),
      [],
    );
    assert.deepEqual(ctx.entriesAt(TOOL_CALL_TOOLVIEW_SLOT).map((e) => (e.options as { key?: string }).key), [
      FOREIGN.tool,
    ]);
    assert.deepEqual(ctx.entriesAt(SHELL_OVERLAY_SLOT).map((e) => (e.options as SlotRegistrationOptions).id), [
      FOREIGN.overlayEntryId,
    ]);
    assert.deepEqual([...ctx.locales.keys()], [FOREIGN.localeNs]);
  });

  it("shell.overlay: the dispatcher registers nothing (capsule + launcher retired); the foreign entry stands alone", () => {
    const ctx = createClientCtx();
    applyForeignClientPlugin(ctx);
    applyDispatcherClient(ctx);

    const entries = ctx.entriesAt(SHELL_OVERLAY_SLOT);
    // The ticket-78 CUTOVER (2026-09-19) ends the capsule era: both of our
    // additive entries (the roster capsule, the staging launcher chip)
    // stopped registering. Ticket 99 (ADR-0021) then retired the
    // displacement registrations too — nothing of ours registers anywhere
    // in the shipped layout. The foreign plugin's entry is unmolested.
    assert.equal(entries.length, 1);
    const options = entries[0]!.options as SlotRegistrationOptions;
    assert.equal(options.id, FOREIGN.overlayEntryId);
    assert.equal(options.order, FOREIGN.overlayOrder);
    assert.match(options.id, /^foreign-helper-/);
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

    // Unload ONLY the dispatcher's client fiber (HMR swap): its toolviews
    // and settings card leave (the `root` election and keyed `main` page
    // retired from the composition at ticket 99 — ADR-0021); the foreign
    // plugin's entries stay.
    dispatcherFiber.dispose();
    assert.deepEqual(ctx.injects.filter((record) => record.parent === ROOT_FRAME_SLOT), []);
    assert.deepEqual(ctx.entriesAt(SHELL_OVERLAY_SLOT).map((e) => (e.options as SlotRegistrationOptions).id), [
      FOREIGN.overlayEntryId,
    ]);
    assert.deepEqual(
      ctx.entriesAt(TOOL_CALL_TOOLVIEW_SLOT).map((e) => (e.options as { key?: string }).key),
      [FOREIGN.tool],
    );
    assert.deepEqual([...ctx.locales.keys()], [FOREIGN.localeNs]);

    // The fresh post-HMR fiber re-registers cleanly — no duplication of the
    // foreign plugin's entries, and still NO overlay entries of ours (the
    // capsule + launcher retired at the cutover).
    applyDispatcherClient(ctx);
    assert.equal(ctx.entriesAt(SHELL_OVERLAY_SLOT).length, 1);
    assert.equal(ctx.entriesAt(TOOL_CALL_TOOLVIEW_SLOT).length, TOOLVIEW_TOOL_NAMES.length + 1);
    assert.deepEqual([...ctx.locales.keys()].sort(), [FOREIGN.localeNs, LOCALE_NAMESPACE]);

    // Unloading the foreign fiber afterwards removes exactly its own entries.
    foreignFiber.dispose();
    assert.equal(ctx.entriesAt(SHELL_OVERLAY_SLOT).length, 0);
    assert.equal(ctx.entriesAt(TOOL_CALL_TOOLVIEW_SLOT).length, TOOLVIEW_TOOL_NAMES.length);
    assert.deepEqual([...ctx.locales.keys()], [LOCALE_NAMESPACE]);
  });
});
