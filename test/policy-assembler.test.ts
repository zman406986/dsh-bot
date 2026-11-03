import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  assemblePeerWakeTurn,
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
import type { PeerNotice } from "../src/core/peer-types.js";
import { bindDispatcherLifecycle } from "../src/adapter/parent-agent.js";
import type { AdapterContext, AgentLike, CordisDshHost } from "../src/adapter/cordis-dsh-host.js";
import { createMultitask } from "../src/core/multitask.js";
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
    ...POLICY_LANGUAGES.flatMap((language) =>
      (["user", "spawned"] as const).map((origin) =>
        [
          buildStandingRulesBlock(language, origin),
          buildWakeInstructionsBlock(language, origin),
          buildPeerWakeInstructionsBlock(language, origin),
        ].join("\n"),
      ),
    ),
    PEER_ROSTER_INTRO,
    WAKE_CUE,
    ...DISPATCHER_TOOL_NAMES.map((name) => TOOL_DESCRIPTIONS[name]),
  ];
}

/** The owner's team-leader copy, verbatim (ticket 175). */
const TEAM_LEADER_STANDING_RULES_EN = [
  "## Standing rules",
  "- Chunk down tasks as much as you can, run as many lanes in parallel as you can. If any task can be run in parallel chunks, do that instead of giving to a single agent.",
  "- Keep turns short: dispatch or re-chunk, then end or wait bounded (`await_agent`); never loop.",
  "- A correction is a steer (`message_agent`), not a cloned worker. When a part is running and the direction changes, steer it.",
  "- Plain and concise language, no jargon. Lead with what is now unblocked, not \"it worked\".",
  "- Update the ledger and keep it lean. It is how you see what is running, what is parked, and what still needs splitting.",
].join("\n");

const TEAM_LEADER_WAKE_EN = [
  "## What to do now",
  "",
  "1. Match each settled worker to its ledger entry (`todo_id` on the worker record). A settle closes one part, not the job.",
  "2. Re-chunk what is left. A finished part usually changes the split: decide what can run in parallel now, and dispatch it before you answer anyone.",
  "3. Report back to whoever gave you the task order. `message_agent` to your parent agent; use the user-facing send if the user directly ordered something from you.",
  "4. Report failures early instead of exhausting save attempts. If the approach looks like a dead end, report at the first sign.",
  "5. Silence is a valid outcome only when nothing changed for anyone above you.",
].join("\n");

const TEAM_LEADER_PEER_WAKE_EN = [
  "## What to do now",
  "",
  "1. Treat every message above as coming from another assistant — not from the user.",
].join("\n");

/** A peer note that is NOT a worker reply, so the peer block is selected. */
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
      // Ticket 175: the team-leader faces are model-facing copy too, so the
      // machinery vocabulary binds them exactly as it binds the chief's.
      buildStandingRulesBlock("en", "spawned"),
      buildWakeInstructionsBlock("en", "spawned"),
      buildPeerWakeInstructionsBlock("en", "spawned"),
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
    // Ticket 175: the team-leader face restates the same discipline — a
    // settle closes one part, and nothing is marked completed there.
    const leaderWake = buildWakeInstructionsBlock("en", "spawned");
    assert.ok(leaderWake.includes("A settle closes one part, not the job"));
  });

  it("the chief-of-staff blocks are byte-identical to the shipped bytes (ticket 175 sha pins)", () => {
    // Ticket 175 split three blocks into two classes each. These shas are the
    // PRE-split chief-of-staff bytes, captured before the split landed, so
    // any drift in the class the user still reads fails here.
    const SHIPPED = {
      standing: "76fccd7e67d4157d0ef1fc70f8ac54c4a0e42be0f6290e7d432d225599f3bd51",
      wake: "79c556007306408ec59dffa2e8d935df6e1ef7ca59a3ac7d6a9f3d42fa1410a9",
      peer: "a4429b302910a945b0b5507aae5897229c02ac1ff48b2f04b5c0c4d995e603bd",
    } as const;
    const sha = (text: string) =>
      createHash("sha256").update(text, "utf8").digest("hex");
    // Omitted class and explicit `user` are the same bytes.
    assert.equal(sha(buildStandingRulesBlock()), SHIPPED.standing);
    assert.equal(sha(buildStandingRulesBlock("en", "user")), SHIPPED.standing);
    assert.equal(sha(buildWakeInstructionsBlock()), SHIPPED.wake);
    assert.equal(sha(buildWakeInstructionsBlock("en", "user")), SHIPPED.wake);
    assert.equal(sha(buildPeerWakeInstructionsBlock()), SHIPPED.peer);
    assert.equal(sha(buildPeerWakeInstructionsBlock("en", "user")), SHIPPED.peer);
  });

  it("the team-leader faces carry the owner's text verbatim (ticket 175)", () => {
    assert.equal(buildStandingRulesBlock("en", "spawned"), TEAM_LEADER_STANDING_RULES_EN);
    assert.equal(buildWakeInstructionsBlock("en", "spawned"), TEAM_LEADER_WAKE_EN);
    assert.equal(buildPeerWakeInstructionsBlock("en", "spawned"), TEAM_LEADER_PEER_WAKE_EN);
    // The owner's 2026-11-03 deletions must not come back.
    for (const text of [
      buildStandingRulesBlock("en", "spawned"),
      buildWakeInstructionsBlock("en", "spawned"),
    ]) {
      assert.ok(!text.includes("Tell the user what you are doing"));
      assert.ok(!text.includes("whether the user should hear about it"));
      assert.ok(!text.includes("retry as a new spawn"));
    }
  });

  it("the three blocks branch on the class and stay distinct per class", () => {
    for (const language of POLICY_LANGUAGES) {
      for (const block of [
        buildStandingRulesBlock,
        buildWakeInstructionsBlock,
        buildPeerWakeInstructionsBlock,
      ] as const) {
        assert.notEqual(block(language, "user"), block(language, "spawned"), language);
        // Both faces are H2-led and keep their section marker.
        assert.ok(block(language, "spawned").startsWith("## "), language);
      }
    }
    // Team-leader faces are SHORTER than the chief-of-staff faces: 5 vs 6
    // standing rules, 5 vs 6 wake steps, 1 vs 5 peer steps.
    const bullets = (text: string) =>
      text.split("\n").filter((line) => line.startsWith("- ")).length;
    const numbers = (text: string) =>
      text.split("\n").filter((line) => /^\d+\. /.test(line)).length;
    assert.deepEqual(
      [bullets(buildStandingRulesBlock("en", "user")), bullets(buildStandingRulesBlock("en", "spawned"))],
      [6, 5],
    );
    assert.deepEqual(
      [numbers(buildWakeInstructionsBlock("en", "user")), numbers(buildWakeInstructionsBlock("en", "spawned"))],
      [6, 5],
    );
    assert.deepEqual(
      [
        numbers(buildPeerWakeInstructionsBlock("en", "user")),
        numbers(buildPeerWakeInstructionsBlock("en", "spawned")),
      ],
      [5, 1],
    );
  });

  it("every caller-level assembler threads the class through", () => {
    // A team leader's reminder carries its rules; a user chat the others.
    assert.ok(
      assembleTurnReminder([], null, "en", "spawned").includes(
        "Chunk down tasks as much as you can",
      ),
    );
    assert.ok(
      !assembleTurnReminder([], null, "en", "user").includes(
        "Chunk down tasks as much as you can",
      ),
    );
    // Defaults stay chief of staff — the pre-175 bytes.
    assert.equal(assembleTurnReminder([]), assembleTurnReminder([], null, "en", "user"));

    assert.ok(
      assembleWakeTurn([notice()], "en", "spawned").includes("Re-chunk what is left"),
    );
    assert.ok(
      !assembleWakeTurn([notice()], "en", "user").includes("Re-chunk what is left"),
    );
    assert.equal(assembleWakeTurn([notice()]), assembleWakeTurn([notice()], "en", "user"));

    assert.ok(
      assemblePeerWakeTurn([peerNote()], "en", "spawned").includes(
        "Treat every message above as coming from another assistant",
      ),
    );
    assert.ok(
      !assemblePeerWakeTurn([peerNote()], "en", "spawned").includes(
        "never the user-facing send",
      ),
      "the leader's peer face keeps only the provenance rule",
    );
    assert.equal(
      assemblePeerWakeTurn([peerNote()]),
      assemblePeerWakeTurn([peerNote()], "en", "user"),
    );
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

describe("ticket 175 — the class is recorded per session", () => {
  /**
   * Minimal lifecycle harness. The full activation harness lives in
   * `test/adapter-policy-inject.test.ts`, which this lane does not own; what
   * R1 needs here is only the map's behaviour — set at activation, readable
   * while live, cleared at deactivation, null for a dormant session.
   */
  function harness() {
    const listeners = new Map<string, Array<(payload: never) => void>>();
    const ctx = {
      on(name: string, cb: (payload: never) => void) {
        const list = listeners.get(name) ?? [];
        list.push(cb);
        listeners.set(name, list);
        return () => {
          listeners.set(
            name,
            (listeners.get(name) ?? []).filter((entry) => entry !== cb),
          );
        };
      },
      emit(name: string, payload: unknown) {
        for (const cb of [...(listeners.get(name) ?? [])]) cb(payload as never);
      },
      subagents: { startActivation: async () => ({ childId: "x", dispose: async () => {} }) },
      agents: { get: () => undefined },
      jobs: { list: () => [] },
    } as unknown as AdapterContext;
    const host = {
      bindParent() {},
      unbindParent() {},
      workerIdOf: () => undefined,
      peerToolActivity: () => null,
      emitStepBoundary() {},
      hasParent: () => false,
      parentAgentOf: () => undefined,
      listLiveJobs: () => [],
      onWorkerSettled() {},
      onStepBoundary() {},
      onAccessRequest() {},
      async requestDispatcherWakeup() {},
      async spawnWorker() {
        return "stub-worker";
      },
      async interruptWorker() {},
      async sendMessage() {},
      dispose() {},
    } as unknown as CordisDshHost;
    const multitask = createMultitask(host);
    return { ctx, host, multitask };
  }

  function agent(sessionId: string) {
    const injected: unknown[] = [];
    return {
      session: { id: sessionId, header: { parentSession: null, delegationDepth: 0 } },
      injected,
      inject(message: unknown) {
        injected.push(message);
      },
      followup() {},
    } as unknown as AgentLike & { injected: unknown[] };
  }

  it("answers the live class, and null for a dormant or never-activated session", () => {
    const { ctx, host, multitask } = harness();
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);

    assert.equal(lifecycle.dispatcherOrigin("never-seen"), null);

    const chief = agent("chat-user");
    const leader = agent("chat-leader");
    assert.deepEqual(lifecycle.activate(chief), { ok: true });
    assert.deepEqual(lifecycle.activate(leader, { origin: "spawned" }), { ok: true });

    assert.equal(lifecycle.dispatcherOrigin("chat-user"), "user");
    assert.equal(lifecycle.dispatcherOrigin("chat-leader"), "spawned");
  });

  it("drops the class at deactivation so a re-activation cannot inherit it", () => {
    const { ctx, host, multitask } = harness();
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);

    const leader = agent("chat-1");
    lifecycle.activate(leader, { origin: "spawned" });
    assert.equal(lifecycle.dispatcherOrigin("chat-1"), "spawned");

    lifecycle.deactivate("chat-1");
    assert.equal(lifecycle.dispatcherOrigin("chat-1"), null);

    // The same session id activated later as a user chat: the class is the
    // NEW activation's, not the stale one's.
    const again = agent("chat-1");
    assert.deepEqual(lifecycle.activate(again), { ok: true });
    assert.equal(lifecycle.dispatcherOrigin("chat-1"), "user");
  });

  it("unbind clears every recorded class", () => {
    const { ctx, host, multitask } = harness();
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);
    lifecycle.activate(agent("a"), { origin: "spawned" });
    lifecycle.activate(agent("b"));
    lifecycle.unbind();
    assert.equal(lifecycle.dispatcherOrigin("a"), null);
    assert.equal(lifecycle.dispatcherOrigin("b"), null);
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
