/**
 * Ticket 140 — a SPAWNED dispatcher resolves to kind `"dispatcher"`.
 *
 * The durable `sessionKind` projection unit consults the adapter's
 * dispatcher-mark mirror at `init`. Ticket 140 originally hung a client
 * header chip on the same value; ticket 157 / ADR-0032 removed that chip —
 * a summoned dispatcher is a top-level session with its own sidebar row, so
 * the sidebar glyph is the one mark. The host half is unchanged and is what
 * this file pins, end to end, against the REAL pieces — real `CordisDshHost`,
 * real projection unit, real probe — over a structural ctx whose
 * `agents.create` creates the session the way the installed host does
 * (`setup` composes, then `session/created` — the moment the projection's
 * `init` runs — then `agent/created`; the durable mark row is written only
 * after the create resolves). Three binding facts:
 *
 * 1. The mirror is SEEDED at the reserve site, so the projection's `init` —
 *    which runs at session creation, inside `ctx.agents.create` — sees the
 *    child as a dispatcher even though the durable row does not exist yet.
 *    The projection cache would otherwise checkpoint the wrong kind.
 * 2. A FAILED spawn removes the seed: the mirror never self-deletes and the
 *    peer fence reads it, so a refused spawn must leave no phantom mark.
 * 3. The unit's probe is LATE-BOUND: the plugin registers the unit before the
 *    host exists, so `init` must read a thunk set afterwards, never a
 *    captured host instance.
 *
 * Ticket 157 / ADR-0032: the summon no longer rides `ctx.subagents`. The
 * stub's `startActivation` is kept only as a tripwire — any dispatcher spawn
 * that reaches it fails the test by name.
 *
 * Offline only (S8): a stub ctx, no live dsh, no LLM.
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
  type CreateAgentOptionsLike,
} from "../src/adapter/cordis-dsh-host.js";
import {applySessionKindProjection, DISPATCHER_SESSION_KIND, initSessionKindProjection, TEAM_LEADER_SESSION_KIND, registerSessionKindProjection, SESSION_KIND_PROJECTION_KEY, SESSION_KIND_PROJECTION_STATE_VERSION, sessionKindProjectionDefinition, type DispatcherMarkProbe, type SessionKindProjectionState, type SessionProjectionDefinitionLike, type SessionProjectionEventLike} from "../src/adapter/session-kind-projection.js";

interface StubSessionHeader {
  readonly id: string;
  readonly parentSession?: string;
  readonly delegationDepth?: number;
}

function createAgent(id: string, delegationDepth = 0): AgentLike {
  return {
    session: {
      id,
      header:
        delegationDepth === 0
          ? {
              parentSession: undefined,
              delegationDepth: 0,
              // ADR-0032: `meta.cwd` is the only field a summon carries.
              cwd: "C:\\work",
            }
          : { parentSession: "disp-1", delegationDepth },
    },
    followup() {},
  };
}

/**
 * A registry that behaves like the installed one for the part this ticket
 * touches: `session/created` initializes the cell with `definition.init`
 * (`dsh-session-projection/lib/index.js` constructor listener), and the wire
 * read returns `view`. Cells are never refolded — the point is what `init`
 * saw at creation.
 */
function createFakeRegistry() {
  const states = new Map<string, SessionKindProjectionState>();
  let definition: SessionProjectionDefinitionLike<SessionKindProjectionState> | null =
    null;
  return {
    get definition(): SessionProjectionDefinitionLike<SessionKindProjectionState> | null {
      return definition;
    },
    register(next: SessionProjectionDefinitionLike<SessionKindProjectionState>) {
      definition = next;
      return () => {
        definition = null;
      };
    },
    /** `session/created` for a session with an empty log. */
    sessionCreated(header: StubSessionHeader): void {
      assert.notEqual(definition, null, "unit is registered");
      states.set(header.id, definition!.init(header, 0));
    },
    /** The client-visible wire value of one session. */
    kindOf(sessionId: string): unknown {
      assert.notEqual(definition, null);
      const state = states.get(sessionId);
      if (state === undefined) return undefined;
      return definition!.wire.view(state);
    },
    /** One committed event through the registered fold. */
    append(sessionId: string, event: SessionProjectionEventLike): void {
      assert.notEqual(definition, null);
      const current = states.get(sessionId);
      assert.ok(current, `cell for ${sessionId} was never created`);
      states.set(sessionId, definition!.apply(current, event));
    },
    stateOf(sessionId: string): SessionKindProjectionState | undefined {
      return states.get(sessionId);
    },
    states,
  };
}

/**
 * Structural ctx stub. `agents.create` creates the child exactly like the
 * installed host: `setup` composes while the agent is still unpublished, then
 * publication announces `session/created` (the moment the real registry's
 * `init` runs) and `agent/created`. The durable mark row is written only after
 * the create resolves, so the seed is the only source `init` can see.
 *
 * ADR-0032 (ticket 157): a dispatcher summon no longer rides
 * `ctx.subagents.startActivation`. That stub stays because the adapter
 * contract requires it, and it throws by name so a regression to the subagent
 * shape fails loudly instead of passing on a stale assumption.
 */
function createStubCtx(options?: {
  /** Runs at the host's `session/created` moment (inside `agents.create`). */
  onSessionCreated?: (header: StubSessionHeader) => void;
}) {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const startActivationCalls: ActivationSpecLike[] = [];
  const createCalls: CreateAgentOptionsLike[] = [];
  const state: { failNextCreateWith: unknown; mintOwnId: boolean } = {
    failNextCreateWith: undefined,
    mintOwnId: false,
  };
  let nextChild = 1;

  const ctx: AdapterContext & {
    fire(name: string, payload: unknown): void;
    startActivationCalls: ActivationSpecLike[];
    createCalls: CreateAgentOptionsLike[];
    failNextCreateWith(error: unknown): void;
    mintOwnSessionId(): void;
  } = {
    startActivationCalls,
    createCalls,
    failNextCreateWith(error: unknown) {
      state.failNextCreateWith = error;
    },
    mintOwnSessionId() {
      state.mintOwnId = true;
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
        // ADR-0032: a dispatcher summon creates a top-level session; reaching
        // the subagent service is the retired shape and must fail the test.
        throw new Error(
          "startActivation is the worker route, not the dispatcher summon (ADR-0032)",
        );
      },
      interrupt() {},
      async sendMessage() {
        return "msg-stub";
      },
    },
    agents: {
      get: () => undefined,
      async create(
        spec: CreateAgentOptionsLike,
      ): Promise<AgentHandleLike> {
        createCalls.push(spec);
        if (state.failNextCreateWith !== undefined) {
          const failure = state.failNextCreateWith;
          state.failNextCreateWith = undefined;
          throw failure;
        }
        const reservedId = String(spec.sessionId);
        const createdId = state.mintOwnId ? `host-session-${nextChild++}` : reservedId;
        state.mintOwnId = false;
        const agent = createAgent(createdId);
        // The real factory runs `setup` while unpublished, then publishes:
        // `session/created` first, `agent/created` second.
        await spec.setup?.({}, agent);
        options?.onSessionCreated?.({ id: createdId });
        ctx.fire("agent/created", { agent, source: "startup" });
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

describe("ticket 140: spawned dispatcher resolves to kind dispatcher", () => {
  it("the reserved id is in the mirror BEFORE the session is created (the seed)", async () => {
    const registry = createFakeRegistry();
    let seededAtCreate = false;
    let host: ReturnType<typeof createCordisDshHost> | null = null;
    const ctx = createStubCtx({
      onSessionCreated(header) {
        // The mirror must already answer for the reserved id: `init` below
        // runs at `session/created`, inside `ctx.agents.create`, while the
        // durable mark row is written only after the create resolves.
        seededAtCreate = host?.isDurablyMarkedDispatcher(header.id) === true;
        registry.sessionCreated(header);
      },
    });
    host = createCordisDshHost(ctx);
    registerSessionKindProjection({ sessionProjections: registry }, () =>
      host === null ? undefined : (sessionId) => host.dispatcherMarkAnswer(sessionId),
    );
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    // Ticket 157 / ADR-0032: the seed is written BEFORE `ctx.agents.create`,
    // which is where the projection's `init` now runs. The retired assertion
    // counted `spawnDispatcher`'s far side at `subagents.startActivation` with
    // `provider: "spawn"` — that call no longer exists; this is the same
    // protection (the mirror answers before the child is visible) reached
    // through the create route.
    assert.equal(seededAtCreate, true, "seed is visible at session creation");
    assert.equal(ctx.startActivationCalls.length, 0);
    assert.equal(ctx.createCalls.length, 1);
    const createCall = ctx.createCalls[0];
    assert.ok(createCall);
    assert.equal(createCall.sessionId, result.dispatcherId);
    // A top-level session: `cwd` and nothing else in `meta`, no parentAgent.
    assert.deepEqual(createCall.meta, { cwd: "C:\\work" });
    assert.equal("parentAgent" in createCall, false);
    // (a) the child session projects a dispatcher kind, from a log that
    // carries no `/dsh-bot` settlement at all. Ticket 177: the kind names the
    // CLASS — a summoned dispatcher is the team-leader class, not the
    // human-started one.
    assert.equal(
      registry.kindOf(result.dispatcherId),
      TEAM_LEADER_SESSION_KIND,
    );
    assert.equal(
      (registry.states.get(result.dispatcherId) as SessionKindProjectionState)
        .dispatcherClass,
      "spawned",
    );
    assert.equal(
      (registry.states.get(result.dispatcherId) as SessionKindProjectionState)
        .active,
      true,
    );
  });

  it("a failed spawn leaves no phantom dispatcher mark", async () => {
    // A seed that outlives a refused create would mark a session that never
    // existed as a dispatcher — a false positive the sidebar would render.
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");
    const refusal = new Error("host refused the create");
    ctx.failNextCreateWith(refusal);

    await assert.rejects(
      host.spawnDispatcher({ parentSessionId: "disp-1", title: "Peer", prompt: "Handle it." }),
      (error: unknown) => error === refusal,
    );
    const reservedId = String(ctx.createCalls[0]?.sessionId ?? "");
    assert.ok(reservedId.length > 0);
    assert.equal(host.isDurablyMarkedDispatcher(reservedId), false, "the seed survived");
  });

  it("fails closed: a throwing probe or a bad header never claims a kind", () => {
    const throwing = sessionKindProjectionDefinition(() => () => {
      throw new Error("mirror exploded");
    });
    assert.equal(throwing.init({ id: "child-1" }, 0).active, false);
    // A throw is "cannot answer", not "definitely not a dispatcher".
    assert.equal(throwing.init({ id: "child-1" }, 0).resolved, false);
    assert.equal(throwing.init(null, 0).active, false);
    assert.equal(throwing.init({}, 0).active, false);
    assert.equal(
      sessionKindProjectionDefinition().init({ id: "child-1" }, 0).active,
      false,
    );
    // The shared state version is what the persisted cache keys on.
    assert.equal(
      sessionKindProjectionDefinition().stateVersion,
      SESSION_KIND_PROJECTION_STATE_VERSION,
    );
    assert.equal(
      sessionKindProjectionDefinition().key,
      SESSION_KIND_PROJECTION_KEY,
    );
  });
});

describe("ticket 140 review fix: the cold case and the abstain rule", () => {
  /** A durable table that answers only once opened, like the real store. */
  function createPeekStore() {
    const marks = new Map<string, { sessionId: string }>();
    let opened = false;
    return {
      marks,
      open(): void {
        opened = true;
      },
      peekDispatcherMark(sessionId: string):
        | { kind: "dispatcher"; mark: { sessionId: string } }
        | { kind: "not-dispatcher" }
        | { kind: "unknown" } {
        if (!opened) return { kind: "unknown" };
        const mark = marks.get(sessionId);
        return mark === undefined
          ? { kind: "not-dispatcher" }
          : { kind: "dispatcher", mark };
      },
    };
  }

  function markerStore(store: ReturnType<typeof createPeekStore>) {
    return {
      writeWorkerMarker() {},
      readWorkerMarkers: () => [],
      deleteWorkerMarker() {},
      peekDispatcherMark: (id: string) => store.peekDispatcherMark(id),
    };
  }

  it("(a) cold mirror + durable mark present -> the child projects dispatcher", () => {
    const store = createPeekStore();
    // The row exists from a previous process; the in-memory mirror is cold
    // (no spawn ran, no warm-up read yet).
    store.marks.set("resumed-child", { sessionId: "resumed-child" });
    store.open();

    const host = createCordisDshHost(createStubCtx(), {
      markers: markerStore(store),
    });
    const probe: DispatcherMarkProbe = (id) => host.dispatcherMarkAnswer(id);

    const state = initSessionKindProjection({ id: "resumed-child" }, probe);
    assert.equal(state.active, true, "the durable row settles the kind");
    // Ticket 177: a mark row only ever exists for a summon, so the durable
    // answer carries the CLASS too, not just the identity.
    assert.equal(state.dispatcherClass, "spawned");
    assert.equal(sessionKindView(state), TEAM_LEADER_SESSION_KIND);
    assert.equal(host.isDurablyMarkedDispatcher("resumed-child"), false);
  });

  it("(b) cold store (not yet open) -> UNRESOLVED, nothing definitive cached", () => {
    const store = createPeekStore(); // deliberately not opened
    const host = createCordisDshHost(createStubCtx(), {
      markers: markerStore(store),
    });
    const probe: DispatcherMarkProbe = (id) => host.dispatcherMarkAnswer(id);

    const state = initSessionKindProjection({ id: "later-child" }, probe);
    assert.equal(state.active, false);
    assert.equal(state.resolved, false, "abstains instead of claiming 'no'");
    assert.equal(state.sessionId, "later-child", "remembers what to re-ask");
    // The wire value is still null — an unknown kind is never displayed.
    assert.equal(sessionKindView(state), null);

    // The row (from a previous process) becomes readable; the next event
    // re-derives it with no new log evidence.
    store.marks.set("later-child", { sessionId: "later-child" });
    store.open();
    const settled = applySessionKindProjection(
      state,
      { type: "turn/end" },
      probe,
    );
    assert.equal(settled.active, true);
    assert.equal(settled.resolved, undefined, "settled state drops the marker");
    assert.equal(settled.sessionId, undefined);
    // Ticket 177: the late answer settles the CLASS as well as the identity.
    assert.equal(settled.dispatcherClass, "spawned");
    assert.equal(sessionKindView(settled), TEAM_LEADER_SESSION_KIND);
  });

  it("(c) genuinely absent mark with the store open -> resolved not-dispatcher", () => {
    const store = createPeekStore();
    store.open();
    const host = createCordisDshHost(createStubCtx(), {
      markers: markerStore(store),
    });
    const state = initSessionKindProjection(
      { id: "plain-chat" },
      (id) => host.dispatcherMarkAnswer(id),
    );
    assert.equal(state.active, false);
    assert.equal(state.resolved, undefined, "a real 'no' is cached as resolved");
  });

});

function sessionKindView(state: SessionKindProjectionState): unknown {
  return sessionKindProjectionDefinition().wire.view(state);
}
