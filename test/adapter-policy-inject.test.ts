import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMultitask } from "../src/core/multitask.js";
import {
  bindDispatcherLifecycle,
  subagentLabelOf,
  type AgentLike,
} from "../src/adapter/index.js";
import type { AdapterContext, CordisDshHost } from "../src/adapter/cordis-dsh-host.js";

interface CaptureAgent extends AgentLike {
  readonly injected: unknown[];
  readonly followed: unknown[];
}

function createAgent(sessionId: string, withInject = true): CaptureAgent {
  const injected: unknown[] = [];
  const followed: unknown[] = [];
  const agent: CaptureAgent = {
    session: { id: sessionId, header: { parentSession: null, delegationDepth: 0 } },
    injected,
    followed,
    followup(message: unknown) {
      followed.push(message);
    },
    ...(withInject
      ? {
          inject(message: unknown) {
            injected.push(message);
          },
        }
      : {}),
  };
  return agent;
}

function createChildAgent(sessionId: string): CaptureAgent {
  const agent = createAgent(sessionId);
  return {
    ...agent,
    session: {
      id: sessionId,
      header: { parentSession: "parent-x", delegationDepth: 1 },
    },
  };
}

function createCtx(): AdapterContext & {
  listeners: Map<string, Array<(payload: never) => void>>;
  emit(name: string, payload: unknown): void;
} {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  return {
    listeners,
    emit(name: string, payload: unknown) {
      for (const cb of listeners.get(name) ?? []) {
        cb(payload as never);
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

/** Minimal CordisDshHost stand-in for lifecycle binding tests. */
function createHostStub(): CordisDshHost & {
  bound: Array<{ agent: AgentLike; sessionId: string }>;
  /** Ticket 58: dispatcher wakes recorded so the redrive can be asserted. */
  wakeups: string[];
  /** Ticket 155: per-session current tool/target the roster feed reads. */
  peerTools: Map<string, { tool: string | null; target: string | null }>;
  fireSettled(event: unknown): void;
} {
  const bound: Array<{ agent: AgentLike; sessionId: string }> = [];
  const wakeups: string[] = [];
  const peerTools = new Map<
    string,
    { tool: string | null; target: string | null }
  >();
  const settledCallbacks: Array<(event: never) => void> = [];
  const stepCallbacks: Array<(workerId: string) => void | Promise<void>> = [];

  const host = {
    bound,
    wakeups,
    async spawnWorker(): Promise<string> {
      return "stub-worker";
    },
    async interruptWorker(): Promise<void> {},
    async sendMessage(): Promise<void> {},
    onWorkerSettled(cb: (event: never) => void): void {
      settledCallbacks.push(cb);
    },
    onStepBoundary(cb: (workerId: string) => void | Promise<void>): void {
      stepCallbacks.push(cb);
    },
    onAccessRequest(): void {
      // Stub: T13 access-relay wiring is not under test here.
    },
    async requestDispatcherWakeup(sessionId: string): Promise<void> {
      wakeups.push(sessionId);
    },
    fireSettled(event: unknown): void {
      for (const cb of [...settledCallbacks]) cb(event as never);
    },
    // ADR-0019: per-session parent map semantics.
    bindParent(agent: AgentLike, sessionId: string): void {
      bound.push({ agent, sessionId });
    },
    unbindParent(sessionId?: string): void {
      if (sessionId === undefined) {
        bound.length = 0;
        return;
      }
      const at = bound.findIndex((entry) => entry.sessionId === sessionId);
      if (at >= 0) bound.splice(at, 1);
    },
    hasParent(): boolean {
      return bound.length > 0;
    },
    parentAgentOf(sessionId: string): AgentLike | undefined {
      return bound.find((entry) => entry.sessionId === sessionId)?.agent;
    },
    listLiveJobs: () => [],
    markers: undefined,
    workerIdOf: () => undefined,
    owns: () => false,
    peerTools,
    peerToolActivity: (sessionId: string) => peerTools.get(sessionId) ?? null,
    emitStepBoundary(): void {},
    dispose(): void {},
  };
  return host as unknown as CordisDshHost & {
    bound: Array<{ agent: AgentLike; sessionId: string }>;
    wakeups: string[];
    peerTools: Map<string, { tool: string | null; target: string | null }>;
    fireSettled(event: unknown): void;
  };
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

describe("dispatcher activation lifecycle (ticket 19)", () => {
  it("activate binds the parent and injects policy exactly once", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      policyEnabled: true,
    });
    const agent = createAgent("session-1");

    const outcome = lifecycle.activate(agent);

    assert.deepEqual(outcome, { ok: true });
    assert.equal(lifecycle.dispatcherSessionId(), "session-1");
    assert.equal(host.hasParent(), true);
    assert.deepEqual(host.bound, [{ agent, sessionId: "session-1" }]);
    assert.equal(agent.injected.length, 1);
    const text = textOf(agent.injected[0]);
    assert.ok(text.includes("# Multitask dispatcher"));
    assert.ok(text.includes("chief of staff"));
  });

  it("fires onActivated / onDeactivated around the activation", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const events: string[] = [];
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      onActivated: (sessionId) => events.push(`activated:${sessionId}`),
      onDeactivated: () => events.push("deactivated"),
    });
    const agent = createAgent("session-1");

    lifecycle.activate(agent);
    ctx.emit("agent/disposed", { agent });

    assert.deepEqual(events, ["activated:session-1", "deactivated"]);
    assert.equal(lifecycle.dispatcherSessionId(), null);
    assert.equal(host.hasParent(), false);
  });

  it("agent/disposed unbinds the parent and clears the session", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);
    const agent = createAgent("session-1");

    lifecycle.activate(agent);
    ctx.emit("agent/disposed", { agent });

    assert.equal(lifecycle.dispatcherSessionId(), null);
    assert.equal(host.hasParent(), false);
    assert.deepEqual(host.bound, []);
  });

  it("re-injects the per-turn reminder on dispatcher turn start after activation", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      policyEnabled: true,
    });
    const agent = createAgent("session-1");

    lifecycle.activate(agent);
    ctx.emit("agent/status", { agent, status: "running" });

    assert.equal(agent.injected.length, 2);
    const reminder = textOf(agent.injected[1]);
    assert.ok(reminder.includes("## Ledger"));
    assert.ok(reminder.includes("## Standing rules"));
    assert.ok(reminder.includes("(empty)"));

    // Ticket 57 R2: a turn is ALREADY open here, so the reminder queues via
    // `inject`. Waking it would open a second turn on every dispatcher turn
    // start — an extra model call per turn, for content already in context.
    // Only the recovery notice wakes.
    assert.equal(
      agent.followed.length,
      0,
      "the per-turn reminder must not wake a turn",
    );
  });

  it("a dispatcher turn end redrives an undelivered result by opening a turn (ticket 58)", async () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      policyEnabled: true,
    });
    const agent = createAgent("session-1");
    lifecycle.activate(agent);

    multitask.createTodo({
      sessionId: "session-1",
      id: "todo-1",
      title: "Research",
    });
    const spawned = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "k1",
      title: "Research",
      prompt: "go",
      todoId: "todo-1",
    });
    assert.ok(spawned.ok);
    host.fireSettled({
      workerId: spawned.workerId,
      status: "completed",
      report: "done",
    });
    // The settle wake itself is the item's first delivery chance.
    multitask.drainWake("session-1");
    const wakeupsBefore = host.wakeups.length;

    // The turn that carried the result ends with the result still undelivered.
    ctx.emit("agent/status", { agent, status: "running" });
    ctx.emit("agent/status", { agent, status: "idle" });

    assert.equal(
      multitask.todos.get("todo-1")?.redriveAttempts,
      1,
      "the missed delivery cost exactly one attempt",
    );
    assert.equal(
      host.wakeups.length,
      wakeupsBefore + 1,
      "the redrive reaches the host's waking primitive — it does not wait",
    );

    // A delivered result stops the loop dead: no further attempts, no wake.
    multitask.markDelivered("todo-1");
    const wakeupsAtDelivery = host.wakeups.length;
    ctx.emit("agent/status", { agent, status: "running" });
    ctx.emit("agent/status", { agent, status: "idle" });
    assert.equal(multitask.todos.get("todo-1")?.redriveAttempts, 1);
    assert.equal(host.wakeups.length, wakeupsAtDelivery);
  });

});

describe("peer roster feed carries label + current tool/target (ticket 155)", () => {
  /** Activate N dispatchers; the first is the viewer. */
  function activatePeers(options: {
    count: number;
    labels?: Readonly<Record<string, string | null>>;
    throwFor?: string;
  }) {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const labels = options.labels ?? {};
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      policyEnabled: true,
      peerLabelOf: (session) => {
        const id = String((session as { id?: unknown }).id);
        if (options.throwFor === id) throw new Error("registry exploded");
        return labels[id] ?? null;
      },
    });
    const agents = Array.from({ length: options.count }, (_, index) =>
      createAgent(`session-${index + 1}`),
    );
    for (const agent of agents) lifecycle.activate(agent);
    const viewer = agents[0];
    assert.ok(viewer);
    return { ctx, host, multitask, lifecycle, agents, viewer };
  }

  /** The roster block of the viewer's last injected reminder. */
  function rosterOf(agent: CaptureAgent): string {
    const text = textOf(agent.injected.at(-1));
    const at = text.indexOf("## Other agents");
    return at < 0 ? "" : text.slice(at);
  }

  it("two peers with distinct labels and distinct tools render two distinct rows", () => {
    const { ctx, host, viewer } = activatePeers({
      count: 3,
      labels: { "session-2": "Research scout" },
    });
    host.peerTools.set("session-2", { tool: "read_file", target: "src/core/policy" });
    host.peerTools.set("session-3", { tool: "grep", target: "roster" });

    ctx.emit("agent/status", { agent: viewer, status: "running" });
    const roster = rosterOf(viewer);
    assert.ok(
      roster.includes(
        "- Research scout (session-2) — idle · using read_file on src/core/policy",
      ),
      roster,
    );
    assert.ok(roster.includes("- session-3 — idle · using grep on roster"), roster);
    assert.equal(
      roster.split("\n").filter((line) => line.startsWith("- ")).length,
      2,
      "one row per peer, never merged",
    );
  });

  it("a labelled peer with no observed tool shows the label only", () => {
    const { ctx, viewer } = activatePeers({
      count: 2,
      labels: { "session-2": "Changelog" },
    });
    ctx.emit("agent/status", { agent: viewer, status: "running" });
    const roster = rosterOf(viewer);
    assert.ok(roster.includes("- Changelog (session-2) — idle"), roster);
    assert.ok(!roster.includes("·"));
  });

  it("the label read is best-effort: a throwing seam leaves the row on its id", () => {
    const { ctx, viewer } = activatePeers({ count: 2, throwFor: "session-2" });
    assert.doesNotThrow(() =>
      ctx.emit("agent/status", { agent: viewer, status: "running" }),
    );
    assert.ok(rosterOf(viewer).includes("- session-2 — idle"));
  });

  it("the current tool rides the same row as liveness (working · using …)", () => {
    const { ctx, host, agents } = activatePeers({
      count: 2,
      labels: { "session-2": "Research scout" },
    });
    const viewer = agents[0];
    const peer = agents[1];
    assert.ok(viewer && peer);
    host.peerTools.set("session-2", { tool: "bash", target: "npm test" });
    ctx.emit("agent/status", { agent: peer, status: "running" });
    ctx.emit("agent/status", { agent: viewer, status: "running" });
    assert.ok(
      rosterOf(viewer).includes(
        "- Research scout (session-2) — working · using bash on npm test",
      ),
      rosterOf(viewer),
    );
  });
});

describe("subagentLabelOf — the ADR-0027 label read (ticket 155)", () => {
  /** Registry stub: `stateOf` answers from a per-session map of raw states. */
  function registry(states: Readonly<Record<string, unknown>>) {
    return {
      stateOf(session: unknown, key: string): unknown {
        if (key !== "subagent") return undefined;
        return states[String((session as { id?: unknown }).id)];
      },
    };
  }

  it("reads the folded identity label, never the wire mode", () => {
    const label = subagentLabelOf(
      registry({ s1: { identity: { mode: "continuable", label: "Research scout", seq: 3 } } }),
      { id: "s1" },
    );
    assert.equal(label, "Research scout");
  });

  it("no registry, no stateOf, junk state, or a throw all answer null", () => {
    assert.equal(subagentLabelOf(undefined, { id: "s1" }), null);
    assert.equal(subagentLabelOf({}, { id: "s1" }), null);
    assert.equal(subagentLabelOf(registry({ s1: 42 }), { id: "s1" }), null);
    assert.equal(
      subagentLabelOf(registry({ s1: { identity: "nope" } }), { id: "s1" }),
      null,
    );
    assert.equal(
      subagentLabelOf(
        {
          stateOf() {
            throw new Error("registry exploded");
          },
        },
        { id: "s1" },
      ),
      null,
    );
  });
});
