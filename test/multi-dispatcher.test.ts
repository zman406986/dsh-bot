/**
 * Ticket 76 — ADR-0019 implementation: per-dispatcher scoped tool
 * registration + session-keyed state.
 *
 * Offline only (S8): fake AdapterContext seams — a per-agent SCOPED tool
 * surface on every test agent (shaped after the live host's `agent.ctx`,
 * docs/research/dsh-tool-scoping-seam.md), a settings-capturing scope, and a
 * listener bus — driving the real plugin apply(), the real CordisDshHost, and
 * the real Multitask core. No network, no LLM, no running dsh.
 *
 * Fake-vs-host (ticket 93): the settings-provider fake models the shipped
 * scope contract — `register(ns, schema, options?)` returns the owner scope
 * (`@deepseek-ai/dsh-settings/lib/index.js:281-315`) while
 * `installSection(...)` returns VOID (`:327-343`;
 * `lib/types/index.d.ts:228`).
 *
 * Pinned here (ticket AC 5): a second dispatcher session's tools never
 * appear in the first's surface; handlers route to their own session's
 * state; the same model-authored stream_key in two sessions does not
 * collide while the same key within one session still refuses; deactivating
 * session A clears only A's policy rows and prompts; roster publishes carry
 * the changed session's id.
 *
 * Fake-vs-host (ticket 91): the plugin-level `commands.register` /
 * `tools.register` and each agent's SCOPED `tools.register` throw on a
 * duplicate name with the shipped wording
 * (`@deepseek-ai/dsh-commands/lib/index.js:82`,
 * `@deepseek-ai/dsh-tools/lib/index.js:2538`; the scoped layer uses the
 * same `NamedEntries` factory).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../src/plugin.js";
import {
  DISPATCHER_START_COMMAND,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
  type SessionProjectionChildLike,
  type ToolsLike,
} from "../src/adapter/index.js";
import { ROSTER_SETTINGS_KEY } from "../src/core/roster-snapshot.js";
import { volatileConfig } from "./support/plugin-config.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick();
}

/** Text of an injected plugin context message (policy / turn reminder). */
function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

/** Top-level agent with its OWN scoped tool surface (live-host shape). */
interface ScopedAgent extends AgentLike {
  /** Messages `inject` received (ticket 159: the per-turn peer roster). */
  readonly injected: unknown[];
  scopedToolNames(): string[];
  scopedTool: (
    name: string,
  ) =>
    | { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
    | undefined;
}

function createScopedAgent(id: string, cwd = "C:\\work"): ScopedAgent {
  const scoped = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const injected: unknown[] = [];
  const tools: ToolsLike = {
    schemas: () => [...scoped.keys()].map((name) => ({ name })),
    register(definition: {
      name: string;
      execute: (args: unknown, exec?: unknown) => Promise<unknown>;
    }) {
      // Shipped rule (ticket 91): duplicate tool name throws in the calling
      // agent's scope too (dsh-tools lib/index.js:2538 — the scoped layer
      // uses the same NamedEntries factory; dsh-tools/lib/types/index.d.ts
      // :595 "duplicates within one layer ... fail").
      if (scoped.has(definition.name)) {
        throw new Error(
          `tool "${definition.name}" is already registered (for a ` +
            `per-agent variant, register through that agent's ` +
            `\`agent.ctx\` instead)`,
        );
      }
      scoped.set(definition.name, definition);
      return () => {
        scoped.delete(definition.name);
      };
    },
  };
  const agent: ScopedAgent = {
    session: { id, header: { parentSession: null, delegationDepth: 0, cwd } },
    followup() {},
    inject(message: unknown) {
      injected.push(message);
    },
    ctx: { tools },
    injected,
    scopedToolNames: () => [...scoped.keys()],
    scopedTool: (name) => scoped.get(name),
  };
  return agent;
}

function createMultiCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const disposers: Array<() => void> = [];
  const sentMessages: Array<{ targetId: unknown; text: string }> = [];
  const spawnedParents: Array<{ childId: string; parentSessionId: string }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const claimedNamespaces = new Set<string>();
  // Settings-provider fake: the shipped scope contract (ticket 93).
  // - `register(ns, schema, options?)` RETURNS the owner scope
  //   (dsh-settings lib/index.js:281-315).
  // - `installSection(...)` returns VOID (dsh-settings lib/index.js:327-343;
  //   types :228).
  // - a second claim of one namespace fails loud (shipped rule,
  //   dsh-settings lib/index.js:283).
  const claim = (ns: string): { update(value: unknown): Promise<void> } => {
    if (claimedNamespaces.has(ns)) {
      throw new Error(`settings namespace "${ns}" is already registered`);
    }
    claimedNamespaces.add(ns);
    return {
      // The host scope's `update` is ASYNC (dsh-settings
      // lib/types/index.d.ts:105-108).
      async update(value: unknown) {
        updates.push(value as Record<string, unknown>);
      },
    };
  };
  const settingsProvider = {
    register(ns: string) {
      return claim(ns);
    },
    installSection(_owner: unknown, ns: string) {
      claim(ns);
    },
  };
  let nextChild = 1;
  const createCalls: Array<{ sessionId: string; cwd: unknown }> = [];
  const childrenById = new Map<string, ScopedAgent>();
  const heldGates = new Map<string, () => void>();
  /** Ticket 159: park every create before its `setup`, until released. */
  let holdAllCreates = false;

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
    }
  };

  const agentsById = new Map<string, AgentLike>();

  const ctx = {
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
    inject(
      services: readonly string[],
      callback: (child: SessionProjectionChildLike) => void,
    ) {
      if (services.includes("settings")) {
        // This fake also answers `settings` for the ticket-91 scope pins; the
        // shape is not a projection child, hence the one assertion.
        callback({ settings: settingsProvider } as unknown as SessionProjectionChildLike);
      }
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
        // Shipped rule (ticket 91): duplicate command name throws
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
        // Shipped rule (ticket 91): duplicate tool name throws
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
      async startActivation(spec: {
        request: { parent: AgentLike };
      }) {
        const childId = `child-${nextChild++}`;
        spawnedParents.push({
          childId,
          parentSessionId: String(spec.request.parent.session.id),
        });
        return { childId, messageId: `msg-${childId}`, dispose: async () => {} };
      },
      interrupt() {},
      async sendMessage(
        _sender: unknown,
        targetId: unknown,
        content: Array<{ text?: string }>,
      ) {
        sentMessages.push({
          targetId,
          text: content.map((block) => block.text ?? "").join(""),
        });
        return "msg-stub";
      },
    },
    agents: {
      get: (id: unknown) => agentsById.get(String(id)),
      /**
       * ADR-0032 / ticket 159: the summon path. The real host creates a
       * TOP-LEVEL session here and awaits `setup` BEFORE publication.
       *
       * `holdCreates()` parks every create before its `setup` runs.
       * `releaseCreate(id)` then lets ONE parked create through, chosen by the
       * session id it was reserved under — so a test can make the SECOND
       * summon's `setup` reach the activation hook first. That is the exact
       * interleaving two simultaneous summons produce, and a pairing that
       * relies on queue order has no order to trust there.
       */
      async create(createOptions: {
        sessionId: string;
        meta?: Record<string, unknown>;
        setup?: (agentCtx: unknown, agent: AgentLike) => void | Promise<void>;
      }) {
        createCalls.push({
          sessionId: createOptions.sessionId,
          cwd: createOptions.meta?.["cwd"],
        });
        const child = createScopedAgent(
          createOptions.sessionId,
          typeof createOptions.meta?.["cwd"] === "string"
            ? String(createOptions.meta["cwd"])
            : "C:\\work",
        );
        childrenById.set(createOptions.sessionId, child);
        agentsById.set(createOptions.sessionId, child);
        if (holdAllCreates) {
          await new Promise<void>((resolve) => {
            heldGates.set(createOptions.sessionId, resolve);
          });
        }
        await createOptions.setup?.(child.ctx, child);
        return { agent: child, dispose: async () => {} };
      },
    },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        return {
          table() {
            const t = new Map<string, unknown>();
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
    updates,
    installSettingsSection: (ns: string) =>
      settingsProvider.installSection({}, ns),
    registerSettingsNamespace: (ns: string) => settingsProvider.register(ns),
    commandNames: () => [...commands.keys()],
    globalToolNames: () => [...tools.keys()],
    globalTool: (name: string) => tools.get(name),
    sentMessages,
    spawnedParents,
    createCalls,
    childrenById,
    /** Park every `agents.create` before its `setup` runs, until released. */
    holdCreates() {
      holdAllCreates = true;
    },
    /** Release ONE parked create, chosen by the id it was reserved under. */
    releaseCreate(sessionId: string) {
      const gate = heldGates.get(sessionId);
      heldGates.delete(sessionId);
      gate?.();
    },
    runCommand(invocation: {
      commandId: string;
      agent?: AgentLike;
    }): CommandResultLike {
      const command = commands.get(invocation.commandId);
      if (command === undefined) {
        throw new Error(`command not registered: ${invocation.commandId}`);
      }
      return command.handler(invocation as never) as CommandResultLike;
    },
  };
  return { ctx: ctx as typeof ctx & AdapterContext, agentsById };
}

async function activate(
  multi: ReturnType<typeof createMultiCtx>,
  agent: ScopedAgent,
): Promise<void> {
  multi.agentsById.set(String(agent.session.id), agent);
  const result = multi.ctx.runCommand({
    commandId: DISPATCHER_START_COMMAND,
    agent,
  });
  assert.equal(result.kind, "success");
  // Drain the async rebuild chain queued by activation.
  for (let i = 0; i < 6; i += 1) {
    await tick();
  }
}

async function spawnVia(
  agent: ScopedAgent,
  streamKey: string,
): Promise<{ ok: boolean; worker_id?: string; reason?: string }> {
  const spawn = agent.scopedTool("spawn_worker");
  assert.ok(spawn, `no scoped spawn_worker on ${String(agent.session.id)}`);
  return (await spawn.execute(
    { stream_key: streamKey, title: "T", prompt: "P" },
    undefined,
  )) as { ok: boolean; worker_id?: string; reason?: string };
}

describe("multi-dispatcher — scoped surfaces (ADR-0019)", () => {
  it("each dispatcher sees only its own eight tools, and no global tool", async () => {
    const multi = createMultiCtx();
    apply(multi.ctx, volatileConfig({ enabled: true }));
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");

    await activate(multi, a);
    await activate(multi, b);

    // Eight dispatcher tools. Owner ruling 2026-11-05: the ticket-145
    // per-session `recall` is absent by default — racoons is off.
    assert.deepEqual(a.scopedToolNames().sort(), [
      "await_agent",
      "check_workers",
      "deliver_result",
      "message_agent",
      "spawn_dispatcher",
      "spawn_worker",
      "steer_worker",
      "stop_worker",
    ]);
    assert.deepEqual(b.scopedToolNames().sort(), [
      "await_agent",
      "check_workers",
      "deliver_result",
      "message_agent",
      "spawn_dispatcher",
      "spawn_worker",
      "steer_worker",
      "stop_worker",
    ]);
    // The global registry is empty: ticket 174 / ADR-0033 removed the worker
    // ask tool, the only global name this plugin ever claimed.
    assert.deepEqual(multi.ctx.globalToolNames(), []);
  });

  it("the same stream_key in two sessions does not collide; within one session it still refuses", async () => {
    const multi = createMultiCtx();
    apply(multi.ctx, volatileConfig({ enabled: true }));
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");
    await activate(multi, a);
    await activate(multi, b);

    // Both models pick "build": both spawn.
    const first = await spawnVia(a, "build");
    const second = await spawnVia(b, "build");
    assert.ok(first.ok);
    assert.ok(second.ok);

    // A second "build" within session A still refuses.
    const dup = await spawnVia(a, "build");
    assert.equal(dup.ok, false);
    assert.equal(dup.reason, "duplicate-stream-key");
  });

  it("roster reads are per-session and no settings mirror is written (0.2.1)", async () => {
    const multi = createMultiCtx();
    apply(multi.ctx, volatileConfig({ enabled: true }));
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");
    await activate(multi, a);
    await activate(multi, b);

    await spawnVia(a, "k-a");
    await spawnVia(b, "k-b");

    // 0.2.1 port: the roster settings mirror is GONE — there is no settings
    // registry to publish into, so nothing writes `ROSTER_SETTINGS_KEY`.
    // The live roster read is the per-session `check_workers` tool, which
    // stays scoped to the calling dispatcher.
    const mirrorUpdates = multi.ctx.updates.filter(
      (update) => ROSTER_SETTINGS_KEY in update,
    );
    assert.deepEqual(
      mirrorUpdates,
      [],
      "no roster mirror exists to publish into",
    );

    for (const [session, agent] of [
      ["s-a", a],
      ["s-b", b],
    ] as const) {
      const check = agent.scopedTool("check_workers");
      assert.ok(check, `${session} can read its own roster`);
      const roster = (await check.execute({}, undefined)) as {
        ok: boolean;
        rows: Array<{ worker_id: string }>;
      };
      assert.equal(roster.ok, true);
      // Isolation is enforced by the SURFACE: each session's tool sees only
      // the workers that session spawned (the row carries no dispatcher id).
      assert.equal(roster.rows.length, 1, `${session} sees exactly its own worker`);
    }
  });

  it("deactivating session A drops only A's roster view (ticket 79)", async () => {
    const multi = createMultiCtx();
    apply(multi.ctx, volatileConfig({ enabled: true }));
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");
    await activate(multi, a);
    await activate(multi, b);
    await spawnVia(a, "k-a");
    await spawnVia(b, "k-b");

    // Deactivate A: its tool surface is torn down with it. There is no
    // per-session mirror key to clear on 0.2.1 — the surface IS the read
    // path, so its absence is the honest signal.
    multi.ctx.fire("agent/disposed", { agent: a });
    await tick();
    await tick();
    assert.equal(a.scopedTool("check_workers"), undefined, "A's surface is gone");

    // B keeps its own surface and its own roster.
    const checkB = b.scopedTool("check_workers");
    assert.ok(checkB, "B's surface survives A's deactivation");
    const rosterB = (await checkB.execute({}, undefined)) as {
      ok: boolean;
      rows: Array<{ worker_id: string }>;
    };
    assert.equal(rosterB.rows.length, 1);

    // A later transition in B still answers through B's own surface.
    await spawnVia(b, "k-b2");
    const after = (await checkB.execute({}, undefined)) as {
      rows: Array<{ worker_id: string }>;
    };
    assert.equal(after.rows.length, 2, "B's roster keeps advancing");
  });
});

// Ticket 91's fail-loud duplicate-registration pin lives in
// test/plugin-scaffold.test.ts: it is one host rule, pinned once.

/**
 * Ticket 159 — the spawn title pairs with its session by IDENTITY, not by
 * queue position.
 *
 * The defect: `src/plugin.ts` kept a plugin-wide `spawnTitlesInFlight` array,
 * pushed the summon's title into it before calling the host, and let the
 * activation hook claim the OLDEST entry with `shift()`. Two dispatcher
 * sessions summoning at the same instant therefore swapped labels whenever the
 * host ran the second child's `setup` first: both spawns succeed, both ids are
 * right, and each peer-roster row shows the other's name.
 *
 * The fix: the title rides the hook call itself (the host passes `opts.title`
 * beside the reserved child id), so nothing is claimed by position.
 *
 * The interleaving below is the ticket's exact one — both creates are in
 * flight and parked BEFORE either `setup` runs, then the SECOND summon is
 * released first. A FIFO claim binds the second child with the first title.
 * The assertions are two-directional: each roster row carries its own title
 * AND not the other's, so a non-empty-label check cannot pass by accident.
 */
describe("ticket 159 — two simultaneous summons keep their own titles", () => {
  async function spawnDispatcherVia(
    agent: ScopedAgent,
    title: string,
  ): Promise<Record<string, unknown>> {
    const spawn = agent.scopedTool("spawn_dispatcher");
    assert.ok(spawn, `no scoped spawn_dispatcher on ${String(agent.session.id)}`);
    return (await spawn.execute(
      { title, prompt: `${title}: own this half.` },
      undefined,
    )) as Record<string, unknown>;
  }

  it("a summon released out of order binds each child with ITS OWN title", async () => {
    const multi = createMultiCtx();
    apply(multi.ctx, volatileConfig({ enabled: true }));
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");
    await activate(multi, a);
    await activate(multi, b);

    // Both creates park before `setup`, so neither child has been activated
    // when the other spawn is already in flight — the queue has no order.
    multi.ctx.holdCreates();
    const firstSpawn = spawnDispatcherVia(a, "Alpha job");
    const secondSpawn = spawnDispatcherVia(b, "Beta job");
    for (let i = 0; i < 50 && multi.ctx.createCalls.length < 2; i += 1) {
      await tick();
    }
    assert.equal(
      multi.ctx.createCalls.length,
      2,
      "both summons are in flight at the same instant",
    );
    const alphaId = multi.ctx.createCalls[0]?.sessionId;
    const betaId = multi.ctx.createCalls[1]?.sessionId;
    assert.ok(alphaId !== undefined && betaId !== undefined);
    assert.notEqual(alphaId, betaId);

    // Release the SECOND summon first: its `setup` reaches the activation hook
    // before the first summon's does. A positional claim hands it Alpha's
    // title, which is exactly the swap.
    multi.ctx.releaseCreate(betaId);
    await drain();
    multi.ctx.releaseCreate(alphaId);
    const [alphaResult, betaResult] = await Promise.all([
      firstSpawn,
      secondSpawn,
    ]);
    assert.equal(alphaResult.ok, true, JSON.stringify(alphaResult));
    assert.equal(betaResult.ok, true, JSON.stringify(betaResult));
    // The ack echoes the caller's own title under either implementation; the
    // roster is where the swap was observable.
    assert.equal(alphaResult.dispatcher_id, alphaId);
    assert.equal(betaResult.dispatcher_id, betaId);

    // The peer roster is rendered from the activation's own record, so a
    // swapped label shows up here first.
    const rosterOf = (agent: ScopedAgent): string => {
      const before = agent.injected.length;
      multi.ctx.fire("agent/status", { agent, status: "running" });
      assert.ok(
        agent.injected.length > before,
        `no turn reminder was injected for ${String(agent.session.id)}`,
      );
      return textOf(agent.injected.at(-1));
    };

    // Direction 1: A's roster row for B carries Beta's title.
    const rosterA = rosterOf(a);
    assert.ok(
      rosterA.includes(`- Beta job (${String(betaId)})`),
      `A's roster must label B with Beta's title:\n${rosterA}`,
    );
    assert.ok(
      !rosterA.includes(`Alpha job (${String(betaId)})`),
      `A's roster labelled B with A's own title (the swap):\n${rosterA}`,
    );

    // Direction 2: B's roster row for A carries Alpha's title.
    const rosterB = rosterOf(b);
    assert.ok(
      rosterB.includes(`- Alpha job (${String(alphaId)})`),
      `B's roster must label A with Alpha's title:\n${rosterB}`,
    );
    assert.ok(
      !rosterB.includes(`Beta job (${String(alphaId)})`),
      `B's roster labelled A with B's own title (the swap):\n${rosterB}`,
    );
  });

  it("a refused summon records no title, so a later summon cannot inherit it", async () => {
    const multi = createMultiCtx();
    apply(multi.ctx, volatileConfig({ enabled: true }));
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");
    await activate(multi, a);
    await activate(multi, b);

    // A summoner with no cwd is REFUSED by the host before any session is
    // created (ticket 163 defect 2). Its title must not survive anywhere.
    const homeless = createScopedAgent("s-homeless", "");
    await activate(multi, homeless);
    const refused = await spawnDispatcherVia(homeless, "Never happened");
    assert.equal(refused.ok, false);
    assert.equal(multi.ctx.createCalls.length, 0, "nothing was created");

    // A real summon from a different session afterwards keeps its own title —
    // there is no leftover entry for it to inherit, and none to displace.
    const real = await spawnDispatcherVia(b, "Real job");
    assert.equal(real.ok, true, JSON.stringify(real));
    const realId = String(real.dispatcher_id);

    multi.ctx.fire("agent/status", { agent: a, status: "running" });
    const rosterA = textOf(a.injected.at(-1));
    assert.ok(
      rosterA.includes(`- Real job (${realId})`),
      `the later summon keeps its own title:\n${rosterA}`,
    );
    assert.ok(
      !rosterA.includes("Never happened"),
      `a refused summon's title leaked into the roster:\n${rosterA}`,
    );
  });
});
