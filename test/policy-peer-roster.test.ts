import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendPeerRosterTail,
  assembleTurnReminder,
  buildPeerRosterSnapshot,
  derivePeerLiveness,
  PEER_LIVENESS_STATES,
  PEER_ROSTER_MAX_ROWS,
  renderPeerRoster,
  type PeerRosterEntry,
  type PeerRosterSnapshot,
} from "../src/core/policy/assembler.js";
import {
  PEER_ROSTER_INTRO,
  PEER_ROSTER_SECTION_HEADING,
  PEER_WAKE_SECTION_HEADINGS,
} from "../src/core/policy/prompts.js";
import { TOOL_RESULT_SUMMARY_MAX_ROWS } from "../src/core/report-clamp.js";
import type { TodoItem } from "../src/core/todo-reconciler.js";

/**
 * Ticket 121 / ADR-0027: the peer roster rides the prompt TAIL.
 *
 * What these tests pin, in order of importance:
 * 1. Tail placement + prefix byte-stability. The text before the roster
 *    section is identical with 0 and with 20 peers, so the cached prompt
 *    prefix cannot be invalidated by the roster's presence.
 * 2. Byte-stability for an unchanged roster: two renders of the same state
 *    are identical, and insertion order does not matter.
 * 3. Boundedness: the check-roster cap (20 rows) plus an explicit overflow
 *    count, never a truncated row that looks complete.
 * 4. Honest degradation: unknown statuses and malformed rows render
 *    `unknown` / are skipped; nothing throws; no invented state.
 */

function peer(overrides: Partial<PeerRosterEntry> & { sessionId: string }): PeerRosterEntry {
  return { ...overrides };
}

function snapshot(peers: readonly PeerRosterEntry[]): PeerRosterSnapshot {
  return { peers };
}

function todo(overrides: Partial<TodoItem> & { id: string }): TodoItem {
  return {
    sessionId: "session-1",
    title: "Task",
    status: "pending",
    streamKey: null,
    workerId: null,
    delivered: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

describe("renderPeerRoster — empty and absent state", () => {
  it("empty roster → null (never an empty heading)", () => {
    assert.equal(renderPeerRoster({ peers: [] }), null);
    assert.equal(renderPeerRoster(null), null);
    assert.equal(renderPeerRoster(undefined), null);
  });

  it("a roster containing only self → null", () => {
    const text = renderPeerRoster({
      peers: [peer({ sessionId: "s-1" })],
      selfSessionId: "s-1",
    });
    assert.equal(text, null);
  });

  it("adding an empty roster leaves the reminder byte-identical", () => {
    const todos = [todo({ id: "t-1", status: "in_progress" })];
    const base = assembleTurnReminder(todos);
    assert.equal(assembleTurnReminder(todos, { peers: [] }), base);
    assert.equal(assembleTurnReminder(todos, null), base);
    assert.ok(!base.includes(PEER_ROSTER_SECTION_HEADING));
  });
});

describe("renderPeerRoster — one row", () => {
  it("renders label, session id, liveness, and the activity phrase", () => {
    const text = renderPeerRoster(
      snapshot([
        peer({
          sessionId: "sess-abc",
          label: "Research scout",
          liveness: "working",
          activity: "grep: token budget",
        }),
      ]),
    );
    assert.ok(text !== null);
    assert.equal(
      text,
      [
        PEER_ROSTER_SECTION_HEADING,
        "",
        PEER_ROSTER_INTRO,
        "",
        "- Research scout (sess-abc) — working · grep: token budget",
      ].join("\n"),
    );
  });

  it("falls back label → title → session id", () => {
    const titled = renderPeerRoster(
      snapshot([
        peer({ sessionId: "s-2", title: "Changelog", liveness: "idle" }),
      ]),
    );
    assert.ok(titled !== null);
    assert.ok(titled.includes("- Changelog (s-2) — idle"));

    const bare = renderPeerRoster(
      snapshot([peer({ sessionId: "s-3", liveness: "waiting" })]),
    );
    assert.ok(bare !== null);
    assert.ok(bare.includes("- s-3 — waiting"));
  });

  it("renders the explicit tool/target pair when no ring phrase exists", () => {
    const text = renderPeerRoster(
      snapshot([
        peer({
          sessionId: "s-4",
          liveness: "working",
          currentTool: "read",
          currentTarget: "src/core/policy",
        }),
      ]),
    );
    assert.ok(text !== null);
    assert.ok(text.includes("— working · using read on src/core/policy"));
  });

  it("says nothing beyond the status when no activity was observed", () => {
    const text = renderPeerRoster(
      snapshot([peer({ sessionId: "s-5", liveness: "idle" })]),
    );
    assert.ok(text !== null);
    assert.ok(text.includes("- s-5 — idle"));
    assert.ok(!text.includes("idle ·"));
  });

  it("keeps one row to one line even with multi-line input", () => {
    const text = renderPeerRoster(
      snapshot([
        peer({
          sessionId: "s-6",
          label: "Line\nbreak",
          liveness: "working",
          activity: "grep:\n  spaced\tout",
        }),
      ]),
    );
    assert.ok(text !== null);
    const row = text.split("\n").find((line) => line.startsWith("- "));
    assert.equal(row, "- Line break (s-6) — working · grep: spaced out");
  });
});

describe("renderPeerRoster — determinism and byte-stability", () => {
  it("same state, different insertion order → identical text", () => {
    const a = peer({ sessionId: "s-b", liveness: "working", activity: "bash: b" });
    const b = peer({ sessionId: "s-a", liveness: "idle" });
    const c = peer({ sessionId: "s-c", liveness: "approval" });
    assert.equal(
      renderPeerRoster(snapshot([a, b, c])),
      renderPeerRoster(snapshot([c, a, b])),
    );
  });

  it("two consecutive renders of the same state are byte-identical", () => {
    const state = snapshot([
      peer({ sessionId: "s-2", liveness: "waiting", activity: "read: x" }),
      peer({ sessionId: "s-1", liveness: "working", activity: "edit: y" }),
    ]);
    assert.equal(renderPeerRoster(state), renderPeerRoster(state));
  });

  it("duplicate session ids collapse to one row", () => {
    const text = renderPeerRoster(
      snapshot([
        peer({ sessionId: "s-1", liveness: "working" }),
        peer({ sessionId: "s-1", liveness: "idle" }),
      ]),
    );
    assert.ok(text !== null);
    assert.equal(text.split("\n").filter((l) => l.startsWith("- ")).length, 1);
  });
});

describe("renderPeerRoster — bound", () => {
  it("the cap reuses the shipped check-roster row convention", () => {
    assert.equal(PEER_ROSTER_MAX_ROWS, TOOL_RESULT_SUMMARY_MAX_ROWS);
    assert.equal(PEER_ROSTER_MAX_ROWS, 20);
  });

  it("over cap → the cap's rows plus an explicit total/shown count", () => {
    const peers = Array.from({ length: 25 }, (_, i) =>
      peer({
        sessionId: `s-${String(i).padStart(3, "0")}`,
        liveness: "idle",
      }),
    );
    const text = renderPeerRoster(snapshot(peers));
    assert.ok(text !== null);
    const rows = text.split("\n").filter((line) => line.startsWith("- "));
    assert.equal(rows.length, PEER_ROSTER_MAX_ROWS + 1);
    assert.equal(rows.at(-1), "- … and 5 more (25 total; 20 shown).");
    assert.ok(text.includes("- s-000 — idle"));
    assert.ok(text.includes("- s-019 — idle"));
    assert.ok(!text.includes("- s-020 — idle"));
  });

  it("exactly at the cap → no overflow line", () => {
    const peers = Array.from({ length: PEER_ROSTER_MAX_ROWS }, (_, i) =>
      peer({ sessionId: `s-${i}`, liveness: "idle" }),
    );
    const text = renderPeerRoster(snapshot(peers));
    assert.ok(text !== null);
    assert.ok(!text.includes("more ("));
  });
});

describe("renderPeerRoster — prefix stays byte-stable (tail placement)", () => {
  it("the text before the roster is identical with 0 and 20 peers", () => {
    const todos = [
      todo({ id: "t-1", title: "Summarize RFCs", status: "in_progress" }),
      todo({ id: "t-2", title: "Changelog stub", status: "pending" }),
    ];
    const withNone = assembleTurnReminder(todos, { peers: [] });
    const peers = Array.from({ length: PEER_ROSTER_MAX_ROWS }, (_, i) =>
      peer({
        sessionId: `peer-${String(i).padStart(2, "0")}`,
        liveness: "working",
        activity: `grep: queue ${i}`,
      }),
    );
    const withAll = assembleTurnReminder(todos, { peers });

    // 1. The roster is present only in the second render.
    assert.ok(!withNone.includes(PEER_ROSTER_SECTION_HEADING));
    assert.ok(withAll.includes(PEER_ROSTER_SECTION_HEADING));

    // 2. Everything before the roster section is the exact same bytes.
    const at = withAll.indexOf(PEER_ROSTER_SECTION_HEADING);
    assert.ok(at > 0);
    const prefix = withAll.slice(0, at);
    assert.equal(prefix, `${withNone}\n\n`);

    // 3. The roster is the LAST section: its heading is the final heading,
    //    and nothing follows the rows.
    const lastHeading = withAll.lastIndexOf("\n## ");
    assert.equal(withAll.slice(lastHeading + 1).split("\n")[0], PEER_ROSTER_SECTION_HEADING);
    assert.ok(withAll.endsWith("— working · grep: queue 19"));
  });

  it("the roster sits after every standing rule", () => {
    const text = assembleTurnReminder([], {
      peers: [peer({ sessionId: "s-1", liveness: "idle" })],
    });
    assert.ok(
      text.indexOf("## Standing rules") <
        text.indexOf(PEER_ROSTER_SECTION_HEADING),
    );
    assert.ok(
      text.indexOf("Workers never message the user") <
        text.indexOf(PEER_ROSTER_SECTION_HEADING),
    );
  });

  it("appendPeerRosterTail puts the roster after a multi-block body, unchanged when empty", () => {
    const body = [assembleTurnReminder([]), "", "# Background work landed", "", "body"].join("\n");
    assert.equal(appendPeerRosterTail(body, { peers: [] }), body);
    assert.equal(appendPeerRosterTail(body, null), body);
    const withRoster = appendPeerRosterTail(body, {
      peers: [peer({ sessionId: "s-1", liveness: "idle" })],
    });
    assert.equal(withRoster, `${body}\n\n${renderPeerRoster({ peers: [peer({ sessionId: "s-1", liveness: "idle" })] })}`);
    assert.ok(withRoster.endsWith("- s-1 — idle"));
    // Two renders of the same state are byte-identical.
    assert.equal(
      appendPeerRosterTail(body, { peers: [peer({ sessionId: "s-1", liveness: "idle" })] }),
      withRoster,
    );
  });
});

describe("renderPeerRoster — provenance", () => {
  it("the heading says these are not the user (existing cue convention)", () => {
    assert.equal(PEER_ROSTER_SECTION_HEADING, "## Other agents — not the user");
    assert.ok(PEER_ROSTER_SECTION_HEADING.includes("not the user"));
    // Same provenance idea as the shipped peer-wake cue.
    assert.ok(PEER_WAKE_SECTION_HEADINGS[0].includes("not from the user"));
    assert.ok(PEER_ROSTER_INTRO.includes("not the user"));
    // Ticket 119: the retired `send_peer` name must not survive in model-facing
    // copy — `message_agent` is the one verb (ADR-0025).
    assert.ok(PEER_ROSTER_INTRO.includes("message_agent"));
    assert.ok(!PEER_ROSTER_INTRO.includes("send_peer"));
    assert.ok(PEER_ROSTER_INTRO.includes("session id"));
  });
});

describe("liveness mapping — honest reduced shape", () => {
  it("names the observable vocabulary only", () => {
    assert.deepEqual([...PEER_LIVENESS_STATES], [
      "working",
      "waiting",
      "approval",
      "idle",
    ]);
  });

  it("precedence: approval > working > waiting > idle", () => {
    assert.equal(
      derivePeerLiveness({ busy: true, pendingApproval: true, queuedWake: true }),
      "approval",
    );
    assert.equal(
      derivePeerLiveness({ busy: true, pendingApproval: false, queuedWake: true }),
      "working",
    );
    assert.equal(
      derivePeerLiveness({ busy: false, pendingApproval: false, queuedWake: true }),
      "waiting",
    );
    assert.equal(
      derivePeerLiveness({ busy: false, pendingApproval: false, queuedWake: false }),
      "idle",
    );
  });
});

describe("buildPeerRosterSnapshot — per-turn projection is pure", () => {
  it("derives each row's liveness from the observable facts", () => {
    const built = buildPeerRosterSnapshot("self", [
      { sessionId: "a", busy: true },
      { sessionId: "b", pendingApproval: true },
      { sessionId: "c", queuedWake: true },
      { sessionId: "d" },
    ]);
    assert.equal(built.selfSessionId, "self");
    assert.deepEqual(
      built.peers.map((p) => [p.sessionId, p.liveness]),
      [
        ["a", "working"],
        ["b", "approval"],
        ["c", "waiting"],
        ["d", "idle"],
      ],
    );
  });

  it("omitted and null fields are preserved as null, never invented", () => {
    const built = buildPeerRosterSnapshot(null, [{ sessionId: "a" }]);
    const row = built.peers[0];
    assert.ok(row !== undefined);
    assert.equal(row.label, null);
    assert.equal(row.title, null);
    assert.equal(row.activity, null);
    assert.equal(row.currentTool, null);
    assert.equal(row.currentTarget, null);
    assert.equal(built.selfSessionId, null);
  });
});

describe("renderPeerRoster — malformed input degrades, never throws", () => {
  it("unknown or missing status → `unknown`, never a coerced state", () => {
    const text = renderPeerRoster(
      snapshot([
        peer({ sessionId: "s-1", liveness: "thinking" }),
        peer({ sessionId: "s-2" }),
        // Untyped junk from a stale caller must not throw.
        { sessionId: "s-3", liveness: 42 } as unknown as PeerRosterEntry,
      ]),
    );
    assert.ok(text !== null);
    for (const id of ["s-1", "s-2", "s-3"]) {
      assert.ok(text.includes(`- ${id} — unknown`), `missing unknown row for ${id}`);
    }
    for (const state of PEER_LIVENESS_STATES) {
      assert.ok(!text.includes(`— ${state}`), `invented status: ${state}`);
    }
  });

  it("malformed rows are skipped, and a roster of only junk → null", () => {
    const junk = [
      null,
      undefined,
      "not-a-peer",
      { sessionId: "" },
      { sessionId: "   " },
      { sessionId: 7 },
    ] as unknown as readonly PeerRosterEntry[];
    assert.equal(renderPeerRoster(snapshot(junk)), null);
    const mixed = renderPeerRoster({
      peers: [...junk, peer({ sessionId: "s-ok", liveness: "idle" })],
    });
    assert.ok(mixed !== null);
    assert.ok(mixed.includes("- s-ok — idle"));
    assert.equal(mixed.split("\n").filter((l) => l.startsWith("- ")).length, 1);
  });

  it("a malformed snapshot shape → null, no throw", () => {
    assert.equal(
      renderPeerRoster({ peers: "nope" } as unknown as PeerRosterSnapshot),
      null,
    );
    assert.equal(
      renderPeerRoster({ peers: null } as unknown as PeerRosterSnapshot),
      null,
    );
  });
});
