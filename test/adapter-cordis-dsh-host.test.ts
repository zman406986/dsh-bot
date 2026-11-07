import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {createCordisDshHost, listGlobalToolNames, mapStopReason, SPAWN_PROVIDER, type ActivationLike, type ActivationSpecLike, type AdapterContext, type AgentLike} from "../src/adapter/cordis-dsh-host.js";
import { RESUME_WAKE_CUE } from "../src/adapter/wake-copy.js";
import { bindDispatcherLifecycle, isTopLevel } from "../src/adapter/parent-agent.js";
import { createMultitask } from "../src/core/multitask.js";
import { assembleSessionPolicy } from "../src/core/policy/assembler.js";
import {
  deriveWorkerLiveness,
  WORKER_STALL_THRESHOLD_MS,
} from "../src/core/liveness.js";
import { CHECK_ACTIVITY_CHARS, RECENT_RESULT_EXCERPT_CHARS } from "../src/core/report-clamp.js";
import type { SettledEvent } from "../src/core/types.js";
import type { DurableWorkerMarker } from "../src/core/durability.js";
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
  /**
   * Auto-title plan §9.1 test 6: every native `rename(session, title)` the
   * host's title service receives. A WORKER spawn must add none — only a
   * summoned team leader is named.
   */
  const sessionTitleCalls: Array<{ sessionId: unknown; title: string }> = [];
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
   * Defect-fix harness: the live host answers `agents.get(id)` with the SAME
   * object it announced. The default stub returns a recording wrapper (the
   * wake tests count `followupCalls` through it); tests that exercise an
   * identity check ("still the same agent") set this to true and bind the
   * exact object.
   */
  let exactAgentIdentity = false;

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
    sessionTitleCalls: Array<{ sessionId: unknown; title: string }>;
    get(name: string): unknown;
    activationSeams: typeof activationSeams;
    composedChildren: Array<{
      childId: string;
      sections: string[];
      restrictions: Array<{ deny?: readonly string[]; allow?: readonly string[] }>;
      schemasScopes: unknown[];
    }>;
    bindAgent(agent: AgentLike): void;
    setExactAgentIdentity(value: boolean): void;
    listenerCount(): number;
  } = {
    startActivationCalls,
    disposedWorkerIds,
    interruptCalls,
    sendMessageCalls,
    followupCalls,
    jobListCalls,
    sessionTitleCalls,
    activationSeams,
    composedChildren,
    /**
     * Auto-title plan §4.2: the host's optional `sessionTitle` service. It is
     * mounted here so the worker path can be checked for NOT calling it;
     * every other service lookup answers undefined, exactly like a minimal
     * deployment (the guarded reads already treat that as "absent").
     */
    get(name: string) {
      if (name !== "sessionTitle") return undefined;
      return {
        rename(session: unknown, title: string) {
          sessionTitleCalls.push({
            sessionId: (session as { id?: unknown } | null | undefined)?.id,
            title,
          });
        },
      };
    },
    fire(name: string, ...payloads: unknown[]) {
      for (const cb of listeners.get(name) ?? []) {
        (cb as (...args: unknown[]) => void)(...payloads);
      }
    },
    bindAgent(agent: AgentLike) {
      agents.set(String(agent.session.id), agent);
    },
    setExactAgentIdentity(value: boolean) {
      exactAgentIdentity = value;
    },
    listenerCount() {
      let total = 0;
      for (const list of listeners.values()) total += list.length;
      return total;
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
        if (exactAgentIdentity) return agent;
        return {
          ...agent,
          followup(message: unknown) {
            followupCalls.push(message);
            // Preserve the driver's answer: a live driver may return a
            // rejected promise, and the host must be able to own it.
            return agent.followup(message);
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
              get: (k: string) =>
                table.get(k) as DurableWorkerMarker | undefined,
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

  it("never names a worker: the host title service is not touched", async () => {
    // Auto-title plan §9.1 test 6 / §6: a worker is not a sidebar row and keeps
    // its `subagent.label`; only the summoned-dispatcher path may rename. The
    // stub mounts a recording title service, so a stray rename would show up
    // rather than pass silently.
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");

    const workerId = await host.spawnWorker("Do the thing.", {
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "Thing",
    });

    assert.equal(typeof workerId, "string");
    assert.notEqual(workerId, "");
    assert.equal(host.owns(workerId), true);
    assert.equal(ctx.sessionTitleCalls.length, 0);
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
          "request_access",
        ],
      },
    ]);
  });

  it("a throwing worker composition does not fail child creation", async () => {
    const ctx = createStubCtx();
    const def = createWorkerAgentDef();
    const throwingDef = {
      ...def,
      resolveToolFilter() {
        throw new Error("tool barrier exploded");
      },
    };
    const host = createCordisDshHost(ctx, { workerAgentDef: throwingDef });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const warnings = await captureWarnings(async () => {
      const workerId = await host.spawnWorker("Do the thing.", {
        parentSessionId: "disp-1",
        streamKey: "s1",
        title: "Thing",
      });
      assert.equal(typeof workerId, "string");
      assert.equal(host.owns(workerId), true, "the child is still live");
    });

    assert.ok(
      warnings.some((line) => line.includes("could not be composed")),
      "the composition failure is logged, not thrown into the host",
    );
    assert.equal(ctx.startActivationCalls.length, 1);
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

  it("dispose while activation is pending aborts the spawn and releases a late receipt", async () => {
    // Ticket 196: dispose() runs during the startActivation await. The
    // controller must already be reachable so teardown can abort the signal,
    // and a host that nevertheless returns a receipt must not register it.
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    ctx.activationSeams.duringActivation = () => {
      entered = true;
      return gate;
    };

    const spawn = host.spawnWorker("x", {
      parentSessionId: "disp-1",
      streamKey: "s-pending-dispose",
      title: "t",
    });
    assert.equal(entered, true, "startActivation is held at the gate");
    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    const signal = spec.signal;
    assert.equal(ctx.listenerCount() > 0, true, "the host is subscribed before dispose");

    host.dispose();
    const abortedAfterDispose = signal.aborted;
    const listenersAfterDispose = ctx.listenerCount();

    // Release the late receipt: the host must not keep it.
    release();
    const workerId = await spawn;

    assert.equal(
      abortedAfterDispose,
      true,
      "a single disposal aborts the pending startup signal",
    );
    assert.equal(listenersAfterDispose, 0, "dispose removed every host subscription");
    assert.equal(host.owns(workerId), false, "no usable worker in a disposed host");
    assert.equal(host.workerIdOf(workerId), undefined);
    assert.deepEqual(
      ctx.disposedWorkerIds,
      [workerId],
      "the late activation receipt is disposed exactly once",
    );

    // Ordinary unload does not call dispose twice; if something does, it must
    // not release the same activation again.
    host.dispose();
    assert.deepEqual(ctx.disposedWorkerIds, [workerId]);
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

describe("ticket 285: spawn_worker applies the request's model route", () => {
  it("sends the explicit model as agentOptions on the activation request", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("leader-1"), "leader-1");

    await host.spawnWorker("Do the thing.", {
      parentSessionId: "leader-1",
      streamKey: "s1",
      title: "Thing",
      model: { provider: "pD", model: "mD" },
    });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    // provider+model only — the spawn option carries no reasoning effort or
    // maxTokens (plan §1.5). The host's child merge turns a changed route
    // into a bare one itself; sending tuning here would contradict the
    // contract the tool resolves.
    assert.deepEqual(spec.request.agentOptions, {
      provider: "pD",
      model: "mD",
    });
  });

  it("omits agentOptions entirely when neither the option nor a stored default exists", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("leader-1"), "leader-1");

    await host.spawnWorker("Do the thing.", {
      parentSessionId: "leader-1",
      streamKey: "s1",
      title: "Thing",
    });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    // Exact pre-feature request shape: with no route to apply the child
    // inherits the leader's live route through the host's own child-option
    // merge (dsh-subagent/lib/types/child-agent.js), and the key must not
    // appear at all — an explicit undefined would change what the host sees.
    assert.equal("agentOptions" in spec.request, false);
    assert.deepEqual(Object.keys(spec.request).sort(), [
      "maxDepth",
      "parent",
      "prompt",
    ]);
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

  it("sendMessage delivers through subagent delivery, never the peer facade", async () => {
    // The production crash this pins: the steered session was a subagent
    // child and `sessionController.resolveAgent` refused it with
    // `session/agent-busy`. Subagent delivery is the only worker route; a
    // mounted facade must not be consulted at all.
    const ctx = createStubCtx();
    const facadeCalls: string[] = [];
    (ctx as unknown as Record<string, unknown>)["get"] = (name: string) =>
      name === "sessionController"
        ? {
            async resolveAgent(sessionId: string) {
              facadeCalls.push(sessionId);
              return { error: new Error("session is owned by subagent routing") };
            },
          }
        : undefined;

    const host = createCordisDshHost(ctx);
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);

    const parent = createAgent("disp-1");
    assert.deepEqual(lifecycle.activate(parent), { ok: true });

    const spawn = await multitask.spawnWorker({
      parentSessionId: "disp-1",
      streamKey: "s-steer",
      title: "Steer",
      prompt: "go",
    });
    assert.ok(spawn.ok);
    if (!spawn.ok) return;

    await host.sendMessage(spawn.workerId, "tighten it");

    assert.deepEqual(facadeCalls, [], "the peer facade must not be asked");
    assert.equal(ctx.sendMessageCalls.length, 1);
    assert.equal(ctx.sendMessageCalls[0]?.targetId, spawn.workerId);
    assert.equal(ctx.sendMessageCalls[0]?.sender, parent);
    const content = ctx.sendMessageCalls[0]?.content as Array<{
      readonly text?: string;
    }>;
    assert.ok(
      content.map((block) => block.text ?? "").join("").includes("tighten it"),
    );
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

  it("a worker that settles during startActivation is not re-inserted", async () => {
    const { ctx, host } = wire();
    const settled: SettledEvent[] = [];
    host.onWorkerSettled((event) => settled.push(event));
    ctx.activationSeams.duringActivation = (childId) => {
      ctx.fire("subagent/end", {
        id: childId,
        stopReason: "completed",
        lastAssistantMessage: [{ type: "text", text: "done already" }],
      });
    };

    const workerId = await host.spawnWorker("x", {
      parentSessionId: "disp-1",
      streamKey: "s-settled-during-spawn",
      title: "T",
    });

    assert.equal(settled.length, 1, "the settle was observed");
    assert.equal(host.owns(workerId), false, "no post-settle re-insertion");
    assert.equal(host.workerIdOf(workerId), undefined);
    assert.deepEqual(ctx.disposedWorkerIds, [workerId]);

    // Host teardown must not release the same activation twice.
    host.dispose();
    assert.deepEqual(ctx.disposedWorkerIds, [workerId]);
  });

  it("accepts a settle after the live entry is pruned when no durable store exists", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");
    const workerId = await host.spawnWorker("x", {
      parentSessionId: "disp-1",
      streamKey: "s-no-durability",
      title: "T",
    });
    const settled: SettledEvent[] = [];
    host.onWorkerSettled((event) => settled.push(event));

    // The live entry is gone (a disposal), and there is no durable wake row.
    ctx.fire("agent/disposed", { agent: { session: { id: workerId } } });
    assert.equal(host.owns(workerId), false);

    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "done" }],
    });

    assert.equal(settled.length, 1, "the in-process spawn proof keeps the settle");
    assert.equal(settled[0]?.workerId, workerId);
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

/**
 * Defect fixes on the host's dormancy, delivery, and per-worker lifecycle
 * paths. Each test fails against the pre-fix code:
 * - a throwing `followup` escaped the synchronous `agent/created` listener;
 * - `interruptWorker` returned success with no authority (the core had
 *   already committed `aborted`);
 * - a facade refusal was terminal, so pre-ADR-0032 rows were never resumed;
 * - `resumeRequested` stranded forever after a resume that never activated;
 * - a parked worker correction was dropped on a failed send;
 * - a settled worker whose async row delete was lost was woken again;
 * - `workers`/`spawnControllers`/`workerActivations` leaked until dispose.
 */
describe("defect fixes: wake, interrupt, dormancy and worker lifecycle", () => {
  function tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  async function drain(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await tick();
  }

  /** A mark store that answers every seam the host reads. */
  function createMarkStore(options?: {
    dispatchers?: Array<{
      sessionId: string;
      parentSessionId?: string;
      generation?: number;
      origin?: "subagent" | "top-level";
    }>;
    workers?: Array<{ sessionId: string; parentSessionId: string }>;
    workerMarkers?: Array<{ workerId: string; parentSessionId: string; status: string }>;
  }) {
    const dispatchers = new Map(
      (options?.dispatchers ?? []).map((row) => [row.sessionId, { ...row }]),
    );
    const workers = new Map(
      (options?.workers ?? []).map((row) => [row.sessionId, { ...row }]),
    );
    const workerMarkers = options?.workerMarkers ?? [];
    return {
      dispatchers,
      workers,
      writeWorkerMarker() {},
      readWorkerMarkers(parentSessionId: string) {
        return workerMarkers.filter(
          (marker) => marker.parentSessionId === parentSessionId,
        ) as never;
      },
      deleteWorkerMarker() {},
      writeDispatcherMark(mark: { sessionId: string; parentSessionId?: string }) {
        dispatchers.set(mark.sessionId, { ...mark });
      },
      readDispatcherMark(sessionId: string) {
        return dispatchers.get(sessionId);
      },
      listDispatcherMarks() {
        return [...dispatchers.values()] as never;
      },
      peekDispatcherMark(sessionId: string) {
        const mark = dispatchers.get(sessionId);
        return mark === undefined
          ? { kind: "not-dispatcher" as const }
          : { kind: "dispatcher" as const, mark: mark as never };
      },
      listWorkerSessions() {
        return [...workers.values()] as never;
      },
      readWorkerSession(sessionId: string) {
        return workers.get(sessionId) as never;
      },
      deleteWorkerSession(sessionId: string) {
        // `DurabilityPort` owns a void result; the row's fate is not part of
        // the seam's answer.
        workers.delete(sessionId);
      },
      writeWorkerSession(session: { sessionId: string; parentSessionId: string }) {
        workers.set(session.sessionId, { ...session });
      },    };
  }

  function textOfCall(call: RecordedCall): string {
    const content = call["content"] as Array<{ text?: string }>;
    return content.map((block) => block.text ?? "").join("");
  }

  /** A subagent-shaped child of ONE named dispatcher session. */
  function createChildAgent(id: string, parentSessionId: string): AgentLike {
    return {
      session: {
        id,
        header: { parentSession: parentSessionId, delegationDepth: 1 },
      },
      followup() {},
    };
  }

  it("a throwing dispatcher followup does not escape the listener, and the wake is re-parked", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore({ dispatchers: [{ sessionId: "disp-1" }] });
    const host = createCordisDshHost(ctx, { markers: store });
    await host.refreshDispatcherMarks();

    // The live agent's driver throws — the reported real shape of a disposed
    // or half-torn-down Agent.
    const flaky = createAgent("disp-1");
    flaky.followup = () => {
      throw new Error("driver is gone");
    };
    ctx.bindAgent(flaky);

    // Must RESOLVE: the wake request is reached from settle callbacks, and an
    // escaping throw there is an unhandled rejection in the host.
    const warnings = await captureWarnings(async () => {
      await host.requestDispatcherWakeup("disp-1");
    });
    assert.equal(ctx.followupCalls.length, 1);
    assert.ok(
      warnings.some((line) => line.includes("could not be opened")),
      "the failure is logged",
    );

    // The parked text was re-parked, so the next announcement still delivers.
    const followed: unknown[] = [];
    const resumed = createAgent("disp-1");
    resumed.followup = (message: unknown) => {
      followed.push(message);
    };
    ctx.fire("agent/created", {
      agent: resumed,
      source: "resume",
    });
    assert.equal(followed.length, 1, "the wake was not lost");
  });

  it("a failed followup retries the composed body verbatim, never the generic cue", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore({ dispatchers: [{ sessionId: "disp-1" }] });
    const composed = "## Recent worker activity\n\n- parser finished; 42 tests passed";
    let composes = 0;
    const host = createCordisDshHost(ctx, {
      markers: store,
      composeWakeText: () => {
        composes += 1;
        return composed;
      },
    });
    await host.refreshDispatcherMarks();

    const flaky = createAgent("disp-1");
    flaky.followup = () => {
      throw new Error("driver is gone");
    };
    ctx.bindAgent(flaky);

    const warnings = await captureWarnings(async () => {
      await host.requestDispatcherWakeup("disp-1");
    });
    assert.equal(composes, 1, "the report is composed (and drained) exactly once");
    assert.ok(warnings.some((line) => line.includes("could not be opened")));

    // The parked turn is discharged by the next announcement. It must reuse
    // the text composed before the failure: composing again would find the
    // wake bus already drained and deliver only the generic cue.
    const followed: unknown[] = [];
    const resumed = createAgent("disp-1");
    resumed.followup = (message: unknown) => {
      followed.push(message);
    };
    ctx.fire("agent/created", { agent: resumed, source: "resume" });

    assert.equal(followed.length, 1, "delivered exactly once");
    assert.equal(
      textOfWake(followed[0]),
      composed,
      "the composed report is delivered, not the generic settle cue",
    );
    assert.equal(composes, 1, "the retry must not compose/drain a second time");
  });

  it("a live wake whose followup returns a rejected promise is parked, never an unhandled rejection", async () => {
    const watcher: unknown[] = [];
    const listener = (reason: unknown): void => {
      watcher.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const ctx = createStubCtx();
      const composed = "worker report body";
      let composes = 0;
      const host = createCordisDshHost(ctx, {
        composeWakeText: () => {
          composes += 1;
          return composed;
        },
      });
      const flaky = createAgent("disp-1");
      // A live driver can also return a rejected promise (instead of
      // throwing synchronously); the wake path must own it.
      flaky.followup = () => Promise.reject(new Error("driver rejected"));
      ctx.bindAgent(flaky);

      const warnings = await captureWarnings(async () => {
        await host.requestDispatcherWakeup("disp-1");
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      assert.ok(
        warnings.some((line) => line.includes("could not be opened")),
        "the rejection is logged",
      );

      const followed: unknown[] = [];
      const resumed = createAgent("disp-1");
      resumed.followup = (message: unknown) => {
        followed.push(message);
      };
      ctx.fire("agent/created", { agent: resumed, source: "resume" });
      assert.equal(followed.length, 1);
      assert.equal(textOfWake(followed[0]), composed);
      assert.equal(composes, 1);

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(watcher, [], "no followup rejection may go unhandled");
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("a live wake consumes the parked slot, so activation opens no second turn", async () => {
    const ctx = createStubCtx();
    ctx.setExactAgentIdentity(true);
    const store = createMarkStore({ dispatchers: [{ sessionId: "disp-1" }] });
    const host = createCordisDshHost(ctx, {
      markers: store,
      composeWakeText: () => "LIVE WAKE BODY",
    });
    await host.refreshDispatcherMarks();

    // No live agent yet: the turn is parked and a resume is requested.
    await host.requestDispatcherWakeup("disp-1");
    await drain();

    // The session becomes live BEFORE the activation hook runs. A live wake
    // delivers now and must consume the parked slot.
    const live = createChildAgent("disp-1", "disp-parent");
    const followed: unknown[] = [];
    live.followup = (message: unknown) => {
      followed.push(message);
    };
    ctx.bindAgent(live);
    await host.requestDispatcherWakeup("disp-1");
    await drain();
    assert.equal(followed.length, 1, "the live wake opened one turn");

    // The activation hook now runs for the same id. The stale slot must not
    // open a second, generic turn.
    ctx.fire("agent/created", { agent: live, source: "resume" });
    await drain();
    assert.equal(
      followed.length,
      1,
      "the parked body is only for the failure path and was cleared",
    );
  });

  it("the session facade resumes a marked dispatcher with exactly one RESUME_WAKE_CUE followup and no subagent send", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore({
      dispatchers: [
        { sessionId: "disp-facade", parentSessionId: "disp-spawner" },
      ],
    });
    const resolved: string[] = [];
    const followed: unknown[] = [];
    (ctx as unknown as Record<string, unknown>)["get"] = (name: string) =>
      name === "sessionController"
        ? {
            async resolveAgent(sessionId: string) {
              resolved.push(sessionId);
              const agent = createAgent(sessionId);
              agent.followup = (message: unknown) => {
                followed.push(message);
              };
              return { agent };
            },
          }
        : undefined;
    const host = createCordisDshHost(ctx, {
      markers: store,
      composeWakeText: () => "PEER MESSAGE: pick the work back up.",
    });
    await host.refreshDispatcherMarks();
    // The spawner fallback WOULD be issuable; a successful facade resolve
    // must still be the only route.
    host.bindParent(createAgent("disp-spawner"), "disp-spawner");

    await host.requestDispatcherWakeup("disp-facade");
    await drain();

    assert.deepEqual(resolved, ["disp-facade"]);
    assert.equal(followed.length, 1, "exactly one followup opens the turn");
    assert.equal(
      textOfWake(followed[0]),
      RESUME_WAKE_CUE,
      "the payload is the resume cue, not the peer text",
    );
    assert.equal(
      ctx.sendMessageCalls.length,
      0,
      "a successful facade resolve never falls back to subagents",
    );
  });

  it("a facade followup failure does not double-send through subagents and keeps the wake parked", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore({
      dispatchers: [
        { sessionId: "disp-facade", parentSessionId: "disp-spawner" },
      ],
    });
    let resolves = 0;
    (ctx as unknown as Record<string, unknown>)["get"] = (name: string) =>
      name === "sessionController"
        ? {
            async resolveAgent() {
              resolves += 1;
              const agent = createAgent("disp-facade");
              agent.followup = () => {
                throw new Error("followup driver died");
              };
              return { agent };
            },
          }
        : undefined;
    let composes = 0;
    const host = createCordisDshHost(ctx, {
      markers: store,
      composeWakeText: () => {
        composes += 1;
        return "PEER BODY: pick the work back up.";
      },
    });
    await host.refreshDispatcherMarks();
    host.bindParent(createAgent("disp-spawner"), "disp-spawner");

    const warnings = await captureWarnings(async () => {
      await host.requestDispatcherWakeup("disp-facade");
      await drain();
    });

    assert.equal(resolves, 1);
    assert.equal(
      ctx.sendMessageCalls.length,
      0,
      "a resolved resume must never fall through to a second cue",
    );
    assert.ok(
      warnings.some((line) =>
        line.includes("was resumed but its followup failed"),
      ),
      "the followup failure is logged",
    );
    assert.equal(
      composes,
      0,
      "the peer body is still parked in the wake bus, not drained",
    );

    // The parked wake is still an obligation: the announcement delivers it
    // exactly once, and still never through the spawner route.
    const followed: unknown[] = [];
    const resumed = createAgent("disp-facade");
    resumed.followup = (message: unknown) => {
      followed.push(message);
    };
    ctx.fire("agent/created", { agent: resumed, source: "resume" });
    assert.equal(followed.length, 1);
    assert.equal(textOfWake(followed[0]), "PEER BODY: pick the work back up.");
    assert.equal(ctx.sendMessageCalls.length, 0);
  });

  it("a rejected facade followup promise is owned, never an unhandled rejection", async () => {
    const watcher: unknown[] = [];
    const listener = (reason: unknown): void => {
      watcher.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const ctx = createStubCtx();
      const store = createMarkStore({
        dispatchers: [
          { sessionId: "disp-facade", parentSessionId: "disp-spawner" },
        ],
      });
      (ctx as unknown as Record<string, unknown>)["get"] = (name: string) =>
        name === "sessionController"
          ? {
              async resolveAgent() {
                const agent = createAgent("disp-facade");
                agent.followup = () => Promise.reject(new Error("driver rejected"));
                return { agent };
              },
            }
          : undefined;
      const host = createCordisDshHost(ctx, { markers: store });
      await host.refreshDispatcherMarks();
      host.bindParent(createAgent("disp-spawner"), "disp-spawner");

      const warnings = await captureWarnings(async () => {
        await host.requestDispatcherWakeup("disp-facade");
        await drain();
      });

      assert.equal(ctx.sendMessageCalls.length, 0);
      assert.ok(
        warnings.some((line) =>
          line.includes("was resumed but its followup failed"),
        ),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(watcher, [], "no followup rejection may go unhandled");
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("interruptWorker refuses with the missing authority instead of claiming success", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const parent = createAgent("disp-1");
    host.bindParent(parent, "disp-1");
    const workerId = await host.spawnWorker("Do it.", {
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
    });

    // The recorded parent is unbound: nothing can be issued.
    host.unbindParent("disp-1");
    await assert.rejects(
      host.interruptWorker(workerId),
      /no parent agent bound for worker/,
    );
    assert.equal(ctx.interruptCalls.length, 0);

    // …but the host's own live registry still answers the same session id, and
    // that agent is still the child's ancestor: the interrupt is issued.
    ctx.bindAgent(parent);
    await host.interruptWorker(workerId);
    assert.equal(ctx.interruptCalls.length, 1);
    const authority = (ctx.interruptCalls[0] as { authority: { agent: AgentLike } })
      .authority;
    assert.equal(String(authority.agent.session.id), "disp-1");
  });

  it("falls back to the recorded spawner when the session facade refuses a legacy parented child", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore({
      dispatchers: [
        {
          sessionId: "legacy-child",
          parentSessionId: "disp-1",
          origin: "subagent",
        },
      ],
    });
    (ctx as unknown as Record<string, unknown>)["get"] = (name: string) =>
      name === "sessionController"
        ? {
            async resolveAgent() {
              return { error: new Error("session/agent-busy") };
            },
          }
        : undefined;
    const host = createCordisDshHost(ctx, { markers: store });
    await host.refreshDispatcherMarks();
    const parent = createAgent("disp-1");
    host.bindParent(parent, "disp-1");

    await host.requestDispatcherWakeup("legacy-child");
    await drain();

    assert.equal(ctx.sendMessageCalls.length, 1);
    const call = ctx.sendMessageCalls[0] as RecordedCall;
    assert.equal(String(call["targetId"]), "legacy-child");
    assert.equal(
      String((call["sender"] as AgentLike).session.id),
      "disp-1",
      "the recorded spawner is the sender",
    );
    assert.equal(
      textOfCall(call),
      RESUME_WAKE_CUE,
      "the fallback sends the resume cue, not the peer text",
    );
  });

  it("does not use the subagent route for a top-level peer with no facade", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore({
      dispatchers: [
        {
          sessionId: "peer-top",
          parentSessionId: "disp-1",
          generation: 2,
          origin: "top-level",
        },
      ],
    });
    // No session facade at all (ctx.get is absent on this stub).
    const host = createCordisDshHost(ctx, { markers: store });
    await host.refreshDispatcherMarks();
    // The recorded summoner IS bound; that alone must not select the subagent
    // route (the bug).
    host.bindParent(createAgent("disp-1"), "disp-1");

    const warnings = await captureWarnings(async () => {
      await host.requestDispatcherWakeup("peer-top");
      await drain();
    });

    assert.equal(
      ctx.sendMessageCalls.length,
      0,
      "a top-level peer is not addressable through ctx.subagents.sendMessage",
    );
    assert.ok(
      warnings.some((line) => line.includes("is undeliverable")),
      "the gap is named rather than claimed as a resume",
    );

    // The wake stayed parked and is delivered on activation.
    const followed: unknown[] = [];
    const resumed = createChildAgent("peer-top", "disp-parent");
    resumed.followup = (message: unknown) => {
      followed.push(message);
    };
    ctx.fire("agent/created", { agent: resumed, source: "resume" });
    await drain();
    assert.equal(followed.length, 1, "the parked wake is still an obligation");
  });

  it("logs one undeliverable line and keeps the wake parked when the facade refuses with no spawner", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore({ dispatchers: [{ sessionId: "orphan-child" }] });
    (ctx as unknown as Record<string, unknown>)["get"] = (name: string) =>
      name === "sessionController"
        ? {
            async resolveAgent() {
              return { error: new Error("session/agent-busy") };
            },
          }
        : undefined;
    const host = createCordisDshHost(ctx, { markers: store });
    await host.refreshDispatcherMarks();

    const warnings = await captureWarnings(async () => {
      await host.requestDispatcherWakeup("orphan-child");
      await drain();
    });
    assert.equal(ctx.sendMessageCalls.length, 0, "nothing was sent");
    assert.ok(
      warnings.some((line) => line.includes("is undeliverable")),
      "the gap is named, not claimed as a resume",
    );

    // The parked wake is still an obligation: the next announcement delivers.
    const followed: unknown[] = [];
    const resumed = createAgent("orphan-child");
    resumed.followup = (message: unknown) => {
      followed.push(message);
    };
    ctx.fire("agent/created", { agent: resumed, source: "resume" });
    assert.equal(followed.length, 1, "the wake stayed parked");
  });

  it("clears a stranded resumeRequested on agent/created and agent/disposed", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore({ dispatchers: [{ sessionId: "disp-1" }] });
    let resolves = 0;
    (ctx as unknown as Record<string, unknown>)["get"] = (name: string) =>
      name === "sessionController"
        ? {
            async resolveAgent() {
              resolves += 1;
              return { agent: createAgent("disp-1") };
            },
          }
        : undefined;
    const host = createCordisDshHost(ctx, { markers: store });
    await host.refreshDispatcherMarks();

    // First send: one resume, which never reaches an activation here (the
    // stub's `agents.get` does not answer the id).
    await host.requestDispatcherWakeup("disp-1");
    await drain();
    assert.equal(resolves, 1);

    // A second send is deduplicated, and says so instead of returning silently.
    const warnings = await captureWarnings(async () => {
      await host.requestDispatcherWakeup("disp-1");
      await drain();
    });
    assert.equal(resolves, 1);
    assert.ok(
      warnings.some((line) => line.includes("already has a resume in flight")),
      "the short-circuit is logged",
    );

    // The session is announced (no activation hook on this host): the marker
    // is cleared, so a later send starts a FRESH resume.
    ctx.fire("agent/created", {
      agent: createAgent("disp-1"),
      source: "resume",
    });
    await host.requestDispatcherWakeup("disp-1");
    await drain();
    assert.equal(resolves, 2, "a later send may resume again");
  });

  it("re-parks a parked worker correction when the spawner is not bound", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const rememberWake = host.rememberWorkerWake;
    const wakeDormant = host.wakeDormantWorker;
    assert.ok(rememberWake && wakeDormant, "the host exposes the wake seam");
    rememberWake("w-1", "disp-1");

    // No parent bound yet: nothing is issued and the text stays parked.
    await wakeDormant("w-1", "tighten it");
    const child = createChildAgent("w-1", "disp-1");
    ctx.fire("agent/created", { agent: child, source: "resume" });
    await drain();
    // Only the resume cue could have been sent, and it was not (no sender).
    assert.equal(ctx.sendMessageCalls.length, 0);

    // The spawner activates: the same correction is delivered, not dropped.
    const parent = createAgent("disp-1");
    host.bindParent(parent, "disp-1");
    ctx.fire("agent/created", { agent: child, source: "resume" });
    await drain();
    assert.equal(ctx.sendMessageCalls.length, 1);
    assert.equal(
      textOfCall(ctx.sendMessageCalls[0] as RecordedCall),
      "tighten it",
    );
  });

  it("binding a previously unbound spawner delivers its parked worker correction once", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const rememberWake = host.rememberWorkerWake;
    const wakeDormant = host.wakeDormantWorker;
    assert.ok(rememberWake && wakeDormant, "the host exposes the wake seams");
    rememberWake("w-1", "disp-1");
    await wakeDormant("w-1", "tighten it");
    await drain();
    assert.equal(
      ctx.sendMessageCalls.length,
      0,
      "nothing can be sent without a bound spawner",
    );

    host.bindParent(createAgent("disp-1"), "disp-1");
    await drain();
    assert.equal(ctx.sendMessageCalls.length, 1, "activation delivered it");
    assert.equal(
      textOfCall(ctx.sendMessageCalls[0] as RecordedCall),
      "tighten it",
    );

    // A later announcement of the same worker must not repeat it.
    ctx.fire("agent/created", {
      agent: createChildAgent("w-1", "disp-1"),
      source: "resume",
    });
    await drain();
    assert.equal(ctx.sendMessageCalls.length, 1);
  });

  it("a newer correction parked during an in-flight send is delivered after it resolves", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const rememberWake = host.rememberWorkerWake;
    const wakeDormant = host.wakeDormantWorker;
    assert.ok(rememberWake && wakeDormant, "the host exposes the wake seams");
    rememberWake("w-1", "disp-1");

    const corrections: string[] = [];
    let releaseFirst: (() => void) | null = null;
    ctx.subagents.sendMessage = async (
      _sender: AgentLike,
      _target: unknown,
      content: unknown,
    ) => {
      const text = (content as Array<{ text?: string }>)
        .map((block) => block.text ?? "")
        .join("");
      if (text === RESUME_WAKE_CUE) return "cue";
      corrections.push(text);
      if (text === "T1") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return "ok";
    };

    await wakeDormant("w-1", "T1");
    // Activation of the spawner starts T1's delivery (in flight).
    host.bindParent(createAgent("disp-1"), "disp-1");
    await tick();
    assert.deepEqual(corrections, ["T1"]);

    // A newer correction arrives while T1's send is still unresolved.
    await wakeDormant("w-1", "T2");
    await tick();
    assert.deepEqual(corrections, ["T1"], "the in-flight guard holds T2");

    // T1 resolves; T2 must now start on its own, exactly once, and T1 must
    // not be repeated.
    assert.ok(releaseFirst !== null);
    (releaseFirst as () => void)();
    await drain();
    assert.deepEqual(corrections, ["T1", "T2"]);
  });

  it("does not re-park a failed correction for a worker that settled meanwhile", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const rememberWake = host.rememberWorkerWake;
    const wakeDormant = host.wakeDormantWorker;
    assert.ok(rememberWake && wakeDormant, "the host exposes the wake seams");
    rememberWake("w-1", "disp-1");

    const corrections: string[] = [];
    let rejectFirst: ((error: Error) => void) | null = null;
    ctx.subagents.sendMessage = async (
      _sender: AgentLike,
      _target: unknown,
      content: unknown,
    ) => {
      const text = (content as Array<{ text?: string }>)
        .map((block) => block.text ?? "")
        .join("");
      if (text === RESUME_WAKE_CUE) return "cue";
      corrections.push(text);
      if (text === "T1") {
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return "ok";
    };

    await wakeDormant("w-1", "T1");
    host.bindParent(createAgent("disp-1"), "disp-1");
    await tick();
    assert.deepEqual(corrections, ["T1"]);

    // The worker settles while its correction is in flight.
    const forgetWake = host.forgetWorkerWake;
    assert.ok(forgetWake, "the host exposes the tombstone seam");
    forgetWake("w-1");
    assert.ok(rejectFirst !== null);
    (rejectFirst as (error: Error) => void)(new Error("delivery refused"));
    await drain();

    // Re-binding the spawner would deliver anything still parked. The failed
    // text must NOT be re-parked for a tombstoned worker.
    host.bindParent(createAgent("disp-1"), "disp-1");
    await drain();
    assert.deepEqual(corrections, ["T1"], "nothing was re-parked");
  });

  it("a dormant worker wake uses subagent delivery with the RESUME cue, never the peer facade", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore({
      workers: [{ sessionId: "w-1", parentSessionId: "disp-1" }],
    });
    let facadeCalls = 0;
    (ctx as unknown as Record<string, unknown>)["get"] = (name: string) =>
      name === "sessionController"
        ? {
            async resolveAgent() {
              facadeCalls += 1;
              return { error: new Error("session/agent-busy") };
            },
          }
        : undefined;
    const host = createCordisDshHost(ctx, { markers: store });
    // The durable row is what marks this worker wake-able after a restart.
    await host.refreshWorkerSessionMarks();
    host.bindParent(createAgent("disp-1"), "disp-1");
    const wakeDormant = host.wakeDormantWorker;
    assert.ok(wakeDormant, "the host exposes the dormant-worker wake seam");

    await wakeDormant("w-1", "tighten it");
    await drain();

    assert.equal(
      facadeCalls,
      0,
      "the cross-session facade serves dispatcher peers, never subagent children",
    );
    assert.equal(ctx.sendMessageCalls.length, 1);
    const call = ctx.sendMessageCalls[0] as RecordedCall;
    assert.equal(String(call["targetId"]), "w-1");
    assert.equal(
      String((call["sender"] as AgentLike).session.id),
      "disp-1",
      "the recorded spawner is the sender",
    );
    assert.equal(
      textOfCall(call),
      RESUME_WAKE_CUE,
      "the cue opens the turn; the correction is delivered after activation",
    );
  });

  it("re-parks a parked worker correction when the send rejects", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const parent = createAgent("disp-1");
    host.bindParent(parent, "disp-1");
    const rememberWake = host.rememberWorkerWake;
    const wakeDormant = host.wakeDormantWorker;
    assert.ok(rememberWake && wakeDormant, "the host exposes the wake seam");
    rememberWake("w-1", "disp-1");
    await wakeDormant("w-1", "tighten it");
    await drain();
    assert.equal(ctx.sendMessageCalls.length, 1, "the resume cue went out");

    // The delivery itself is refused once.
    const original = ctx.subagents.sendMessage;
    let refuses = 1;
    ctx.subagents.sendMessage = async (...args) => {
      if (refuses > 0) {
        refuses -= 1;
        throw new Error("delivery refused");
      }
      return original(...args);
    };

    const child = createChildAgent("w-1", "disp-1");
    ctx.fire("agent/created", { agent: child, source: "resume" });
    await drain();
    // The refused delivery never reached the stub's recorder: only the cue is
    // there, and the correction is back in the parked slot.
    assert.equal(ctx.sendMessageCalls.length, 1);

    // The failed text was re-parked and delivered on the next announcement.
    ctx.fire("agent/created", { agent: child, source: "resume" });
    await drain();
    const corrections = ctx.sendMessageCalls
      .filter((call) => String(call["targetId"]) === "w-1")
      .map((call) => textOfCall(call as RecordedCall))
      .filter((text) => text === "tighten it");
    assert.deepEqual(corrections, ["tighten it"]);
  });

  it("a settled worker's live entries are pruned, and it is never adopted again", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");
    const workerId = await host.spawnWorker("Do it.", {
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
    });
    assert.equal(host.owns(workerId), true);

    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "Done." }],
    });

    assert.equal(host.owns(workerId), false, "the registry entry is gone");
    assert.equal(host.workerIdOf(workerId), undefined);
    assert.deepEqual(
      ctx.disposedWorkerIds,
      [workerId],
      "the activation is released",
    );

    // Re-adoption after a terminal settle is refused: stop is for good.
    const again = createChildAgent(workerId, "disp-1");
    ctx.fire("agent/created", { agent: again, source: "resume" });
    await drain();
    assert.equal(
      host.owns(workerId),
      false,
      "a settled worker is not resurrected",
    );
  });

  it("a disposed worker agent's live entries are pruned but its wake identity survives", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const parent = createAgent("disp-1");
    host.bindParent(parent, "disp-1");
    const workerId = await host.spawnWorker("Do it.", {
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
    });
    // The core records the wake identity at spawn (`rememberWorkerWake`);
    // repeat it here because this test drives the host directly.
    const rememberWake = host.rememberWorkerWake;
    assert.ok(rememberWake, "the host exposes the worker wake mirror");
    rememberWake(workerId, "disp-1");
    assert.equal(host.owns(workerId), true);

    ctx.fire("agent/disposed", {
      agent: { session: { id: workerId } },
    });

    assert.equal(host.owns(workerId), false, "the live entry is gone");
    assert.deepEqual(ctx.disposedWorkerIds, [workerId]);
    assert.deepEqual(
      host.workerSessionMark(workerId),
      { parentSessionId: "disp-1" },
      "the wake identity survives plain disposure",
    );
  });

  it("a stale agent/disposed event after re-adoption does not prune the new activation", async () => {
    const ctx = createStubCtx();
    ctx.setExactAgentIdentity(true);
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");
    const workerId = await host.spawnWorker("Do it.", {
      parentSessionId: "disp-1",
      streamKey: "s1",
      title: "T",
    });

    // The host re-adopted this id under a NEW Agent (cold resume on send).
    const adopted = createChildAgent(workerId, "disp-1");
    ctx.bindAgent(adopted);

    // A stale disposal for the PREVIOUS Agent arrives afterwards.
    ctx.fire("agent/disposed", {
      agent: { session: { id: workerId } },
    });

    assert.equal(
      host.owns(workerId),
      true,
      "the old disposal must not prune the re-adopted activation",
    );
    assert.deepEqual(
      ctx.disposedWorkerIds,
      [],
      "and must not release its activation",
    );
  });

  it("refreshWorkerSessionMarks skips rows whose worker is durably terminal", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore({
      workers: [
        { sessionId: "w-done", parentSessionId: "disp-1" },
        { sessionId: "w-live", parentSessionId: "disp-1" },
      ],
      workerMarkers: [
        { workerId: "w-done", parentSessionId: "disp-1", status: "completed" },
        { workerId: "w-live", parentSessionId: "disp-1", status: "running" },
      ],
    });
    const host = createCordisDshHost(ctx, { markers: store });

    await host.refreshWorkerSessionMarks();

    assert.equal(
      host.workerSessionMark("w-done"),
      undefined,
      "terminal row ignored",
    );
    assert.deepEqual(host.workerSessionMark("w-live"), {
      parentSessionId: "disp-1",
    });
  });

  it("skips adopting a worker whose durable marker is terminal, even through the store fallback", async () => {
    const ctx = createStubCtx();
    ctx.setExactAgentIdentity(true);
    const store = createMarkStore({
      workers: [{ sessionId: "w-done", parentSessionId: "disp-1" }],
      workerMarkers: [
        { workerId: "w-done", parentSessionId: "disp-1", status: "aborted" },
      ],
    });
    const host = createCordisDshHost(ctx, { markers: store });
    const parent = createAgent("disp-1");
    host.bindParent(parent, "disp-1");
    const child = createChildAgent("w-done", "disp-1");
    ctx.bindAgent(child);

    ctx.fire("agent/created", { agent: child, source: "resume" });
    await drain();

    assert.equal(
      host.owns("w-done"),
      false,
      "a terminal worker is not adopted",
    );
  });

  it("a disposed parented dispatcher re-activates on re-announcement, exactly once", async () => {
    const ctx = createStubCtx();
    ctx.setExactAgentIdentity(true);
    const store = createMarkStore({
      dispatchers: [
        { sessionId: "legacy-child", parentSessionId: "disp-parent" },
      ],
    });
    const state = {
      activations: 0,
      injects: 0,
      tools: new Set<string>(),
      parentBinding: null as AgentLike | null,
    };
    const agent = {
      session: {
        id: "legacy-child",
        header: { parentSession: "disp-parent", delegationDepth: 1 },
      },
      followup() {},
      inject() {
        state.injects += 1;
      },
      ctx: {
        tools: {
          schemas: () => [...state.tools].map((name) => ({ name })),
          register(definition: { name: string }) {
            state.tools.add(definition.name);
            return () => state.tools.delete(definition.name);
          },
        },
      },
    } as unknown as AgentLike;
    ctx.bindAgent(agent);
    let host: ReturnType<typeof createCordisDshHost>;
    host = createCordisDshHost(ctx, {
      markers: store,
      onDispatcherSpawned: (child, sessionId) => {
        // The three effects a real activation produces (bind, policy, scoped
        // tools). The host's job is to run this hook once per activation.
        state.activations += 1;
        state.parentBinding = child;
        host.bindParent(child, sessionId);
        child.inject?.({ content: [{ type: "text", text: "policy" }] });
        child.ctx?.tools?.register?.({
          name: `dispatcher_tool_${state.activations}`,
        });
      },
    });

    ctx.fire("agent/created", { agent, source: "resume" });
    await drain();
    assert.equal(state.activations, 1);
    assert.equal(state.injects, 1);
    assert.equal(state.tools.size, 1);
    assert.equal(host.parentAgentOf("legacy-child"), agent);

    // Dispose the activation. The plugin's deactivation clears its surface;
    // model that here so "returned" is observable.
    ctx.fire("agent/disposed", { agent });
    host.unbindParent("legacy-child");
    state.tools.clear();
    assert.equal(host.parentAgentOf("legacy-child"), undefined);

    // A re-announcement of the same parented id must activate again.
    ctx.fire("agent/created", { agent, source: "resume" });
    await drain();
    assert.equal(state.activations, 2, "the hook ran again");
    assert.equal(state.injects, 2, "policy came back exactly once");
    assert.equal(state.tools.size, 1, "the scoped tool surface came back once");
    assert.equal(host.parentAgentOf("legacy-child"), agent);

    // A repeat announcement while already active is still deduplicated.
    ctx.fire("agent/created", { agent, source: "resume" });
    await drain();
    assert.equal(state.activations, 2, "no duplicate activation while live");
    assert.equal(state.tools.size, 1);
  });

  it("does not activate a dispatcher whose agent was disposed during the store round-trip", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore({ dispatchers: [{ sessionId: "disp-child" }] });
    const spawned: string[] = [];
    const host = createCordisDshHost(ctx, {
      markers: store,
      onDispatcherSpawned: (_agent, sessionId) => {
        spawned.push(sessionId);
      },
    });
    const child = createChildAgent("disp-child", "disp-parent");

    // Announced, but the host's registry no longer answers it by the time the
    // mark read resolves — a disposed Agent must not be installed.
    ctx.fire("agent/created", { agent: child, source: "resume" });
    await drain();

    assert.deepEqual(spawned, [], "no activation on a dead agent");
  });
});

describe("adapter host contract guards (second-round audit)", () => {
  it("listGlobalToolNames requires and forwards the agent scope", () => {
    const ctx = createStubCtx();
    const scope = { session: { id: "agent-1" } };
    let seen: unknown;
    ctx.tools = {
      schemas(received?: unknown) {
        seen = received;
        return [{ name: "scoped_tool" }];
      },
    };

    const names = listGlobalToolNames(ctx, scope);
    assert.deepEqual([...names], ["scoped_tool"]);
    assert.equal(seen, scope, "the unscoped global-only view is never used");
  });

  it("listLiveJobs reads the guarded ctx.get('jobs') service", () => {
    const ctx = createStubCtx();
    const seen: unknown[] = [];
    // The un-injected property read must not be the route.
    ctx.jobs = {
      list() {
        throw new Error("ctx.jobs must not be read on a live shape");
      },
    };
    (ctx as unknown as Record<string, unknown>)["get"] = (name: string) =>
      name === "jobs"
        ? {
            list(callerSessionId?: unknown) {
              seen.push(callerSessionId);
              return [
                {
                  id: "job-1",
                  kind: "worker",
                  label: "Job",
                  status: "running",
                  startedAt: 1,
                },
              ];
            },
          }
        : undefined;
    const host = createCordisDshHost(ctx);

    const jobs = host.listLiveJobs("caller-1");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.id, "job-1");
    assert.deepEqual(seen, ["caller-1"]);
  });
});

/** Capture `console.warn` lines for one asynchronous run. */
async function captureWarnings(
  run: () => void | Promise<void>,
): Promise<string[]> {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return messages;
}

/** Text of a wake/followup message (`content` text blocks joined). */
function textOfWake(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  return Array.isArray(content)
    ? content.map((block) => block.text ?? "").join("")
    : "";
}

/**
 * Ticket 163/ADR-0032 defect fixes that live in the lifecycle layer:
 * - a disposed dispatcher no longer stays `busy` on the wake bus;
 * - a peer's spawn title survives deactivation (it is a property of the id);
 * - a transcript that already carries the session policy is not re-injected.
 */
describe("defect fixes: dispatcher lifecycle and policy idempotence", () => {
  /** A top-level agent that records injects, for the policy/roster checks. */
  function createInjectableAgent(id: string) {
    const injected: unknown[] = [];
    const agent = {
      session: {
        id,
        header: { parentSession: undefined, delegationDepth: 0 },
      },
      injected,
      followup() {},
      inject(message: unknown) {
        injected.push(message);
      },
    };
    return agent;
  }

  /**
   * Install the supported `sessionQuery` listing seam. The policy probe reads
   * this (`ctx.get("sessionQuery").listEvents(sessionId)`), NOT the
   * deprecated `session.snapshotEvents()`.
   */
  function installSessionQuery(
    ctx: ReturnType<typeof createStubCtx>,
    eventsBySession: Record<string, readonly unknown[]>,
  ): void {
    (ctx as unknown as Record<string, unknown>)["get"] = (name: string) =>
      name === "sessionQuery"
        ? {
            listEvents(sessionId: string) {
              return eventsBySession[sessionId] ?? [];
            },
          }
        : undefined;
  }

  /** One committed `user/message` carrying `text` from this producer. */
  function policyEvent(seq: number, text: string, extras?: {
    role?: string;
    sourceKind?: string;
    type?: string;
  }): unknown {
    return {
      type: extras?.type ?? "user/message",
      seq,
      data: {
        role: extras?.role ?? "user",
        content: [{ type: "text", text }],
        source: { kind: extras?.sourceKind ?? "plugin:multitask-dispatcher" },
      },
    };
  }

  function textOf(message: unknown): string {
    const content = (message as { content?: Array<{ text?: string }> }).content;
    return Array.isArray(content)
      ? content.map((block) => block.text ?? "").join("")
      : "";
  }

  it("deactivation ends the wake-bus turn, so a re-activated dispatcher is not stuck busy", () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);

    const parent = createAgent("disp-1");
    assert.deepEqual(lifecycle.activate(parent), { ok: true });
    ctx.fire("agent/status", { agent: parent, status: "running" });
    assert.equal(multitask.wakeBus.isBusy("disp-1"), true);

    // Disposed mid-turn: the activation (and its turn) ends with it.
    lifecycle.deactivate("disp-1");
    assert.equal(
      multitask.wakeBus.isBusy("disp-1"),
      false,
      "a disposed dispatcher must not stay busy",
    );
  });

  it("deactivation cancels pending work without delivering it or resuming the session", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);
    let resumes = 0;
    (ctx as unknown as Record<string, unknown>)["get"] = (name: string) =>
      name === "sessionController"
        ? {
            async resolveAgent() {
              resumes += 1;
              return { error: new Error("refused") };
            },
          }
        : undefined;

    const parent = createAgent("disp-1");
    ctx.bindAgent(parent);
    assert.deepEqual(lifecycle.activate(parent), { ok: true });
    // Mid-turn: the settle is queued, not delivered.
    ctx.fire("agent/status", { agent: parent, status: "running" });
    multitask.wakeBus.enqueueWorkerSettled({
      parentSessionId: "disp-1",
      workerId: "w-1",
      status: "completed",
      title: "Done",
      resultText: "result",
    });
    assert.equal(ctx.followupCalls.length, 0);

    lifecycle.deactivate("disp-1");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      ctx.followupCalls.length,
      0,
      "teardown must not open a wake turn into the disposed session",
    );
    assert.equal(resumes, 0, "and must not cold-resume it");
    assert.equal(multitask.wakeBus.isBusy("disp-1"), false);
    assert.equal(
      multitask.wakeBus.peek("disp-1"),
      undefined,
      "no prepared wake is left ready for the dead activation",
    );
  });

  it("keeps a peer's spawn title across deactivation and re-activation", () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);

    const titled = createInjectableAgent("disp-a");
    const viewer = createInjectableAgent("disp-b");
    assert.deepEqual(
      lifecycle.activate(titled, { origin: "spawned", title: "Alpha team" }),
      { ok: true },
    );
    assert.deepEqual(lifecycle.activate(viewer), { ok: true });

    // The viewer's per-turn reminder lists the titled peer.
    ctx.fire("agent/status", { agent: viewer, status: "running" });
    const firstTurn = viewer.injected.map(textOf).join("\n");
    assert.ok(firstTurn.includes("Alpha team"));

    // Deactivate + re-activate WITHOUT the title: the label is a property of
    // the session id, exactly like its generation, so it must not vanish.
    lifecycle.deactivate("disp-a");
    assert.deepEqual(lifecycle.activate(titled), { ok: true });
    ctx.fire("agent/status", { agent: viewer, status: "running" });
    const laterTurns = viewer.injected.map(textOf).join("\n");
    assert.ok(
      laterTurns.includes("Alpha team"),
      "the re-activated peer kept its label",
    );
  });

  it("skips injection only for a live committed producer policy above any compaction", () => {
    const policy = assembleSessionPolicy(true, "user", 1, "en");
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const multitask = createMultitask(host);
    const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);

    installSessionQuery(ctx, {
      "disp-1": [policyEvent(1, policy)],
      // A compaction landed AFTER the policy copy: its live-context presence
      // can no longer be established, so the probe must inject again.
      "disp-compacted": [
        policyEvent(1, policy),
        { type: "compaction/start", seq: 2, data: { compactionId: "c1" } },
        { type: "compaction/end", seq: 3, data: { compactionId: "c1" } },
      ],
      // A compaction BEFORE the policy copy leaves the copy on the surface.
      "disp-live": [
        { type: "compaction/start", seq: 1, data: { compactionId: "c0" } },
        { type: "compaction/end", seq: 2, data: { compactionId: "c0" } },
        policyEvent(3, policy),
      ],
      // An assistant/model echo carries the text but is not OUR committed
      // user message.
      "disp-echo": [
        policyEvent(1, policy, { role: "assistant" }),
        policyEvent(2, policy, { sourceKind: "user" }),
      ],
    });

    const carrying = createInjectableAgent("disp-1");
    assert.deepEqual(lifecycle.activate(carrying), { ok: true });
    assert.equal(carrying.injected.length, 0, "live policy is not re-injected");

    const compacted = createInjectableAgent("disp-compacted");
    assert.deepEqual(lifecycle.activate(compacted), { ok: true });
    assert.equal(
      compacted.injected.length,
      1,
      "old policy below a compaction boundary is injected again",
    );

    const live = createInjectableAgent("disp-live");
    assert.deepEqual(lifecycle.activate(live), { ok: true });
    assert.equal(live.injected.length, 0, "policy after a boundary is live");

    const echo = createInjectableAgent("disp-echo");
    assert.deepEqual(lifecycle.activate(echo), { ok: true });
    assert.equal(echo.injected.length, 1, "an echo does not count as the policy");

    // No supported query seam at all: fail open and inject.
    const noSeamCtx = createStubCtx();
    const noSeamHost = createCordisDshHost(noSeamCtx);
    const noSeamLifecycle = bindDispatcherLifecycle(
      noSeamCtx,
      noSeamHost,
      createMultitask(noSeamHost),
    );
    const fresh = createInjectableAgent("disp-2");
    assert.deepEqual(noSeamLifecycle.activate(fresh), { ok: true });
    assert.equal(fresh.injected.length, 1);
  });

  it("a throwing sessionKindOf reader does not escape the listener, and the parked wake still flushes", async () => {
    const ctx = createStubCtx();
    const store = {
      writeWorkerMarker() {},
      readWorkerMarkers() {
        return [];
      },
      deleteWorkerMarker() {},
      listDispatcherMarks() {
        return [{ sessionId: "disp-cold" }];
      },
    };
    const host = createCordisDshHost(ctx, {
      markers: store,
      onUserDispatcherResumed: () => {},
      sessionKindOf: () => {
        throw new Error("projection exploded");
      },
    });
    await host.refreshDispatcherMarks();
    await host.requestDispatcherWakeup("disp-cold");

    const followed: unknown[] = [];
    const resumed = createAgent("disp-cold");
    resumed.followup = (message: unknown) => {
      followed.push(message);
    };
    // The listener must not throw, and the parked wake is delivered even
    // though the kind projection answered nothing.
    ctx.fire("agent/created", { agent: resumed, source: "resume" });
    assert.equal(followed.length, 1);
  });
});
