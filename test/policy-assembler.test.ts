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
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
  MESSAGE_AGENT_TOOL,
  PEER_ROSTER_INTRO,
  POLICY_LANGUAGES,
  POLICY_SECTION_HEADINGS,
  POLICY_SECTION_HEADINGS_ZH,
  SPAWN_DISPATCHER_TOOL,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
  TOOL_DESCRIPTIONS,
  buildDispatcherPolicySection,
  buildPeerWakeInstructionsBlock,
  buildStandingRulesBlock,
  buildWakeInstructionsBlock,
  resolvePolicyLanguage,
} from "../src/core/policy/prompts.js";
import { emptyReportPlaceholder, REPORT_CLAMP_CHARS } from "../src/core/report-clamp.js";
import {
  formatMessageAgentDormantSteerNote,
  formatDormantSteerNote,
  formatSpawnAck,
  formatSteerNote,
  formatStopNote,
} from "../src/core/tool-results.js";
import { WAKE_CUE } from "../src/adapter/wake-copy.js";
import type { TodoItem } from "../src/core/todo-reconciler.js";

/** ADR-0018 no-verbatim identifiers. */
const FORBIDDEN_VOCAB = ["sand", "executor", "MessageSubagent", "SAND_MULTITASK_"];

/** Machinery-UI vocabulary that must never leak into model-facing narration. */
const MACHINERY_TOKENS = [
  "console",
  "subagent",
  "toolview",
  "overlay",
  "timeline",
  "progress bar",
  "streaming",
];

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

/** Every model-facing copy surface the plugin ships. */
function modelFacingCopy(): string[] {
  return [
    buildDispatcherPolicySection("user"),
    buildDispatcherPolicySection("spawned"),
    buildStandingRulesBlock(),
    buildWakeInstructionsBlock(),
    buildPeerWakeInstructionsBlock(),
    PEER_ROSTER_INTRO,
    WAKE_CUE,
    ...DISPATCHER_TOOL_NAMES.map((name) => TOOL_DESCRIPTIONS[name]),
  ];
}

describe("policy assembler", () => {
  it("flag OFF yields an empty policy in every origin and language", () => {
    for (const origin of ["user", "spawned"] as const) {
      for (const language of POLICY_LANGUAGES) {
        assert.equal(assembleSessionPolicy(false, origin, 2, language), "");
      }
    }
    assert.equal(assembleSessionPolicy(true).length > 0, true);
  });

  it("the dispatcher tool list is exactly the shipped eight, in order", () => {
    assert.deepEqual([...DISPATCHER_TOOL_NAMES], [
      SPAWN_WORKER_TOOL,
      CHECK_WORKERS_TOOL,
      STEER_WORKER_TOOL,
      STOP_WORKER_TOOL,
      DELIVER_RESULT_TOOL,
      MESSAGE_AGENT_TOOL,
      AWAIT_AGENT_TOOL,
      SPAWN_DISPATCHER_TOOL,
    ]);
    for (const name of DISPATCHER_TOOL_NAMES) {
      assert.ok(TOOL_DESCRIPTIONS[name].length > 20, `thin description: ${name}`);
    }
  });

  it("the retired send_peer name is gone from every model-facing surface", () => {
    for (const text of modelFacingCopy()) {
      assert.ok(!text.includes("send_peer"), `retired tool name in: ${text.slice(0, 60)}`);
    }
  });

  it("no model-facing copy carries a forbidden identifier or machinery token", () => {
    // The machinery vocabulary (PRD §6.1: the machinery stays invisible) binds
    // the narration surfaces — wake turn, wake cue, standing/wake rules, notes.
    const narration = [
      assembleWakeTurn([notice(), notice({ workerId: "w-2", status: "error", report: "Boom." })]),
      WAKE_CUE,
      buildWakeInstructionsBlock(),
      buildStandingRulesBlock(),
      formatSpawnAck({ title: "t", workerId: "w-1", streamKey: "s", prompt: "p" }),
      formatSteerNote("t"),
      formatDormantSteerNote("t"),
      formatMessageAgentDormantSteerNote("t"),
      formatStopNote(),
    ];
    for (const text of [...narration, ...modelFacingCopy()]) {
      const lower = text.toLowerCase();
      for (const token of FORBIDDEN_VOCAB) {
        assert.ok(!lower.includes(token.toLowerCase()), `"${token}" in: ${text.slice(0, 60)}`);
      }
    }
    for (const text of narration) {
      const lower = text.toLowerCase();
      for (const token of MACHINERY_TOKENS) {
        assert.ok(!lower.includes(token), `machinery token "${token}" in: ${text.slice(0, 60)}`);
      }
    }
  });

  it("keeps ADR-0007: a settle completes nothing until the dispatcher delivers", () => {
    const wake = buildWakeInstructionsBlock();
    assert.ok(wake.includes("A settle does not complete anything"));
    assert.ok(wake.includes("mark the matching todo `completed`"));
    for (const text of [assembleSessionPolicy(true), wake]) {
      assert.ok(!text.includes("user has the result"));
      assert.ok(!text.includes("user actually has the result"));
    }
  });

  it("the user-started policy is byte-identical to the shipped bytes (ticket 141 sha pin)", () => {
    // Re-pinned per ticket: 151, 166, 170, then 2026-11-02's chief-of-staff
    // rewrite. Any OTHER drift still fails here.
    const SHIPPED_SHA256 =
      "29aaea291cc1431cbf0338ea0d8ff7159cfd70e37d0e132b620e7a1829c7a464";
    const text = buildDispatcherPolicySection("user");
    assert.equal(createHash("sha256").update(text, "utf8").digest("hex"), SHIPPED_SHA256);
    // The generation argument can never reach either class.
    for (const origin of ["user", "spawned"] as const) {
      assert.equal(buildDispatcherPolicySection(origin, 7), buildDispatcherPolicySection(origin, 2));
    }
    assert.ok(!text.toLowerCase().includes("generation"));
  });

  it("the two dispatcher classes are distinct and both H1-led", () => {
    const user = buildDispatcherPolicySection("user");
    const spawned = buildDispatcherPolicySection("spawned");
    assert.notEqual(user, spawned);
    assert.ok(user.startsWith("# ") && spawned.startsWith("# "));
    // The shared doctrine stays in the standing rules, not in either class.
    const rules = buildStandingRulesBlock();
    assert.ok(rules.includes("never loop"));
    assert.ok(rules.includes("wait bounded"));
    assert.ok(rules.includes(`(\`${AWAIT_AGENT_TOOL}\`)`));
    assert.ok(rules.includes(`(\`${MESSAGE_AGENT_TOOL}\`)`));
  });

  it("the no-summon rule is stated to the team leader only (ticket 176)", () => {
    // Owner ruling 2026-11-03: a summoned dispatcher may not summon further
    // dispatchers. The tool surface withholds the verb (pinned in
    // `test/spawn-dispatcher-activation.test.ts`) and the host refuses the
    // call (pinned in `test/spawn-dispatcher-host.test.ts`); this is the third
    // layer — the leader is TOLD the rule, so it does not spend a turn
    // discovering the tool is missing.
    const spawned = buildDispatcherPolicySection("spawned");
    assert.ok(spawned.includes("You do not spawn other dispatchers."));
    assert.ok(
      spawned.includes("report back to the dispatcher that summoned you"),
    );
    // The chief of staff may summon, so it must never carry the same rule.
    assert.ok(!buildDispatcherPolicySection("user").includes("You do not spawn other dispatchers."));
  });

  it("renders the ledger with the (empty) marker and one line per todo", () => {
    const empty = assembleTurnReminder([]);
    assert.ok(empty.includes("## Ledger") && empty.includes("(empty)"));
    assert.ok(empty.includes("## Standing rules"));

    const filled = assembleTurnReminder([
      todo({ id: "t-1", title: "Summarize RFCs", status: "in_progress" }),
      todo({ id: "t-2", title: "Changelog stub", status: "pending" }),
    ]);
    assert.ok(filled.includes("- t-1 · in_progress · Summarize RFCs"));
    assert.ok(filled.includes("- t-2 · pending · Changelog stub"));
    assert.ok(!filled.includes("(empty)"));
  });

  it("wake turn: sections in order, report clamped, statuses honest", () => {
    const plain = assembleWakeTurn([notice()]);
    assert.ok(
      plain.indexOf("## Settled workers") < plain.indexOf("## What to do now"),
      "sections out of order",
    );
    assert.ok(plain.includes("Silence is a valid"));

    const long = assembleWakeTurn([notice({ report: "R".repeat(REPORT_CLAMP_CHARS + 500) })]);
    assert.ok(long.includes("report truncated"));
    assert.ok(long.includes("Full transcript: child-1"), "transcript pointer attaches");

    assert.ok(assembleWakeTurn([notice({ report: "" })]).includes(emptyReportPlaceholder()));
    assert.ok(assembleWakeTurn([notice({ status: "error", report: "boom" })]).includes("Worker failed:"));

    // An aborted worker never exposes report text (no revival).
    const aborted = assembleWakeTurn([notice({ status: "aborted", report: "secret work product" })]);
    assert.ok(aborted.includes("Stopped before completion"));
    assert.ok(!aborted.includes("secret work product"));
  });

  it("maps a settled worker notice onto the wake row", () => {
    assert.deepEqual(
      noticeFromSettled(
        { workerId: "w-2", status: "completed", title: "Changelog", resultText: "Drafted." },
        "child-2",
      ),
      { workerId: "w-2", title: "Changelog", status: "completed", report: "Drafted.", transcriptRef: "child-2" },
    );
  });

  it("the spawn/steer/stop notes stay narration-shaped and name the channel", () => {
    const ack = formatSpawnAck({
      title: "Rewrite auth docs",
      workerId: "w-1",
      streamKey: "t-1",
      prompt: "Do the work.",
    });
    assert.ok(ack.includes("background") && ack.includes("do not need to wait"));
    assert.ok(formatSteerNote("x").includes("no restart"));
    assert.ok(formatDormantSteerNote("x").length > 0);
    assert.ok(formatMessageAgentDormantSteerNote("x").length > 0);
    assert.ok(formatStopNote().includes("Tell the user only if"));
    assert.ok(TOOL_DESCRIPTIONS[CHECK_WORKERS_TOOL].includes("never a wait loop"));
  });
});

describe("policy language selection", () => {
  it("only the exact shipped id selects ZH; everything else fails closed to EN", () => {
    assert.equal(resolvePolicyLanguage("zh"), "zh");
    for (const other of ["en", "zh-CN", "ZH", "zh_CN", "ja", "", null, undefined, 0, 1, true, {}, []]) {
      assert.equal(resolvePolicyLanguage(other), "en", `not EN: ${String(other)}`);
    }
    assert.deepEqual([...POLICY_LANGUAGES], ["zh", "en"]);
  });

  it("the EN face is byte-stable: neither the language nor the origin moves it", () => {
    const byDefault = buildDispatcherPolicySection();
    assert.equal(buildDispatcherPolicySection("user", 2, "en"), byDefault);
    assert.equal(buildDispatcherPolicySection("user", 7, "en"), byDefault);
    assert.equal(
      assembleSessionPolicy(true, "user", 2, resolvePolicyLanguage("ja")),
      byDefault,
    );
  });
});

describe("policy ZH face — structure, not prose", () => {
  it("each class keeps the ZH headings, in order, and they never leak into EN", () => {
    for (const origin of ["user", "spawned"] as const) {
      const zh = buildDispatcherPolicySection(origin, 2, "zh");
      let last = -1;
      for (const heading of POLICY_SECTION_HEADINGS_ZH) {
        const at = zh.indexOf(heading);
        assert.ok(at > last, `${origin}: ZH heading missing or out of order: ${heading}`);
        last = at;
      }
    }
    assert.equal(
      POLICY_SECTION_HEADINGS.some((heading) => POLICY_SECTION_HEADINGS_ZH.includes(heading as never)),
      false,
    );
  });

  it("ZH mirrors the EN line shape: same lines, same bullets, headings aligned", () => {
    // The two classes have different bullet counts (chief of staff 4, team
    // leader 7 after ticket 176 added the no-summon rule to the owner's
    // 2026-11-03 rewrite), so the pin is per class.
    const bullets: Record<"user" | "spawned", number> = { user: 4, spawned: 7 };
    for (const origin of ["user", "spawned"] as const) {
      const en = buildDispatcherPolicySection(origin, 2, "en").split("\n");
      const zh = buildDispatcherPolicySection(origin, 2, "zh").split("\n");
      assert.equal(zh.length, en.length, `${origin}: line count differs`);
      const countBullets = (lines: string[]) => lines.filter((l) => l.startsWith("- ")).length;
      assert.equal(countBullets(zh), countBullets(en), `${origin}: bullet count differs`);
      assert.equal(countBullets(en), bullets[origin], `${origin}: bullet count drifted`);
      en.forEach((line, index) => {
        if (line === "") assert.equal(zh[index], "", `${origin}: blank line ${index} moved`);
        if (line.startsWith("#")) assert.ok(zh[index]?.startsWith("#"), `${origin}: heading ${index} missing in ZH`);
      });
    }
  });

  it("ZH keeps the literal ASCII tool identifiers and the bounded wait", () => {
    const zh = buildDispatcherPolicySection("user", 2, "zh");
    assert.ok(zh.includes(`\`${SPAWN_DISPATCHER_TOOL}\``));
    // The team-leader text (owner rewrite 2026-11-03) names no tool at all;
    // the scheduling health-check block that carried `check_workers` is gone.
    for (const language of ["en", "zh"] as const) {
      assert.equal(
        [...buildDispatcherPolicySection("spawned", 2, language).matchAll(/`[^`]+`/g)].length,
        0,
        `team-leader ${language} face names no backticked tool`,
      );
    }
    const zhRules = buildStandingRulesBlock("zh");
    assert.ok(zhRules.includes("有上限"));
    assert.ok(zhRules.includes("绝不循环"));
  });

  it("ZH carries no untranslated EN words and no forbidden identifier", () => {
    for (const origin of ["user", "spawned"] as const) {
      const zh = buildDispatcherPolicySection(origin, 3, "zh");
      const withoutIdentifiers = zh.replace(/`[^`]+`/g, " ");
      assert.deepEqual([...withoutIdentifiers.matchAll(/[A-Za-z]{3,}/g)].map((m) => m[0]), [], origin);
      for (const heading of POLICY_SECTION_HEADINGS) assert.ok(!zh.includes(heading), origin);
      const lower = zh.toLowerCase();
      for (const term of FORBIDDEN_VOCAB) assert.ok(!lower.includes(term.toLowerCase()), term);
    }
  });

  it("no CJK reaches any EN face", () => {
    for (const origin of ["user", "spawned"] as const) {
      assert.doesNotMatch(buildDispatcherPolicySection(origin), /[\u3400-\u9fff]/, origin);
    }
  });

  it("the two ZH classes differ and state no generation number", () => {
    const user = buildDispatcherPolicySection("user", 2, "zh");
    const spawned = buildDispatcherPolicySection("spawned", 2, "zh");
    assert.notEqual(user, spawned);
    for (const zh of [user, spawned]) {
      assert.ok(!/第 *\d+ *代/.test(zh), "a generation number reached the face");
      assert.equal(buildDispatcherPolicySection("user", 9, "zh"), user);
    }
  });
});
