/**
 * Ticket 118 chunk 1 — the HOST-SIDE dispatcher spawn path only.
 * Offline: a structural `AdapterContext` stub, no live dsh, no LLM.
 *
 * What this file pins (and what it deliberately does not test, because
 * chunks 2/3 own it): the spawn request shape, the `maxDepth` derivation,
 * and the fact that a spawned dispatcher is NOT routed through the worker
 * composition/registry path. The activation path (`activateSpawnedDispatcher`,
 * scoped tool registration, policy injection, lifecycle insertion) is chunk 3.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCordisDshHost,
  SPAWN_PROVIDER,
  type ActivationLike,
  type ActivationSpecLike,
  type AdapterContext,
  type AgentLike,
} from "../src/adapter/cordis-dsh-host.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import {
  createWorkerAgentDef,
  dispatcherSpawnMaxDepth,
  workerSpawnMaxDepth,
} from "../src/worker/agent-def.js";
import { WORKER_PERSONA_SECTION } from "../src/worker/preset.js";

interface ComposedChild {
  readonly childId: string;
  readonly sections: string[];
  readonly restrictions: unknown[];
}

function createAgent(id: string, delegationDepth = 0): AgentLike {
  return {
    session: {
      id,
      header:
        delegationDepth === 0
          ? { parentSession: undefined, delegationDepth: 0 }
          : { parentSession: "parent-x", delegationDepth },
    },
    followup() {},
  };
}

/**
 * Structural ctx stub. `startActivation` announces the child on
 * `agent/created` exactly like the host does (the child's header carries the
 * parent's id and depth + 1), which is the seam the worker composition
 * listens on — so "the dispatcher child got no composition" is observable.
 */
function createStubCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const startActivationCalls: ActivationSpecLike[] = [];
  const composedChildren: ComposedChild[] = [];
  const state: { failNextWith: unknown } = { failNextWith: undefined };
  let nextChild = 1;

  const ctx: AdapterContext & {
    fire(name: string, payload: unknown): void;
    startActivationCalls: ActivationSpecLike[];
    composedChildren: ComposedChild[];
    failNextActivationWith(error: unknown): void;
  } = {
    startActivationCalls,
    composedChildren,
    failNextActivationWith(error: unknown) {
      state.failNextWith = error;
    },
    fire(name: string, payload: unknown) {
      for (const cb of [...(listeners.get(name) ?? [])]) {
        (cb as (arg: unknown) => void)(payload);
      }
    },
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((entry) => entry !== cb),
        );
      };
    },
    subagents: {
      async startActivation(spec: ActivationSpecLike): Promise<ActivationLike> {
        startActivationCalls.push(spec);
        if (state.failNextWith !== undefined) {
          const failure = state.failNextWith;
          state.failNextWith = undefined;
          throw failure;
        }
        const childId = `child-${nextChild++}`;
        const composed: ComposedChild = {
          childId,
          sections: [],
          restrictions: [],
        };
        composedChildren.push(composed);
        const childCtx = {
          systemPrompt: {
            section(section: { name: string }) {
              composed.sections.push(section.name);
              return () => {};
            },
            getSectionOrder() {
              return 0;
            },
          },
          tools: {
            schemas() {
              return [{ name: "spawn_worker" }, { name: "todo_write" }];
            },
            restrict(filter: unknown) {
              composed.restrictions.push(filter);
              return () => {};
            },
          },
        };
        const parentDepth =
          spec.request.parent.session.header?.delegationDepth ?? 0;
        ctx.fire("agent/created", {
          agent: {
            session: {
              id: childId,
              header: {
                parentSession: String(spec.request.parent.session.id),
                delegationDepth: parentDepth + 1,
              },
            },
            ctx: childCtx,
          },
          source: "startup",
        });
        return {
          childId,
          messageId: `msg-${childId}`,
          dispose: async () => {},
        };
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

  return ctx;
}

/**
 * The host's acceptance rule, replicated offline from the installed
 * dsh-subagent lib (READ-ONLY reference): `childDepth = parentDepth + 1`,
 * refused when `childDepth > maxDepth`. This is the wall ADR-0025 leans on;
 * our helper must satisfy it at BOTH hops (the child, then its workers).
 */
function hostAccepts(parentDepth: number, maxDepth: number): boolean {
  return parentDepth + 1 <= maxDepth;
}

describe("ticket 118: dispatcherSpawnMaxDepth", () => {
  it("returns parentDepth + 2", () => {
    assert.equal(dispatcherSpawnMaxDepth(0), 2);
    assert.equal(dispatcherSpawnMaxDepth(1), 3);
    assert.equal(dispatcherSpawnMaxDepth(4), 6);
  });

  it("is exactly one hop above the worker idiom: the child dispatcher keeps its worker hop", () => {
    assert.equal(
      dispatcherSpawnMaxDepth(0),
      workerSpawnMaxDepth(0) + 1,
    );
    // +1 would accept the child (depth 1 <= 1) and then refuse every worker
    // it spawns (depth 2 > 1). +2 accepts both hops.
    const childCeiling = dispatcherSpawnMaxDepth(0);
    assert.equal(hostAccepts(0, childCeiling), true);
    const childDepth = 0 + 1;
    assert.equal(hostAccepts(childDepth, childCeiling), true);
    assert.equal(hostAccepts(0, workerSpawnMaxDepth(0)), true);
    assert.equal(hostAccepts(childDepth, workerSpawnMaxDepth(0)), false);
  });
});

describe("ticket 118: host spawnDispatcher", () => {
  it("spawns with provider spawn, label = title, parent delivery, no agentPreset, maxDepth = parentDepth + 2", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon a peer",
      prompt: "Own the login bug and report the outcome.",
    });

    assert.equal(result.dispatcherId, "child-1");
    assert.equal(ctx.startActivationCalls.length, 1);
    const spec = ctx.startActivationCalls[0] as ActivationSpecLike;
    assert.equal(spec.provider, SPAWN_PROVIDER);
    assert.equal(spec.provider, "spawn");
    assert.equal(spec.label, "Summon a peer");
    assert.equal(spec.delivery, "parent");
    // Mitosis: the child joins the parent's composition. `ActivationSpecLike`
    // has no such slot, and nothing invents one.
    assert.equal("agentPreset" in spec, false);
    assert.equal("agentPreset" in spec.request, false);
    // Prompt rides as one text block on the child's first turn.
    assert.equal(spec.request.prompt.length, 1);
    assert.equal(spec.request.prompt[0]?.type, "text");
    assert.equal(
      (spec.request.prompt[0] as { text: string }).text,
      "Own the login bug and report the outcome.",
    );
    // Depth-0 parent → absolute ceiling 2 (child hop + its worker hop).
    assert.equal(spec.request.maxDepth, 2);
    assert.ok(spec.signal instanceof AbortSignal);
    assert.equal("signal" in spec.request, false);
  });

  it("derives the ceiling from THAT parent's depth: a depth-1 parent spawns at +2 = 3", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-deep", 1), "disp-deep");

    await host.spawnDispatcher({
      parentSessionId: "disp-deep",
      title: "Nested peer",
      prompt: "Take the second half.",
    });

    const spec = ctx.startActivationCalls[0] as ActivationSpecLike;
    assert.equal(spec.request.maxDepth, 3);
    // Both hops admitted at the host: this child at depth 2, its workers at 3.
    assert.equal(hostAccepts(1, spec.request.maxDepth as number), true);
    assert.equal(hostAccepts(2, spec.request.maxDepth as number), true);
    assert.equal(hostAccepts(3, spec.request.maxDepth as number), false);
  });

  it("does not route the child through the worker path: no composition, no worker registry entry", async () => {
    const ctx = createStubCtx();
    // A worker def is supplied on purpose: if the dispatcher spawn bumped
    // `pendingSpawns`, the agent/created listener WOULD compose the child.
    const host = createCordisDshHost(ctx, {
      workerAgentDef: createWorkerAgentDef(),
    });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    // The child was announced, but received NO worker persona and NO barrier.
    assert.equal(ctx.composedChildren.length, 1);
    const composed = ctx.composedChildren[0] as ComposedChild;
    assert.equal(composed.childId, result.dispatcherId);
    assert.deepEqual(composed.sections, []);
    assert.deepEqual(composed.restrictions, []);
    assert.ok(!composed.sections.includes(WORKER_PERSONA_SECTION));

    // Not an owned worker: no roster entry, no worker id, no interrupt target.
    assert.equal(host.owns(result.dispatcherId), false);
    assert.equal(host.workerIdOf(result.dispatcherId), undefined);

    // The counter is untouched in the other direction too: a worker spawned
    // afterwards is composed exactly once, as a worker.
    const workerId = await host.spawnWorker("Do the thing.", {
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "Thing",
    });
    assert.equal(ctx.composedChildren.length, 2);
    const workerComposition = ctx.composedChildren[1] as ComposedChild;
    assert.equal(workerComposition.childId, workerId);
    assert.deepEqual(workerComposition.sections, [WORKER_PERSONA_SECTION]);
    assert.equal(host.owns(workerId), true);
  });

  it("throws when the parent session is unbound (same rule as spawnWorker)", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "not-bound",
        title: "Peer",
        prompt: "Handle it.",
      }),
      /no parent agent bound for session not-bound/,
    );
    assert.equal(ctx.startActivationCalls.length, 0);
  });

  it("propagates a host rejection unchanged (ACTIVATION_LIMIT_REACHED from the 8-slot pool)", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");
    const hostRefusal = new Error("ACTIVATION_LIMIT_REACHED");
    ctx.failNextActivationWith(hostRefusal);

    const caught = await host
      .spawnDispatcher({
        parentSessionId: "disp-1",
        title: "Peer",
        prompt: "Handle it.",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Same object: no re-wrap, no invented refusal class, no cap of ours.
    assert.equal(caught, hostRefusal);
  });

  it("uses a caller-supplied signal when given one", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");
    const controller = new AbortController();

    await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
      signal: controller.signal,
    });

    const spec = ctx.startActivationCalls[0] as ActivationSpecLike;
    assert.equal(spec.signal, controller.signal);
  });
});

describe("ticket 118: FakeDshHost dispatcher spawn", () => {
  it("records dispatcher spawns separately and never as workers", async () => {
    const host = new FakeDshHost();

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });
    const workerId = await host.spawnWorker("Work.", {
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "Thing",
    });

    assert.equal(result.dispatcherId, "fake-dispatcher-1");
    assert.equal(host.dispatcherSpawnCalls.length, 1);
    assert.equal(host.dispatcherSpawnCalls[0]?.opts.title, "Peer");
    // The worker id sequence is untouched by dispatcher spawns, so existing
    // `fake-worker-N` assertions elsewhere stay stable.
    assert.equal(workerId, "fake-worker-1");
    assert.equal(host.spawnCalls.length, 1);
  });
});
