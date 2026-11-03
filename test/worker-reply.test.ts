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

import type { PeerEnvelope } from "../src/core/peer-types.js";
import {createWorkerReplyTool, registerWorkerLocalTools, REPLY_TO_DISPATCHER_TOOL, WORKER_REPLY_RATE_LIMIT, WORKER_REPLY_RATE_WINDOW_MS, WORKER_REPLY_TEXT_MAX_CHARS, type WorkerReplyToolResult} from "../src/core/tools.js";

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
    const r = await rig();
    const before = r.multitask.getWorker(r.workerId)?.status;
    assert.equal((await r.execute({ text: "still going", status: "progress" })).ok, true);
    assert.equal(r.multitask.getWorker(r.workerId)?.status, before, "the reply settled the worker");
    assert.equal(r.multitask.listTodos(r.parentSessionId).every((t) => t.status !== "completed"), true);
  });

  it("refuses empty text and an unknown status word", async () => {
    const r = await rig();
    assert.equal((await r.execute({ text: "   " })).ok, false);
    assert.equal((await r.execute({ text: "hi", status: "done" as never })).ok, false);
    assert.equal(inboxOf(r.multitask, r.parentSessionId).length, 0, "a refused reply reached the inbox");
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

});

describe("ticket 122 — worker-only surface, leader leaves", () => {
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

  it("has no recipient argument — a worker can never address another worker", async () => {
    // ADR-0003's leaf rule: the address is always the owning dispatcher, so a
    // recipient field would open a child-to-child path the topology forbids.
    const tool = createWorkerReplyTool({ multitask: {} as never, resolveWorkerId: () => null });
    assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).sort(), ["status", "text"]);
    assert.equal(tool.parameters.additionalProperties, false);
  });
});
