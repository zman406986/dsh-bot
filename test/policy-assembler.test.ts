import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  POLICY_LANGUAGES,
  POLICY_SECTION_HEADINGS,
  POLICY_SECTION_HEADINGS_ZH,
  resolvePolicyLanguage,
} from "../src/core/policy/prompts.js";
import { emptyReportPlaceholder, REPORT_CLAMP_CHARS } from "../src/core/report-clamp.js";
import {
  formatDormantSteerNote,
  formatMessageAgentDormantSteerNote,
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
      // Ticket 151: the reminder no longer orders a todo entry BEFORE the
      // spawn (the spawn creates it); it states that each spawn records one.
      "each spawn records its own todo entry",
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

describe("spawned dispatcher policy variant (ticket 141)", () => {
  // The two activation paths share one policy block. Only the statements that
  // are FALSE for a summoned dispatcher may differ; everything else is
  // byte-identical, so the user-started text is pinned against the default.

  it("user-started text is byte-identical to the pre-141 default", () => {
    const byDefault = buildDispatcherPolicySection();
    assert.equal(byDefault, buildDispatcherPolicySection("user"));
    assert.equal(assembleSessionPolicy(true), byDefault);
    assert.equal(assembleSessionPolicy(true, "user"), byDefault);
    assert.ok(byDefault.includes("You are the user's main assistant in this chat."));
    assert.ok(byDefault.includes("Only you deliver."));
  });

  it("user-started text is byte-identical to the shipped bytes (ticket 141 sha256 pin)", () => {
    // Computed from `git show HEAD:src/core/policy/prompts.ts` BEFORE the
    // first ticket-141 edit (2026-10-24): the user-started prompt must not
    // change, not even by one byte.
    //
    // Re-pinned by ticket 151 (2026-10-28): the review required the
    // "write a todo entry before you spawn" line to describe the shipped
    // behavior — the spawn creates the entry. That is an intentional,
    // ticket-scoped copy change; the pin moves with it so any OTHER drift
    // still fails here.
    const SHIPPED_SHA256 =
      "2be8e8c792e170d2c56605ee5094ce078c882e85a4aaf557b7133bd1099c7371";
    const text = buildDispatcherPolicySection("user");
    assert.equal(
      createHash("sha256").update(text, "utf8").digest("hex"),
      SHIPPED_SHA256,
    );
    // The generation argument cannot reach the user text, whatever it is.
    assert.equal(buildDispatcherPolicySection("user", 7), text);
    assert.equal(assembleSessionPolicy(true, "user", 9), text);
    assert.ok(!text.includes("generation"), "the user text never says generation");
    assert.ok(!text.includes("team leader"), "the user is not a team leader");
  });

  it("the spawned opener carries the ruled generation line (ticket 141)", () => {
    // A generation-3 dispatcher's child is generation 4: the child sees its
    // spawner's number and its own, and nothing else changes.
    const spawned = buildDispatcherPolicySection("spawned", 3);
    assert.ok(
      spawned.includes(
        "A generation-2 dispatcher spawned you. You are the generation-3 team leader.",
      ),
      "X spawns X+1: a generation-2 spawner makes a generation-3 leader",
    );
    assert.equal(assembleSessionPolicy(true, "spawned", 3), spawned);

    // Default spawned is a direct child of a user-started dispatcher (1 → 2).
    const byDefault = buildDispatcherPolicySection("spawned");
    assert.ok(
      byDefault.includes(
        "A generation-1 dispatcher spawned you. You are the generation-2 team leader.",
      ),
    );
    assert.equal(assembleSessionPolicy(true, "spawned"), byDefault);
  });

  it("spawned text says what the session is: summoned by a dispatcher, results go back to it", () => {
    const spawned = buildDispatcherPolicySection("spawned");
    assert.ok(
      spawned.includes("Another dispatcher summoned you."),
      "the opener names the summoner",
    );
    assert.ok(
      spawned.includes(
        "your results go back to that dispatcher, not to a user",
      ),
      "the opener states where results go",
    );
    assert.ok(
      spawned.includes(
        "Mark an entry `completed` at your first report of its outcome to the dispatcher that summoned you.",
      ),
      "the todo trigger is the report to the summoner, not a user acknowledgement",
    );
    assert.ok(
      spawned.includes(
        "Their results come back to you; yours go back to the dispatcher that summoned you.",
      ),
      "the delivery line names the only channel a child has",
    );
    assert.equal(assembleSessionPolicy(true, "spawned"), spawned);
  });

  it("spawned text drops the two statements a child cannot honour", () => {
    const spawned = buildDispatcherPolicySection("spawned");
    assert.ok(
      !spawned.includes("You are the user's main assistant in this chat"),
      "a spawned dispatcher is not the user's assistant in a chat",
    );
    assert.ok(
      !spawned.includes("Only you deliver"),
      "a spawned dispatcher has no user-facing delivery",
    );
    assert.ok(
      !spawned.includes("first visible acknowledgement to the user"),
      "a child has no user-visible acknowledgement to wait for",
    );
  });

  it("both variants keep the stable headings, order, and the shared doctrine", () => {
    for (const origin of ["user", "spawned"] as const) {
      const policy = buildDispatcherPolicySection(origin);
      let last = -1;
      for (const heading of [
        "# Multitask dispatcher",
        "## How you work",
        "## What you never do",
      ]) {
        const at = policy.indexOf(heading);
        assert.ok(at >= 0, `${origin}: missing section ${heading}`);
        assert.ok(at > last, `${origin}: section out of order ${heading}`);
        last = at;
      }
      for (const needle of [
        "dispatcher, not the workhorse",
        "You may summon another dispatcher",
        "never reference a task board or milestone view",
        "Poll in a loop.",
      ]) {
        assert.ok(policy.includes(needle), `${origin}: missing ${needle}`);
      }
      assertNewCopy(policy);
    }
    // Everything except the three rewritten lines is shared: the two texts
    // differ in exactly those three places.
    const userLines = buildDispatcherPolicySection("user").split("\n");
    const spawnedLines = buildDispatcherPolicySection("spawned").split("\n");
    assert.equal(spawnedLines.length, userLines.length);
    const differing = userLines.filter((line, index) => line !== spawnedLines[index]);
    assert.equal(differing.length, 3, "exactly three lines differ");
  });

  it("flag OFF stays empty for either origin", () => {
    assert.equal(assembleSessionPolicy(false, "spawned"), "");
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
    // Ticket 142: the dormant-worker variants stay narration-shaped too.
    assertOrdinaryNarration(formatDormantSteerNote("Rewrite auth docs"));
    assertOrdinaryNarration(
      formatMessageAgentDormantSteerNote("Rewrite auth docs"),
    );
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

/**
 * Ticket 153 step 1: the dispatcher policy section ships EN + ZH. The ZH face
 * is authored copy, so these pin MEANING PARITY (same rules, same numbers,
 * same tool names, same line shape) plus the absence of EN leftovers — not
 * prose quality, which ticket 154's review owns.
 */
describe("dispatcher policy — ZH face (ticket 153)", () => {
  /** Any latin word of 3+ letters outside backticks is an EN leftover. */
  const LATIN_WORD = /[A-Za-z]{3,}/g;

  it("only an exact shipped id selects ZH; everything else fails closed to EN", () => {
    // The host carries `LOCALE_IDS = ["zh", "en"]`; a preference is one of
    // those two strings or absent. Only the exact ZH literal switches.
    assert.equal(resolvePolicyLanguage("zh"), "zh");
    for (const unknownPreference of [
      "en",
      "zh-CN",
      "zh-TW",
      "ZH",
      "zh_CN",
      "ja",
      "",
      null,
      undefined,
      0,
      1,
      true,
      {},
      [],
      () => "zh",
    ]) {
      assert.equal(
        resolvePolicyLanguage(unknownPreference),
        "en",
        `must fail closed to EN: ${String(unknownPreference)}`,
      );
    }
    assert.deepEqual([...POLICY_LANGUAGES], ["zh", "en"]);
  });

  it("default and explicit EN compose the same bytes as before ticket 153", () => {
    // The EN face is untouched: the existing sha256 pin above covers the
    // exact bytes, and these assert the new argument cannot reach it.
    const byDefault = buildDispatcherPolicySection();
    assert.equal(buildDispatcherPolicySection("user", 2, "en"), byDefault);
    assert.equal(buildDispatcherPolicySection("user", 7, "en"), byDefault);
    assert.equal(assembleSessionPolicy(true), byDefault);
    assert.equal(assembleSessionPolicy(true, "user", 2, "en"), byDefault);
    assert.equal(
      assembleSessionPolicy(true, "user", 2, resolvePolicyLanguage("ja")),
      byDefault,
    );
  });

  it("ZH keeps the section headings, in order", () => {
    for (const origin of ["user", "spawned"] as const) {
      const policy = buildDispatcherPolicySection(origin, 2, "zh");
      let last = -1;
      for (const heading of POLICY_SECTION_HEADINGS_ZH) {
        const at = policy.indexOf(heading);
        assert.ok(at >= 0, `${origin}: missing ZH section ${heading}`);
        assert.ok(at > last, `${origin}: ZH section out of order ${heading}`);
        last = at;
      }
    }
    // The marker lists are separate and neither leaks into the other face.
    for (const heading of POLICY_SECTION_HEADINGS_ZH) {
      assert.ok(!POLICY_SECTION_HEADINGS.includes(heading as never));
    }
  });

  it("ZH carries every directive the EN face carries (meaning parity)", () => {
    const zh = buildDispatcherPolicySection("user", 2, "zh");
    // Each entry is one EN directive and a ZH phrase that can only appear if
    // that directive survived the authoring pass.
    const parity: readonly (readonly [string, string])[] = [
      ["You are the user's main assistant in this chat.", "用户在这个聊天里的主要助手"],
      ["stay responsive", "保持随时响应"],
      ["dispatcher, not the workhorse", "你是调度器，不是干重活的人"],
      ["Independent requests run in parallel", "相互独立的请求并行推进"],
      ["A correction to work already in flight is a steer", "对已经开始的工作做修正"],
      ["One live worker per stream", "每条流只允许一个在运行的工作者"],
      ["Each spawn records its own todo entry", "每次启动都会记下它自己的待办条目"],
      ["first visible acknowledgement", "第一次对用户可见的确认"],
      ["Worker exit alone completes nothing", "工作者退出本身不算完成"],
      ["reconcile the ledger", "先对齐账本"],
      ["Worker prompts are self-contained", "给工作者的提示必须自包含"],
      ["Only you deliver", "只有你负责送达"],
      ["message any agent you can see", "给任何你看得见的代理发消息"],
      ["Waiting is not polling", "等待不是轮询"],
      ["summon another dispatcher", "召唤另一个调度器"],
      ["same tools, same policy", "同样的工具、同样的策略"],
      ["stop or change course in plain language", "让你停下或改变方向"],
      ["Never claim a stopped worker produced a result", "绝不要声称已停止的工作者产出了结果"],
      ["never reference a task board or milestone view", "绝不要提到任务看板或里程碑视图"],
      ["The user never hears the machinery", "用户永远看不到背后的运行细节"],
      ["Poll in a loop", "循环轮询"],
      ["A spawn only starts it", "启动只是开始"],
      ["Clone a stream because the user corrected it", "因为用户做了修正，就复制出一条流"],
      ["Dump a worker transcript", "把工作者的记录"],
      ["similar jargon", "这类行话"],
    ];
    for (const [enNeedle, zhNeedle] of parity) {
      assert.ok(
        buildDispatcherPolicySection("user").includes(enNeedle),
        `EN face lost its counterpart of: ${zhNeedle}`,
      );
      assert.ok(zh.includes(zhNeedle), `ZH face missing: ${zhNeedle}`);
    }
  });

  it("ZH names the tools and statuses as literal ASCII identifiers", () => {
    const zh = buildDispatcherPolicySection("user", 2, "zh");
    for (const identifier of [
      CHECK_WORKERS_TOOL,
      MESSAGE_AGENT_TOOL,
      AWAIT_AGENT_TOOL,
      SPAWN_DISPATCHER_TOOL,
      "in_progress",
      "completed",
    ]) {
      assert.ok(
        zh.includes(`\`${identifier}\``),
        `ZH copy must keep the literal identifier: ${identifier}`,
      );
    }
  });

  it("ZH keeps the numbered bounds the EN face states", () => {
    const zh = buildDispatcherPolicySection("user", 2, "zh");
    // One bounded wait only, and the only legal wait is a single await_agent.
    assert.ok(zh.includes("等一次"), "the single-wait bound survives");
    assert.ok(zh.includes("有上限"), "the wait is still bounded");
    assert.ok(zh.includes("唯一允许的等待"), "the one legal wait is named");
  });

  it("ZH carries no EN leftovers besides the allowed ASCII identifiers", () => {
    for (const origin of ["user", "spawned"] as const) {
      const zh = buildDispatcherPolicySection(origin, 3, "zh");
      // Strip the backticked ASCII identifiers the contract requires, then
      // any latin word left is an untranslated EN fragment.
      const withoutIdentifiers = zh.replace(/`[^`]+`/g, " ");
      const leftovers = [...withoutIdentifiers.matchAll(LATIN_WORD)].map(
        (match) => match[0],
      );
      assert.deepEqual(
        leftovers,
        [],
        `${origin}: untranslated EN words leaked into the ZH face`,
      );
      // The EN headings must not appear in the ZH block.
      for (const heading of POLICY_SECTION_HEADINGS) {
        assert.ok(!zh.includes(heading), `${origin}: EN heading in ZH copy: ${heading}`);
      }
    }
  });

  it("ZH carries no forbidden identifier either (ADR-0018 no-verbatim)", () => {
    for (const origin of ["user", "spawned"] as const) {
      assertNewCopy(buildDispatcherPolicySection(origin, 2, "zh"));
    }
  });

  it("the spawned ZH variant differs from the user ZH variant in exactly three lines", () => {
    // Same shape as the EN pin: the origin only rewrites the opener, the todo
    // trigger, and the delivery line.
    const userLines = buildDispatcherPolicySection("user", 2, "zh").split("\n");
    const spawnedLines = buildDispatcherPolicySection("spawned", 2, "zh").split("\n");
    assert.equal(spawnedLines.length, userLines.length);
    const differing = userLines.filter((line, index) => line !== spawnedLines[index]);
    assert.equal(differing.length, 3, "exactly three ZH lines differ by origin");
  });

  it("the spawned ZH opener carries the generation line", () => {
    const zh = buildDispatcherPolicySection("spawned", 3, "zh");
    assert.ok(
      zh.includes("召唤你的是第 2 代调度器。你是第 3 代团队负责人。"),
      "X spawns X+1 survives translation",
    );
    // The user face never mentions generations, in either language.
    const userZh = buildDispatcherPolicySection("user", 9, "zh");
    assert.equal(userZh, buildDispatcherPolicySection("user", 2, "zh"));
    assert.ok(
      !/第 *\d+ *代/.test(userZh),
      "the user face never states a generation number",
    );
  });

  it("ZH mirrors the EN line shape (same blocks, same bullet count)", () => {
    // Meaning parity is a structural fact here: the faces are authored
    // one-to-one, so a bullet added to one face and not the other fails.
    for (const origin of ["user", "spawned"] as const) {
      const en = buildDispatcherPolicySection(origin, 2, "en").split("\n");
      const zh = buildDispatcherPolicySection(origin, 2, "zh").split("\n");
      assert.equal(zh.length, en.length, `${origin}: line count differs`);
      const enBullets = en.filter((line) => line.startsWith("- ")).length;
      const zhBullets = zh.filter((line) => line.startsWith("- ")).length;
      assert.equal(zhBullets, enBullets, `${origin}: bullet count differs`);
      assert.equal(enBullets, 19, "14 How-you-work + 5 never-do bullets");
      // Blank lines and headings sit at the same indices in both faces.
      en.forEach((line, index) => {
        const other = zh[index] ?? "";
        if (line === "") assert.equal(other, "", `${origin}: blank line ${index} moved`);
        if (line.startsWith("#")) {
          assert.ok(other.startsWith("#"), `${origin}: heading ${index} missing in ZH`);
        }
      });
    }
  });

  it("ZH never mixes faces: no ZH character in the EN block", () => {
    for (const origin of ["user", "spawned"] as const) {
      const en = buildDispatcherPolicySection(origin);
      assert.ok(
        !/[\u3400-\u9fff]/.test(en),
        `${origin}: CJK characters leaked into the EN face`,
      );
    }
  });

  it("flag OFF stays empty in either language", () => {
    assert.equal(assembleSessionPolicy(false, "user", 2, "zh"), "");
    assert.equal(assembleSessionPolicy(false, "spawned", 2, "zh"), "");
  });
});
