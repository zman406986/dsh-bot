import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorkerAgentDef,
  WORKER_MAX_DEPTH,
  workerSpawnMaxDepth,
  type WorkerAgentDef,
} from "../src/worker/agent-def.js";
import { buildWorkerSystemPrompt } from "../src/worker/prompt.js";
import {EMPTY_WORKER_REPORT_PLACEHOLDER, normalizeWorkerErrorReport, normalizeWorkerReport} from "../src/worker/report.js";
import {
  buildWorkerToolFilter,
  WORKER_DENIED_TOOL_CANDIDATES,
} from "../src/worker/tool-barrier.js";
import {
  AWAIT_AGENT_TOOL,
  CHECK_WORKERS_TOOL,
  SPAWN_DISPATCHER_TOOL,
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
  MESSAGE_AGENT_TOOL,
  SEND_PEER_TOOL,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
} from "../src/core/policy/prompts.js";

const FORBIDDEN_VOCAB = [
  "sand",
  "executor",
  "MessageSubagent",
  "SAND_MULTITASK_",
] as const;

describe("worker tool barrier", () => {
  it("intersects deny candidates with known global tools", () => {
    const known = new Set(["todo_write", "present", "subagent", "send_message"]);
    const filter = buildWorkerToolFilter(known);
    assert.deepEqual(
      [...filter.deny].sort(),
      ["present", "send_message", "subagent", "todo_write"],
    );
  });

  it("omits unknown candidate names rather than throwing", () => {
    const known = new Set(["bash", "present", "not-a-candidate"]);
    const filter = buildWorkerToolFilter(known);
    assert.deepEqual([...filter.deny], ["present"]);
    for (const name of filter.deny) {
      assert.ok(WORKER_DENIED_TOOL_CANDIDATES.includes(name));
      assert.ok(known.has(name));
    }
  });

  it("covers user, peer, spawn, job, todo, and dispatcher categories", () => {
    const names = new Set(WORKER_DENIED_TOOL_CANDIDATES);
    for (const required of [
      "present",
      "ask_user_question",
      "send_message",
      "interrupt_agent",
      "subagent",
      "list_subagent_models",
      "job_list",
      "job_output",
      "job_kill",
      "todo_write",
      "spawn_worker",
      "check_workers",
      "steer_worker",
      "stop_worker",
      "deliver_result",
      "send_peer",
      "message_agent",
      "await_agent",
      "spawn_dispatcher",
    ]) {
      assert.ok(names.has(required), `missing deny candidate: ${required}`);
    }
  });

  it("denies the eight registered dispatcher tools on the spawned worker filter", () => {
    const dispatcherTools = [
      SPAWN_WORKER_TOOL,
      CHECK_WORKERS_TOOL,
      STEER_WORKER_TOOL,
      STOP_WORKER_TOOL,
      DELIVER_RESULT_TOOL,
      MESSAGE_AGENT_TOOL,
      AWAIT_AGENT_TOOL,
      SPAWN_DISPATCHER_TOOL,
    ];
    // The declared surface, tool for tool (ticket 116 retired send_peer,
    // which stays a deny candidate above; ticket 117 added await_agent;
    // ticket 118 added spawn_dispatcher).
    assert.deepEqual([...dispatcherTools], [...DISPATCHER_TOOL_NAMES]);
    const known = new Set([...dispatcherTools, SEND_PEER_TOOL, "bash"]);
    const filter = createWorkerAgentDef().resolveToolFilter(known);
    for (const name of dispatcherTools) {
      assert.ok(
        filter.deny.includes(name),
        `worker can still resolve dispatcher tool: ${name}`,
      );
    }
    // The retired name stays denied too — a historical row must never become
    // visible on a worker surface.
    assert.ok(filter.deny.includes(SEND_PEER_TOOL));
    assert.ok(!filter.deny.includes("bash"));
  });

  // Ticket 119: the durable form of the rule above. Derived from the declared
  // surface rather than a hand-kept list, so a ninth dispatcher tool cannot
  // ship without a matching deny candidate — the failure mode is a
  // dispatcher-only verb silently reaching a worker.
  it("every declared dispatcher tool is a deny candidate (structural, not a list)", () => {
    const candidates = new Set(WORKER_DENIED_TOOL_CANDIDATES);
    for (const name of DISPATCHER_TOOL_NAMES) {
      assert.ok(
        candidates.has(name),
        `dispatcher tool missing from the worker deny candidates: ${name}`,
      );
    }
    // The retired verb keeps its deny entry even though nothing registers it:
    // a historical row must never become visible on a worker.
    assert.ok(candidates.has(SEND_PEER_TOOL));
    // And nothing dispatcher-only is missing from the intersection path.
    const known = new Set([...DISPATCHER_TOOL_NAMES, SEND_PEER_TOOL]);
    const deny = new Set(buildWorkerToolFilter(known).deny);
    for (const name of known) {
      assert.ok(deny.has(name), `worker filter leaks dispatcher tool: ${name}`);
    }
  });
});

describe("worker prompt assembly", () => {
  // Ticket 56 (register D-3): the reference appends one shared safety section to
  // every subagent prompt, unconditionally. This is the structural pin, so the
  // section cannot be silently dropped later.
  it("appends the safety section last, and does not restate the host's guarantee", () => {
    const prompt = buildWorkerSystemPrompt();
    assert.ok(prompt.includes("## Safety"));
    assert.equal(
      prompt.lastIndexOf("## "),
      prompt.indexOf("## Safety"),
      "safety is appended as the final section",
    );

    // The host already injects the fixed delegation-scope statement into every
    // child ("subagent:delegation"): scope is fixed at start, cannot be widened,
    // and approval-requiring operations are rejected automatically. Restating it
    // spends tokens on every turn of every worker, so ours must complement it.
    const lowered = prompt.toLowerCase();
    assert.ok(
      !lowered.includes("permission scope"),
      "must not restate the host's fixed-scope statement",
    );
    assert.ok(
      !lowered.includes("approval"),
      "must not restate the host's approval-rejection statement",
    );
  });

  it("states delegated role, no user contact, no spawn, no todo, final-answer contract", () => {
    const prompt = buildWorkerSystemPrompt();
    assert.ok(prompt.includes("delegated worker"));
    assert.ok(prompt.includes("no way to message the user"));
    assert.ok(prompt.includes("no way to message other agents"));
    assert.ok(/spawn/i.test(prompt));
    assert.ok(prompt.includes("do not maintain a todo list"));
    assert.ok(prompt.includes("final answer"));
  });

  // Ticket 174 / ADR-0033 removed the worker access-ask feature in full. The
  // contract teaches exactly ONE worker->parent channel now (the mid-task
  // reply), and `## Limits` states the surviving rule in our own words —
  // scope is fixed, it cannot be widened from inside the session, so a task
  // that needs more ends with an honest report. The host's
  // `subagent:delegation` wording is still NOT restated (the pin above).
  it("names no access-ask channel and no ask tool", () => {
    const prompt = buildWorkerSystemPrompt();
    assert.ok(
      !prompt.includes("request_access"),
      "the removed ask tool must not be named",
    );
    assert.ok(
      !prompt.includes("Asking for access"),
      "the removed ask section must be gone",
    );
    assert.ok(
      !/access ask/.test(prompt),
      "nothing may promise an ask channel",
    );
  });

  it("Limits names only the final answer and the mid-task reply", () => {
    const prompt = buildWorkerSystemPrompt();
    assert.ok(
      prompt.includes(
        "Your only channels back are your final answer and the mid-task reply described below.",
      ),
      "Limits names exactly the two surviving channels",
    );
  });

  it("Limits states the fixed scope and the report-instead-of-ask rule", () => {
    const prompt = buildWorkerSystemPrompt();
    assert.ok(
      prompt.includes(
        "What you can reach is fixed when you start; you cannot widen it from inside the session.",
      ),
      "the surviving rule: scope is fixed at start",
    );
    assert.ok(
      prompt.includes(
        "If the task needs access you do not have, say what was blocked and why in your final answer instead of asking for it.",
      ),
      "a blocked worker reports, it does not ask",
    );
  });

  it("still teaches the mid-task reply as the surviving worker->parent channel", () => {
    const prompt = buildWorkerSystemPrompt();
    assert.ok(prompt.includes("## Mid-task reply"));
    assert.ok(prompt.includes("reply_to_dispatcher"));
    assert.ok(prompt.includes("progress, blocked, or note"));
  });

  // Ticket 55 (register D-1/D-2): the contract is delivered in a system
  // position via the spawn request's `persona`, not concatenated into the
  // first user turn. The adapter-side separation is asserted in
  // `adapter-cordis-dsh-host.test.ts`; these cases pin the contract text's
  // own constraints.
});

describe("worker report normalization", () => {
  it("replaces empty / whitespace / nullish with the placeholder", () => {
    assert.equal(normalizeWorkerReport(""), EMPTY_WORKER_REPORT_PLACEHOLDER);
    assert.equal(normalizeWorkerReport("   "), EMPTY_WORKER_REPORT_PLACEHOLDER);
    assert.equal(
      normalizeWorkerReport(undefined),
      EMPTY_WORKER_REPORT_PLACEHOLDER,
    );
    assert.equal(normalizeWorkerReport(null), EMPTY_WORKER_REPORT_PLACEHOLDER);
  });

  it("error reports pass the message and never the empty placeholder", () => {
    assert.equal(normalizeWorkerErrorReport("boom"), "boom");
    assert.notEqual(normalizeWorkerErrorReport("boom"), EMPTY_WORKER_REPORT_PLACEHOLDER);
  });

});

describe("createWorkerAgentDef", () => {
  it("exposes the contract persona, leaf delegation budget, and resolving filter", () => {
    const def: WorkerAgentDef = createWorkerAgentDef();
    // Ticket 55: the contract is named `persona` because that is the channel it
    // travels on. It must be the same text `buildWorkerSystemPrompt` produces.
    assert.equal(def.persona, buildWorkerSystemPrompt());
    assert.ok(def.persona.includes("## Role"));
    // Ticket 83: `maxDepth` is the worker's OWN delegation BUDGET below
    // itself (0 = leaf, ADR-0003), never the spawn request's `maxDepth`
    // slot — the host reads that slot as the child's absolute ceiling.
    assert.equal(def.maxDepth, WORKER_MAX_DEPTH);
    assert.equal(def.maxDepth, 0);
    const filter = def.resolveToolFilter(new Set(["present", "bash"]));
    assert.deepEqual([...filter.deny], ["present"]);
  });

  it("derives the spawn request ceiling from the one leaf-budget constant (ticket 83)", () => {
    // The request slot value = parent depth + 1 hop + WORKER_MAX_DEPTH, so
    // the "0 = leaf" budget cannot silently reappear in the request slot.
    assert.equal(workerSpawnMaxDepth(0), 0 + 1 + WORKER_MAX_DEPTH);
    assert.equal(workerSpawnMaxDepth(0), 1);
    assert.equal(workerSpawnMaxDepth(2), 3);
    assert.equal(workerSpawnMaxDepth(5), 6);
    // An explicit non-default budget stays derivable from the same formula.
    assert.equal(workerSpawnMaxDepth(0, 1), 2);
  });
});
