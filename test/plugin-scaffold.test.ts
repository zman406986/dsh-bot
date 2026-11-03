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
import { Config, apply, inject, name } from "../src/plugin.js";
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
} from "../src/adapter/cordis-dsh-host.js";

function createAgent(id: string): AgentLike {
  return {
    session: {
      id,
      // ADR-0032: a summoned dispatcher inherits the summoner's cwd; the
      // cross-session route refuses a session whose header carries none.
      header: { parentSession: null, delegationDepth: 0, cwd: "C:\\work" },
    },
    followup() {},
    inject() {},
  };
}

/**
 * Ticket 112: a dispatcher agent that records what reached it, so a test can
 * assert whether a wake opened a turn (through `followup`) — before or after
 * teardown.
 */
function createRecordingAgent(
  id: string,
): AgentLike & { readonly followups: unknown[] } {
  const followups: unknown[] = [];
  return {
    session: { id, header: { parentSession: null, delegationDepth: 0 } },
    followup(message: unknown) {
      followups.push(message);
    },
    inject() {},
    followups,
  };
}

function createStubCtx(options?: {
  /** Ticket 112: agents `ctx.agents.get` resolves (wake delivery target). */
  agentsById?: ReadonlyMap<string, AgentLike>;
}): AdapterContext & {
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
    // Ticket 174 / ADR-0033 removed `userQuestions` (the access-prompt seam)
    // and `approval` (the dispatch-approval seam) from the inject list.
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
    // Two command registrations + the teardown + the ticket-145 racoons
    // mount (which always registers inside the enabled path). Ticket 174 /
    // ADR-0033 removed the `/dispatcher-resolve` command.
    assert.equal(ctx.disposers.length, 4);
    for (const dispose of [...ctx.disposers]) dispose();
    assert.equal(ctx.registeredCommands.length, 0);
  });

  it("command activation registers the tool surface; dispose reverses it", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));

    // Eight dispatcher tools (ticket 116 retired send_peer for message_agent;
    // ticket 117 added await_agent; ticket 118 added spawn_dispatcher)
    // + the ticket-145 per-session recall. Ticket 174 / ADR-0033 removed the
    // worker access tool.
    const names = ctx.registeredTools.map((t) => t.name);
    for (const tool of [
      "spawn_worker",
      "check_workers",
      "steer_worker",
      "stop_worker",
      "deliver_result",
      "message_agent",
      "await_agent",
      "spawn_dispatcher",
    ]) {
      assert.ok(names.includes(tool), `missing tool: ${tool}`);
    }

    // Session end unbinds and unregisters the tool surface.
    ctx.fire("agent/disposed", { agent });
    assert.equal(ctx.registeredTools.length, 0);

    // Re-activation registers a fresh surface.
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.registeredTools.length, 9);
  });

  it("tool executions route to the registering session (ADR-0019: gate retired)", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));

    const spawn = ctx.registeredTools.find((t) => t.name === "spawn_worker");
    assert.ok(spawn);

    // ADR-0019 retired the execute-time gate: there is no refusal copy. This
    // agent carries no scoped ctx, so the tools registered through the
    // plugin-level fallback and every execution routes to the registering
    // session's state (live hosts fence visibility per agent scope instead).
    const routed = (await spawn.execute(
      { stream_key: "s", title: "T", prompt: "P" },
      { agent: { session: { id: "session-2" } } },
    )) as { ok: boolean };
    assert.equal(routed.ok, true);

    // The activated chat's exec shape reaches the core identically.
    const ok = (await spawn.execute(
      { stream_key: "s2", title: "T", prompt: "P" },
      { agent: { session: { id: "session-1" } } },
    )) as { ok: boolean };
    assert.equal(ok.ok, true);
  });

  it("spawn_dispatcher reaches the host spawn seam (ticket 118 wiring)", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));

    const spawnDispatcher = ctx.registeredTools.find(
      (t) => t.name === "spawn_dispatcher",
    );
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
    // other dispatcher tool is still there, which the first line pins.
    assert.ok(ctx.createdToolNames.includes("spawn_worker"));
    assert.ok(!ctx.createdToolNames.includes("spawn_dispatcher"));

    // The first turn is part of the summon — a created-but-unprompted session
    // stays blank and the sidebar hides it.
    assert.equal(ctx.createFollowups.length, 1);
    const firstTurn = ctx.createFollowups[0] as {
      role?: unknown;
      content?: ReadonlyArray<{ text?: unknown }>;
    };
    assert.equal(firstTurn.role, "user");
    assert.equal(firstTurn.content?.[0]?.text, "Own the other half.");
  });

  it("dispose-all (HMR) unregisters the command, tools, and listeners", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const agent = createAgent("session-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await new Promise((resolve) => setImmediate(resolve));
    // Eight dispatcher tools + per-session recall.
    assert.equal(ctx.registeredTools.length, 9);

    for (const dispose of ctx.disposers) dispose();

    assert.equal(ctx.registeredCommands.length, 0);
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
    assert.equal(ctx.registeredTools.length, 9);

    for (const dispose of [...ctx.disposers]) dispose();
    assert.equal(ctx.registeredCommands.length, 0);
    assert.equal(ctx.registeredTools.length, 0);

    // HMR re-load: the fresh apply must re-register the same dispatcher command
    // names and the tool surface WITHOUT hitting the host's duplicate rule —
    // teardown released every name (src/plugin.ts:664-687).
    assert.doesNotThrow(() => apply(ctx, volatileConfig({ enabled: true })));
    assert.deepEqual(ctx.registeredCommands.map((c) => c.name), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);
    ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: createAgent("session-2"),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.registeredTools.length, 9);
  });

  it("a firehose tool/call advances the count check_workers shows (ticket 75)", async () => {
    const ctx = createStubCtx();
    apply(ctx, volatileConfig({ enabled: true }));

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
    const before = ctx.registeredTools.map((t) => t.name);

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
    assert.deepEqual(ctx.registeredTools.map((t) => t.name), before);
    assert.equal(before.length, 9);
  });

  // Ticket 112: plugin teardown must disarm the wake bus. Under the ticket-108
  // coalescing window a settle arms a timer that would later open a turn
  // through the host. Teardown now calls `multitask.dispose()` before
  // `host.dispose()`, so the armed timer is cancelled and a stale one that
  // still fires is a generation-checked no-op. The control case (no teardown)
  // proves the timer really does wake the agent — otherwise the assertion
  // below would pass for the wrong reason.
  it("plugin teardown cancels a pending coalesced wake timer (ticket 112)", async (t) => {
    const agent = createRecordingAgent("session-1");
    const agentsById = new Map<string, AgentLike>([["session-1", agent]]);

    /** Spawn one worker and settle it with the window armed. */
    const armWake = async (
      ctx: ReturnType<typeof createStubCtx>,
    ): Promise<void> => {
      apply(
        ctx,
        volatileConfig({ enabled: true, wakeCoalesceWindowMs: 50 }),
      );
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
      await new Promise((resolve) => setImmediate(resolve));

      const spawn = ctx.registeredTools.find((tool) => tool.name === "spawn_worker");
      assert.ok(spawn);
      const spawned = (await spawn.execute(
        { stream_key: "s", title: "T", prompt: "P" },
        { agent: { session: { id: "session-1" } } },
      )) as { ok: boolean; worker_id?: string };
      assert.equal(spawned.ok, true);

      ctx.fire("subagent/end", {
        id: spawned.worker_id,
        stopReason: "completed",
        lastAssistantMessage: [{ type: "text", text: "done" }],
      });
    };

    t.mock.timers.enable({ apis: ["setTimeout"] });

    // Control: the same setup without teardown does wake the agent once the
    // window elapses — the manual scheduler has a timer to fire.
    const controlCtx = createStubCtx({ agentsById });
    await armWake(controlCtx);
    assert.equal(agent.followups.length, 0, "nothing before the window");
    t.mock.timers.tick(50);
    assert.equal(agent.followups.length, 1, "the window opened the turn");
    for (const dispose of controlCtx.disposers) dispose();
    agent.followups.length = 0;

    // Teardown runs the collected effect cleanups, then the window elapses.
    const ctx = createStubCtx({ agentsById });
    await armWake(ctx);
    assert.equal(agent.followups.length, 0);
    for (const dispose of ctx.disposers) dispose();
    t.mock.timers.tick(50);
    assert.equal(
      agent.followups.length,
      0,
      "no wake may open a turn after plugin teardown",
    );
  });

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
    // A foreign plugin already owns `spawn_worker` in this host.
    ctx.tools.register({
      name: "spawn_worker",
      execute: async () => ({ ok: false }),
    });

    const agent = createAgent("session-1");
    // The tool surface rides the activation effect, so the duplicate throws
    // straight out of the command's activation path (live: it aborts the
    // whole activation, not one degraded surface).
    assert.throws(
      () => ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent }),
      /tool "spawn_worker" is already registered/,
    );
  });
});
