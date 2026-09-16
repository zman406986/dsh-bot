import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  DEFAULT_ACCESS_TIMEOUT_MS,
  createAccessPolicyTable,
  createAccessRelay,
  matchTargetPattern,
  wrapAccessDecision,
} from "../src/core/access-relay.js";
import type {
  AccessDecision,
  AccessRequestBody,
  AccessRequestEvent,
} from "../src/core/access-types.js";
import type { SpawnResult } from "../src/core/types.js";
import { createWakeBus, type WakeEvent } from "../src/core/wake-bus.js";
import { assembleAccessSection } from "../src/core/policy/assembler.js";
import {
  createRequestAccessHandler,
  toAccessRequestBody,
} from "../src/adapter/worker-access-tool.js";

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

async function spawnRunning(
  multitask: Multitask,
  parentSessionId: string,
  streamKey: string,
  title: string,
  credentialNames?: readonly string[],
): Promise<string> {
  const workerId = unwrapSpawn(
    await multitask.spawnWorker({
      parentSessionId,
      streamKey,
      title,
      prompt: "Do the work.",
      ...(credentialNames !== undefined ? { credentialNames } : {}),
    }),
  );
  multitask.noteTurnStarted(workerId);
  return workerId;
}

interface ManualScheduler {
  readonly scheduled: Array<{ fn: () => void; ms: number }>;
  readonly cancelled: number[];
  schedule(fn: () => void, ms: number): () => void;
  runAll(): void;
  runAt(index: number): void;
}

function createManualScheduler(): ManualScheduler {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const cancelled: number[] = [];
  return {
    scheduled,
    cancelled,
    schedule(fn, ms) {
      const index = scheduled.length;
      scheduled.push({ fn, ms });
      return () => {
        cancelled.push(index);
      };
    },
    runAll() {
      for (const entry of [...scheduled]) entry.fn();
    },
    runAt(index: number) {
      const entry = scheduled[index];
      assert.ok(entry, `no scheduled fn at ${index}`);
      entry.fn();
    },
  };
}

function body(overrides: Partial<AccessRequestBody> = {}): AccessRequestBody {
  return {
    class: "tool",
    target: "write_file",
    reason: "need to write outside workspace",
    ...overrides,
  };
}

function accessEvent(
  workerId: string,
  overrides: Partial<AccessRequestEvent> = {},
): AccessRequestEvent {
  return {
    workerId,
    requestId: `req-${workerId}`,
    body: body(),
    createdAtMs: 1_000,
    ...overrides,
  };
}

describe("access relay — T1 ask wakes dispatcher", () => {
  it("fireAccessRequest on a live worker wakes the parent and parks one ticket", async () => {
    const host = new FakeDshHost();
    // Explicit short timeout + manual scheduler: this test parks the ticket
    // forever, so no real 120 s default timer may stay armed past the test.
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      access: { timeoutMs: 50, schedule: scheduler.schedule },
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Write docs");

    host.fireAccessRequest(accessEvent(workerId));

    assert.equal(scheduler.scheduled.length, 1);
    assert.deepEqual(host.wakeCalls, ["session-1"]);
    const pending = multitask.listPendingAccess("session-1");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.workerId, workerId);
    assert.equal(pending[0]?.body.target, "write_file");

    const wake = multitask.wakeBus.drain("session-1");
    assert.ok(wake);
    assert.equal(wake.source, "worker-access-request");
    assert.equal(wake.accessRequests?.length, 1);
    assert.equal(wake.accessRequests?.[0]?.body.class, "tool");
  });
});

describe("access relay — T2 allow steers answer back", () => {
  it("resolve(allow) delivers a continue wrapper via sendMessage and resolves the ticket", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Write docs");

    host.fireAccessRequest(accessEvent(workerId));
    assert.equal(host.sendMessageCalls.length, 0);

    const ok = multitask.resolveAccess(workerId, { kind: "allow" });
    assert.equal(ok, true);
    assert.equal(host.sendMessageCalls.length, 1);
    const sent = host.sendMessageCalls[0];
    assert.ok(sent);
    assert.equal(sent.workerId, workerId);
    assert.ok(sent.message.includes("allowed"));
    assert.ok(sent.message.toLowerCase().includes("continue"));
    assert.ok(sent.message.toLowerCase().includes("do not restart"));
    assert.equal(multitask.listPendingAccess("session-1").length, 0);
  });
});

describe("access relay — T3 user deny is honest", () => {
  it("deny wrapper names the target and reason; never a bare empty message", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Write docs");

    host.fireAccessRequest(accessEvent(workerId));
    const ok = multitask.resolveAccess(workerId, {
      kind: "deny",
      reason: "user-denied",
      detail: "user said no",
    });
    assert.equal(ok, true);
    const sent = host.sendMessageCalls[0];
    assert.ok(sent);
    assert.ok(sent.message.length > 0);
    assert.ok(sent.message.includes("write_file"));
    assert.ok(sent.message.includes("user-denied") || sent.message.includes("denied by the user"));
    assert.ok(sent.message.includes("Do not retry"));
  });
});

describe("access relay — T4 unanswered timeout", () => {
  it("never-resolved ask auto-denies after timeoutMs; notice available for wake", async () => {
    const host = new FakeDshHost();
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      access: { timeoutMs: 50, schedule: scheduler.schedule },
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Long ask");

    host.fireAccessRequest(accessEvent(workerId));
    assert.equal(scheduler.scheduled.length, 1);
    assert.equal(scheduler.scheduled[0]?.ms, 50);
    // Never resolve — run the timeout.
    scheduler.runAll();

    assert.equal(host.sendMessageCalls.length, 1);
    const sent = host.sendMessageCalls[0];
    assert.ok(sent);
    assert.ok(sent.message.includes("timeout") || sent.message.includes("timed out"));
    assert.equal(multitask.listPendingAccess("session-1").length, 0);

    const wake = multitask.wakeBus.drain("session-1");
    assert.ok(wake);
    const notices = wake.accessNotices ?? [];
    assert.ok(notices.length >= 1);
    assert.equal(notices[0]?.decision.kind, "deny");
    if (notices[0]?.decision.kind === "deny") {
      assert.equal(notices[0].decision.reason, "timeout");
    }
  });
});

describe("access relay — deny delivery to an unbound parent never rejects", () => {
  it("timeout deny with a throwing sendMessage produces no unhandled rejection", async () => {
    const host = new FakeDshHost();
    // Parent unbound: the real adapter throws from sendMessage
    // (cordis-dsh-host: "no parent agent bound; cannot send").
    host.sendMessage = async () => {
      throw new Error("CordisDshHost: no parent agent bound; cannot send");
    };
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      access: { timeoutMs: 50, schedule: scheduler.schedule },
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Unbound ask");

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      host.fireAccessRequest(accessEvent(workerId));
      // Never resolve — the timeout deny fires into the unbound parent.
      scheduler.runAll();
      // Let the discarded delivery promise settle before judging.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    assert.equal(rejections.length, 0);
    assert.equal(multitask.listPendingAccess("session-1").length, 0);
  });
});

describe("access relay — T5 timeout cancelled on early answer", () => {
  it("resolve before the timer runs cancels the schedule; late timer is a no-op", async () => {
    const host = new FakeDshHost();
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      access: { timeoutMs: 50, schedule: scheduler.schedule },
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Quick ask");

    host.fireAccessRequest(accessEvent(workerId));
    const ok = multitask.resolveAccess(workerId, { kind: "allow" });
    assert.equal(ok, true);
    assert.deepEqual(scheduler.cancelled, [0]);

    const sendsBefore = host.sendMessageCalls.length;
    scheduler.runAll();
    // Late timer is a no-op — no second sendMessage.
    assert.equal(host.sendMessageCalls.length, sendsBefore);
  });
});

describe("access relay — T6 abort clears pending", () => {
  it("abortWorker drops the ticket; later timer/resolve are no-ops with no sendMessage", async () => {
    const host = new FakeDshHost();
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      access: { timeoutMs: 50, schedule: scheduler.schedule },
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Stopped ask");

    host.fireAccessRequest(accessEvent(workerId));
    assert.equal(multitask.listPendingAccess("session-1").length, 1);

    const stop = await multitask.abortWorker(workerId);
    assert.ok(stop.ok);
    assert.equal(multitask.listPendingAccess("session-1").length, 0);
    assert.deepEqual(scheduler.cancelled, [0]);

    scheduler.runAll();
    const late = multitask.resolveAccess(workerId, { kind: "allow" });
    assert.equal(late, false);
    assert.equal(host.sendMessageCalls.length, 0);
  });
});

describe("access relay — T7 one outstanding ask per worker", () => {
  it("a second fireAccessRequest while pending is ignored; still one ticket", async () => {
    const host = new FakeDshHost();
    // Same hygiene as T1: parked ticket, manual scheduler — no real 120 s timer.
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      access: { timeoutMs: 50, schedule: scheduler.schedule },
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Double ask");

    host.fireAccessRequest(accessEvent(workerId, { requestId: "req-1" }));
    host.fireAccessRequest(
      accessEvent(workerId, {
        requestId: "req-2",
        body: body({ target: "network_fetch", class: "network" }),
      }),
    );

    assert.equal(multitask.listPendingAccess("session-1").length, 1);
    assert.equal(multitask.listPendingAccess("session-1")[0]?.requestId, "req-1");
  });
});

describe("access relay — T8 stored policy allow", () => {
  it("policy allow auto-answers without a user-ask wake", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    multitask.accessPolicy.set({
      class: "tool",
      targetPattern: "read_file",
      decision: "allow",
      scope: "session",
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Policy allow");

    host.fireAccessRequest(
      accessEvent(workerId, {
        body: body({ target: "read_file", reason: "read a file" }),
      }),
    );

    // Auto-allow: no pending ticket; allow steer sent; no access wake required.
    assert.equal(multitask.listPendingAccess("session-1").length, 0);
    assert.equal(host.sendMessageCalls.length, 1);
    assert.ok(host.sendMessageCalls[0]?.message.includes("allowed"));
    // No wake solely for the ask (policy answered immediately).
    const wake = multitask.wakeBus.peek("session-1");
    assert.equal(wake?.accessRequests?.length ?? 0, 0);
  });
});

describe("access relay — T9 stored policy deny", () => {
  it("policy deny steers a deny, does not hang, and surfaces an honest notice", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    multitask.accessPolicy.set({
      class: "network",
      targetPattern: "*",
      decision: "deny",
      scope: "profile",
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Policy deny");

    host.fireAccessRequest(
      accessEvent(workerId, {
        body: body({ class: "network", target: "example.com", reason: "fetch API" }),
      }),
    );

    assert.equal(multitask.listPendingAccess("session-1").length, 0);
    assert.equal(host.sendMessageCalls.length, 1);
    const sent = host.sendMessageCalls[0];
    assert.ok(sent);
    assert.ok(sent.message.includes("example.com"));
    assert.ok(sent.message.includes("denied"));

    const wake = multitask.wakeBus.drain("session-1");
    assert.ok(wake);
    const notices = wake.accessNotices ?? [];
    assert.ok(notices.length >= 1);
    assert.equal(notices[0]?.decision.kind, "deny");
  });
});

describe("access relay — T10 unknown class → ask", () => {
  it("lookupPolicy ask parks a ticket and wakes; default deny only after timeout", async () => {
    const host = new FakeDshHost();
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      access: { timeoutMs: 10, schedule: scheduler.schedule },
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Ask class");

    host.fireAccessRequest(
      accessEvent(workerId, {
        body: body({ class: "other", target: "mystery", reason: "unknown gate" }),
      }),
    );

    assert.equal(multitask.listPendingAccess("session-1").length, 1);
    assert.equal(host.sendMessageCalls.length, 0);
    assert.deepEqual(host.wakeCalls, ["session-1"]);

    // Default deny only after the timeout.
    scheduler.runAll();
    assert.equal(host.sendMessageCalls.length, 1);
    assert.ok(host.sendMessageCalls[0]?.message.includes("timeout") || host.sendMessageCalls[0]?.message.includes("timed out"));
  });
});

describe("access relay — T11 credential name never in prompt", () => {
  it("spawn with credentialNames does not put the name/value into the prompt", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(
      multitask,
      "session-1",
      "todo-1",
      "Cred worker",
      ["API_TOKEN"],
    );

    const spawn = host.spawnCalls[0];
    assert.ok(spawn);
    assert.deepEqual(spawn.opts.credentialNames, ["API_TOKEN"]);
    // The prompt is the task text only — never a secret value or the name as a secret.
    assert.ok(!spawn.prompt.includes("API_TOKEN"));
    assert.ok(!spawn.prompt.includes("secret-value"));

    // Credential ask: name only.
    host.fireAccessRequest(
      accessEvent(workerId, {
        body: {
          class: "credential",
          target: "API_TOKEN",
          reason: "need the API token",
          credentialName: "API_TOKEN",
        },
      }),
    );
    multitask.resolveAccess(workerId, {
      kind: "allow",
      note: "credential API_TOKEN is now available to your tools",
    });
    const sent = host.sendMessageCalls[0];
    assert.ok(sent);
    // Name may appear; a secret value must not.
    assert.ok(sent.message.includes("API_TOKEN"));
    assert.ok(!sent.message.includes("secret-value"));
    // Decision shape has no value field.
    const decision: AccessDecision = { kind: "allow" };
    assert.ok(!("value" in decision));
  });
});

describe("access relay — T12 credential value never steered", () => {
  it("AccessDecision has no value field; allow note may carry the name only", () => {
    const allow: AccessDecision = {
      kind: "allow",
      note: "credential API_TOKEN is now available to your tools",
    };
    assert.ok(!("value" in allow));
    const deny: AccessDecision = {
      kind: "deny",
      reason: "policy-denied",
      detail: "policy denied credential API_TOKEN",
    };
    assert.ok(!("value" in deny));
    const wrapped = wrapAccessDecision(allow, {
      class: "credential",
      target: "API_TOKEN",
      reason: "need it",
    });
    assert.ok(wrapped.includes("API_TOKEN"));
    assert.ok(!wrapped.includes("sk-"));
  });
});

describe("access relay — T13 settle drops late resolve", () => {
  it("fireSettled then resolve is false with no sendMessage", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Settled ask");

    host.fireAccessRequest(accessEvent(workerId));
    assert.equal(multitask.listPendingAccess("session-1").length, 1);

    host.fireSettled({ workerId, status: "completed", report: "done" });
    assert.equal(multitask.listPendingAccess("session-1").length, 0);

    const late = multitask.resolveAccess(workerId, { kind: "allow" });
    assert.equal(late, false);
    assert.equal(host.sendMessageCalls.length, 0);
  });
});

describe("access relay — T14 wake batching", () => {
  it("two asks from different workers on the same parent flush as one WakeEvent", async () => {
    const host = new FakeDshHost();
    // Same hygiene as T1: two parked tickets, manual scheduler — no real 120 s timers.
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      access: { timeoutMs: 50, schedule: scheduler.schedule },
    });
    const w1 = await spawnRunning(multitask, "session-1", "todo-1", "Worker A");
    const w2 = await spawnRunning(multitask, "session-1", "todo-2", "Worker B");

    host.fireAccessRequest(accessEvent(w1, { requestId: "req-a" }));
    host.fireAccessRequest(
      accessEvent(w2, {
        requestId: "req-b",
        body: body({ target: "network_fetch", class: "network" }),
      }),
    );

    // Idle parent: first ask flushes immediately; second joins the ready batch.
    const wake = multitask.wakeBus.drain("session-1");
    assert.ok(wake);
    assert.equal(wake.accessRequests?.length, 2);
    assert.equal(multitask.listPendingAccess("session-1").length, 2);
  });
});

describe("access relay — default timeout arms the shipped 120 s", () => {
  it("createMultitask without timeoutMs arms DEFAULT_ACCESS_TIMEOUT_MS — asserted, never waited", async () => {
    const host = new FakeDshHost();
    const scheduler = createManualScheduler();
    const multitask = createMultitask(host, {
      access: { schedule: scheduler.schedule },
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "Default ask");

    host.fireAccessRequest(accessEvent(workerId));

    assert.equal(scheduler.scheduled.length, 1);
    assert.equal(scheduler.scheduled[0]?.ms, DEFAULT_ACCESS_TIMEOUT_MS);
  });
});

describe("access policy table", () => {
  it("matchTargetPattern supports *, exact, and trailing prefix", () => {
    assert.equal(matchTargetPattern("*", "anything"), true);
    assert.equal(matchTargetPattern("write_file", "write_file"), true);
    assert.equal(matchTargetPattern("write_file", "write_files"), false);
    assert.equal(matchTargetPattern("write_*", "write_file"), true);
    assert.equal(matchTargetPattern("read_*", "write_file"), false);
  });

  it("session rows win over profile rows; no hit → ask", () => {
    const table = createAccessPolicyTable([
      { class: "tool", targetPattern: "*", decision: "deny", scope: "profile" },
      { class: "tool", targetPattern: "safe_tool", decision: "allow", scope: "session" },
    ]);
    const ctx = { parentSessionId: "session-1" };
    const ask = table.lookup(body({ target: "unknown_tool" }), ctx);
    // Profile deny hits unknown_tool.
    assert.ok(typeof ask !== "string" && ask.kind === "deny");
    const allow = table.lookup(body({ target: "safe_tool" }), ctx);
    assert.ok(typeof allow !== "string" && allow.kind === "allow");
  });

  it("empty table always asks", () => {
    const table = createAccessPolicyTable();
    assert.equal(table.lookup(body(), { parentSessionId: "s" }), "ask");
  });
});

describe("access assembler section", () => {
  it("empty inputs → empty string; denials name the action", () => {
    assert.equal(assembleAccessSection([], []), "");
    const text = assembleAccessSection(
      [
        {
          workerId: "w1",
          requestId: "r1",
          title: "Write docs",
          body: body(),
        },
      ],
      [
        {
          kind: "access-resolved",
          workerId: "w1",
          title: "Write docs",
          decision: {
            kind: "deny",
            reason: "timeout",
            detail: "stopped waiting for an answer",
          },
          body: body(),
        },
      ],
    );
    assert.ok(text.includes("## Access requests"));
    assert.ok(text.includes("write_file"));
    assert.ok(text.includes("timeout"));
    assert.ok(text.includes("Pending asks"));
    assert.ok(text.includes("Resolved"));
  });
});

describe("worker request_access tool handler", () => {
  it("emits a structured event for a known worker and refuses a second concurrent ask", async () => {
    const emitted: AccessRequestEvent[] = [];
    let pending = false;
    const execute = createRequestAccessHandler({
      resolveWorkerId: (exec) => {
        const record = exec as { sessionId?: unknown } | null | undefined;
        return record?.sessionId != null ? String(record.sessionId) : null;
      },
      hasPendingAsk: () => pending,
      emit: (event) => {
        emitted.push(event);
        pending = true;
      },
      newRequestId: () => "fixed-id",
      now: () => 42,
    });

    const first = await execute(
      {
        class: "tool",
        target: "write_file",
        reason: "need write",
      },
      { sessionId: "child-1" },
    );
    assert.equal(first.ok, true);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.workerId, "child-1");
    assert.equal(emitted[0]?.requestId, "fixed-id");
    assert.equal(emitted[0]?.createdAtMs, 42);

    const second = await execute(
      { class: "tool", target: "write_file", reason: "again" },
      { sessionId: "child-1" },
    );
    assert.equal(second.ok, false);
    assert.ok(second.summary.includes("Already waiting"));
    assert.equal(emitted.length, 1);
  });

  it("refuses when the caller is not a worker", async () => {
    const execute = createRequestAccessHandler({
      resolveWorkerId: () => null,
      hasPendingAsk: () => false,
      emit: () => {
        assert.fail("must not emit for non-worker");
      },
    });
    const result = await execute(
      { class: "tool", target: "x", reason: "y" },
      {},
    );
    assert.equal(result.ok, false);
  });

  it("toAccessRequestBody validates class/target/reason and accepts credential_name", () => {
    const req = toAccessRequestBody({
      class: "credential",
      target: "API_TOKEN",
      reason: "need it",
      credential_name: "API_TOKEN",
    });
    assert.equal(req.class, "credential");
    assert.equal(req.credentialName, "API_TOKEN");
    assert.throws(() => toAccessRequestBody({ class: "nope", target: "t", reason: "r" }));
    assert.throws(() => toAccessRequestBody({ class: "tool", target: "", reason: "r" }));
  });
});

describe("access relay — standalone unit (no multitask)", () => {
  it("noteRequest with policy allow delivers immediately and never parks", () => {
    const delivered: Array<{ workerId: string; message: string }> = [];
    const wakes: string[] = [];
    const relay = createAccessRelay({
      timeoutMs: 10,
      lookupPolicy: () => ({ kind: "allow" }),
      deliver: (workerId, message) => {
        delivered.push({ workerId, message });
      },
      wakeForAsk: (n) => wakes.push(n.workerId),
      onResolved: () => {},
    });

    relay.noteRequest(accessEvent("w1"), "session-1");
    assert.equal(delivered.length, 1);
    assert.equal(relay.listPending().length, 0);
    assert.equal(wakes.length, 0);
  });

  it("clear cancels the timeout without delivering", () => {
    const scheduler = createManualScheduler();
    const delivered: string[] = [];
    const relay = createAccessRelay({
      timeoutMs: 10,
      schedule: scheduler.schedule,
      lookupPolicy: () => "ask",
      deliver: (_id, message) => {
        delivered.push(message);
      },
      wakeForAsk: () => {},
      onResolved: () => {},
    });

    relay.noteRequest(accessEvent("w1"), "session-1");
    relay.clear("w1");
    assert.deepEqual(scheduler.cancelled, [0]);
    scheduler.runAll();
    assert.equal(delivered.length, 0);
    assert.equal(relay.resolve("w1", { kind: "allow" }), false);
  });
});

describe("wake bus — access enqueue (bus-level)", () => {
  it("enqueueAccessRequest on an idle session flushes one wake", () => {
    const ids: string[] = [];
    const bus = createWakeBus({ onDeliver: (id) => ids.push(id) });
    bus.enqueueAccessRequest({
      parentSessionId: "s1",
      workerId: "w1",
      requestId: "r1",
      title: "T",
      body: body(),
    });
    assert.deepEqual(ids, ["s1"]);
    const wake: WakeEvent | undefined = bus.drain("s1");
    assert.ok(wake);
    assert.equal(wake.source, "worker-access-request");
    assert.equal(wake.accessRequests?.length, 1);
  });
});
