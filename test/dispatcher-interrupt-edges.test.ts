/**
 * Dispatcher interrupt edges — auto-continue fix, design note Decision 6
 * (.scratch/auto-continue-fix/design-note.md, red-test plan file 5).
 *
 * ONE focused currently-failing behavior: the completed-before-abort refusal
 * (multitask.ts abortWorker) must KEEP refusing — completion stands and the
 * obligation is legitimately owed — but its detail must name the owed todo_id
 * and the deliver_result(todo_id=...) close path, so the dispatcher reading
 * the refusal knows exactly how to close the obligation (Decision 6a).
 *
 * Controls (expected green today AND after the fix):
 * - a deliver ack leaves nothing to rebuild: no obligation, no redrive, no wake;
 * - a settle after a REAL abort is dropped: no revival, no marker, no wake;
 * - requestDispatcherInterrupt stays the documented no-op (Decision 6c): it
 *   resolves without opening a followup or issuing a host cancel, and the
 *   priority peer wake still wins the flush after noteTurnEnded.
 *
 * Pure core (FakeDshHost + createInMemoryDurability held across fresh cores)
 * plus the REAL adapter interrupt seam over a structural stub ctx — S8 offline,
 * no dsh-scope, no network/LLM. The cancelled-turn durable-charge edge lives in
 * test/turn-end-redrive.test.ts per the note's disjoint plan (Decision 4/6b).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCordisDshHost,
  type ActivationLike,
  type ActivationSpecLike,
  type AdapterContext,
  type AgentHandleLike,
  type AgentLike,
} from "../src/adapter/cordis-dsh-host.js";
import { createInMemoryDurability } from "../src/core/durability.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import { toPeerNotice, type PeerEnvelope } from "../src/core/peer-types.js";
import type { SpawnResult } from "../src/core/types.js";

const SESSION = "session-1";
const TODO_ID = "todo-1";

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

/** A todo plus its linked worker with the running edge already observed. */
async function spawnLinkedWorker(core: Multitask): Promise<string> {
  core.createTodo({ sessionId: SESSION, id: TODO_ID, title: "Research" });
  const workerId = unwrapSpawn(
    await core.spawnWorker({
      parentSessionId: SESSION,
      streamKey: "stream-1",
      title: "Research",
      prompt: "go",
      todoId: TODO_ID,
    }),
  );
  core.noteTurnStarted(workerId);
  return workerId;
}

/**
 * The parts of AdapterContext the interrupt seam's construction touches: the
 * event bus registrations and the structurally required services. The bound
 * dispatcher agent records followup/cancel so a turn opened by the interrupt
 * would be observable. Pattern: test/dispatcher-parent-accessor.test.ts.
 */
function createInterruptStubCtx(): {
  ctx: AdapterContext;
  agent: AgentLike;
  followupCalls: unknown[];
  cancelCalls: unknown[];
  subagentInterrupts: unknown[];
} {
  const followupCalls: unknown[] = [];
  const cancelCalls: unknown[] = [];
  const subagentInterrupts: unknown[] = [];
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const agent: AgentLike = {
    session: {
      id: SESSION,
      header: { delegationDepth: 0, cwd: "C:\\work" },
    },
    // Model the busy dispatcher turn the interrupt is requested against.
    status: "running",
    followup(message: unknown) {
      followupCalls.push(message);
    },
    cancel(cause) {
      cancelCalls.push(cause);
    },
  };
  const ctx = {
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb as (payload: unknown) => void);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((entry) => entry !== cb),
        );
      };
    },
    subagents: {
      async startActivation(_spec: ActivationSpecLike): Promise<ActivationLike> {
        throw new Error("this test never spawns through the adapter");
      },
      interrupt(...args: unknown[]) {
        subagentInterrupts.push(args);
      },
      async sendMessage() {
        return "stub-message";
      },
    },
    agents: {
      get: () => undefined,
      async create(): Promise<AgentHandleLike> {
        throw new Error("this test never creates agents");
      },
    },
    jobs: { list: () => [] },
    storageDomain: {},
  };
  return {
    ctx: ctx as unknown as AdapterContext,
    agent,
    followupCalls,
    cancelCalls,
    subagentInterrupts,
  };
}

describe("dispatcher interrupt edges — Decision 6 (auto-continue fix)", () => {
  it("completed-before-abort keeps refusing: the detail names the owed todo_id + deliver_result path, and an acked item keeps the generic detail", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const core = createMultitask(host, { durability });
    const workerId = await spawnLinkedWorker(core);
    host.fireSettled({
      workerId,
      status: "completed",
      report: "done; the user has not seen it yet",
    });

    const refusal = await core.abortWorker(workerId);

    // The kept refusal (Decision 6a): completion stands, nothing is
    // interrupted, and the owed obligation is NOT dropped by the abort.
    assert.equal(refusal.ok, false, "abort after settle must keep refusing");
    assert.ok(refusal.ok === false && refusal.reason === "already-settled");
    assert.deepEqual(host.interruptCalls, [], "a refused abort never interrupts");
    assert.equal(core.getWorker(workerId)?.status, "completed");
    const todo = core.todos.get(TODO_ID);
    assert.ok(todo, "the owed obligation survives the refused abort");
    assert.equal(todo.status, "in_progress");
    assert.equal(todo.delivered, false);
    assert.ok(
      durability.markers.has(workerId),
      "the owed obligation stays durable across the refused abort",
    );

    // RED today: the detail is generic ("worker ... is not running; it may
    // already be done"). Desired: it names the owed todo and the exact
    // deliver_result close path, so the refusal is actionable.
    assert.ok(
      refusal.ok === false && refusal.detail.includes(TODO_ID),
      `refusal detail must name the owed todo id; got: ${refusal.ok === false ? refusal.detail : "(ok)"}`,
    );
    assert.ok(
      refusal.ok === false &&
        refusal.detail.includes(`deliver_result(todo_id="${TODO_ID}")`),
      `refusal detail must name the deliver_result close path; got: ${refusal.ok === false ? refusal.detail : "(ok)"}`,
    );

    // The refinement is owed-only (Decision 6a): once the obligation is
    // acked, the SAME refusal keeps the generic detail — it must not falsely
    // name a todo_id / deliver_result close path for work that owes nothing.
    assert.equal(core.markDelivered(TODO_ID), true);
    const ackedRefusal = await core.abortWorker(workerId);
    assert.ok(
      ackedRefusal.ok === false && ackedRefusal.reason === "already-settled",
      "the acked item still refuses the abort",
    );
    assert.ok(
      ackedRefusal.ok === false &&
        !ackedRefusal.detail.includes(TODO_ID) &&
        !ackedRefusal.detail.includes("deliver_result"),
      `an acked item keeps the generic refusal detail; got: ${ackedRefusal.ok === false ? ackedRefusal.detail : "(ok)"}`,
    );
  });

  it("control: a deliver ack leaves nothing to rebuild — no obligation, no redrive, no wake", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const core = createMultitask(host, { durability });
    const workerId = await spawnLinkedWorker(core);
    host.fireSettled({ workerId, status: "completed", report: "done" });

    assert.equal(core.markDelivered(TODO_ID), true);
    assert.equal(
      durability.markers.has(workerId),
      false,
      "healthy store: the ack deletes the marker (today's durable ack)",
    );

    // Simulated restart: only the store outlives the core.
    const freshHost = new FakeDshHost();
    const fresh = createMultitask(freshHost, { durability });
    const report = await fresh.rebuildFromDurability(SESSION);
    assert.deepEqual(report.restored, [], "an acked result is not restored as owed");
    assert.equal(fresh.todos.get(TODO_ID), undefined);
    const redrive = fresh.redriveUndelivered(SESSION);
    assert.deepEqual(redrive.redriven, []);
    assert.deepEqual(redrive.lost, []);
    assert.deepEqual(freshHost.wakeCalls, [], "nothing owed means no wake");
    fresh.dispose();
  });

  it("control: a settle after a real abort is dropped — no revival, no marker, no wake", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const core = createMultitask(host, { durability });
    const workerId = await spawnLinkedWorker(core);

    assert.deepEqual(await core.abortWorker(workerId), { ok: true });
    assert.deepEqual(host.interruptCalls, [workerId]);
    assert.equal(
      core.todos.get(TODO_ID),
      undefined,
      "the linked todo is cancelled and pruned by the real abort",
    );
    assert.equal(
      durability.markers.has(workerId),
      false,
      "the real abort closes the marker obligation",
    );

    host.fireSettled({ workerId, status: "completed", report: "too late" });

    assert.equal(core.getWorker(workerId)?.status, "aborted");
    assert.equal(core.todos.get(TODO_ID), undefined, "no todo resurrection");
    assert.equal(
      durability.markers.has(workerId),
      false,
      "a late settle must not resurrect the marker",
    );
    assert.deepEqual(host.wakeCalls, []);
    const redrive = core.redriveUndelivered(SESSION);
    assert.deepEqual(redrive.redriven, []);
    assert.deepEqual(redrive.lost, []);
  });

  it("control: requestDispatcherInterrupt stays a no-op — resolves, opens no followup; the priority peer still flushes after turn end", async () => {
    // Adapter half (Decision 6c): the REAL seam over a structural stub ctx.
    const stub = createInterruptStubCtx();
    const adapter = createCordisDshHost(stub.ctx);
    adapter.bindParent(stub.agent, SESSION);

    // The seam is optional on the DshHost contract (core/dsh-host.ts:102);
    // the real adapter must expose it — assert before invoking (type-narrow).
    assert.ok(
      adapter.requestDispatcherInterrupt,
      "the adapter exposes the dispatcher interrupt seam",
    );
    const answer = await adapter.requestDispatcherInterrupt(SESSION);

    assert.equal(answer, undefined, "the kept no-op resolves");
    assert.deepEqual(stub.followupCalls, [], "the interrupt opens no model turn");
    assert.deepEqual(stub.cancelCalls, [], "no host cancel is issued for the dispatcher");
    assert.deepEqual(stub.subagentInterrupts, []);
    adapter.dispose();

    // Core half: the bus still reaches the interrupt seam mid non-user turn,
    // the no-op does not end the running turn, and the priority peer wake
    // wins the flush at noteTurnEnded (the documented soft fallback).
    const host = new FakeDshHost();
    const core = createMultitask(host);
    core.wakeBus.noteTurnStarted(SESSION, "worker-settled");
    const envelope: PeerEnvelope = {
      messageId: "p1",
      fromAgentId: "peer-a",
      fromName: "Peer A",
      to: { kind: "agent", agentId: SESSION },
      conversationId: "conv-1",
      text: "urgent",
      priority: true,
      createdAtMs: 1_000,
    };
    core.wakeBus.enqueuePeer({
      sessionId: SESSION,
      notice: toPeerNotice(envelope, true),
      effectivePriority: true,
    });

    assert.deepEqual(
      host.interruptDispatcherCalls,
      [SESSION],
      "the priority peer reaches the interrupt seam",
    );
    assert.equal(
      core.wakeBus.isBusy(SESSION),
      true,
      "the no-op interrupt does not end the running turn",
    );
    assert.equal(core.wakeBus.getTurnOwner(SESSION), "worker-settled");

    core.wakeBus.noteTurnEnded(SESSION);
    const wake = core.wakeBus.drain(SESSION);
    assert.equal(wake?.source, "peer", "the priority peer wake flushes after turn end");
    assert.equal(wake?.peerMessages?.[0]?.messageId, "p1");
    core.dispose();
  });
});
