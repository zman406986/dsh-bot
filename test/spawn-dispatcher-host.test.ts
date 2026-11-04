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

interface ComposedChild {
  readonly childId: string;
  readonly sections: string[];
  readonly restrictions: unknown[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A structural agent.
 *
 * Ticket 163 defect 2: `cwd` defaults to a real directory. A summon from a
 * session with none is REFUSED (its peer could never be cold-resumed), so an
 * agent without one models a summoner that cannot summon — the refusal has its
 * own test below, which passes `null` to mean "no directory".
 */
function createAgent(
  id: string,
  delegationDepth = 0,
  header: { cwd?: string | null } = {},
  options?: AgentOptionsLike,
): AgentLike {
  const cwd = header.cwd === undefined ? "C:\\work" : header.cwd;
  return {
    session: {
      id,
      header: {
        ...(delegationDepth === 0
          ? { parentSession: undefined, delegationDepth: 0 }
          : { parentSession: "parent-x", delegationDepth }),
        ...(cwd === null ? {} : { cwd }),
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
  /**
   * Ticket 159: park the NEXT create BEFORE `setup` runs, so a second create
   * can reach `setup` first. That is the interleaving the old positional queue
   * could not survive.
   */
  let holdNextCreate = false;
  let heldCreate: (() => void) | null = null;

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
    holdNextActivation(): void;
    releaseHeldActivation(): void;
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
    holdNextActivation() {
      holdNextCreate = true;
    },
    releaseHeldActivation() {
      const gate = heldCreate;
      heldCreate = null;
      gate?.();
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
        // Ticket 159: park here — AFTER the id exists, BEFORE `setup` — so a
        // test can start a second create and let IT reach `setup` first.
        if (holdNextCreate) {
          holdNextCreate = false;
          await new Promise<void>((resolve) => {
            heldCreate = resolve;
          });
        }
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

/**
 * Ticket 163 — the four defects the ticket-157 review found. Each test here
 * fails against the code as ticket 157 left it, and passes after its fix.
 */
describe("ticket 163 defect 1: the child's generation follows the summoner's DURABLE row", () => {
  /** A store that lists rows, so `refreshDispatcherMarks` can warm the mirror. */
  function createListableMarkStore() {
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
      listDispatcherMarks() {
        return [...marks.values()];
      },
      peekDispatcherMark(sessionId: string) {
        return marks.has(sessionId)
          ? ({ kind: "dispatcher", mark: marks.get(sessionId)! } as const)
          : ({ kind: "not-dispatcher" } as const);
      },
    };
  }

  /**
   * The measured defect, reproduced on the path that is still reachable.
   *
   * Ticket 157 measured it on a generation-3 grandchild. Ticket 176 (owner
   * ruling 2026-11-03) has since made that exact shape unreachable: a session
   * whose class resolves `"spawned"` — which `>= 2` does — is refused a summon
   * outright. What survives is the same ROOT CAUSE one level up: the host read
   * the spawner's generation only from `dispatcherGenerationOf` (the plugin's
   * lifecycle), and a parentless cold resume activates with no generation, so
   * the lifecycle answers 1 for a session whose durable row says more. This
   * test drives that read directly through `refreshDispatcherMarks`, which is
   * the seam the ticket names ("the `dispatcherGenerations` mirror that
   * `refreshDispatcherMarks` had already filled from the durable row").
   *
   * It asserts the mirror's answer rather than a spawn, because the spawn is
   * fenced by ticket 176 and the MIRROR is what that fence and every future
   * generation read consult.
   */
  it("a generation-3 row is what the host reports, not the lifecycle's 1", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    // A durable row from an earlier process: this peer was summoned by a
    // generation-2 dispatcher.
    store.marks.set("peer-3", {
      sessionId: "peer-3",
      parentSessionId: "chat-1",
      generation: 3,
    });
    // The lifecycle seam answers what the plugin knows TODAY. A parentless cold
    // resume activates with no generation, so it answers 1 — the number that
    // must NOT win.
    const host = createCordisDshHost(ctx, {
      markers: store,
      dispatcherGenerationOf: () => 1,
    });
    await host.refreshDispatcherMarks();

    // The durable row is authoritative: this session is class `spawned`, which
    // is exactly the answer a generation >= 2 implies.
    assert.equal(host.isDurablyMarkedDispatcher("peer-3"), true);
    assert.equal(host.dispatcherMarkAnswer("peer-3"), "dispatcher");
  });

  it("a legacy pre-141 row (no generation field) still reads as a dispatcher", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    // Ticket 141: a row written before the field existed came from a spawn, so
    // its honest reading is generation 2.
    store.marks.set("legacy-peer", {
      sessionId: "legacy-peer",
      parentSessionId: "chat-1",
    });
    const host = createCordisDshHost(ctx, {
      markers: store,
      dispatcherGenerationOf: () => null,
    });
    await host.refreshDispatcherMarks();

    assert.equal(host.isDurablyMarkedDispatcher("legacy-peer"), true);
  });

  it("an in-process spawn seeds the mirror BEFORE the child exists, so a chained read is right", async () => {
    // The mirror is not only the boot path: `spawnDispatcher` seeds it before
    // the create, and `writeDispatcherMark` re-seeds it after. A read taken
    // between the two must already be correct.
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    const host = createCordisDshHost(ctx, {
      markers: store,
      dispatcherGenerationOf: () => null,
    });
    host.bindParent(createAgent("chat-1"), "chat-1");

    const first = await host.spawnDispatcher({
      parentSessionId: "chat-1",
      title: "Peer two",
      prompt: "First slice.",
    });

    // Child of a generation-1 user chat.
    assert.equal(store.marks.get(first.dispatcherId)?.generation, 2);
    assert.equal(host.isDurablyMarkedDispatcher(first.dispatcherId), true);
    // …and therefore class `spawned` in this process, without any store read.
    assert.equal(host.dispatcherMarkAnswer(first.dispatcherId), "dispatcher");
  });

  /**
   * The root cause, isolated: the SPAWNER-generation expression must consult
   * the mirror before the lifecycle seam.
   *
   * This is asserted through a real spawn from a USER-class session whose id
   * also appears in the mirror with a higher generation — the one arrangement
   * ticket 176 does not fence, because `dispatcherClasses` can keep the session
   * `"user"` while the mirror says 3. A host that read only the lifecycle would
   * record 2 here; reading the mirror first records 4.
   */
  it("the spawn path itself prefers the mirror over the lifecycle seam", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    const host = createCordisDshHost(ctx, {
      markers: store,
      // The lifecycle says "generation 1" — the parentless-resume default.
      dispatcherGenerationOf: () => 1,
    });
    await host.refreshDispatcherMarks();
    // A user-class session (so it MAY summon) whose mirror entry says 3.
    // `recordDispatcherClass` writes the CLASS without touching the mirror;
    // the generation mirror was warmed from a row that also exists.
    store.marks.set("resumed-user", {
      sessionId: "resumed-user",
      parentSessionId: "chat-0",
      generation: 3,
    });
    host.bindParent(createAgent("resumed-user"), "resumed-user");
    host.recordDispatcherClass("resumed-user", "user");
    await host.refreshDispatcherMarks();

    const result = await host.spawnDispatcher({
      parentSessionId: "resumed-user",
      title: "Peer four",
      prompt: "Own a fourth slice.",
    });

    assert.equal(
      store.marks.get(result.dispatcherId)?.generation,
      4,
      "one past the DURABLE generation the mirror holds, not the lifecycle's 1",
    );
  });
});

describe("ticket 163 defect 2: a summoner with no cwd refuses loudly", () => {
  it("throws a named refusal before creating anything", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    // `null` means "this header carries no cwd" — a summoner that cannot
    // produce a resumable peer.
    host.bindParent(createAgent("nowhere", 0, { cwd: null }), "nowhere");

    const caught = await host
      .spawnDispatcher({
        parentSessionId: "nowhere",
        title: "Peer",
        prompt: "Own the slice.",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // LOUD, with the remedy named — never a silent unresumable session.
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /^CordisDshHost: /);
    assert.match(caught.message, /has no cwd/);
    assert.match(caught.message, /cold-resumed/);
    assert.match(caught.message, /Nothing was created/);
    // Nothing happened: no session, no turn, no failed spawn to clean up.
    assert.equal(ctx.createCalls.length, 0);
    assert.equal(ctx.followupCalls.length, 0);
  });

  it("an empty-string cwd is the same refusal — it is not a directory either", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("blank", 0, { cwd: "" }), "blank");

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "blank",
        title: "Peer",
        prompt: "Own the slice.",
      }),
      /has no cwd/,
    );
    assert.equal(ctx.createCalls.length, 0);
  });

  it("a summoner WITH a cwd still creates the peer in that exact directory", async () => {
    // The refusal must not become a blanket rule: the normal case is untouched.
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(
      createAgent("disp-1", 0, { cwd: "C:\\work\\project" }),
      "disp-1",
    );

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Own the slice.",
    });
    assert.deepEqual(ctx.createCalls[0]?.meta, { cwd: "C:\\work\\project" });
    assert.equal(ctx.createCalls.length, 1);
    assert.match(result.dispatcherId, UUID_RE);
  });
});

/**
 * Ticket 159 — the spawn title must pair with the session it belongs to by
 * IDENTITY, never by queue position.
 *
 * The host-side half of the fix: the title rides the activation hook beside the
 * session id it names, so there is no queue to get wrong. These tests pin the
 * host's contract — the title the summoner asked for is the title the hook
 * receives, on the call that names that child, even when two summons are in
 * flight at once.
 */
describe("ticket 159: the spawn title travels with its own session id", () => {
  it("the hook receives the summoner's title beside the child's own id", async () => {
    const ctx = createStubCtx();
    const hooked: Array<{ sessionId: string; title: string | undefined }> = [];
    const host = createCordisDshHost(ctx, {
      onDispatcherSpawned: (_agent, sessionId, _generation, title) => {
        hooked.push({ sessionId, title });
      },
    });
    host.bindParent(createAgent("chat-1"), "chat-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "chat-1",
      title: "Payments migration",
      prompt: "Own the migration.",
    });

    assert.equal(hooked.length, 1);
    // Identity: the id on the hook is the id the spawn reports back.
    assert.equal(hooked[0]?.sessionId, result.dispatcherId);
    assert.equal(hooked[0]?.title, "Payments migration");
  });

  it("two summons in flight bind each child with ITS OWN title (the reported race)", async () => {
    // The interleaving ticket 159 describes: A's create suspends before `setup`
    // while B's create reaches it first. A queue claim would give B A's title.
    const ctx = createStubCtx();
    const hooked: Array<{ sessionId: string; title: string | undefined }> = [];
    const host = createCordisDshHost(ctx, {
      onDispatcherSpawned: (_agent, sessionId, _generation, title) => {
        hooked.push({ sessionId, title });
      },
    });
    host.bindParent(createAgent("chat-a"), "chat-a");
    host.bindParent(createAgent("chat-b"), "chat-b");

    // Summon A is started first and parks before its `setup`.
    ctx.holdNextActivation();
    const spawnA = host.spawnDispatcher({
      parentSessionId: "chat-a",
      title: "Alpha job",
      prompt: "Own alpha.",
    });
    // Let A reach the parked point, then start B and let IT finish first.
    await new Promise((resolve) => setImmediate(resolve));
    const spawnB = host.spawnDispatcher({
      parentSessionId: "chat-b",
      title: "Beta job",
      prompt: "Own beta.",
    });
    const b = await spawnB;
    // NOW release A, so A's `setup` runs after B's — the wrong order for any
    // positional claim.
    ctx.releaseHeldActivation();
    const a = await spawnA;

    assert.equal(hooked.length, 2);
    const titleById = new Map(hooked.map((e) => [e.sessionId, e.title]));
    // Both directions, not just "both labels are non-empty".
    assert.equal(titleById.get(a.dispatcherId), "Alpha job");
    assert.equal(titleById.get(b.dispatcherId), "Beta job");
    // …and they are genuinely different sessions, so a swap is meaningful.
    assert.notEqual(a.dispatcherId, b.dispatcherId);
  });

  it("a refused spawn hands the hook no title at all — nothing leaks to a later summon", async () => {
    const ctx = createStubCtx();
    const hooked: Array<{ sessionId: string; title: string | undefined }> = [];
    const host = createCordisDshHost(ctx, {
      onDispatcherSpawned: (_agent, sessionId, _generation, title) => {
        hooked.push({ sessionId, title });
      },
    });
    host.bindParent(createAgent("chat-1"), "chat-1");
    const refusal = new Error("session/agent-busy");
    ctx.failNextCreateWith(refusal);

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "chat-1",
        title: "Never happened",
        prompt: "Own it.",
      }),
      (error: unknown) => error === refusal,
    );
    // The hook never ran, so there is no entry anywhere for a later summon to
    // inherit — the second-order symptom the ticket recorded.
    assert.equal(hooked.length, 0);

    const ok = await host.spawnDispatcher({
      parentSessionId: "chat-1",
      title: "Real job",
      prompt: "Own it.",
    });
    assert.equal(hooked.length, 1);
    assert.equal(hooked[0]?.sessionId, ok.dispatcherId);
    assert.equal(hooked[0]?.title, "Real job");
  });

  it("a re-announcement passes no title, so it cannot overwrite the spawn's label", async () => {
    // The hook also fires for a cold-resumed / re-announced child. There is no
    // title there, and `undefined` says so — the roster keeps the label the
    // session was bound with.
    const ctx = createStubCtx();
    const hooked: Array<{ sessionId: string; title: string | undefined }> = [];
    const host = createCordisDshHost(ctx, {
      onDispatcherSpawned: (_agent, sessionId, _generation, title) => {
        hooked.push({ sessionId, title });
      },
    });
    host.bindParent(createAgent("chat-1"), "chat-1");
    const spawned = await host.spawnDispatcher({
      parentSessionId: "chat-1",
      title: "Original label",
      prompt: "Own it.",
    });

    // A second announcement of the same session (the resume path).
    ctx.fire("agent/created", {
      agent: createAgent(spawned.dispatcherId),
      source: "resume",
    });
    await new Promise((resolve) => setImmediate(resolve));

    // The re-announcement is deduplicated by `dispatcherActivated`, so the hook
    // still ran exactly once with the spawn's own title.
    assert.equal(hooked.length, 1);
    assert.equal(hooked[0]?.title, "Original label");
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
