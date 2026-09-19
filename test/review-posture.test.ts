import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  createReviewPostureTable,
  reviewPostureDenyDetail,
} from "../src/core/review-posture.js";
import {
  createDispatcherTools,
  type DispatcherToolDef,
  type DispatchApprovalOutcome,
  type DispatchApprovalFn,
} from "../src/core/tools.js";
import { SPAWN_WORKER_TOOL } from "../src/core/policy/prompts.js";
import type { SpawnWorkerToolResult } from "../src/core/tool-results.js";
import type {
  AccessRequestBody,
  AccessRequestEvent,
} from "../src/core/access-types.js";
import type { SpawnResult } from "../src/core/types.js";

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

interface ManualScheduler {
  readonly scheduled: Array<{ fn: () => void; ms: number }>;
  readonly cancelled: number[];
  schedule(fn: () => void, ms: number): () => void;
  runAll(): void;
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
  };
}

/** Host + core with a manual scheduler so no real 120 s timer is ever armed. */
async function setupCore(): Promise<{
  host: FakeDshHost;
  multitask: Multitask;
  scheduler: ManualScheduler;
}> {
  const host = new FakeDshHost();
  const scheduler = createManualScheduler();
  const multitask = createMultitask(host, {
    access: { timeoutMs: 50, schedule: scheduler.schedule },
  });
  return { host, multitask, scheduler };
}

async function spawnRunning(
  multitask: Multitask,
  parentSessionId: string,
  streamKey: string,
  title: string,
): Promise<string> {
  const result: SpawnResult = await multitask.spawnWorker({
    parentSessionId,
    streamKey,
    title,
    prompt: "Do the work.",
  });
  assert.ok(result.ok, result.ok ? "" : result.detail);
  multitask.noteTurnStarted(result.workerId);
  return result.workerId;
}

describe("review posture — table unit", () => {
  it("empty posture always asks (shipped posture is EMPTY)", () => {
    const table = createReviewPostureTable();
    assert.equal(table.lookup(body(), { parentSessionId: "s-1" }), "ask");
    assert.equal(
      table.lookupDispatch("Any title", { parentSessionId: "s-1" }),
      undefined,
    );
    assert.equal(table.list().length, 0);
  });

  it("posture allow/deny answers on a miss; miss returns ask", () => {
    const table = createReviewPostureTable();
    assert.equal(
      table.set({
        class: "tool",
        targetPattern: "write_file",
        decision: "allow",
        scope: "session",
        session: "s-1",
      }),
      true,
    );
    const allowed = table.lookup(body(), { parentSessionId: "s-1" });
    assert.ok(typeof allowed !== "string" && allowed.kind === "allow");

    assert.equal(
      table.set({
        class: "network",
        targetPattern: "example.com",
        decision: "deny",
        scope: "session",
        session: "s-1",
      }),
      true,
    );
    const denied = table.lookup(
      body({ class: "network", target: "example.com" }),
      { parentSessionId: "s-1" },
    );
    assert.ok(typeof denied !== "string" && denied.kind === "deny");
    if (denied.kind !== "deny") return;
    // Self-naming deny detail (design §2): reason is policy-denied, the
    // detail names the auto-review posture.
    assert.equal(denied.reason, "policy-denied");
    assert.equal(denied.detail, reviewPostureDenyDetail("network", "example.com"));
    assert.ok(denied.detail.includes("auto-review posture"));
    assert.ok(denied.detail.includes("example.com"));

    // No row for this target → ask.
    assert.equal(
      table.lookup(body({ target: "other_tool" }), { parentSessionId: "s-1" }),
      "ask",
    );
  });

  it("access-ask lookup is never answered by a dispatch row (and vice versa)", () => {
    const table = createReviewPostureTable();
    table.set({
      class: "worker-dispatch",
      targetPattern: "Summarize RFCs",
      decision: "deny",
      scope: "session",
      session: "s-1",
    });
    const ctx = { parentSessionId: "s-1" };
    assert.equal(table.lookup(body({ target: "Summarize RFCs" }), ctx), "ask");
    assert.equal(table.lookupDispatch("write_file", ctx), undefined);
    assert.ok(table.lookupDispatch("Summarize RFCs", ctx) !== undefined);
  });

  it("wildcard fence: set refuses *-bearing targets, bare and prefix (A5)", () => {
    const table = createReviewPostureTable();
    for (const pattern of ["*", "write_*", "w*e"]) {
      assert.equal(
        table.set({
          class: "tool",
          targetPattern: pattern,
          decision: "allow",
          scope: "session",
          session: "s-1",
        }),
        false,
        `pattern ${pattern} must be refused`,
      );
    }
    assert.equal(table.list().length, 0);
    assert.equal(table.lookup(body(), { parentSessionId: "s-1" }), "ask");
  });

  it("attributed rows answer only their own session; un-owned rows apply to any (ADR-0019)", () => {
    const table = createReviewPostureTable();
    table.set({
      class: "tool",
      targetPattern: "write_file",
      decision: "allow",
      scope: "session",
      session: "s-1",
    });
    const owner = table.lookup(body(), { parentSessionId: "s-1" });
    assert.ok(typeof owner !== "string" && owner.kind === "allow");
    assert.equal(table.lookup(body(), { parentSessionId: "s-2" }), "ask");

    const legacy = createReviewPostureTable();
    legacy.set({
      class: "tool",
      targetPattern: "write_file",
      decision: "allow",
      scope: "session",
    });
    const anySession = legacy.lookup(body(), { parentSessionId: "s-9" });
    assert.ok(typeof anySession !== "string" && anySession.kind === "allow");
  });

  it("two sessions may hold the same class+pattern without evicting each other", () => {
    const table = createReviewPostureTable();
    for (const session of ["s-1", "s-2"]) {
      assert.equal(
        table.set({
          class: "tool",
          targetPattern: "write_file",
          decision: "allow",
          scope: "session",
          session,
        }),
        true,
      );
    }
    assert.equal(table.list().length, 2);
    for (const session of ["s-1", "s-2"]) {
      const hit = table.lookup(body(), { parentSessionId: session });
      assert.ok(typeof hit !== "string" && hit.kind === "allow");
    }
  });

  it("clearSession(id) drops only that session's rows; profile rows survive; no id clears all session rows", () => {
    const table = createReviewPostureTable();
    table.set({
      class: "tool",
      targetPattern: "write_file",
      decision: "allow",
      scope: "session",
      session: "s-1",
    });
    table.set({
      class: "tool",
      targetPattern: "write_file",
      decision: "allow",
      scope: "session",
      session: "s-2",
    });
    table.set({
      class: "network",
      targetPattern: "example.com",
      decision: "deny",
      scope: "profile",
    });

    table.clearSession("s-1");
    assert.equal(table.lookup(body(), { parentSessionId: "s-1" }), "ask");
    const sibling = table.lookup(body(), { parentSessionId: "s-2" });
    assert.ok(typeof sibling !== "string" && sibling.kind === "allow");
    // Profile rows survive a session-scope clear.
    const profile = table.lookup(
      body({ class: "network", target: "example.com" }),
      { parentSessionId: "s-1" },
    );
    assert.ok(typeof profile !== "string" && profile.kind === "deny");

    table.clearSession();
    assert.equal(table.lookup(body(), { parentSessionId: "s-2" }), "ask");
    const profileStill = table.lookup(
      body({ class: "network", target: "example.com" }),
      { parentSessionId: "s-2" },
    );
    assert.ok(typeof profileStill !== "string" && profileStill.kind === "deny");
  });

  it("deny detail helper names unnamed targets", () => {
    assert.ok(reviewPostureDenyDetail("tool", "").includes("(unnamed)"));
  });
});

describe("review posture — composed after the consent table (chunk A wiring)", () => {
  it("consent deny beats posture allow (all-three-orders: deny first)", async () => {
    const { host, multitask } = await setupCore();
    multitask.accessPolicy.set({
      class: "tool",
      targetPattern: "write_file",
      decision: "deny",
      scope: "session",
    });
    multitask.reviewPosture.set({
      class: "tool",
      targetPattern: "write_file",
      decision: "allow",
      scope: "session",
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "W");

    host.fireAccessRequest(accessEvent(workerId));

    // Consent won: policy-deny wrapper, never the posture allow.
    assert.equal(multitask.listPendingAccess("session-1").length, 0);
    assert.equal(host.sendMessageCalls.length, 1);
    const sent = host.sendMessageCalls[0];
    assert.ok(sent);
    assert.ok(sent.message.includes("denied by policy"));
    assert.ok(!sent.message.includes("Allowed"));
    const wake = multitask.wakeBus.drain("session-1");
    const notices = wake?.accessNotices ?? [];
    assert.equal(notices.length, 1);
    if (notices[0]?.decision.kind === "deny") {
      // Consent deny keeps the consent table's detail copy.
      assert.ok(notices[0].decision.detail.includes("policy denied"));
      assert.ok(!notices[0].decision.detail.includes("auto-review"));
    }
  });

  it("consent allow beats posture deny (all-three-orders: allow first)", async () => {
    const { host, multitask } = await setupCore();
    multitask.accessPolicy.set({
      class: "tool",
      targetPattern: "write_file",
      decision: "allow",
      scope: "session",
    });
    multitask.reviewPosture.set({
      class: "tool",
      targetPattern: "write_file",
      decision: "deny",
      scope: "session",
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "W");

    host.fireAccessRequest(accessEvent(workerId));

    // Consent allow wins: silent shipped auto-answer, no deny notice.
    assert.equal(multitask.listPendingAccess("session-1").length, 0);
    assert.equal(host.sendMessageCalls.length, 1);
    assert.ok(host.sendMessageCalls[0]?.message.includes("allowed"));
    const wake = multitask.wakeBus.peek("session-1");
    assert.equal(wake?.accessNotices?.length ?? 0, 0);
  });

  it("posture allow rides the shipped silent auto-answer branch (no wake, no ticket)", async () => {
    const { host, multitask, scheduler } = await setupCore();
    multitask.reviewPosture.set({
      class: "tool",
      targetPattern: "write_file",
      decision: "allow",
      scope: "session",
      session: "session-1",
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "W");

    host.fireAccessRequest(accessEvent(workerId));

    // Delivered to the worker, no card, no wake, no timeout armed (A3).
    assert.equal(multitask.listPendingAccess("session-1").length, 0);
    assert.equal(host.sendMessageCalls.length, 1);
    assert.ok(host.sendMessageCalls[0]?.message.includes("allowed"));
    assert.deepEqual(host.wakeCalls, []);
    assert.equal(scheduler.scheduled.length, 0);
  });

  it("posture deny produces the self-naming policy-denied notice", async () => {
    const { host, multitask, scheduler } = await setupCore();
    multitask.reviewPosture.set({
      class: "tool",
      targetPattern: "write_file",
      decision: "deny",
      scope: "session",
      session: "session-1",
    });
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "W");

    host.fireAccessRequest(accessEvent(workerId));

    assert.equal(multitask.listPendingAccess("session-1").length, 0);
    assert.equal(host.sendMessageCalls.length, 1);
    const sent = host.sendMessageCalls[0];
    assert.ok(sent);
    assert.ok(sent.message.includes("denied by policy"));
    assert.ok(sent.message.includes("auto-review posture denied"));
    assert.ok(sent.message.includes("write_file"));
    assert.ok(sent.message.includes("Do not retry"));
    // Honest notice via the shipped onResolved deny path; no timeout armed.
    const wake = multitask.wakeBus.drain("session-1");
    const notices = wake?.accessNotices ?? [];
    assert.equal(notices.length, 1);
    if (notices[0]?.decision.kind === "deny") {
      assert.equal(notices[0].decision.reason, "policy-denied");
      assert.equal(
        notices[0].decision.detail,
        reviewPostureDenyDetail("tool", "write_file"),
      );
    }
    assert.equal(scheduler.scheduled.length, 0);
  });

  it("empty posture: park, wake, and armed timeout are byte-identical to shipped (A2)", async () => {
    const { host, multitask, scheduler } = await setupCore();
    const workerId = await spawnRunning(multitask, "session-1", "todo-1", "W");

    host.fireAccessRequest(accessEvent(workerId));

    assert.equal(scheduler.scheduled.length, 1);
    assert.equal(scheduler.scheduled[0]?.ms, 50);
    assert.deepEqual(host.wakeCalls, ["session-1"]);
    assert.equal(host.sendMessageCalls.length, 0);
    assert.equal(multitask.listPendingAccess("session-1").length, 1);
    // Escalated ask still denies after the armed timeout (A3, ADR-0008).
    scheduler.runAll();
    assert.equal(host.sendMessageCalls.length, 1);
    assert.equal(multitask.listPendingAccess("session-1").length, 0);
  });
});

describe("review posture — session lifecycle through Multitask (A4)", () => {
  it("clearSessionAccessPolicy(id) drops that session's posture rows; sibling's survive", async () => {
    const { host, multitask } = await setupCore();
    for (const session of ["session-1", "session-2"]) {
      multitask.reviewPosture.set({
        class: "tool",
        targetPattern: "write_file",
        decision: "allow",
        scope: "session",
        session,
      });
    }
    const w1 = await spawnRunning(multitask, "session-1", "todo-1", "A");
    const w2 = await spawnRunning(multitask, "session-2", "todo-1", "B");

    host.fireAccessRequest(accessEvent(w1));
    host.fireAccessRequest(accessEvent(w2));
    assert.equal(multitask.listPendingAccess().length, 0);

    multitask.clearSessionAccessPolicy("session-1");

    // session-1 asks again; session-2's remembered posture survives.
    host.fireAccessRequest(accessEvent(w1, { requestId: "req-1b" }));
    assert.equal(multitask.listPendingAccess("session-1").length, 1);
    assert.equal(multitask.listPendingAccess("session-2").length, 0);
  });

  it("whole-table clearance (no id) drops every session-scope posture row", async () => {
    const { host, multitask } = await setupCore();
    for (const session of ["session-1", "session-2"]) {
      multitask.reviewPosture.set({
        class: "tool",
        targetPattern: "write_file",
        decision: "allow",
        scope: "session",
        session,
      });
    }
    multitask.clearSessionAccessPolicy();
    assert.equal(multitask.reviewPosture.list().length, 0);
    const w1 = await spawnRunning(multitask, "session-1", "todo-1", "A");
    host.fireAccessRequest(accessEvent(w1));
    assert.equal(multitask.listPendingAccess("session-1").length, 1);
  });

  it("an un-owned posture row behaves as shipped: cleared by any session clear", async () => {
    const { host, multitask } = await setupCore();
    multitask.reviewPosture.set({
      class: "tool",
      targetPattern: "write_file",
      decision: "allow",
      scope: "session",
    });
    multitask.clearSessionAccessPolicy("session-1");
    assert.equal(multitask.reviewPosture.list().length, 0);
  });
});

describe("worker-dispatch gate (chunk A, A6)", () => {
  interface ToolsHarness {
    host: FakeDshHost;
    multitask: Multitask;
    tools: DispatcherToolDef[];
    setSession: (sessionId: string | null) => void;
    seamCalls: Array<{ title: string; streamKey: string }>;
  }

  async function setupTools(options?: {
    seam?: DispatchApprovalFn;
  }): Promise<ToolsHarness> {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    let sessionId: string | null = "session-1";
    const seamCalls: Array<{ title: string; streamKey: string }> = [];
    const seam: DispatchApprovalFn =
      options?.seam ??
      (async (request) => {
        seamCalls.push(request);
        return "allowed-once" as DispatchApprovalOutcome;
      });
    const tools = createDispatcherTools({
      multitask,
      getSessionId: () => sessionId,
      requestDispatchApproval: seam,
    });
    return {
      host,
      multitask,
      tools,
      setSession: (id) => {
        sessionId = id;
      },
      seamCalls,
    };
  }

  function spawnTool(tools: DispatcherToolDef[]): DispatcherToolDef {
    const tool = tools.find((t) => t.name === SPAWN_WORKER_TOOL);
    assert.ok(tool, "missing spawn tool");
    return tool;
  }

  const SPAWN_ARGS = {
    stream_key: "s-1",
    title: "Summarize RFCs",
    prompt: "Summarize the three auth RFCs.",
  };

  it("posture miss → spawn proceeds exactly as shipped; seam never called", async () => {
    const { host, tools, seamCalls } = await setupTools();
    const result = (await spawnTool(tools).execute({
      ...SPAWN_ARGS,
    })) as SpawnWorkerToolResult;
    assert.ok(result.ok);
    assert.equal(host.spawnCalls.length, 1);
    assert.equal(seamCalls.length, 0);
    // Chunk B marker: an ungated spawn carries NO gating provenance.
    assert.equal(result.gated, undefined);
  });

  it("allow row + seam allowed-once → spawn proceeds", async () => {
    const { host, multitask, tools, seamCalls } = await setupTools();
    multitask.reviewPosture.set({
      class: "worker-dispatch",
      targetPattern: "Summarize RFCs",
      decision: "allow",
      scope: "session",
      session: "session-1",
    });
    const result = (await spawnTool(tools).execute({
      ...SPAWN_ARGS,
    })) as SpawnWorkerToolResult;
    assert.ok(result.ok);
    assert.equal(host.spawnCalls.length, 1);
    assert.equal(seamCalls.length, 1);
    assert.equal(seamCalls[0]?.title, "Summarize RFCs");
    assert.equal(seamCalls[0]?.streamKey, "s-1");
    // Chunk B marker: the durable record carries the gating provenance so
    // the client's dispatch-card projection derives `approval-allowed` at
    // presentation time (ticket 69, design §3 shape 2).
    assert.equal(result.gated, true);
  });

  it("allow row + seam refused outcome → honest refused result, no host spawn", async () => {
    for (const outcome of ["rejected", "cancelled", "unavailable"] as const) {
      const { host, multitask, tools, seamCalls } = await setupTools({
        seam: async (request) => {
          seamCalls.push(request);
          return outcome;
        },
      });
      multitask.reviewPosture.set({
        class: "worker-dispatch",
        targetPattern: "Summarize RFCs",
        decision: "allow",
        scope: "session",
        session: "session-1",
      });
      const result = (await spawnTool(tools).execute({
        ...SPAWN_ARGS,
      })) as SpawnWorkerToolResult;
      assert.ok(!result.ok, outcome);
      if (result.ok) continue;
      assert.equal(result.reason, "auto-review-refused");
      assert.ok(result.detail.includes("Summarize RFCs"));
      assert.ok(result.detail.includes(outcome));
      assert.equal(host.spawnCalls.length, 0);
      assert.equal(seamCalls.length, 1);
    }
  });

  it("allow row + absent seam → refused (fail-closed), no host spawn", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    multitask.reviewPosture.set({
      class: "worker-dispatch",
      targetPattern: "Summarize RFCs",
      decision: "allow",
      scope: "session",
      session: "session-1",
    });
    const tools = createDispatcherTools({
      multitask,
      getSessionId: () => "session-1",
      // No requestDispatchApproval: un-answerable gate refuses.
    });
    const result = (await spawnTool(tools).execute({
      ...SPAWN_ARGS,
    })) as SpawnWorkerToolResult;
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "auto-review-refused");
    assert.ok(result.detail.includes("fail-closed"));
    assert.equal(host.spawnCalls.length, 0);
  });

  it("deny row → refused with the self-naming detail; the seam is never called", async () => {
    const { host, multitask, tools, seamCalls } = await setupTools();
    multitask.reviewPosture.set({
      class: "worker-dispatch",
      targetPattern: "Summarize RFCs",
      decision: "deny",
      scope: "session",
      session: "session-1",
    });
    const result = (await spawnTool(tools).execute({
      ...SPAWN_ARGS,
    })) as SpawnWorkerToolResult;
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "auto-review-refused");
    assert.ok(result.detail.includes("auto-review posture denied"));
    assert.equal(host.spawnCalls.length, 0);
    assert.equal(seamCalls.length, 0);
  });

  it("dispatch rows are session-keyed: a sibling session's row never gates this session", async () => {
    const { host, multitask, tools, seamCalls } = await setupTools();
    multitask.reviewPosture.set({
      class: "worker-dispatch",
      targetPattern: "Summarize RFCs",
      decision: "allow",
      scope: "session",
      session: "other-session",
    });
    const result = (await spawnTool(tools).execute({
      ...SPAWN_ARGS,
    })) as SpawnWorkerToolResult;
    assert.ok(result.ok);
    assert.equal(host.spawnCalls.length, 1);
    assert.equal(seamCalls.length, 0);
  });

  it("wildcard fence covers the dispatch sink too: a refused row leaves the spawn ungated", async () => {
    const { host, multitask, tools, seamCalls } = await setupTools();
    assert.equal(
      multitask.reviewPosture.set({
        class: "worker-dispatch",
        targetPattern: "Summarize_*",
        decision: "deny",
        scope: "session",
        session: "session-1",
      }),
      false,
    );
    const result = (await spawnTool(tools).execute({
      ...SPAWN_ARGS,
    })) as SpawnWorkerToolResult;
    assert.ok(result.ok);
    assert.equal(host.spawnCalls.length, 1);
    assert.equal(seamCalls.length, 0);
  });
});
