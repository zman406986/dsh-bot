/**
 * Plugin scaffold — the Cordis plugin contract (name/inject/Config) plus a
 * stub host context driving the real `apply()`.
 *
 * Fake-vs-host (ticket 91): `ctx.commands.register` and `ctx.tools.register`
 * model the shipped fail-loud duplicate rules — a second registration of the
 * same name THROWS the host's exact message, because both registries are
 * `NamedEntries` tables whose insert() rejects a live key
 * (`@deepseek-ai/dsh-commands/lib/index.js:82` and
 * `@deepseek-ai/dsh-tools/lib/index.js:2538`). A duplicate that used to pass
 * silently here now aborts this fake's `apply()` exactly as it aborts live
 * activation (the ticket-84/85 amplifier class).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Config,
  INBOX_JOB_PROMPT_CLAMP_CHARS,
  apply,
  clampInboxJobPrompt,
  composeWakeText,
  inject,
  name,
  resolveInboxJobDir,
} from "../src/plugin.js";
import {
  DISPATCHER_TOOL_NAMES,
  POLICY_SECTION_HEADINGS_ZH,
} from "../src/core/policy/prompts.js";
import type { Multitask } from "../src/core/multitask.js";
import { volatileConfig } from "./support/plugin-config.js";
import {
  DISPATCHER_START_COMMAND,
  DISPATCHER_STEER_COMMAND,
} from "../src/adapter/index.js";
import type {
  ActivationSpecLike,
  AdapterContext,
  AgentHandleLike,
  AgentLike,
  CommandDefinitionLike,
  CreateAgentOptionsLike,
  ToolsLike,
} from "../src/adapter/cordis-dsh-host.js";

interface ScopedToolSurface extends ToolsLike {
  register(definition: unknown): () => void;
  /** Every name currently in the registry, restricted or not. */
  registeredNames(): string[];
  /** What this scope actually exposes after `restrict` filtering. */
  visibleNames(): string[];
  /** Every restriction applied through the host's `restrict` seam. */
  restrictCalls: Array<{
    deny?: readonly string[];
    allow?: readonly string[];
  }>;
  /** The host's inherited-layer filter; returns the restriction disposer. */
  restrict(filter: {
    deny?: readonly string[];
    allow?: readonly string[];
  }): () => void;
  /** Scope arguments the plugin used to read the inherited surface. */
  schemasScopeCalls: unknown[];
  get(
    name: string,
  ): { execute: (args: unknown, exec?: unknown) => Promise<unknown> } | undefined;
}

/**
 * ADR-0019: the live host mints a scoped tool surface per agent. Tests now
 * default to it because the plugin refuses the old process-global fallback
 * (it exposed every dispatcher tool to every session and closed over one
 * session id).
 */
function createScopedTools(options?: {
  /** Make every disposer throw, for teardown-isolation tests. */
  disposeThrows?: boolean;
  /**
   * Tools the PRESET already mounted on this scope (the host's inherited
   * layer: `subagent`, `subagent_fork`, `list_subagent_models`, …). They are
   * visible to `schemas()` before the plugin registers anything, exactly like
   * the live agent plane.
   */
  hostTools?: readonly string[];
}): ScopedToolSurface {
  const scoped = new Map<
    string,
    { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  /** Names hidden by the host's restriction filter (inherited layer only). */
  const denied = new Set<string>();
  const restrictCalls: Array<{
    deny?: readonly string[];
    allow?: readonly string[];
  }> = [];
  const schemasScopeCalls: unknown[] = [];
  for (const name of options?.hostTools ?? []) {
    scoped.set(name, { name, execute: async () => ({ ok: true }) });
  }
  return {
    schemas(scope?: unknown) {
      if (scope !== undefined) schemasScopeCalls.push(scope);
      return [...scoped.keys()]
        .filter((name) => !denied.has(name))
        .map((name) => ({ name }));
    },
    register(definition: unknown) {
      const tool = definition as {
        name: string;
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      };
      // Shipped rule: a duplicate tool name throws
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
        if (options?.disposeThrows === true) {
          throw new Error("tool disposer exploded");
        }
        scoped.delete(tool.name);
      };
    },
    registeredNames: () => [...scoped.keys()],
    visibleNames: () =>
      [...scoped.keys()].filter((name) => !denied.has(name)),
    restrict(filter) {
      restrictCalls.push(filter);
      const names = filter.deny ?? [];
      for (const name of names) denied.add(name);
      return () => {
        for (const name of names) denied.delete(name);
      };
    },
    restrictCalls,
    schemasScopeCalls,
    get: (name) => scoped.get(name),
  };
}

interface ScaffoldAgent extends AgentLike {
  readonly tools: ScopedToolSurface;
  readonly injected: unknown[];
}

/** A pre-scoped agent with no tool context and no injected policy recorder. */
function createBareAgent(id: string): AgentLike {
  return {
    session: { id, header: { parentSession: null, delegationDepth: 0 } },
    followup() {},
    inject() {},
  };
}

/** Capture `console.warn` output for the duration of `run`. */
function captureWarnings(run: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

/** Text of the first text block of an injected message. */
function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

function createAgent(
  id: string,
  options?: {
    disposeThrows?: boolean;
    hostTools?: readonly string[];
    /**
     * Model the host committing an injected context message to the session
     * log. `transcriptCarriesPolicy` reads exactly that log, so a retry after
     * a failed activation can prove the policy is not injected twice.
     */
    commitInjects?: boolean;
  },
): ScaffoldAgent {
  const tools = createScopedTools(options);
  const injected: unknown[] = [];
  return {
    session: {
      id,
      // ADR-0032: a summoned dispatcher inherits the summoner's cwd; the
      // cross-session route refuses a session whose header carries none.
      header: { parentSession: null, delegationDepth: 0, cwd: "C:\\work" },
      ...(options?.commitInjects === true
        ? {
            snapshotEvents: () =>
              injected.map((message) => ({
                type: "user/message",
                data: message,
              })),
          }
        : {}),
    },
    followup() {},
    inject(message: unknown) {
      injected.push(message);
    },
    injected,
    ctx: { tools },
    tools,
  };
}

/**
 * Ticket 112: a dispatcher agent that records what reached it, so a test can
 * assert whether a wake opened a turn (through `followup`) — before or after
 * teardown. It carries the same scoped surface as a live agent.
 */
function createRecordingAgent(
  id: string,
): ScaffoldAgent & { readonly followups: unknown[] } {
  const followups: unknown[] = [];
  const tools = createScopedTools();
  const injected: unknown[] = [];
  return {
    session: { id, header: { parentSession: null, delegationDepth: 0 } },
    followup(message: unknown) {
      followups.push(message);
    },
    inject(message: unknown) {
      injected.push(message);
    },
    injected,
    ctx: { tools },
    tools,
    followups,
  };
}

function createStubCtx(options?: {
  /** Ticket 112: agents `ctx.agents.get` resolves (wake delivery target). */
  agentsById?: ReadonlyMap<string, AgentLike>;
  /** Guarded service read (`ctx.get`) the host would provide, if any. */
  getService?: (name: string) => unknown;
  /** Make the marker domain's `close()` reject, for teardown-isolation tests. */
  storageCloseError?: unknown;
}): AdapterContext & {
  effect: (execute: () => unknown, label?: string) => unknown;
  inject: (
    services: readonly string[],
    callback: (child: Record<string, never>) => void,
  ) => void;
  get?: (name: string) => unknown;
  disposers: Array<() => void>;
  listeners: Map<string, Array<(payload: never) => void>>;
  commands: {
    register(definition: CommandDefinitionLike): () => void;
  };
  registeredCommands: CommandDefinitionLike[];
  registeredTools: Array<{ name: string }>;
  /** Ticket 118: every activation spec the fake host's `subagents` received. */
  activationCalls: ActivationSpecLike[];
  /**
   * ADR-0032 / ticket 157: every top-level create the host asked for. This is
   * the far side of the dispatcher spawn seam now — a summon used to arrive at
   * `subagents.startActivation` and no longer does.
   */
  createCalls: CreateAgentOptionsLike[];
  /** The first turn handed to each created session (`agent.followup`). */
  createFollowups: unknown[];
  /** Names composed on each created session's OWN tool scope (ADR-0019). */
  createdToolNames: string[];
  /** Variadic: some buses pass extra args (session/event is two-arg). */
  fire(name: string, ...payloads: unknown[]): void;
  runCommand(inv: { commandId: string; agent: AgentLike }): void;
} {
  const disposers: Array<() => void> = [];
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const tables = new Map<string, Map<string, unknown>>();
  const registeredCommands: CommandDefinitionLike[] = [];
  const activationCalls: ActivationSpecLike[] = [];
  const createCalls: CreateAgentOptionsLike[] = [];
  const createFollowups: unknown[] = [];
  const createdToolNames: string[] = [];
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
    activationCalls,
    createCalls,
    createFollowups,
    createdToolNames,
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
    ...(options?.getService === undefined
      ? {}
      : { get: options.getService }),
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
        // Shipped rule: a duplicate name throws
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
    tools: {
      schemas: () => registeredTools.map((tool) => ({ name: tool.name })),
      register(definition: { name: string } & {
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      }) {
        // Shipped rule: a duplicate name throws
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
      async startActivation(spec: ActivationSpecLike) {
        activationCalls.push(spec);
        return { childId: "child-stub", dispose: async () => {} };
      },
      interrupt() {},
      async sendMessage() {
        return "msg-stub";
      },
    },
    agents: {
      get(id: unknown) {
        return options?.agentsById?.get(String(id));
      },
      /**
       * ADR-0032 / ticket 157: the summon path. The real host creates a
       * TOP-LEVEL session here (no `parentAgent`), runs `setup` before
       * publication and then publishes; this stub does the same order —
       * `setup` first, so the child's own tool surface exists before the
       * first turn — and records what reached it. `sessionId` is the
       * reservation the host minted, so the returned agent's id must be
       * exactly that (the real factory refuses a mismatch).
       */
      async create(createOptions: CreateAgentOptionsLike) {
        createCalls.push(createOptions);
        const created: AgentLike = {
          session: {
            id: createOptions.sessionId,
            // A top-level session: no parent, depth 0, meta carries cwd only.
            header: {
              parentSession: undefined,
              delegationDepth: 0,
              ...(createOptions.meta?.cwd === undefined
                ? {}
                : { cwd: createOptions.meta.cwd }),
            },
          },
          followup(message: unknown) {
            createFollowups.push(message);
          },
          inject() {},
          ctx: {
            tools: {
              schemas() {
                return [];
              },
              register(definition: unknown) {
                createdToolNames.push(
                  String((definition as { name?: unknown }).name),
                );
                return () => {};
              },
            },
          },
        };
        await createOptions.setup?.(created.ctx, created);
        const handle: AgentHandleLike = {
          agent: created,
          async dispose() {},
        };
        return handle;
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
          async close() {
            if (options?.storageCloseError !== undefined) {
              throw options.storageCloseError;
            }
          },
          name,
        };
      },
    },
  };
  return ctx as typeof ctx & AdapterContext;
}

/**
 * The tools THIS PLUGIN registers on the dispatcher's OWN scope (racoons off
 * by default). Workers, status, steering and stopping are the preset's stock
 * `subagent` / `list_agents` / `send_message` / `interrupt_agent`, which no
 * fixture in this file mounts — so every count below is the custom set only.
 */
const DISPATCHER_TOOL_COUNT = DISPATCHER_TOOL_NAMES.length;

describe("plugin scaffold", () => {
  it("exports the Cordis plugin contract", () => {
    assert.equal(name, "multitask-dispatcher");
    // Ticket 174 / ADR-0033 removed `userQuestions` (the access-prompt seam)
    // and `approval` (the dispatch-approval seam) from the inject list.
    assert.deepEqual(inject, [
      "subagents",
      "agents",
      "storageDomain",
      "tools",
      "commands",
    ]);
    assert.ok(Config);
  });

  it("apply registers through ctx.effect and the disposer is callable", () => {
    const ctx = createStubCtx();

    apply(ctx, volatileConfig({ enabled: true }));
    // Activation command + lifecycle cleanup (+ tools after activation).
    assert.ok(ctx.disposers.length >= 1);
    assert.doesNotThrow(() => {
      for (const dispose of ctx.disposers) dispose();
    });
  });

  it("apply is a no-op when disabled", () => {
    const ctx = createStubCtx();

    apply(ctx, volatileConfig({ enabled: false }));
    assert.equal(ctx.disposers.length, 0);
  });

  it("dormant apply wires passive listeners without session-start capture", () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    // Ticket 19: the agent/session-start capture is deleted.
    assert.equal(ctx.listeners.has("agent/session-start"), false);
    assert.ok(ctx.listeners.get("agent/status"));
    assert.ok(ctx.listeners.get("agent/disposed"));
    assert.ok(ctx.listeners.get("subagent/end"));
  });

  it("dormant apply registers the host commands, no tools", () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    assert.deepEqual(ctx.registeredCommands.map((c) => c.name), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);
    // Deferred to activation (ticket 19): the tool surface stays stock.
    assert.equal(ctx.registeredTools.length, 0);
  });

  it("command registration survives apply (cordis effect contract, ticket 44)", () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    // The contract-faithful fake runs `execute` at apply exactly like live
    // cordis: a plugin that handed the register DISPOSER to `ctx.effect`
    // would invoke it right here and silently unregister the command — the
    // live 2026-09-18 re-pass bug (ticket 44). Every command must still be
    // present, and each effect must have contributed exactly one real
    // cleanup (the command registrations + the teardown), so an HMR
    // dispose-all unregisters everything through the collected disposers.
    assert.deepEqual(ctx.registeredCommands.map((c) => c.name), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);
    // Two command registrations + the teardown. Ticket 174 / ADR-0033 removed
    // the `/dispatcher-resolve` command; owner ruling 2026-11-05 keeps the
    // racoons mount off by default, so it contributes no disposer.
    assert.equal(ctx.disposers.length, 3);
    for (const dispose of [...ctx.disposers]) dispose();
    assert.equal(ctx.registeredCommands.length, 0);
  });

  it("command activation registers the tool surface; dispose reverses it", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));

    // The custom three (deliver_result, message_agent, spawn_dispatcher). The
    // stock agent verbs are mounted by the preset — this fixture mounts none,
    // so the whole surface here is exactly the custom set. Ticket 174 /
    // ADR-0033 removed the worker access tool; owner ruling 2026-11-05 keeps
    // racoons off by default, so no per-session `recall`. The surface is the
    // agent's own scope — never the process-global one.
    assert.deepEqual(
      agent.tools.registeredNames().sort(),
      [...DISPATCHER_TOOL_NAMES].sort(),
    );
    for (const tool of DISPATCHER_TOOL_NAMES) {
      assert.ok(
        agent.tools.registeredNames().includes(tool),
        `missing tool: ${tool}`,
      );
    }
    assert.equal(ctx.registeredTools.length, 0, "no process-global tool");

    // Session end unbinds and unregisters the tool surface.
    ctx.fire("agent/disposed", { agent });
    assert.deepEqual(agent.tools.registeredNames(), []);

    // Re-activation registers a fresh surface.
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(agent.tools.registeredNames().length, DISPATCHER_TOOL_COUNT);
  });

  it("the /dsh-bot surface withholds the host preset's fork verb and lifts the restriction on deactivation", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    // The preset's inherited agent-plane verbs: the stock spawn verb and its
    // route-discovery companion (both now ALLOWED for a dispatcher), the fork
    // verb ticket 179 withholds, and an unrelated tool that must survive.
    const hostTools = [
      "subagent",
      "subagent_fork",
      "list_subagent_models",
      "read",
    ];
    const agent = createAgent("session-1", { hostTools });
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));

    // ONE restriction, scoped to the candidates actually on the surface —
    // never a hard-coded deny list the host would reject. The stock-subagent
    // refactor narrowed the withhold list to the fork verb alone: plain
    // `subagent` is now how a dispatcher starts a worker, and
    // `list_subagent_models` is its route-discovery companion.
    assert.deepEqual(agent.tools.restrictCalls, [{ deny: ["subagent_fork"] }]);
    assert.ok(
      agent.tools.schemasScopeCalls.includes(agent),
      "the inherited layer is read through THIS agent's scope",
    );

    const visible = agent.tools.visibleNames();
    assert.ok(!visible.includes("subagent_fork"), "the fork verb is withheld");
    for (const name of ["subagent", "list_subagent_models"]) {
      assert.ok(visible.includes(name), `${name} stays visible for a dispatcher`);
    }
    assert.ok(visible.includes("read"), "an unrelated inherited tool stays");
    for (const name of DISPATCHER_TOOL_NAMES) {
      assert.ok(visible.includes(name), `the dispatcher tool ${name} stays`);
    }
    assert.equal(
      agent.tools.registeredNames().length,
      hostTools.length + DISPATCHER_TOOL_COUNT,
    );

    // Deactivation runs the restriction disposer: the inherited verbs come
    // back with the session's own surface gone.
    ctx.fire("agent/disposed", { agent });
    assert.deepEqual(
      agent.tools.visibleNames().sort(),
      [...hostTools].sort(),
      "the restriction is lifted with the activation",
    );
  });

  it("tool executions route to the registering session (ADR-0019: gate retired)", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));

    const deliver = agent.tools.get("deliver_result");
    assert.ok(deliver);

    // ADR-0019: there is no execute-time gate. The surface is scoped to this
    // agent, and every execution routes to the registering session's state —
    // an exec argument naming another session changes nothing.
    const routed = (await deliver.execute(
      { text: "Shipped." },
      { agent: { session: { id: "session-2" } } },
    )) as { ok: boolean; delivered?: boolean };
    assert.equal(routed.ok, true);
    assert.equal(routed.delivered, true);

    // ...which the self-target fence proves positively: the tool's identity is
    // session-1, so a peer send ADDRESSED to session-1 is the self-target
    // refusal, never a peer send from session-2.
    const message = agent.tools.get("message_agent");
    assert.ok(message);
    const selfSend = (await message.execute(
      { target: "session-1", text: "hi" },
      { agent: { session: { id: "session-2" } } },
    )) as { ok: boolean; reason?: string };
    assert.equal(selfSend.ok, false);
    assert.equal(selfSend.reason, "self-target");
  });

  it("spawn_dispatcher reaches the host spawn seam (ticket 118 wiring)", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));

    const spawnDispatcher = agent.tools.get("spawn_dispatcher");
    assert.ok(spawnDispatcher);

    // The activate path bound this agent, so the host resolves the parent from
    // the tool's closure session id — the exec argument below names ANOTHER
    // session and must change nothing (no parent is bound for it).
    const result = (await spawnDispatcher.execute(
      { title: "Child dispatcher", prompt: "Own the other half." },
      { agent: { session: { id: "session-2" } } },
    )) as { ok: boolean; dispatcher_id?: string };

    assert.equal(result.ok, true);

    // ADR-0032 (ticket 157): the seam's far side is `ctx.agents.create` — a
    // new TOP-LEVEL session parallel to the summoner. The old expectation here
    // (`subagents.startActivation` once, with provider "spawn", delivery
    // "parent" and `maxDepth: 2`) pinned the retired subagent shape; there is
    // no activation call left to count.
    assert.equal(ctx.activationCalls.length, 0);
    assert.equal(ctx.createCalls.length, 1);
    const createCall = ctx.createCalls[0];
    assert.ok(createCall);

    // The reserved id the host minted is what the host asked for and what the
    // tool reports back — no other id can come back from a real create.
    assert.equal(result.dispatcher_id, createCall.sessionId);
    assert.ok(createCall.sessionId.length > 0);

    // `meta` is `cwd` and nothing else: `origin`, `parentSession` and
    // `delegationDepth` would re-classify the session as a subagent child.
    assert.deepEqual(createCall.meta, { cwd: "C:\\work" });
    assert.equal("parentAgent" in createCall, false);

    // `setup` composed the child's OWN tool surface before publication
    // (ADR-0019): the spawned session is a dispatcher, not a blank chat.
    //
    // Ticket 176 REVERSES the old second assertion here. It read
    // `assert.ok(ctx.createdToolNames.includes("spawn_dispatcher"))` — i.e.
    // the summoned child carried the summon verb too. The owner ruled on
    // 2026-11-03 that a spawned dispatcher may not summon further dispatchers,
    // so the child's surface is composed WITHOUT `spawn_dispatcher`. Every
    // other CUSTOM dispatcher tool is still there (the stock agent verbs are
    // the preset's, absent from this fake's child scope), which the first two
    // lines pin.
    assert.ok(ctx.createdToolNames.includes("deliver_result"));
    assert.ok(ctx.createdToolNames.includes("message_agent"));
    assert.ok(!ctx.createdToolNames.includes("spawn_dispatcher"));

    // The first turn is part of the summon — a created-but-unprompted session
    // stays blank and the sidebar hides it.
    assert.equal(ctx.createFollowups.length, 1);
    const firstTurn = ctx.createFollowups[0] as {
      role?: unknown;
      content?: ReadonlyArray<{ text?: unknown }>;
    };
    assert.equal(firstTurn.role, "user");
    // The host may prepend its summon provenance to the first turn; the
    // summoner's prompt must still be the body it opens with.
    assert.ok(
      String(firstTurn.content?.[0]?.text ?? "").endsWith(
        "Own the other half.",
      ),
    );
  });

  it("dispose-all (HMR) unregisters the command, tools, and listeners", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));
    // The custom dispatcher tools on the agent's own scope (racoons off by
    // default, so no `recall`).
    assert.equal(agent.tools.registeredNames().length, DISPATCHER_TOOL_COUNT);

    for (const dispose of ctx.disposers) dispose();

    assert.equal(ctx.registeredCommands.length, 0);
    assert.equal(agent.tools.registeredNames().length, 0);
    assert.equal(ctx.registeredTools.length, 0);
    for (const cbs of ctx.listeners.values()) {
      assert.equal(cbs.length, 0);
    }
    // A later session-start still captures nothing.
    ctx.fire("agent/session-start", { agent: createAgent("session-2") });
  });

  it("a re-apply after dispose-all finds every name free (ticket 91 mirror-image pin)", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(agent.tools.registeredNames().length, DISPATCHER_TOOL_COUNT);

    for (const dispose of [...ctx.disposers]) dispose();
    assert.equal(ctx.registeredCommands.length, 0);
    assert.equal(agent.tools.registeredNames().length, 0);
    assert.equal(ctx.registeredTools.length, 0);

    // HMR re-load: the fresh apply must re-register the same dispatcher command
    // names and the tool surface WITHOUT hitting the host's duplicate rule —
    // teardown released every name (src/plugin.ts:664-687).
    assert.doesNotThrow(() => apply(ctx, volatileConfig({ enabled: true })));
    assert.deepEqual(ctx.registeredCommands.map((c) => c.name), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);
    const reloaded = createAgent("session-2");
    ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: reloaded,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reloaded.tools.registeredNames().length, DISPATCHER_TOOL_COUNT);
  });

  // DELETED with the `check_workers` handler: "a firehose tool/call advances
  // the count check_workers shows (ticket 75)" read the per-worker
  // tool-call count back through a tool this plugin no longer registers. The
  // stock `list_agents` exposes no count or liveness field, so there is no
  // honest surface left to assert; the activity ring itself stays core state,
  // covered where it is written.

  // Ticket 117: the shipped `apply()` wires the user-message early release as
  // `host.onDispatcherUserMessage` → `multitask.releaseWaits`. The semantic
  // pins live in `test/adapter-dispatcher-tools.test.ts` (real host
  // subscription, manual clock); this pin is the wiring's safety net at the
  // plugin level — a structured user prompt, our own wake, and a peer wake all
  // flow through the shipped listener without throwing or disturbing the
  // surface, and a dormant plugin stays inert.
  it("structured user prompts on the firehose are handled without a throw (ticket 117 wiring)", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    // Dormant: the listener exists, nothing is armed, and the delivery is inert.
    assert.doesNotThrow(() => {
      ctx.fire("session/event", { id: "session-1" }, {
        type: "agent/inbox/spliced",
        data: {
          target: "next-turn",
          start: 0,
          inserted: [
            {
              id: "m-1",
              role: "user",
              content: [{ type: "text", text: "hi" }],
              source: { kind: "user" },
            },
          ],
        },
      });
    });

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));
    const before = agent.tools.registeredNames();

    for (const kind of ["user", "plugin:multitask-dispatcher", "agent-message"]) {
      assert.doesNotThrow(() => {
        ctx.fire("session/event", { id: "session-1" }, {
          type: "agent/inbox/spliced",
          data: {
            target: "next-turn",
            start: 0,
            inserted: [
              {
                id: `m-${kind}`,
                role: "user",
                content: [{ type: "text", text: "anything" }],
                source: { kind },
              },
            ],
          },
        });
        ctx.fire("session/event", { id: "session-1" }, {
          type: "user/message",
          data: {
            id: `u-${kind}`,
            role: "user",
            content: [{ type: "text", text: "anything" }],
            source: { kind },
          },
        });
      });
    }

    // Nothing was unregistered and no state changed by observation alone.
    assert.deepEqual(agent.tools.registeredNames(), before);
    assert.equal(before.length, DISPATCHER_TOOL_COUNT);
  });

  // DELETED (ticket 112): "plugin teardown cancels a pending coalesced wake
  // timer". It armed the coalescing window through a settle, which no longer
  // wakes through this bus (the host pushes the stock completion notice
  // instead); the remaining coalesced trigger is a PEER message, which needs a
  // second live dispatcher session this stub cannot activate cleanly.
  // The behaviour itself — `dispose` cancels an armed window and stays
  // idempotent — is pinned directly in test/wake-bus-disposal.test.ts.

  // Ticket 91 negative controls: the shipped registries are fail-loud on a
  // duplicate name, so a pre-registered name makes the REAL apply() throw
  // (this is the offline detector for a double registration — the ticket-84/85
  // activation-abort class, where the fake used to swallow it).
  it("apply throws the host duplicate-command error when our command name is taken", () => {
    const ctx = createStubCtx();
    ctx.commands.register({
      name: DISPATCHER_START_COMMAND,
      description: "foreign claimant",
      handler: () => ({ kind: "success", text: "foreign" }),
    });

    assert.throws(
      () => apply(ctx, volatileConfig({ enabled: true })),
      new RegExp(
        `command "${DISPATCHER_START_COMMAND}" is already registered`,
      ),
    );
  });

  it("activation throws the host duplicate-tool error when a dispatcher tool name is taken", () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const agent = createAgent("session-1");
    // A foreign plugin already owns `deliver_result` in this agent's scope —
    // the FIRST custom tool the dispatcher registers.
    agent.tools.register({
      name: "deliver_result",
      execute: async () => ({ ok: false }),
    });

    // The tool surface rides the activation effect, so the duplicate throws
    // straight out of the command's activation path (live: it aborts the
    // whole activation, not one degraded surface).
    assert.throws(
      () => ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent }),
      /tool "deliver_result" is already registered/,
    );

    // Rollback (fix 5): the failed registration left the foreign definition
    // alone and registered none of the dispatcher tools behind it.
    assert.deepEqual(agent.tools.registeredNames(), ["deliver_result"]);
  });

  it("refuses the process-global tool fallback and logs the refusal once", () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const warnings = captureWarnings(() => {
      ctx.runCommand({
        commandId: DISPATCHER_START_COMMAND,
        agent: createBareAgent("bare-1"),
      });
      ctx.runCommand({
        commandId: DISPATCHER_START_COMMAND,
        agent: createBareAgent("bare-2"),
      });
    });

    // Nothing was registered globally: the old fallback exposed the tools to
    // every session and closed over one session id.
    assert.equal(ctx.registeredTools.length, 0);
    assert.equal(
      warnings.filter((line) => line.includes("refusing to register"))
        .length,
      1,
      "the refusal is logged once, not once per activation",
    );
  });

  it("rolls back a partial tool registration: restriction lifted, tools removed, retry does not double-inject policy", () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const hostTools = [
      "subagent",
      "subagent_fork",
      "list_subagent_models",
    ];
    // `commitInjects` makes the fake session log carry every inject, which is
    // what the ticket-163 policy idempotence check reads on the retry.
    const agent = createAgent("session-1", { hostTools, commitInjects: true });
    // The foreign claimant owns `deliver_result`, which the dispatcher
    // registers FIRST, so the very first registration throws (nothing behind
    // it ever lands).
    const foreignDispose = agent.tools.register({
      name: "deliver_result",
      execute: async () => ({ ok: false }),
    });

    assert.throws(
      () => ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent }),
      /tool "deliver_result" is already registered/,
    );
    // The withhold ran BEFORE the throwing registration, and the rollback
    // lifted it: the preset's verbs are visible again.
    assert.equal(agent.tools.restrictCalls.length, 1);
    assert.deepEqual(
      agent.tools.visibleNames().sort(),
      [...hostTools, "deliver_result"].sort(),
      "the restriction is lifted by the failed activation's rollback",
    );
    // No half surface: every dispatcher tool registered before the throw is
    // gone. The foreign claimant and the preset's tools are untouched.
    assert.deepEqual(
      agent.tools.registeredNames().sort(),
      [...hostTools, "deliver_result"].sort(),
    );
    // The policy was injected before the tool-surface failure; it is now in
    // the session log.
    assert.equal(agent.injected.length, 1);

    // The session was deactivated too, so a later attempt is a fresh
    // activation rather than a silent "already active" with no tools.
    foreignDispose();
    assert.doesNotThrow(() =>
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent }),
    );
    assert.equal(
      agent.tools.registeredNames().length,
      hostTools.length + DISPATCHER_TOOL_COUNT,
    );
    assert.equal(
      agent.injected.length,
      1,
      "the retry sees the policy in the transcript and does not inject it again",
    );
    // The retry re-applies the restriction for its own activation: the fork
    // verb is gone again, while the stock `subagent` stays (workers now start
    // through it).
    assert.equal(agent.tools.restrictCalls.length, 2);
    assert.ok(!agent.tools.visibleNames().includes("subagent_fork"));
    assert.ok(agent.tools.visibleNames().includes("subagent"));
  });

  it("removes every custom tool when recall registration throws after the dispatcher surface landed", () => {
    const ctx = createStubCtx();
    // racoons on: `recallTools` runs AFTER the custom dispatcher tools and is
    // the last step inside the activation's try block.
    apply(ctx, volatileConfig({ enabled: true, racoonsEnabled: true }));
    const hostTools = [
      "subagent",
      "subagent_fork",
      "list_subagent_models",
    ];
    const agent = createAgent("session-1", { hostTools });
    // A foreign plugin owns `recall`; racoons' registration throws the host's
    // duplicate-tool error, i.e. a throw after the whole dispatcher surface.
    const foreignRecall = agent.tools.register({
      name: "recall",
      execute: async () => ({ ok: false }),
    });

    assert.throws(
      () => ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent }),
      /tool "recall" is already registered/,
    );

    // Every one of the custom tools is gone, and the restriction that ran
    // before them is lifted; only the preset's tools and the foreign claimant
    // remain.
    assert.deepEqual(
      agent.tools.registeredNames().sort(),
      [...hostTools, "recall"].sort(),
    );
    assert.deepEqual(
      agent.tools.visibleNames().sort(),
      [...hostTools, "recall"].sort(),
    );
    assert.equal(agent.tools.restrictCalls.length, 1);
    foreignRecall();
  });

  it("keeps a durable spawned class on the /dsh-bot path (no spawn_dispatcher)", () => {
    const ctx = createStubCtx({
      getService: (service) =>
        service === "sessionProjections"
          ? {
              stateOf: () => ({
                active: true,
                dispatcherClass: "spawned",
                pendingStarts: [],
                pendingStops: [],
              }),
            }
          : undefined,
    });
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("session-spawned");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });

    const names = agent.tools.registeredNames();
    // A spawned team leader never regains the summon verb just because the
    // human activation path ran in it.
    assert.ok(!names.includes("spawn_dispatcher"));
    assert.ok(names.includes("deliver_result"));
    assert.ok(names.includes("message_agent"));
    // Two custom tools for a team leader: no spawn_dispatcher, no stock verbs
    // registered by us.
    assert.equal(names.length, 2);
  });

  it("settles the language on first activation rather than freezing apply-time EN", () => {
    let settings: unknown;
    const ctx = createStubCtx({
      getService: (service) => (service === "settings" ? settings : undefined),
    });
    apply(ctx, volatileConfig({ enabled: true }));

    // The settings service mounts after apply, before the first activation.
    settings = {
      describe: () => [{ ns: "locale", value: { preference: "zh" } }],
    };
    const first = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first });
    assert.ok(
      textOf(first.injected[0]).startsWith(POLICY_SECTION_HEADINGS_ZH[0]),
      "first activation uses the settled ZH policy",
    );

    // Settlement happens once: a later flip does not rewrite this process.
    settings = {
      describe: () => [{ ns: "locale", value: { preference: "en" } }],
    };
    const second = createAgent("session-2");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: second });
    assert.ok(
      textOf(second.injected[0]).startsWith(POLICY_SECTION_HEADINGS_ZH[0]),
    );
  });

  it("uses a dedicated task-material bound for inbox prompts, with a job pointer", () => {
    // The old worker-report clamp (4000 chars) silently cut the task itself.
    const fourThousand = "x".repeat(4000);
    assert.equal(
      clampInboxJobPrompt("job-1", fourThousand, "/inbox/job-1"),
      fourThousand,
      "a 4k prompt is task material, not a report",
    );

    const huge = "y".repeat(INBOX_JOB_PROMPT_CLAMP_CHARS + 50);
    const clipped = clampInboxJobPrompt("job-9", huge, "/inbox/job-9");
    assert.ok(clipped.startsWith("y".repeat(INBOX_JOB_PROMPT_CLAMP_CHARS)));
    assert.ok(clipped.includes("Job job-9"));
    assert.ok(clipped.includes("/inbox/job-9"));
  });

  it("refuses to derive an inbox job directory from an empty root", () => {
    assert.equal(resolveInboxJobDir("job-1", "", ""), null);
    assert.equal(
      resolveInboxJobDir("job-1", "", "C:\\inbox"),
      "C:\\inbox\\job-1",
    );
    assert.equal(
      resolveInboxJobDir("job-1", "C:\\explicit", "C:\\inbox"),
      "C:\\explicit",
    );
  });

  it("restored ERROR results point at the transcript, not 'no message'", () => {
    const multitask = {
      drainWake: () => ({
        wake: { source: "worker-settled", settledWorkers: [] },
        reconcile: { landedUndelivered: [{ workerId: "w-1" }] },
      }),
      listWorkers: () => [
        {
          workerId: "w-1",
          title: "Parser",
          status: "error",
          transcriptRef: "child-9",
        },
      ],
      listTodos: () => [],
    } as unknown as Multitask;

    const text = composeWakeText(multitask, "s-1");
    assert.ok(text);
    assert.ok(text.includes("Transcript: child-9"), "the pointer is present");
    assert.ok(
      !text.includes("worker failed with no message"),
      "the empty-error placeholder must not be produced for a restored error",
    );
  });

  it("inbox job task material is not cut at the worker-report bound", () => {
    const prompt = "z".repeat(5_000);
    const jobText = (jobId: string, promptText: string, jobDir: string) => {
      const multitask = {
        drainWake: () => ({
          wake: {
            source: "external-event",
            settledWorkers: [],
            externalJobs: [{ jobId, promptText, jobDir }],
          },
          reconcile: { landedUndelivered: [] },
        }),
        listWorkers: () => [],
        listTodos: () => [],
      } as unknown as Multitask;
      return composeWakeText(multitask, "s-1");
    };

    const shortText = jobText("job-7", prompt, "/inbox/job-7");
    assert.ok(shortText);
    assert.ok(shortText.includes(prompt), "a 5k task prompt rides whole");

    const huge = "y".repeat(INBOX_JOB_PROMPT_CLAMP_CHARS + 10);
    const clipped = jobText("job-8", huge, "/inbox/job-8");
    assert.ok(clipped);
    assert.ok(clipped.includes("Job job-8"));
    assert.ok(clipped.includes("/inbox/job-8"));
  });

  it("isolates teardown disposers and observes the marker-store rejection", async () => {
    const ctx = createStubCtx({
      storageCloseError: new Error("marker close failed"),
    });
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("session-1", { disposeThrows: true });

    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
      // Let the durability rebuild open the marker domain before teardown.
      await new Promise((resolve) => setImmediate(resolve));
      assert.doesNotThrow(() => {
        for (const dispose of [...ctx.disposers]) dispose();
      });
      // Let the rejected close settle through the teardown catch.
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      console.warn = original;
    }

    assert.ok(
      warnings.some((line) => line.includes("tool surface disposer")),
      "a throwing tool disposer is reported",
    );
    assert.ok(
      warnings.some((line) => line.includes("marker store dispose")),
      "a rejecting marker close is observed",
    );
    // The throw did not abort the remaining teardown steps.
    assert.equal(ctx.registeredCommands.length, 0);
  });
});
