/**
 * Ticket 122 / ADR-0028 — worker mid-task reply channel.
 *
 * What these pins hold:
 * 1. The verb is `reply_to_dispatcher`, worker-only, and it addresses the
 *    owning dispatcher from CORE TRUTH (the roster record), never from a
 *    tool argument — so no child→child or cross-dispatcher path exists.
 * 2. A reply rides the existing `peer` wake lane. During a user-owned turn
 *    it queues and flushes at turn end; it never interrupts the user.
 * 3. A reply does not settle the worker, does not complete the todo, and is
 *    not the completion report: the completion report arrives as a
 *    `worker-settled` wake, the reply as a `peer` wake.
 * 4. Provenance is structured (`origin.kind: "worker-reply"`), survives to
 *    the rendered peer wake, and the rendering cannot read as a user message.
 * 5. The tool is absent from the dispatcher surface and present on a
 *    worker's; the worker barrier does not deny it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import { assemblePeerWakeTurn } from "../src/core/policy/assembler.js";
import {
  PEER_WAKE_SECTION_HEADINGS,
  WAKE_SECTION_HEADINGS,
} from "../src/core/policy/prompts.js";
import { isWorkerReply } from "../src/core/peer-types.js";
import type { PeerEnvelope } from "../src/core/peer-types.js";
import {
  createDispatcherTools,
  createWorkerReplyTool,
  registerWorkerLocalTools,
  REPLY_TO_DISPATCHER_TOOL,
  toRegisterableWorkerTool,
  WORKER_REPLY_RATE_LIMIT,
  WORKER_REPLY_RATE_WINDOW_MS,
  WORKER_REPLY_TEXT_MAX_CHARS,
  type WorkerReplyToolResult,
} from "../src/core/tools.js";
import { buildWorkerToolFilter } from "../src/worker/tool-barrier.js";
import { buildWorkerSystemPrompt } from "../src/worker/prompt.js";

const PARENT = "dispatcher-session-1";

interface Rig {
  host: FakeDshHost;
  multitask: Multitask;
  workerId: string;
  parentSessionId: string;
  execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<WorkerReplyToolResult>;
}

async function rig(options?: {
  now?: () => number;
  title?: string;
  todoId?: string;
  parentSessionId?: string;
}): Promise<Rig> {
  const host = new FakeDshHost();
  const multitask = createMultitask(host);
  const parentSessionId = options?.parentSessionId ?? PARENT;
  if (options?.todoId !== undefined) {
    multitask.createTodo({
      sessionId: parentSessionId,
      title: options.title ?? "Index the docs",
      id: options.todoId,
    });
  }
  const spawned = await multitask.spawnWorker({
    parentSessionId,
    streamKey: "stream-1",
    title: options?.title ?? "Index the docs",
    prompt: "Do the work.",
    ...(options?.todoId !== undefined ? { todoId: options.todoId } : {}),
  });
  assert.ok(spawned.ok);
  if (!spawned.ok) throw new Error("unreachable");
  const workerId = spawned.workerId;
  multitask.noteTurnStarted(workerId);

  const tool = createWorkerReplyTool({
    multitask,
    // The adapter's shape: exec session id must be an owned worker.
    resolveWorkerId: (exec) => {
      const record = exec as { sessionId?: unknown } | null | undefined;
      const id = record?.sessionId;
      if (id === undefined || id === null) return null;
      const value = String(id);
      return multitask.getWorker(value) !== undefined ? value : null;
    },
    ...(options?.now !== undefined ? { now: options.now } : {}),
  });

  return {
    host,
    multitask,
    workerId,
    parentSessionId,
    execute: (args, exec) =>
      tool.execute(args, exec ?? { sessionId: workerId }) as Promise<
        WorkerReplyToolResult
      >,
  };
}

function inboxOf(multitask: Multitask, sessionId: string): PeerEnvelope[] {
  return [...multitask.listPendingPeers(sessionId)];
}

describe("ticket 122 — the owning dispatcher is the only reachable target", () => {
  it("refuses when that dispatcher session is no longer live", async () => {
    const host = new FakeDshHost();
    const live = new Set<string>();
    const multitask = createMultitask(host, {
      isLiveDispatcherSession: (sessionId) => live.has(sessionId),
    });
    const spawned = await multitask.spawnWorker({
      parentSessionId: PARENT,
      streamKey: "s",
      title: "T",
      prompt: "P",
    });
    assert.ok(spawned.ok);
    if (!spawned.ok) throw new Error("unreachable");
    const workerId = spawned.workerId;
    const tool = createWorkerReplyTool({
      multitask,
      resolveWorkerId: () => workerId,
    });

    // Parent live: accepted.
    live.add(PARENT);
    const first = (await tool.execute({ text: "one" })) as WorkerReplyToolResult;
    assert.equal(first.ok, true);

    // Parent gone: refused honestly, nothing queued for anyone.
    live.delete(PARENT);
    const refused = (await tool.execute({
      text: "two",
    })) as WorkerReplyToolResult;
    assert.equal(refused.ok, false);
    assert.match(refused.summary, /unknown-target/);
    assert.equal(inboxOf(multitask, PARENT).length, 1);
  });
});

describe("ticket 122 — reply_to_dispatcher routes to the owning dispatcher", () => {
  it("lands in the parent dispatcher's inbox with structured origin", async () => {
    const r = await rig();
    const result = await r.execute({
      text: "Found the retry bug in sync.ts; fixing it now.",
      status: "progress",
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "progress");

    const pending = inboxOf(r.multitask, r.parentSessionId);
    assert.equal(pending.length, 1);
    const envelope = pending[0]!;
    assert.deepEqual(envelope.to, { kind: "agent", agentId: r.parentSessionId });
    assert.equal(envelope.text, "Found the retry bug in sync.ts; fixing it now.");
    assert.equal(envelope.priority, false, "a reply never preempts a user turn");
    assert.equal(envelope.fromAgentId, r.workerId);
    assert.deepEqual(envelope.origin, {
      kind: "worker-reply",
      workerId: r.workerId,
      status: "progress",
    });
  });

  it("takes the address from the roster, so a supplied target is ignored", async () => {
    const r = await rig();
    await r.execute({
      text: "hello",
      // A model trying to address someone else; the schema also forbids it.
      to_session: "some-other-dispatcher",
      worker_id: "another-worker",
    });

    const pending = inboxOf(r.multitask, r.parentSessionId);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0]!.to, {
      kind: "agent",
      agentId: r.parentSessionId,
    });
    assert.equal(inboxOf(r.multitask, "some-other-dispatcher").length, 0);
  });

  it("refuses a caller that is not an owned worker", async () => {
    const r = await rig();
    const asDispatcher = await r.execute(
      { text: "not from a worker" },
      { sessionId: PARENT },
    );
    assert.equal(asDispatcher.ok, false);
    assert.match(asDispatcher.summary, /only available to workers/);
    assert.equal(inboxOf(r.multitask, r.parentSessionId).length, 0);

    const anonymous = await r.execute({ text: "no exec context" }, {});
    assert.equal(anonymous.ok, false);
    assert.equal(inboxOf(r.multitask, r.parentSessionId).length, 0);
  });
});

describe("ticket 122 — the reply is not the completion report", () => {
  it("does not settle the worker, complete the todo, or end its turn", async () => {
    const r = await rig({ todoId: "t-1" });
    const before = r.multitask.getWorker(r.workerId);
    assert.equal(before?.status, "running");

    const result = await r.execute({ text: "Halfway through.", status: "note" });
    assert.equal(result.ok, true);

    // Worker truth unchanged: no FSM transition, no settle, no wake.
    const after = r.multitask.getWorker(r.workerId);
    assert.equal(after?.status, "running");
    // The live todo stays open: the reply is not a delivery, so it cannot
    // complete the ledger entry.
    const todos = r.multitask.listTodos(r.parentSessionId);
    const linked = todos.find((todo) => todo.id === "t-1");
    assert.ok(linked);
    assert.notEqual(linked.status, "completed");
    assert.equal(linked.delivered, false);
    // The only wake the reply causes is the peer-lane wake.
    assert.deepEqual(r.host.wakeCalls, [r.parentSessionId]);
    const wake = r.multitask.wakeBus.drain(r.parentSessionId);
    assert.equal(wake?.source, "peer", "the reply rides the peer lane");
    assert.deepEqual(wake?.settledWorkers, [], "no completion notice");
    assert.equal(wake?.peerMessages?.[0]?.messageId, result.message_id);

    // The completion report is still owed and still arrives by settle.
    r.host.fireSettled({
      workerId: r.workerId,
      status: "completed",
      title: "Index the docs",
      resultText: "Done: indexed 42 docs.",
    });
    const settleWake = r.multitask.wakeBus.drain(r.parentSessionId);
    assert.equal(settleWake?.source, "worker-settled");
    assert.equal(settleWake?.settledWorkers.length, 1);
  });

  it("pins the two wake shapes the dispatcher distinguishes", () => {
    // A mid-task reply is a peer wake rendered under the not-from-the-user
    // heading. A completion report is a settled-workers wake. Neither
    // renderer accepts the other's input shape.
    const reply = assemblePeerWakeTurn([
      {
        messageId: "m-1",
        fromAgentId: "w-1",
        fromName: "worker reply (progress) — Index the docs",
        to: { kind: "agent", agentId: PARENT },
        conversationId: "direct",
        text: "halfway",
        priority: false,
        createdAtMs: 1,
        origin: { kind: "worker-reply", workerId: "w-1", status: "progress" },
      },
    ]);
    assert.ok(reply.startsWith(`# ${PEER_WAKE_SECTION_HEADINGS[0]}`));
    assert.ok(reply.includes("not from the user"));
    assert.ok(!reply.includes(WAKE_SECTION_HEADINGS[0]));
    assert.ok(reply.includes("worker reply (progress) — Index the docs"));
    assert.equal(
      isWorkerReply({
        messageId: "m-1",
        fromAgentId: "w-1",
        fromName: "x",
        to: { kind: "agent", agentId: PARENT },
        conversationId: "direct",
        text: "halfway",
        priority: false,
        createdAtMs: 1,
        origin: { kind: "worker-reply", workerId: "w-1" },
      }),
      true,
    );
  });
});

describe("ticket 122 — delivery lane (queue during a user turn)", () => {
  it("queues while the dispatcher's user turn is open and flushes at turn end", async () => {
    const r = await rig();
    r.multitask.wakeBus.noteTurnStarted(r.parentSessionId, "user");

    const result = await r.execute({ text: "Progress ping.", status: "progress" });
    assert.equal(result.ok, true);
    assert.equal(
      r.multitask.wakeBus.drain(r.parentSessionId),
      undefined,
      "a user-owned turn is never interrupted",
    );
    assert.deepEqual(r.host.interruptDispatcherCalls, []);

    r.multitask.wakeBus.noteTurnEnded(r.parentSessionId);
    const wake = r.multitask.wakeBus.drain(r.parentSessionId);
    assert.equal(wake?.source, "peer");
    assert.equal(wake?.peerMessages?.[0]?.text, "Progress ping.");
  });

  it("does not interrupt a running peer turn for a non-priority reply", async () => {
    const r = await rig();
    r.multitask.wakeBus.noteTurnStarted(r.parentSessionId, "peer");
    await r.execute({ text: "Still working.", status: "progress" });
    assert.equal(r.multitask.wakeBus.drain(r.parentSessionId), undefined);
    assert.deepEqual(r.host.interruptDispatcherCalls, []);
    assert.deepEqual(r.host.interruptCalls, []);
  });
});

describe("ticket 122 — bounds", () => {
  it("accepts text at the cap and refuses one character over, clearly", async () => {
    const r = await rig();
    const atCap = await r.execute({ text: "x".repeat(WORKER_REPLY_TEXT_MAX_CHARS) });
    assert.equal(atCap.ok, true);

    const over = await r.execute({
      text: "x".repeat(WORKER_REPLY_TEXT_MAX_CHARS + 1),
    });
    assert.equal(over.ok, false);
    assert.match(over.summary, /capped at 8000/);
    assert.match(over.summary, /shorten/i);
    // Nothing over-max was accepted into the inbox.
    const pending = inboxOf(r.multitask, r.parentSessionId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.text.length, WORKER_REPLY_TEXT_MAX_CHARS);
  });

  it("refuses empty text and unknown status words without accepting anything", async () => {
    const r = await rig();
    const empty = await r.execute({ text: "   " });
    assert.equal(empty.ok, false);
    assert.match(empty.summary, /non-empty/);

    const bad = await r.execute({ text: "hi", status: "done" });
    assert.equal(bad.ok, false);
    assert.match(bad.summary, /progress, blocked, note/);
    assert.equal(inboxOf(r.multitask, r.parentSessionId).length, 0);
  });

  it("rate-limits one worker to the declared budget per rolling window", async () => {
    let clock = 1_000_000;
    const r = await rig({ now: () => clock });
    for (let i = 0; i < WORKER_REPLY_RATE_LIMIT; i += 1) {
      const ok = await r.execute({ text: `update ${i}` });
      assert.equal(ok.ok, true, `reply ${i} should be accepted`);
    }
    const refused = await r.execute({ text: "one too many" });
    assert.equal(refused.ok, false);
    assert.match(refused.summary, /rate limit/);

    // A refusal does not count: still refused inside the same window...
    const stillRefused = await r.execute({ text: "still too many" });
    assert.equal(stillRefused.ok, false);

    // ...and the window rolls.
    clock += WORKER_REPLY_RATE_WINDOW_MS;
    const afterWindow = await r.execute({ text: "fresh window" });
    assert.equal(afterWindow.ok, true);

    // Only accepted replies reached the inbox.
    const pending = inboxOf(r.multitask, r.parentSessionId);
    assert.equal(pending.length, WORKER_REPLY_RATE_LIMIT + 1);
    assert.ok(pending.every((envelope) => envelope.text !== "one too many"));
  });
});

describe("ticket 122 — provenance is structured, not a text prefix", () => {
  it("survives inbox accept and wake mapping, and renders as not-from-the-user", async () => {
    const r = await rig({ title: "Audit auth" });
    await r.execute({ text: "two thirds done", status: "progress" });

    const wake = r.multitask.wakeBus.drain(r.parentSessionId);
    assert.equal(wake?.source, "peer");
    const notice = wake?.peerMessages?.[0];
    assert.ok(notice);
    assert.deepEqual(notice.origin, {
      kind: "worker-reply",
      workerId: r.workerId,
      status: "progress",
    });
    assert.equal(isWorkerReply(notice), true);

    const rendered = assemblePeerWakeTurn(wake?.peerMessages ?? []);
    assert.ok(rendered.includes("not from the user"));
    assert.ok(rendered.includes("worker reply (progress) — Audit auth"));
    assert.ok(!/\buser\b\s*:/i.test(rendered), "no user-message framing");
    // The rendered heading is presentation only; the decision fields are the
    // structured ones asserted above.
    assert.ok(rendered.includes("two thirds done"));
  });

  it("the inbox rejects an undeclared origin or status at the host edge", () => {
    const multitask = createMultitask(new FakeDshHost());
    const base: PeerEnvelope = {
      messageId: "m-1",
      fromAgentId: "w-1",
      fromName: "worker reply",
      to: { kind: "agent", agentId: PARENT },
      conversationId: "direct",
      text: "hi",
      priority: false,
      createdAtMs: 1,
    };

    const badKind = multitask.sendPeer(PARENT, {
      ...base,
      origin: { kind: "user" } as never,
    });
    assert.equal(badKind.ok, false);
    assert.ok(!badKind.ok);
    assert.equal(badKind.reason, "invalid-envelope");

    const badStatus = multitask.sendPeer(PARENT, {
      ...base,
      origin: {
        kind: "worker-reply",
        workerId: "w-1",
        status: "done",
      } as never,
    });
    assert.equal(badStatus.ok, false);
    assert.ok(!badStatus.ok);
    assert.equal(badStatus.reason, "invalid-envelope");
    assert.equal(multitask.listPendingPeers(PARENT).length, 0);
  });

  it("an ordinary dispatcher peer message carries no origin and is not a worker reply", async () => {
    const r = await rig();
    r.multitask.sendPeer(PARENT, {
      messageId: "peer-1",
      fromAgentId: "other-dispatcher",
      fromName: "other-dispatcher",
      to: { kind: "agent", agentId: PARENT },
      conversationId: "direct",
      text: "status?",
      priority: false,
      createdAtMs: 1,
    });
    const wake = r.multitask.wakeBus.drain(PARENT);
    const notice = wake?.peerMessages?.[0];
    assert.ok(notice);
    assert.equal(notice.origin, undefined);
    assert.equal(isWorkerReply(notice), false);
  });
});

describe("ticket 122 — worker-only surface, leader leaves", () => {
  it("is absent from the dispatcher tool surface", () => {
    const names = createDispatcherTools({
      multitask: { } as never,
      getSessionId: () => PARENT,
    }).map((def) => def.name);
    assert.ok(!names.includes(REPLY_TO_DISPATCHER_TOOL));
  });

  it("registers on a worker's scoped surface and nowhere else", async () => {
    const r = await rig();
    const registered: string[] = [];
    const surface = {
      register(definition: unknown) {
        const name = (definition as { name: string }).name;
        registered.push(name);
        return () => {};
      },
    };
    const disposers = registerWorkerLocalTools(surface, {
      multitask: r.multitask,
      resolveWorkerId: () => r.workerId,
    });
    assert.equal(disposers.length, 1);
    assert.deepEqual(registered, [REPLY_TO_DISPATCHER_TOOL]);
  });

  it("is not denied by the worker barrier (worker-only, not dispatcher-only)", () => {
    const known = new Set([
      REPLY_TO_DISPATCHER_TOOL,
      "spawn_worker",
      "read",
    ]);
    const filter = buildWorkerToolFilter(known);
    assert.ok(!filter.deny.includes(REPLY_TO_DISPATCHER_TOOL));
    assert.ok(filter.deny.includes("spawn_worker"));
  });

  it("has no recipient argument at all — no child-to-child path", async () => {
    const tool = createWorkerReplyTool({
      multitask: {} as never,
      resolveWorkerId: () => null,
    });
    assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).sort(), [
      "status",
      "text",
    ]);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual([...(tool.parameters.properties?.status?.enum ?? [])].sort(), [
      "blocked",
      "note",
      "progress",
    ]);
    // Closed status set: `done` would read as a completion signal.
    assert.ok(!(tool.parameters.properties?.status?.enum ?? []).includes("done"));

    // The registry-ready shape serializes to a provider-valid schema: the
    // authored `required: true` becomes the parent's required array.
    const schema = toRegisterableWorkerTool(tool).parameters as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    assert.deepEqual(schema.required, ["text"]);
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
      "status",
      "text",
    ]);
  });

  it("the worker contract names all three channels back", () => {
    const contract = buildWorkerSystemPrompt();
    assert.ok(
      contract.includes(
        "Your only channels back are your final answer, the mid-task reply described below, and, when a gated action needs one-time access, the access ask described below.",
      ),
      "the Limits sentence names final answer, reply, and access ask",
    );
    assert.ok(contract.includes("## Mid-task reply"));
    assert.ok(contract.includes(REPLY_TO_DISPATCHER_TOOL));
    assert.match(contract, /does not finish the task and does not end your turn/);
    assert.match(contract, /never the user, never another worker/);
  });
});
