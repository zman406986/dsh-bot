import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Ticket 153 step 2: every model-facing asset ships EN + ZH through the same
 * fail-closed seam. Parity is asserted structurally — same rules, same
 * numbers, same ASCII identifiers, same line shape — never as prose quality;
 * ticket 154's review owns the wording.
 */

import {
  ACCESS_SECTION_HEADING,
  ACCESS_SECTION_HEADING_ZH,
  AWAIT_AGENT_TOOL,
  DISPATCHER_TOOL_NAMES,
  EMPTY_LEDGER_LINE,
  MESSAGE_AGENT_TOOL,
  PEER_ROSTER_INTRO,
  PEER_ROSTER_INTRO_ZH,
  PEER_ROSTER_SECTION_HEADING,
  PEER_ROSTER_SECTION_HEADING_ZH,
  PEER_WAKE_SECTION_HEADINGS,
  PEER_WAKE_SECTION_HEADINGS_ZH,
  REMINDER_SECTION_HEADINGS,
  REMINDER_SECTION_HEADINGS_ZH,
  SPAWN_WORKER_TOOL,
  TOOL_DESCRIPTIONS,
  WAKE_SECTION_HEADINGS,
  WAKE_SECTION_HEADINGS_ZH,
  buildAccessPolicyBlock,
  buildPeerWakeInstructionsBlock,
  buildStandingRulesBlock,
  buildWakeInstructionsBlock,
  resolvePolicyLanguage,
  toolDescriptionsFor,
  type PolicyLanguage,
} from "../src/core/policy/prompts.js";
import {
  assembleAccessSection,
  assemblePeerWakeTurn,
  assembleTurnReminder,
  assembleWakeTurn,
  type WakeNotice,
} from "../src/core/policy/assembler.js";
import {
  APPROVAL_LOCATION_LOCAL,
  APPROVAL_LOCATION_LOCAL_ZH,
  APPROVAL_LOCATION_REMOTE_ZH,
  ACCESS_PROMPT_ALLOW,
  ACCESS_PROMPT_ALLOW_ZH,
  ACCESS_PROMPT_ALWAYS_ALLOW_ZH,
  ACCESS_PROMPT_DENY,
  ACCESS_PROMPT_DENY_ZH,
  accessPromptQuestion,
  approvalLocationLineFor,
  parseAccessPromptAnswer,
} from "../src/adapter/access-prompt.js";
import {
  PEER_WAKE_CUE,
  RESUME_WAKE_CUE,
  WAKE_CUE,
  peerWakeCueFor,
  resumeWakeCueFor,
  wakeCueFor,
} from "../src/adapter/wake-copy.js";
import {
  WORKER_CONTRACT_HEADINGS,
  WORKER_CONTRACT_HEADINGS_ZH,
  buildWorkerSystemPrompt,
  resolveWorkerPromptLanguage,
} from "../src/worker/prompt.js";
import { createWorkerAgentDef } from "../src/worker/agent-def.js";
import type { AccessNotice, AccessRequestNotice } from "../src/core/access-types.js";
import type { PeerNotice } from "../src/core/peer-types.js";

const EN: PolicyLanguage = "en";
const ZH: PolicyLanguage = "zh";
const LATIN_WORD = /[A-Za-z]{3,}/g;
const CJK = /[\u3400-\u9fff]/;

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

/**
 * Latin words permitted inside ZH prose: format names that have no Chinese
 * spelling. Everything else outside backticks is an untranslated fragment —
 * tool names, parameter names and status literals must be backticked.
 */
const ALLOWED_ZH_LATIN = new Set(["Markdown", "JSON"]);

/** Latin words outside backticks that would be untranslated EN fragments. */
function leftoversIn(text: string): string[] {
  return [...text.replace(/`[^`]+`/g, " ").matchAll(LATIN_WORD)]
    .map((match) => match[0])
    .filter((word) => !ALLOWED_ZH_LATIN.has(word));
}

function numberedLines(text: string): number {
  return text.split("\n").filter((line) => /^\d+\. /.test(line)).length;
}

function bulletLines(text: string): number {
  return text.split("\n").filter((line) => line.startsWith("- ")).length;
}

function request(): AccessRequestNotice {
  return {
    workerId: "w1",
    requestId: "req-1",
    title: "Deploy the staging build",
    body: {
      class: "tool",
      target: "deploy",
      reason: "the release cannot ship without it",
    },
  };
}

function denial(): AccessNotice {
  return {
    kind: "access-resolved",
    workerId: "w1",
    title: "Deploy the staging build",
    decision: { kind: "deny", reason: "timeout", detail: "timed out" },
    body: {
      class: "tool",
      target: "deploy",
      reason: "the release cannot ship without it",
    },
  };
}

function peerNote(): PeerNotice {
  return {
    messageId: "msg-1",
    fromAgentId: "peer-session-1",
    fromName: "Peer A",
    to: { kind: "agent", agentId: "self-session" },
    conversationId: "conv-1",
    text: "How is the migration going?",
    priority: false,
    createdAtMs: 1_700_000_000_000,
  };
}

describe("remaining model-facing copy — ZH face (ticket 153 step 2)", () => {
  it("standing rules: EN unchanged, ZH parallel, no cross-face leakage", () => {
    const en = buildStandingRulesBlock();
    assert.equal(buildStandingRulesBlock(EN), en);
    assert.equal(buildStandingRulesBlock(), en, "default stays EN");
    assert.ok(!CJK.test(en), "EN standing rules carry no CJK");

    const zh = buildStandingRulesBlock(ZH);
    assert.ok(zh.startsWith(REMINDER_SECTION_HEADINGS_ZH[1]), "ZH heading");
    assert.ok(!zh.includes(REMINDER_SECTION_HEADINGS[1]), "no EN heading");
    assert.equal(bulletLines(zh), bulletLines(en), "same rule count");
    assert.deepEqual(leftoversIn(zh), [], "no EN leftovers");
    assert.ok(zh.includes("有上限"), "the single bounded wait survives");
    assert.ok(zh.includes("`completed`"), "the status literal stays ASCII");
    assertNewCopy(zh);
  });

  it("wake instructions: same six steps, same bounds, ZH-only prose", () => {
    const en = buildWakeInstructionsBlock();
    assert.equal(buildWakeInstructionsBlock(EN), en);
    assert.equal(buildWakeInstructionsBlock(), en);
    assert.ok(!CJK.test(en));

    const zh = buildWakeInstructionsBlock(ZH);
    assert.ok(zh.startsWith(WAKE_SECTION_HEADINGS_ZH[2]), "ZH heading");
    assert.equal(numberedLines(zh), numberedLines(en), "same step count");
    assert.equal(numberedLines(zh), 6);
    assert.ok(zh.includes("`todo_id`"), "the field name stays ASCII");
    assert.ok(zh.includes("`completed`"), "the status literal stays ASCII");
    assert.deepEqual(leftoversIn(zh), [], "no EN leftovers");
    assertNewCopy(zh);
  });

  it("access policy block: same ask/deny rules, timeout still denies by default", () => {
    const en = buildAccessPolicyBlock();
    assert.equal(buildAccessPolicyBlock(EN), en);
    assert.equal(buildAccessPolicyBlock(), en);
    assert.ok(!CJK.test(en));

    const zh = buildAccessPolicyBlock(ZH);
    assert.equal(bulletLines(zh), bulletLines(en), "same bullet count");
    assert.ok(zh.includes("超时默认拒绝"), "timeout-deny survives");
    assert.deepEqual(leftoversIn(zh), [], "no EN leftovers");
    assertNewCopy(zh);
  });

  it("peer wake instructions: same five steps, reply path still message_agent", () => {
    const en = buildPeerWakeInstructionsBlock();
    assert.equal(buildPeerWakeInstructionsBlock(EN), en);
    assert.equal(buildPeerWakeInstructionsBlock(), en);
    assert.ok(!CJK.test(en));

    const zh = buildPeerWakeInstructionsBlock(ZH);
    assert.ok(zh.startsWith(PEER_WAKE_SECTION_HEADINGS_ZH[2]), "ZH heading");
    assert.equal(numberedLines(zh), numberedLines(en), "same step count");
    assert.equal(numberedLines(zh), 5);
    assert.ok(zh.includes("`message_agent`"), "the one messaging verb stays ASCII");
    assert.deepEqual(leftoversIn(zh), [], "no EN leftovers");
    assertNewCopy(zh);
  });

  it("the eight tool descriptions: ZH names every tool, keeps every bound", () => {
    const en = TOOL_DESCRIPTIONS;
    const zh = toolDescriptionsFor(ZH);
    assert.equal(toolDescriptionsFor(EN), en, "EN face unchanged");
    assert.deepEqual(
      Object.keys(zh).sort(),
      Object.keys(en).sort(),
      "same key set",
    );
    assert.equal(Object.keys(zh).length, 8);
    for (const name of DISPATCHER_TOOL_NAMES) {
      assert.ok(zh[name].length > 0, `${name}: ZH description exists`);
      assert.ok(!CJK.test(en[name]), `${name}: EN description carries no CJK`);
      assert.ok(CJK.test(zh[name]), `${name}: ZH description is Chinese`);
      assert.deepEqual(
        leftoversIn(zh[name]),
        [],
        `${name}: untranslated EN words leaked into the ZH face`,
      );
      assertNewCopy(zh[name]);
    }
    // Load-bearing identifiers and numbers stay literal ASCII.
    assert.ok(zh[SPAWN_WORKER_TOOL].includes("stream_key"));
    assert.ok(zh[AWAIT_AGENT_TOOL].includes("120000"));
    assert.ok(zh[AWAIT_AGENT_TOOL].includes("30000"));
    assert.ok(zh[AWAIT_AGENT_TOOL].includes("still-running"));
    assert.ok(zh[AWAIT_AGENT_TOOL].includes("released"));
    assert.ok(zh[MESSAGE_AGENT_TOOL].includes("`priority`"));
    assert.ok(zh[MESSAGE_AGENT_TOOL].includes("list_agents"));
  });

  it("wake turn, access section and peer turn render the selected face", () => {
    const settled: WakeNotice = {
      workerId: "w1",
      title: "Fix the build",
      status: "completed",
      report: "done",
      transcriptRef: null,
    };
    const enWake = assembleWakeTurn([settled]);
    const zhWake = assembleWakeTurn([settled], undefined, ZH);
    assert.ok(enWake.startsWith(WAKE_SECTION_HEADINGS[0]));
    assert.ok(zhWake.startsWith(WAKE_SECTION_HEADINGS_ZH[0]));
    for (const heading of WAKE_SECTION_HEADINGS_ZH) {
      assert.ok(zhWake.includes(heading), `ZH wake heading: ${heading}`);
    }
    for (const heading of WAKE_SECTION_HEADINGS) {
      assert.ok(!zhWake.includes(heading), `EN wake heading in ZH: ${heading}`);
    }
    assert.ok(!CJK.test(enWake), "EN wake carries no CJK");
    assert.equal(
      zhWake.split("\n").length,
      enWake.split("\n").length,
      "same line shape",
    );
    assert.ok(zhWake.includes("w1"), "worker id stays literal");
    assert.ok(zhWake.includes("completed"), "status stays literal");
    assert.ok(buildAccessPolicyBlock(ZH).length > 0);

    const accessEn = assembleAccessSection([request()], [denial()]);
    const accessZh = assembleAccessSection([request()], [denial()], ZH);
    assert.ok(accessEn.startsWith(ACCESS_SECTION_HEADING));
    assert.ok(accessZh.startsWith(ACCESS_SECTION_HEADING_ZH));
    assert.ok(!CJK.test(accessEn));
    assert.ok(accessZh.includes("req-1"), "request id stays literal in ZH");
    assert.equal(bulletLines(accessZh), bulletLines(accessEn), "same row count");

    const peerEn = assemblePeerWakeTurn([peerNote()]);
    const peerZh = assemblePeerWakeTurn([peerNote()], ZH);
    assert.ok(peerEn.startsWith(`# ${PEER_WAKE_SECTION_HEADINGS[0]}`));
    assert.ok(peerZh.startsWith(`# ${PEER_WAKE_SECTION_HEADINGS_ZH[0]}`));
    assert.ok(!CJK.test(peerEn), "EN peer turn carries no CJK");
    assert.ok(peerZh.includes("peer-session-1"), "sender id stays literal");
  });

  it("the reminder's peer roster tail follows the language", () => {
    const snapshot = {
      peers: [{ sessionId: "peer-a", label: "Peer A", liveness: "idle" }],
      selfSessionId: "self",
    };
    const en = assembleTurnReminder([], snapshot);
    const zh = assembleTurnReminder([], snapshot, ZH);
    assert.ok(en.includes(PEER_ROSTER_SECTION_HEADING));
    assert.ok(en.includes(PEER_ROSTER_INTRO));
    assert.ok(zh.includes(PEER_ROSTER_SECTION_HEADING_ZH));
    assert.ok(zh.includes(PEER_ROSTER_INTRO_ZH));
    assert.ok(!zh.includes(PEER_ROSTER_SECTION_HEADING), "no EN heading in ZH");
    assert.ok(!zh.includes(PEER_ROSTER_INTRO), "no EN intro in ZH");
    assert.ok(zh.includes("peer-a"), "session ids stay literal");
    assert.ok(zh.startsWith(REMINDER_SECTION_HEADINGS_ZH[0]), "ZH ledger heading");
    // The empty-ledger marker is a marker, not prose: identical in both faces.
    assert.ok(zh.includes(`- ${EMPTY_LEDGER_LINE}`));
    assert.ok(en.includes(`- ${EMPTY_LEDGER_LINE}`));
    // Defaults keep the EN face byte-identical.
    assert.equal(assembleTurnReminder([], snapshot), en);
  });

  it("worker contract: same sections, same identifiers, ZH-only prose", () => {
    const en = buildWorkerSystemPrompt();
    assert.equal(buildWorkerSystemPrompt(EN), en);
    assert.equal(buildWorkerSystemPrompt(), en, "default stays EN");
    assert.ok(!CJK.test(en), "EN contract carries no CJK");

    const zh = buildWorkerSystemPrompt(ZH);
    let last = -1;
    for (const heading of WORKER_CONTRACT_HEADINGS_ZH) {
      const at = zh.indexOf(heading);
      assert.ok(at >= 0, `missing ZH heading ${heading}`);
      assert.ok(at > last, `ZH heading out of order ${heading}`);
      last = at;
    }
    for (const heading of WORKER_CONTRACT_HEADINGS) {
      assert.ok(!zh.includes(heading), `EN heading in ZH contract: ${heading}`);
    }
    assert.equal(zh.split("\n").length, en.split("\n").length, "same line shape");
    for (const identifier of [
      "request_access",
      "reply_to_dispatcher",
      "progress",
      "blocked",
      "note",
      "class",
      "target",
    ]) {
      assert.ok(zh.includes(identifier), `literal identifier lost: ${identifier}`);
    }
    assert.deepEqual(leftoversIn(zh), [], "no EN leftovers");
    assertNewCopy(zh);
    // The persona template fence holds on both faces (the spawn request's
    // `persona` uses strict `{{…}}` interpolation).
    for (const face of [en, zh]) {
      assert.ok(!face.includes("{{") && !face.includes("}}"));
    }
    // Fail-closed selection, same rule as the policy face.
    assert.equal(resolveWorkerPromptLanguage("zh"), "zh");
    for (const unknown of ["en", "zh-CN", "ZH", "ja", "", null, undefined, 1]) {
      assert.equal(resolveWorkerPromptLanguage(unknown), "en");
    }
    // The worker agent definition carries the selected face.
    assert.equal(createWorkerAgentDef().persona, en);
    assert.equal(createWorkerAgentDef("zh").persona, zh);
  });

  it("wake cues, access prompt copy and location lines have a ZH face", () => {
    assert.equal(wakeCueFor(EN), WAKE_CUE);
    assert.ok(CJK.test(wakeCueFor(ZH)));
    assert.ok(!CJK.test(wakeCueFor(EN)));
    assert.ok(CJK.test(peerWakeCueFor(ZH)));
    assert.ok(CJK.test(resumeWakeCueFor(ZH)));
    assert.equal(resumeWakeCueFor(EN), RESUME_WAKE_CUE);
    assert.equal(peerWakeCueFor(EN), PEER_WAKE_CUE);
    // Fail-closed: only the exact id switches, like the policy face.
    assert.equal(wakeCueFor(resolvePolicyLanguage("zh-CN")), WAKE_CUE);
    assert.equal(resumeWakeCueFor(resolvePolicyLanguage("ja")), RESUME_WAKE_CUE);

    const ticket = { workerId: "w1", requestId: "r1", body: request().body };
    const enQuestion = accessPromptQuestion(ticket);
    const zhQuestion = accessPromptQuestion(ticket, "worker", ZH);
    assert.equal(enQuestion.id, zhQuestion.id, "same question id");
    assert.ok(!CJK.test(enQuestion.question));
    assert.ok(CJK.test(zhQuestion.question));
    assert.ok(zhQuestion.question.includes("w1"), "worker id stays literal");
    assert.equal(enQuestion.options.length, 3, "allow / always / deny");
    assert.deepEqual(
      zhQuestion.options.map((option) => option.label),
      [ACCESS_PROMPT_ALLOW_ZH, ACCESS_PROMPT_ALWAYS_ALLOW_ZH, ACCESS_PROMPT_DENY_ZH],
    );
    // The wildcard fence drops "always allow" in both faces.
    const wild = { ...ticket, body: { ...ticket.body, target: "src/*" } };
    assert.equal(accessPromptQuestion(wild, "worker", ZH).options.length, 2);
    assert.equal(accessPromptQuestion(wild).options.length, 2);

    // Location lines.
    assert.equal(approvalLocationLineFor("worker", EN), APPROVAL_LOCATION_LOCAL);
    assert.equal(approvalLocationLineFor("worker", ZH), APPROVAL_LOCATION_LOCAL_ZH);
    assert.equal(
      approvalLocationLineFor("computer-worker", ZH),
      APPROVAL_LOCATION_REMOTE_ZH,
    );
    assert.ok(!CJK.test(approvalLocationLineFor("worker", EN)));

    // The parser accepts either face's labels, so a UI rendering one language
    // still routes an answer phrased in the other.
    const questionId = enQuestion.id;
    const answer = (label: string) => ({
      answers: [{ id: questionId, selected: [label] }],
    });
    assert.equal(
      parseAccessPromptAnswer(answer(ACCESS_PROMPT_ALLOW), questionId),
      "allow",
    );
    assert.equal(
      parseAccessPromptAnswer(answer(ACCESS_PROMPT_ALLOW_ZH), questionId),
      "allow",
    );
    assert.equal(
      parseAccessPromptAnswer(answer(ACCESS_PROMPT_ALWAYS_ALLOW_ZH), questionId),
      "always-allow",
    );
    assert.equal(
      parseAccessPromptAnswer(answer(ACCESS_PROMPT_DENY_ZH), questionId),
      "deny",
    );
    // Ambiguity still fails closed: deny wins over any allow shape.
    assert.equal(
      parseAccessPromptAnswer(
        {
          answers: [
            { id: questionId, selected: [ACCESS_PROMPT_ALLOW, ACCESS_PROMPT_DENY_ZH] },
          ],
        },
        questionId,
      ),
      "deny",
    );
    // An unknown label resolves nothing (the relay's timeout still decides).
    assert.equal(
      parseAccessPromptAnswer(answer(ACCESS_PROMPT_DENY), "other-id"),
      null,
    );
  });

  it("no CJK reaches any EN face (the EN bytes are the shipped text)", () => {
    const enFaces: readonly string[] = [
      buildStandingRulesBlock(EN),
      buildWakeInstructionsBlock(EN),
      buildAccessPolicyBlock(EN),
      buildPeerWakeInstructionsBlock(EN),
      buildWorkerSystemPrompt(EN),
      assembleWakeTurn([], undefined, EN),
      assemblePeerWakeTurn([peerNote()], EN),
      WAKE_CUE,
      PEER_WAKE_CUE,
      RESUME_WAKE_CUE,
      ...DISPATCHER_TOOL_NAMES.map((name) => TOOL_DESCRIPTIONS[name]),
      ...PEER_WAKE_SECTION_HEADINGS,
      ...WAKE_SECTION_HEADINGS,
      ...REMINDER_SECTION_HEADINGS,
      ...WORKER_CONTRACT_HEADINGS,
      ACCESS_SECTION_HEADING,
      PEER_ROSTER_SECTION_HEADING,
      PEER_ROSTER_INTRO,
      ...DISPATCHER_TOOL_NAMES,
    ];
    for (const text of enFaces) {
      assert.ok(!CJK.test(text), `CJK leaked into an EN face: ${text.slice(0, 40)}…`);
    }
  });
});
