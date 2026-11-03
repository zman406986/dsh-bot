/**
 * Ticket 123 — host-side session-kind projection.
 *
 * Pins the durable dispatcher marker the client reads as
 * `projectionValues.sessionKind`:
 *
 * 1. The fold marks a session ONLY on a SUCCESSFUL `/dsh-bot`
 *    settlement (`command/run` + `command/done`), never on a refused start,
 *    a thrown handler, or an unpaired run. Logs persisted before the
 *    ADR-0030 rename carry the legacy literal `dispatcher-start`; the fold
 *    accepts BOTH names so restart replay stays durable across the rename.
 * 2. A successful legacy `/dispatcher-stop` settlement clears the mark; a
 *    refused stop leaves it untouched (the fold never fabricates a kind).
 *    The stop command itself is withdrawn (ADR-0030, ticket 129) — the fold
 *    matches the persisted legacy literal only, so restart replay of old
 *    logs still clears the mark.
 * 3. Fold state is per session — the registry keeps one cell per session, so
 *    a second dispatcher session never contaminates the first (ADR-0019).
 * 4. State is plain JSON, so the persisted projection cache can store it and
 *    a restart re-seeds the same view (durability).
 *
 * Offline only (S8): synthetic events, no host, no LLM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {applySessionKindProjection, dispatcherClassOf, DISPATCHER_SESSION_KIND, initSessionKindProjection, INITIAL_SESSION_KIND_STATE, parseDispatcherSessionKind, parseSessionKindProjectionState, LEGACY_DISPATCHER_STOP_COMMAND, registerSessionKindProjection, SESSION_KIND_PROJECTION_DEFINITION, TEAM_LEADER_SESSION_KIND, viewSessionKind, type SessionKindProjectionState, type SessionProjectionChildLike, type SessionProjectionDefinitionLike, type SessionProjectionEventLike, type SessionProjectionsRegistryLike} from "../src/adapter/session-kind-projection.js";
import {DISPATCHER_START_COMMAND} from "../src/adapter/activation-command.js";

/** One declared host event as the log carries it (only fields we read). */
function commandRun(
  commandId: string,
  commandName: string,
): SessionProjectionEventLike {
  return {
    type: "command/run",
    data: { commandId, name: commandName, source: { kind: "user" } },
  };
}

function commandDone(
  commandId: string,
  kind: "success" | "error",
): SessionProjectionEventLike {
  return { type: "command/done", data: { commandId, kind } };
}

function fold(
  events: readonly SessionProjectionEventLike[],
  initial: SessionKindProjectionState = INITIAL_SESSION_KIND_STATE,
): SessionKindProjectionState {
  return events.reduce(
    (state, event) => applySessionKindProjection(state, event),
    initial,
  );
}

// ── A minimal faithful registry: one cell per session ──────────────────────
// Mirrors the behavior the contract states
// (`dsh-session-projection/lib/types/index.js:57-70`: `session/created`
// initializes a cell per session; `session/event` drives only that session).

interface FakeRegistry extends SessionProjectionsRegistryLike {
  readonly definition: SessionProjectionDefinitionLike<SessionKindProjectionState> | null;
  readonly states: Map<string, SessionKindProjectionState>;
  readonly registers: number;
  append(sessionId: string, event: SessionProjectionEventLike): void;
  snapshot(sessionId: string): unknown;
}

function createFakeRegistry(): FakeRegistry {
  const states = new Map<string, SessionKindProjectionState>();
  const registry: FakeRegistry = {
    definition: null,
    states,
    registers: 0,
    register(definition) {
      registry.registers += 1;
      registry.definition = definition;
      return () => {
        registry.definition = null;
      };
    },
    append(sessionId, event) {
      assert.notEqual(registry.definition, null, "unit is registered");
      const definition = registry.definition;
      assert.ok(definition !== null);
      const current =
        states.get(sessionId) ?? definition.init({}, 0);
      states.set(sessionId, definition.apply(current, event));
    },
    snapshot(sessionId) {
      assert.notEqual(registry.definition, null);
      const definition = registry.definition;
      assert.ok(definition !== null);
      const state = states.get(sessionId) ?? definition.init({}, 0);
      const wire = definition.wire.viewSchema.parse(
        definition.wire.view(state),
      );
      return wire;
    },
  };
  return registry;
}

describe("session-kind projection — fold", () => {
  it("marks a session only after a SUCCESSFUL dsh-bot settlement", () => {
    const started = fold([
      commandRun("cmd-1", DISPATCHER_START_COMMAND),
      commandDone("cmd-1", "success"),
    ]);
    assert.equal(viewSessionKind(started), DISPATCHER_SESSION_KIND);

    // The run alone is not a settlement: a crash between the two events must
    // not fabricate a dispatcher.
    const pending = fold([commandRun("cmd-2", DISPATCHER_START_COMMAND)]);
    assert.equal(viewSessionKind(pending), null);

    // A refused start (not-top-level / unresolved) settles `error`.
    const refused = fold([
      commandRun("cmd-3", DISPATCHER_START_COMMAND),
      commandDone("cmd-3", "error"),
    ]);
    assert.equal(viewSessionKind(refused), null);
  });

  it("re-activation after a stop marks the session again", () => {
    const state = fold([
      commandRun("cmd-1", DISPATCHER_START_COMMAND),
      commandDone("cmd-1", "success"),
      commandRun("cmd-2", LEGACY_DISPATCHER_STOP_COMMAND),
      commandDone("cmd-2", "success"),
      commandRun("cmd-3", DISPATCHER_START_COMMAND),
      commandDone("cmd-3", "success"),
    ]);
    assert.equal(viewSessionKind(state), DISPATCHER_SESSION_KIND);
  });

  it("pairs concurrent command ids instead of last-write-wins", () => {
    // Two starts in flight; only the second settles success first.
    let state = fold([
      commandRun("start-a", DISPATCHER_START_COMMAND),
      commandRun("start-b", DISPATCHER_START_COMMAND),
      commandDone("start-b", "success"),
    ]);
    assert.equal(viewSessionKind(state), DISPATCHER_SESSION_KIND);
    // The still-pending refused start settles later without unsetting it.
    state = fold([commandDone("start-a", "error")], state);
    assert.equal(viewSessionKind(state), DISPATCHER_SESSION_KIND);
  });
});

describe("session-kind projection — sessions do not cross-contaminate", () => {
  it("a second dispatcher session leaves the first session's kind untouched", () => {
    const registry = createFakeRegistry();
    registry.register(SESSION_KIND_PROJECTION_DEFINITION);

    // Session A activates.
    registry.append(
      "session-a",
      commandRun("a-1", DISPATCHER_START_COMMAND),
    );
    registry.append("session-a", commandDone("a-1", "success"));
    assert.equal(registry.snapshot("session-a"), DISPATCHER_SESSION_KIND);

    // Session B activates with its OWN command ids.
    registry.append(
      "session-b",
      commandRun("b-1", DISPATCHER_START_COMMAND),
    );
    registry.append("session-b", commandDone("b-1", "success"));
    registry.append("session-c", {
      type: "tool/call",
      data: { name: "spawn_worker" },
    });

    assert.equal(registry.snapshot("session-a"), DISPATCHER_SESSION_KIND);
    assert.equal(registry.snapshot("session-b"), DISPATCHER_SESSION_KIND);
    // A session that never ran the command has no mark at all.
    assert.equal(registry.snapshot("session-c"), null);

    // Stopping B does not clear A.
    registry.append("session-b", commandRun("b-2", LEGACY_DISPATCHER_STOP_COMMAND));
    registry.append("session-b", commandDone("b-2", "success"));
    assert.equal(registry.snapshot("session-b"), null);
    assert.equal(registry.snapshot("session-a"), DISPATCHER_SESSION_KIND);
  });

  it("each session's cell starts from its own empty state", () => {
    const registry = createFakeRegistry();
    registry.register(SESSION_KIND_PROJECTION_DEFINITION);
    assert.equal(registry.states.size, 0);
    registry.append("session-x", {
      type: "tool/result",
      data: {},
    });
    assert.equal(registry.states.size, 1);
    assert.equal(registry.snapshot("session-x"), null);
    assert.equal(registry.snapshot("session-y"), null);
    // The fold copies rather than mutating the shared initial state.
    assert.equal(INITIAL_SESSION_KIND_STATE.active, false);
    assert.deepEqual(INITIAL_SESSION_KIND_STATE.pendingStarts, []);
  });
});

describe("session-kind projection — state durability", () => {
  it("state is plain JSON and re-seeds the same view after a restart", () => {
    const started = fold([
      commandRun("cmd-1", DISPATCHER_START_COMMAND),
      commandDone("cmd-1", "success"),
    ]);
    // The projection cache persists state via structured clone.
    const stored = structuredClone(started);
    const restored = parseSessionKindProjectionState(
      JSON.parse(JSON.stringify(stored)),
    );
    assert.equal(viewSessionKind(restored), DISPATCHER_SESSION_KIND);
  });

  it("rejects malformed persisted state and malformed wire values", () => {
    assert.throws(() => parseSessionKindProjectionState(null));
    assert.throws(() => parseSessionKindProjectionState({}));
    assert.throws(() =>
      parseSessionKindProjectionState({
        active: true,
        pendingStarts: [1],
        pendingStops: [],
      }),
    );
    assert.throws(() =>
      parseSessionKindProjectionState({
        active: true,
        pendingStarts: [],
        pendingStops: "nope",
      }),
    );
    assert.equal(parseDispatcherSessionKind(null), null);
    assert.equal(
      parseDispatcherSessionKind(DISPATCHER_SESSION_KIND),
      DISPATCHER_SESSION_KIND,
    );
    assert.throws(() => parseDispatcherSessionKind("worker"));
  });
});

describe("session-kind projection — registration", () => {
  it("is a silent no-op when the service is absent", () => {
    assert.doesNotThrow(() => registerSessionKindProjection({}));
    assert.doesNotThrow(() =>
      registerSessionKindProjection({
        inject(_services, callback) {
          callback({});
        },
      }),
    );
  });

  it("never throws activation when the host rejects the unit", () => {
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      assert.doesNotThrow(() =>
        registerSessionKindProjection({
          sessionProjections: {
            register() {
              throw new Error("stateVersion conflict");
            },
          },
        }),
      );
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1);
  });
});

/**
 * Ticket 177 — the two dispatcher classes ride this one projection.
 *
 * The owner wants a different sidebar icon for a dispatcher the human started
 * and one another dispatcher summoned (ticket 173's two policy classes). The
 * class therefore has to be a SECOND WIRE VALUE on the key the client already
 * reads, and it has to be durable: a restart must not turn a team leader back
 * into a chief of staff.
 */
describe("session-kind projection — dispatching classes (ticket 177)", () => {
  it("a durable mark settles the SPAWNED class — the row only exists for a summon", () => {
    // `writeDispatcherMark` has one caller (`spawnDispatcher`) and the mark
    // schema rejects generation 1, so a row's existence IS "summoned". This
    // is why no new column was added to the mark table.
    const state = initSessionKindProjection(
      { id: "summoned-1" },
      () => "dispatcher",
    );
    assert.equal(state.active, true);
    assert.equal(state.dispatcherClass, "spawned");
    assert.equal(viewSessionKind(state), TEAM_LEADER_SESSION_KIND);
    assert.equal(viewSessionKind(state), "dispatcher-team-leader");
  });

  it("an abstaining mark source settles no class; a negative one settles none either", () => {
    const abstained = initSessionKindProjection(
      { id: "unknown-1" },
      () => "unknown",
    );
    assert.equal(abstained.resolved, false);
    assert.equal(abstained.dispatcherClass, undefined);
    assert.equal(viewSessionKind(abstained), null);

    const negative = initSessionKindProjection(
      { id: "chat-1" },
      () => "not-dispatcher",
    );
    assert.equal(negative.active, false);
    assert.equal(negative.dispatcherClass, undefined);
    assert.equal(viewSessionKind(negative), null);
  });

  it("the classes are distinct wire values, and null still means 'not a dispatcher'", () => {
    assert.notEqual(DISPATCHER_SESSION_KIND, TEAM_LEADER_SESSION_KIND);
    assert.equal(viewSessionKind(INITIAL_SESSION_KIND_STATE), null);
  });

  it("a spawned class survives a /dsh-bot success on the same log", () => {
    // Defensive: a summon never re-runs the command, but if a log carried
    // both the more specific fact must win.
    const state = fold(
      [
        commandRun("cmd-1", DISPATCHER_START_COMMAND),
        commandDone("cmd-1", "success"),
      ],
      {
        active: true,
        pendingStarts: [],
        pendingStops: [],
        dispatcherClass: "spawned",
      },
    );
    assert.equal(state.dispatcherClass, "spawned");
    assert.equal(viewSessionKind(state), TEAM_LEADER_SESSION_KIND);
  });

  it("a FAILED /dsh-bot settlement settles no class", () => {
    const state = fold(
      [
        commandRun("cmd-1", DISPATCHER_START_COMMAND),
        commandDone("cmd-1", "error"),
      ],
      INITIAL_SESSION_KIND_STATE,
    );
    assert.equal(state.active, false);
    assert.equal(state.dispatcherClass, undefined);
    assert.equal(viewSessionKind(state), null);
  });

  it("the class is plain JSON and survives the projection cache round-trip", () => {
    const started = fold([
      commandRun("cmd-1", DISPATCHER_START_COMMAND),
      commandDone("cmd-1", "success"),
    ]);
    const restored = parseSessionKindProjectionState(
      JSON.parse(JSON.stringify(structuredClone(started))),
    );
    assert.equal(restored.dispatcherClass, "user");
    assert.equal(viewSessionKind(restored), DISPATCHER_SESSION_KIND);

    const summoned = parseSessionKindProjectionState(
      JSON.parse(
        JSON.stringify({
          active: true,
          pendingStarts: [],
          pendingStops: [],
          dispatcherClass: "spawned",
        }),
      ),
    );
    assert.equal(viewSessionKind(summoned), TEAM_LEADER_SESSION_KIND);
  });

  it("a pre-175 row (no class field) reads as the user-started class", () => {
    // Every row written before this ticket could only describe a dispatcher
    // started by the human OR a spawned one whose class was never recorded.
    // Reading it as `user` is the status quo, and it is what keeps the
    // existing glyph on screen instead of blanking every cached row.
    const legacy = parseSessionKindProjectionState({
      active: true,
      pendingStarts: [],
      pendingStops: [],
    });
    assert.equal(legacy.dispatcherClass, undefined);
    assert.equal(viewSessionKind(legacy), DISPATCHER_SESSION_KIND);
  });

  it("rejects a class value outside the two shipped ones", () => {
    assert.throws(() =>
      parseSessionKindProjectionState({
        active: true,
        pendingStarts: [],
        pendingStops: [],
        dispatcherClass: "admiral",
      }),
    );
  });

  it("accepts both wire values and still rejects everything else", () => {
    assert.equal(
      parseDispatcherSessionKind(TEAM_LEADER_SESSION_KIND),
      TEAM_LEADER_SESSION_KIND,
    );
    assert.equal(parseDispatcherSessionKind(null), null);
    assert.throws(() => parseDispatcherSessionKind("dispatcher-admiral"));
    assert.throws(() => parseDispatcherSessionKind(undefined));
  });

  describe("dispatcherClassOf — the resume seam's reader", () => {
    /** A registry that answers one fixed state for any session. */
    function registryAnswering(
      state: SessionKindProjectionState | undefined,
    ) {
      return { stateOf: () => state };
    }

    it("answers the class of an active dispatcher", () => {
      assert.equal(
        dispatcherClassOf(
          registryAnswering({
            active: true,
            pendingStarts: [],
            pendingStops: [],
            dispatcherClass: "spawned",
          }),
          {},
        ),
        "spawned",
      );
      assert.equal(
        dispatcherClassOf(
          registryAnswering({
            active: true,
            pendingStarts: [],
            pendingStops: [],
            dispatcherClass: "user",
          }),
          {},
        ),
        "user",
      );
    });

    it("fails closed to null — never invents a class", () => {
      assert.equal(dispatcherClassOf(undefined, {}), null);
      assert.equal(
        dispatcherClassOf(registryAnswering(undefined), {}),
        null,
      );
      assert.equal(
        dispatcherClassOf(
          registryAnswering({
            active: false,
            pendingStarts: [],
            pendingStops: [],
            dispatcherClass: "spawned",
          }),
          {},
        ),
        null,
        "an inactive cell is not a dispatcher at all",
      );
      assert.equal(
        dispatcherClassOf(
          {
            stateOf() {
              throw new Error("fold exploded");
            },
          },
          {},
        ),
        null,
      );
      assert.equal(
        dispatcherClassOf(
          { stateOf: () => "not a state" },
          {},
        ),
        null,
      );
    });

    it("a settled class never disagrees with the wire value", () => {
      // The glyph and the resumed policy read the SAME cell, so they cannot
      // show different classes for one session.
      for (const dispatcherClass of ["user", "spawned"] as const) {
        const state: SessionKindProjectionState = {
          active: true,
          pendingStarts: [],
          pendingStops: [],
          dispatcherClass,
        };
        const wire = viewSessionKind(state);
        assert.equal(
          dispatcherClassOf(registryAnswering(state), {}),
          dispatcherClass,
        );
        assert.equal(
          wire === TEAM_LEADER_SESSION_KIND,
          dispatcherClass === "spawned",
        );
      }
    });
  });
});
