/** #301: real stock cold resume, with deterministic in-memory inference/storage. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { createCordisDshHost, type CordisDshHost } from "../src/adapter/cordis-dsh-host.js";
import { bindDispatcherLifecycle } from "../src/adapter/parent-agent.js";
import { subagentLabelOf } from "../src/adapter/peer-label.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import { createInMemoryDurability } from "../src/core/durability.js";
import type { SettledEvent } from "../src/core/types.js";
import { createWorkerAgentDef } from "../src/worker/agent-def.js";

// Load the installed native host graph, not a fake resume/settle event emitter.
// It opens no server and the only llm service below is the scripted generator.
const installed = join(process.env.APPDATA!, "npm/node_modules/@deepseek-ai/dsh");
const load = (name: string) => import(pathToFileURL(join(installed, "node_modules/@deepseek-ai", name, "lib/index.js")).href);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("accounts for a real same-session stock continuation without reopening delivered work", { timeout: 20_000 }, async () => {
  const { Context } = await load("cordis");
  const { createUserMessage } = await load("dsh-llm");
  const ctx = new Context();
  const parentId = "stock-continuation-parent";
  const firstResult = "FIRST_RESULT_4f81";
  const secondResult = "SECOND_RESULT_19c2";
  const resumeText = "RESUME_TASK_67c4";
  let childId: string | undefined;
  let firstChildAgent: any;
  let resumedChildAgent: any;
  let childCalls = 0;
  let workExecutions = 0;
  let firstToolEvent: any;
  const resumedEntered = deferred<void>();
  const releaseResumed = deferred<void>();
  const secondSettled = deferred<void>();
  const sendAccepted = deferred<any>();
  const starts: Array<{ id: string; runId: string }> = [];
  const rawSettles: Array<{ id: string; runId: string; stopReason: string; lastAssistantMessage?: any[] }> = [];
  const productSettles: SettledEvent[] = [];
  const errors: string[] = [];
  const notices: string[] = [];
  const boundaries: string[] = [];
  let replayingStaleEvent = false;
  const textOf = (message: any): string => (message?.content ?? []).map((block: any) => block.text ?? "").join("");
  const msg = (text: string) => createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] });

  async function* blocks(content: any[], reason = "stop") {
    for (const [index, block] of content.entries()) {
      yield { type: "block-start", index, blockType: block.type };
      if (block.type === "text") yield { type: "text-delta", index, text: block.text };
      else yield { type: "tool-call-delta", index, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: "block-end", index, block };
    }
    yield { type: "finish", reason: { kind: reason } };
  }
  async function* script(request: any) {
    const texts = request.messages.map((message: any) => ({ role: message.role, text: textOf(message) }));
    if (request.sessionId === parentId) {
      if (texts.some((m: any) => m.text === "RESUME_NOW") && !texts.some((m: any) => m.role === "tool" && m.text.includes("message delivered"))) {
        yield* blocks([{ type: "tool-call", id: "resume-send-call", name: "send_message", arguments: JSON.stringify({ agent_id: childId, message: resumeText }) }], "tool-calls");
        return;
      }
      yield* blocks([{ type: "text", text: "PARENT_ACK" }]);
      return;
    }
    childId ??= request.sessionId;
    assert.equal(request.sessionId, childId);
    childCalls += 1;
    const resumed = texts.some((m: any) => m.text.includes(resumeText));
    const callId = resumed ? "run-b-work" : "run-a-work";
    if (!request.messages.some((m: any) => m.role === "tool" && m.toolCallId === callId)) {
      yield* blocks([{ type: "tool-call", id: callId, name: "continuation_work", arguments: JSON.stringify({ target: resumed ? "run-b.txt" : "run-a.txt" }) }], "tool-calls");
      return;
    }
    if (!resumed) {
      yield* blocks([{ type: "text", text: firstResult }]);
      return;
    }
    assert.equal(childCalls, 4, "one work call and one answer step per execution");
    assert(texts.some((m: any) => m.text.includes(firstResult)), "prior context restored");
    assert(texts.some((m: any) => m.text.includes(resumeText)), "stock message reaches second run");
    resumedChildAgent = ctx.agents.get(childId);
    resumedEntered.resolve();
    await Promise.race([releaseResumed.promise, new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))]);
    yield* blocks([{ type: "text", text: secondResult }]);
  }
  ctx.provide("llm", { async prepareCall(config: any) { return { config, adapterDefaults: {}, stream: script }; }, stream: script });
  ctx.provide("workingDirectory", { async ensure() { return process.cwd(); }, async set() {} });
  ctx.provide("jobs", { list() { return []; } });
  const persisted = new Map<string, any>();
  const handleFor = (row: any) => ({
    header: row.header, inheritedEventCount: row.inheritedEventCount,
    async append(suffix: any[]) { row.events.push(...suffix); },
    async read(start = 0, end?: number) { return { events: structuredClone(row.events.slice(start, end)) }; },
    async close() {},
  });
  ctx.provide("sessionPersistence", {
    async stat(id: string) { return persisted.get(id); },
    async create(header: any, options: any) {
      const row = { header, events: [], inheritedEventCount: options.inheritedEventCount ?? 0 };
      persisted.set(header.id, row);
      return handleFor(row);
    },
    async open(id: string) { const row = persisted.get(id); assert(row, "persisted child exists"); return handleFor(row); },
  });
  ctx.provide("sessionQuery", { async observeSession(id: string) {
    const row = persisted.get(id);
    assert(row);
    return { header: row.header, events: structuredClone(row.events), inheritedEventCount: row.inheritedEventCount, [Symbol.dispose]() {} };
  } });
  ctx.on("session/event", (session: any, event: any) => {
    persisted.get(session.id)?.events.push(event);
    if (session.id !== parentId && event.type === "tool/call" && event.data.callId === "run-a-work") firstToolEvent = event;
    if (session.id === parentId && event.type === "tool/result" && event.data.message?.toolCallId === "resume-send-call") sendAccepted.resolve(event);
    if (session.id === parentId && event.type === "user/message" && event.data.source?.kind === "subagent-settled") notices.push(textOf(event.data));
  });
  ctx.on("agent/error", ({ error }: any) => errors.push(String(error?.stack ?? error)));
  ctx.on("agent/created", ({ agent }: any) => { if (agent.session.header.origin === "subagent") firstChildAgent ??= agent; });
  ctx.on("subagent/start", (info: any) => { if (!replayingStaleEvent) starts.push(info); });
  ctx.on("subagent/end", (info: any) => {
    if (replayingStaleEvent) return;
    rawSettles.push(info);
    if (rawSettles.length === 2) secondSettled.resolve();
  });
  const replay = (name: string, payload: unknown) => {
    replayingStaleEvent = true;
    try { ctx.emit(name, payload); } finally { replayingStaleEvent = false; }
  };

  const durability = createInMemoryDurability();
  let host: CordisDshHost | undefined;
  let core: Multitask | undefined;
  let lifecycle: ReturnType<typeof bindDispatcherLifecycle> | undefined;
  let parentHandle: any;
  let activation: any;
  try {
    for (const name of ["dsh-session", "dsh-session-projection", "dsh-agent", "dsh-system-prompt", "dsh-tools"]) await ctx.plugin((await load(name)).default, {});
    const { defineTool } = await load("dsh-tools");
    ctx.tools.register(defineTool({
      name: "continuation_work", description: "Perform deterministic offline fixture work.",
      parameters: { target: { type: "string", required: true } },
      output: { schema: { type: "string" }, render: (_args: any, value: string) => [{ type: "text", text: value }] },
      async execute({ target }: any) { workExecutions += 1; return target; },
    }));
    await ctx.plugin(await load("dsh-tool-executor-native"), {});
    await ctx.plugin((await load("dsh-agent-loop")).default, { agents: [] });
    await ctx.plugin((await load("dsh-subagent")).default, {});
    await ctx.plugin(await load("dsh-subagent-spawn-in-process"), { providerName: "spawn" });
    await ctx.plugin(await load("dsh-tool-subagent-control"), {});
    host = createCordisDshHost(ctx, {
      markers: durability, workerAgentDef: createWorkerAgentDef("en"), workerLocalTools: () => [],
      onStockWorkerAdopted: (workerId, parentSessionId, session, runId) => core?.adoptSpawnedWorker({ workerId, parentSessionId, ...(runId !== undefined ? { runId } : {}), label: subagentLabelOf(ctx.sessionProjections, session) }),
      onWorkerReattached: (workerId, parentSessionId) => core?.reclaimWorker(workerId, parentSessionId),
    });
    core = createMultitask(host, { durability });
    lifecycle = bindDispatcherLifecycle(ctx, host, core, { policyEnabled: false });
    host.onWorkerSettled(event => productSettles.push(event));
    host.onWorkerToolCall(workerId => { core?.noteToolCall(workerId); });
    host.onStepBoundary(workerId => { boundaries.push(workerId); });
    parentHandle = await ctx.agents.create({ sessionId: parentId, agentOptions: { provider: "offline-fixture", model: "memory" } });
    const parent = parentHandle.agent;
    assert.equal(lifecycle.activate(parent).ok, true);
    activation = await ctx.subagents.startActivation({ provider: "spawn", label: "same-session follow-up", delivery: "parent", signal: new AbortController().signal, request: { parent, maxDepth: 1, prompt: [{ type: "text", text: "FIRST_TASK" }] } });
    childId = activation.childId;
    await activation.result;
    await parent.whenIdle();
    assert.deepEqual(errors, []);
    assert.equal(rawSettles.length, 1);
    assert.equal(productSettles.length, 1);
    const firstRecord = core.getWorker(childId!);
    assert.equal(firstRecord?.status, "completed");
    assert(firstRecord?.todoId);
    assert.equal(core.markDelivered(firstRecord.todoId), true);
    const oldTodo = structuredClone(core.todos.get(firstRecord.todoId));
    const firstSettle = structuredClone(core.settleRecords.lookup(parentId, childId!));
    assert.equal(ctx.agents.get(childId), undefined, "first Agent actually disposed");

    parent.followup(msg("RESUME_NOW"));
    await resumedEntered.promise;
    const accepted = await sendAccepted.promise;
    assert.equal(accepted.data.message.isError, false);
    assert.notEqual(firstChildAgent, resumedChildAgent, "cold resume creates distinct Agent");
    assert.equal(resumedChildAgent.id, childId);
    assert.equal(resumedChildAgent.status, "running");
    assert.equal(starts.length, 2);
    assert.equal(starts[0]?.id, starts[1]?.id);
    assert.notEqual(starts[0]?.runId, starts[1]?.runId, "native identity distinguishes executions");
    assert.equal(workExecutions, 2, "native executor actually ran work in both A and B");
    assert(firstToolEvent, "A's real work event was captured before disposal");
    assert.equal(host.recentActivities(childId!, 1).length, 1, "current B activity was actually recorded");
    assert.notEqual(host.recentActivity(childId!), null, "live B activity is not hidden by A's tombstone");
    assert.notEqual(host.lastActivityAtMs(childId!), null, "live B activity timestamp is not hidden by A's tombstone");
    const whileRunning = { owns: host.owns(childId!), worker: structuredClone(core.getWorker(childId!)) };
    const currentTodoId = whileRunning.worker?.todoId;
    assert(currentTodoId);
    assert.notEqual(currentTodoId, firstRecord.todoId, "new run has separate obligation");
    const currentTodo = structuredClone(core.todos.get(currentTodoId));
    const oldRun = structuredClone(core.getWorker(childId!, starts[0]!.runId));
    const boundaryCount = boundaries.length;
    const currentActivity = structuredClone(host.recentActivities(childId!, 5));
    // Same session id, but OLD Session object: this captured A event must not
    // charge B or replace its live activity after native B was verified.
    ctx.emit("session/event", firstChildAgent.session, firstToolEvent);
    assert.equal(core.getWorker(childId!)?.toolCallCount, whileRunning.worker?.toolCallCount, "old Session tool event cannot charge current B");
    assert.deepEqual(host.recentActivities(childId!, 5), currentActivity, "old Session tool event cannot replace B activity");
    // These are captured REAL old events, replayed only after real stock B is
    // running. They must not re-adopt A, settle B, or discharge B's boundary.
    replay("subagent/start", starts[0]);
    replay("subagent/end", rawSettles[0]);
    replay("agent/status", { agent: firstChildAgent, status: "running" });
    replay("agent/status", { agent: firstChildAgent, status: "idle" });
    replay("agent/disposed", { agent: firstChildAgent });
    assert.equal(boundaries.length, boundaryCount, "old Agent status cannot discharge current run boundary");
    assert.deepEqual(core.getWorker(childId!), whileRunning.worker, "old events cannot change current run");
    assert.equal(host.owns(childId!), true, "old disposal cannot drop current ownership");
    assert.deepEqual(core.todos.get(currentTodoId), currentTodo);
    assert.deepEqual(core.getWorker(childId!, starts[0]!.runId), oldRun, "prior terminal history unchanged");
    assert.equal(productSettles.length, 1, "old settle cannot settle current run");
    releaseResumed.resolve();
    await secondSettled.promise;
    await parent.whenIdle();

    // Positive controls precede the product assertions: real second execution,
    // successful upstream delivery, and no reopening of the delivered item.
    assert.deepEqual(errors, []);
    assert.equal(rawSettles.length, 2);
    assert.equal(rawSettles[1]?.runId, starts[1]?.runId);
    assert.equal(rawSettles[1]?.stopReason, "completed");
    assert.match(textOf({ content: rawSettles[1]?.lastAssistantMessage }), /SECOND_RESULT_19c2/);
    assert.equal(notices.filter(text => text.includes(secondResult)).length, 1, "stock parent receives second result exactly once");
    assert.deepEqual(core.todos.get(firstRecord.todoId), oldTodo, "old delivered obligation unchanged");
    assert.match(firstSettle?.resultText ?? "", /FIRST_RESULT_4f81/);

    assert.equal(whileRunning.owns, true, "new verified execution must be owned while actually running");
    assert.equal(whileRunning.worker?.status, "running", "current projection must represent resumed execution");
    assert.equal(productSettles.length, 2, "each verified execution settles once");
    assert.match(core.settleRecords.lookup(parentId, childId!)?.resultText ?? "", /SECOND_RESULT_19c2/);
    assert.match(core.settleRecords.lookup(parentId, childId!, starts[0]!.runId)?.resultText ?? "", /FIRST_RESULT_4f81/);
    assert.deepEqual(core.getWorker(childId!, starts[0]!.runId), oldRun);
    const secondTerminal = structuredClone(core.getWorker(childId!));
    const secondSettle = structuredClone(core.settleRecords.lookup(parentId, childId!));
    replay("subagent/end", rawSettles[1]);
    replay("subagent/start", starts[0]);
    assert.equal(productSettles.length, 2, "duplicate second settlement remains a no-op");
    assert.deepEqual(core.getWorker(childId!), secondTerminal);
    assert.deepEqual(core.settleRecords.lookup(parentId, childId!), secondSettle);
    assert.equal(host.owns(childId!), false, "stale start cannot resurrect terminal work");
    assert.deepEqual(core.todos.get(firstRecord.todoId), oldTodo);
  } finally {
    releaseResumed.resolve();
    core?.dispose();
    lifecycle?.unbind();
    host?.dispose();
    await activation?.dispose();
    await parentHandle?.dispose();
  }
});
