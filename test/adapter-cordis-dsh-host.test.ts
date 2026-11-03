import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {createCordisDshHost, mapStopReason, SPAWN_PROVIDER, type ActivationLike, type ActivationSpecLike, type AdapterContext, type AgentLike} from "../src/adapter/cordis-dsh-host.js";
import { bindDispatcherLifecycle, isTopLevel } from "../src/adapter/parent-agent.js";
import { createMultitask } from "../src/core/multitask.js";
import {
  deriveWorkerLiveness,
  WORKER_STALL_THRESHOLD_MS,
} from "../src/core/liveness.js";
import { CHECK_ACTIVITY_CHARS, RECENT_RESULT_EXCERPT_CHARS } from "../src/core/report-clamp.js";
import type { SettledEvent } from "../src/core/types.js";
import { createWorkerAgentDef } from "../src/worker/agent-def.js";
import { WORKER_PERSONA_SECTION } from "../src/worker/preset.js";
import { EMPTY_WORKER_REPORT_PLACEHOLDER } from "../src/worker/report.js";

interface RecordedCall {
  [key: string]: unknown;
}

function createAgent(id: string, topLevel = true): AgentLike {
  return {
    session: {
      id,
      header: topLevel
        ? { parentSession: undefined, delegationDepth: 0 }
        : { parentSession: "parent-x", delegationDepth: 1 },
    },
    followup() {},
  };
}

function createStubCtx() {
  const startActivationCalls: RecordedCall[] = [];
  const disposedWorkerIds: string[] = [];
  const interruptCalls: RecordedCall[] = [];
  const sendMessageCalls: RecordedCall[] = [];
  const followupCalls: unknown[] = [];
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const jobListCalls: unknown[] = [];
  const composedChildren: Array<{
    childId: string;
    sections: string[];
    restrictions: Array<{ deny?: readonly string[]; allow?: readonly string[] }>;
    schemasScopes: unknown[];
  }> = [];
  let nextChild = 1;

  // 0.2.1 host shape: `tools.schemas()` with no scope reports the
  // context-global layer ONLY; the surface an agent inherits (its preset's
  // model-facing tools) is read by passing that agent as the scope. The
  // barrier's deny intersection must use the scoped read, so the fake keeps
  // the two views distinct the same way.
  const contextGlobalTools = [{ name: "request_access" }, { name: "working_directory" }];
  const agentPlaneTools = [
    { name: "present" },
    { name: "send_message" },
    { name: "todo_write" },
    { name: "spawn_worker" },
    { name: "check_workers" },
    { name: "steer_worker" },
    { name: "stop_worker" },
    { name: "deliver_result" },
    { name: "message_agent" },
    { name: "await_agent" },
    { name: "spawn_dispatcher" },
    { name: "read" },
  ];

  const agents = new Map<string, AgentLike>();

  /**
   * Ticket 120: runs INSIDE `startActivation`, after `agent/created` and
   * before the call resolves — exactly where the real host lets the child
   * emit its first `agent/status: running`. The race test drives the status
   * edge from here, which is what makes it deterministic rather than timing
   * dependent.
   */
  const activationSeams = {
    duringActivation: null as null | ((childId: string) => void | Promise<void>),
  };

  const ctx: AdapterContext & {
    fire(name: string, ...payloads: unknown[]): void;
    startActivationCalls: RecordedCall[];
    disposedWorkerIds: string[];
    interruptCalls: RecordedCall[];
    sendMessageCalls: RecordedCall[];
    followupCalls: unknown[];
    jobListCalls: unknown[];
    activationSeams: typeof activationSeams;
    composedChildren: Array<{
      childId: string;
      sections: string[];
      restrictions: Array<{ deny?: readonly string[]; allow?: readonly string[] }>;
      schemasScopes: unknown[];
    }>;
    bindAgent(agent: AgentLike): void;
  } = {
    startActivationCalls,
    disposedWorkerIds,
    interruptCalls,
    sendMessageCalls,
    followupCalls,
    jobListCalls,
    activationSeams,
    composedChildren,
    fire(name: string, ...payloads: unknown[]) {
      for (const cb of listeners.get(name) ?? []) {
        (cb as (...args: unknown[]) => void)(...payloads);
      }
    },
    bindAgent(agent: AgentLike) {
      agents.set(String(agent.session.id), agent);
    },
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((c) => c !== cb),
        );
      };
    },
    subagents: {
      async startActivation(spec: ActivationSpecLike): Promise<ActivationLike> {
        startActivationCalls.push(spec as unknown as RecordedCall);
        // Ticket 120: a reserved child id is honoured exactly like the real
        // host's local backend (it either uses the id or refuses the spawn).
        const childId =
          spec.childId !== undefined ? String(spec.childId) : `child-${nextChild++}`;
        // The host creates the child inside this call and announces it on
        // `agent/created` before its first turn; the adapter's composition
        // must land there.
        const composed = {
          childId,
          sections: [] as string[],
          restrictions: [] as Array<{
            deny?: readonly string[];
            allow?: readonly string[];
          }>,
          schemasScopes: [] as unknown[],
        };
        composedChildren.push(composed);
        const childCtx = {
          systemPrompt: {
            section(section: { name: string }) {
              composed.sections.push(section.name);
              return () => {};
            },
            getSectionOrder() {
              return 0;
            },
          },
          tools: {
            schemas(scope?: unknown) {
              if (scope === undefined) return contextGlobalTools;
              composed.schemasScopes.push(scope);
              return [...contextGlobalTools, ...agentPlaneTools];
            },
            restrict(filter: {
              deny?: readonly string[];
              allow?: readonly string[];
            }) {
              composed.restrictions.push(filter);
              return () => {};
            },
          },
        };
        ctx.fire("agent/created", {
          agent: {
            session: {
              id: childId,
              header: {
                parentSession: String(spec.request.parent.session.id),
                delegationDepth: 1,
              },
            },
            ctx: childCtx,
          },
          source: "startup",
        });
        // Ticket 120: the real host lets the child run here — its first
        // `agent/status: running` lands BEFORE this promise resolves.
        await activationSeams.duringActivation?.(childId);
        return {
          childId,
          messageId: `msg-${childId}`,
          dispose: async () => {
            disposedWorkerIds.push(childId);
          },
        };
      },
      interrupt(targetSessionId: unknown, authority: unknown) {
        interruptCalls.push({ targetSessionId, authority });
      },
      async sendMessage(
        sender: AgentLike,
        targetId: unknown,
        content: unknown,
        options: { signal: AbortSignal },
      ) {
        sendMessageCalls.push({ sender, targetId, content, options });
        return `mid-${sendMessageCalls.length}`;
      },
    },
    agents: {
      get(id: unknown) {
        const agent = agents.get(String(id));
        if (agent === undefined) return undefined;
        return {
          ...agent,
          followup(message: unknown) {
            followupCalls.push(message);
            agent.followup(message);
          },
        };
      },
    },
    jobs: {
      list(callerSessionId?: unknown) {
        jobListCalls.push(callerSessionId);
        return [];
      },
    },
    storageDomain: {
      async open() {
        const table = new Map<string, unknown>();
        return {
          table() {
            return {
              get: (k: string) => table.get(k),
              entries: () => table.entries() as never,
              put: async (k: string, v: unknown) => {
                table.set(k, v);
              },
              delete: async (k: string) => table.delete(k),
            };
          },
          close: async () => {},
        };
      },
    },
  };

  return ctx;
}

describe("stop reason and report mapping", () => {
  it("maps completed/aborted/error and max-tokens/refusal → error", () => {
    assert.equal(mapStopReason("completed"), "completed");
    assert.equal(mapStopReason("aborted"), "aborted");
    assert.equal(mapStopReason("error"), "error");
    assert.equal(mapStopReason("max-tokens"), "error");
    assert.equal(mapStopReason("refusal"), "error");
    assert.equal(mapStopReason("unknown-future"), "error");
  });

});

/**
 * The host's acceptance rule, replicated offline from the installed
 * dsh-subagent lib (READ-ONLY reference): `resolveChildDepth`
 * (dsh-subagent/lib/index.js:432-437) computes `childDepth =
 * delegationDepthOf(parent) + 1` and throws `SubagentDepthError`
 * (:412-420) when `childDepth > request.maxDepth`; `delegationDepthOf`
 * (:144-147) floors the parent's depth at the persisted session header.
 * Keep in sync with the lib; this is the spec our request slot must satisfy.
 */
function hostResolveChildDepth(
  parentDelegationDepth: number,
  requestMaxDepth: number,
): number {
  const childDepth = parentDelegationDepth + 1;
  if (childDepth > requestMaxDepth) {
    throw new Error(
      `subagent depth ${childDepth} exceeds maxDepth ${requestMaxDepth}`,
    );
  }
  return childDepth;
}

describe("ticket 83 regression: spawn maxDepth is the child's ABSOLUTE ceiling", () => {
  it("accepts a depth-1 child of a depth-0 dispatcher (the exact live 2026-09-19 failure shape)", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx, { workerAgentDef: createWorkerAgentDef() });
    // createAgent(...) binds a top-level parent: header delegationDepth 0,
    // exactly what activation isTopLevel-gates to.
    host.bindParent(createAgent("disp-1"), "disp-1");

    await host.spawnWorker("ok?", { parentSessionId: "disp-1", streamKey: "s", title: "t" });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    assert.equal(spec.request.maxDepth, 1);
    // The host must ACCEPT the child (before the fix this threw
    // "subagent depth 1 exceeds maxDepth 0" live).
    assert.equal(hostResolveChildDepth(0, spec.request.maxDepth as number), 1);
  });

  it("refuses a hypothetical depth-2 grandchild through the same ceiling (worker stays a leaf at the host layer)", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx, { workerAgentDef: createWorkerAgentDef() });
    host.bindParent(createAgent("disp-1"), "disp-1");

    await host.spawnWorker("ok?", { parentSessionId: "disp-1", streamKey: "s", title: "t" });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    const ceiling = spec.request.maxDepth as number;
    assert.throws(
      () => hostResolveChildDepth(ceiling, ceiling),
      /exceeds maxDepth 1/,
    );
  });

  it("derives the ceiling from the parent's real seam depth, not a hardcoded 1", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx, { workerAgentDef: createWorkerAgentDef() });
    const deeperParent: AgentLike = {
      session: {
        id: "disp-deep",
        header: { parentSession: "up", delegationDepth: 2 },
      },
      followup() {},
    };
    host.bindParent(deeperParent, "disp-deep");

    await host.spawnWorker("x", { parentSessionId: "disp-deep", streamKey: "s", title: "t" });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    // 2 (parent) + 1 (hop) + 0 (leaf budget) — a depth-3 child is accepted.
    assert.equal(spec.request.maxDepth, 3);
    assert.equal(hostResolveChildDepth(2, spec.request.maxDepth as number), 3);
  });

  it("falls back to the top-level assumption when the header is unreadable (isTopLevel fails open)", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx, { workerAgentDef: createWorkerAgentDef() });
    const opaqueParent: AgentLike = {
      session: { id: "disp-opaque" },
      followup() {},
    };
    host.bindParent(opaqueParent, "disp-opaque");

    await host.spawnWorker("x", { parentSessionId: "disp-opaque", streamKey: "s", title: "t" });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    assert.equal(spec.request.maxDepth, 1);
    assert.equal(hostResolveChildDepth(0, spec.request.maxDepth as number), 1);
  });
});

describe("CordisDshHost spawn / interrupt / send", () => {
  it("spawn calls startActivation with provider spawn, parent delivery, and returns workerId string", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const parent = createAgent("disp-1");
    host.bindParent(parent, "disp-1");

    const workerId = await host.spawnWorker("Do the thing.", {
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "Thing",
    });

    // Ticket 120: the id is RESERVED before the spawn and passed as
    // `spec.childId`, so the worker id is the reserved id — no longer a
    // host-minted `child-N` this adapter only learns after the await.
    assert.equal(typeof workerId, "string");
    assert.notEqual(workerId, "");
    assert.equal(host.owns(workerId), true);
    assert.equal(host.workerIdOf(workerId), workerId);
    assert.equal(ctx.startActivationCalls.length, 1);
    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    assert.equal(spec.provider, SPAWN_PROVIDER);
    // The reservation IS the spec id — that is what makes the child
    // recognisable while it is still emitting events.
    assert.equal(String(spec.childId), workerId);
    assert.equal(spec.label, "Thing");
    // 0.2.1: the completion notice reaches the model through `parent`.
    assert.equal(spec.delivery, "parent");
    assert.equal(spec.request.prompt.length, 1);
    assert.equal(spec.request.prompt[0]?.type, "text");
    assert.equal((spec.request.prompt[0] as { text: string }).text, "Do the thing.");
    // The signal is pre-publication only and lives on the spec, never in request.
    assert.ok(spec.signal instanceof AbortSignal);
    assert.equal("signal" in spec.request, false);
    // 0.2.1 removed per-spawn persona/toolFilter; with no worker def no preset
    // is selected either.
    assert.equal("persona" in spec.request, false);
    assert.equal("toolFilter" in spec.request, false);
    assert.equal("agentPreset" in spec.request, false);
    // Ticket 83: the slot is the CHILD'S ABSOLUTE depth ceiling — for a
    // depth-0 dispatcher parent, 1 (the host computes childDepth = 0 + 1 and
    // needs childDepth <= maxDepth). Sending the leaf budget 0 refused every
    // live spawn.
    assert.equal(spec.request.maxDepth, 1);
  });

  it("spawn with WorkerAgentDef composes the child at agent/created; the contract never rides the task prompt", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx, { workerAgentDef: createWorkerAgentDef() });
    const parent = createAgent("disp-1");
    host.bindParent(parent, "disp-1");

    const workerId = await host.spawnWorker("Do the thing.", {
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "Thing",
    });

    assert.equal(typeof workerId, "string");
    assert.notEqual(workerId, "");
    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;

    // 0.2.1: persona and toolFilter are not request fields at all, and no
    // named preset is selected — composition is per child.
    assert.equal("persona" in spec.request, false);
    assert.equal("toolFilter" in spec.request, false);
    assert.equal("agentPreset" in spec.request, false);

    // The task is the child's first user turn, ALONE. Putting the contract
    // back into this channel is the regression this pins.
    assert.equal(spec.request.prompt.length, 1);
    const brief = (spec.request.prompt[0] as { text: string }).text;
    assert.equal(brief, "Do the thing.");
    assert.ok(!brief.includes("## Role"));
    assert.ok(!brief.includes("Task:\n"));

    // Ticket 83: depth-0 parent → absolute ceiling 1 (child of a depth-0
    // session is depth 1; `maxDepth: 0` was the live-refused leaf budget).
    assert.equal(spec.request.maxDepth, 1);

    // The contract and barrier landed on the CHILD's own scope at
    // `agent/created`, before its first turn.
    const composed = ctx.composedChildren[0];
    assert.ok(composed);
    assert.deepEqual(composed.sections, [WORKER_PERSONA_SECTION]);
    // The deny intersection reads the CHILD'S surface (`schemas(child)`), not
    // the context-global layer: on 0.2.1 an unscoped read sees only the
    // bookkeeping tools, which silently denied nothing at all.
    assert.equal(composed.schemasScopes.length, 1);
    assert.equal(
      (composed.schemasScopes[0] as { session: { id: string } }).session.id,
      workerId,
    );
    assert.deepEqual(composed.restrictions, [
      {
        deny: [
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
        ],
      },
    ]);
  });

  it("spawn owns the activation and disposes it on host dispose", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");

    await host.spawnWorker("x", {
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "t",
    });
    assert.deepEqual(ctx.disposedWorkerIds, []);
    host.dispose();
    // The reserved id is the activation this host owns and disposes.
    assert.equal(ctx.disposedWorkerIds.length, 1);
  });

  it("spawn rejects when no parent is bound", async () => {
    // Fail-closed: a host with no bound parent must refuse, never guess one.
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    await assert.rejects(
      () => host.spawnWorker("x", { parentSessionId: "p", streamKey: "s", title: "t" }),
      /no parent agent bound/,
    );
  });

  it("interrupt uses ancestor authority with the parent agent", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const parent = createAgent("disp-1");
    host.bindParent(parent, "disp-1");
    const workerId = await host.spawnWorker("x", {
      parentSessionId: "disp-1",
      streamKey: "s",
      title: "t",
    });
    await host.interruptWorker(workerId);
    assert.equal(ctx.interruptCalls.length, 1);
    const call = ctx.interruptCalls[0] as {
      targetSessionId: string;
      authority: { kind: string; agent: AgentLike };
    };
    assert.equal(call.targetSessionId, workerId);
    assert.equal(call.authority.kind, "ancestor");
    assert.equal(call.authority.agent, parent);
  });

  it("sendMessage delivers one text block to the same worker", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const parent = createAgent("disp-1");
    host.bindParent(parent, "disp-1");
    const workerId = await host.spawnWorker("x", {
      parentSessionId: "disp-1",
      streamKey: "s",
      title: "t",
    });
    await host.sendMessage(workerId, "steer this");
    assert.equal(ctx.sendMessageCalls.length, 1);
    const call = ctx.sendMessageCalls[0] as {
      targetId: string;
      content: Array<{ type: string; text: string }>;
    };
    assert.equal(call.targetId, workerId);
    assert.equal(call.content.length, 1);
    assert.equal(call.content[0]?.text, "steer this");
  });
});

describe("CordisDshHost settle and step boundary", () => {
  async function spawnOne() {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const parent = createAgent("disp-1");
    host.bindParent(parent, "disp-1");
    const workerId = await host.spawnWorker("x", {
      parentSessionId: "disp-1",
      streamKey: "s",
      title: "t",
    });
    return { ctx, host, parent, workerId };
  }

  it("subagent/end completed → SettledEvent completed with joined report", async () => {
    const { ctx, host, workerId } = await spawnOne();
    const events: SettledEvent[] = [];
    host.onWorkerSettled((e) => events.push(e));

    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "All done." }],
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.workerId, workerId);
    assert.equal(events[0]?.status, "completed");
    assert.equal(events[0]?.report, "All done.");
    assert.equal(events[0]?.transcriptRef, workerId);
  });

  it("empty completed settle uses the placeholder; error keeps message; abort invents nothing", async () => {
    const { ctx, host, workerId } = await spawnOne();
    const events: SettledEvent[] = [];
    host.onWorkerSettled((e) => events.push(e));

    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [],
    });
    assert.equal(events[0]?.report, EMPTY_WORKER_REPORT_PLACEHOLDER);

    // Core drops late settles after abort; adapter still must not invent a report.
    const abortHost = createCordisDshHost(ctx);
    abortHost.bindParent(createAgent("disp-2"), "disp-2");
    const abortWorkerId = await abortHost.spawnWorker("x", {
      parentSessionId: "disp-2",
      streamKey: "s2",
      title: "t2",
    });
    const abortEvents: SettledEvent[] = [];
    abortHost.onWorkerSettled((e) => abortEvents.push(e));
    ctx.fire("subagent/end", {
      id: abortWorkerId,
      stopReason: "aborted",
      lastAssistantMessage: undefined,
    });
    assert.equal(abortEvents[0]?.report, "");
  });

});

describe("CordisDshHost recentResult — deliverables excerpt source (ticket 41)", () => {
  async function settleOne() {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");
    const workerId = await host.spawnWorker("x", {
      parentSessionId: "disp-1",
      streamKey: "s",
      title: "t",
    });
    return { ctx, host, workerId };
  }

  it("a completed settle leaves a bounded excerpt visible before core observers run", async () => {
    const { ctx, host, workerId } = await settleOne();
    let excerptDuringSettle: unknown = "not-read";
    host.onWorkerSettled(() => {
      // The projection reads the seat from inside the settle-triggered
      // roster publish — it must already see the text here.
      excerptDuringSettle = host.recentResult(workerId);
    });
    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "All done." }],
    });
    assert.equal(
      (excerptDuringSettle as { text: string } | null)?.text,
      "All done.",
      "the settle-time publish already sees the excerpt",
    );
    assert.equal(
      typeof (excerptDuringSettle as { settledAtMs: number } | null)?.settledAtMs,
      "number",
    );
    assert.equal(host.recentResult(workerId)?.text, "All done.");
  });

  it("clamps an over-long report to the excerpt bound; empty abort leaves null", async () => {
    const { ctx, host, workerId } = await settleOne();
    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [
        { type: "text", text: "y".repeat(RECENT_RESULT_EXCERPT_CHARS + 1_000) },
      ],
    });
    const clamped = host.recentResult(workerId);
    assert.equal(clamped?.text.length, RECENT_RESULT_EXCERPT_CHARS);
    assert.ok(clamped?.text.endsWith("…"));

    // An aborted worker with no text invents nothing.
    const abortWorkerId = await host.spawnWorker("x", {
      parentSessionId: "disp-1",
      streamKey: "s2",
      title: "t2",
    });
    ctx.fire("subagent/end", {
      id: abortWorkerId,
      stopReason: "aborted",
      lastAssistantMessage: undefined,
    });
    assert.equal(host.recentResult(abortWorkerId), null);
    assert.equal(host.recentResult("never-settled"), null);
  });

});

describe("dispatcher wake", () => {
  it("followup is called on the dispatcher agent", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const parent = createAgent("disp-1");
    ctx.bindAgent(parent);
    host.bindParent(parent, "disp-1");

    await host.requestDispatcherWakeup("disp-1");
    assert.equal(ctx.followupCalls.length, 1);
    const msg = ctx.followupCalls[0] as { role: string; content: Array<{ text: string }> };
    assert.equal(msg.role, "user");
    assert.ok(msg.content[0]?.text.includes("Background"));
  });

});

describe("bindDispatcherLifecycle", () => {
  it("activation binds the parent and wires wakeBus turn bounds by session id", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);

    const parent = createAgent("disp-1");
    ctx.bindAgent(parent);
    // Ticket 19: capture is explicit — no session-start listener fires.
    assert.deepEqual(lifecycle.activate(parent), { ok: true });

    assert.equal(lifecycle.dispatcherSessionId(), "disp-1");
    assert.equal(host.hasParent(), true);

    ctx.fire("agent/status", { agent: parent, status: "running" });
    assert.equal(multitask.wakeBus.isBusy("disp-1"), true);

    ctx.fire("agent/status", { agent: parent, status: "idle" });
    assert.equal(multitask.wakeBus.isBusy("disp-1"), false);

    lifecycle.unbind();
  });

  it("child running promotes spawned → running; child idle fires step boundary", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);

    const parent = createAgent("disp-1");
    assert.deepEqual(lifecycle.activate(parent), { ok: true });

    const spawn = await multitask.spawnWorker({
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
      prompt: "go",
    });
    assert.ok(spawn.ok);
    if (!spawn.ok) return;
    const workerId = spawn.workerId;

    assert.equal(multitask.getWorker(workerId)?.status, "spawned");

    const child = {
      session: { id: workerId, header: { parentSession: "disp-1", delegationDepth: 1 } },
      followup() {},
    };
    ctx.fire("agent/status", { agent: child, status: "running" });
    assert.equal(multitask.getWorker(workerId)?.status, "running");

    const boundaries: string[] = [];
    host.onStepBoundary((id) => {
      boundaries.push(id);
    });
    ctx.fire("agent/status", { agent: child, status: "idle" });
    assert.deepEqual(boundaries, [workerId]);
  });

  it("settle through subagent/end reaches the wake bus exactly once", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);

    const parent = createAgent("disp-1");
    assert.deepEqual(lifecycle.activate(parent), { ok: true });

    const spawn = await multitask.spawnWorker({
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
      prompt: "go",
    });
    assert.ok(spawn.ok);
    if (!spawn.ok) return;
    const workerId = spawn.workerId;

    ctx.fire("agent/status", {
      agent: { session: { id: workerId }, followup() {} },
      status: "running",
    });
    ctx.fire("agent/status", { agent: parent, status: "running" });

    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "ok" }],
    });
    // Double settle is ignored by core FSM.
    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "ok again" }],
    });

    assert.equal(multitask.getWorker(workerId)?.status, "completed");
    // Mid-turn: wake is queued, not flushed.
    assert.equal(multitask.wakeBus.peek("disp-1"), undefined);
    ctx.fire("agent/status", { agent: parent, status: "idle" });
    const wake = multitask.wakeBus.drain("disp-1");
    assert.ok(wake);
    assert.equal(wake.settledWorkers.length, 1);
    assert.equal(wake.settledWorkers[0]?.workerId, workerId);
    assert.equal(wake.settledWorkers[0]?.resultText, "ok");
  });

  it("unbind removes listeners and refuses later activation", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);
    lifecycle.unbind();
    const parent = createAgent("disp-1");
    // Ticket 19: no session-start capture exists; an unbound lifecycle
    // refuses activation instead of re-binding.
    ctx.fire("agent/session-start", { agent: parent, source: "startup" });
    assert.deepEqual(lifecycle.activate(parent), {
      ok: false,
      reason: "unbound",
    });
    assert.equal(host.hasParent(), false);
  });
});

/**
 * Ticket 120 (e2e finding s1) — the worker's FIRST status edge is emitted
 * inside `startActivation`, before `spawnWorker` resolves.
 *
 * The real host runs the child during the spawn: `agent/created` and the
 * first `agent/status: running` both land before `startActivation` returns.
 * The old adapter registered the worker only AFTER the await, so
 * `workerIdOf(...)` answered `undefined` for that exact edge, the plugin's
 * status handler dropped it, and the FSM never left `spawned` — the whole
 * first turn was un-steerable and `check_workers` under-reported.
 *
 * These tests drive the edge from inside the spawn, so the ordering is
 * encoded rather than assumed; nothing sleeps.
 */
describe("ticket 120: the first worker status edge precedes spawn registration", () => {
  /** Wire the shipped trio: real host + real core + the real lifecycle. */
  function wire() {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);
    const parent = createAgent("disp-1");
    ctx.bindAgent(parent);
    assert.deepEqual(lifecycle.activate(parent), { ok: true });
    return { ctx, host, multitask, lifecycle, parent };
  }

  it("a `running` edge emitted inside startActivation reaches the FSM: spawned → running", async () => {
    const { ctx, host, multitask } = wire();
    let statusAtSpawn: string | undefined;
    let sawRunningEdge = false;

    ctx.activationSeams.duringActivation = (childId) => {
      // Exactly what the real child emits 1 ms after `subagent/start`.
      ctx.fire("agent/status", {
        agent: { session: { id: childId, header: { parentSession: "disp-1" } }, followup() {} },
        status: "running",
      });
      sawRunningEdge = true;
      statusAtSpawn = multitask.getWorker(childId)?.status;
    };

    const spawn = await multitask.spawnWorker({
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
      prompt: "go",
    });
    assert.ok(spawn.ok);
    if (!spawn.ok) return;

    assert.equal(sawRunningEdge, true, "the edge really fired during the spawn");
    // The fix, directly: the worker is already `running` when the spawn
    // RESOLVES — it was `spawned` (or absent) before.
    assert.equal(statusAtSpawn, "running", "status applies before the spawn resolves");
    assert.equal(multitask.getWorker(spawn.workerId)?.status, "running");
    // The same id in both registries — no second, phantom entry.
    assert.equal(host.workerIdOf(spawn.workerId), spawn.workerId);
    assert.equal(multitask.listWorkers("disp-1").length, 1);
  });

  it("the first-turn worker accepts a steer and message_agent — the s1 refusal is gone", async () => {
    const { ctx, multitask } = wire();
    ctx.activationSeams.duringActivation = (childId) => {
      ctx.fire("agent/status", {
        agent: { session: { id: childId, header: { parentSession: "disp-1" } }, followup() {} },
        status: "running",
      });
    };

    const spawn = await multitask.spawnWorker({
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "S1 draftsman",
      prompt: "go",
    });
    assert.ok(spawn.ok);
    if (!spawn.ok) return;

    // The exact refusal the e2e harness recorded: "is not running".
    const steer = await multitask.steerWorker(spawn.workerId, "use the other format");
    assert.deepEqual(steer, { ok: true });
    assert.equal(multitask.getWorker(spawn.workerId)?.status, "steering");
  });

  it("one running edge yields exactly one turn-started — no double count, no drop", async () => {
    const { ctx, multitask } = wire();
    multitask.createTodo({ sessionId: "disp-1", id: "t-1", title: "Linked" });
    let recordDuringSpawn: unknown = null;
    let statusAfterSecondEdge: string | undefined;

    ctx.activationSeams.duringActivation = (childId) => {
      const child = {
        session: { id: childId, header: { parentSession: "disp-1" } },
        followup() {},
      };
      ctx.fire("agent/status", { agent: child, status: "running" });
      recordDuringSpawn = multitask.getWorker(childId);
      // Emitting the SAME edge again (a re-announcement) must be a no-op on
      // the FSM: `turn-started` is only legal out of `spawned`.
      ctx.fire("agent/status", { agent: child, status: "running" });
      statusAfterSecondEdge = multitask.getWorker(childId)?.status;
    };

    const spawn = await multitask.spawnWorker({
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
      prompt: "go",
      todoId: "t-1",
    });
    assert.ok(spawn.ok);
    if (!spawn.ok) return;

    assert.equal(statusAfterSecondEdge, "running", "a repeat edge neither resets nor doubles");
    assert.equal(multitask.getWorker(spawn.workerId)?.status, "running");
    // The SAME record object across both edges and the resolution — the
    // reservation is not re-registered into a second, fresh `spawned` row.
    assert.equal(multitask.getWorker(spawn.workerId), recordDuringSpawn);
    // The linked todo advanced at the first turn.
    assert.equal(multitask.listTodos("disp-1")[0]?.status, "in_progress");
    // No duplicate roster rows from the reservation + resolution pair.
    assert.equal(multitask.listWorkers("disp-1").length, 1);
  });

  it("a settled worker still refuses steering — the fix does not weaken the FSM", async () => {
    const { ctx, multitask } = wire();
    ctx.activationSeams.duringActivation = (childId) => {
      ctx.fire("agent/status", {
        agent: { session: { id: childId, header: { parentSession: "disp-1" } }, followup() {} },
        status: "running",
      });
    };
    const spawn = await multitask.spawnWorker({
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
      prompt: "go",
    });
    assert.ok(spawn.ok);
    if (!spawn.ok) return;
    assert.equal(multitask.getWorker(spawn.workerId)?.status, "running");

    ctx.fire("subagent/end", {
      id: spawn.workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "done" }],
    });
    assert.equal(multitask.getWorker(spawn.workerId)?.status, "completed");
    const steer = await multitask.steerWorker(spawn.workerId, "too late");
    assert.ok(!steer.ok);
    if (steer.ok) return;
    assert.equal(steer.reason, "not-running");
  });

  it("a spawn that never starts is still `spawned` and refuses steering", async () => {
    const { multitask } = wire();
    // No activation seam: the child emitted no status edge.
    const spawn = await multitask.spawnWorker({
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
      prompt: "go",
    });
    assert.ok(spawn.ok);
    if (!spawn.ok) return;

    assert.equal(multitask.getWorker(spawn.workerId)?.status, "spawned");
    const steer = await multitask.steerWorker(spawn.workerId, "nope");
    assert.ok(!steer.ok);
    if (steer.ok) return;
    assert.equal(steer.reason, "not-running");
  });

  it("a failed spawn leaves neither registry holding the reservation", async () => {
    const { ctx, host, multitask } = wire();
    // The edge lands, then the host refuses the spawn: no worker survives.
    let emittedId: string | null = null;
    ctx.activationSeams.duringActivation = (childId) => {
      emittedId = childId;
      ctx.fire("agent/status", {
        agent: { session: { id: childId, header: { parentSession: "disp-1" } }, followup() {} },
        status: "running",
      });
      throw new Error("startActivation refused after the child ran");
    };

    await assert.rejects(
      multitask.spawnWorker({
        parentSessionId: "disp-1",
        streamKey: "s1",
        title: "T",
        prompt: "go",
      }),
      /refused after the child ran/,
    );

    assert.ok(emittedId !== null);
    assert.equal(multitask.getWorker(String(emittedId)), undefined);
    assert.equal(multitask.listWorkers("disp-1").length, 0);
    assert.equal(host.owns(String(emittedId)), false);
    // The stream key is free again — the failed spawn holds nothing.
    ctx.activationSeams.duringActivation = null;
    const retry = await multitask.spawnWorker({
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
      prompt: "go",
    });
    assert.ok(retry.ok);
  });
});

/** Fire a `session/event` the way the host bus does: (session, event). */
function fireSessionEvent(
  ctx: ReturnType<typeof createStubCtx>,
  sessionId: string,
  event: unknown,
): void {
  ctx.fire("session/event", { id: sessionId }, event);
}

function toolCallEvent(name: string, args: unknown): unknown {
  return {
    type: "tool/call",
    data: {
      turn: 1,
      step: 2,
      callId: "call-1",
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

/** Bind a parent and spawn one worker; returns the host and its worker id. */
async function spawnOneWorker(ctx: ReturnType<typeof createStubCtx>) {
  const host = createCordisDshHost(ctx);
  host.bindParent(createAgent("disp-1"), "disp-1");
  const workerId = await host.spawnWorker("Do the thing.", {
    parentSessionId: "disp-1",
    streamKey: "s1",
    title: "Thing",
  });
  return { host, workerId };
}

describe("CordisDshHost session/event activity feed (ticket 29)", () => {
  it("derives a phrase from an owned worker's tool/call event", async () => {
    const ctx = createStubCtx();
    const { host, workerId } = await spawnOneWorker(ctx);
    assert.equal(host.recentActivity(workerId), null);

    fireSessionEvent(ctx, workerId, toolCallEvent("bash", { command: "npm test" }));
    assert.equal(host.recentActivity(workerId), "bash: npm test");
  });

  it("ignores non-tool events, unowned sessions, and unreadable payloads", async () => {
    const ctx = createStubCtx();
    const { host, workerId } = await spawnOneWorker(ctx);

    fireSessionEvent(ctx, workerId, { type: "turn/start", data: { turn: 1 } });
    fireSessionEvent(ctx, "stranger-session", toolCallEvent("bash", { command: "rm -rf /" }));
    fireSessionEvent(ctx, workerId, { type: "tool/call", data: { name: "" } });
    fireSessionEvent(ctx, workerId, { type: "tool/call", data: null });
    fireSessionEvent(ctx, workerId, { type: "tool/call" });
    fireSessionEvent(ctx, workerId, null);
    fireSessionEvent(ctx, workerId, undefined);

    assert.equal(host.recentActivity(workerId), null);
  });

  it("clamps the phrase to CHECK_ACTIVITY_CHARS with an ellipsis", async () => {
    const ctx = createStubCtx();
    const { host, workerId } = await spawnOneWorker(ctx);

    // Ticket 63 / A-7: build past the constant, not past a hardcoded 150 —
    // otherwise re-tuning CHECK_ACTIVITY_CHARS quietly un-tests this clamp.
    const longName = "tool_".padEnd(CHECK_ACTIVITY_CHARS + 30, "x");
    fireSessionEvent(ctx, workerId, toolCallEvent(longName, { command: "go" }));
    const phrase = host.recentActivity(workerId);
    assert.ok(phrase !== null);
    assert.ok(
      phrase.length <= CHECK_ACTIVITY_CHARS + 1,
      `phrase clamped: ${phrase.length}`,
    );
    assert.ok(phrase.endsWith("…"));
  });

});

describe("CordisDshHost peer tool/target feed (ticket 155)", () => {
  /** Bind a dispatcher parent so its session id counts as a peer source. */
  function bindDispatcher(ctx: ReturnType<typeof createStubCtx>, id: string) {
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent(id), id);
    return host;
  }

  it("records the tool and target of a bound dispatcher session's tool/call", () => {
    const ctx = createStubCtx();
    const host = bindDispatcher(ctx, "disp-1");
    assert.equal(host.peerToolActivity("disp-1"), null);

    fireSessionEvent(ctx, "disp-1", toolCallEvent("read_file", { path: "src/core/policy" }));
    assert.deepEqual(host.peerToolActivity("disp-1"), {
      tool: "read_file",
      target: "src/core/policy",
    });
  });

  it("a peer's tool call never reaches the worker ring or the tool-call count", async () => {
    const ctx = createStubCtx();
    const { host, workerId } = await spawnOneWorker(ctx);
    const seen: string[] = [];
    host.onWorkerToolCall((id) => seen.push(id));

    fireSessionEvent(ctx, "disp-1", toolCallEvent("bash", { command: "npm test" }));

    assert.deepEqual(seen, [], "no worker count for a dispatcher key");
    assert.equal(host.recentActivity("disp-1"), null, "the worker ring stays worker-keyed");
    assert.equal(host.recentActivity(workerId), null);
    assert.deepEqual(host.peerToolActivity("disp-1"), {
      tool: "bash",
      target: "npm test",
    });
  });

  it("turn/end clears the current tool — a closed turn has no live activity", () => {
    const ctx = createStubCtx();
    const host = bindDispatcher(ctx, "disp-1");

    fireSessionEvent(ctx, "disp-1", toolCallEvent("grep", { pattern: "todo" }));
    assert.ok(host.peerToolActivity("disp-1"));
    fireSessionEvent(ctx, "disp-1", { type: "turn/end", data: { turn: 1, reason: "completed" } });
    assert.equal(host.peerToolActivity("disp-1"), null);
  });

  it("an unreadable payload clears the entry instead of keeping a stale tool", () => {
    const ctx = createStubCtx();
    const host = bindDispatcher(ctx, "disp-1");

    fireSessionEvent(ctx, "disp-1", toolCallEvent("bash", { command: "go" }));
    fireSessionEvent(ctx, "disp-1", { type: "tool/call", data: { name: 7 } });
    assert.equal(host.peerToolActivity("disp-1"), null);
  });

});

describe("CordisDshHost tool-call feed (ticket 75)", () => {
  it("every owned tool/call event notifies subscribers; unreadable payloads count without a phrase", async () => {
    const ctx = createStubCtx();
    const { host, workerId } = await spawnOneWorker(ctx);
    const seen: string[] = [];
    host.onWorkerToolCall((id) => seen.push(id));

    fireSessionEvent(ctx, workerId, toolCallEvent("bash", { command: "go" }));
    // Unreadable payload: no activity phrase, but the call still happened.
    fireSessionEvent(ctx, workerId, { type: "tool/call", data: null });
    assert.deepEqual(seen, [workerId, workerId]);
    assert.equal(host.recentActivity(workerId), "bash: go");

    // Non-tool events and unowned sessions never notify.
    fireSessionEvent(ctx, workerId, { type: "turn/start", data: {} });
    fireSessionEvent(ctx, "stranger-session", toolCallEvent("bash", { command: "x" }));
    assert.deepEqual(seen, [workerId, workerId]);
  });

  it("wired to the core, the count advances and the unknown-reference liveness state becomes reachable", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    // The plugin's glue line (plugin.ts), replicated at this layer; the
    // end-to-end glue itself is covered in plugin-scaffold.test.ts.
    const multitask = createMultitask(host);
    host.onWorkerToolCall((id) => multitask.noteToolCall(id));
    host.bindParent(createAgent("disp-1"), "disp-1");

    const spawn = await multitask.spawnWorker({
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
      prompt: "go",
    });
    assert.ok(spawn.ok);
    if (!spawn.ok) return;
    const workerId = spawn.workerId;

    // Unreadable payload: the count advances with no observation moment.
    fireSessionEvent(ctx, workerId, { type: "tool/call", data: null });

    const summary = multitask.listWorkers("disp-1")[0];
    assert.equal(summary?.toolCallCount, 1);
    assert.equal(host.lastActivityAtMs(workerId), null);
    assert.equal(summary?.startedAtMs, multitask.getWorker(workerId)?.startedAtMs);

    // The stalled-vs-quiet flip (ticket 75): past the stall threshold with
    // no observed activity, a worker whose count stayed 0 was measured from
    // start and read `stalled`; now that the count advanced, the advancement
    // moment is unknown and the honest verdict is `quiet`.
    const now = (summary?.startedAtMs ?? 0) + WORKER_STALL_THRESHOLD_MS + 1;
    const base = {
      status: summary?.status ?? "spawned",
      startedAtMs: summary?.startedAtMs ?? 0,
      lastActivityAtMs: host.lastActivityAtMs(workerId),
      blocked: false,
    };
    assert.equal(deriveWorkerLiveness({ ...base, toolCallCount: 0 }, now), "stalled");
    assert.equal(
      deriveWorkerLiveness(
        { ...base, toolCallCount: summary?.toolCallCount ?? 0 },
        now,
      ),
      "quiet",
    );
  });
});
