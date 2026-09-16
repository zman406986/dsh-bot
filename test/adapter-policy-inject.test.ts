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
} {
  const bound: Array<{ agent: AgentLike; sessionId: string }> = [];
  let parent: AgentLike | null = null;
  const settledCallbacks: Array<(event: never) => void> = [];
  const stepCallbacks: Array<(workerId: string) => void | Promise<void>> = [];

  const host = {
    bound,
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
    async requestDispatcherWakeup(): Promise<void> {},
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
  };
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

describe("dispatcher policy inject (T11)", () => {
  it("injects the session policy once at bind when enabled", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
      policyEnabled: true,
    });
    const agent = createAgent("session-1");

    ctx.emit("agent/session-start", { agent });

    assert.equal(lifecycle.dispatcherSessionId(), "session-1");
    assert.equal(agent.injected.length, 1);
    const text = textOf(agent.injected[0]);
    assert.ok(text.includes("# Multitask dispatcher"));
    assert.ok(text.includes("not the workhorse"));
  });

  it("does not inject policy when the session flag is OFF", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    bindDispatcherLifecycle(ctx, host, multitask, { policyEnabled: false });
    const agent = createAgent("session-1");

    ctx.emit("agent/session-start", { agent });
    assert.equal(agent.injected.length, 0);
  });

  it("re-injects the per-turn reminder on dispatcher turn start", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    bindDispatcherLifecycle(ctx, host, multitask, { policyEnabled: true });
    const agent = createAgent("session-1");

    ctx.emit("agent/session-start", { agent });
    ctx.emit("agent/status", { agent, status: "running" });

    assert.equal(agent.injected.length, 2);
    const reminder = textOf(agent.injected[1]);
    assert.ok(reminder.includes("## Ledger"));
    assert.ok(reminder.includes("## Standing rules"));
    assert.ok(reminder.includes("(empty)"));
  });

  it("skips inject when the agent has no inject method", () => {
    const ctx = createCtx();
    const host = createHostStub();
    const multitask = createMultitask(host);
    bindDispatcherLifecycle(ctx, host, multitask, { policyEnabled: true });
    const agent = createAgent("session-1", false);

    assert.doesNotThrow(() => {
      ctx.emit("agent/session-start", { agent });
      ctx.emit("agent/status", { agent, status: "running" });
    });
  });
});
