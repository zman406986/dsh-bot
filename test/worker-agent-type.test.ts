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
  applyWorkerComposition,
  type WorkerCompositionContext,
} from "../src/worker/preset.js";
import {
  HOST_SPAWN_TOOL_CANDIDATES,
  withheldHostSpawnTools,
} from "../src/core/tools.js";
import {
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
  MESSAGE_AGENT_TOOL,
  SEND_PEER_TOOL,
  SPAWN_DISPATCHER_TOOL,
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
    // `send_message` is the stock worker->parent reply lane: allowed.
    assert.deepEqual(
      [...filter.deny].sort(),
      ["present", "subagent", "todo_write"],
    );
    assert.equal(filter.deny.includes("send_message"), false);
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

  it("covers user, peer, stock spawn/control, job, todo, and custom categories", () => {
    const names = new Set(WORKER_DENIED_TOOL_CANDIDATES);
    for (const required of [
      "present",
      "ask_user_question",
      "interrupt_agent",
      "list_agents",
      "subagent",
      "subagent_fork",
      "list_subagent_models",
      "job_list",
      "job_output",
      "job_kill",
      "todo_write",
      "deliver_result",
      "send_peer",
      "message_agent",
      "spawn_dispatcher",
      "workflow",
    ]) {
      assert.ok(names.has(required), `missing deny candidate: ${required}`);
    }
    // The stock reply verb is deliberately NOT a deny candidate: a worker
    // answers its parent through `send_message` (the parent sees the notice).
    assert.equal(names.has("send_message"), false);
  });

  it("denies the three registered custom tools on the spawned worker filter", () => {
    const dispatcherTools = [
      DELIVER_RESULT_TOOL,
      MESSAGE_AGENT_TOOL,
      SPAWN_DISPATCHER_TOOL,
    ];
    // The declared surface, tool for tool (ticket 116 retired send_peer,
    // which stays a deny candidate above; the stock-subagent refactor left
    // exactly these three custom verbs).
    assert.deepEqual([...dispatcherTools], [...DISPATCHER_TOOL_NAMES]);
    const known = new Set([
      ...dispatcherTools,
      SEND_PEER_TOOL,
      "send_message",
      "subagent",
      "list_agents",
      "interrupt_agent",
      "bash",
    ]);
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
    // Stock spawn/control verbs stay closed; the stock reply verb is open.
    for (const name of ["subagent", "list_agents", "interrupt_agent"]) {
      assert.ok(
        filter.deny.includes(name),
        `worker can still resolve stock verb: ${name}`,
      );
    }
    assert.ok(!filter.deny.includes("send_message"));
    assert.ok(!filter.deny.includes("bash"));
  });

  it("allows stock send_message upward but no stock spawn or control verb", () => {
    const known = new Set([
      "send_message",
      "subagent",
      "subagent_fork",
      "list_subagent_models",
      "list_agents",
      "interrupt_agent",
      "read",
    ]);
    const deny = new Set(buildWorkerToolFilter(known).deny);
    assert.equal(
      deny.has("send_message"),
      false,
      "the worker reply lane was closed",
    );
    for (const blocked of [
      "subagent",
      "subagent_fork",
      "list_subagent_models",
      "list_agents",
      "interrupt_agent",
    ]) {
      assert.ok(
        deny.has(blocked),
        `worker isolation weakened: ${blocked} allowed`,
      );
    }
    assert.equal(deny.has("read"), false, "work tools survive");
  });

  // Ticket 182: the installed standard preset mounts `workflow`
  // (workflow-ptc); its script-level `agent()` can start descendants outside
  // this plugin's tracked worker-spawn path, so a worker's scope must deny it.
  // The dispatcher deliberately keeps it: the fix belongs in the worker deny
  // candidates only, never in the dispatcher's host-spawn withhold list.
  it("denies workflow on a worker scope but keeps it on dispatcher scope", () => {
    const known = new Set(["workflow", "bash"]);
    const workerDeny = new Set(buildWorkerToolFilter(known).deny);
    assert.ok(
      workerDeny.has("workflow"),
      "worker scope still exposes the workflow orchestration tool",
    );
    assert.ok(!workerDeny.has("bash"));

    // Dispatcher scope applies only `withheldHostSpawnTools`; `workflow` must
    // stay out of it, or the dispatcher loses a capability on purpose kept.
    assert.deepEqual(withheldHostSpawnTools(known), []);
    assert.ok(!HOST_SPAWN_TOOL_CANDIDATES.includes("workflow"));
  });

  // Ticket 179: the worker barrier keeps its OWN spawn candidate list —
  // `subagent` and `list_subagent_models` are allowed on the dispatcher
  // surface now, but a worker must never create an unaccounted child through
  // any of them.
  it("denies every host spawn verb candidate, subagent_fork included", () => {
    const candidates = new Set(WORKER_DENIED_TOOL_CANDIDATES);
    for (const name of HOST_SPAWN_TOOL_CANDIDATES) {
      assert.ok(candidates.has(name), `missing worker deny candidate: ${name}`);
    }
    const known = new Set(HOST_SPAWN_TOOL_CANDIDATES);
    const deny = new Set(buildWorkerToolFilter(known).deny);
    for (const name of HOST_SPAWN_TOOL_CANDIDATES) {
      assert.ok(deny.has(name), `worker filter leaks host spawn verb: ${name}`);
    }
  });

  // Ticket 119: the durable form of the rule above. Derived from the declared
  // surface rather than a hand-kept list, so a fourth custom dispatcher tool
  // cannot ship without a matching deny candidate — the failure mode is a
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
    assert.ok(prompt.includes("never message any other agent"));
    assert.ok(/spawn/i.test(prompt));
    assert.ok(prompt.includes("Never wait or poll"));
    assert.ok(prompt.includes("do not maintain a todo list"));
    assert.ok(prompt.includes("final answer"));
  });

  // Ticket 174 / ADR-0033 removed the worker access-ask feature in full. The
  // contract teaches only the interim `send_message` and the closing answer,
  // and `## Limits` states the surviving rule in our own words —
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

  it("Limits names only the final answer and the interim send_message", () => {
    const prompt = buildWorkerSystemPrompt();
    assert.ok(
      prompt.includes(
        "Your only channels back are the final answer you close with and the interim `send_message` described below.",
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
    // Ticket 170 (owner ruling 2026-11-04): one exit wins. The `blocked`
    // mid-task reply is preferred; the final answer is the fallback. Limits and
    // Reporting must not describe two competing exits.
    assert.ok(
      prompt.includes(
        "If the task needs access you do not have, say what was blocked and why instead of asking for it.",
      ),
      "a blocked worker reports, it does not ask",
    );
    assert.ok(
      prompt.includes(
        "A mid-task reply with status `blocked` is the preferred exit; the final answer carries it only if the reply channel is not usable or the task is ending anyway.",
      ),
      "Limits names the preferred exit, not two competing ones",
    );
  });

  // Stock-subagent refactor (lane A2b): the worker-local `reply_to_dispatcher`
  // tool is GONE, so the contract names the stock reply verb and the stock
  // completion notice instead. Both facts are pinned, because the whole worker
  // ->parent channel now rests on them.
  it("teaches stock send_message as the interim steer and the closing answer as the report", () => {
    const prompt = buildWorkerSystemPrompt();
    assert.ok(prompt.includes("## Mid-task reply"));
    assert.ok(prompt.includes("progress, blocked, or note"));
    assert.ok(
      prompt.includes("`send_message`"),
      "the interim steer must name the stock verb",
    );
    assert.ok(
      prompt.includes("completion notice"),
      "the contract must say where the dispatcher reads the worker's answer",
    );
    assert.ok(prompt.includes("last non-empty assistant answer"));
    assert.ok(
      !prompt.includes("reply_to_dispatcher"),
      "the removed worker-local tool must not be taught",
    );

    // The ZH face is where the old tool name survived last; it must teach the
    // stock verb and drop the removed one too.
    const zh = buildWorkerSystemPrompt("zh");
    assert.ok(zh.includes("`send_message`"));
    assert.ok(!zh.includes("reply_to_dispatcher"));
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

// ── second-round audit: optional verbs + fail-closed composition ──────────

describe("worker tool barrier — audit hardening (second-round)", () => {
  const OPTIONAL_AGENT_VERBS = [
    "spawn_teammate",
    "team_task_create",
    "team_task_get",
    "team_task_list",
    "team_task_update",
    "wait_agent",
    "list_agents",
    "request_access",
  ] as const;

  it("denies the optional agent/user-reach verbs when the host ships them", () => {
    const known = new Set<string>([...OPTIONAL_AGENT_VERBS, "read"]);
    const deny = new Set(buildWorkerToolFilter(known).deny);
    for (const name of OPTIONAL_AGENT_VERBS) {
      assert.ok(deny.has(name), `worker filter leaks optional verb: ${name}`);
      assert.ok(
        WORKER_DENIED_TOOL_CANDIDATES.includes(name),
        `missing deny candidate: ${name}`,
      );
    }
    assert.ok(!deny.has("read"), "work tools survive");
  });

  /** A context whose scoped read/restrict behavior each test controls. */
  function compositionCtx(options: {
    schemas?: () => ReadonlyArray<{ readonly name: string }>;
    restrict?: (filter: { readonly deny: readonly string[] }) => () => void;
    noTools?: boolean;
  }): WorkerCompositionContext {
    return {
      systemPrompt: {
        section() {
          return () => {};
        },
        getSectionOrder() {
          return 0;
        },
      },
      ...(options.noTools === true
        ? {}
        : {
            tools: {
              schemas: options.schemas ?? (() => [{ name: "deliver_result" }, { name: "read" }]),
              restrict: options.restrict ?? (() => () => {}),
            },
          }),
    } as WorkerCompositionContext;
  }

  it("throws when schemas() throws — never composes an unrestricted worker", () => {
    const ctx = compositionCtx({
      schemas: () => {
        throw new Error("surface unavailable");
      },
    });
    assert.throws(
      () => applyWorkerComposition(ctx, createWorkerAgentDef(), {}),
      /schemas\(\) failed/u,
    );
  });

  it("throws when schemas() returns empty on a context that can restrict", () => {
    const ctx = compositionCtx({ schemas: () => [] });
    assert.throws(
      () => applyWorkerComposition(ctx, createWorkerAgentDef(), {}),
      /scoped tool set is empty/u,
    );
  });

  it("throws when the deny list would deny nothing (barrier not applied)", () => {
    const ctx = compositionCtx({
      schemas: () => [{ name: "read" }, { name: "bash" }],
    });
    assert.throws(
      () => applyWorkerComposition(ctx, createWorkerAgentDef(), {}),
      /no denied verb/u,
    );
  });

  it("throws when restrict() is unavailable on a surface with denied verbs", () => {
    const ctx: WorkerCompositionContext = {
      tools: {
        schemas: () => [{ name: "deliver_result" }],
      } as never,
    };
    assert.throws(
      () => applyWorkerComposition(ctx, createWorkerAgentDef(), {}),
      /restrict\(\) is unavailable/u,
    );
  });

  it("throws when the context exposes no scoped tools surface", () => {
    const ctx = compositionCtx({ noTools: true });
    assert.throws(
      () => applyWorkerComposition(ctx, createWorkerAgentDef(), {}),
      /no scoped tools surface/u,
    );
  });

  it("keeps the minimal-stub contract when the context cannot restrict at all", () => {
    // A stub with no `restrict` seam has nothing to enforce; the live host
    // always has one. This is the documented carve-out, not a silent pass on
    // a host that COULD restrict.
    const ctx: WorkerCompositionContext = {
      tools: {
        schemas: () => [],
      } as never,
    };
    assert.doesNotThrow(() => applyWorkerComposition(ctx, createWorkerAgentDef(), {}));
  });

  it("applies the extended deny list on a real scoped surface", () => {
    const restrictions: Array<{ readonly deny: readonly string[] }> = [];
    const ctx = compositionCtx({
      schemas: () => [...OPTIONAL_AGENT_VERBS, "deliver_result", "send_message", "read"].map((name) => ({ name })),
      restrict: (filter) => {
        restrictions.push(filter);
        return () => {};
      },
    });
    const applied = applyWorkerComposition(ctx, createWorkerAgentDef(), {});
    assert.equal(applied, 2, "contract section + tool restriction");
    assert.equal(restrictions.length, 1);
    const deny = new Set(restrictions[0]?.deny ?? []);
    for (const name of [...OPTIONAL_AGENT_VERBS, "deliver_result"]) {
      assert.ok(deny.has(name), `missing from the applied deny list: ${name}`);
    }
    assert.ok(!deny.has("send_message"), "the stock reply lane stays open");
    assert.ok(!deny.has("read"));
  });
});
