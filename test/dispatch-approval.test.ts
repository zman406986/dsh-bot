/**
 * Ticket 69 — L3 offline half + the Q2 offline-half pin.
 *
 * The dispatch approval seam's live face: `createDispatchApprovalSeam`
 * raises `ctx.approval.request` (`@deepseek-ai/dsh-user-approval`, the face
 * documented at `docs/research/dsh-adapter-api-notes.md:220-247`, inject
 * note `:390`) scoped to the activated dispatcher's Agent, and collapses
 * EVERY failure — service absent, not a function, agent gone, throw, rogue
 * outcome — to the fail-closed `unavailable`.
 *
 * **Q2 (design §6, offline half):** a `worker-dispatch` posture hit with NO
 * live answerer must refuse honestly and never wedge the spawned
 * dispatcher's turn. Pinned end to end: the LIVE seam (built over an absent
 * `ctx.approval`, exactly what the plugin wires) is fed to chunk A's spawn
 * gate; the posture-gated spawn REFUSES with `auto-review-refused`, the
 * returned promise settles (no hang, no un-answerable await), and no host
 * spawn call is made. The live-only remainder — whether the shipped client
 * approval composer still answers under the wrapper root frame — stays on
 * the 45/33 lane.
 *
 * Offline only (S8): FakeDshHost, no network, no LLM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDispatchApprovalSeam,
  DISPATCH_APPROVAL_TOOL_NAME,
} from "../src/adapter/dispatch-approval.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";
import {
  createDispatcherTools,
  type DispatcherToolDef,
} from "../src/core/tools.js";
import { SPAWN_WORKER_TOOL } from "../src/core/policy/prompts.js";
import type { SpawnWorkerToolResult } from "../src/core/tool-results.js";
import type { DispatchApprovalFn } from "../src/core/tools.js";

describe("createDispatchApprovalSeam (the answerer face, offline-degradable)", () => {
  const REQUEST = { title: "Summarize RFCs", streamKey: "s-1" };

  function serviceReturning(outcome: unknown, log?: Array<unknown>) {
    return {
      request: async (req: unknown) => {
        log?.push(req);
        return outcome;
      },
    };
  }

  it("passes the host outcomes through verbatim", async () => {
    for (const outcome of [
      "allowed-once",
      "rejected",
      "cancelled",
      "unavailable",
    ] as const) {
      const seam = createDispatchApprovalSeam({
        getApproval: () => serviceReturning(outcome),
        getAgent: () => ({ session: { id: "session-1" } }),
      });
      assert.equal(await seam(REQUEST), outcome, outcome);
    }
  });

  it("scopes the ask to the agent and names the spawn tool + dispatch", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const seam = createDispatchApprovalSeam({
      getApproval: () => serviceReturning("allowed-once", calls),
      getAgent: () => ({ session: { id: "session-1" } }),
    });
    await seam(REQUEST);
    assert.equal(calls.length, 1);
    const ask = calls[0];
    assert.ok(ask);
    assert.equal((ask.agent as { session: { id: string } }).session.id, "session-1");
    assert.equal(ask.toolName, DISPATCH_APPROVAL_TOOL_NAME);
    assert.equal(ask.toolName, "spawn_worker");
    assert.ok(String(ask.reason).includes("Summarize RFCs"));
    assert.ok(String(ask.reason).includes("s-1"));
  });

  it("degrades to unavailable when the service is absent or malformed", async () => {
    for (const service of [
      undefined,
      null,
      42,
      {},
      { request: "not-a-function" },
    ]) {
      const seam = createDispatchApprovalSeam({
        getApproval: () => service,
        getAgent: () => ({ session: { id: "session-1" } }),
      });
      assert.equal(await seam(REQUEST), "unavailable", String(service));
    }
  });

  it("degrades when the agent is gone or either lazy read throws", async () => {
    const noAgent = createDispatchApprovalSeam({
      getApproval: () => serviceReturning("allowed-once"),
      getAgent: () => undefined,
    });
    assert.equal(await noAgent(REQUEST), "unavailable");

    const throwingService = createDispatchApprovalSeam({
      getApproval: () => {
        throw new Error("service lookup failed");
      },
      getAgent: () => ({ session: { id: "session-1" } }),
    });
    assert.equal(await throwingService(REQUEST), "unavailable");

    const throwingAgent = createDispatchApprovalSeam({
      getApproval: () => serviceReturning("allowed-once"),
      getAgent: () => {
        throw new Error("agent gone");
      },
    });
    assert.equal(await throwingAgent(REQUEST), "unavailable");
  });

  it("a throwing answerer and a rogue outcome value both fail closed", async () => {
    const throwing = createDispatchApprovalSeam({
      getApproval: () => ({
        request: async () => {
          throw new Error("waterfall down");
        },
      }),
      getAgent: () => ({ session: { id: "session-1" } }),
    });
    assert.equal(await throwing(REQUEST), "unavailable");

    const rogue = createDispatchApprovalSeam({
      getApproval: () => serviceReturning("sure-whatever"),
      getAgent: () => ({ session: { id: "session-1" } }),
    });
    assert.equal(await rogue(REQUEST), "unavailable");
  });
});

describe("Q2 offline half: gated dispatch, NO answerer → honest refusal, never a wedge", () => {
  function spawnTool(tools: DispatcherToolDef[]): DispatcherToolDef {
    const tool = tools.find((t) => t.name === SPAWN_WORKER_TOOL);
    assert.ok(tool, "missing spawn tool");
    return tool;
  }

  function setup(seam: DispatchApprovalFn | undefined): {
    host: FakeDshHost;
    tools: DispatcherToolDef[];
  } {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    // A non-empty posture marks the dispatch class GATED (chunk A).
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
      ...(seam !== undefined ? { requestDispatchApproval: seam } : {}),
    });
    return { host, tools };
  }

  it("the LIVE seam over an ABSENT ctx.approval refuses the gated spawn — and settles", async () => {
    // Exactly what src/plugin.ts wires when the host approval service is
    // not composed: the seam degrades every ask to `unavailable`.
    const seam = createDispatchApprovalSeam({
      getApproval: () => undefined,
      getAgent: () => ({ session: { id: "session-1" } }),
    });
    const { host, tools } = setup(seam);
    // The await itself is the no-wedge assertion: the gate's promise
    // settles with an honest refusal, never a pending await on an
    // answerer that will never come.
    const result = (await spawnTool(tools).execute({
      stream_key: "s-1",
      title: "Summarize RFCs",
      prompt: "Read and summarize the three auth RFCs.",
    })) as SpawnWorkerToolResult;
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "auto-review-refused");
    assert.ok(result.detail.includes("not approved"));
    assert.ok(result.detail.includes("unavailable"));
    assert.equal(host.spawnCalls.length, 0, "fail-closed: no host spawn");
  });

  it("an ALLOWED answer through the seam proceeds and marks the record gated", async () => {
    const seam = createDispatchApprovalSeam({
      getApproval: () => ({
        request: async () => "allowed-once",
      }),
      getAgent: () => ({ session: { id: "session-1" } }),
    });
    const { host, tools } = setup(seam);
    const result = (await spawnTool(tools).execute({
      stream_key: "s-1",
      title: "Summarize RFCs",
      prompt: "Read and summarize the three auth RFCs.",
    })) as SpawnWorkerToolResult;
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.gated, true, "durable approval provenance for the card");
    assert.equal(host.spawnCalls.length, 1);
  });
});
