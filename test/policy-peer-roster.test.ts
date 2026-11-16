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
  PEER_ROSTER_EMPTY_LINE,
  PEER_ROSTER_EMPTY_LINE_ZH,
  PEER_ROSTER_FRESHNESS_LINE,
  PEER_ROSTER_FRESHNESS_LINE_ZH,
  PEER_ROSTER_INTRO,
  PEER_ROSTER_SECTION_HEADING,
  PEER_ROSTER_SECTION_HEADING_ZH,
  PEER_ROSTER_SUPERSEDE_LINE,
  PEER_ROSTER_SUPERSEDE_LINE_ZH,
  PEER_WAKE_SECTION_HEADINGS,
} from "../src/core/policy/prompts.js";

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
    redriveAttempts: 0,
    disposition: null,
    dispositionReason: null,
    external: null,
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

});

describe("renderPeerRoster — one row", () => {
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

});

describe("renderPeerRoster — bound", () => {
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
    assert.ok(withRoster.includes("- s-1 — idle"));
    // The fixed supersede marker closes the appended section.
    assert.ok(withRoster.endsWith(PEER_ROSTER_FRESHNESS_LINE));
    // Two renders of the same state are byte-identical.
    assert.equal(
      appendPeerRosterTail(body, { peers: [peer({ sessionId: "s-1", liveness: "idle" })] }),
      withRoster,
    );
  });
});

describe("roster freshness marker — the newest turn is authoritative", () => {
  it("a non-empty roster carries the fixed supersede line after its rows", () => {
    const snapshot = { peers: [peer({ sessionId: "s-1", liveness: "idle" })] };
    const text = assembleTurnReminder([], snapshot);
    assert.ok(text.includes(PEER_ROSTER_SECTION_HEADING));
    assert.ok(text.includes(PEER_ROSTER_FRESHNESS_LINE), text);
    assert.ok(
      text.indexOf("- s-1 — idle") < text.indexOf(PEER_ROSTER_FRESHNESS_LINE),
      "the line must follow the rows it supersedes",
    );
    assert.ok(text.trimEnd().endsWith(PEER_ROSTER_FRESHNESS_LINE));
    // Byte-stable: the same state renders identical bytes — the marker carries
    // no clock, counter, or turn number.
    assert.equal(assembleTurnReminder([], snapshot), text);
    assert.doesNotMatch(PEER_ROSTER_FRESHNESS_LINE, /\d/);
    // ZH face of the same marker.
    const zh = assembleTurnReminder([], snapshot, "zh");
    assert.ok(zh.includes(PEER_ROSTER_FRESHNESS_LINE_ZH), zh);
    assert.ok(!zh.includes(PEER_ROSTER_FRESHNESS_LINE), "no EN marker in ZH");
  });

  it("a computed-but-empty roster emits a fresh zero-row section with the same instruction", () => {
    // A replayed old roster block sits ABOVE this turn; a reminder that renders
    // no section at all supersedes nothing, so a roster the caller actually
    // computed and found empty must speak.
    const snapshots = [
      { peers: [] },
      { peers: [], selfSessionId: "self" },
      // The live path's shape: peerRosterFor always answers a snapshot.
      buildPeerRosterSnapshot("self", []),
    ] as const;
    for (const peers of snapshots) {
      const text = assembleTurnReminder([], peers);
      assert.ok(text.includes(PEER_ROSTER_SECTION_HEADING), text);
      assert.ok(text.includes(PEER_ROSTER_EMPTY_LINE), text);
      assert.ok(
        text.trimEnd().endsWith(PEER_ROSTER_EMPTY_LINE),
        "the empty section is the reminder's tail",
      );
      const section = text.slice(text.indexOf(PEER_ROSTER_SECTION_HEADING));
      assert.deepEqual(
        section.split("\n").filter((line) => line.startsWith("- ")),
        [],
        "zero rows: the empty section lists no peer",
      );
    }
    assert.deepEqual(buildPeerRosterSnapshot("self", []), {
      peers: [],
      selfSessionId: "self",
    });
    // Both cases state the SAME supersede instruction.
    assert.ok(
      PEER_ROSTER_EMPTY_LINE.includes('ignore every earlier "Other agents" section'),
    );
    // The renderer itself still answers null: the empty section belongs to the
    // assembler, so a bare roster never grows a heading with no rows.
    assert.equal(renderPeerRoster({ peers: [] }), null);
    // ZH face of the empty section.
    const zh = assembleTurnReminder([], { peers: [] }, "zh");
    assert.ok(zh.includes(PEER_ROSTER_SECTION_HEADING_ZH), zh);
    assert.ok(zh.includes(PEER_ROSTER_EMPTY_LINE_ZH), zh);
    assert.ok(!zh.includes(PEER_ROSTER_SECTION_HEADING), "no EN heading in ZH");
  });

  it("a null roster (wake composer) emits ONLY the neutral supersede line", () => {
    // plugin.ts:694 passes `null` because a wake turn never builds a roster.
    // After a restart that first wake turn still has an old block above it, so
    // it must say which roster wins — but it must not claim a roster follows,
    // and it must not claim nobody is visible: nobody looked.
    const text = assembleTurnReminder([], null);
    assert.ok(text.includes(PEER_ROSTER_SUPERSEDE_LINE), text);
    assert.ok(
      text.trimEnd().endsWith(PEER_ROSTER_SUPERSEDE_LINE),
      "the neutral line is the reminder's tail",
    );
    assert.ok(!text.includes(PEER_ROSTER_SECTION_HEADING), "no heading");
    assert.ok(!text.includes(PEER_ROSTER_EMPTY_LINE), "no empty-roster claim");
    assert.ok(!text.includes(PEER_ROSTER_FRESHNESS_LINE), "no roster-exists claim");
    assert.ok(!text.includes("No other agents"), text);
    assert.ok(!text.includes(PEER_ROSTER_INTRO), text);
    // Byte-stable: the same call renders identical bytes.
    assert.equal(assembleTurnReminder([], null), text);
    // ZH face of the neutral line only.
    const zh = assembleTurnReminder([], null, "zh");
    assert.ok(zh.includes(PEER_ROSTER_SUPERSEDE_LINE_ZH), zh);
    assert.ok(!zh.includes(PEER_ROSTER_SECTION_HEADING_ZH), zh);
    assert.ok(!zh.includes(PEER_ROSTER_EMPTY_LINE_ZH), zh);
    assert.ok(!zh.includes(PEER_ROSTER_SUPERSEDE_LINE), "no EN line in ZH");
  });

  it("an undefined roster (no-argument helper call) emits no roster text at all", () => {
    const text = assembleTurnReminder([]);
    assert.ok(!text.includes(PEER_ROSTER_SECTION_HEADING), text);
    assert.ok(!text.includes(PEER_ROSTER_EMPTY_LINE), text);
    assert.ok(!text.includes(PEER_ROSTER_FRESHNESS_LINE), text);
    assert.ok(!text.includes(PEER_ROSTER_SUPERSEDE_LINE), text);
    assert.ok(!text.includes("Other agents"), text);
    // The reminder still ends with its stable rules, no dangling separator.
    assert.ok(text.trimEnd().endsWith("- Update the ledger and keep it lean."), text);
    assert.equal(text, assembleTurnReminder([], undefined));
    const zh = assembleTurnReminder([], undefined, "zh");
    assert.ok(!zh.includes(PEER_ROSTER_SECTION_HEADING_ZH), zh);
    assert.ok(!zh.includes(PEER_ROSTER_EMPTY_LINE_ZH), zh);
    assert.ok(!zh.includes(PEER_ROSTER_SUPERSEDE_LINE_ZH), zh);
  });
});

describe("renderPeerRoster — provenance", () => {
  it("says these are other agents, never the user (S5)", () => {
    assert.equal(PEER_ROSTER_SECTION_HEADING, "## Other agents — not the user");
    assert.ok(PEER_WAKE_SECTION_HEADINGS[0]?.includes("not from the user"));
    assert.ok(PEER_ROSTER_INTRO.includes("not the user"));
    // Ticket 119: `message_agent` is the one messaging verb; the retired
    // `send_peer` name must never come back into model-facing copy.
    assert.ok(PEER_ROSTER_INTRO.includes("message_agent"));
    assert.ok(!PEER_ROSTER_INTRO.includes("send_peer"));
  });
});

describe("liveness mapping — honest reduced shape", () => {
  it("precedence: working > waiting > idle", () => {
    // Ticket 174 / ADR-0033 removed the `pendingApproval` fact with the
    // worker access-ask feature. `approval` stays in the vocabulary
    // (ADR-0027 decision 3), so it is still an accepted wire VALUE — it just
    // has no producer any more.
    assert.equal(derivePeerLiveness({ busy: true, queuedWake: true }), "working");
    assert.equal(derivePeerLiveness({ busy: false, queuedWake: true }), "waiting");
    assert.equal(derivePeerLiveness({ busy: false, queuedWake: false }), "idle");
    assert.ok(PEER_LIVENESS_STATES.includes("approval"));
  });
});

describe("buildPeerRosterSnapshot — per-turn projection is pure", () => {
  it("derives each row's liveness from the observable facts", () => {
    const built = buildPeerRosterSnapshot("self", [
      { sessionId: "a", busy: true },
      { sessionId: "b", busy: false, queuedWake: false },
      { sessionId: "c", queuedWake: true },
      { sessionId: "d" },
    ]);
    assert.equal(built.selfSessionId, "self");
    assert.deepEqual(
      built.peers.map((p) => [p.sessionId, p.liveness]),
      [
        ["a", "working"],
        ["b", "idle"],
        ["c", "waiting"],
        ["d", "idle"],
      ],
    );
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
