/**
 * DORMANT shell mirror feed: one accepted channel value fanned out to every
 * attached store, last-known truth replayed to a later attachment, and a
 * per-store detach disposer (S8: pure data, no host or browser).
 *
 * Regression (ticket 283): a synchronous store subscriber may reenter the
 * feed while fanout is suspended mid-iteration. The nested publication is the
 * newer accepted truth and has already reached every attached store, so the
 * suspended outer publication must stop instead of writing its stale entries
 * into a store the nested call already cleared.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createShellMirrorFeed } from "../src/client/shell-mirror-feed.js";
import {
  createDispatcherShellStore,
  type DispatcherShellStore,
} from "../src/client/shell-store.js";

const SESSION_ID = "s";

/** The store's current mirror for one session, or undefined when absent. */
function mirrorOf(store: DispatcherShellStore, sessionId: string) {
  return store.getBox().state.mirrors.get(sessionId);
}

describe("shell mirror feed", () => {
  it("does not let a suspended outer fanout overwrite a reentrant clear", () => {
    const feed = createShellMirrorFeed();
    const storeA = createDispatcherShellStore();
    const storeB = createDispatcherShellStore();
    feed.attach(storeA);
    feed.attach(storeB);

    let reentered = false;
    const detach = storeA.subscribe(() => {
      if (reentered) return;
      if (mirrorOf(storeA, SESSION_ID)?.kind !== "unavailable") return;
      reentered = true;
      detach();
      // The newer accepted value: a clear for the same session.
      feed.applyChannelValue({ "roster.s": null });
    });

    // The outer publication applies to A first, notifies its subscriber, and
    // is suspended while the nested clear fans out to A and B.
    feed.applyChannelValue({ "roster.s": {} });

    assert.equal(reentered, true);
    assert.deepEqual(mirrorOf(storeA, SESSION_ID), { kind: "cleared" });
    assert.deepEqual(
      mirrorOf(storeB, SESSION_ID),
      { kind: "cleared" },
      "the stale outer fanout must not overwrite the newer clear in a store it had not reached yet",
    );

    const storeC = createDispatcherShellStore();
    feed.attach(storeC);
    assert.deepEqual(
      mirrorOf(storeC, SESSION_ID),
      { kind: "cleared" },
      "a late attachment must replay the newer clear",
    );
  });

  it("keeps sequential last-wins publication, replay, and per-store detach", () => {
    const feed = createShellMirrorFeed();
    const storeA = createDispatcherShellStore();
    const storeB = createDispatcherShellStore();
    const detachA = feed.attach(storeA);
    feed.attach(storeB);

    // Raw values keep the store's own classification: junk → unavailable,
    // null → cleared; the later publication wins.
    feed.applyChannelValue({ "roster.s": {} });
    assert.deepEqual(mirrorOf(storeA, SESSION_ID), { kind: "unavailable" });
    feed.applyChannelValue({ "roster.s": null });
    assert.deepEqual(mirrorOf(storeA, SESSION_ID), { kind: "cleared" });
    assert.deepEqual(mirrorOf(storeB, SESSION_ID), { kind: "cleared" });

    const storeC = createDispatcherShellStore();
    feed.attach(storeC);
    assert.deepEqual(
      mirrorOf(storeC, SESSION_ID),
      { kind: "cleared" },
      "a late attachment replays the last-known truth",
    );

    detachA();
    feed.applyChannelValue({ "roster.s": {} });
    assert.deepEqual(
      mirrorOf(storeA, SESSION_ID),
      { kind: "cleared" },
      "a detached store receives no later publications",
    );
    assert.deepEqual(mirrorOf(storeB, SESSION_ID), { kind: "unavailable" });
  });
});
