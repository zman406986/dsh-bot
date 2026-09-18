import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMultitask } from "../src/core/multitask.js";
import {
  bindDispatcherLifecycle,
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
      async startContinuable() {
        return { childId: "child-stub" };
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
  fireSettled(event: unknown): void;
} {
  const bound: Array<{ agent: AgentLike; sessionId: string }> = [];
  const wakeups: string[] = [];
  let parent: AgentLike | null = null;
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
    bindParent(agent: AgentLike, sessionId: string): void {
      bound.push({ agent, sessionId });
      parent = agent;
    },
    unbindParent(): void {
      bound.length = 0;
      parent = null;
    },
    hasParent(): boolean {
      return parent !== null;
    },
    get parentAgent(): AgentLike | null {
      return parent;
    },
    listLiveJobs: () => [],
    markers: undefined,
    workerIdOf: () => undefined,
    owns: () => false,
    emitStepBoundary(): void {},
    dispose(): void {},
  };
  return host as unknown as CordisDshHost & {
    bound: Array<{ agent: AgentLike; sessionId: string }>;
    wakeups: string[];
    fireSettled(event: unknown): void;
  };
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

describe("dispatcher activation lifecycle (ticket 19)", () => {
  it("dormant lifecycle captures nothing on simulated session-start", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      policyEnabled: true,
    });
    const agent = createAgent("session-1");

    ctx.emit("agent/session-start", { agent });

    // Stock dsh: no capture, no bind, no policy inject.
    assert.equal(lifecycle.dispatcherSessionId(), null);
    assert.equal(host.hasParent(), false);
    assert.equal(agent.injected.length, 0);
  });

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
    assert.ok(text.includes("not the workhorse"));
  });

  it("refuses activation for a non-top-level chat", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);
    const child = createChildAgent("child-1");

    const outcome = lifecycle.activate(child);

    assert.deepEqual(outcome, { ok: false, reason: "not-top-level" });
    assert.equal(lifecycle.dispatcherSessionId(), null);
    assert.equal(host.hasParent(), false);
    assert.equal(child.injected.length, 0);
  });

  it("refuses a second activation in the same chat without re-binding", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);
    const agent = createAgent("session-1");

    assert.deepEqual(lifecycle.activate(agent), { ok: true });
    const outcome = lifecycle.activate(agent);

    assert.deepEqual(outcome, { ok: false, reason: "already-active-here" });
    assert.equal(host.bound.length, 1);
    assert.equal(agent.injected.length, 1);
  });

  it("refuses activation while another chat holds the dispatcher slot", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);
    const first = createAgent("session-1");
    const second = createAgent("session-2");

    assert.deepEqual(lifecycle.activate(first), { ok: true });
    const outcome = lifecycle.activate(second);

    assert.deepEqual(outcome, { ok: false, reason: "already-active-elsewhere" });
    assert.equal(lifecycle.dispatcherSessionId(), "session-1");
    assert.equal(host.bound.length, 1);
    assert.equal(second.injected.length, 0);
  });

  it("activation with policy disabled binds but does not inject", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      policyEnabled: false,
    });
    const agent = createAgent("session-1");

    assert.deepEqual(lifecycle.activate(agent), { ok: true });
    assert.equal(host.hasParent(), true);
    assert.equal(agent.injected.length, 0);
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

  it("agent/disposed for another agent leaves the activation intact", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);
    const agent = createAgent("session-1");

    lifecycle.activate(agent);
    ctx.emit("agent/disposed", { agent: createAgent("session-2") });

    assert.equal(lifecycle.dispatcherSessionId(), "session-1");
    assert.equal(host.hasParent(), true);
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

  it("skips inject when the agent has no inject method", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      policyEnabled: true,
    });
    const agent = createAgent("session-1", false);

    assert.doesNotThrow(() => {
      assert.deepEqual(lifecycle.activate(agent), { ok: true });
      ctx.emit("agent/status", { agent, status: "running" });
    });
  });

  it("unbind reverses the activation and detaches listeners (HMR)", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    let deactivated = 0;
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      onDeactivated: () => {
        deactivated += 1;
      },
    });
    const agent = createAgent("session-1");

    lifecycle.activate(agent);
    lifecycle.unbind();

    assert.equal(lifecycle.dispatcherSessionId(), null);
    assert.equal(host.hasParent(), false);
    assert.equal(deactivated, 1);
    // Listeners are gone: a later session-start captures nothing.
    ctx.emit("agent/session-start", { agent });
    ctx.emit("agent/status", { agent, status: "running" });
    assert.equal(agent.injected.length, 1);
  });
});
