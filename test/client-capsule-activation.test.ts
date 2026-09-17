/**
 * Ticket 39 — capsule expanded panel: the activation row + dormant vs
 * activated compositions (epic 35 §1, ADR-0005/0009 discipline).
 *
 * Offline only (S8): pure view-model assertions over the store kinds — the
 * composition matrix (each store kind maps to exactly one composition), the
 * intent-dispatch contract (the exact payload per affordance, the default
 * no-op seat keeping the component render-only), and the locale contract for
 * the new keys. Component rendering stays covered by build success +
 * typecheck, same as the panel and the ticket-38 chip.
 *
 * The no-stop guard extension (capsule view models carry no direct
 * stop/deactivate control) lives with ticket 31's guard in
 * `test/restart-honesty.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPSULE_ACTIVATION_PITCH_KEY,
  CAPSULE_ACTIVATION_START_KEY,
  CAPSULE_ACTIVATION_STOP_KEY,
  CAPSULE_DOT_KEYS,
  createCapsuleStore,
  describeCapsuleActivationRow,
  dispatchActivationIntent,
  noopOnActivationIntent,
  type CapsuleActivationComposition,
  type CapsuleActivationIntent,
  type OnActivationIntent,
} from "../src/client/capsule-store.js";
import { createDispatcherCapsule } from "../src/client/capsule.js";
import {
  localeDictionary,
  validateLocaleDictionary,
} from "../src/client/overlay.js";
import { createRosterStore, type RosterPanelState } from "../src/client/roster-store.js";
import {
  ROSTER_STALE_WINDOW_MS,
  type RosterSnapshot,
  type RosterSnapshotWorker,
} from "../src/core/roster-snapshot.js";
import type { WorkerStatus } from "../src/core/types.js";

/** A v2 roster row with honest defaults; overrides keep tests terse. */
function row(
  workerId: string,
  status: WorkerStatus,
  overrides: Partial<RosterSnapshotWorker> = {},
): RosterSnapshotWorker {
  return {
    kind: "worker",
    workerId,
    title: `Worker ${workerId}`,
    status,
    todoId: null,
    startedAtMs: 0,
    toolCallCount: 0,
    delivered: true,
    blocked: null,
    ...overrides,
  };
}

/** A v3 snapshot builder for activation-row view-model tests. */
function snapshot(
  workers: RosterSnapshotWorker[],
  publishedAtMs = 1_000,
): RosterSnapshot {
  return {
    schemaVersion: 3,
    dispatcherSessionId: "s-1",
    publishedAtMs,
    workers,
    recentResult: null,
  };
}

describe("capsule activation row — composition matrix (ticket 39)", () => {
  it("waiting maps dormant: the activation pitch with the single start affordance", () => {
    assert.deepEqual(describeCapsuleActivationRow({ kind: "waiting" }, 5_000), {
      composition: "dormant",
      stateKey: CAPSULE_DOT_KEYS.dormant,
      affordance: {
        intent: "start",
        labelKey: CAPSULE_ACTIVATION_START_KEY,
      },
    });
  });

  it("a fresh snapshot maps activated: active state line + stop intent", () => {
    const view = describeCapsuleActivationRow(
      {
        kind: "snapshot",
        snapshot: snapshot([row("w-1", "running"), row("w-2", "steering")]),
      },
      1_000,
    );
    assert.deepEqual(view, {
      composition: "activated",
      stateKey: CAPSULE_DOT_KEYS.active,
      affordance: { intent: "stop", labelKey: CAPSULE_ACTIVATION_STOP_KEY },
    });
  });

  it("a fresh empty snapshot stays activated: activation observed, no workers", () => {
    const view = describeCapsuleActivationRow(
      { kind: "snapshot", snapshot: snapshot([]) },
      1_000,
    );
    assert.equal(view.composition, "activated");
    assert.equal(view.affordance?.intent, "stop");
  });

  it("stale/invalid/channel-missing map unavailable: honest copy, NO actionable affordance", () => {
    const staleState = {
      kind: "snapshot",
      snapshot: snapshot([row("w", "running", { delivered: false })]),
    } as const;
    const states = [
      { kind: "channel-missing" },
      { kind: "invalid" },
      // One ms past the window: was active, vouches for nothing.
      {
        kind: "snapshot",
        snapshot: snapshot([row("w", "running")]),
        at: 1_000 + ROSTER_STALE_WINDOW_MS + 1,
      },
    ] as const;
    for (const [index, state] of states.entries()) {
      const view = describeCapsuleActivationRow(
        state,
        "at" in state ? state.at : 5_000,
      );
      assert.deepEqual(
        view,
        {
          composition: "unavailable",
          stateKey: CAPSULE_DOT_KEYS.error,
          affordance: null,
        },
        `state ${index} must be unavailable with no affordance`,
      );
    }
    // Boundary: exactly the window is still activated (mirrors
    // isRosterSnapshotStale — one clock, one freshness rule).
    assert.equal(
      describeCapsuleActivationRow(staleState, 1_000 + ROSTER_STALE_WINDOW_MS)
        .composition,
      "activated",
    );
  });

  it("the matrix is a total function: every store kind maps to exactly one composition", () => {
    const states: ReadonlyArray<{ label: string; state: RosterPanelState; now: number }> = [
      { label: "waiting", state: { kind: "waiting" }, now: 5_000 },
      {
        label: "fresh snapshot",
        state: { kind: "snapshot", snapshot: snapshot([row("w", "running")]) },
        now: 1_000,
      },
      {
        label: "stale snapshot",
        state: { kind: "snapshot", snapshot: snapshot([row("w", "running")]) },
        now: 1_000 + ROSTER_STALE_WINDOW_MS + 1,
      },
      { label: "invalid", state: { kind: "invalid" }, now: 5_000 },
      { label: "channel-missing", state: { kind: "channel-missing" }, now: 5_000 },
    ];
    const seen = new Set<CapsuleActivationComposition>();
    for (const { label, state, now } of states) {
      // Deterministic: the same truth always yields the same composition.
      assert.deepEqual(
        describeCapsuleActivationRow(state, now),
        describeCapsuleActivationRow(state, now),
        `composition for ${label} must be deterministic`,
      );
      seen.add(describeCapsuleActivationRow(state, now).composition);
    }
    // The matrix exercises every composition exactly.
    assert.deepEqual(
      [...seen].sort(),
      ["activated", "dormant", "unavailable"],
    );
  });

  it("affordance pairing: dormant→start, activated→stop, unavailable→none", () => {
    const checks: ReadonlyArray<{
      state: RosterPanelState;
      composition: CapsuleActivationComposition;
      intent: CapsuleActivationIntent | null;
    }> = [
      {
        state: { kind: "waiting" },
        composition: "dormant",
        intent: "start",
      },
      {
        state: { kind: "snapshot", snapshot: snapshot([]) },
        composition: "activated",
        intent: "stop",
      },
      {
        state: { kind: "invalid" },
        composition: "unavailable",
        intent: null,
      },
    ];
    for (const { state, composition, intent } of checks) {
      const view = describeCapsuleActivationRow(state, 5_000);
      assert.equal(view.composition, composition);
      assert.equal(view.affordance?.intent ?? null, intent);
    }
  });
});

describe("capsule activation row — intent dispatch (ticket 39)", () => {
  it("dispatch hands the EXACT payload per affordance to the injected callback", () => {
    const received: CapsuleActivationIntent[] = [];
    const recorder: OnActivationIntent = (intent) => {
      received.push(intent);
    };
    const dormant = describeCapsuleActivationRow({ kind: "waiting" }, 5_000);
    const activated = describeCapsuleActivationRow(
      { kind: "snapshot", snapshot: snapshot([row("w", "running")]) },
      1_000,
    );
    const dormantAffordance = dormant.affordance;
    const activatedAffordance = activated.affordance;
    assert.ok(dormantAffordance);
    assert.ok(activatedAffordance);
    dispatchActivationIntent(dormantAffordance, recorder);
    dispatchActivationIntent(activatedAffordance, recorder);
    assert.deepEqual(received, ["start", "stop"]);
  });

  it("the unavailable composition has no affordance, so there is nothing to dispatch", () => {
    const view = describeCapsuleActivationRow(
      { kind: "channel-missing" },
      5_000,
    );
    assert.equal(view.affordance, null);
  });

  it("the default seat is a callable no-op for both intents", () => {
    assert.equal(typeof noopOnActivationIntent, "function");
    assert.doesNotThrow(() => noopOnActivationIntent("start"));
    assert.doesNotThrow(() => noopOnActivationIntent("stop"));
  });

  it("the factory takes the intent seat with a no-op default (render-only unbound)", () => {
    const t = (key: string) => key;
    const store = createRosterStore();
    const capsule = createCapsuleStore();
    // Calling the FACTORY executes no hooks, so the injection shapes are
    // assertable offline; calling the returned component needs a renderer
    // (S8: none), which is why behavior is pinned one seam out, on
    // dispatchActivationIntent + the view model above.
    const unbound = createDispatcherCapsule(t, store, capsule);
    const bound = createDispatcherCapsule(t, store, capsule, () => {});
    assert.equal(typeof unbound, "function");
    assert.equal(typeof bound, "function");
    assert.notEqual(unbound, bound);
  });
});

describe("capsule activation row — locale contract (ticket 39)", () => {
  it("the dictionary still validates; the three new keys exist in BOTH faces", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    for (const key of [
      CAPSULE_ACTIVATION_START_KEY,
      CAPSULE_ACTIVATION_STOP_KEY,
      CAPSULE_ACTIVATION_PITCH_KEY,
    ]) {
      assert.equal(typeof localeDictionary.en[key], "string", `en missing ${key}`);
      assert.equal(typeof localeDictionary.zh[key], "string", `zh missing ${key}`);
      assert.notEqual(localeDictionary.en[key], "", `en ${key} empty`);
      assert.notEqual(localeDictionary.zh[key], "", `zh ${key} empty`);
    }
  });

  it("the start label is the ticket's exact affordance phrasing", () => {
    assert.equal(
      localeDictionary.en[CAPSULE_ACTIVATION_START_KEY],
      "Start dispatcher in this chat",
    );
  });

  it("the stop label is an honest conversational ask, not a kill control", () => {
    const en = localeDictionary.en[CAPSULE_ACTIVATION_STOP_KEY] ?? "";
    const zh = localeDictionary.zh[CAPSULE_ACTIVATION_STOP_KEY] ?? "";
    // The ADR-0005/0009 framing: an ask handed to the dispatcher, never a
    // direct stop/deactivate control (guard-enforced structurally in
    // test/restart-honesty.test.ts).
    assert.match(en, /^Ask the dispatcher/);
    assert.match(zh, /^请求调度器/);
  });

  it("the view model's label keys resolve through the seat for every composition", () => {
    const states = [
      { kind: "waiting" },
      { kind: "snapshot", snapshot: snapshot([row("w", "running")]) },
      { kind: "invalid" },
    ] as const;
    for (const state of states) {
      const view = describeCapsuleActivationRow(state, 5_000);
      assert.equal(typeof localeDictionary.en[view.stateKey], "string");
      if (view.affordance !== null) {
        assert.equal(
          typeof localeDictionary.en[view.affordance.labelKey],
          "string",
        );
        assert.equal(
          typeof localeDictionary.zh[view.affordance.labelKey],
          "string",
        );
      }
    }
  });
});
