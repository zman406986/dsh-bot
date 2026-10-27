/**
 * Ticket 140 — a SPAWNED dispatcher resolves to kind `"dispatcher"`.
 *
 * The 2026-10-28 ruling: a spawned dispatcher gets the dispatcher mark via
 * (1) the host-side `sessionKind` projection unit consulting the adapter's
 * dispatcher-mark mirror at `init`, and (2) the client header chip reading
 * `projectionValues.sessionKind` (pinned in `client-session-kind.test.ts`).
 *
 * This file pins the host half end to end against the REAL pieces — real
 * `CordisDshHost`, real projection unit, real probe — over a structural ctx
 * whose `startActivation` announces the child the way the installed host
 * does (`agent/created` fires INSIDE the call, i.e. before the durable mark
 * row is written). Three binding facts:
 *
 * 1. The mirror is SEEDED at the reserve site, so the projection's `init` —
 *    which runs at session creation, inside `startActivation` — sees the
 *    child as a dispatcher even though the durable row does not exist yet.
 *    The projection cache would otherwise checkpoint the wrong kind.
 * 2. A FAILED spawn removes the seed: the mirror never self-deletes and the
 *    peer fence reads it, so a refused spawn must leave no phantom mark.
 * 3. The unit's probe is LATE-BOUND: the plugin registers the unit before the
 *    host exists, so `init` must read a thunk set afterwards, never a
 *    captured host instance.
 *
 * Offline only (S8): a stub ctx, no live dsh, no LLM.
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
import {
  DISPATCHER_SESSION_KIND,
  registerSessionKindProjection,
  SESSION_KIND_PROJECTION_KEY,
  SESSION_KIND_PROJECTION_STATE_VERSION,
  sessionKindProjectionDefinition,
  type SessionKindProjectionState,
  type SessionProjectionDefinitionLike,
} from "../src/adapter/session-kind-projection.js";

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
          ? { parentSession: undefined, delegationDepth: 0 }
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
    states,
  };
}

/**
 * Structural ctx stub. `startActivation` announces the child exactly like the
 * installed host: the child session id is `spec.childId` (so the reservation
 * matches), and `agent/created` fires INSIDE the call — the moment the real
 * registry's `session/created` listener runs `init`.
 */
function createStubCtx(options?: {
  /** Runs at the host's `session/created` moment (inside startActivation). */
  onSessionCreated?: (header: StubSessionHeader) => void;
}) {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const startActivationCalls: ActivationSpecLike[] = [];
  const state: { failNextWith: unknown; mintOwnId: boolean } = {
    failNextWith: undefined,
    mintOwnId: false,
  };
  let nextChild = 1;

  const ctx: AdapterContext & {
    fire(name: string, payload: unknown): void;
    startActivationCalls: ActivationSpecLike[];
    failNextActivationWith(error: unknown): void;
    mintOwnChildId(): void;
  } = {
    startActivationCalls,
    failNextActivationWith(error: unknown) {
      state.failNextWith = error;
    },
    mintOwnChildId() {
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
        if (state.failNextWith !== undefined) {
          const failure = state.failNextWith;
          state.failNextWith = undefined;
          throw failure;
        }
        const announcedId = String(spec.childId);
        const parentDepth =
          spec.request.parent.session.header?.delegationDepth ?? 0;
        // The registry's `session/created` listener runs first (the host
        // creates the Session, then builds the Agent).
        options?.onSessionCreated?.({
          id: announcedId,
          parentSession: String(spec.request.parent.session.id),
          delegationDepth: parentDepth + 1,
        });
        ctx.fire("agent/created", {
          agent: {
            session: {
              id: announcedId,
              header: {
                parentSession: String(spec.request.parent.session.id),
                delegationDepth: parentDepth + 1,
              },
            },
          },
          source: "startup",
        });
        const returnedId = state.mintOwnId
          ? `host-child-${nextChild++}`
          : announcedId;
        state.mintOwnId = false;
        return {
          childId: returnedId,
          messageId: `msg-${returnedId}`,
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

describe("ticket 140: spawned dispatcher resolves to kind dispatcher", () => {
  it("the reserved id is in the mirror BEFORE startActivation runs (the seed)", async () => {
    const registry = createFakeRegistry();
    let seededAtStart = false;
    let host: ReturnType<typeof createCordisDshHost> | null = null;
    const ctx = createStubCtx({
      onSessionCreated(header) {
        // The mirror must already answer for the reserved id: `init` below
        // runs before the durable mark row is written.
        seededAtStart = host?.isDurablyMarkedDispatcher(header.id) === true;
        registry.sessionCreated(header);
      },
    });
    host = createCordisDshHost(ctx);
    registerSessionKindProjection({ sessionProjections: registry }, () =>
      host === null ? undefined : (sessionId) =>
        host.isDurablyMarkedDispatcher(sessionId),
    );
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    assert.equal(seededAtStart, true, "seed is visible inside startActivation");
    assert.equal(
      (ctx.startActivationCalls[0] as ActivationSpecLike).provider,
      SPAWN_PROVIDER,
    );
    // (a) the child session projects kind "dispatcher", from a log that
    // carries no `/dsh-bot` settlement at all.
    assert.equal(registry.kindOf(result.dispatcherId), DISPATCHER_SESSION_KIND);
    assert.equal(
      (registry.states.get(result.dispatcherId) as SessionKindProjectionState)
        .active,
      true,
    );
  });

  it("a normal session still projects null — the probe only answers for marked ids", () => {
    const registry = createFakeRegistry();
    let marked = false;
    registerSessionKindProjection({ sessionProjections: registry }, () =>
      () => marked,
    );
    registry.sessionCreated({ id: "chat-1" });
    assert.equal(registry.kindOf("chat-1"), null);
    marked = true;
    registry.sessionCreated({ id: "child-1" });
    assert.equal(registry.kindOf("child-1"), DISPATCHER_SESSION_KIND);
  });

  it("(b) a FAILED spawn leaves no mirror entry — no phantom dispatcher mark", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");
    const refusal = new Error("ACTIVATION_LIMIT_REACHED");
    ctx.failNextActivationWith(refusal);

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "disp-1",
        title: "Peer",
        prompt: "Handle it.",
      }),
      (error: unknown) => error === refusal,
    );

    const reservedId = String(
      (ctx.startActivationCalls[0] as ActivationSpecLike).childId,
    );
    assert.ok(reservedId.length > 0);
    // The mirror never self-deletes, and the peer fence reads it — a refused
    // spawn must not leave the id looking like a dispatcher.
    assert.equal(host.isDurablyMarkedDispatcher(reservedId), false);
    // A second, successful spawn is unaffected by the failed one.
    const ok = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer 2",
      prompt: "Handle it.",
    });
    assert.equal(host.isDurablyMarkedDispatcher(ok.dispatcherId), true);
    assert.notEqual(ok.dispatcherId, reservedId);
  });

  it("a host that minted its own id keeps only the REAL child marked", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");
    ctx.mintOwnChildId();

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    const reservedId = String(
      (ctx.startActivationCalls[0] as ActivationSpecLike).childId,
    );
    assert.notEqual(result.dispatcherId, reservedId);
    assert.equal(host.isDurablyMarkedDispatcher(result.dispatcherId), true);
    assert.equal(host.isDurablyMarkedDispatcher(reservedId), false);
  });

  it("(3) the probe is LATE-BOUND: the unit registered before the host exists still sees it", () => {
    let probe: ((sessionId: string) => boolean) | null = null;
    const definition = sessionKindProjectionDefinition(() => probe ?? undefined);

    assert.equal(definition.init({ id: "child-1" }, 0).active, false);
    // The host binding arrives after registration, exactly like `apply`.
    probe = (sessionId) => sessionId === "child-1";
    assert.equal(definition.init({ id: "child-1" }, 0).active, true);
    assert.equal(definition.init({ id: "chat-1" }, 0).active, false);
  });

  it("fails closed: a throwing probe, a bad header, or no probe all read as not-dispatcher", () => {
    const throwing = sessionKindProjectionDefinition(() => () => {
      throw new Error("mirror exploded");
    });
    assert.equal(throwing.init({ id: "child-1" }, 0).active, false);
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
