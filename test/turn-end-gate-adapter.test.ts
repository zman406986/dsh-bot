/**
 * Turn-end redrive gate — auto-continue fix, design note Decision 4 (adapter
 * half) + review Required Change 3.
 *
 * ONE focused behavior: the agent/status idle edge runs redriveUndelivered
 * only when a turn actually ran (wakeBus.isBusy is still true at the idle
 * edge, before noteTurnEnded). isBusy is ORIGIN-BLIND — every running edge
 * sets it, auto-redrive turns included — so the gate skips exactly the
 * initial idle at activation (no running edge) and a cancelled turn
 * (cancelTurn cleared busy). The live-loop bound is the durable budget
 * (core lane, test/turn-end-redrive.test.ts), not this gate.
 *
 * Real bindDispatcherLifecycle + real core wakeBus over a structural stub
 * ctx (pattern: test/dispatcher-parent-accessor.test.ts) — S8 offline, no
 * dsh-scope, no network/LLM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCordisDshHost,
  type ActivationLike,
  type ActivationSpecLike,
  type AdapterContext,
  type AgentHandleLike,
  type AgentLike,
} from "../src/adapter/cordis-dsh-host.js";
import { bindDispatcherLifecycle } from "../src/adapter/parent-agent.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";

const SESSION = "session-1";

/** The AdapterContext parts the lifecycle touches: event bus + required services. */
function createGateStubCtx(): {
  ctx: AdapterContext;
  fire: (name: string, payload: unknown) => void;
} {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const ctx = {
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb as (payload: unknown) => void);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((entry) => entry !== cb),
        );
      };
    },
    subagents: {
      async startActivation(_spec: ActivationSpecLike): Promise<ActivationLike> {
        throw new Error("this test never spawns through the adapter");
      },
      interrupt() {},
      async sendMessage() {
        return "stub-message";
      },
    },
    agents: {
      get: () => undefined,
      async create(): Promise<AgentHandleLike> {
        throw new Error("this test never creates agents");
      },
    },
    jobs: { list: () => [] },
    storageDomain: {},
  };
  return {
    ctx: ctx as unknown as AdapterContext,
    fire(name, payload) {
      for (const cb of listeners.get(name) ?? []) cb(payload);
    },
  };
}

describe("turn-end redrive gate — Decision 4 (auto-continue fix)", () => {
  it("idle edge redrives only when a turn actually ran; initial-idle and cancelled edges skip", () => {
    const stub = createGateStubCtx();
    const adapter = createCordisDshHost(stub.ctx);
    const core = createMultitask(new FakeDshHost());
    // Count the adapter's decision; the core redrive semantics themselves
    // are owned by test/turn-end-redrive.test.ts.
    const redriveCalls: string[] = [];
    const multitask = {
      ...core,
      redriveUndelivered(sessionId: string) {
        redriveCalls.push(sessionId);
        return core.redriveUndelivered(sessionId);
      },
    };
    const lifecycle = bindDispatcherLifecycle(stub.ctx, adapter, multitask);
    const agent: AgentLike = {
      session: {
        id: SESSION,
        header: { delegationDepth: 0, cwd: "C:\\work" },
      },
      followup() {},
    };
    assert.deepEqual(lifecycle.activate(agent), { ok: true });

    // Initial idle at activation: no running edge ever fired → no redrive.
    stub.fire("agent/status", { agent, status: "idle" });
    assert.deepEqual(redriveCalls, [], "mere open/resume must not redrive");

    // A turn actually ran (any origin — the gate is origin-blind): the idle
    // edge redrives BEFORE noteTurnEnded clears busy.
    stub.fire("agent/status", { agent, status: "running" });
    stub.fire("agent/status", { agent, status: "idle" });
    assert.deepEqual(redriveCalls, [SESSION], "a turn that ran redrives once at its idle edge");

    // Cancelled turn: cancelTurn cleared busy → the idle edge skips the pass.
    stub.fire("agent/status", { agent, status: "running" });
    core.wakeBus.cancelTurn(SESSION);
    stub.fire("agent/status", { agent, status: "idle" });
    assert.deepEqual(redriveCalls, [SESSION], "a cancelled turn adds no redrive pass");

    lifecycle.unbind();
    adapter.dispose();
    core.dispose();
  });
});
