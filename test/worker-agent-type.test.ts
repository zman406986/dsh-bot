import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorkerAgentDef,
  WORKER_MAX_DEPTH,
  workerSpawnMaxDepth,
  type WorkerAgentDef,
} from "../src/worker/agent-def.js";
import { buildWorkerSystemPrompt } from "../src/worker/prompt.js";
import {
  EMPTY_WORKER_ERROR_REPORT,
  EMPTY_WORKER_REPORT_PLACEHOLDER,
  normalizeWorkerErrorReport,
  normalizeWorkerReport,
} from "../src/worker/report.js";
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

  it("returns empty deny when only work tools are known (no invented names)", () => {
    const known = new Set(["bash", "read", "web_search"]);
    const filter = buildWorkerToolFilter(known);
    assert.deepEqual(filter.deny, []);
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

  it("result is a plain JSON-serializable { deny: string[] }", () => {
    const known = new Set(["present", "todo_write", "subagent"]);
    const filter = buildWorkerToolFilter(known);
    assert.deepEqual(JSON.parse(JSON.stringify(filter)), {
      deny: ["present", "subagent", "todo_write"],
    });
    assert.deepEqual(Object.keys(filter), ["deny"]);
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
  it("returns a non-empty string", () => {
    const prompt = buildWorkerSystemPrompt();
    assert.ok(prompt.length > 0);
  });

  it("contains stable section headings", () => {
    const prompt = buildWorkerSystemPrompt();
    for (const heading of [
      "## Role",
      "## Autonomy",
      "## Limits",
      "## Asking for access",
      "## Mid-task reply",
      "## Todo ledger",
      "## Work style",
      "## Final answer",
      "## Safety",
    ]) {
      assert.ok(prompt.includes(heading), `missing section: ${heading}`);
    }
  });

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

  it("orders Role before Limits before Final answer", () => {
    const prompt = buildWorkerSystemPrompt();
    const role = prompt.indexOf("## Role");
    const limits = prompt.indexOf("## Limits");
    const finalAnswer = prompt.indexOf("## Final answer");
    assert.ok(role >= 0 && limits > role && finalAnswer > limits);
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

  // Ticket 13/69 (live pass 5, Session B-2 FINDING 1): three instructed live
  // workers skipped `request_access` outright. The registration surface was
  // already pinned correct (activation-lifecycle: the tool is the one GLOBAL;
  // host source: the global layer reaches every agent's view) — the gap was
  // model-facing: the contract never mentioned the tool while actively
  // forbidding ask-and-wait. These pins hold the teaching in place.
  it("teaches the request_access channel: the tool by name, once, then stop and wait", () => {
    const prompt = buildWorkerSystemPrompt();
    assert.ok(
      prompt.includes("request_access"),
      "the contract must name the worker-side ask tool",
    );
    assert.ok(
      /call the request_access tool once/.test(prompt),
      "the ask is one call, not a retry loop",
    );
    assert.ok(
      /end your turn and stop/.test(prompt) &&
        /answer arrives as your next message/.test(prompt),
      "after asking, the worker stops and waits for the parent answer",
    );
  });

  it("the access ask carries names-never-values and a final-denial rule", () => {
    const prompt = buildWorkerSystemPrompt();
    assert.ok(
      /only its NAME, never a value/.test(prompt),
      "credential asks pass the name only",
    );
    assert.ok(
      /do not retry the same ask/.test(prompt),
      "a denial is final — the denied ask is not retried",
    );
  });

  it("Autonomy and Limits carve out the ask channel instead of contradicting it", () => {
    const prompt = buildWorkerSystemPrompt();
    // The old absolute "Never wait for a reply." is exactly what three live
    // workers obeyed over the task's explicit ask instruction.
    assert.ok(
      !prompt.includes("Never wait for a reply"),
      "the absolute no-wait line is gone",
    );
    assert.ok(
      /exception is the access ask/.test(prompt),
      "Autonomy names the ask as the one exception",
    );
    assert.ok(
      prompt.includes(
        "Your only channels back are your final answer, the mid-task reply described below, and, when a gated action needs one-time access, the access ask described below.",
      ),
      "Limits names all three channels back (final answer, mid-task reply, access ask)",
    );
  });

  it("omits reconstruction codenames", () => {
    const prompt = buildWorkerSystemPrompt();
    for (const word of FORBIDDEN_VOCAB) {
      assert.ok(
        !prompt.includes(word),
        `prompt must not contain forbidden vocabulary: ${word}`,
      );
    }
  });

  // Ticket 55 (register D-1/D-2): the contract is delivered in a system
  // position via the spawn request's `persona`, not concatenated into the
  // first user turn. The adapter-side separation is asserted in
  // `adapter-cordis-dsh-host.test.ts`; these cases pin the contract text's
  // own constraints.
  it("contains no unescaped {{…}} — persona interpolation is strict", () => {
    const contract = buildWorkerSystemPrompt();
    assert.ok(
      !contract.includes("{{"),
      "contract must not contain a literal '{{' (persona template syntax)",
    );
    assert.ok(
      !contract.includes("}}"),
      "contract must not contain a literal '}}' (persona template syntax)",
    );
  });

  it("does not smuggle the task into the contract text", () => {
    const contract = buildWorkerSystemPrompt();
    // The old single-blob shape put "Task:" + the brief inside the prompt.
    // That is exactly what D-1 removed, so guard against it coming back.
    assert.ok(!contract.includes("Task:\n"));
  });
});

describe("worker report normalization", () => {
  it("passes non-empty text through trimmed", () => {
    assert.equal(normalizeWorkerReport("hello"), "hello");
    assert.equal(normalizeWorkerReport("  padded \n"), "padded");
  });

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

  it("empty error message becomes a non-empty wrapper", () => {
    assert.equal(normalizeWorkerErrorReport(""), EMPTY_WORKER_ERROR_REPORT);
    assert.equal(normalizeWorkerErrorReport(undefined), EMPTY_WORKER_ERROR_REPORT);
    assert.equal(normalizeWorkerErrorReport(null), EMPTY_WORKER_ERROR_REPORT);
    assert.ok(EMPTY_WORKER_ERROR_REPORT.length > 0);
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
