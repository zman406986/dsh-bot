/**
 * Ticket 118 / ticket 157 / ADR-0032 — the HOST-SIDE dispatcher spawn path.
 * Offline: a structural `AdapterContext` stub, no live dsh, no LLM.
 *
 * What this file pins: the spawn shape, the `cwd` handoff, the first-turn
 * delivery through `followup`, the absence of every subagent field, and the
 * fact that a summoned dispatcher is NOT routed through the worker
 * composition/registry path. The activation body (scoped tools, policy,
 * lifecycle) is the plugin's step and is not tested here.
 *
 * ADR-0032 changed the mechanism: a summoned dispatcher is a NEW TOP-LEVEL
 * SESSION parallel to its summoner (`ctx.agents.create` + `agent.followup`),
 * not a subagent child (`ctx.subagents.startActivation`). The stub therefore
 * models BOTH seams — `agents.create` for the peer, `startActivation` for a
 * worker — so the contrast stays observable in one file.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCordisDshHost,
  SPAWN_PROVIDER,
  type ActivationLike,
  type ActivationSpecLike,
  type AdapterContext,
  type AgentHandleLike,
  type AgentLike,
  type AgentOptionsLike,
  type CreateAgentOptionsLike,
} from "../src/adapter/cordis-dsh-host.js";
import { WAKE_SOURCE_KIND } from "../src/adapter/wake-copy.js";
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createAgent(
  id: string,
  delegationDepth = 0,
  header: { cwd?: string } = {},
  options?: AgentOptionsLike,
): AgentLike {
  return {
    session: {
      id,
      header: {
        ...(delegationDepth === 0
          ? { parentSession: undefined, delegationDepth: 0 }
          : { parentSession: "parent-x", delegationDepth }),
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      },
    },
    ...(options === undefined ? {} : { options }),
    followup() {},
  };
}

/**
 * Structural ctx stub.
 *
 * `agents.create` is the dispatcher seam (ADR-0032). It honours `sessionId`,
 * awaits `setup` before publication (so composition lands before
 * `agent/created` and the first prompt), announces a TOP-LEVEL session — no
 * `parentSession`, no `delegationDepth`, `cwd` only — and returns a handle
 * whose `agent.followup` is recorded, so "the first turn was delivered" is
 * observable.
 *
 * `subagents.startActivation` is kept for the worker seam: it announces the
 * child with the parent's id and depth + 1, exactly like the host, which is
 * the seam the worker composition listens on.
 */
function createStubCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const startActivationCalls: ActivationSpecLike[] = [];
  const createCalls: CreateAgentOptionsLike[] = [];
  const followupCalls: Array<{ sessionId: string; message: unknown }> = [];
  const announcedHeaders: Array<{
    childId: string;
    header: Record<string, unknown>;
  }> = [];
  const composedChildren: ComposedChild[] = [];
  const events: string[] = [];
  const state: { failNextWith: unknown } = { failNextWith: undefined };
  let nextChild = 1;

  /** The child's OWN scope: the only place composition can land. */
  function childScope(childId: string) {
    const composed: ComposedChild = {
      childId,
      sections: [],
      restrictions: [],
    };
    composedChildren.push(composed);
    return {
      composed,
      scopeCtx: {
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
      },
    };
  }

  const ctx: AdapterContext & {
    fire(name: string, payload: unknown): void;
    startActivationCalls: ActivationSpecLike[];
    createCalls: CreateAgentOptionsLike[];
    followupCalls: Array<{ sessionId: string; message: unknown }>;
    announcedHeaders: Array<{ childId: string; header: Record<string, unknown> }>;
    composedChildren: ComposedChild[];
    events: string[];
    failNextCreateWith(error: unknown): void;
  } = {
    startActivationCalls,
    createCalls,
    followupCalls,
    announcedHeaders,
    composedChildren,
    events,
    failNextCreateWith(error: unknown) {
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
        const { scopeCtx } = childScope(childId);
        const parentDepth =
          spec.request.parent.session.header?.delegationDepth ?? 0;
        const header = {
          parentSession: String(spec.request.parent.session.id),
          delegationDepth: parentDepth + 1,
        };
        announcedHeaders.push({ childId, header });
        ctx.fire("agent/created", {
          agent: { session: { id: childId, header }, ctx: scopeCtx },
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
    agents: {
      get: () => undefined,
      async create(options: CreateAgentOptionsLike): Promise<AgentHandleLike> {
        createCalls.push(options);
        events.push("create");
        if (state.failNextWith !== undefined) {
          const failure = state.failNextWith;
          state.failNextWith = undefined;
          throw failure;
        }
        // The created session keeps the id the caller reserved, and its header
        // is a TOP-LEVEL one: `cwd` and nothing else.
        const childId = String(options.sessionId);
        const header: Record<string, unknown> = {};
        if (options.meta?.cwd !== undefined) header.cwd = options.meta.cwd;
        const agent: AgentLike = {
          session: { id: childId, header },
          ...(options.agentOptions === undefined
            ? {}
            : { options: options.agentOptions }),
          followup(message: unknown) {
            followupCalls.push({ sessionId: childId, message });
            events.push("followup");
          },
        };
        const { scopeCtx } = childScope(childId);
        announcedHeaders.push({ childId, header });
        events.push("setup");
        // `setup` is AWAITED before publication (ADR-0032): everything it
        // registers exists before `agent/created` and the first prompt.
        await options.setup?.(scopeCtx, agent);
        events.push("published");
        ctx.fire("agent/created", {
          agent: { session: { id: childId, header }, ctx: scopeCtx },
          source: "startup",
        });
        return { agent, dispose: async () => {} };
      },
    },
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
 * The subagent host's acceptance rule, replicated offline from the installed
 * dsh-subagent lib (READ-ONLY reference): `childDepth = parentDepth + 1`,
 * refused when `childDepth > maxDepth`.
 *
 * ADR-0032 note: the dispatcher spawn no longer sends `maxDepth` — a top-level
 * session has no delegation depth and the 8-slot root pool does not bound it —
 * so this rule now describes the WORKER hop only. `dispatcherSpawnMaxDepth`
 * stays exported and is still checked below; its numbers are simply no longer
 * on the dispatcher spawn path.
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
    assert.equal(dispatcherSpawnMaxDepth(0), workerSpawnMaxDepth(0) + 1);
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

describe("ADR-0032: host spawnDispatcher creates a parallel top-level session", () => {
  it("creates with the reserved id, passes cwd and no parent/origin/depth, and delivers the prompt through followup", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(
      createAgent("disp-1", 0, { cwd: "C:\\work\\project" }),
      "disp-1",
    );

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon a peer",
      prompt: "Own the login bug and report the outcome.",
    });

    // The subagent runtime is not involved at all any more.
    assert.equal(ctx.startActivationCalls.length, 0);
    assert.equal(ctx.createCalls.length, 1);
    const options = ctx.createCalls[0] as CreateAgentOptionsLike;

    // The id is RESERVED before the create and handed over as the session id,
    // so the host either creates that exact session or refuses.
    const reservedId = String(options.sessionId);
    assert.match(reservedId, UUID_RE);
    assert.equal(result.dispatcherId, reservedId);

    // `cwd` is copied: the host's cross-session route refuses a session whose
    // header has none, so a peer without one would be unreachable after a
    // restart.
    assert.deepEqual(options.meta, { cwd: "C:\\work\\project" });

    // THE POINT OF THE CHANGE. The host's ownership guard is an OR, so these
    // must stay absent TOGETHER — any one of them silently re-classifies the
    // session and every ordinary route then answers `session/agent-busy`.
    const meta = (options.meta ?? {}) as Record<string, unknown>;
    assert.equal("parentSession" in meta, false);
    assert.equal("origin" in meta, false);
    assert.equal("delegationDepth" in meta, false);
    assert.equal("parentAgent" in options, false);
    // …and the whole subagent request shape went with them: no parent agent,
    // no parent delivery, no depth ceiling, no spawn provider, no label.
    assert.equal("request" in options, false);
    assert.equal("delivery" in options, false);
    assert.equal("maxDepth" in options, false);
    assert.equal("label" in options, false);
    assert.equal("provider" in options, false);
    // Mitosis: the child becomes a top-level session, so it inherits no
    // per-agent preset either — nothing invents such a slot.
    assert.equal("agentPreset" in options, false);
    // This summoner carries no route, so no AgentOptions is invented.
    assert.equal("agentOptions" in options, false);
    // The host mints its own pre-publication signal when the caller sends none.
    assert.ok(options.signal instanceof AbortSignal);

    // FIRST TURN: the whole prompt, delivered through `followup`. Creating a
    // session alone leaves it blank, and a blank session stays hidden until
    // its first turn lands.
    assert.equal(ctx.followupCalls.length, 1);
    const turn = ctx.followupCalls[0] as {
      sessionId: string;
      message: {
        id: string;
        role: string;
        content: Array<{ type: string; text?: string }>;
        source: { kind: string };
      };
    };
    assert.equal(turn.sessionId, reservedId);
    assert.match(turn.message.id, /^multitask-spawn-/);
    assert.equal(turn.message.role, "user");
    assert.equal(turn.message.content.length, 1);
    assert.equal(turn.message.content[0]?.type, "text");
    assert.equal(
      (turn.message.content[0] as { text: string }).text,
      "Own the login bug and report the outcome.",
    );
    // Producer-owned source kind: session format v4 rejects a plugin wrapper.
    assert.equal(turn.message.source.kind, WAKE_SOURCE_KIND);

    // `setup` lands before publication, and the first turn is only queued
    // after the create resolved — never from inside `setup`.
    assert.deepEqual(ctx.events, ["create", "setup", "published", "followup"]);
  });

  /**
   * ADR-0032: `setup` COMPOSES, never drives.
   *
   * `setup` is awaited before publication, so a turn it opened would start
   * before the child's own first turn and before its tool surface is wired.
   * The host therefore activates with `flushWake = false` inside `setup` and
   * discharges a parked wake only AFTER `create` resolves.
   *
   * Where the wake is parked: the child id is minted inside `spawnDispatcher`,
   * so no caller can name it before that call. The create seam is the earliest
   * moment it exists — parked there, before `setup` is awaited, which is
   * exactly the window this ordering protects. Parking only works because the
   * host seeds the durable-mark mirror with the reserved id BEFORE the create
   * (`openWakeTurn` parks marked-but-not-live ids and nothing else).
   *
   * KNOWN GAP (recorded, ticket 158): this test covers ONE of the two flush
   * sites — the explicit post-create flush. The stub's `agent/created` payload
   * is parentless (`cwd` only, ADR-0032), so it routes to
   * `resumeUserStartedDispatcher`, which returns early here because this host
   * was built without an `onUserDispatcherResumed` hook. A host that DOES have
   * the hook can therefore discharge the same parked wake from the listener
   * instead; that path is not exercised by an ordering test and would need its
   * own trace assertion to distinguish the two.
   */
  it("setup composes, never drives: a wake parked for the child flushes after create, never inside setup", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");

    const wakeOrigin = {
      kind: "agent-message",
      form: "relay",
      senderSessionId: "peer-9",
    } as const;
    /** Turns the child had received when `setup` returned (-1 = never ran). */
    let turnsInsideSetup = -1;
    const innerCreate = ctx.agents.create;
    if (innerCreate === undefined) {
      throw new Error("stub ctx exposes no agents.create");
    }
    ctx.agents.create = async (options) => {
      // Park the wake first, then run the stub's own create unchanged, with a
      // measurement wrapped around the host's `setup` callback.
      await host.requestDispatcherWakeup(String(options.sessionId), wakeOrigin);
      ctx.events.push("park");
      const innerSetup = options.setup;
      return innerCreate({
        ...options,
        setup: async (agentCtx, agent) => {
          await innerSetup?.(agentCtx, agent);
          turnsInsideSetup = ctx.followupCalls.length;
        },
      });
    };

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Wake ordering",
      prompt: "Own the wake ordering.",
    });

    type Recorded = {
      sessionId: string;
      message: {
        id: string;
        role: string;
        content: Array<{ type: string; text?: string }>;
        source: { kind: string; senderSessionId?: string };
      };
    };

    // (1) `setup` drives nothing: the parked wake was still parked when it
    // returned, so it cannot have opened a turn ahead of the first prompt.
    assert.equal(turnsInsideSetup, 0);
    // (2) The child's FIRST turn is the spawn prompt.
    assert.equal(ctx.followupCalls.length, 2);
    const first = ctx.followupCalls[0] as Recorded;
    assert.equal(first.sessionId, result.dispatcherId);
    assert.match(first.message.id, /^multitask-spawn-/);
    assert.equal(first.message.content[0]?.text, "Own the wake ordering.");
    // (3) The parked wake follows it, addressed to the same child and still
    // attributed to its peer sender.
    const second = ctx.followupCalls[1] as Recorded;
    assert.equal(second.sessionId, result.dispatcherId);
    assert.match(second.message.id, /^multitask-wake-/);
    assert.equal(second.message.source.kind, "agent-message");
    assert.equal(second.message.source.senderSessionId, "peer-9");
    // The trace, in order: no turn is driven before `published`. A flush moved
    // into `setup` would put a "followup" between "setup" and "published" —
    // and would make the wake, not the prompt, the child's first turn.
    assert.deepEqual(ctx.events, [
      "park",
      "create",
      "setup",
      "published",
      "followup",
      "followup",
    ]);
  });

  it("announces a top-level session: cwd only, so a depth-1 summoner produces a PEER, not a grandchild", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(
      createAgent("disp-deep", 1, { cwd: "C:\\work\\deep" }),
      "disp-deep",
    );

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-deep",
      title: "Nested peer",
      prompt: "Take the second half.",
    });

    const options = ctx.createCalls[0] as CreateAgentOptionsLike;
    // The summoner's own depth does not propagate: a top-level session has no
    // delegation depth, and there is no ceiling to send.
    assert.equal("maxDepth" in options, false);
    assert.deepEqual(Object.keys(options.meta ?? {}), ["cwd"]);
    assert.equal(String(options.sessionId), result.dispatcherId);

    // The announced session is top-level in its HEADER too — `cwd` and nothing
    // else, exactly like the host's own "new conversation".
    const announced = ctx.announcedHeaders[0] as {
      childId: string;
      header: Record<string, unknown>;
    };
    assert.equal(announced.childId, result.dispatcherId);
    assert.deepEqual(Object.keys(announced.header), ["cwd"]);
    assert.equal(announced.header.cwd, "C:\\work\\deep");
  });

  it("copies the summoner's provider/model route, and sends no agentOptions for a half route", async () => {
    // The subagent path inherited a route through `resolveChildAgentOptions`;
    // that edge is gone, so the summoner must supply one or the first turn
    // throws "no provider/model".
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(
      createAgent(
        "disp-1",
        0,
        {},
        { provider: "deepseek", model: "deepseek-chat" },
      ),
      "disp-1",
    );
    await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });
    assert.deepEqual(
      (ctx.createCalls[0] as CreateAgentOptionsLike).agentOptions,
      { provider: "deepseek", model: "deepseek-chat" },
    );

    // A half route is not a route: an empty AgentOptions must never be sent.
    const half = createStubCtx();
    const halfHost = createCordisDshHost(half);
    halfHost.bindParent(
      createAgent("disp-1", 0, {}, { provider: "deepseek" }),
      "disp-1",
    );
    await halfHost.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });
    assert.equal(
      "agentOptions" in (half.createCalls[0] as CreateAgentOptionsLike),
      false,
    );
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

    // The peer was announced, but received NO worker persona and NO barrier:
    // its own scope stayed empty.
    assert.equal(ctx.composedChildren.length, 1);
    const peer = ctx.composedChildren[0] as ComposedChild;
    assert.equal(peer.childId, result.dispatcherId);
    assert.ok(!peer.sections.includes(WORKER_PERSONA_SECTION));
    assert.deepEqual(peer.sections, []);
    assert.deepEqual(peer.restrictions, []);

    // Not an owned worker: no roster entry, no worker id.
    assert.equal(host.owns(result.dispatcherId), false);
    assert.equal(host.workerIdOf(result.dispatcherId), undefined);

    // The other direction: a worker spawned afterwards still goes through the
    // subagent runtime, is composed exactly once as a worker, and IS owned.
    const workerId = await host.spawnWorker("Do the thing.", {
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "Thing",
    });
    assert.equal(ctx.createCalls.length, 1);
    assert.equal(ctx.startActivationCalls.length, 1);
    assert.equal(ctx.composedChildren.length, 2);
    const workerComposition = ctx.composedChildren[1] as ComposedChild;
    assert.equal(workerComposition.childId, workerId);
    assert.deepEqual(workerComposition.sections, [WORKER_PERSONA_SECTION]);
    assert.equal(host.owns(workerId), true);

    // Which shape each hop used — the contrast this change is about. The
    // worker hop keeps every subagent field the dispatcher hop dropped.
    const workerSpec = ctx.startActivationCalls[0] as ActivationSpecLike;
    assert.equal(workerSpec.provider, SPAWN_PROVIDER);
    assert.equal(workerSpec.delivery, "parent");
    assert.equal(workerSpec.request.parent.session.id, "disp-1");
    assert.equal(typeof workerSpec.request.maxDepth, "number");
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
    assert.equal(ctx.createCalls.length, 0);
    assert.equal(ctx.startActivationCalls.length, 0);
  });

  it("propagates a create refusal unchanged: no re-wrap, no invented refusal class", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");
    const hostRefusal = new Error("session/agent-busy");
    ctx.failNextCreateWith(hostRefusal);

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
    // A refused create opens no turn.
    assert.equal(ctx.followupCalls.length, 0);
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

    const options = ctx.createCalls[0] as CreateAgentOptionsLike;
    assert.equal(options.signal, controller.signal);
  });
});

describe("ticket 130: host durable dispatcher mark", () => {
  /** Minimal in-memory DurabilityPort: the two seams this ticket adds. */
  function createMarkStore() {
    const marks = new Map<
      string,
      { sessionId: string; parentSessionId?: string; generation?: number }
    >();
    return {
      marks,
      writeWorkerMarker() {},
      readWorkerMarkers() {
        return [];
      },
      deleteWorkerMarker() {},
      writeDispatcherMark(mark: {
        sessionId: string;
        parentSessionId?: string;
        generation?: number;
      }) {
        marks.set(mark.sessionId, mark);
      },
      readDispatcherMark(sessionId: string) {
        return marks.get(sessionId);
      },
    };
  }

  it("writes the child's mark after the create resolves, keyed by the session id", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    assert.deepEqual([...store.marks.keys()], [result.dispatcherId]);
    assert.equal(
      store.marks.get(result.dispatcherId)?.parentSessionId,
      "disp-1",
    );
    // The in-memory mirror answers for the live child — that is what the
    // `sessionKind` projection and the peer fence read.
    assert.equal(host.isDurablyMarkedDispatcher(result.dispatcherId), true);
  });

  it("does not write a mark when the create is refused, and the finally drops both pre-create seeds", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore();
    const activated: string[] = [];
    const host = createCordisDshHost(ctx, {
      markers: store,
      onDispatcherSpawned: (_agent, sessionId) => {
        activated.push(sessionId);
      },
    });
    host.bindParent(createAgent("disp-1"), "disp-1");
    ctx.failNextCreateWith(new Error("session/agent-busy"));

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "disp-1",
        title: "Peer",
        prompt: "Handle it.",
      }),
      /session\/agent-busy/,
    );
    assert.equal(store.marks.size, 0);
    const attempted = ctx.createCalls[0] as CreateAgentOptionsLike;
    const reservedId = String(attempted.sessionId);

    // Ticket 140: the mark MIRROR is seeded before the create (the projection's
    // `init` runs at `session/created`, inside it). A failed spawn must not
    // leave a phantom dispatcher mark behind.
    assert.equal(host.isDurablyMarkedDispatcher(reservedId), false);

    // Ticket 118: the reservation is dropped too. If it survived, the
    // agent/created listener would treat this exact id as our dispatcher child
    // and activate it; here it must fall through to nothing.
    ctx.fire("agent/created", {
      agent: {
        session: { id: reservedId, header: { parentSession: "disp-1" } },
        ctx: {},
      },
      source: "startup",
    });
    assert.deepEqual(activated, []);
  });

  it("a failing mark write never turns an accepted spawn into a host refusal", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore();
    store.writeDispatcherMark = () => {
      throw new Error("marker store unavailable");
    };
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    // The host already accepted the spawn: the id is still the reserved one
    // and the first turn was still delivered, whatever the store did.
    assert.equal(
      result.dispatcherId,
      String((ctx.createCalls[0] as CreateAgentOptionsLike).sessionId),
    );
    assert.equal(ctx.followupCalls.length, 1);
    assert.equal(host.isDurablyMarkedDispatcher(result.dispatcherId), true);
  });
});

describe("ticket 141: host spawn generation", () => {
  /** Minimal mark store that records the whole row. */
  function createMarkStore() {
    const marks = new Map<
      string,
      { sessionId: string; parentSessionId?: string; generation?: number }
    >();
    return {
      marks,
      writeWorkerMarker() {},
      readWorkerMarkers() {
        return [];
      },
      deleteWorkerMarker() {},
      writeDispatcherMark(mark: {
        sessionId: string;
        parentSessionId?: string;
        generation?: number;
      }) {
        marks.set(mark.sessionId, mark);
      },
      readDispatcherMark(sessionId: string) {
        return marks.get(sessionId);
      },
    };
  }

  it("a spawner reported as generation 2 makes the child generation 3, recorded on the row", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore();
    const host = createCordisDshHost(ctx, {
      markers: store,
      dispatcherGenerationOf: (sessionId) =>
        sessionId === "disp-1" ? 2 : null,
    });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    assert.equal(store.marks.get(result.dispatcherId)?.generation, 3);
    assert.equal(store.marks.get(result.dispatcherId)?.parentSessionId, "disp-1");
  });

  it("with no generation resolver the spawner is generation 1, so the child is 2", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    assert.equal(store.marks.get(result.dispatcherId)?.generation, 2);
  });

  it("the activation hook runs from the create setup and reads the seeded number before the row exists", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore();
    const seen: Array<{
      sessionId: string;
      generation: number;
      rowExisted: boolean;
      markedAtHookTime: boolean;
    }> = [];
    const host = createCordisDshHost(ctx, {
      markers: store,
      // The spawner is a generation-4 dispatcher: the child must be 5, and the
      // hook now runs BEFORE the mark row is written — the pre-create seed is
      // the only thing that can supply the number at that moment.
      dispatcherGenerationOf: (sessionId) =>
        sessionId === "disp-1" ? 4 : null,
      onDispatcherSpawned: (_agent, sessionId, generation) => {
        seen.push({
          sessionId,
          generation,
          rowExisted: store.marks.has(sessionId),
          markedAtHookTime: host.isDurablyMarkedDispatcher(sessionId),
        });
      },
    });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    // Once, from `setup`, with the same number the row later stores.
    assert.deepEqual(seen, [
      {
        sessionId: result.dispatcherId,
        generation: 5,
        rowExisted: false,
        markedAtHookTime: true,
      },
    ]);
    assert.equal(store.marks.get(result.dispatcherId)?.generation, 5);
    // `setup` COMPOSES, never drives: the hook opened no turn of its own, and
    // the first turn is still the handoff prompt.
    assert.equal(ctx.followupCalls.length, 1);
    assert.deepEqual(ctx.events, ["create", "setup", "published", "followup"]);
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
