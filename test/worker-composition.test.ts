/**
 * Route-independent worker composition (0.2.1 port).
 *
 * 0.2.1 removed per-spawn `persona`/`toolFilter` and our two boot routes do
 * not share a preset registry, so the contract and the tool barrier are
 * registered on the CHILD's own scoped context at `agent/created`. These tests
 * pin the two facts that make that composition real:
 *
 * 1. the tool names are read from the CHILD'S scope — an unscoped
 *    `tools.schemas()` answers for the context-global layer only (two
 *    bookkeeping tools on the live host), so an unscoped read yields an empty
 *    deny list and the barrier silently does nothing;
 * 2. the contract registers as a literal (non-interpolated) scoped section
 *    that shadows the deployment persona for that child alone.
 *
 * Barrier split after the stock-subagent refactor: a worker REPLIES to its
 * parent through the stock `send_message`, so that one stock verb is NOT
 * denied; stock spawning (`subagent`/`subagent_fork`) and stock control
 * (`list_agents`/`interrupt_agent`) still are, as are our three kept custom
 * tools and the user/todo/job lanes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {applyWorkerComposition, globalToolNames, WORKER_PERSONA_SECTION_ORDER, type WorkerCompositionContext} from "../src/worker/preset.js";
import { createWorkerAgentDef } from "../src/worker/agent-def.js";

interface RecordedSection {
  name: string;
  order: number;
  text: string;
  interpolate?: boolean;
}

function createScopedStub(options?: {
  contextGlobal?: string[];
  agentPlane?: string[];
  noPrompt?: boolean;
  noTools?: boolean;
}) {
  const sections: RecordedSection[] = [];
  const restrictions: Array<{ allow?: readonly string[]; deny?: readonly string[] }> = [];
  const scopeReads: unknown[] = [];
  const agent = { session: { id: "child-1" } };
  const contextGlobal = (options?.contextGlobal ?? ["request_access", "working_directory"]).map(
    (name) => ({ name }),
  );
  // The live child scope: stock agent verbs, our three kept custom tools, and
  // one work tool. `send_message` is the allowed worker->parent reply lane.
  const agentPlane = (
    options?.agentPlane ?? [
      "present",
      "send_message",
      "todo_write",
      "list_agents",
      "interrupt_agent",
      "subagent",
      "subagent_fork",
      "list_subagent_models",
      "deliver_result",
      "message_agent",
      "spawn_dispatcher",
      "read",
    ]
  ).map((name) => ({ name }));

  const ctx: WorkerCompositionContext = {
    ...(options?.noPrompt === true
      ? {}
      : {
          systemPrompt: {
            section(section: RecordedSection) {
              sections.push(section);
              return () => {};
            },
            getSectionOrder(name: string) {
              assert.equal(name, WORKER_PERSONA_SECTION_ORDER);
              return 1234;
            },
          },
        }),
    ...(options?.noTools === true
      ? {}
      : {
          tools: {
            schemas(scope?: unknown) {
              scopeReads.push(scope);
              // The live contract: no scope = context-global layer only.
              return scope === undefined ? contextGlobal : [...contextGlobal, ...agentPlane];
            },
            restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }) {
              restrictions.push(filter);
              return () => {};
            },
          },
        }),
  };

  return { ctx, agent, sections, restrictions, scopeReads };
}

describe("globalToolNames", () => {
  it("reads the CHILD's surface when a scope is passed", () => {
    const { ctx, agent } = createScopedStub();
    const names = globalToolNames(ctx, agent);
    assert.ok(names.has("send_message"), "the stock reply verb is visible");
    assert.ok(names.has("request_access"), "the context-global tool is visible too");
    assert.equal(names.size, 14);
  });

  it("returns an empty set when the context exposes no tools surface", () => {
    assert.deepEqual([...globalToolNames({})], []);
  });
});

describe("applyWorkerComposition", () => {
  it("denies the dispatcher surface intersected with the CHILD's live tools", () => {
    const { ctx, agent, restrictions, scopeReads } = createScopedStub();
    applyWorkerComposition(ctx, createWorkerAgentDef(), agent);

    assert.deepEqual(scopeReads, [agent], "the scope read must be the child agent");
    assert.equal(restrictions.length, 1);
    assert.deepEqual(restrictions[0]?.deny, [
      "present",
      // Stock control verbs stay denied.
      "interrupt_agent",
      "list_agents",
      // Our three kept custom tools stay denied.
      "message_agent",
      "deliver_result",
      "spawn_dispatcher",
      // Stock spawn verbs stay denied.
      "subagent",
      "subagent_fork",
      "list_subagent_models",
      "todo_write",
      // Second-round audit: the optional host user-reach verb is denied too.
      "request_access",
    ]);
    // The stock worker->parent reply is the ONE allowed agent verb.
    assert.ok(!restrictions[0]?.deny?.includes("send_message"));
    // Work tools survive.
    assert.ok(!restrictions[0]?.deny?.includes("read"));
    assert.ok(!restrictions[0]?.deny?.includes("working_directory"));
  });

  it("omits names the host does not know (restrict throws on unknown names)", () => {
    const { ctx, agent, restrictions } = createScopedStub({
      agentPlane: ["message_agent", "read"],
    });
    applyWorkerComposition(ctx, createWorkerAgentDef(), agent);

    // `request_access` is a context-global name in this fixture, so the
    // candidate intersection picks it up as well (second-round audit).
    assert.deepEqual(restrictions, [
      { deny: ["message_agent", "request_access"] },
    ]);
  });

  it("allows stock send_message while denying stock spawn and control verbs", () => {
    const { ctx, agent, restrictions } = createScopedStub({
      agentPlane: [
        "send_message",
        "subagent",
        "subagent_fork",
        "list_subagent_models",
        "list_agents",
        "interrupt_agent",
        "read",
      ],
    });
    applyWorkerComposition(ctx, createWorkerAgentDef(), agent);
    const deny = new Set(restrictions[0]?.deny ?? []);
    assert.equal(deny.has("send_message"), false, "the worker reply lane was closed");
    for (const blocked of [
      "subagent",
      "subagent_fork",
      "list_subagent_models",
      "list_agents",
      "interrupt_agent",
    ]) {
      assert.ok(deny.has(blocked), `worker isolation weakened: ${blocked} allowed`);
    }
  });

  // Lane A2b surface check: the barrier is only half the story — the stock
  // reply verb must actually SURVIVE composition (the plugin no longer
  // registers a reply tool of its own), and no dispatcher/spawn verb may.
  it("leaves stock send_message visible and removes every dispatcher/spawn verb", () => {
    const { ctx, agent, restrictions } = createScopedStub();
    applyWorkerComposition(ctx, createWorkerAgentDef(), agent);
    const deny = new Set(restrictions[0]?.deny ?? []);
    const visible = [...globalToolNames(ctx, agent)].filter(
      (name) => !deny.has(name),
    );
    assert.ok(
      visible.includes("send_message"),
      "the stock reply lane was filtered out of the worker surface",
    );
    for (const blocked of [
      "present",
      "interrupt_agent",
      "list_agents",
      "subagent",
      "subagent_fork",
      "list_subagent_models",
      "message_agent",
      "deliver_result",
      "spawn_dispatcher",
      "todo_write",
    ]) {
      assert.ok(
        !visible.includes(blocked),
        `worker surface still exposes ${blocked}`,
      );
    }
    assert.ok(visible.includes("read"), "work tools survive");
  });

  it("registers a contract that teaches send_message, never the removed tool", () => {
    const { ctx, agent, sections } = createScopedStub();
    applyWorkerComposition(ctx, createWorkerAgentDef(), agent);
    const persona = sections[0]?.text ?? "";
    assert.ok(persona.includes("`send_message`"));
    assert.ok(!persona.includes("reply_to_dispatcher"));
  });

});
