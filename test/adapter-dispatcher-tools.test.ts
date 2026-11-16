/**
 * Adapter dispatcher-tool surface: `registerDispatcherTools` over a capture
 * context (per-session routing, stream-key uniqueness, tool shapes).
 *
 * Fake-vs-host (ticket 91): the capture `tools.register` throws on a
 * duplicate name with the shipped wording
 * (`@deepseek-ai/dsh-tools/lib/index.js:2538`, the `NamedEntries` duplicate
 * factory) — the dispatcher tool names are registered exactly once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";
import {
  DISPATCHER_TOOL_NAMES,
  SPAWN_DISPATCHER_TOOL,
} from "../src/core/policy/prompts.js";
import {registerDispatcherTools, toRegisterableTool, type RegisterableTool} from "../src/adapter/dispatcher-tools.js";
import { withholdHostSpawnTools } from "../src/core/tools.js";
import {
  createCordisDshHost,
  dispatcherUserMessageSession,
  USER_MESSAGE_SOURCE_KIND,
  type AdapterContext,
  type AgentLike,
} from "../src/adapter/cordis-dsh-host.js";

/** Manual clock/scheduler so no test ever waits on a real timer. */
function manualSeams(startMs = 1_000_000): {
  now: () => number;
  schedule: (fn: () => void, ms: number) => () => void;
  readonly scheduled: Array<{ ms: number; cancelled: boolean }>;
  advance(step: number): void;
} {
  let currentMs = startMs;
  const scheduled: Array<{ ms: number; cancelled: boolean }> = [];
  return {
    now: () => currentMs,
    schedule: (fn, ms) => {
      const entry = { ms, cancelled: false };
      scheduled.push(entry);
      void fn;
      return () => {
        entry.cancelled = true;
      };
    },
    scheduled,
    advance: (step) => {
      currentMs += step;
    },
  };
}

/** Minimal live-ish host context: event bus, agent registry, inert services. */
function createHostCtx(): AdapterContext & {
  fire(name: string, ...payloads: unknown[]): void;
  listeners: Map<string, Array<(...args: never[]) => void>>;
  bindAgent(agent: AgentLike): void;
} {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const agents = new Map<string, AgentLike>();
  return {
    listeners,
    fire(name: string, ...payloads: unknown[]) {
      for (const cb of listeners.get(name) ?? []) {
        (cb as (...args: unknown[]) => void)(...payloads);
      }
    },
    bindAgent(agent: AgentLike) {
      agents.set(String(agent.session.id), agent);
    },
    on(name: string, cb: (...args: never[]) => void) {
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
    subagents: {
      async startActivation() {
        return { childId: "child-stub", dispose: async () => {} };
      },
      interrupt() {},
      async sendMessage() {
        return "msg-stub";
      },
    },
    agents: { get: (id: unknown) => agents.get(String(id)) },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        return {
          table: () => ({
            get: () => undefined,
            entries: () => new Map().entries(),
            async put() {},
            async delete() {
              return false;
            },
          }),
          async close() {},
          name: "stub",
        };
      },
    },
  };
}

/** One `UserMessage` as the host records it, with a structured source. */
function userMessage(sourceKind = USER_MESSAGE_SOURCE_KIND, role = "user") {
  return {
    id: `msg-${sourceKind}`,
    role,
    content: [{ type: "text", text: "hello" }],
    source: { kind: sourceKind },
  };
}

/** The host's inbox-splice commit for one inserted message. */
function inboxSpliced(inserted: unknown[]) {
  return {
    type: "agent/inbox/spliced",
    data: { target: "next-turn", start: 0, inserted },
  };
}

function createToolsCaptureCtx(): AdapterContext & {
  registered: RegisterableTool[];
  disposers: Array<() => void>;
} {
  const registered: RegisterableTool[] = [];
  const disposers: Array<() => void> = [];
  return {
    registered,
    disposers,
    tools: {
      schemas: () => registered.map((tool) => ({ name: tool.name })),
      register(definition: unknown) {
        const tool = definition as RegisterableTool;
        // Shipped rule (ticket 91): a duplicate tool name throws
        // (dsh-tools lib/index.js:2538, NamedEntries factory) — the shipped
        // eight-tool surface must register each name exactly once.
        if (registered.some((t) => t.name === tool.name)) {
          throw new Error(
            `tool "${tool.name}" is already registered (for a per-agent ` +
              `variant, register through that agent's \`agent.ctx\` ` +
              `instead)`,
          );
        }
        registered.push(tool);
        const dispose = () => {
          const at = registered.indexOf(tool);
          if (at >= 0) registered.splice(at, 1);
        };
        disposers.push(dispose);
        return dispose;
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
    agents: { get: () => undefined },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        return {
          table: () => ({
            get: () => undefined,
            entries: () => new Map().entries(),
            async put() {},
            async delete() {
              return false;
            },
          }),
          async close() {},
          name: "stub",
        };
      },
    },
  };
}

describe("adapter dispatcher tool registration", () => {
  it("the capture registry throws the host duplicate-tool error (ticket 91 pin)", () => {
    const ctx = createToolsCaptureCtx();
    const tool = {
      name: SPAWN_DISPATCHER_TOOL,
      description: "d",
      parameters: {},
      execute: async () => ({}),
    } as unknown as RegisterableTool;
    ctx.tools.register(tool);

    assert.throws(
      () => ctx.tools.register(tool),
      new RegExp(`tool "${SPAWN_DISPATCHER_TOOL}" is already registered`),
    );
  });

  it("registers the dispatcher tools when ctx.tools.register exists", () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const disposers = registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "session-1",
    });
    assert.equal(disposers.length, DISPATCHER_TOOL_NAMES.length);
    assert.deepEqual(
      ctx.registered.map((tool) => tool.name),
      [...DISPATCHER_TOOL_NAMES],
    );
    // Each tool has a description and parameters for the model.
    for (const tool of ctx.registered) {
      assert.ok(tool.description.length > 20);
      assert.ok(tool.parameters !== undefined);
      assert.ok(typeof tool.execute === "function");
      assert.ok(typeof tool.output.render === "function");
    }
    for (const dispose of disposers) dispose();
    assert.equal(ctx.registered.length, 0);
  });

  /**
   * Ticket 176 (owner ruling 2026-11-03): the CLASS selects the surface.
   *
   * A summoned dispatcher is a team leader for one job and may not summon
   * further dispatchers, so `spawn_dispatcher` is never registered on its
   * scope — the model does not see the name at all (ADR-0019: visibility is
   * the fence, not a refusal copy). The user-started chief of staff keeps the
   * full custom set; a leader keeps the other two.
   */
  it("a spawned-class registration withholds spawn_dispatcher and keeps the other two", () => {
    const ctx = createToolsCaptureCtx();
    const multitask = createMultitask(new FakeDshHost());
    const disposers = registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "session-1",
      origin: "spawned",
    });

    const names = ctx.registered.map((tool) => tool.name);
    assert.ok(!names.includes(SPAWN_DISPATCHER_TOOL));
    assert.deepEqual(
      names,
      [...DISPATCHER_TOOL_NAMES].filter((name) => name !== SPAWN_DISPATCHER_TOOL),
    );
    assert.equal(disposers.length, DISPATCHER_TOOL_NAMES.length - 1);
    for (const dispose of disposers) dispose();
    assert.equal(ctx.registered.length, 0);
  });

  it("an explicit user class keeps all three, exactly like an omitted one", () => {
    const multitask = createMultitask(new FakeDshHost());
    const omitted = createToolsCaptureCtx();
    registerDispatcherTools({ ctx: omitted, multitask, getSessionId: () => "s" });
    const explicit = createToolsCaptureCtx();
    registerDispatcherTools({
      ctx: explicit,
      multitask,
      getSessionId: () => "s",
      origin: "user",
    });
    assert.deepEqual(
      explicit.registered.map((tool) => tool.name),
      omitted.registered.map((tool) => tool.name),
    );
    assert.deepEqual(
      explicit.registered.map((tool) => tool.name),
      [...DISPATCHER_TOOL_NAMES],
    );
  });

  /**
   * Ticket 179, narrowed by the stock-subagent refactor: the composition
   * `src/plugin.ts` performs on a real host — withhold the inherited fork
   * verb, then register our tools on the same scoped surface. The restriction
   * filters the INHERITED layer only (`dsh-tools/lib/index.js:3040-3072`), so
   * the custom tools stay while `subagent_fork` disappears. Plain
   * `subagent` is the supported way to start a worker now, and
   * `list_subagent_models` stays visible.
   */
  it("withholding the host fork verb leaves our custom tools untouched", () => {
    const inherited = new Map<string, RegisterableTool>();
    const restrictions: Array<{ deny?: readonly string[] }> = [];
    for (const name of [
      "subagent",
      "subagent_fork",
      "list_subagent_models",
      "read",
      "bash",
    ]) {
      inherited.set(name, { name } as RegisterableTool);
    }
    // A surface that behaves like the host's: `schemas(scope)` answers the
    // visible set (inherit minus restrictions, plus own), `register` lands in
    // the own layer, `restrict` filters inherited names only.
    const own = new Map<string, RegisterableTool>();
    const ctx = {
      tools: {
        schemas: () => [
          ...[...inherited.keys()]
            .filter((name) => !restrictions.some((r) => r.deny?.includes(name)))
            .map((name) => ({ name })),
          ...[...own.keys()].map((name) => ({ name })),
        ],
        register(definition: unknown) {
          const tool = definition as RegisterableTool;
          own.set(tool.name, tool);
          return () => {
            own.delete(tool.name);
          };
        },
        restrict(filter: { deny?: readonly string[] }) {
          const entry = { ...filter };
          restrictions.push(entry);
          return () => {
            const at = restrictions.indexOf(entry);
            if (at >= 0) restrictions.splice(at, 1);
          };
        },
      },
    };
    const surface = ctx.tools;

    const withholdDisposer = withholdHostSpawnTools(surface, {});
    const disposers = registerDispatcherTools({
      ctx,
      multitask: createMultitask(new FakeDshHost()),
      getSessionId: () => "session-1",
    });

    assert.deepEqual(restrictions, [{ deny: ["subagent_fork"] }]);
    const visible = surface.schemas().map((schema) => schema.name);
    assert.deepEqual(
      [...own.keys()],
      [...DISPATCHER_TOOL_NAMES],
    );
    assert.deepEqual(
      visible.sort(),
      [
        ...DISPATCHER_TOOL_NAMES,
        "bash",
        "read",
        "subagent",
        "list_subagent_models",
      ].sort(),
    );
    assert.ok(!visible.includes("subagent_fork"), "the fork verb is withheld");
    assert.ok(visible.includes("subagent"), "workers start with the stock subagent");
    assert.ok(visible.includes("list_subagent_models"));

    // The restriction is owned by the activation, like every registered tool.
    assert.ok(withholdDisposer);
    if (withholdDisposer !== null) disposers.push(withholdDisposer);
    for (const dispose of disposers) dispose();
    assert.deepEqual(restrictions, []);
    assert.deepEqual([...own.keys()], []);
  });

  it("execute on a registerable tool hits the Multitask core", async () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-core",
      title: "Ship the fix",
    });
    registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "session-1",
    });
    // `deliver_result` is the retained handler that writes through to the
    // core: the obsolete `spawn_worker` probe became this ledger close.
    const deliver = ctx.registered.find((tool) => tool.name === "deliver_result");
    assert.ok(deliver);
    const value = (await deliver.execute({
      text: "Fixed the parser.",
      todo_id: "todo-core",
    })) as { ok: boolean; delivered: boolean; channel?: string };
    assert.equal(value.ok, true);
    assert.equal(value.delivered, true);
    const entry = multitask.todos.get("todo-core");
    assert.equal(entry?.status, "completed");
    assert.equal(entry?.delivered, true);
    assert.equal(host.spawnCalls.length, 0, "nothing spawned a worker");
  });

  // Ticket 81 (live pass 5, Session B-2 FINDING 2): the durable `tool/result`
  // event carries the tool's RENDERED text plus the OPTIONAL
  // `output.presentationMeta` projection — never the raw structured `value`
  // (dsh-agent-loop `appendToolResult`, lib/index.js:697-712; dsh-tools
  // `createSuccessResult`, lib/index.js:3428). The client reducer reads
  // `data.meta` first, so every registered dispatcher tool must ship the
  // projection or the worker-dispatch card and the toolview parsers see only
  // prose live.
  it("every registered dispatcher tool carries output.presentationMeta", () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "session-1",
    });
    assert.equal(ctx.registered.length, DISPATCHER_TOOL_NAMES.length);
    for (const tool of ctx.registered) {
      assert.equal(
        typeof tool.output.presentationMeta,
        "function",
        `tool "${tool.name}" must attach presentationMeta (the durable record's structured half)`,
      );
    }
  });

  it("carries a compact display subject (kind/id/title) resolved from the core", async () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "session-1",
      spawnDispatcher: async (opts) => host.spawnDispatcher(opts),
    });
    // The retained `spawn_dispatcher` replaces the retired spawn probe: its
    // subject is the summoned peer, still only core identity (kind/id/title).
    const spawn = ctx.registered.find(
      (tool) => tool.name === SPAWN_DISPATCHER_TOOL,
    );
    assert.ok(spawn);
    const args = {
      title: "Parser hardening",
      prompt: "(never projected)",
    };
    const value = (await spawn.execute(args)) as {
      dispatcher_id: string;
      note: string;
    };
    const meta = spawn.output.presentationMeta?.(args, value) as {
      note?: unknown;
      display?: {
        subject?: { kind?: string; id?: string; title?: string };
      };
    };
    assert.equal(meta.note, undefined, "the model-facing note stays out");
    assert.deepEqual(meta.display?.subject, {
      kind: "dispatcher",
      id: value.dispatcher_id,
      title: "Parser hardening",
    });
    // Losslessly JSON-serializable (the host snapshots presentationMeta).
    assert.deepEqual(
      JSON.parse(JSON.stringify(meta)).display.subject,
      meta.display.subject,
    );
    // Never a prompt, report, or transcript string.
    assert.equal(JSON.stringify(meta).includes("never projected"), false);
  });

  it("resolves a todo title for deliver_result and a dispatcher kind for peers", async () => {
    const ctx = createToolsCaptureCtx();
    const multitask = createMultitask(new FakeDshHost());
    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-7",
      title: "Summarize RFCs",
    });
    registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "session-1",
      deliverToUser: async () => true,
    });
    const deliver = ctx.registered.find((tool) => tool.name === "deliver_result");
    assert.ok(deliver);
    const deliverArgs = { text: "done", todo_id: "todo-7" };
    const deliverValue = await deliver.execute(deliverArgs);
    const deliverMeta = deliver.output.presentationMeta?.(deliverArgs, deliverValue) as {
      display?: { subject?: { kind?: string; id?: string; title?: string } };
    };
    assert.deepEqual(deliverMeta.display?.subject, {
      kind: "todo",
      id: "todo-7",
      title: "Summarize RFCs",
    });

    const message = ctx.registered.find((tool) => tool.name === "message_agent");
    assert.ok(message);
    const messageArgs = { target: "session-0123456789abcdef", text: "hello" };
    const messageValue = await message.execute(messageArgs);
    const messageMeta = message.output.presentationMeta?.(messageArgs, messageValue) as {
      display?: { subject?: { kind?: string; id?: string; title?: string } };
    };
    assert.equal(messageMeta.display?.subject?.kind, "dispatcher");
    assert.equal(messageMeta.display?.subject?.id, "session-0123456789abcdef");
    assert.equal(messageMeta.display?.subject?.title, undefined);
  });

  // DELETED with the `check_workers` handler: "passes recentActivity through
  // to check rows (ticket 29)" read the roster through a tool this plugin no
  // longer registers. The stock `list_agents` has no recent-activity field,
  // and inventing one here would pin a contract that does not exist. The
  // activity ring itself stays core state, covered where it is written.
});

describe("per-session routing (ADR-0019)", () => {
  it("handlers route to the session that registered them, whatever the exec says", async () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "disp-1",
      spawnDispatcher: async (opts) => host.spawnDispatcher(opts),
    });
    const spawn = ctx.registered.find(
      (tool) => tool.name === SPAWN_DISPATCHER_TOOL,
    );
    assert.ok(spawn);

    // No execute-time gate (ADR-0019): the closed-over session id is the
    // authority; visibility is the fence, not a refusal copy. The retained
    // `spawn_dispatcher` is the probe: its core call carries the closure's
    // parent session, never the exec's.
    const routed = (await spawn.execute(
      { title: "T", prompt: "P" },
      { agent: { session: { id: "someone-else" } } },
    )) as { ok: boolean };
    assert.equal(routed.ok, true);
    assert.equal(host.dispatcherSpawnCalls.length, 1);
    assert.equal(host.dispatcherSpawnCalls[0]?.opts.parentSessionId, "disp-1");

    // Unresolvable exec: same routing, same session.
    const again = (await spawn.execute(
      { title: "T2", prompt: "P" },
      undefined,
    )) as { ok: boolean };
    assert.equal(again.ok, true);
    assert.equal(host.dispatcherSpawnCalls.length, 2);
    assert.equal(host.dispatcherSpawnCalls[1]?.opts.parentSessionId, "disp-1");
  });

  it("two registrations route independently per session", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const ctxA = createToolsCaptureCtx();
    const ctxB = createToolsCaptureCtx();
    registerDispatcherTools({
      ctx: ctxA,
      multitask,
      getSessionId: () => "disp-a",
      spawnDispatcher: async (opts) => host.spawnDispatcher(opts),
    });
    registerDispatcherTools({
      ctx: ctxB,
      multitask,
      getSessionId: () => "disp-b",
      spawnDispatcher: async (opts) => host.spawnDispatcher(opts),
    });
    const spawnA = ctxA.registered.find(
      (tool) => tool.name === SPAWN_DISPATCHER_TOOL,
    );
    const spawnB = ctxB.registered.find(
      (tool) => tool.name === SPAWN_DISPATCHER_TOOL,
    );
    assert.ok(spawnA);
    assert.ok(spawnB);

    await spawnA.execute({ title: "A", prompt: "P" }, undefined);
    await spawnB.execute({ title: "B", prompt: "P" }, undefined);
    assert.deepEqual(
      host.dispatcherSpawnCalls.map((call) => call.opts.parentSessionId),
      ["disp-a", "disp-b"],
    );
    // (The duplicate-stream-key half went with `spawn_worker`: a summoned
    // dispatcher has no stream key, and nothing on this surface spawns a
    // worker any more.)
  });
});

describe("ticket 117 — exec passthrough (the host's second argument reaches the handler)", () => {
  it("toRegisterableTool forwards exec to def.execute (the default path, no override)", async () => {
    const seen: unknown[] = [];
    const tool = toRegisterableTool({
      name: "x",
      description: "d",
      parameters: { type: "object" },
      async execute(_args, exec) {
        seen.push(exec);
        return { ok: true };
      },
    });
    const controller = new AbortController();
    const exec = { agent: { session: { id: "s-1" } }, signal: controller.signal };

    await tool.execute({ a: 1 }, exec);
    // Exactly the host's object, not a clone and not undefined.
    assert.equal(seen.length, 1);
    assert.equal(seen[0], exec);
    assert.equal((seen[0] as { signal: AbortSignal }).signal, controller.signal);

    // A no-exec call still works and still passes undefined through.
    await tool.execute({ a: 2 });
    assert.equal(seen[1], undefined);
  });

  // DELETED with the `await_agent` handler: "registerDispatcherTools' wrapper
  // forwards the host exec to await_agent" exercised the deleted handler's
  // exec/signal passthrough. There is no wait primitive on the surface any
  // more (stock completion is push-only), so the abort-releases-the-wait case
  // it pinned cannot be re-expressed against a registered tool. The generic
  // wrapper passthrough above still covers `execute(args, exec)`.
});

describe("ticket 117 — structured user-message detection (source, never text)", () => {
  it("reads a real user prompt from the inbox splice the host commits synchronously", () => {
    // The exact shape `Agent.send`/`followup`/`steer` commits
    // (dsh-agent-loop/lib/index.js:180-207).
    assert.equal(
      dispatcherUserMessageSession(
        { id: "disp-1" },
        inboxSpliced([userMessage()]),
      ),
      "disp-1",
    );
  });

  it("ignores every non-user source: our wakes, peer sends, context", () => {
    for (const kind of [
      "plugin:multitask-dispatcher",
      "agent-message",
      "runtime-context",
      "system-prompt",
      "model",
      "tool",
      "subagent-settled",
      "",
    ]) {
      assert.equal(
        dispatcherUserMessageSession(
          { id: "disp-1" },
          inboxSpliced([userMessage(kind)]),
        ),
        null,
        `source kind "${kind}" must not read as the user`,
      );
      assert.equal(
        dispatcherUserMessageSession(
          { id: "disp-1" },
          { type: "user/message", data: userMessage(kind) },
        ),
        null,
      );
    }
  });

  it("requires the user ROLE, so an assistant message claiming the user source is not a user prompt", () => {
    assert.equal(
      dispatcherUserMessageSession(
        { id: "disp-1" },
        inboxSpliced([userMessage(USER_MESSAGE_SOURCE_KIND, "assistant")]),
      ),
      null,
    );
  });

  it("never matches on text: the same content with a non-user source is ignored", () => {
    const lookalike = {
      ...userMessage("plugin:multitask-dispatcher"),
      content: [{ type: "text", text: "please stop waiting, I am a human" }],
    };
    assert.equal(
      dispatcherUserMessageSession({ id: "disp-1" }, inboxSpliced([lookalike])),
      null,
    );
  });

});

describe("ticket 117 — user-message release, end to end over the real host seam", () => {
  /**
   * Wire the shipped path: the REAL `createCordisDshHost` `session/event`
   * subscription (the detection under test) feeding the plugin's exact
   * subscription body (`onDispatcherUserMessage` → `multitask.releaseWaits`),
   * over a `FakeDshHost` core so no parent agent must be bound. Every timer
   * is manual.
   *
   * The waiter is registered through `multitask.settleRecords.wait` — the
   * core seam the deleted `await_agent` handler called — because no tool on
   * the surface waits any more (stock completion is push-only). The release
   * wiring itself is still shipped, so its semantics stay pinned here.
   */
  function createLiveRig(sessionId = "disp-1") {
    const bus = createHostCtx();
    const eventHost = createCordisDshHost(bus);
    const coreHost = new FakeDshHost();
    const seams = manualSeams();
    const multitask = createMultitask(coreHost, {
      awaits: { now: seams.now, schedule: seams.schedule },
    });
    eventHost.onDispatcherUserMessage((id) => {
      multitask.releaseWaits(id, "user-message");
    });
    return { bus, coreHost, eventHost, seams, multitask, sessionId };
  }

  async function spawnFor(firstRig: ReturnType<typeof createLiveRig>, sessionId = "disp-1") {
    const spawned = await firstRig.multitask.spawnWorker({
      parentSessionId: sessionId,
      streamKey: "s",
      title: "T",
      prompt: "P",
    });
    assert.ok(spawned.ok, spawned.ok ? "" : spawned.detail);
    if (!spawned.ok) throw new Error("unreachable");
    return spawned.workerId;
  }

  it("a user prompt on the waiting dispatcher's own session releases the wait", async () => {
    const r = createLiveRig();
    const workerId = await spawnFor(r);

    const pending = r.multitask.settleRecords.wait(
      "disp-1",
      workerId,
      120_000,
      new AbortController().signal,
    ) as Promise<{ ok: boolean; status?: string; reason?: string; waitedMs?: number }>;
    assert.equal(r.multitask.settleRecords.waiterCount("disp-1"), 1);
    r.seams.advance(250);

    // The host commits the inbox splice synchronously inside `Agent.send`,
    // i.e. while the tool call is still blocked.
    r.bus.fire("session/event", { id: "disp-1" }, inboxSpliced([userMessage()]));

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.status, "released");
    assert.equal(result.reason, "user-message");
    assert.equal(result.waitedMs, 250);
    assert.equal(r.seams.scheduled[0]?.ms, 120_000);
    assert.equal(r.seams.scheduled[0]?.cancelled, true);
    assert.equal(r.multitask.settleRecords.waiterCount("disp-1"), 0);
    // The worker was NOT stopped — only the wait was — and no record appeared.
    assert.equal(r.coreHost.interruptCalls.length, 0);
    assert.equal(r.multitask.settleRecords.lookup("disp-1", workerId), undefined);
  });

  it("our own wake and a peer wake never release; the user's message does", async () => {
    const r = createLiveRig();
    const workerId = await spawnFor(r);

    const pending = r.multitask.settleRecords.wait(
      "disp-1",
      workerId,
      30_000,
      new AbortController().signal,
    ) as Promise<{ ok: boolean; status?: string; reason?: string }>;

    // Plugin wake (`plugin:multitask-dispatcher`), peer wake (`agent-message`),
    // and injected runtime context all arrive on the same session first.
    for (const kind of [
      "plugin:multitask-dispatcher",
      "agent-message",
      "runtime-context",
    ]) {
      r.bus.fire("session/event", { id: "disp-1" }, inboxSpliced([userMessage(kind)]));
    }
    assert.equal(r.multitask.settleRecords.waiterCount("disp-1"), 1);

    r.bus.fire("session/event", { id: "disp-1" }, inboxSpliced([userMessage()]));
    const result = await pending;
    assert.equal(result.status, "released");
    assert.equal(result.reason, "user-message");
  });

  it("another session's user prompt does not release this session's waiter", async () => {
    const r = createLiveRig("disp-1");
    const workerId = await spawnFor(r);

    const pending = r.multitask.settleRecords.wait(
      "disp-1",
      workerId,
      30_000,
      new AbortController().signal,
    ) as Promise<{ ok: boolean; status?: string; reason?: string }>;

    r.bus.fire("session/event", { id: "someone-else" }, inboxSpliced([userMessage()]));
    assert.equal(r.multitask.settleRecords.waiterCount("disp-1"), 1);

    // The release must be scoped: the sibling's prompt left this wait alive,
    // so only the deactivation path can end it here.
    r.multitask.cancelWaits("disp-1");
    const result = await pending;
    assert.equal(result.status, "released");
    assert.equal(result.reason, "stopped");
  });

  it("a worker's own initial brief (host source kind `user`) cannot release the dispatcher's wait", async () => {
    // The host submits a spawned child's task with `source: {kind:"user"}`
    // (`dsh-subagent/lib/index.js:1461`), so a spawn DURING a dispatcher wait
    // delivers a user-sourced message on the CHILD's session. Waiters are
    // keyed by the awaiting dispatcher's session id, so that delivery must
    // release nothing here.
    const r = createLiveRig();
    const workerId = await spawnFor(r);
    const pending = r.multitask.settleRecords.wait(
      "disp-1",
      workerId,
      30_000,
      new AbortController().signal,
    ) as Promise<{ ok: boolean; status?: string; reason?: string }>;
    assert.equal(r.multitask.settleRecords.waiterCount("disp-1"), 1);

    r.bus.fire("session/event", { id: "child-worker-9" }, inboxSpliced([userMessage()]));
    assert.equal(
      r.multitask.settleRecords.waiterCount("disp-1"),
      1,
      "the child's brief must not release the dispatcher's wait",
    );

    // The dispatcher's own user prompt is what ends it.
    r.bus.fire("session/event", { id: "disp-1" }, inboxSpliced([userMessage()]));
    const result = await pending;
    assert.equal(result.status, "released");
    assert.equal(result.reason, "user-message");
  });

  // DELETED with the `await_agent` handler: "the released/user-message wire
  // shape carries the model-facing copy" pinned result formatters
  // (`summary`/`target`/`waited_ms`) that left the tree with the tool. The
  // core outcome's own shape is asserted by the four release cases above.
});

