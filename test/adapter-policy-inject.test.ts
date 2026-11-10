import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMultitask } from "../src/core/multitask.js";
import { assembleSessionPolicy } from "../src/core/policy/assembler.js";
import {
  bindDispatcherLifecycle,
  subagentLabelOf,
  type AgentLike,
} from "../src/adapter/index.js";
import type { AdapterContext, CordisDshHost } from "../src/adapter/cordis-dsh-host.js";
import { WAKE_SOURCE_KIND } from "../src/adapter/wake-copy.js";

interface CaptureAgent extends AgentLike {
  readonly injected: unknown[];
  readonly followed: unknown[];
}

/** One committed session event, as the live surface and eventAt expose it. */
interface FakeSurfaceEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: {
    readonly role?: string;
    readonly source?: { readonly kind?: string };
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  };
}

/**
 * A minimal event-sourced session (ticket 296): an append-only event list plus
 * a live surface node list, which is exactly what `policyOnLiveSurface`
 * reads. Compaction shadows nodes; nothing is ever removed from the log.
 */
interface FakeSurface {
  readonly session: {
    readonly id: string;
    readonly header: { readonly parentSession: null; readonly delegationDepth: number };
    readonly surface: { readonly nodes: readonly number[] };
    eventAt(seq: number): FakeSurfaceEvent | undefined;
  };
  appendSystem(text: string): number;
  appendToolResult(text: string): number;
  appendProducerUserMessage(text: string): number;
  compact(summary: string): void;
  pruneToolResult(seq: number, replacementText: string): void;
  nodes(): readonly number[];
}

function textBlock(text: string): ReadonlyArray<{ readonly type: string; readonly text: string }> {
  return [{ type: "text", text }];
}

function createFakeSurface(sessionId: string): FakeSurface {
  const events: FakeSurfaceEvent[] = [];
  let nodes: number[] = [];
  function append(event: Omit<FakeSurfaceEvent, "seq">): number {
    const seq = events.length;
    events.push({ seq, ...event });
    nodes.push(seq);
    return seq;
  }
  const session = {
    id: sessionId,
    header: { parentSession: null, delegationDepth: 0 },
    surface: {
      get nodes(): readonly number[] {
        return [...nodes];
      },
    },
    eventAt(seq: number): FakeSurfaceEvent | undefined {
      return events[seq];
    },
  };
  return {
    session,
    appendSystem(text: string): number {
      return append({
        type: "system/message",
        data: { role: "system", content: textBlock(text) },
      });
    },
    appendToolResult(text: string): number {
      return append({
        type: "tool/result",
        data: { role: "tool", content: textBlock(text) },
      });
    },
    appendProducerUserMessage(text: string): number {
      return append({
        type: "user/message",
        data: {
          role: "user",
          source: { kind: WAKE_SOURCE_KIND },
          content: textBlock(text),
        },
      });
    },
    compact(summary: string): void {
      const systemSeqs = nodes.filter(
        (seq) => events[seq]?.type === "system/message",
      );
      const checkpointSeq = append({
        type: "user/message",
        data: {
          role: "user",
          source: { kind: "plugin:compaction-basic" },
          content: textBlock(summary),
        },
      });
      // Host compaction keeps the system head and replaces everything else
      // with the summary checkpoint.
      nodes.splice(0, nodes.length, ...systemSeqs, checkpointSeq);
    },
    pruneToolResult(seq: number, replacementText: string): void {
      const at = nodes.indexOf(seq);
      if (at >= 0) nodes.splice(at, 1);
      append({
        type: "tool/result",
        data: { role: "tool", content: textBlock(replacementText) },
      });
    },
    nodes(): readonly number[] {
      return [...nodes];
    },
  };
}

function createAgent(
  sessionId: string,
  withInject = true,
  surface?: FakeSurface,
  commitInjects = true,
): CaptureAgent {
  const injected: unknown[] = [];
  const followed: unknown[] = [];
  const agent: CaptureAgent = {
    session:
      surface?.session ??
      { id: sessionId, header: { parentSession: null, delegationDepth: 0 } },
    injected,
    followed,
    followup(message: unknown) {
      followed.push(message);
    },
    ...(withInject
      ? {
          inject(message: unknown) {
            injected.push(message);
            // The host loop commits an injected user message at the next
            // step; the fake commits synchronously so a probe can be proven
            // to see its own inject on the next turn.
            if (commitInjects) surface?.appendProducerUserMessage(textOf(message));
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
  listeners: Map<string, Array<(...args: never[]) => void>>;
  emit(name: string, ...payload: unknown[]): void;
} {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  return {
    listeners,
    emit(name: string, ...payload: unknown[]) {
      for (const cb of listeners.get(name) ?? []) {
        cb(...(payload as never[]));
      }
    },
    on(name: string, cb: (...args: never[]) => void) {
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


describe("dispatcher policy re-injection after host compaction (ticket 296)", () => {
  /** The exact bytes activation injects for a user-started dispatcher. */
  const USER_POLICY = assembleSessionPolicy(true, "user", 1, "en");

  function policyMessages(agent: CaptureAgent, policy: string): unknown[] {
    return agent.injected.filter((message) => textOf(message) === policy);
  }

  /**
   * Activate one dispatcher on a fake event-sourced session. The system head
   * is present before activation, exactly as the host assembles it.
   */
  function activateDispatcher(options?: {
    origin?: "user" | "spawned";
    generation?: number;
  }) {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      policyEnabled: true,
    });
    const surface = createFakeSurface("session-1");
    surface.appendSystem("You are the dsh agent.");
    const agent = createAgent("session-1", true, surface);
    const outcome = lifecycle.activate(agent, options);
    assert.deepEqual(outcome, { ok: true });
    return { ctx, host, multitask, lifecycle, surface, agent };
  }

  it("surface after compaction (system head + checkpoint, policy gone) gets exactly one inject, byte-identical", () => {
    const { ctx, surface, agent } = activateDispatcher();
    // A normal activation turn settles the queued-copy mark and commits the
    // policy, as it does live. Compaction comes later, in a session that has
    // already been running.
    ctx.emit("agent/status", { agent, status: "running" });
    ctx.emit("agent/status", { agent, status: "idle" });
    assert.equal(policyMessages(agent, USER_POLICY).length, 1);

    surface.compact("Summary of the earlier conversation.");
    assert.equal(
      surface.nodes().length,
      2,
      "the live surface is now the system head plus the checkpoint",
    );
    assert.equal(policyMessages(agent, USER_POLICY).length, 1);

    ctx.emit("agent/status", { agent, status: "running" });

    const injected = policyMessages(agent, USER_POLICY);
    assert.equal(injected.length, 2, "exactly one re-inject after compaction");
    assert.equal(textOf(injected.at(-1)), USER_POLICY);
    assert.equal(
      textOf(agent.injected.at(-2)),
      USER_POLICY,
      "the policy lands before the turn reminder",
    );
    assert.ok(
      textOf(agent.injected.at(-1)).includes("## Ledger"),
      "the reminder remains the newest tail",
    );
  });

  it("policy still on the surface: two consecutive turns inject zero policies", () => {
    const { ctx, agent } = activateDispatcher();
    const afterActivation = agent.injected.length;

    ctx.emit("agent/status", { agent, status: "running" });
    ctx.emit("agent/status", { agent, status: "running" });

    assert.equal(
      policyMessages(agent, USER_POLICY).length,
      1,
      "activation's copy is still present; no duplicate",
    );
    assert.equal(
      agent.injected.length,
      afterActivation + 2,
      "each turn still gets its reminder",
    );
  });

  it("two consecutive turns after compaction inject exactly one policy in total", () => {
    const { ctx, surface, agent } = activateDispatcher();
    ctx.emit("agent/status", { agent, status: "running" });
    ctx.emit("agent/status", { agent, status: "idle" });
    surface.compact("Summary of the earlier conversation.");

    ctx.emit("agent/status", { agent, status: "running" });
    ctx.emit("agent/status", { agent, status: "running" });

    assert.equal(
      policyMessages(agent, USER_POLICY).length,
      2,
      "one activation inject plus exactly one post-compaction re-inject, on the first turn back",
    );
  });

  it("a spawned-origin session re-injects the spawned wording with its stored generation", () => {
    const spawnedPolicy = assembleSessionPolicy(true, "spawned", 3, "en");
    assert.notEqual(spawnedPolicy, USER_POLICY);
    const { ctx, surface, agent } = activateDispatcher({
      origin: "spawned",
      generation: 3,
    });
    assert.equal(policyMessages(agent, spawnedPolicy).length, 1);
    ctx.emit("agent/status", { agent, status: "running" });
    ctx.emit("agent/status", { agent, status: "idle" });

    surface.compact("Summary of the earlier conversation.");
    ctx.emit("agent/status", { agent, status: "running" });

    const injected = policyMessages(agent, spawnedPolicy);
    assert.equal(injected.length, 2);
    assert.equal(
      textOf(injected.at(-1)),
      spawnedPolicy,
      'byte-identical to assembleSessionPolicy(true, "spawned", 3, policyLanguage)',
    );
    assert.equal(policyMessages(agent, USER_POLICY).length, 0);
  });

  it("a worker session receives no policy on agent/status or on compaction/end", () => {
    const { ctx } = activateDispatcher();
    const workerSurface = createFakeSurface("worker-1");
    workerSurface.appendSystem("worker contract");
    const worker = createAgent("worker-1", true, workerSurface);

    ctx.emit("agent/status", { agent: worker, status: "running" });
    ctx.emit("session/event", worker.session, { type: "compaction/end" });

    assert.equal(worker.injected.length, 0);
    assert.equal(worker.followed.length, 0);
  });

  it("a microcompact prune of a tool result keeps the policy node: zero injects", () => {
    const { ctx, surface, agent } = activateDispatcher();
    const toolSeq = surface.appendToolResult("a long tool result");
    // Microcompact shadows the tool result and appends its cleared replacement.
    surface.pruneToolResult(toolSeq, "[tool result cleared]");
    assert.equal(policyMessages(agent, USER_POLICY).length, 1);

    ctx.emit("agent/status", { agent, status: "running" });

    assert.equal(
      policyMessages(agent, USER_POLICY).length,
      1,
      "the policy node survived the prune; nothing to re-inject",
    );
  });

  it("an activation inject still queued when the first turn starts is not duplicated", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      policyEnabled: true,
    });
    const surface = createFakeSurface("session-1");
    surface.appendSystem("You are the dsh agent.");
    // Activation queues the copy; the host loop has not committed it yet.
    const agent = createAgent("session-1", true, surface, false);
    lifecycle.activate(agent);
    assert.equal(policyMessages(agent, USER_POLICY).length, 1);

    // The running edge precedes the step's inbox drain, so the probe cannot
    // see the queued copy yet. It must NOT queue a second one.
    ctx.emit("agent/status", { agent, status: "running" });
    assert.equal(policyMessages(agent, USER_POLICY).length, 1);

    // The step drains the queue; the turn closes and the next turn sees it.
    surface.appendProducerUserMessage(USER_POLICY);
    ctx.emit("agent/status", { agent, status: "idle" });
    ctx.emit("agent/status", { agent, status: "running" });
    assert.equal(policyMessages(agent, USER_POLICY).length, 1);
  });

  it("compaction/end re-injects promptly for a bound dispatcher and only once", () => {
    const { ctx, surface, agent } = activateDispatcher();
    ctx.emit("agent/status", { agent, status: "running" });
    ctx.emit("agent/status", { agent, status: "idle" });
    surface.compact("Summary of the earlier conversation.");
    assert.equal(policyMessages(agent, USER_POLICY).length, 1);

    ctx.emit("session/event", agent.session, { type: "compaction/end" });

    const injected = policyMessages(agent, USER_POLICY);
    assert.equal(injected.length, 2, "the boundary re-injects inside the turn");
    assert.equal(textOf(injected.at(-1)), USER_POLICY);

    // The committed copy is on the surface now; a second boundary in the same
    // turn must not queue another.
    ctx.emit("session/event", agent.session, { type: "compaction/end" });
    assert.equal(policyMessages(agent, USER_POLICY).length, 2);
  });

  it("compaction/end with the policy still present injects nothing", () => {
    const { ctx, agent } = activateDispatcher();
    ctx.emit("session/event", agent.session, { type: "compaction/end" });
    assert.equal(policyMessages(agent, USER_POLICY).length, 1);
  });
});
