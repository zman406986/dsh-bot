import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assembleActivityDigest,
  composeWakeText,
  WAKE_ACTIVITY_DIGEST_HEADING,
  WAKE_DIGEST_ACTIVITY_COUNT,
} from "../src/plugin.js";
import {
  createCordisDshHost,
  type AdapterContext,
  type AgentLike,
  type ContinuableStartSpecLike,
  type WorkerActivityEntry,
} from "../src/adapter/cordis-dsh-host.js";
import { bindDispatcherLifecycle } from "../src/adapter/parent-agent.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import type { WakeNotice } from "../src/core/policy/assembler.js";
import { CHECK_ACTIVITY_CHARS } from "../src/core/report-clamp.js";

/** One observed phrase with a controlled observation moment. */
function entry(phrase: string, atMs: number): WorkerActivityEntry {
  return { phrase, atMs };
}

function notice(workerId: string, title: string): WakeNotice {
  return {
    workerId,
    title,
    status: "completed",
    report: "",
    transcriptRef: workerId,
  };
}

describe("assembleActivityDigest (ticket 110)", () => {
  it("renders per-worker lines, newest-first, workers in notice order", () => {
    const digest = assembleActivityDigest(
      [notice("w1", "Title A"), notice("w2", "Title B")],
      (workerId, n) =>
        workerId === "w1"
          ? [
              entry("grep: third", 3),
              entry("sed: second", 2),
              entry("bash: first", 1),
            ].slice(0, n)
          : [entry("bash: first", 1)].slice(0, n),
    );
    assert.equal(
      digest,
      [
        WAKE_ACTIVITY_DIGEST_HEADING,
        "",
        "- w1 · grep: third",
        "- w1 · sed: second",
        "- w1 · bash: first",
        "- w2 · bash: first",
      ].join("\n"),
    );
  });

  it("asks the provider for at most WAKE_DIGEST_ACTIVITY_COUNT phrases", () => {
    const asked: number[] = [];
    const digest = assembleActivityDigest([notice("w1", "T")], (_workerId, n) => {
      asked.push(n);
      // Ring-shaped provider: slices to the requested n, newest-first.
      return [
        entry("p5", 5),
        entry("p4", 4),
        entry("p3", 3),
        entry("p2", 2),
        entry("p1", 1),
      ].slice(0, n);
    });
    assert.deepEqual(asked, [WAKE_DIGEST_ACTIVITY_COUNT]);
    // Only the newest 3 survive.
    const lines = digest.split("\n").filter((l) => l.startsWith("- "));
    assert.deepEqual(lines, ["- w1 · p5", "- w1 · p4", "- w1 · p3"]);
  });

  it("clamps every phrase through the core activity clamp", () => {
    const long = "x".repeat(CHECK_ACTIVITY_CHARS + 100);
    const digest = assembleActivityDigest(
      [notice("w1", "T")],
      () => [entry(long, 1)],
    );
    const line = digest.split("\n").find((l) => l.startsWith("- w1 · "));
    assert.ok(line);
    // Kept prefix + ellipsis, never the over-limit tail.
    assert.ok(line.endsWith("…"));
    assert.ok(line.includes("x".repeat(CHECK_ACTIVITY_CHARS)));
    assert.ok(!line.includes("x".repeat(CHECK_ACTIVITY_CHARS + 1)));
  });

  it("is empty when no referenced worker has observed activity", () => {
    assert.equal(
      assembleActivityDigest([notice("w1", "T"), notice("w2", "U")], () => []),
      "",
    );
  });
});

interface RecordedCall {
  [key: string]: unknown;
}

function createAgent(id: string): AgentLike {
  return {
    session: {
      id,
      header: { parentSession: undefined, delegationDepth: 0 },
    },
    followup() {},
  };
}

/** Minimal stub ctx — the same firehose-driving shape the adapter tests use. */
function createStubCtx() {
  const followupCalls: unknown[] = [];
  const listeners = new Map<string, Array<(payload: never) => void>>();
  let nextChild = 1;

  const agents = new Map<string, AgentLike>();

  const ctx: AdapterContext & {
    fire(name: string, ...payloads: unknown[]): void;
    followupCalls: unknown[];
    bindAgent(agent: AgentLike): void;
  } = {
    followupCalls,
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
      async startContinuable(spec: ContinuableStartSpecLike) {
        void spec;
        const childId = `child-${nextChild++}`;
        return { childId, messageId: `msg-${childId}` };
      },
      interrupt() {},
      async sendMessage() {
        return "mid";
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
      list() {
        return [];
      },
    },
    storageDomain: {
      async open() {
        throw new Error("not used in these tests");
      },
    },
  };

  return ctx;
}

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
      arguments: JSON.stringify(args),
    },
  };
}

/**
 * Wire the host EXACTLY as plugin.ts apply() does — composeWakeText closed
 * over the multitask ref and the host's own recentActivities — then drive a
 * full spawn → activity → settle → idle cycle. Returns the followup text the
 * dispatcher would receive, plus the spawned worker id.
 */
async function driveSettleAndWake(
  toolCalls: Array<{ name: string; args: unknown }>,
): Promise<{ text: string; workerId: string }> {
  const ctx = createStubCtx();
  // Mirrors plugin.ts: the closure reads `multitaskRef`/`host` before their
  // initialization completes syntactically, but only ever RUNS at wake time.
  let multitaskRef: Multitask | null = null;
  const host = createCordisDshHost(ctx, {
    composeWakeText: (sessionId) => {
      if (multitaskRef === null) return null;
      return composeWakeText(
        multitaskRef,
        sessionId,
        () => false,
        (workerId, n) => host.recentActivities(workerId, n),
      );
    },
  });
  const multitask = createMultitask(host);
  multitaskRef = multitask;
  const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);

  const parent = createAgent("disp-1");
  // requestDispatcherWakeup resolves the Agent through ctx.agents.
  ctx.bindAgent(parent);
  assert.deepEqual(lifecycle.activate(parent), { ok: true });

  const spawn = await multitask.spawnWorker({
    parentSessionId: "disp-1",
    streamKey: "s1",
    title: "T",
    prompt: "go",
  });
  assert.ok(spawn.ok);
  if (!spawn.ok) throw new Error("unreachable");
  const workerId = spawn.workerId;

  ctx.fire("agent/status", {
    agent: { session: { id: workerId }, followup() {} },
    status: "running",
  });
  ctx.fire("agent/status", { agent: parent, status: "running" });

  for (const call of toolCalls) {
    fireSessionEvent(ctx, workerId, toolCallEvent(call.name, call.args));
  }

  ctx.fire("subagent/end", {
    id: workerId,
    stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "ok" }],
  });
  // Mid-turn the wake is queued; going idle flushes it. The core wake bus
  // delivers through `host.requestDispatcherWakeup` itself (multitask.ts
  // `onDeliver`), which runs synchronously up to the `followup` call —
  // this captures the exact shipped settle → followup path.
  ctx.fire("agent/status", { agent: parent, status: "idle" });
  // One macrotask tick: defensive against any async wrapper in delivery.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.followupCalls.length, 1);
  const msg = ctx.followupCalls[0] as {
    role: string;
    content: Array<{ text: string }>;
  };
  const text = msg.content.map((b) => b.text).join("\n");
  lifecycle.unbind();
  return { text, workerId };
}

describe("wake digest over the adapter path (ticket 110)", () => {
  it("wake followup carries the recent-activity digest, newest-first and clamped", async () => {
    // The host clamps phrases at observation (hint capped at
    // ACTIVITY_HINT_CHARS), so an over-limit phrase needs a long tool NAME;
    // the digest line must still land at the core activity clamp exactly.
    const longName = "x".repeat(CHECK_ACTIVITY_CHARS + 50);
    const { text, workerId } = await driveSettleAndWake([
      { name: longName, args: {} },
      { name: "sed", args: { script: "second" } },
      { name: "grep", args: { pattern: "third" } },
    ]);

    assert.ok(text.includes("Background work landed"));
    assert.ok(text.includes(WAKE_ACTIVITY_DIGEST_HEADING));

    const digest = text.slice(text.indexOf(WAKE_ACTIVITY_DIGEST_HEADING));
    const lines = digest.split("\n").filter((l) => l.startsWith("- "));
    // Newest-first per worker; the over-limit phrase is clamped inline.
    assert.deepEqual(lines, [
      `- ${workerId} · grep: third`,
      `- ${workerId} · sed: second`,
      `- ${workerId} · ${"x".repeat(CHECK_ACTIVITY_CHARS)}…`,
    ]);
  });

  it("wake followup omits the digest when no activity was observed (honest amnesia)", async () => {
    const { text } = await driveSettleAndWake([]);
    assert.ok(text.includes("Background work landed"));
    assert.ok(!text.includes("Recent worker activity"));
  });
});
