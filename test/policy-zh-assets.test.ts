import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Ticket 153 step 2: every model-facing asset ships EN + ZH through the same
 * fail-closed seam. Parity is asserted structurally — same rules, same
 * numbers, same ASCII identifiers, same line shape — never as prose quality;
 * ticket 154's review owns the wording.
 */

import {DISPATCHER_TOOL_NAMES, EMPTY_LEDGER_LINE, PEER_ROSTER_INTRO, PEER_ROSTER_INTRO_ZH, PEER_ROSTER_SECTION_HEADING, PEER_ROSTER_SECTION_HEADING_ZH, PEER_WAKE_SECTION_HEADINGS, REMINDER_SECTION_HEADINGS, REMINDER_SECTION_HEADINGS_ZH, TOOL_DESCRIPTIONS, WAKE_SECTION_HEADINGS, buildPeerWakeInstructionsBlock, buildStandingRulesBlock, buildWakeInstructionsBlock, resolvePolicyLanguage, type PolicyLanguage} from "../src/core/policy/prompts.js";
import {assemblePeerWakeTurn, assembleTurnReminder, assembleWakeTurn} from "../src/core/policy/assembler.js";
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
    // Ticket 174 / ADR-0033: `request_access` is gone, so it is not asserted.
    // `class`/`target` were the ask tool's parameter names and went with it.
    for (const identifier of [
      "reply_to_dispatcher",
      "progress",
      "blocked",
      "note",
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

  it("wake cues have a ZH face", () => {
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
  });

  it("no CJK reaches any EN face (the EN bytes are the shipped text)", () => {
    const enFaces: readonly string[] = [
      buildStandingRulesBlock(EN),
      buildWakeInstructionsBlock(EN),
      buildPeerWakeInstructionsBlock(EN),
      buildWorkerSystemPrompt(EN),
      assembleWakeTurn([], EN),
      assemblePeerWakeTurn([peerNote()], EN),
      WAKE_CUE,
      PEER_WAKE_CUE,
      RESUME_WAKE_CUE,
      ...DISPATCHER_TOOL_NAMES.map((name) => TOOL_DESCRIPTIONS[name]),
      ...PEER_WAKE_SECTION_HEADINGS,
      ...WAKE_SECTION_HEADINGS,
      ...REMINDER_SECTION_HEADINGS,
      ...WORKER_CONTRACT_HEADINGS,
      PEER_ROSTER_SECTION_HEADING,
      PEER_ROSTER_INTRO,
      ...DISPATCHER_TOOL_NAMES,
    ];
    for (const text of enFaces) {
      assert.ok(!CJK.test(text), `CJK leaked into an EN face: ${text.slice(0, 40)}…`);
    }
  });
});
