import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assembleTurnReminder,
  formatLedgerLine,
} from "../src/core/policy/assembler.js";
import {
  buildStandingRulesBlock,
  EMPTY_LEDGER_LINE,
  REMINDER_SECTION_HEADINGS,
  REMINDER_SECTION_HEADINGS_ZH,
} from "../src/core/policy/prompts.js";
import {
  clearReminderDeltaSession,
  createReminderDeltaStore,
  ledgerRowSignature,
  rememberReminderSignatures,
  reminderSignaturesForSession,
} from "../src/core/policy/reminder-delta.js";
import { buildTurnReminderForSession } from "../src/core/tools.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";
import type { TodoItem } from "../src/core/todo-reconciler.js";

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

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("per-session reminder delta ledger", () => {
  it("renders every row in the legacy format on the first reminder", () => {
    const session = "delta-first-full";
    clearReminderDeltaSession(session);
    const todos = [
      todo({ id: "t-1", title: "Draft plan", status: "in_progress" }),
      todo({
        id: "t-2",
        title: "Ship fix",
        status: "completed",
        delivered: true,
        disposition: "delivered",
      }),
    ];

    const text = assembleTurnReminder(todos, undefined, "en", "user", session);

    assert.equal(text, assembleTurnReminder(todos));
    assert.ok(text.includes(REMINDER_SECTION_HEADINGS[0]));
    assert.ok(text.includes("- t-1 · in_progress · Draft plan"));
    assert.ok(text.includes("- t-2 · completed · Ship fix"));
    assert.ok(!text.includes("(unchanged)"));
  });

  it("collapses unchanged rows into status groups that name every id", () => {
    const session = "delta-status-groups";
    clearReminderDeltaSession(session);
    const todos = [
      todo({ id: "t-1", title: "Pending work" }),
      todo({ id: "t-2", title: "Active work", status: "in_progress" }),
      todo({
        id: "t-3",
        title: "Done work",
        status: "completed",
        delivered: true,
        disposition: "delivered",
      }),
      todo({
        id: "t-4",
        title: "Lost work",
        status: "lost",
        disposition: "dropped",
        dispositionReason: "max-redrives",
      }),
    ];
    assembleTurnReminder(todos, undefined, "en", "user", session);

    const text = assembleTurnReminder(todos, undefined, "en", "user", session);

    assert.ok(text.includes("- pending (unchanged): t-1"));
    assert.ok(text.includes("- in_progress (unchanged): t-2"));
    assert.ok(text.includes("- completed (unchanged): t-3"));
    assert.ok(text.includes("- lost (unchanged): t-4 (max-redrives)"));
    for (const id of ["t-1", "t-2", "t-3", "t-4"]) {
      assert.equal(occurrenceCount(text, id), 1, id + " should appear once");
    }
    assert.ok(!text.includes("- t-1 · pending · Pending work"));
  });

  it("renders a changed row full when status or title moves", () => {
    const session = "delta-status-title";
    clearReminderDeltaSession(session);
    const first = [
      todo({ id: "t-1", title: "Old title" }),
      todo({ id: "t-2", title: "Keep title" }),
    ];
    assembleTurnReminder(first, undefined, "en", "user", session);

    const second = [
      todo({ id: "t-1", title: "Old title", status: "in_progress" }),
      todo({ id: "t-2", title: "New title" }),
    ];
    const text = assembleTurnReminder(second, undefined, "en", "user", session);

    assert.ok(text.includes("- t-1 · in_progress · Old title"));
    assert.ok(text.includes("- t-2 · pending · New title"));
    assert.ok(!text.includes("(unchanged)"));
  });

  it("renders a row full when delivered, redriveAttempts, or workerId moves", () => {
    const session = "delta-invisible-fields";
    clearReminderDeltaSession(session);
    const line = "- t-3 · completed · Task";
    const base = todo({
      id: "t-3",
      title: "Task",
      status: "completed",
      delivered: false,
      redriveAttempts: 0,
    });
    assembleTurnReminder([base], undefined, "en", "user", session);

    const deliveredOnly = todo({ ...base, delivered: true });
    const deliveredText = assembleTurnReminder(
      [deliveredOnly],
      undefined,
      "en",
      "user",
      session,
    );
    assert.ok(deliveredText.includes(line));
    assert.ok(!deliveredText.includes("(unchanged)"));

    const redriveOnly = todo({ ...deliveredOnly, redriveAttempts: 2 });
    const redriveText = assembleTurnReminder(
      [redriveOnly],
      undefined,
      "en",
      "user",
      session,
    );
    assert.ok(redriveText.includes(line));
    assert.ok(!redriveText.includes("(unchanged)"));

    const workerOnly = todo({ ...redriveOnly, workerId: "worker-1" });
    const workerText = assembleTurnReminder(
      [workerOnly],
      undefined,
      "en",
      "user",
      session,
    );
    assert.ok(workerText.includes(line));
    assert.ok(!workerText.includes("(unchanged)"));

    const sameAgain = assembleTurnReminder(
      [workerOnly],
      undefined,
      "en",
      "user",
      session,
    );
    assert.ok(sameAgain.includes("- completed (unchanged): t-3"));
  });

  it("keeps lost ids and reason tokens loud in the summary", () => {
    const session = "delta-lost";
    clearReminderDeltaSession(session);
    const first = [
      todo({
        id: "t-max",
        title: "Exhausted",
        status: "lost",
        disposition: "dropped",
        dispositionReason: "max-redrives",
      }),
      todo({
        id: "t-gone",
        title: "Vanished",
        status: "lost",
        disposition: "dropped",
        dispositionReason: "worker-gone",
      }),
    ];
    assembleTurnReminder(first, undefined, "en", "user", session);

    const text = assembleTurnReminder(first, undefined, "en", "user", session);

    assert.ok(
      text.includes(
        "- lost (unchanged): t-max (max-redrives), t-gone (worker-gone)",
      ),
    );
    assert.equal(occurrenceCount(text, "t-max"), 1);
    assert.equal(occurrenceCount(text, "t-gone"), 1);

    const reasonChanged = first.map((row) =>
      row.id === "t-max"
        ? todo({ ...row, dispositionReason: "worker-gone" })
        : row,
    );
    const changedText = assembleTurnReminder(
      reasonChanged,
      undefined,
      "en",
      "user",
      session,
    );
    assert.ok(
      changedText.includes("- t-max · lost · Exhausted (worker-gone)"),
      "reason change renders the row full",
    );
    assert.ok(
      changedText.includes("- lost (unchanged): t-gone (worker-gone)"),
      "untouched lost row stays in the summary",
    );
  });

  it("keeps the empty ledger marker on first and later reminders", () => {
    const session = "delta-empty";
    clearReminderDeltaSession(session);
    const first = assembleTurnReminder([], undefined, "en", "user", session);
    const second = assembleTurnReminder([], undefined, "en", "user", session);

    assert.ok(first.includes("- " + EMPTY_LEDGER_LINE));
    assert.ok(second.includes("- " + EMPTY_LEDGER_LINE));
    assert.equal(first, second);
  });

  it("keeps the standing-rules block byte-identical in first and summary variants, EN and ZH", () => {
    for (const language of ["en", "zh"] as const) {
      const session = "delta-rules-" + language;
      clearReminderDeltaSession(session);
      const heading =
        language === "zh"
          ? REMINDER_SECTION_HEADINGS_ZH[0]
          : REMINDER_SECTION_HEADINGS[0];
      const rules = buildStandingRulesBlock(language, "user");
      const todos = [todo({ id: "t-1", title: "Rule check" })];

      const first = assembleTurnReminder(todos, undefined, language, "user", session);
      const summary = assembleTurnReminder(
        todos,
        undefined,
        language,
        "user",
        session,
      );

      assert.ok(first.includes(heading), language + " first heading");
      assert.ok(summary.includes(heading), language + " summary heading");
      assert.ok(first.includes(rules), language + " first rules");
      assert.ok(summary.includes(rules), language + " summary rules");
      assert.ok(!first.includes("(unchanged)"), language + " first is full");
      assert.ok(
        summary.includes(
          language === "zh"
            ? "- pending（未变）：t-1"
            : "- pending (unchanged): t-1",
        ),
        language + " summary line",
      );
    }
  });

  it("is deterministic and does not leak the session key into the text", () => {
    const todos = [
      todo({ id: "t-1", title: "Deterministic", status: "in_progress" }),
    ];
    const sessionA = "delta-determinism-a";
    const sessionB = "delta-determinism-b";
    clearReminderDeltaSession(sessionA);
    clearReminderDeltaSession(sessionB);

    const a1 = assembleTurnReminder(todos, undefined, "en", "user", sessionA);
    const a2 = assembleTurnReminder(todos, undefined, "en", "user", sessionA);
    const b1 = assembleTurnReminder(todos, undefined, "en", "user", sessionB);
    const b2 = assembleTurnReminder(todos, undefined, "en", "user", sessionB);

    assert.equal(a1, b1);
    assert.equal(a2, b2);
    assert.ok(!a2.includes(sessionA));
    assert.ok(!b2.includes(sessionB));
  });

  it("keeps every call full when no session key is supplied", () => {
    const row = todo({ id: "t-1", title: "Keyless", status: "in_progress" });
    const first = assembleTurnReminder([row]);
    const second = assembleTurnReminder([row]);

    assert.equal(second, first);
    assert.ok(second.includes(formatLedgerLine(row)));
    assert.ok(!second.includes("(unchanged)"));
  });

  it("shares one store across assembleTurnReminder and buildTurnReminderForSession", () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const session = "delta-shared-store";
    clearReminderDeltaSession(session);
    multitask.createTodo({
      sessionId: session,
      id: "t-shared",
      title: "Shared row",
    });

    const first = assembleTurnReminder(
      multitask.listTodos(session),
      undefined,
      "en",
      "user",
      session,
    );
    const second = buildTurnReminderForSession(multitask, session);

    assert.ok(first.includes("- t-shared · pending · Shared row"));
    assert.ok(second.includes("- pending (unchanged): t-shared"));
    assert.ok(!second.includes("- t-shared · pending · Shared row"));

    clearReminderDeltaSession(session);
    const afterTeardown = buildTurnReminderForSession(multitask, session);
    assert.ok(afterTeardown.includes("- t-shared · pending · Shared row"));
    assert.ok(!afterTeardown.includes("(unchanged)"));
  });

  it("exposes an isolated store accessor with teardown semantics", () => {
    const store = createReminderDeltaStore();
    const row = todo({ id: "t-1", title: "Stored" });
    assert.equal(reminderSignaturesForSession("s-1", store), undefined);

    rememberReminderSignatures([row], "s-1", store);
    assert.equal(
      reminderSignaturesForSession("s-1", store)?.get("t-1"),
      ledgerRowSignature(row),
    );

    clearReminderDeltaSession("s-1", store);
    assert.equal(reminderSignaturesForSession("s-1", store), undefined);
  });
});
