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
} from "../src/core/policy/prompts.js";
import {
  registerDispatcherTools,
  resolveExecSessionId,
  structuredPresentationMeta,
  toRegisterableTool,
  type RegisterableTool,
} from "../src/adapter/dispatcher-tools.js";
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
      name: "spawn_worker",
      description: "d",
      parameters: {},
      execute: async () => ({}),
    } as unknown as RegisterableTool;
    ctx.tools.register(tool);

    assert.throws(
      () => ctx.tools.register(tool),
      /tool "spawn_worker" is already registered/,
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

  it("is a no-op when tools or register are unavailable", () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const bare = {} as AdapterContext;
    assert.deepEqual(
      registerDispatcherTools({
        ctx: bare,
        multitask,
        getSessionId: () => null,
      }),
      [],
    );
  });

  it("execute on a registerable tool hits the Multitask core", async () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "session-1",
    });
    const spawn = ctx.registered.find((tool) => tool.name === "spawn_worker");
    assert.ok(spawn);
    const value = (await spawn.execute({
      stream_key: "s-1",
      title: "Title",
      prompt: "Prompt.",
    })) as { ok: boolean; ack: string };
    assert.equal(value.ok, true);
    assert.ok(value.ack.includes("background"));
    assert.equal(host.spawnCalls.length, 1);
  });

  it("render prefers ack / summary / note over raw JSON", () => {
    const rendered = toRegisterableTool({
      name: "x",
      description: "d",
      parameters: { type: "object" },
      async execute() {
        return { ok: true, ack: "Started in the background." };
      },
    }).output.render({}, { ok: true, ack: "Started in the background." });
    assert.deepEqual(rendered, [
      { type: "text", text: "Started in the background." },
    ]);
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

  it("structuredPresentationMeta strips model-facing prose, keeps the structured fields", () => {
    // spawn ack embeds the whole worker prompt — never durable twice.
    const spawn = structuredPresentationMeta(
      {},
      {
        ok: true,
        worker_id: "w-1",
        stream_key: "s-1",
        title: "Title",
        gated: true,
        ack: "Started ... Self-contained prompt sent:\n---\nthe whole prompt",
      },
    ) as Record<string, unknown>;
    assert.deepEqual(spawn, {
      ok: true,
      worker_id: "w-1",
      stream_key: "s-1",
      title: "Title",
      gated: true,
    });
    // check summary is the rendered table — rows remain the structured half.
    const check = structuredPresentationMeta({}, {
      ok: true,
      rows: [{ worker_id: "w-1" }],
      summary: "running · \"Title\" · 1s",
    }) as Record<string, unknown>;
    assert.deepEqual(check, { ok: true, rows: [{ worker_id: "w-1" }] });
    // steer/stop notes and refusal records: prose gone, reason/detail kept.
    assert.deepEqual(structuredPresentationMeta({}, { ok: true, note: "n" }), {
      ok: true,
    });
    assert.deepEqual(
      structuredPresentationMeta({}, {
        ok: false,
        reason: "auto-review-refused",
        detail: "d",
      }),
      { ok: false, reason: "auto-review-refused", detail: "d" },
    );
    // Non-record values pass through (the host rejects an undefined
    // projection outright — there is no "absent" answer).
    assert.equal(structuredPresentationMeta({}, null), null);
    assert.deepEqual(structuredPresentationMeta({}, [1, 2]), [1, 2]);
    assert.equal(structuredPresentationMeta({}, "text"), "text");
    // The projection must not mutate its input value.
    const original = { ok: true, ack: "a", worker_id: "w" };
    structuredPresentationMeta({}, original);
    assert.deepEqual(original, { ok: true, ack: "a", worker_id: "w" });
  });

  it("toRegisterableTool output attaches the presentation projection", () => {
    const tool = toRegisterableTool({
      name: "x",
      description: "d",
      parameters: { type: "object" },
      async execute() {
        return { ok: true };
      },
    });
    assert.equal(typeof tool.output.presentationMeta, "function");
    assert.deepEqual(tool.output.presentationMeta?.({}, { ok: true }), {
      ok: true,
    });
  });

  it("passes recentActivity through to check rows (ticket 29)", async () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "session-1",
      recentActivity: (workerId) =>
        workerId.startsWith("fake-worker") ? "bash: npm test" : null,
    });
    const result = (await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "t-1",
      title: "Summarize RFCs",
      prompt: "Go.",
    })) as { ok: true; workerId: string };
    assert.ok(result.ok);
    const check = ctx.registered.find((tool) => tool.name === "check_workers");
    assert.ok(check);
    const value = (await check.execute({})) as {
      ok: boolean;
      rows: Array<{ worker_id: string; recent_activity: string | null }>;
    };
    assert.equal(value.ok, true);
    assert.equal(value.rows.length, 1);
    assert.equal(value.rows[0]?.worker_id, result.workerId);
    assert.equal(value.rows[0]?.recent_activity, "bash: npm test");
  });
});

describe("per-session routing (ADR-0019)", () => {
  it("resolveExecSessionId reads common exec shapes", () => {
    assert.equal(
      resolveExecSessionId({ agent: { session: { id: "a1" } } }),
      "a1",
    );
    assert.equal(resolveExecSessionId({ session: { id: "a2" } }), "a2");
    assert.equal(resolveExecSessionId({ sessionId: "a3" }), "a3");
    assert.equal(resolveExecSessionId(undefined), null);
    assert.equal(resolveExecSessionId("string"), null);
    assert.equal(resolveExecSessionId({ agent: { session: {} } }), null);
  });

  it("handlers route to the session that registered them, whatever the exec says", async () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "disp-1",
    });
    const spawn = ctx.registered.find((tool) => tool.name === "spawn_worker");
    assert.ok(spawn);

    // No execute-time gate (ADR-0019): the closed-over session id is the
    // authority; visibility is the fence, not a refusal copy.
    const routed = (await spawn.execute(
      { stream_key: "s", title: "T", prompt: "P" },
      { agent: { session: { id: "someone-else" } } },
    )) as { ok: boolean };
    assert.equal(routed.ok, true);
    assert.equal(host.spawnCalls.length, 1);
    assert.equal(host.spawnCalls[0]?.opts.parentSessionId, "disp-1");

    // Unresolvable exec: same routing, same session.
    const again = (await spawn.execute(
      { stream_key: "s2", title: "T", prompt: "P" },
      undefined,
    )) as { ok: boolean };
    assert.equal(again.ok, true);
    assert.equal(host.spawnCalls.length, 2);
    assert.equal(host.spawnCalls[1]?.opts.parentSessionId, "disp-1");
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
    });
    registerDispatcherTools({
      ctx: ctxB,
      multitask,
      getSessionId: () => "disp-b",
    });
    const spawnA = ctxA.registered.find((tool) => tool.name === "spawn_worker");
    const spawnB = ctxB.registered.find((tool) => tool.name === "spawn_worker");
    assert.ok(spawnA);
    assert.ok(spawnB);

    await spawnA.execute(
      { stream_key: "shared", title: "A", prompt: "P" },
      undefined,
    );
    await spawnB.execute(
      { stream_key: "shared", title: "B", prompt: "P" },
      undefined,
    );
    assert.deepEqual(
      host.spawnCalls.map((call) => call.opts.parentSessionId),
      ["disp-a", "disp-b"],
    );

    // Same stream key within ONE session still refuses.
    const refused = (await spawnA.execute(
      { stream_key: "shared", title: "A2", prompt: "P" },
      undefined,
    )) as { ok: boolean; reason: string };
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "duplicate-stream-key");
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

  it("registerDispatcherTools' wrapper forwards the host exec to await_agent", async () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const seams = manualSeams();
    const multitask = createMultitask(host, {
      awaits: { now: seams.now, schedule: seams.schedule },
    });
    registerDispatcherTools({ ctx, multitask, getSessionId: () => "disp-1" });

    const spawned = await multitask.spawnWorker({
      parentSessionId: "disp-1",
      streamKey: "s",
      title: "T",
      prompt: "P",
    });
    assert.ok(spawned.ok);
    if (!spawned.ok) throw new Error("unreachable");

    const awaitAgent = ctx.registered.find((t) => t.name === "await_agent");
    assert.ok(awaitAgent);

    // The host invokes a registered tool as `execute(args, exec)`
    // (`dsh-tools/lib/index.js:3406`). Aborting that signal must release the
    // wait — this is the whole point of the passthrough: without it the wait
    // has only its 120 s cap.
    const controller = new AbortController();
    const pending = awaitAgent.execute(
      { target: spawned.workerId, timeout_ms: 30_000 },
      { agent: { session: { id: "disp-1" } }, signal: controller.signal },
    ) as Promise<{ ok: boolean; status?: string; reason?: string }>;
    assert.equal(seams.scheduled.length, 1);
    assert.equal(multitask.settleRecords.waiterCount("disp-1"), 1);

    seams.advance(12);
    controller.abort();

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.status, "released");
    assert.equal(result.reason, "stopped");
    // The losing racer cleaned up: timer cancelled, waiter gone.
    assert.equal(seams.scheduled[0]?.cancelled, true);
    assert.equal(multitask.settleRecords.waiterCount("disp-1"), 0);
  });

  it("a worker-scope exec shape is not required: any exec object is forwarded verbatim", async () => {
    // The wrapper must not filter, reshape, or validate exec — `readExecSignal`
    // in core owns that decision, and it must see what the host produced.
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
    const unusual = { signal: undefined, foreign: new Map([[1, 2]]) };
    await tool.execute({}, unusual);
    assert.equal(seen[0], unusual);
  });

  it("an executeOverride still receives exec (the existing escape hatch is unchanged)", async () => {
    const seen: unknown[] = [];
    const tool = toRegisterableTool(
      {
        name: "x",
        description: "d",
        parameters: { type: "object" },
        async execute() {
          throw new Error("the override must win");
        },
      },
      async (_args, exec) => {
        seen.push(exec);
        return { ok: true };
      },
    );
    const exec = { signal: new AbortController().signal };
    await tool.execute({}, exec);
    assert.equal(seen[0], exec);
  });
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

  it("reads a user/message event as the turn-boundary catch", () => {
    assert.equal(
      dispatcherUserMessageSession(
        { id: "disp-1" },
        { type: "user/message", data: userMessage() },
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

  it("ignores removals from the inbox: only inserted messages count", () => {
    // Queue management (a cancel/remove) is not a user prompt.
    assert.equal(
      dispatcherUserMessageSession(
        { id: "disp-1" },
        {
          type: "agent/inbox/spliced",
          data: { target: "next-step", start: 0, removedCount: 2, inserted: [], outcome: "canceled" },
        },
      ),
      null,
    );
  });

  it("ignores worker tool traffic and unreadable payloads", () => {
    assert.equal(
      dispatcherUserMessageSession(
        { id: "disp-1" },
        { type: "tool/call", data: { name: "bash", arguments: "{}" } },
      ),
      null,
    );
    assert.equal(dispatcherUserMessageSession({ id: "d" }, null), null);
    assert.equal(dispatcherUserMessageSession({ id: "d" }, { type: "user/message" }), null);
    assert.equal(dispatcherUserMessageSession(undefined, { type: "user/message", data: userMessage() }), null);
    assert.equal(dispatcherUserMessageSession({}, { type: "user/message", data: userMessage() }), null);
    assert.equal(
      dispatcherUserMessageSession({ id: "d" }, { type: "agent/inbox/spliced", data: { inserted: "nope" } }),
      null,
    );
  });
});

describe("ticket 117 — user-message release, end to end over the real host seam", () => {
  /**
   * Wire the shipped path: the REAL `createCordisDshHost` `session/event`
   * subscription (the detection under test) feeding the plugin's exact
   * subscription body (`onDispatcherUserMessage` → `multitask.releaseWaits`),
   * over a `FakeDshHost` core so no parent agent must be bound. The registered
   * `await_agent` is the adapter wrapper (exec passthrough exercised too), and
   * every timer is manual.
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
    const tools = createToolsCaptureCtx();
    registerDispatcherTools({ ctx: tools, multitask, getSessionId: () => sessionId });
    const awaitAgent = tools.registered.find((t) => t.name === "await_agent");
    assert.ok(awaitAgent);
    return { bus, coreHost, eventHost, seams, multitask, awaitAgent };
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

    const pending = r.awaitAgent.execute(
      { target: workerId, timeout_ms: 120_000 },
      { signal: new AbortController().signal },
    ) as Promise<{ ok: boolean; status?: string; reason?: string; waited_ms?: number }>;
    assert.equal(r.multitask.settleRecords.waiterCount("disp-1"), 1);
    r.seams.advance(250);

    // The host commits the inbox splice synchronously inside `Agent.send`,
    // i.e. while the tool call is still blocked.
    r.bus.fire("session/event", { id: "disp-1" }, inboxSpliced([userMessage()]));

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.status, "released");
    assert.equal(result.reason, "user-message");
    assert.equal(result.waited_ms, 250);
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

    const pending = r.awaitAgent.execute(
      { target: workerId, timeout_ms: 30_000 },
      { signal: new AbortController().signal },
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

    const pending = r.awaitAgent.execute(
      { target: workerId, timeout_ms: 30_000 },
      { signal: new AbortController().signal },
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

  it("a user prompt with no waiter in flight is a harmless no-op", () => {
    const r = createLiveRig();
    assert.doesNotThrow(() => {
      r.bus.fire("session/event", { id: "disp-1" }, inboxSpliced([userMessage()]));
      r.bus.fire("session/event", { id: "never-activated" }, inboxSpliced([userMessage()]));
    });
    assert.equal(r.multitask.settleRecords.waiterCount("disp-1"), 0);
  });

  it("a worker's own initial brief (host source kind `user`) cannot release the dispatcher's wait", async () => {
    // The host submits a spawned child's task with `source: {kind:"user"}`
    // (`dsh-subagent/lib/index.js:1461`), so a spawn DURING a dispatcher wait
    // delivers a user-sourced message on the CHILD's session. Waiters are
    // keyed by the awaiting dispatcher's session id and workers are denied
    // `await_agent`, so that delivery must release nothing here.
    const r = createLiveRig();
    const workerId = await spawnFor(r);
    const pending = r.awaitAgent.execute(
      { target: workerId, timeout_ms: 30_000 },
      { signal: new AbortController().signal },
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

  it("the released/user-message wire shape carries the model-facing copy", async () => {
    const r = createLiveRig();
    const workerId = await spawnFor(r);
    const pending = r.awaitAgent.execute(
      { target: workerId, timeout_ms: 30_000 },
      { signal: new AbortController().signal },
    ) as Promise<Record<string, unknown>>;
    r.bus.fire("session/event", { id: "disp-1" }, inboxSpliced([userMessage()]));
    const result = await pending;

    assert.deepEqual(Object.keys(result).sort(), [
      "ok",
      "reason",
      "status",
      "summary",
      "target",
      "waited_ms",
    ]);
    assert.equal(result.reason, "user-message");
    const summary = String(result.summary);
    assert.ok(summary.includes("the user said something"));
    assert.ok(summary.includes("answer them now"));
    // The worker keeps running — the copy must say so.
    assert.ok(summary.includes("keeps running"));
  });
});

