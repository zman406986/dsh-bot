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
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyWorkerComposition,
  globalToolNames,
  WORKER_PERSONA_SECTION,
  WORKER_PERSONA_SECTION_ORDER,
  type WorkerCompositionContext,
} from "../src/worker/preset.js";
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
  const agentPlane = (
    options?.agentPlane ?? [
      "present",
      "send_message",
      "todo_write",
      "spawn_worker",
      "check_workers",
      "steer_worker",
      "stop_worker",
      "deliver_result",
      "message_agent",
      "await_agent",
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
    assert.ok(names.has("spawn_worker"), "the agent-plane tool is visible");
    assert.ok(names.has("request_access"), "the context-global tool is visible too");
    assert.equal(names.size, 14);
  });

  it("reads the context-global layer alone without a scope", () => {
    const { ctx } = createScopedStub();
    const names = globalToolNames(ctx);
    assert.deepEqual([...names].sort(), ["request_access", "working_directory"]);
  });

  it("returns an empty set when the registry read throws", () => {
    const ctx: WorkerCompositionContext = {
      tools: {
        schemas() {
          throw new Error("registry unavailable");
        },
        restrict() {
          return () => {};
        },
      },
    };
    assert.deepEqual([...globalToolNames(ctx)], []);
  });

  it("returns an empty set when the context exposes no tools surface", () => {
    assert.deepEqual([...globalToolNames({})], []);
  });
});

describe("applyWorkerComposition", () => {
  it("registers the contract as a literal scoped persona section", () => {
    const { ctx, agent, sections } = createScopedStub();
    const def = createWorkerAgentDef();
    applyWorkerComposition(ctx, def, agent);

    assert.equal(sections.length, 1);
    const section = sections[0]!;
    assert.equal(section.name, WORKER_PERSONA_SECTION);
    assert.equal(section.order, 1234);
    assert.equal(section.text, def.persona);
    // Literal prose: interpolation would eat any `{{` in the contract.
    assert.equal(section.interpolate, false);
  });

  it("denies the dispatcher surface intersected with the CHILD's live tools", () => {
    const { ctx, agent, restrictions, scopeReads } = createScopedStub();
    applyWorkerComposition(ctx, createWorkerAgentDef(), agent);

    assert.deepEqual(scopeReads, [agent], "the scope read must be the child agent");
    assert.equal(restrictions.length, 1);
    assert.deepEqual(restrictions[0]?.deny, [
      "present",
      "send_message",
      "todo_write",
      "spawn_worker",
      "check_workers",
      "steer_worker",
      "stop_worker",
      "deliver_result",
      "message_agent",
      "await_agent",
      "spawn_dispatcher",
    ]);
    // Work tools survive.
    assert.ok(!restrictions[0]?.deny?.includes("read"));
  });

  it("omits names the host does not know (restrict throws on unknown names)", () => {
    const { ctx, agent, restrictions } = createScopedStub({
      agentPlane: ["spawn_worker", "read"],
    });
    applyWorkerComposition(ctx, createWorkerAgentDef(), agent);

    assert.deepEqual(restrictions, [{ deny: ["spawn_worker"] }]);
  });

  it("skips the restriction entirely when no candidate is live", () => {
    const { ctx, agent, restrictions } = createScopedStub({
      contextGlobal: ["request_access"],
      agentPlane: ["read", "edit"],
    });
    const applied = applyWorkerComposition(ctx, createWorkerAgentDef(), agent);

    // `tools.restrict({ deny: [] })` throws on the host, so an empty
    // intersection must not reach it.
    assert.deepEqual(restrictions, []);
    assert.equal(applied, 1, "only the persona section registered");
  });

  it("reports how many surfaces it registered and tolerates a bare context", () => {
    const full = createScopedStub();
    assert.equal(applyWorkerComposition(full.ctx, createWorkerAgentDef(), full.agent), 2);

    const promptOnly = createScopedStub({ noTools: true });
    assert.equal(applyWorkerComposition(promptOnly.ctx, createWorkerAgentDef(), promptOnly.agent), 1);

    const toolsOnly = createScopedStub({ noPrompt: true });
    assert.equal(applyWorkerComposition(toolsOnly.ctx, createWorkerAgentDef(), toolsOnly.agent), 1);

    // A stub host exposing neither surface registers nothing — absence is
    // never reported as success.
    assert.equal(applyWorkerComposition({}, createWorkerAgentDef(), undefined), 0);
  });
});
