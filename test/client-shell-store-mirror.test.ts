/**
 * Ticket 282 — the retained per-session mirror ingress must not attach
 * another session's snapshot to the key it arrived under.
 *
 * `applySessionMirror(sessionId, value)` takes a RAW settings value, so the
 * key/snapshot relation is the store's to enforce: `parseRosterSnapshot`
 * validates shape only and has no expected-session parameter. A parser-valid
 * v5 snapshot naming B must degrade A to the existing honest "unavailable"
 * state — key-derived `dispatcher` flag kept, presence/waiting/recentResult
 * null — whether A's row already exists or arrives later. Mirrors never
 * invent rows. Matching-ID snapshots and null/undefined clears stay unchanged.
 *
 * Offline store test (S8): no browser, host, network, or LLM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDispatcherShellStore,
  describeShellSidebar,
} from "../src/client/shell-store.js";
import {
  ROSTER_SNAPSHOT_SCHEMA_VERSION,
  type RosterSnapshot,
} from "../src/core/roster-snapshot.js";

const NOW_MS = 1_000;

/** One parser-valid v5 snapshot belonging to `dispatcherSessionId`. */
function snapshotFor(dispatcherSessionId: string): RosterSnapshot {
  return {
    schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
    dispatcherSessionId,
    publishedAtMs: NOW_MS,
    workers: [
      {
        kind: "worker",
        workerId: "w-result",
        title: "Result",
        status: "completed",
        todoId: "todo-1",
        startedAtMs: 900,
        toolCallCount: 1,
        delivered: false,
      },
    ],
    recentResult: {
      workerId: "w-result",
      title: "Result",
      text: "result excerpt",
    },
  };
}

describe("shell store — mirror session identity (ticket 282)", () => {
  it("degrades a mismatch to unavailable instead of caching another session's snapshot", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "A", title: "Session A" }]);
    store.applySessionMirror("A", snapshotFor("A"));

    const accepted = store.getBox().state.rows.get("A");
    assert.ok(accepted, "A's row exists");
    assert.deepEqual(accepted.presence, {
      working: 0,
      needsYou: 1,
      finished: 0,
    });
    assert.deepEqual(accepted.waiting, { kind: "landed" });
    assert.equal(accepted.recentResult?.text, "result excerpt");

    // B's snapshot arrives under A's key: misdelivered, not A's truth.
    store.applySessionMirror("A", snapshotFor("B"));

    const state = store.getBox().state;
    assert.equal(
      state.mirrors.get("A")?.kind,
      "unavailable",
      "B's snapshot is not accepted under A",
    );
    assert.equal(state.mirrors.has("B"), false, "the key is not relocated to B");

    const row = state.rows.get("A");
    assert.ok(row, "the mismatch never drops A's row");
    assert.equal(row.sessionId, "A");
    assert.equal(row.title, "Session A");
    assert.equal(row.dispatcher, true, "the key alone still flags one of ours");
    assert.equal(row.presence, null, "B's presence is never A's presence");
    assert.equal(row.waiting, null);
    assert.equal(row.recentResult, null);
    assert.equal(state.rows.has("B"), false, "mirrors never invent rows");
    assert.deepEqual(state.order, ["A"]);

    const sidebar = describeShellSidebar(state, NOW_MS);
    assert.equal(sidebar.kind, "ready");
    const viewA = sidebar.kind === "ready" ? sidebar.rows[0] : undefined;
    assert.ok(viewA);
    assert.equal(viewA.presenceAvailable, false, "honest unavailable chip");
  });

  it("keeps a pre-row mismatch inert and never seeds A when its row arrives", () => {
    const store = createDispatcherShellStore();
    store.applySessionMirror("A", snapshotFor("B"));

    const before = store.getBox().state;
    assert.deepEqual(before.order, [], "mirrors never invent rows");
    assert.equal(before.rows.has("A"), false);
    assert.equal(before.rows.has("B"), false);
    assert.equal(before.mirrors.get("A")?.kind, "unavailable");

    store.upsertSessions([{ sessionId: "A", title: "Session A" }]);

    const state = store.getBox().state;
    const row = state.rows.get("A");
    assert.ok(row);
    assert.equal(row.dispatcher, true);
    assert.equal(row.presence, null);
    assert.equal(row.waiting, null);
    assert.equal(row.recentResult, null);
    assert.deepEqual(state.order, ["A"]);
  });

  it("still accepts matching snapshots (before and after the row) and clears", () => {
    const store = createDispatcherShellStore();

    // Matching snapshot before the row: accepted, inert, then seeds on upsert.
    store.applySessionMirror("A", snapshotFor("A"));
    assert.equal(store.getBox().state.mirrors.get("A")?.kind, "snapshot");
    assert.equal(store.getBox().state.rows.has("A"), false);

    store.upsertSessions([{ sessionId: "A", title: "Session A" }]);
    let row = store.getBox().state.rows.get("A");
    assert.ok(row);
    assert.equal(row.dispatcher, true);
    assert.deepEqual(row.presence, { working: 0, needsYou: 1, finished: 0 });
    assert.deepEqual(row.waiting, { kind: "landed" });
    assert.equal(row.recentResult?.text, "result excerpt");

    // Matching snapshot after the row: same projection.
    store.applySessionMirror("A", snapshotFor("A"));
    row = store.getBox().state.rows.get("A");
    assert.ok(row);
    assert.deepEqual(row.presence, { working: 0, needsYou: 1, finished: 0 });

    // Host deactivation clear: plain row again, honest-empty presence.
    store.applySessionMirror("A", null);
    row = store.getBox().state.rows.get("A");
    assert.ok(row);
    assert.equal(store.getBox().state.mirrors.get("A")?.kind, "cleared");
    assert.equal(row.dispatcher, false);
    assert.equal(row.presence, null);

    // And undefined is the same clear verb.
    store.applySessionMirror("A", snapshotFor("A"));
    store.applySessionMirror("A", undefined);
    row = store.getBox().state.rows.get("A");
    assert.ok(row);
    assert.equal(store.getBox().state.mirrors.get("A")?.kind, "cleared");
    assert.equal(row.dispatcher, false);
    assert.equal(row.presence, null);
  });
});
