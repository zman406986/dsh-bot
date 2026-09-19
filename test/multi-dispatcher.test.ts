/**
 * Ticket 76 — ADR-0019 implementation: per-dispatcher scoped tool
 * registration + session-keyed state.
 *
 * Offline only (S8): fake AdapterContext seams — a per-agent SCOPED tool
 * surface on every test agent (shaped after the live host's `agent.ctx`,
 * docs/research/dsh-tool-scoping-seam.md), a fake `ctx.userQuestions` seam,
 * a settings-capturing scope, and a listener bus — driving the real plugin
 * apply(), the real CordisDshHost, and the real Multitask core. No network,
 * no LLM, no running dsh.
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
  ACCESS_PROMPT_ALLOW,
  ACCESS_PROMPT_ALWAYS_ALLOW,
  DISPATCHER_START_COMMAND,
  type AccessPromptAnswerLike,
  type AccessPromptRequestLike,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
  type ToolsLike,
  type UserQuestionsLike,
} from "../src/adapter/index.js";
import { ROSTER_SETTINGS_KEY } from "../src/core/roster-snapshot.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface CapturedAsk {
  readonly request: AccessPromptRequestLike;
  readonly agentSessionId: string;
  /** Whether the pump abandoned this prompt (deactivation aborts it). */
  aborted: boolean;
  resolve(answer: AccessPromptAnswerLike): void;
}

/** Fake user-questions seam recording which agent each ask was scoped to. */
function createFakeUserQuestions(): UserQuestionsLike & {
  asks: CapturedAsk[];
} {
  const asks: CapturedAsk[] = [];
  return {
    asks,
    ask(request: AccessPromptRequestLike): Promise<AccessPromptAnswerLike> {
      return new Promise<AccessPromptAnswerLike>((resolve, reject) => {
        const agentSessionId =
          request.agent !== undefined &&
          typeof request.agent === "object" &&
          request.agent !== null &&
          "session" in request.agent
            ? String(
                (request.agent as { session?: { id?: unknown } }).session?.id,
              )
            : "";
        const captured: CapturedAsk = {
          request,
          agentSessionId,
          aborted: false,
          resolve,
        };
        asks.push(captured);
        request.signal?.addEventListener("abort", () => {
          captured.aborted = true;
          reject(new Error("prompt aborted"));
        });
      });
    },
  };
}

/** Top-level agent with its OWN scoped tool surface (live-host shape). */
interface ScopedAgent extends AgentLike {
  readonly scopedToolNames(): string[];
  readonly scopedTool: (
    name: string,
  ) =>
    | { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
    | undefined;
}

function createScopedAgent(id: string): ScopedAgent {
  const scoped = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
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
    session: { id, header: { parentSession: null, delegationDepth: 0 } },
    followup() {},
    inject() {},
    ctx: { tools },
    scopedToolNames: () => [...scoped.keys()],
    scopedTool: (name) => scoped.get(name),
  };
  return agent;
}

function createMultiCtx(seam?: UserQuestionsLike) {
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
  // Settings-provider fake: a second claim of one namespace fails loud
  // (shipped rule, dsh-settings lib/index.js:283).
  const settingsProvider = {
    installSection(_owner: unknown, ns: string) {
      if (claimedNamespaces.has(ns)) {
        throw new Error(`settings namespace "${ns}" is already registered`);
      }
      claimedNamespaces.add(ns);
      return {
        update(value: unknown) {
          updates.push(value as Record<string, unknown>);
        },
      };
    },
  };
  let nextChild = 1;

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
    inject(services: readonly string[], callback: (child: unknown) => void) {
      if (services.includes("settings")) {
        callback({ settings: settingsProvider });
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
      async startContinuable(spec: {
        request: { parent: AgentLike };
      }) {
        const childId = `child-${nextChild++}`;
        spawnedParents.push({
          childId,
          parentSessionId: String(spec.request.parent.session.id),
        });
        return { childId, messageId: `msg-${childId}` };
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
    ...(seam !== undefined ? { userQuestions: seam } : {}),
    // Test surface
    fire,
    updates,
    installSettingsSection: (ns: string) =>
      settingsProvider.installSection({}, ns),
    commandNames: () => [...commands.keys()],
    globalToolNames: () => [...tools.keys()],
    globalTool: (name: string) => tools.get(name),
    sentMessages,
    spawnedParents,
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
  it("each dispatcher sees only its own six tools; request_access is the one global", async () => {
    const multi = createMultiCtx();
    apply(multi.ctx, { enabled: true });
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");

    await activate(multi, a);
    await activate(multi, b);

    assert.deepEqual(a.scopedToolNames().sort(), [
      "check_workers",
      "deliver_result",
      "send_peer",
      "spawn_worker",
      "steer_worker",
      "stop_worker",
    ]);
    assert.deepEqual(b.scopedToolNames().sort(), [
      "check_workers",
      "deliver_result",
      "send_peer",
      "spawn_worker",
      "steer_worker",
      "stop_worker",
    ]);
    // The global registry carries only the worker-side ask tool.
    assert.deepEqual(multi.ctx.globalToolNames(), ["request_access"]);
  });

  it("handlers route to their own session's state", async () => {
    const multi = createMultiCtx();
    apply(multi.ctx, { enabled: true });
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");
    await activate(multi, a);
    await activate(multi, b);

    const spawnA = await spawnVia(a, "build");
    const spawnB = await spawnVia(b, "build");
    assert.ok(spawnA.ok);
    assert.ok(spawnB.ok);

    // Each child is host-parented under ITS dispatcher session.
    assert.deepEqual(
      multi.ctx.spawnedParents.map((entry) => entry.parentSessionId),
      ["s-a", "s-b"],
    );

    // A's roster view never contains B's worker (and vice versa).
    const checkA = a.scopedTool("check_workers");
    assert.ok(checkA);
    const rosterA = (await checkA.execute({}, undefined)) as {
      ok: boolean;
      rows: Array<{ worker_id: string }>;
    };
    assert.equal(rosterA.ok, true);
    assert.equal(rosterA.rows.length, 1);
    assert.equal(rosterA.rows[0]?.worker_id, spawnA.worker_id);

    const checkB = b.scopedTool("check_workers");
    assert.ok(checkB);
    const rosterB = (await checkB.execute({}, undefined)) as {
      ok: boolean;
      rows: Array<{ worker_id: string }>;
    };
    assert.deepEqual(
      rosterB.rows.map((row) => row.worker_id),
      [spawnB.worker_id],
    );
  });

  it("the same stream_key in two sessions does not collide; within one session it still refuses", async () => {
    const multi = createMultiCtx();
    apply(multi.ctx, { enabled: true });
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

  it("roster publishes carry the changed session's id (no single-active gate)", async () => {
    const multi = createMultiCtx();
    apply(multi.ctx, { enabled: true });
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");
    await activate(multi, a);
    await activate(multi, b);

    await spawnVia(a, "k-a");
    await spawnVia(b, "k-b");

    const publishedSessions = new Set(
      multi.ctx.updates
        .map((update) => update[ROSTER_SETTINGS_KEY])
        .filter(
          (snapshot): snapshot is { dispatcherSessionId: string } =>
            typeof snapshot === "object" &&
            snapshot !== null &&
            "dispatcherSessionId" in snapshot,
        )
        .map((snapshot) => snapshot.dispatcherSessionId),
    );
    // BOTH sessions published under the changed-session id.
    assert.ok(publishedSessions.has("s-a"));
    assert.ok(publishedSessions.has("s-b"));
  });

  it("deactivating session A clears only A's per-session mirror key (ticket 79)", async () => {
    const multi = createMultiCtx();
    apply(multi.ctx, { enabled: true });
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");
    await activate(multi, a);
    await activate(multi, b);
    await spawnVia(a, "k-a");
    await spawnVia(b, "k-b");

    // Both sessions' snapshots ride their own mirror keys.
    const mirrorA = multi.ctx.updates.filter(
      (update) => "roster.s-a" in update,
    );
    assert.ok(mirrorA.length > 0);

    // Deactivate A: its mirror key is nulled — the wrapper sidebar's
    // dispatcher flag must fall — and ONLY its key; B keeps publishing.
    multi.ctx.fire("agent/disposed", { agent: a });
    await tick();
    await tick();
    const clearedA = multi.ctx.updates.filter(
      (update) =>
        "roster.s-a" in update && update["roster.s-a"] === null,
    );
    assert.ok(clearedA.length > 0, "A's mirror key was cleared");
    const clearedB = multi.ctx.updates.filter(
      (update) =>
        "roster.s-b" in update && update["roster.s-b"] === null,
    );
    assert.deepEqual(clearedB, [], "B's mirror key must survive");

    // A transition in B still publishes under B's own key afterward.
    await spawnVia(b, "k-b2");
    const mirrorB = multi.ctx.updates.filter(
      (update) =>
        typeof update["roster.s-b"] === "object" &&
        update["roster.s-b"] !== null,
    );
    assert.ok(mirrorB.length > 0, "B's mirror keeps publishing");
  });
});

describe("multi-dispatcher — per-session prompts and policy rows (ADR-0019)", () => {
  /** Fire a worker-side request_access from `workerId` through the global tool. */
  async function ask(
    multi: ReturnType<typeof createMultiCtx>,
    workerId: string,
    target = "write_file",
  ): Promise<void> {
    const tool = multi.ctx.globalTool("request_access");
    assert.ok(tool);
    await tool.execute(
      { class: "tool", target, reason: "need it to do the work" },
      { sessionId: workerId },
    );
  }

  function alwaysAnswer(asked: CapturedAsk): void {
    asked.resolve({
      answers: [
        {
          id: asked.request.questions[0]?.id ?? "",
          selected: [ACCESS_PROMPT_ALWAYS_ALLOW],
        },
      ],
    });
  }

  it("deactivating session A abandons only A's outstanding prompt", async () => {
    const seam = createFakeUserQuestions();
    const multi = createMultiCtx(seam);
    apply(multi.ctx, { enabled: true, accessRequestTimeoutMs: 50 });
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");
    await activate(multi, a);
    await activate(multi, b);

    const spawnA = await spawnVia(a, "k-a");
    const spawnB = await spawnVia(b, "k-b");
    assert.ok(spawnA.ok && spawnB.ok);

    await ask(multi, spawnA.worker_id as string);
    await ask(multi, spawnB.worker_id as string);
    assert.equal(seam.asks.length, 2);
    assert.deepEqual(
      seam.asks.map((captured) => captured.agentSessionId).sort(),
      ["s-a", "s-b"],
    );

    // Deactivate A: exactly A's prompt is aborted; B's stays outstanding.
    multi.ctx.fire("agent/disposed", { agent: a });
    await tick();
    const askA = seam.asks.find((captured) => captured.agentSessionId === "s-a");
    const askB = seam.asks.find((captured) => captured.agentSessionId === "s-b");
    assert.ok(askA);
    assert.ok(askB);
    assert.equal(askA.aborted, true, "A's prompt is abandoned with its session");
    assert.equal(
      askB.aborted,
      false,
      "B's prompt survives the sibling's deactivation",
    );

    // Hygiene: let the armed relay timeouts deny both asks (no real 120 s
    // timer outlives the test). B's deny reaches worker B; A's deny has no
    // bound parent left to deliver through (A is deactivated — the relay's
    // documented best-effort delivery) so only B's lands.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(multi.ctx.sentMessages.length, 1);
    assert.ok(multi.ctx.sentMessages[0]?.targetId === spawnB.worker_id);
  });

  it("session A's always-allow is cleared on deactivation; B's survives and keeps answering", async () => {
    const seam = createFakeUserQuestions();
    const multi = createMultiCtx(seam);
    apply(multi.ctx, { enabled: true, accessRequestTimeoutMs: 50 });
    const a = createScopedAgent("s-a");
    const b = createScopedAgent("s-b");
    await activate(multi, a);
    await activate(multi, b);

    // Both sessions' workers ask; both humans answer "Always allow".
    const spawnA = await spawnVia(a, "k-a");
    const spawnB = await spawnVia(b, "k-b");
    assert.ok(spawnA.ok && spawnB.ok);
    await ask(multi, spawnA.worker_id as string);
    await ask(multi, spawnB.worker_id as string);
    assert.equal(seam.asks.length, 2);
    const askA = seam.asks.find((captured) => captured.agentSessionId === "s-a");
    const askB = seam.asks.find((captured) => captured.agentSessionId === "s-b");
    assert.ok(askA);
    assert.ok(askB);
    alwaysAnswer(askA);
    alwaysAnswer(askB);
    await tick();
    await tick();
    // Each ask's own allow was delivered through its own parent.
    assert.equal(multi.ctx.sentMessages.length, 2);

    // Deactivate A: ONLY A's remembered row goes.
    multi.ctx.fire("agent/disposed", { agent: a });
    await tick();

    // B's sibling worker with the same target auto-answers from B's row —
    // no prompt, direct delivery.
    const spawnB2 = await spawnVia(b, "k-b2");
    assert.ok(spawnB2.ok);
    await ask(multi, spawnB2.worker_id as string);
    await tick();
    assert.equal(seam.asks.length, 2, "B's row still auto-answers");
    assert.equal(multi.ctx.sentMessages.length, 3);
    assert.ok(multi.ctx.sentMessages[2]?.targetId === spawnB2.worker_id);
    assert.ok(
      multi.ctx.sentMessages[2]?.text.includes("[Parent: access allowed]"),
    );

    // A's consent did NOT survive its deactivation: after re-activation the
    // same ask prompts again (a fresh prompt scoped to A's agent).
    await activate(multi, a);
    const spawnA2 = await spawnVia(a, "k-a2");
    assert.ok(spawnA2.ok);
    await ask(multi, spawnA2.worker_id as string);
    await tick();
    assert.equal(
      seam.asks.length,
      3,
      "A's remembered allow is gone — the ask prompts again",
    );
    assert.equal(seam.asks[2]?.agentSessionId, "s-a");

    // Hygiene: deny the parked ask so no relay timeout outlives the test.
    const parked = seam.asks[2];
    assert.ok(parked);
    parked.resolve({
      answers: [
        {
          id: parked.request.questions[0]?.id ?? "",
          selected: [ACCESS_PROMPT_ALLOW],
        },
      ],
    });
    await tick();
    await tick();
  });
});

describe("multi-dispatcher — host duplicate-registration rule (ticket 91)", () => {
  it("apply throws the host duplicate-command error when a command name is taken", () => {
    const multi = createMultiCtx();
    multi.ctx.commands.register({
      name: DISPATCHER_START_COMMAND,
      description: "foreign claimant",
      handler: () => ({ kind: "success", text: "foreign" }),
    });

    assert.throws(
      () => apply(multi.ctx, { enabled: true }),
      new RegExp(
        `command "${DISPATCHER_START_COMMAND}" is already registered`,
      ),
    );
  });

  it("the plugin-level tool registry throws the host duplicate-tool error on a taken name", () => {
    const multi = createMultiCtx();
    const tool = { name: "request_access", execute: async () => ({ ok: true }) };
    multi.ctx.tools.register(tool);

    assert.throws(
      () => multi.ctx.tools.register(tool),
      /tool "request_access" is already registered/,
    );
  });

  it("each agent's SCOPED registry throws the host duplicate-tool error on a taken name", () => {
    const agent = createScopedAgent("s-a");
    const tools = agent.ctx?.tools;
    assert.ok(tools);
    const tool = { name: "spawn_worker", execute: async () => ({ ok: true }) };
    tools.register(tool);

    assert.throws(
      () => tools.register(tool),
      /tool "spawn_worker" is already registered/,
    );
  });

  it("the settings fake throws on a duplicate namespace claim (dsh-settings:283)", () => {
    const multi = createMultiCtx();
    multi.ctx.installSettingsSection("multitask-dispatcher");

    assert.throws(
      () => multi.ctx.installSettingsSection("multitask-dispatcher"),
      /settings namespace "multitask-dispatcher" is already registered/,
    );
  });
});
