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
  describeShellPanes,
  describeShellSidebar,
} from "../src/client/shell-store.js";
import { SHELL_CSS, SHELL_CLASS } from "../src/client/shell.js";
import { createDispatcherShell } from "../src/client/shell.js";
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

  it("refuses presence for an unknown session instead of attaching it", () => {
    const store = createDispatcherShellStore();
    store.upsertSessions([{ sessionId: "s-a", title: "A", dispatcher: true }]);
    store.applyPresence(snapshot([worker("w-1", "running")], "s-ghost"));
    assert.equal(store.getBox().state.rows.get("s-a")?.presence, null);
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
  const tokens = [
    ...new Set(
      [...SHELL_CSS.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((m) => m[1]!),
    ),
  ].sort();

  it("carries no raw colour literal — every colour is a host token", () => {
    assert.doesNotMatch(SHELL_CSS, /#[0-9a-fA-F]{3,8}\b/, "hex literal");
    assert.doesNotMatch(SHELL_CSS, /(?<![a-z])rgba?\(/, "rgb()/rgba() literal");
    assert.doesNotMatch(SHELL_CSS, /hsla?\(/, "hsl() literal");
    assert.ok(tokens.length > 0, "no tokens referenced at all");
  });

  it("uses only tokens already evidenced by our shipped surfaces/notes", () => {
    const allowed = new Set([
      "--dsw-alias-bg-layer-1",
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

  it("namespaces every class and ships no animation at all", () => {
    assert.match(SHELL_CSS.trim(), new RegExp(`^\\.${SHELL_CLASS}\\{`));
    const foreign = [
      ...SHELL_CSS.matchAll(/\.([a-z-][a-z0-9_-]*)/g),
    ]
      .map((m) => m[1]!)
      .filter((name) => !name.startsWith("multitask-dispatcher-"));
    assert.deepEqual(foreign, []);
    assert.doesNotMatch(SHELL_CSS, /@keyframes|animation:/);
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
