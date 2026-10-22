import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assembleSessionPolicy,
  assembleTurnReminder,
  assembleWakeTurn,
  noticeFromSettled,
  type WakeNotice,
} from "../src/core/policy/assembler.js";
import {
  AWAIT_AGENT_TOOL,
  CHECK_WORKERS_TOOL,
  SPAWN_DISPATCHER_TOOL,
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
  MESSAGE_AGENT_TOOL,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
  TOOL_DESCRIPTIONS,
  buildStandingRulesBlock,
  buildWakeInstructionsBlock,
  buildDispatcherPolicySection,
  buildPeerWakeInstructionsBlock,
  PEER_ROSTER_INTRO,
} from "../src/core/policy/prompts.js";
import { emptyReportPlaceholder, REPORT_CLAMP_CHARS } from "../src/core/report-clamp.js";
import {
  formatSpawnAck,
  formatSteerNote,
  formatStopNote,
} from "../src/core/tool-results.js";
import { WAKE_CUE } from "../src/adapter/wake-copy.js";
import type { TodoItem } from "../src/core/todo-reconciler.js";

const FORBIDDEN_VOCAB = [
  "sand",
  "executor",
  "MessageSubagent",
  "SAND_MULTITASK_",
] as const;

function assertNewCopy(text: string): void {
  const lower = text.toLowerCase();
  for (const term of FORBIDDEN_VOCAB) {
    assert.ok(
      !lower.includes(term.toLowerCase()),
      `forbidden identifier in copy: ${term}`,
    );
  }
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

function notice(overrides: Partial<WakeNotice> = {}): WakeNotice {
  return {
    workerId: "w-1",
    title: "Rewrite auth docs",
    status: "completed",
    report: "Auth docs rewritten.",
    transcriptRef: "child-1",
    ...overrides,
  };
}

describe("session policy assembler", () => {
  it("flag OFF → empty (ADR-0005)", () => {
    assert.equal(assembleSessionPolicy(false), "");
  });

  it("flag ON → policy with stable sections in order", () => {
    const policy = assembleSessionPolicy(true);
    const headings = [
      "# Multitask dispatcher",
      "## How you work",
      "## What you never do",
    ];
    let last = -1;
    for (const heading of headings) {
      const at = policy.indexOf(heading);
      assert.ok(at >= 0, `missing section: ${heading}`);
      assert.ok(at > last, `section out of order: ${heading}`);
      last = at;
    }
    assertNewCopy(policy);
  });

  it("covers the PRD §6.1 behavioral bullets without jargon dumps", () => {
    const policy = assembleSessionPolicy(true).toLowerCase();
    for (const needle of [
      "dispatcher, not the workhorse",
      "parallel",
      "steer",
      "todo",
      "reconcile",
      "self-contained",
      "cannot talk to the user",
      "never hears the machinery",
      "poll",
    ]) {
      assert.ok(policy.includes(needle), `policy missing: ${needle}`);
    }
  });

  it("todo completion = first visible acknowledgement, never worker exit (ADR-0018)", () => {
    const policy = assembleSessionPolicy(true);
    const reminder = buildStandingRulesBlock();
    assert.ok(policy.includes("first visible acknowledgement"));
    assert.ok(policy.includes("Worker exit alone completes nothing"));
    assert.ok(reminder.includes("first visible acknowledgement"));
    assert.ok(reminder.includes("never on worker exit"));
    for (const text of [policy, reminder]) {
      assert.ok(!text.includes("user actually has the result"));
      assert.ok(!text.includes("user has the result"));
    }
  });
});

describe("per-turn reminder assembler", () => {
  it("empty ledger still injects rules with (empty) marker", () => {
    const reminder = assembleTurnReminder([]);
    assert.ok(reminder.includes("## Ledger"));
    assert.ok(reminder.includes("(empty)"));
    assert.ok(reminder.includes("## Standing rules"));
    assertNewCopy(reminder);
  });

  it("renders id, status, and title per todo", () => {
    const reminder = assembleTurnReminder([
      todo({ id: "t-1", title: "Summarize RFCs", status: "in_progress" }),
      todo({ id: "t-2", title: "Changelog stub", status: "pending" }),
    ]);
    assert.ok(reminder.includes("- t-1 · in_progress · Summarize RFCs"));
    assert.ok(reminder.includes("- t-2 · pending · Changelog stub"));
    assert.ok(!reminder.includes("(empty)"));
  });

  it("standing rules cover short-turn / spawn / steer / todo / wake / silence", () => {
    const reminder = assembleTurnReminder([]);
    const rules = reminder.toLowerCase();
    for (const needle of [
      "short turn",
      "spawn",
      "steer",
      "todo before spawn",
      "reconcile",
      "never message the user",
      "never name the machinery",
    ]) {
      assert.ok(rules.includes(needle), `reminder missing: ${needle}`);
    }
  });
});

describe("wake-turn assembler", () => {
  it("sections appear in order and silence is a valid outcome", () => {
    const wake = assembleWakeTurn([notice()]);
    for (const heading of [
      "# Background work landed",
      "## Settled workers",
      "## What to do now",
    ]) {
      assert.ok(wake.includes(heading), `missing ${heading}`);
    }
    const settledAt = wake.indexOf("## Settled workers");
    const whatAt = wake.indexOf("## What to do now");
    assert.ok(settledAt < whatAt);
    assert.ok(wake.includes("Silence is a valid outcome") || wake.includes("Silence is a valid"));
    assert.ok(wake.toLowerCase().includes("stale"));
    assert.ok(wake.toLowerCase().includes("duplicate"));
    assert.ok(wake.includes("lead with the concrete thing"));
    assertNewCopy(wake);
  });

  it("clamps the report body and attaches the transcript pointer", () => {
    // Ticket 63 / A-7: derive the fixture from the constant rather than
    // hardcoding a length, so re-tuning the bound cannot silently turn this
    // into a test of nothing.
    const long = "R".repeat(REPORT_CLAMP_CHARS + 500);
    const wake = assembleWakeTurn([notice({ report: long })]);
    assert.ok(wake.includes("Transcript: child-1"));
    assert.ok(wake.includes("report truncated"));
    assert.ok(wake.includes("Full transcript: child-1"));
  });

  it("empty report → placeholder pointing at the transcript", () => {
    const wake = assembleWakeTurn([notice({ report: "" })]);
    assert.ok(wake.includes(emptyReportPlaceholder()));
  });

  it("error notice is prefixed", () => {
    const wake = assembleWakeTurn([
      notice({ status: "error", report: "timeout after 10m" }),
    ]);
    assert.ok(wake.includes("Worker failed:"));
    assert.ok(wake.includes("timeout after 10m"));
  });

  it("aborted notice carries no real report", () => {
    const wake = assembleWakeTurn([
      notice({ status: "aborted", report: "secret work product" }),
    ]);
    assert.ok(wake.includes("Stopped before completion"));
    assert.ok(!wake.includes("secret work product"));
  });

  it("maps SettledWorkerNotice through noticeFromSettled", () => {
    const mapped = noticeFromSettled(
      {
        workerId: "w-2",
        status: "completed",
        title: "Changelog",
        resultText: "Drafted.",
      },
      "child-2",
    );
    assert.equal(mapped.workerId, "w-2");
    assert.equal(mapped.title, "Changelog");
    assert.equal(mapped.status, "completed");
    assert.equal(mapped.report, "Drafted.");
    assert.equal(mapped.transcriptRef, "child-2");
  });
});

describe("tool descriptions (new copy)", () => {
  it("covers the dispatcher tool names", () => {
    assert.deepEqual(
      [...DISPATCHER_TOOL_NAMES],
      [
        SPAWN_WORKER_TOOL,
        CHECK_WORKERS_TOOL,
        STEER_WORKER_TOOL,
        STOP_WORKER_TOOL,
        DELIVER_RESULT_TOOL,
        MESSAGE_AGENT_TOOL,
        AWAIT_AGENT_TOOL,
        SPAWN_DISPATCHER_TOOL,
      ],
    );
    for (const name of DISPATCHER_TOOL_NAMES) {
      const description = TOOL_DESCRIPTIONS[name];
      assert.ok(typeof description === "string" && description.length > 20);
      assertNewCopy(description);
    }
  });

  it("spawn description says do not wait or poll", () => {
    const description = TOOL_DESCRIPTIONS[SPAWN_WORKER_TOOL];
    assert.ok(description.includes("do not wait or poll"));
  });

  it("deliver description covers silence on wake turns", () => {
    const description = TOOL_DESCRIPTIONS[DELIVER_RESULT_TOOL];
    assert.ok(description.includes("otherwise stay silent"));
    assert.ok(description.includes("concrete thing"));
  });
});

describe("wake-copy narration guard (ticket 29)", () => {
  // Machinery-UI vocabulary that must never leak into the wake/settle copy
  // (PRD §6.1: the machinery is invisible; no worker-console reading).
  const MACHINERY_TOKENS = [
    "console",
    "subagent",
    "toolview",
    "overlay",
    "timeline",
    "progress bar",
    "streaming",
  ] as const;

  function assertOrdinaryNarration(text: string): void {
    const lower = text.toLowerCase();
    for (const token of MACHINERY_TOKENS) {
      assert.ok(!lower.includes(token), `machinery token in copy: ${token}`);
    }
    assertNewCopy(text);
  }

  function fullWakeTurn(): string {
    return assembleWakeTurn(
      [
        notice(),
        notice({
          workerId: "w-2",
          title: "Grid sweep",
          status: "error",
          report: "Boom at step 3.",
          transcriptRef: "child-2",
        }),
      ],
      { resolved: [] },
    );
  }

  it("the wake turn reads as ordinary narration with no machinery tokens", () => {
    const wake = fullWakeTurn();
    assertOrdinaryNarration(wake);
    // Settle framing stays result-first, not console-like.
    assert.ok(wake.includes("# Background work landed"));
    assert.ok(wake.includes("Rewrite auth docs — completed"));
  });

  it("the wake cue is a plain instruction, not a console notice", () => {
    assertOrdinaryNarration(WAKE_CUE);
    assert.ok(WAKE_CUE.includes("Background workers finished"));
  });

  it("spawn/steer/stop notes stay narration-shaped", () => {
    assertOrdinaryNarration(
      formatSpawnAck({
        title: "Rewrite auth docs",
        workerId: "w-1",
        streamKey: "t-1",
        prompt: "Do the work.",
      }),
    );
    assertOrdinaryNarration(formatSteerNote("Rewrite auth docs"));
    assertOrdinaryNarration(formatStopNote());
  });

  it("wake instructions and standing rules carry no machinery tokens", () => {
    assertOrdinaryNarration(buildWakeInstructionsBlock());
    assertOrdinaryNarration(buildStandingRulesBlock());
  });
});

/**
 * Ticket 119 / ADR-0025 (messaging, bounded await, mitosis): the shipped
 * tools changed the contract, so the model-facing text must name them. Each
 * pin below holds one doctrine line that would otherwise silently regress to
 * the pre-116/117/118 wording.
 */
describe("dispatcher policy — messaging, bounded await, mitosis (ticket 119)", () => {
  it("How you work says one verb messages any agent, never as the user", () => {
    const policy = buildDispatcherPolicySection();
    assert.ok(
      policy.includes("You may message any agent you can see"),
      "the messaging doctrine line is present",
    );
    assert.ok(
      policy.includes(`(\`${MESSAGE_AGENT_TOOL}\`)`),
      "the line names the tool, so the model learns it exists",
    );
    assert.ok(
      policy.includes("To a worker it is a correction to work in flight"),
      "the worker target is mapped onto the steer path",
    );
    assert.ok(
      policy.includes("to another dispatcher it is one assistant writing to another"),
      "the dispatcher target is assistant-to-assistant",
    );
    assert.ok(
      policy.includes("never delivered as the user") &&
        policy.includes("never counts as the user speaking"),
      "agent traffic is never user traffic",
    );
  });

  it("How you work allows one bounded wait and forbids treating it as polling", () => {
    const policy = buildDispatcherPolicySection();
    assert.ok(
      policy.includes(
        "If your next step is blocked on one worker's result, wait on that worker once",
      ),
      "the bounded-wait line is present",
    );
    assert.ok(
      policy.includes(`(\`${AWAIT_AGENT_TOOL}\`)`),
      "the line names the tool",
    );
    assert.ok(
      policy.includes("Waiting is not polling."),
      "the wait is explicitly distinguished from polling",
    );
  });

  it("How you work states mitosis, its user-channel gap, and that it is not awaitable", () => {
    const policy = buildDispatcherPolicySection();
    assert.ok(
      policy.includes("You may summon another dispatcher"),
      "mitosis is taught",
    );
    assert.ok(
      policy.includes(`(\`${SPAWN_DISPATCHER_TOOL}\`)`),
      "the line names the tool",
    );
    assert.ok(
      policy.includes("It is a peer: same tools, same policy"),
      "the summoned dispatcher is a peer, not a helper",
    );
    assert.ok(
      policy.includes("It cannot talk to the user, so its work reaches the user only through you."),
      "the summoned dispatcher has no channel to the user",
    );
    assert.ok(
      policy.includes("It is not awaitable"),
      "a dispatcher is not awaitable",
    );
  });

  it("never-do narrows the poll ban instead of deleting it", () => {
    const policy = buildDispatcherPolicySection();
    assert.ok(
      !policy.includes("Poll a worker in a loop during a turn."),
      "the absolute per-turn poll ban is replaced, not kept",
    );
    assert.ok(
      policy.includes("Poll in a loop."),
      "polling in a loop is still forbidden",
    );
    assert.ok(
      policy.includes("`check_workers` is a snapshot"),
      "the snapshot semantics of check_workers are stated",
    );
    assert.ok(
      policy.includes("One bounded `await_agent` on the worker you actually need is the only wait."),
      "the one legal wait is named",
    );
  });

  it("standing rules replace 'Do not wait on workers' with the bounded wait", () => {
    const rules = buildStandingRulesBlock();
    assert.ok(
      !rules.includes("Do not wait on workers"),
      "the absolute no-wait rule is gone",
    );
    assert.ok(
      rules.includes(
        "One bounded wait on one worker is allowed; never loop.",
      ),
      "the replacement states the bound and the loop ban",
    );
  });

  it("no dispatcher-facing copy still names the retired send_peer", () => {
    // The name survives only as a deny candidate and a client toolview key;
    // the model must never read it again (ticket 116 retired it).
    for (const text of [
      buildDispatcherPolicySection(),
      buildStandingRulesBlock(),
      buildPeerWakeInstructionsBlock(),
      PEER_ROSTER_INTRO,
      ...DISPATCHER_TOOL_NAMES.map((name) => TOOL_DESCRIPTIONS[name]),
    ]) {
      assert.ok(
        !text.includes("send_peer"),
        `retired tool name in model-facing copy: ${text.slice(0, 60)}…`,
      );
    }
  });

  it("the peer wake tail points a reply at message_agent", () => {
    const peerWake = buildPeerWakeInstructionsBlock();
    assert.ok(
      peerWake.includes("use message_agent addressed to the sender's session id"),
      "a later reply to a peer uses the one messaging verb",
    );
    assert.ok(
      !peerWake.includes("send_peer"),
      "the retired verb is not the reply path",
    );
  });
});
