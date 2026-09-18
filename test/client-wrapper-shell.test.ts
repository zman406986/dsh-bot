/**
 * Ticket 77 — wrapper shell skeleton (ADR-0020 slice 1): the dispatcher-
 * session store, the pane logic, the token contract, and the locale copy.
 *
 * Offline only (S8): pure view-model/store assertions in the established
 * client-suite style. Component rendering stays covered by build success +
 * typecheck (same discipline as the panel and capsule). No live seam is
 * exercised: the sessions-feed binding is ticket 79, the conversation
 * surface is ticket 80, the frame election is ticket 78.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDispatcherShellStore,
  describePresence,
  describeRowPreview,
  describeShellPanes,
  describeShellSidebar,
  describeWaiting,
} from "../src/client/shell-store.js";
import {
  SHELL_CSS,
  SHELL_CLASS,
  SHELL_LAUNCHER_CSS,
  SHELL_LAUNCHER_CLASS,
  createDispatcherShell,
  describePresenceDot,
  waitingPhrase,
} from "../src/client/shell.js";
import {
  bindShellSessionsFeed,
  sessionsFeedInputs,
  type ShellFeedSnapshotLike,
} from "../src/client/shell-feed.js";
import {
  LOCALE_NAMESPACE,
  localeDictionary,
  validateLocaleDictionary,
} from "../src/client/overlay.js";
import type { RosterSnapshot } from "../src/core/roster-snapshot.js";
import type { WorkerStatus } from "../src/core/types.js";

/** A snapshot worker with honest defaults; overrides keep tests terse. */
function worker(
  workerId: string,
  status: WorkerStatus,
  overrides: Partial<{
    blocked: { class: string; target: string } | null;
    delivered: boolean;
  }> = {},
): RosterSnapshot["workers"][number] {
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

function snapshot(
  workers: RosterSnapshot["workers"],
  dispatcherSessionId = "s-dispatcher",
): RosterSnapshot {
  return {
    schemaVersion: 3,
    dispatcherSessionId,
    publishedAtMs: 1_000,
    workers,
    recentResult: null,
  };
}

describe("wrapper shell store — feed transitions (ticket 77)", () => {
  it("upserts new sessions in insertion order and updates known rows in place", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "s-1", title: "One", dispatcher: true },
      { sessionId: "s-2", title: "Two" },
    ]);
    store.upsertSessions([{ sessionId: "s-1", title: "One renamed" }]);
    const sidebar = describeShellSidebar(store.getBox().state);
    assert.equal(sidebar.kind, "ready");
    if (sidebar.kind !== "ready") return;
    assert.deepEqual(
      sidebar.rows.map((row) => [row.sessionId, row.title, row.dispatcher]),
      [
        ["s-1", "One renamed", true],
        ["s-2", "Two", false],
      ],
    );
  });

  it("refuses junk feed rows instead of normalizing them into sessions", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "", title: "ghost" },
      { sessionId: "s-ok", title: "Ok", dispatcher: true },
    ]);
    const sidebar = describeShellSidebar(store.getBox().state);
    assert.equal(sidebar.kind, "ready");
    if (sidebar.kind !== "ready") return;
    assert.deepEqual(
      sidebar.rows.map((row) => row.sessionId),
      ["s-ok"],
    );
  });

  it("removing a selected session resets the selection — never a dangling pane", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-1", title: "One", dispatcher: true }]);
    store.select("s-1");
    store.removeSessions(["s-1"]);
    const panes = describeShellPanes(store.getBox().state);
    assert.equal(panes.main.kind, "no-selection");
    assert.equal(panes.right.kind, "none");
  });

  it("select refuses unknown ids and no-op re-selects emit nothing", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-1", title: "One", dispatcher: true }]);
    store.select("s-unknown");
    assert.equal(store.getBox().state.selection.kind, "none");
    store.select("s-1");
    const version = store.getBox().version;
    store.select("s-1");
    assert.equal(store.getBox().version, version);
    assert.deepEqual(store.getBox().state.selection, {
      kind: "session",
      sessionId: "s-1",
    });
  });
});

describe("wrapper shell store — presence (ticket 77)", () => {
  it("attaches presence only to the session the snapshot names", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "s-a", title: "A", dispatcher: true },
      { sessionId: "s-b", title: "B" },
    ]);
    store.applyPresence(
      snapshot(
        [
          worker("w-1", "running"),
          worker("w-2", "completed", { delivered: false }),
          worker("w-3", "completed", { delivered: true }),
        ],
        "s-a",
      ),
    );
    const state = store.getBox().state;
    assert.deepEqual(state.rows.get("s-a")?.presence, {
      working: 1,
      needsYou: 1,
      finished: 1,
    });
    assert.equal(state.rows.get("s-b")?.presence, null);
  });

  it("a mirror for an unknown session touches no sibling row and applies when the feed delivers it", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-a", title: "A", dispatcher: true }]);
    store.applyPresence(snapshot([worker("w-1", "running")], "s-ghost"));
    // The sibling is untouched — presence for a ghost never leaks sideways.
    assert.equal(store.getBox().state.rows.get("s-a")?.presence, null);
    // The mirror is recorded (inert — mirrors never invent rows) and lands
    // the moment the feed delivers the named session.
    store.upsertSessions([{ sessionId: "s-ghost", title: "Ghost" }]);
    const ghost = store.getBox().state.rows.get("s-ghost");
    assert.equal(ghost?.dispatcher, true);
    assert.deepEqual(ghost?.presence, { working: 1, needsYou: 0, finished: 0 });
  });

  it("markPresenceUnavailable degrades honestly back to null", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-a", title: "A", dispatcher: true }]);
    store.applyPresence(snapshot([worker("w-1", "running")], "s-a"));
    assert.deepEqual(store.getBox().state.rows.get("s-a")?.presence, {
      working: 1,
      needsYou: 0,
      finished: 0,
    });
    store.markPresenceUnavailable("s-a");
    assert.equal(store.getBox().state.rows.get("s-a")?.presence, null);
  });

  it("describePresence follows the panel's partition rule exactly", () => {
    // blocked outranks landed; terminal-undelivered is needs-you; aborted is
    // terminal (finished when delivered) — the same semantics as the panel.
    const counts = describePresence(
      snapshot([
        worker("w-1", "running"),
        worker("w-2", "steering"),
        worker("w-3", "completed", {
          delivered: false,
          blocked: { class: "tool", target: "shell" },
        }),
        worker("w-4", "completed", { delivered: false }),
        worker("w-5", "aborted", { delivered: true }),
        worker("w-6", "error", { delivered: true }),
      ]),
    );
    assert.deepEqual(counts, { working: 2, needsYou: 2, finished: 2 });
  });
});

describe("wrapper shell sidebar view (ticket 77)", () => {
  it("is empty when no sessions arrived", () => {
    const store = createDispatcherShellStore();
    assert.deepEqual(describeShellSidebar(store.getBox().state), {
      kind: "empty",
    });
  });

  it("orders dispatcher rows first, then the rest, stably", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "s-1", title: "plain one" },
      { sessionId: "s-2", title: "dispatch two", dispatcher: true },
      { sessionId: "s-3", title: "plain three" },
      { sessionId: "s-4", title: "dispatch four", dispatcher: true },
    ]);
    const sidebar = describeShellSidebar(store.getBox().state);
    assert.equal(sidebar.kind, "ready");
    if (sidebar.kind !== "ready") return;
    assert.deepEqual(
      sidebar.rows.map((row) => row.sessionId),
      ["s-2", "s-4", "s-1", "s-3"],
    );
  });

  it("flags exactly the selected row", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "s-1", title: "One", dispatcher: true },
      { sessionId: "s-2", title: "Two", dispatcher: true },
    ]);
    store.select("s-2");
    const sidebar = describeShellSidebar(store.getBox().state);
    if (sidebar.kind !== "ready") return assert.fail("expected ready");
    assert.deepEqual(
      sidebar.rows.map((row) => row.selected),
      [false, true],
    );
  });
});

describe("wrapper shell panes (ticket 77)", () => {
  it("no selection: both panes empty", () => {
    const store = createDispatcherShellStore();
    assert.deepEqual(describeShellPanes(store.getBox().state), {
      main: { kind: "no-selection" },
      right: { kind: "none" },
    });
  });

  it("selected session: honest pending main surface + hosted-roster right seat", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-1", title: "One", dispatcher: true }]);
    store.select("s-1");
    assert.deepEqual(describeShellPanes(store.getBox().state), {
      main: { kind: "conversation-pending", sessionId: "s-1" },
      right: { kind: "hosted-roster", sessionId: "s-1" },
    });
  });
});

describe("wrapper shell CSS contract (ticket 77, ticket 49's discipline)", () => {
  // Ticket 78 adds the staging launcher chip's stylesheet beside SHELL_CSS.
  const SURFACES = [
    { css: SHELL_CSS, cls: SHELL_CLASS },
    { css: SHELL_LAUNCHER_CSS, cls: SHELL_LAUNCHER_CLASS },
  ] as const;

  for (const { css, cls } of SURFACES) {
    const tokens = [
      ...new Set(
        [...css.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((m) => m[1]!),
      ),
    ].sort();

    it(`${cls}: carries no raw colour literal — every colour is a host token`, () => {
      assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "hex literal");
      assert.doesNotMatch(css, /(?<![a-z])rgba?\(/, "rgb()/rgba() literal");
      assert.doesNotMatch(css, /hsla?\(/, "hsl() literal");
      assert.ok(tokens.length > 0, "no tokens referenced at all");
    });

    it(`${cls}: uses only tokens already evidenced by our shipped surfaces/notes`, () => {
      const allowed = new Set([
        "--dsw-alias-bg-layer-1",
        // The launcher chip borrows the capsule chip's surface vocabulary.
        "--dsw-alias-label-primary",
        "--dsw-alias-bg-layer-3",
        "--dsw-alias-border-l3",
        "--dsw-alias-label-tertiary",
        "--dsw-alias-state-business-primary",
        "--dsw-alias-state-success-primary",
        "--dsw-alias-state-warn-primary",
      ]);
      for (const token of tokens) {
        assert.ok(
          allowed.has(token),
          `token ${token} is not in the evidenced set`,
        );
      }
    });

    it(`${cls}: namespaces every class and ships no animation at all`, () => {
      const foreign = [
        ...css.matchAll(/\.([a-z-][a-z0-9_-]*)/g),
      ]
        .map((m) => m[1]!)
        .filter((name) => !name.startsWith("multitask-dispatcher-"));
      assert.deepEqual(foreign, []);
      assert.doesNotMatch(css, /@keyframes|animation:/);
    });
  }

  it("the shell frame stylesheet opens with the frame class", () => {
    assert.match(SHELL_CSS.trim(), new RegExp(`^\\.${SHELL_CLASS}\\{`));
  });

  it("the launcher self-positions inside the click-through overlay layer", () => {
    // Verified overlay anatomy (dsh-capsule-seams.md Seam 1): entries
    // self-position; the launcher sits below the capsule chip (top:8px).
    assert.match(
      SHELL_LAUNCHER_CSS.trim(),
      new RegExp(`^\\.${SHELL_LAUNCHER_CLASS}\\{position:absolute;`),
    );
  });
});

describe("wrapper shell locale + wiring (ticket 77)", () => {
  const shellKeys = Object.keys(localeDictionary.en).filter((key) =>
    key.startsWith("shell."),
  );

  it("adds shell copy keys to BOTH faces and keeps the dictionary valid", () => {
    assert.ok(shellKeys.length >= 9, "shell.* copy keys missing");
    for (const key of shellKeys) {
      assert.ok(key in localeDictionary.zh, `${key} missing from zh face`);
    }
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
  });

  it("stays inside our locale namespace discipline", () => {
    for (const key of shellKeys) {
      assert.match(key, /^shell\.[a-z0-9.-]+$/);
    }
    assert.equal(LOCALE_NAMESPACE, "multitask-dispatcher");
  });

  it("exposes a component factory bound to store + hosts (wiring smoke)", () => {
    const store = createDispatcherShellStore();
    const component = createDispatcherShell(
      (key) => localeDictionary.en[key] ?? key,
      store,
      { rosterPanel: () => null },
    );
    assert.equal(typeof component, "function");
  });
});

describe("wrapper shell per-session mirrors (ticket 79, ADR-0019 keying)", () => {
  it("applySessionMirror flags the session and derives presence from the raw value", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-a", title: "A" }]);
    store.applySessionMirror(
      "s-a",
      snapshot(
        [
          worker("w-1", "running"),
          worker("w-2", "completed", { delivered: false }),
        ],
        "s-a",
      ),
    );
    const row = store.getBox().state.rows.get("s-a");
    assert.equal(row?.dispatcher, true);
    assert.deepEqual(row?.presence, { working: 1, needsYou: 1, finished: 0 });
    assert.equal(row?.waiting?.kind, "landed");
  });

  it("per-session isolation: each mirror lands only on its own session", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "s-a", title: "A" },
      { sessionId: "s-b", title: "B" },
    ]);
    store.applySessionMirror("s-a", snapshot([worker("w-1", "running")], "s-a"));
    store.applySessionMirror(
      "s-b",
      snapshot(
        [worker("w-2", "error", { delivered: true })],
        "s-b",
      ),
    );
    const state = store.getBox().state;
    assert.deepEqual(state.rows.get("s-a")?.presence, {
      working: 1,
      needsYou: 0,
      finished: 0,
    });
    assert.deepEqual(state.rows.get("s-b")?.presence, {
      working: 0,
      needsYou: 0,
      finished: 1,
    });
    assert.equal(state.mirrors.get("s-a")?.kind, "snapshot");
    assert.equal(state.mirrors.get("s-b")?.kind, "snapshot");
  });

  it("a cleared mirror (null) drops the dispatcher flag — deactivation honesty", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-a", title: "A" }]);
    store.applySessionMirror("s-a", snapshot([worker("w-1", "running")], "s-a"));
    assert.equal(store.getBox().state.rows.get("s-a")?.dispatcher, true);
    store.applySessionMirror("s-a", null);
    const row = store.getBox().state.rows.get("s-a");
    assert.equal(row?.dispatcher, false);
    assert.equal(row?.presence, null);
  });

  it("a corrupt mirror value flags the session but degrades presence, never a wrong roster", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-a", title: "A" }]);
    store.applySessionMirror("s-a", { schemaVersion: 2, junk: true });
    const row = store.getBox().state.rows.get("s-a");
    // The key EXISTS, so the session is ours — but the payload failed
    // fail-closed parse: "unavailable", never fabricated counters.
    assert.equal(row?.dispatcher, true);
    assert.equal(row?.presence, null);
    assert.equal(store.getBox().state.mirrors.get("s-a")?.kind, "unavailable");
  });

  it("a mirror signal outranks the feed's dispatcher claim in both directions", () => {
    const store = createDispatcherShellStore();
    // Feed claims true before any mirror: the claim stands.
    store.upsertSessions([
      { sessionId: "s-claim", title: "Claim", dispatcher: true },
      { sessionId: "s-plain", title: "Plain" },
    ]);
    assert.equal(store.getBox().state.rows.get("s-claim")?.dispatcher, true);
    // A cleared mirror overrides the claim.
    store.applySessionMirror("s-claim", null);
    assert.equal(store.getBox().state.rows.get("s-claim")?.dispatcher, false);
    // A snapshot mirror overrides plain.
    store.applySessionMirror("s-plain", snapshot([worker("w-1", "running")], "s-plain"));
    assert.equal(store.getBox().state.rows.get("s-plain")?.dispatcher, true);
  });

  it("describeWaiting follows the marker precedence: blocked outranks landed", () => {
    const blocked = describeWaiting(
      snapshot([
        worker("w-1", "completed", { delivered: false }),
        worker("w-2", "running", {
          blocked: { class: "tool", target: "shell" },
        }),
      ]),
    );
    assert.equal(blocked?.kind, "blocked");
    if (blocked?.kind !== "blocked") return;
    assert.deepEqual(blocked.blocked, { class: "tool", target: "shell" });
    // Landed alone still marks.
    assert.equal(
      describeWaiting(snapshot([worker("w-3", "completed", { delivered: false })]))
        ?.kind,
      "landed",
    );
    // Nothing owed: no marker.
    assert.equal(describeWaiting(snapshot([worker("w-4", "running")])), null);
  });

  it("junk mirror ids are refused", () => {
    const store = createDispatcherShellStore();
    store.applySessionMirror("", snapshot([], "s-x"));
    assert.equal(store.getBox().state.mirrors.size, 0);
  });
});

describe("wrapper shell staleness + failure states (ticket 79)", () => {
  it("an aged snapshot renders presence-unavailable at view time, without a push", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-a", title: "A" }]);
    store.applySessionMirror("s-a", snapshot([worker("w-1", "running")], "s-a"));
    // Exactly at the window counts as fresh; beyond it is stale (the panel's
    // one stale rule, shared window).
    const fresh = describeShellSidebar(store.getBox().state, 61_000);
    if (fresh.kind !== "ready") return assert.fail("expected ready");
    assert.equal(fresh.rows[0]?.presenceAvailable, true);
    const stale = describeShellSidebar(store.getBox().state, 61_001);
    if (stale.kind !== "ready") return assert.fail("expected ready");
    assert.equal(stale.rows[0]?.presenceAvailable, false);
    // The dispatcher flag is NOT freshness-dependent.
    assert.equal(stale.rows[0]?.dispatcher, true);
  });

  it("without a render clock nothing is declared stale (offline view models)", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-a", title: "A" }]);
    store.applySessionMirror("s-a", snapshot([worker("w-1", "running")], "s-a"));
    const view = describeShellSidebar(store.getBox().state);
    if (view.kind !== "ready") return assert.fail("expected ready");
    assert.equal(view.rows[0]?.presenceAvailable, true);
  });

  it("failure states are retry-less: the CSS ships no retry control and no banner", () => {
    // The only interactive element class in the shell CSS is the row button
    // itself — no retry/refresh control exists to offer (U-A: no reconnect
    // model; see ticket 82 for the ADR-0020 row tension).
    const buttonClasses = [
      ...SHELL_CSS.matchAll(/\.multitask-dispatcher-shell__[a-z-]+(?=\{)/g),
    ]
      .map((m) => m[0])
      .filter((cls) => /retry|refresh|reconnect|banner/.test(cls));
    assert.deepEqual(buttonClasses, []);
    // And the copy vocabulary has no retry beat.
    for (const key of Object.keys(localeDictionary.en)) {
      if (!key.startsWith("shell.")) continue;
      const copy = localeDictionary.en[key]?.toLowerCase() ?? "";
      assert.doesNotMatch(copy, /retry|reconnect/, `${key} suggests a retry`);
    }
  });

  it("attention markers stay pull-only: the shell vocabulary has no push surface", () => {
    for (const key of Object.keys(localeDictionary.en)) {
      if (!key.startsWith("shell.")) continue;
      const copy = localeDictionary.en[key]?.toLowerCase() ?? "";
      assert.doesNotMatch(
        copy,
        /notif|toast|alert|push/,
        `${key} simulates a push channel`,
      );
    }
  });
});

describe("wrapper shell row presence + preview (ticket 79)", () => {
  it("describePresenceDot aggregates the session to one dot state", () => {
    assert.equal(describePresenceDot({ presence: null, presenceAvailable: false }), "unavailable");
    assert.equal(
      describePresenceDot({
        presence: { working: 1, needsYou: 0, finished: 0 },
        presenceAvailable: true,
      }),
      "working",
    );
    // Needs-you outranks finished (the user is on the hook first).
    assert.equal(
      describePresenceDot({
        presence: { working: 0, needsYou: 1, finished: 2 },
        presenceAvailable: true,
      }),
      "needs-you",
    );
    assert.equal(
      describePresenceDot({
        presence: { working: 0, needsYou: 0, finished: 2 },
        presenceAvailable: true,
      }),
      "finished",
    );
    // A live snapshot with nothing in any section is idle, not unavailable.
    assert.equal(
      describePresenceDot({
        presence: { working: 0, needsYou: 0, finished: 0 },
        presenceAvailable: true,
      }),
      "idle",
    );
  });

  it("waitingPhrase reuses the shared roster copy (one vocabulary, not a second)", () => {
    const t = (key: string) => localeDictionary.en[key] ?? key;
    const phrase = waitingPhrase(t, {
      kind: "blocked",
      blocked: { class: "tool", target: "shell" },
    });
    assert.equal(phrase, 'Waiting for your approval: use the tool "shell"');
    assert.equal(waitingPhrase(t, { kind: "landed" }), "Result ready — not delivered yet");
  });

  it("describeRowPreview follows waiting > last entry, and the draft tier is a recorded gap", () => {
    // Waiting reason wins over the excerpt.
    const waiting = describeRowPreview(
      {
        waiting: { kind: "blocked", blocked: { class: "tool", target: "sh" } },
        recentResult: { workerId: "w-1", title: "W", text: "done text" },
      },
      true,
    );
    assert.equal(waiting?.kind, "waiting");
    // No waiting marker: the last-entry tier renders the wire-truth excerpt.
    const excerpt = describeRowPreview(
      { waiting: null, recentResult: { workerId: "w-1", title: "W", text: "done text" } },
      true,
    );
    assert.deepEqual(excerpt, { kind: "excerpt", text: "done text" });
    // Neither tier has data: no preview (and no invented draft tier —
    // per-agent drafts are U-B-excluded, so the tier is skipped, not faked).
    assert.equal(describeRowPreview({ waiting: null, recentResult: null }, true), null);
    // A stale/corrupt feed must not keep previewing old content.
    assert.equal(
      describeRowPreview(
        { waiting: null, recentResult: { workerId: "w", title: "W", text: "x" } },
        false,
      ),
      null,
    );
  });
});

describe("wrapper shell sessions-feed projection + binding (ticket 79)", () => {
  const feedRow = (
    id: string,
    overrides: Partial<{ displayTitle: string; title: string; origin: string }> = {},
  ) => ({ id, ...overrides });

  it("projects ids+byId into store inputs with the host's displayTitle", () => {
    const feed: ShellFeedSnapshotLike = {
      ids: ["s-1", "s-2", "s-3"],
      byId: {
        "s-1": feedRow("s-1", { displayTitle: "Build the thing" }),
        "s-2": feedRow("s-2", { title: "fallback title" }),
        // s-3 deliberately has no row yet (host stream lag).
      },
    };
    assert.deepEqual(sessionsFeedInputs(feed), [
      { sessionId: "s-1", title: "Build the thing" },
      { sessionId: "s-2", title: "fallback title" },
    ]);
  });

  it("falls back to the raw id for the title and excludes subagent (worker) rows", () => {
    const feed: ShellFeedSnapshotLike = {
      ids: ["s-plain", "w-child"],
      byId: {
        "s-plain": feedRow("s-plain"),
        "w-child": feedRow("w-child", { displayTitle: "worker run", origin: "subagent" }),
      },
    };
    assert.deepEqual(sessionsFeedInputs(feed), [
      { sessionId: "s-plain", title: "s-plain" },
    ]);
  });

  it("projects nothing from a malformed snapshot (no ids array)", () => {
    assert.deepEqual(sessionsFeedInputs({}), []);
    assert.deepEqual(sessionsFeedInputs({ ids: "not-an-array" as never }), []);
  });

  function fakeFeed(initial: ShellFeedSnapshotLike) {
    const listeners = new Set<() => void>();
    let snapshotValue = initial;
    return {
      sessions: {
        list: {
          getSnapshot: () => snapshotValue,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
      set(next: ShellFeedSnapshotLike) {
        snapshotValue = next;
        for (const listener of [...listeners]) listener();
      },
      listenerCount: () => listeners.size,
    };
  }

  it("binds the feed: initial sync, live upserts, and removal syncs", () => {
    const fake = fakeFeed({
      ids: ["s-1"],
      byId: { "s-1": feedRow("s-1", { displayTitle: "One" }) },
    });
    const store = createDispatcherShellStore();
    const binding = bindShellSessionsFeed(store, fake.sessions);
    assert.deepEqual(store.getBox().state.order, ["s-1"]);

    // Live upsert.
    fake.set({
      ids: ["s-1", "s-2"],
      byId: {
        "s-1": feedRow("s-1", { displayTitle: "One" }),
        "s-2": feedRow("s-2", { displayTitle: "Two" }),
      },
    });
    assert.deepEqual(store.getBox().state.order, ["s-1", "s-2"]);

    // Feed removal: the row the host dropped leaves the store, and a
    // selected dangling row resets the selection.
    store.select("s-2");
    fake.set({ ids: ["s-1"], byId: { "s-1": feedRow("s-1", { displayTitle: "One" }) } });
    assert.deepEqual(store.getBox().state.order, ["s-1"]);
    assert.equal(store.getBox().state.selection.kind, "none");

    binding.dispose();
    assert.equal(fake.listenerCount(), 0);
  });

  it("a malformed feed snapshot never wipes the roster", () => {
    const fake = fakeFeed({
      ids: ["s-1"],
      byId: { "s-1": feedRow("s-1", { displayTitle: "One" }) },
    });
    const store = createDispatcherShellStore();
    const binding = bindShellSessionsFeed(store, fake.sessions);
    fake.set({ ids: undefined, byId: undefined });
    assert.deepEqual(store.getBox().state.order, ["s-1"]);
    binding.dispose();
  });

  it("open() rides the store guard: known ids select + notify, unknown ids do neither", () => {
    const fake = fakeFeed({
      ids: ["s-1"],
      byId: { "s-1": feedRow("s-1", { displayTitle: "One" }) },
    });
    const store = createDispatcherShellStore();
    const opened: string[] = [];
    const binding = bindShellSessionsFeed(store, fake.sessions, {
      onOpen: (id) => opened.push(id),
    });
    binding.open("s-unknown");
    assert.deepEqual(opened, []);
    assert.equal(store.getBox().state.selection.kind, "none");
    binding.open("s-1");
    assert.deepEqual(store.getBox().state.selection, {
      kind: "session",
      sessionId: "s-1",
    });
    assert.deepEqual(opened, ["s-1"]);
    binding.dispose();
  });

  it("binds a feed without subscribe (sync once, degrade honestly)", () => {
    const store = createDispatcherShellStore();
    const binding = bindShellSessionsFeed(store, {
      list: {
        getSnapshot: () => ({
          ids: ["s-9"],
          byId: { "s-9": feedRow("s-9", { displayTitle: "Nine" }) },
        }),
      },
    });
    assert.deepEqual(store.getBox().state.order, ["s-9"]);
    binding.dispose();
  });
});
