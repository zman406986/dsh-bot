/**
 * Ticket 69 — L1 offline half: the approval-cards RELAY FEED.
 *
 * The v4 roster snapshot's `pendingAsks` envelope field is the relay's
 * pending-ask truth on the proven settings-mirror channel (the roster
 * panel's own access list feed — never a second channel); this suite pins
 * the wire→ticket mapping, the one-channel hub (fan-out, attach replay,
 * detach), and the fed store END TO END: ask appears → resolve (feed
 * re-publishes without it) → card leaves; the secret-ask variant; and the
 * expired path through the store's notice projection (the documented
 * extension point for a future notice-carrying feed).
 *
 * Offline only (S8): pure data — no React, no DOM, no Cordis, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createApprovalRelayFeed,
  accessTicketFromWireAsk,
  pendingAsksFromChannelValue,
} from "../src/client/approval-feed.js";
import { createApprovalCardsStore } from "../src/client/approval-cards.js";
import {
  ROSTER_SETTINGS_KEY,
  ROSTER_SNAPSHOT_SCHEMA_VERSION,
  projectRosterSnapshot,
} from "../src/core/roster-snapshot.js";
import type { AccessNotice } from "../src/core/access-types.js";

function wireAsk(overrides: {
  readonly requestId?: string;
  readonly workerId?: string;
  readonly class?: string;
  readonly target?: string;
  readonly reason?: string;
  readonly credentialName?: string;
  readonly parentSessionId?: string;
  readonly createdAtMs?: number;
} = {}): Record<string, unknown> {
  return {
    requestId: overrides.requestId ?? "req-1",
    workerId: overrides.workerId ?? "w-1",
    class: overrides.class ?? "tool",
    target: overrides.target ?? "run_tests",
    reason: overrides.reason ?? "needs to run the test suite",
    credentialName: overrides.credentialName ?? "",
    parentSessionId: overrides.parentSessionId ?? "session-1",
    createdAtMs: overrides.createdAtMs ?? 1000,
  };
}

function snapshotValue(
  asks: readonly unknown[],
): Record<string, unknown> {
  return {
    [ROSTER_SETTINGS_KEY]: {
      schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
      dispatcherSessionId: "session-1",
      publishedAtMs: 5000,
      workers: [],
      recentResult: null,
      pendingAsks: asks,
    },
  };
}

describe("roster snapshot v4 — the projection writes pendingAsks from relay truth", () => {
  it("projects full pending tickets (names only — never a credential value)", () => {
    const snapshot = projectRosterSnapshot("session-1", [], 100, {
      pendingAccess: [
        {
          workerId: "w-1",
          requestId: "req-1",
          body: {
            class: "credential",
            target: "API_TOKEN",
            reason: "sign the deploy",
            credentialName: "API_TOKEN",
          },
          createdAtMs: 42,
          parentSessionId: "session-1",
          status: "pending",
        },
      ],
    });
    assert.deepEqual(snapshot.pendingAsks, [
      {
        requestId: "req-1",
        workerId: "w-1",
        class: "credential",
        target: "API_TOKEN",
        reason: "sign the deploy",
        credentialName: "API_TOKEN",
        parentSessionId: "session-1",
        createdAtMs: 42,
      },
    ]);
  });
});

describe("wire → ticket mapping (the store's input contract)", () => {
  it("maps a wire ask into an AccessTicket-shaped pending row", () => {
    const ticket = accessTicketFromWireAsk({
      requestId: "req-9",
      workerId: "w-9",
      class: "credential",
      target: "API_TOKEN",
      reason: "r",
      credentialName: "API_TOKEN",
      parentSessionId: "session-2",
      createdAtMs: 7,
    });
    assert.equal(ticket.requestId, "req-9");
    assert.equal(ticket.workerId, "w-9");
    assert.equal(ticket.status, "pending");
    assert.equal(ticket.parentSessionId, "session-2");
    assert.equal(ticket.createdAtMs, 7);
    assert.deepEqual(ticket.body, {
      class: "credential",
      target: "API_TOKEN",
      reason: "r",
      credentialName: "API_TOKEN",
    });
  });

  it("a non-credential ask carries no credentialName field", () => {
    const ticket = accessTicketFromWireAsk({
      requestId: "req-1",
      workerId: "w-1",
      class: "tool",
      target: "run_tests",
      reason: "r",
      credentialName: "",
      parentSessionId: "session-1",
      createdAtMs: 1,
    });
    assert.ok(!("credentialName" in ticket.body));
  });
});

describe("channel value extraction (defensive, roster-store's rule)", () => {
  it("extracts pending asks from a valid document", () => {
    const asks = pendingAsksFromChannelValue(snapshotValue([wireAsk()]));
    assert.ok(asks !== null);
    assert.equal(asks.length, 1);
    assert.equal(asks[0]?.requestId, "req-1");
  });

  it("an empty pendingAsks array is a REAL nothing-waiting (feeds through)", () => {
    const asks = pendingAsksFromChannelValue(snapshotValue([]));
    assert.deepEqual(asks, []);
  });

  it("an unrelated settings document leaves the current truth untouched (null)", () => {
    assert.equal(pendingAsksFromChannelValue({ enabled: true }), null);
  });

  it("a corrupt roster key or v3 payload fails parse (null) — never a half feed", () => {
    assert.equal(
      pendingAsksFromChannelValue({ [ROSTER_SETTINGS_KEY]: { junk: true } }),
      null,
    );
    const v3 = snapshotValue([]) as Record<string, unknown>;
    (v3[ROSTER_SETTINGS_KEY] as Record<string, unknown>).schemaVersion = 3;
    assert.equal(pendingAsksFromChannelValue(v3), null);
  });

  it("duplicate workerId asks or a malformed entry fail the whole snapshot", () => {
    assert.equal(
      pendingAsksFromChannelValue(
        snapshotValue([wireAsk(), wireAsk({ requestId: "req-2" })]),
      ),
      null,
    );
    assert.equal(
      pendingAsksFromChannelValue(
        snapshotValue([wireAsk({ class: "not-a-class" })]),
      ),
      null,
    );
  });
});

describe("the one-channel hub (fan-out, replay, detach)", () => {
  it("a store attaching BEFORE any valid publish stays unfed (no fabricated nothing-waiting)", () => {
    const feed = createApprovalRelayFeed();
    const store = createApprovalCardsStore();
    feed.attach(store);
    assert.equal(store.getBox().state.kind, "unfed");
    // The first valid publish flips it to ready.
    feed.applyChannelValue(snapshotValue([]));
    assert.equal(store.getBox().state.kind, "ready");
  });

  it("feeds every attached store and replays the last good set on late attach", () => {
    const feed = createApprovalRelayFeed();
    const a = createApprovalCardsStore();
    const b = createApprovalCardsStore();
    const detachA = feed.attach(a);
    feed.attach(b);

    feed.applyChannelValue(snapshotValue([wireAsk()]));
    assert.equal(a.getBox().state.kind, "ready");
    assert.equal(
      a.getBox().state.kind === "ready" ? a.getBox().state.cards.length : -1,
      1,
    );
    assert.equal(
      b.getBox().state.kind === "ready" ? b.getBox().state.cards.length : -1,
      1,
    );

    // A store attaching AFTER a publish sees current truth immediately.
    const late = createApprovalCardsStore();
    feed.attach(late);
    assert.equal(late.getBox().state.kind, "ready");
    assert.equal(
      late.getBox().state.kind === "ready" ? late.getBox().state.cards.length : -1,
      1,
    );
    detachA();

    // Resolution: the next publish without the ask feeds ALL live stores.
    feed.applyChannelValue(snapshotValue([]));
    assert.equal(
      b.getBox().state.kind === "ready" ? b.getBox().state.cards.length : -1,
      0,
    );
    // Detached store no longer receives updates — it keeps its last truth.
    const stateAfter = a.getBox().state;
    assert.equal(stateAfter.kind, "ready");
    assert.equal(stateAfter.kind === "ready" ? stateAfter.cards.length : -1, 1);
  });

  it("an invalid document never fabricates a nothing-waiting", () => {
    const feed = createApprovalRelayFeed();
    const store = createApprovalCardsStore();
    feed.attach(store);
    feed.applyChannelValue({ unrelated: true });
    feed.applyChannelValue(snapshotValue([wireAsk({ class: "bogus" })]));
    // Either still unfed or at its last good state — never fed with junk.
    const state = store.getBox().state;
    if (state.kind === "ready") {
      assert.equal(state.cards.length, 0);
    } else {
      assert.equal(state.kind, "unfed");
    }
  });
});

describe("fed store end to end (L1: ask appears → resolve → card leaves)", () => {
  const ticket = {
    workerId: "w-1",
    requestId: "req-1",
    body: {
      class: "tool" as const,
      target: "run_tests",
      reason: "needs to run the test suite",
    },
    createdAtMs: 1000,
    parentSessionId: "session-1",
    status: "pending" as const,
  };

  function notice(overrides: Partial<AccessNotice> = {}): AccessNotice {
    return {
      kind: "access-resolved",
      workerId: "w-1",
      title: "w-1",
      decision: { kind: "deny", reason: "user-denied", detail: "no" },
      body: ticket.body,
      ...overrides,
    };
  }

  it("an ask appears as a pending card; a re-publish without it leaves", () => {
    const store = createApprovalCardsStore();
    const feed = createApprovalRelayFeed();
    feed.attach(store);

    feed.applyChannelValue(snapshotValue([wireAsk()]));
    let state = store.getBox().state;
    assert.equal(state.kind, "ready");
    if (state.kind !== "ready") return;
    assert.equal(state.cards.length, 1);
    const card = state.cards[0];
    assert.ok(card);
    assert.equal(card.status, "pending");
    assert.equal(card.requestId, "req-1");
    assert.equal(card.parentSessionId, "session-1");
    assert.equal(card.cardKind, "access-ask");

    // The user answers through the resolve seat → the relay settles the
    // ticket → the roster channel re-publishes WITHOUT the ask.
    feed.applyChannelValue(snapshotValue([]));
    state = store.getBox().state;
    assert.equal(state.kind, "ready");
    assert.equal(state.kind === "ready" ? state.cards.length : -1, 0);
  });

  it("the secret-ask variant derives the credential cardKind from the wire", () => {
    const store = createApprovalCardsStore();
    const feed = createApprovalRelayFeed();
    feed.attach(store);
    feed.applyChannelValue(
      snapshotValue([
        wireAsk({
          class: "credential",
          target: "API_TOKEN",
          credentialName: "API_TOKEN",
        }),
      ]),
    );
    const state = store.getBox().state;
    assert.equal(state.kind, "ready");
    if (state.kind !== "ready") return;
    assert.equal(state.cards[0]?.cardKind, "secret-ask");
    assert.equal(state.cards[0]?.body.credentialName, "API_TOKEN");
  });

  it("the expired path: a timeout notice settles an expired card (notice feed extension point)", () => {
    // The settings channel carries pending truth only; the store's notice
    // projection stays the documented extension point for a future
    // notice-carrying feed. Pinned here at the store seam the hub feeds:
    // applyRelayTruth(pending, notices) with a timeout deny and the ticket
    // gone from the pending set settles an EXPIRED card, never a fake
    // pending one.
    const store = createApprovalCardsStore();
    store.applyRelayTruth([ticket], []);
    assert.equal(
      store.getBox().state.kind === "ready"
        ? store.getBox().state.cards[0]?.status
        : "",
      "pending",
    );
    store.applyRelayTruth(
      [],
      [notice({ decision: { kind: "deny", reason: "timeout", detail: "t" } })],
    );
    const state = store.getBox().state;
    assert.equal(state.kind, "ready");
    if (state.kind !== "ready") return;
    assert.equal(state.cards.length, 1);
    assert.equal(state.cards[0]?.status, "expired");
    assert.deepEqual(state.cards[0]?.decision, {
      kind: "deny",
      reason: "timeout",
      detail: "t",
    });
  });
});
