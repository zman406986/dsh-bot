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
import {createCordisDshHost, type ActivationLike, type ActivationSpecLike, type AdapterContext, type AgentHandleLike, type AgentLike, type AgentOptionsLike, type CreateAgentOptionsLike} from "../src/adapter/cordis-dsh-host.js";
import { WAKE_SOURCE_KIND } from "../src/adapter/wake-copy.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import {dispatcherSpawnMaxDepth} from "../src/worker/agent-def.js";

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

});

/**
 * Ticket 176 (owner ruling 2026-11-03): a dispatcher another dispatcher
 * summoned may NOT summon further dispatchers.
 *
 * The tool surface is the fence — a team leader never gets `spawn_dispatcher`
 * registered, so it never sees the name. This suite pins the BACKSTOP: even a
 * caller that reaches `host.spawnDispatcher` directly is refused, loudly, and
 * both directions are covered so an over-eager refusal cannot slip through.
 *
 * A REAL HOST records the class itself for every session it activates as a
 * summoned peer, so this suite plays the caller that already has (via
 * `recordDispatcherClass`) — the same entry the plugin's activation hooks use.
 */
describe("ticket 176: a spawned dispatcher cannot summon", () => {
  it("refuses a summon from a spawned-class session, loudly, before the host is touched", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const teamLeader = createAgent("disp-spawned");
    host.bindParent(teamLeader, "disp-spawned");
    host.recordDispatcherClass("disp-spawned", "spawned");

    const caught = await host
      .spawnDispatcher({
        parentSessionId: "disp-spawned",
        title: "Another team",
        prompt: "Own a third slice.",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // LOUD, and actionable: the error names the rule and the remedy. A silent
    // no-op would leave the model believing a peer exists.
    assert.ok(caught instanceof Error, "the refusal is thrown, not swallowed");
    assert.match(caught.message, /^CordisDshHost: /);
    assert.match(caught.message, /team leader/);
    assert.match(caught.message, /cannot summon another dispatcher/);
    assert.match(caught.message, /Report what is needed/);
    // Nothing happened: no session was created, no turn was opened.
    assert.equal(ctx.createCalls.length, 0);
    assert.equal(ctx.followupCalls.length, 0);
    assert.equal(ctx.startActivationCalls.length, 0);
  });

  it("still allows a summon from a user-started session — the user class is untouched", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    // Deliberately NOT recorded: an unrecorded class on a host with no store is
    // `user`, which is what every pre-176 activation produced. A second case
    // records it explicitly so both routes are covered.
    host.bindParent(createAgent("chat-1"), "chat-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "chat-1",
      title: "Peer",
      prompt: "Own the slice.",
    });
    assert.match(result.dispatcherId, UUID_RE);
    assert.equal(ctx.createCalls.length, 1);

    const explicit = createStubCtx();
    const host2 = createCordisDshHost(explicit);
    host2.bindParent(createAgent("chat-2"), "chat-2");
    host2.recordDispatcherClass("chat-2", "user");
    const second = await host2.spawnDispatcher({
      parentSessionId: "chat-2",
      title: "Peer",
      prompt: "Own the other slice.",
    });
    assert.match(second.dispatcherId, UUID_RE);
    assert.equal(explicit.createCalls.length, 1);
  });

  it("a later `user` record cannot unlock a session already known as spawned", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-spawned"), "disp-spawned");
    host.recordDispatcherClass("disp-spawned", "spawned");
    // The class of a session id cannot change (ADR-0034 decision 1), so a
    // second, weaker record is ignored rather than obeyed.
    host.recordDispatcherClass("disp-spawned", "user");

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "disp-spawned",
        title: "Another team",
        prompt: "Own a third slice.",
      }),
      /cannot summon another dispatcher/,
    );
    assert.equal(ctx.createCalls.length, 0);
  });

  /**
   * The COLD-RESUME half of the decision recorded on ticket 176: a spawned
   * dispatcher whose mark row is still on disk keeps the refusal after a
   * restart, because `dispatcher_sessions` rows are written only by the spawn
   * path — a row's presence already means "another dispatcher summoned this".
   */
  it("refuses a cold-resumed spawned dispatcher whose row is readable in the store", async () => {
    const ctx = createStubCtx();
    const store = createPeekableMarkStore();
    store.put({ sessionId: "disp-resumed" });
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-resumed"), "disp-resumed");

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "disp-resumed",
        title: "Another team",
        prompt: "Own a third slice.",
      }),
      /cannot summon another dispatcher/,
    );
    assert.equal(ctx.createCalls.length, 0);
  });

  it("allows a resumed user-started dispatcher: the store proves it has no dispatcher row", async () => {
    const ctx = createStubCtx();
    const store = createPeekableMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("chat-resumed"), "chat-resumed");

    const result = await host.spawnDispatcher({
      parentSessionId: "chat-resumed",
      title: "Peer",
      prompt: "Own the slice.",
    });
    assert.match(result.dispatcherId, UUID_RE);
    assert.equal(ctx.createCalls.length, 1);
  });

  it("fails CLOSED when the store exists but cannot answer yet", async () => {
    // A store that has not opened answers `unknown` for everything. A wrong
    // ALLOW would create a second dispatcher level the owner ruled out, and
    // nothing else would catch it; a wrong DENY is visible and self-heals once
    // the store opens. The ticket records this choice.
    const ctx = createStubCtx();
    const store = createPeekableMarkStore();
    store.closeForNow();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-unknown"), "disp-unknown");

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "disp-unknown",
        title: "Peer",
        prompt: "Own the slice.",
      }),
      /cannot summon another dispatcher/,
    );
    assert.equal(ctx.createCalls.length, 0);
  });
});

/**
 * A mark store that answers the synchronous peek, with an explicit "not opened
 * yet" mode — the shape the real `storageDomain` store has before its async
 * open resolves (`durable-marker.ts` `peekDispatcherMark`).
 */
function createPeekableMarkStore() {
  const marks = new Map<string, { sessionId: string }>();
  let open = true;
  return {
    put(mark: { sessionId: string }): void {
      marks.set(mark.sessionId, mark);
    },
    closeForNow(): void {
      open = false;
    },
    writeWorkerMarker() {},
    readWorkerMarkers() {
      return [];
    },
    deleteWorkerMarker() {},
    peekDispatcherMark(
      sessionId: string,
    ):
      | { kind: "dispatcher"; mark: { sessionId: string } }
      | { kind: "not-dispatcher" }
      | { kind: "unknown" } {
      if (!open) return { kind: "unknown" };
      const mark = marks.get(sessionId);
      return mark === undefined
        ? { kind: "not-dispatcher" }
        : { kind: "dispatcher", mark };
    },
  };
}

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

});

describe("ticket 118: FakeDshHost dispatcher spawn", () => {
  it("records dispatcher spawns separately and never as workers", async () => {
    // A dispatcher is a peer, not a work stream: if its spawn landed in
    // `spawnCalls`, the worker registry would gain a stream it must not own.
    const host = new FakeDshHost();
    await host.spawnDispatcher({ title: "Peer", prompt: "Go." } as never);
    assert.equal(host.dispatcherSpawnCalls.length, 1);
    assert.equal(host.spawnCalls.length, 0);
  });
});
