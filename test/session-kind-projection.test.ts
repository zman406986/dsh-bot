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
import {
  applySessionKindProjection,
  DISPATCHER_SESSION_KIND,
  INITIAL_SESSION_KIND_STATE,
  parseDispatcherSessionKind,
  parseSessionKindProjectionState,
  LEGACY_DISPATCHER_STOP_COMMAND,
  registerSessionKindProjection,
  SESSION_KIND_PROJECTION_DEFINITION,
  SESSION_KIND_PROJECTION_KEY,
  SESSION_KIND_PROJECTION_STATE_VERSION,
  viewSessionKind,
  type SessionKindProjectionState,
  type SessionProjectionChildLike,
  type SessionProjectionDefinitionLike,
  type SessionProjectionEventLike,
  type SessionProjectionsRegistryLike,
} from "../src/adapter/session-kind-projection.js";
import {
  DISPATCHER_START_COMMAND,
  LEGACY_DISPATCHER_START_COMMAND,
} from "../src/adapter/activation-command.js";

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

  it("still marks a session from a LEGACY dispatcher-start log (ADR-0030 rename durability)", () => {
    // The 2026-10-21 rename (ADR-0030) changed the command's NAME only.
    // Logs persisted before it carry the literal `dispatcher-start`; a
    // restart replay of such a log must still mark the session as a
    // dispatcher.
    const started = fold([
      commandRun("cmd-1", LEGACY_DISPATCHER_START_COMMAND),
      commandDone("cmd-1", "success"),
    ]);
    assert.equal(viewSessionKind(started), DISPATCHER_SESSION_KIND);

    // The fail-closed rules hold under the legacy name too: an unpaired
    // run is not a settlement, and a refused start fabricates nothing.
    const pending = fold([
      commandRun("cmd-2", LEGACY_DISPATCHER_START_COMMAND),
    ]);
    assert.equal(viewSessionKind(pending), null);
    const refused = fold([
      commandRun("cmd-3", LEGACY_DISPATCHER_START_COMMAND),
      commandDone("cmd-3", "error"),
    ]);
    assert.equal(viewSessionKind(refused), null);
  });

  it("clears the mark on a successful stop and keeps it on a refused stop", () => {
    const started = fold([
      commandRun("cmd-1", DISPATCHER_START_COMMAND),
      commandDone("cmd-1", "success"),
    ]);
    const stopped = fold(
      [
        commandRun("cmd-2", LEGACY_DISPATCHER_STOP_COMMAND),
        commandDone("cmd-2", "success"),
      ],
      started,
    );
    assert.equal(viewSessionKind(stopped), null);

    // Refused stop ("this chat is not a dispatcher") is `kind: "error"`.
    const refusedStop = fold(
      [
        commandRun("cmd-3", LEGACY_DISPATCHER_STOP_COMMAND),
        commandDone("cmd-3", "error"),
      ],
      started,
    );
    assert.equal(viewSessionKind(refusedStop), DISPATCHER_SESSION_KIND);
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

  it("ignores unrelated commands, unknown events, and junk data by reference", () => {
    const initial = INITIAL_SESSION_KIND_STATE;
    assert.equal(
      applySessionKindProjection(
        initial,
        commandRun("cmd-1", "some-other-command"),
      ),
      initial,
    );
    assert.equal(
      applySessionKindProjection(initial, {
        type: "tool/call",
        data: { name: "spawn_worker" },
      }),
      initial,
    );
    assert.equal(
      applySessionKindProjection(initial, {
        type: "command/run",
        data: { commandId: 42, name: DISPATCHER_START_COMMAND },
      }),
      initial,
    );
    assert.equal(
      applySessionKindProjection(initial, {
        type: "command/done",
        data: { commandId: "unknown-id", kind: "success" },
      }),
      initial,
    );
    assert.equal(
      applySessionKindProjection(initial, {
        type: "command/done",
        data: null,
      }),
      initial,
    );
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

  it("restored state continues to fold new events", () => {
    const stored = JSON.parse(
      JSON.stringify(
        fold([
          commandRun("cmd-1", DISPATCHER_START_COMMAND),
          commandDone("cmd-1", "success"),
        ]),
      ),
    );
    const restored = parseSessionKindProjectionState(stored);
    const stopped = fold(
      [
        commandRun("cmd-2", LEGACY_DISPATCHER_STOP_COMMAND),
        commandDone("cmd-2", "success"),
      ],
      restored,
    );
    assert.equal(viewSessionKind(stopped), null);
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
  it("declares the contract's key, wire view, and state version", () => {
    assert.equal(SESSION_KIND_PROJECTION_KEY, "sessionKind");
    // v2 (ticket 140): `init` also consults the dispatcher-mark mirror, which
    // changes what a v1 row would have cached for a spawned child.
    assert.equal(SESSION_KIND_PROJECTION_STATE_VERSION, 2);
    assert.equal(
      SESSION_KIND_PROJECTION_DEFINITION.key,
      SESSION_KIND_PROJECTION_KEY,
    );
    assert.equal(typeof SESSION_KIND_PROJECTION_DEFINITION.wire.view, "function");
    assert.equal(
      SESSION_KIND_PROJECTION_DEFINITION.init({}, 0).active,
      false,
    );
  });

  it("registers through the optional injected service", () => {
    const registry = createFakeRegistry();
    const requested: string[][] = [];
    registerSessionKindProjection({
      inject(services, callback) {
        requested.push([...services]);
        callback({ sessionProjections: registry });
      },
    });
    assert.deepEqual(requested, [["sessionProjections"]]);
    assert.equal(registry.registers, 1);
    assert.equal(
      registry.definition?.key,
      SESSION_KIND_PROJECTION_KEY,
    );
  });

  it("uses the direct registry when no inject seat exists (stub contexts)", () => {
    const registry = createFakeRegistry();
    const dispose = registerSessionKindProjection({
      sessionProjections: registry,
    });
    assert.equal(registry.registers, 1);
    assert.equal(typeof dispose, "function");
    dispose?.();
    assert.equal(registry.definition, null);
  });

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
