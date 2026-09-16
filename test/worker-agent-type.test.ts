import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorkerAgentDef,
  WORKER_MAX_DEPTH,
  type WorkerAgentDef,
} from "../src/worker/agent-def.js";
import {
  assembleWorkerPrompt,
  buildWorkerSystemPrompt,
} from "../src/worker/prompt.js";
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
  CHECK_WORKERS_TOOL,
  DELIVER_RESULT_TOOL,
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
    ]) {
      assert.ok(names.has(required), `missing deny candidate: ${required}`);
    }
  });

  it("denies the five registered dispatcher tools on the spawned worker filter", () => {
    const dispatcherTools = [
      SPAWN_WORKER_TOOL,
      CHECK_WORKERS_TOOL,
      STEER_WORKER_TOOL,
      STOP_WORKER_TOOL,
      DELIVER_RESULT_TOOL,
    ];
    const known = new Set([...dispatcherTools, "bash"]);
    const filter = createWorkerAgentDef().resolveToolFilter(known);
    for (const name of dispatcherTools) {
      assert.ok(
        filter.deny.includes(name),
        `worker can still resolve dispatcher tool: ${name}`,
      );
    }
    assert.ok(!filter.deny.includes("bash"));
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
      "## Todo ledger",
      "## Work style",
      "## Final answer",
    ]) {
      assert.ok(prompt.includes(heading), `missing section: ${heading}`);
    }
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

  it("omits reconstruction codenames", () => {
    const prompt = buildWorkerSystemPrompt();
    for (const word of FORBIDDEN_VOCAB) {
      assert.ok(
        !prompt.includes(word),
        `prompt must not contain forbidden vocabulary: ${word}`,
      );
    }
  });

  it("assembleWorkerPrompt places system first and task after a separator", () => {
    const system = buildWorkerSystemPrompt();
    const assembled = assembleWorkerPrompt(system, "Do the research.");
    assert.ok(assembled.startsWith(system));
    assert.ok(assembled.includes("Task:\nDo the research."));
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
  it("exposes system prompt, leaf maxDepth, and resolving filter", () => {
    const def: WorkerAgentDef = createWorkerAgentDef();
    assert.ok(def.systemPrompt.includes("## Role"));
    assert.equal(def.maxDepth, WORKER_MAX_DEPTH);
    assert.equal(def.maxDepth, 0);
    const filter = def.resolveToolFilter(new Set(["present", "bash"]));
    assert.deepEqual([...filter.deny], ["present"]);
  });
});
