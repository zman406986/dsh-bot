/**
 * Ticket 94 — the wrapper shell's per-session mirror feed (the live-found
 * missing reader).
 *
 * Live pass (2026-09-19): the shell store's `applySessionMirror`/
 * `applyPresence` had NO live call site, so `state.mirrors` stayed empty and
 * every session row rendered `data-dispatcher="false"` with the
 * `状态不可用` chip; the right pane hosted no roster panel; `data-presence`
 * never populated. This suite pins the feed that fixed it: the per-session
 * key extraction (`roster.<sessionId>`), the one-channel hub (fan-out,
 * attach replay, detach), and the honesty rules — corrupt payload →
 * unavailable, `null` → cleared, an unrelated document leaves the store
 * untouched, and the legacy whole-snapshot key is NOT replayed (it is never
 * cleared, so replaying it would resurrect a deactivated session's flag).
 *
 * Offline only (S8): pure data — no React, no DOM, no Cordis, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createShellMirrorFeed,
  sessionMirrorsFromChannelValue,
} from "../src/client/shell-mirror-feed.js";
import { createDispatcherShellStore } from "../src/client/shell-store.js";
import {
  ROSTER_SETTINGS_KEY,
  projectRosterSnapshot,
} from "../src/core/roster-snapshot.js";
import { rosterSessionKey } from "../src/adapter/roster-channel.js";

function snapshotFor(sessionId: string, publishedAtMs = 1000) {
  return projectRosterSnapshot(sessionId, [], publishedAtMs);
}

describe("ticket 94 — per-session mirror extraction", () => {
  it("reads only the dotted per-session family, keeping ids whole", () => {
    const a = snapshotFor("s-a");
    const dotted = snapshotFor("s.a.b");
    const mirrors = sessionMirrorsFromChannelValue({
      [ROSTER_SETTINGS_KEY]: snapshotFor("legacy"),
      [rosterSessionKey("s-a")]: a,
      [rosterSessionKey("s.a.b")]: dotted,
      enabled: true,
      accessRequestTimeoutMs: 120_000,
    });
    assert.deepEqual(
      mirrors?.map((mirror) => mirror.sessionId),
      ["s-a", "s.a.b"],
    );
    assert.equal(mirrors?.[0]?.value, a);
  });

  it("a non-object document yields null (nothing to read)", () => {
    assert.equal(sessionMirrorsFromChannelValue(null), null);
    assert.equal(sessionMirrorsFromChannelValue(undefined), null);
    assert.equal(sessionMirrorsFromChannelValue("roster"), null);
    // An object with no mirror key is a real "no mirrors", not a null read.
    assert.deepEqual(sessionMirrorsFromChannelValue({ enabled: true }), []);
  });
});

describe("ticket 94 — the one-channel hub", () => {
  it("fans one document out to every attached store", () => {
    const feed = createShellMirrorFeed();
    const one = createDispatcherShellStore();
    const two = createDispatcherShellStore();
    feed.attach(one);
    feed.attach(two);
    one.upsertSessions([{ sessionId: "s-1", title: "Chat" }]);
    two.upsertSessions([{ sessionId: "s-1", title: "Chat" }]);

    feed.applyChannelValue({
      [rosterSessionKey("s-1")]: snapshotFor("s-1"),
    });

    for (const store of [one, two]) {
      const state = store.getBox().state;
      assert.equal(state.rows.get("s-1")?.dispatcher, true);
      assert.equal(state.mirrors.get("s-1")?.kind, "snapshot");
    }
  });

  it("replays the last-known mirrors to a store that attaches later", () => {
    const feed = createShellMirrorFeed();
    feed.applyChannelValue({
      [rosterSessionKey("s-1")]: snapshotFor("s-1"),
    });

    // A mount created after the publish must not wait for a change that may
    // never come (the approvals-feed replay rule).
    const late = createDispatcherShellStore();
    late.upsertSessions([{ sessionId: "s-1", title: "Chat" }]);
    feed.attach(late);
    assert.equal(late.getBox().state.rows.get("s-1")?.dispatcher, true);
  });

  it("replays nothing before the first accepted document", () => {
    const feed = createShellMirrorFeed();
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-1", title: "Chat" }]);
    feed.attach(store);
    // No truth yet: the row keeps the feed's own claim (here: none).
    assert.equal(store.getBox().state.rows.get("s-1")?.dispatcher, false);
    assert.equal(store.getBox().state.mirrors.size, 0);
  });

  it("detaches exactly the store whose disposer ran", () => {
    const feed = createShellMirrorFeed();
    const detached = createDispatcherShellStore();
    const kept = createDispatcherShellStore();
    for (const store of [detached, kept]) {
      store.upsertSessions([{ sessionId: "s-1", title: "Chat" }]);
    }
    const detach = feed.attach(detached);
    feed.attach(kept);
    detach();

    feed.applyChannelValue({
      [rosterSessionKey("s-1")]: snapshotFor("s-1"),
    });
    assert.equal(detached.getBox().state.mirrors.size, 0);
    assert.equal(kept.getBox().state.mirrors.size, 1);
  });

  it("an unrelated / non-object document leaves every store untouched", () => {
    const feed = createShellMirrorFeed();
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-1", title: "Chat" }]);
    feed.attach(store);

    feed.applyChannelValue(null);
    feed.applyChannelValue("garbage");
    feed.applyChannelValue({ enabled: false, onboarding: {} });
    assert.equal(store.getBox().state.mirrors.size, 0);
    assert.equal(store.getBox().state.rows.get("s-1")?.dispatcher, false);
  });

  it("never replays the legacy whole-snapshot key (the resurrection guard)", () => {
    // Deactivation writes `null` under `roster.<sessionId>` but leaves the
    // legacy `roster` key holding the last snapshot (nothing clears it,
    // roster-channel.ts:162-170). Feeding that key would re-flag the
    // deactivated session — so the feed reads only the dotted family.
    const feed = createShellMirrorFeed();
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-1", title: "Chat" }]);
    feed.attach(store);

    feed.applyChannelValue({
      [ROSTER_SETTINGS_KEY]: snapshotFor("s-1"),
      [rosterSessionKey("s-1")]: snapshotFor("s-1"),
    });
    assert.equal(store.getBox().state.rows.get("s-1")?.dispatcher, true);

    // The host clears the session mirror on deactivation; the stale legacy
    // key is still in the document.
    feed.applyChannelValue({
      [ROSTER_SETTINGS_KEY]: snapshotFor("s-1"),
      [rosterSessionKey("s-1")]: null,
    });
    assert.equal(store.getBox().state.rows.get("s-1")?.dispatcher, false);
    assert.equal(store.getBox().state.mirrors.get("s-1")?.kind, "cleared");
    assert.equal(store.getBox().state.rows.get("s-1")?.presence, null);
  });

  it("a corrupt mirror payload flags the session but degrades presence honestly", () => {
    const feed = createShellMirrorFeed();
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-1", title: "Chat" }]);
    feed.attach(store);

    feed.applyChannelValue({
      [rosterSessionKey("s-1")]: { schemaVersion: 999, junk: true },
    });
    const state = store.getBox().state;
    assert.equal(state.rows.get("s-1")?.dispatcher, true);
    assert.equal(state.mirrors.get("s-1")?.kind, "unavailable");
    assert.equal(state.rows.get("s-1")?.presence, null);
  });

  it("a mirror for a session the feed has not delivered invents no row", () => {
    const feed = createShellMirrorFeed();
    const store = createDispatcherShellStore();
    feed.attach(store);
    feed.applyChannelValue({
      [rosterSessionKey("s-late")]: snapshotFor("s-late"),
    });
    assert.equal(store.getBox().state.rows.size, 0);
    // …and the moment the feed delivers the row, the mirror applies.
    store.upsertSessions([{ sessionId: "s-late", title: "Late chat" }]);
    assert.equal(store.getBox().state.rows.get("s-late")?.dispatcher, true);
  });
});
