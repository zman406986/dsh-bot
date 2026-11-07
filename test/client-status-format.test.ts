/**
 * The shared client formatting leaf (readable-status display).
 *
 * Pure, offline (S8): short refs, subject resolution, durations, plural
 * selection, fact capping, placeholders and the status-word map. These are
 * the primitives every row (toolview, roster panel, shell, dispatch card)
 * consumes, so a second formatter cannot quietly drift in.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localeDictionary } from "../src/client/overlay.js";
import { describeRosterPanel } from "../src/client/roster-store.js";
import {
  ROSTER_SNAPSHOT_SCHEMA_VERSION,
  type RosterSnapshot,
} from "../src/core/roster-snapshot.js";
import {
  FACT_SEPARATOR,
  displaySubject,
  formatCount,
  formatDuration,
  formatFacts,
  formatTemplate,
  selectFacts,
  shortRef,
  statusWord,
  statusWordKey,
} from "../src/client/status-format.js";

const EN = localeDictionary.en;
const ZH = localeDictionary.zh;
const lookupEn = (key: string): string => EN[key] ?? key;
const lookupZh = (key: string): string => ZH[key] ?? key;

describe("status-format — short refs never lead with session- or a UUID", () => {
  it("compresses a session id to the session tail", () => {
    assert.equal(
      shortRef("session-d5c7e1f0-1111-2222-3333-4444555593a7"),
      "session …93a7",
    );
    assert.equal(shortRef("session-abc"), "session …abc");
  });

  it("compresses a worker UUID with its kind", () => {
    const uuid = "063f41a2-9897-4936-95de-1cd3f2f76132";
    assert.equal(shortRef(uuid), "worker …6132");
    assert.equal(shortRef(uuid, "dispatcher"), "dispatcher …6132");
  });

  it("keeps short prefixed ids readable", () => {
    assert.equal(shortRef("todo-7"), "todo 7");
    assert.equal(shortRef("worker-7"), "worker 7");
    assert.equal(shortRef("w-7f3a"), "worker 7f3a");
    assert.equal(shortRef("dispatcher-b"), "dispatcher b");
  });

  it("prefixes an unrecognized short id with its kind", () => {
    assert.equal(shortRef("ghost", "agent"), "agent ghost");
    assert.equal(shortRef("ghost"), "ghost");
    assert.equal(shortRef(""), "");
  });

  it("compresses an opaque long id instead of printing it whole", () => {
    assert.equal(shortRef("a".repeat(24), "todo"), "todo …aaaa");
    assert.equal(shortRef("deadbeefcafebabe", "worker"), "worker …babe");
    // Output never starts with a raw UUID or `session-`.
    for (const id of [
      "063f41a2-9897-4936-95de-1cd3f2f76132",
      "session-d5c7e1f0-1111-2222-3333-4444555593a7",
    ]) {
      const ref = shortRef(id);
      assert.doesNotMatch(ref, /^[0-9a-f]{8}-/i);
      assert.doesNotMatch(ref, /^session-/);
    }
  });
});

describe("status-format — display subject (title → kind + ref)", () => {
  it("prefers a title", () => {
    assert.equal(
      displaySubject({
        title: "Rewrite auth docs",
        id: "session-d5c7",
        kind: "dispatcher",
      }),
      "Rewrite auth docs",
    );
  });

  it("falls back to kind + short ref", () => {
    assert.equal(
      displaySubject({
        title: null,
        id: "063f41a2-9897-4936-95de-1cd3f2f76132",
        kind: "worker",
      }),
      "worker …6132",
    );
    assert.equal(displaySubject({ id: "todo-7", kind: "todo" }), "todo 7");
  });

  it("never falls back to a full id — details own it", () => {
    assert.equal(displaySubject({}), null);
    assert.equal(displaySubject({ title: "   ", id: null }), null);
  });
});

describe("status-format — durations and plural counts", () => {
  it("formats compact elapsed text and clamps skew to zero", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(42_000), "42s");
    assert.equal(formatDuration(185_000), "3m 5s");
    assert.equal(formatDuration(7_500_000), "2h 5m");
    assert.equal(formatDuration(93_600_000), "1d 2h");
    assert.equal(formatDuration(-5_000), "0s");
  });

  it("selects .one / .other from the dictionary, in both faces", () => {
    assert.equal(
      formatCount(lookupEn, "roster.activity.toolcalls", 1),
      "1 tool call",
    );
    assert.equal(
      formatCount(lookupEn, "roster.activity.toolcalls", 2),
      "2 tool calls",
    );
    assert.equal(
      formatCount(lookupEn, "shell.row.needs-you", 1),
      "1 needs you",
    );
    assert.equal(
      formatCount(lookupEn, "shell.row.needs-you", 3),
      "3 need you",
    );
    assert.equal(
      formatCount(lookupZh, "roster.activity.toolcalls", 2),
      "2 次工具调用",
    );
    assert.equal(
      formatCount(lookupZh, "roster.activity.toolcalls", 1),
      "1 次工具调用",
    );
    // Identical key sets: every count base has both forms in both faces.
    for (const base of [
      "roster.activity.toolcalls",
      "roster.finished.count",
      "shell.row.working",
      "shell.row.needs-you",
      "shell.row.finished",
      "toolview.fact.attachments",
    ]) {
      for (const face of [EN, ZH]) {
        assert.equal(typeof face[`${base}.one`], "string", `${base}.one`);
        assert.equal(typeof face[`${base}.other`], "string", `${base}.other`);
      }
    }
  });

  it("formats templates with lowercase placeholders only", () => {
    assert.equal(
      formatTemplate("Started \"{title}\"", { title: "Docs" }),
      'Started "Docs"',
    );
    // An unknown placeholder stays visible instead of vanishing.
    assert.equal(formatTemplate("x {missing}", {}), "x {missing}");
    // Uppercase placeholders are deliberately not recognized (copy rule).
    assert.equal(formatTemplate("x {workerId}", { worker: "w" }), "x {workerId}");
  });
});

describe("status-format — facts", () => {
  it("keeps at most two distinct non-empty facts", () => {
    assert.deepEqual(selectFacts(["a", "b", "c"]), ["a", "b"]);
    assert.deepEqual(selectFacts(["a", "a", "b"]), ["a", "b"]);
    assert.deepEqual(selectFacts([null, undefined, "", "  ", "x"]), ["x"]);
    assert.equal(formatFacts(["a", "b", "c"]), `a${FACT_SEPARATOR}b`);
  });
});

describe("status-format — status words", () => {
  it("maps the six raw FSM statuses onto the six human words", () => {
    assert.deepEqual(
      [
        "spawned",
        "running",
        "steering",
        "completed",
        "error",
        "aborted",
      ].map((status) => statusWord(status)),
      ["starting", "working", "adjusting", "done", "failed", "stopped"],
    );
  });

  it("answers locale keys and fails closed for unknown statuses", () => {
    assert.equal(statusWordKey("running"), "status.working");
    assert.equal(statusWordKey("completed"), "status.done");
    assert.equal(statusWordKey("unknown"), null);
    assert.equal(statusWordKey(null), null);
    for (const key of [
      "status.starting",
      "status.working",
      "status.adjusting",
      "status.done",
      "status.failed",
      "status.stopped",
    ]) {
      assert.equal(typeof EN[key], "string", key);
      assert.equal(typeof ZH[key], "string", key);
      assert.notEqual(EN[key], "", key);
      assert.notEqual(ZH[key], "", key);
    }
  });
});

describe("status-format — roster row view (readable status)", () => {
  const now = 1_700_000_000_000;
  const snapshot: RosterSnapshot = {
    schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
    dispatcherSessionId: "s-1",
    publishedAtMs: now,
    workers: [
      {
        kind: "worker",
        workerId: "063f41a2-9897-4936-95de-1cd3f2f76132",
        title: "",
        status: "running",
        todoId: "todo-7",
        startedAtMs: now - 185_000,
        toolCallCount: 7,
        delivered: false,
      },
    ],
    recentResult: null,
  };

  it("keeps the raw status for data-status and selects one human word", () => {
    const view = describeRosterPanel({ kind: "snapshot", snapshot }, now);
    assert.equal(view.kind, "rows");
    if (view.kind !== "rows") return;
    const row = view.sections.flatMap((section) => section.rows)[0];
    assert.ok(row);
    assert.equal(row.statusLabel, "running");
    assert.equal(row.statusWordKey, "status.working");
    assert.equal(lookupEn(row.statusWordKey), "Working");
    assert.equal(row.todoId, "todo-7", "raw linkage metadata stays on the model");
    assert.equal(row.elapsedText, "3m 5s");
    assert.equal(row.toolCallCount, 7);
  });

  it("falls a missing title back to the kind + short ref, never the full id", () => {
    const view = describeRosterPanel({ kind: "snapshot", snapshot }, now);
    if (view.kind !== "rows") throw new Error("expected rows");
    const row = view.sections.flatMap((section) => section.rows)[0];
    assert.equal(row?.title, "worker …6132");
    assert.equal(row?.shortRef, "worker …6132");
    // The model keeps the full id for data attributes; the visible fields
    // never carry it.
    assert.equal(row?.title.includes("063f41a2-9897"), false);
    assert.equal(row?.shortRef.includes("063f41a2-9897"), false);
  });
});
