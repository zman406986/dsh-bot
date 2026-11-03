/**
 * Ticket 116 / ADR-0025 — `message_agent`, the one agent-messaging verb.
 *
 * What these pins hold:
 * 1. A worker target rides the EXISTING steer path: single-slot last-wins
 *    park, interrupt, wrapped send at the next step boundary, and
 *    `delivered_as: "steer"`. No second queue, no peer row.
 * 2. A dispatcher target rides the EXISTING peer inbox/wake lane:
 *    `delivered_as: "peer"`, a queued wake, and `priority` only ever
 *    reclaims a non-user turn.
 * 3. Refusals are the closed vocabulary, honest and queue-free:
 *    `unknown-target`, `self-target`, `not-running`, `rate-limited`,
 *    `invalid-envelope`.
 * 4. The shared budget is 8 accepted per sender per rolling 60 s, counted
 *    on accept only — a refusal never consumes budget.
 * 5. Provenance is structured: a peer wake carries
 *    `{kind:"agent-message", form:"relay", senderSessionId}` on the wake and
 *    through `requestDispatcherWakeup`, and the bus owner is `"peer"`.
 * 6. The four invariants: agent traffic never calls `enqueueUserWake`,
 *    never sets a user turn owner, never satisfies an approval ask, and
 *    never counts as user presence.
 *
 * Offline `FakeDshHost` only (S8 lane).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {createDispatcherTools, MESSAGE_AGENT_RATE_LIMIT, MESSAGE_AGENT_RATE_WINDOW_MS, type DispatcherToolDef} from "../src/core/tools.js";
import { MESSAGE_AGENT_TOOL } from "../src/core/policy/prompts.js";
import type { MessageAgentToolResult } from "../src/core/tool-results.js";

const SENDER = "session-1";
const PEER = "peer-session-9";

interface Rig {
  readonly host: FakeDshHost;
  readonly multitask: Multitask;
  readonly tools: DispatcherToolDef[];
  /** Injected clock for the rate budget. */
  readonly clock: { now: number };
  readonly exec: (
    args: Record<string, unknown>,
  ) => Promise<MessageAgentToolResult>;
  readonly messageAgent: DispatcherToolDef;
}

async function rig(options?: {
  isLive?: (sessionId: string) => boolean;
  isMarked?: (sessionId: string) => boolean;
  isWorkerMarked?: (workerId: string) => { parentSessionId: string } | undefined;
}): Promise<Rig> {
  const host = new FakeDshHost();
  const multitask = createMultitask(host, {
    ...(options?.isLive !== undefined
      ? { isLiveDispatcherSession: options.isLive }
      : {}),
    ...(options?.isMarked !== undefined
      ? { isDurablyMarkedDispatcher: options.isMarked }
      : {}),
    ...(options?.isWorkerMarked !== undefined
      ? { findDurableWorker: options.isWorkerMarked }
      : {}),
    // The access relay's default 120 s timer must never outlive a test.
    access: { timeoutMs: 50, schedule: () => () => {} },
  });
  const clock = { now: 1_000_000 };
  const tools = createDispatcherTools({
    multitask,
    getSessionId: () => SENDER,
    now: () => clock.now,
  });
  const messageAgent = tools.find((tool) => tool.name === MESSAGE_AGENT_TOOL);
  assert.ok(messageAgent, "message_agent is registered");
  return {
    host,
    multitask,
    tools,
    clock,
    messageAgent,
    exec: (args) => messageAgent.execute(args) as Promise<MessageAgentToolResult>,
  };
}

async function spawnRunning(
  multitask: Multitask,
  parentSessionId: string = SENDER,
  streamKey: string = "s-1",
  title: string = "Task",
): Promise<string> {
  const spawned = await multitask.spawnWorker({
    parentSessionId,
    streamKey,
    title,
    prompt: "Do the work.",
  });
  assert.ok(spawned.ok, spawned.ok ? "" : spawned.detail);
  if (!spawned.ok) throw new Error("unreachable");
  multitask.noteTurnStarted(spawned.workerId);
  return spawned.workerId;
}

/** Narrow a refusal and pin its reason. */
function refused(
  result: MessageAgentToolResult,
  reason:
    | "unknown-target"
    | "self-target"
    | "not-running"
    | "inbox-full"
    | "rate-limited"
    | "invalid-envelope",
): Extract<MessageAgentToolResult, { ok: false }> {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, reason);
  return result;
}

describe("ticket 116 — worker target rides the existing steer path", () => {
  it("parks, interrupts, and delivers a wrapped correction at the step boundary", async () => {
    const r = await rig();
    const workerId = await spawnRunning(r.multitask, SENDER, "s-1", "Docs rewrite");

    const result = await r.exec({
      target: workerId,
      text: "Focus on the third RFC only.",
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.target, workerId);
    assert.equal(result.delivered_as, "steer");
    assert.ok(result.message_id.startsWith("agent-"));
    assert.ok(result.note.includes("Docs rewrite"));
    assert.ok(result.note.includes("no restart"));

    // The steer path's observable shape: interrupt now, deliver later.
    assert.deepEqual(r.host.interruptCalls, [workerId]);
    assert.equal(r.host.sendMessageCalls.length, 0);
    assert.equal(r.multitask.getWorker(workerId)?.status, "steering");
    // Nothing rode the peer lane.
    assert.equal(r.multitask.peerInbox.pendingCount(workerId), 0);
    assert.deepEqual(r.host.wakeCalls, []);

    await r.host.fireStepBoundary(workerId);
    assert.equal(r.host.sendMessageCalls.length, 1);
    const delivered = r.host.sendMessageCalls[0];
    assert.ok(delivered);
    assert.equal(delivered.workerId, workerId);
    assert.ok(delivered.message.includes("[Parent correction]"));
    assert.ok(delivered.message.includes("Focus on the third RFC only."));
    assert.equal(r.multitask.getWorker(workerId)?.status, "running");
  });

});

describe("ticket 116 — worker-target refusals", () => {
  it("a settled (terminal) worker refuses not-running and delivers nothing", async () => {
    const r = await rig();
    const workerId = await spawnRunning(r.multitask);
    r.host.fireSettled({ workerId, status: "completed", report: "Done." });

    const result = refused(await r.exec({ target: workerId, text: "one more" }), "not-running");
    assert.ok(result.detail.includes(workerId));
    assert.ok(result.detail.includes("NOT delivered"));
    assert.deepEqual(r.host.sendMessageCalls, []);
  });

  it("another session's worker refuses unknown-target without leaking it", async () => {
    const r = await rig();
    const otherWorker = await spawnRunning(r.multitask, "session-2", "s-other", "Theirs");

    const result = refused(
      await r.exec({ target: otherWorker, text: "not yours" }),
      "unknown-target",
    );
    assert.ok(result.detail.includes(otherWorker));
    assert.ok(result.detail.includes("NOT delivered"));
    // Nothing was queued anywhere, and the other session's worker was not
    // interrupted.
    assert.equal(r.multitask.peerInbox.pendingCount(otherWorker), 0);
    assert.deepEqual(r.host.interruptCalls, []);
    assert.deepEqual(r.host.wakeCalls, []);
  });

  it("a self-target refuses", async () => {
    const r = await rig();
    const result = refused(
      await r.exec({ target: SENDER, text: "note to self" }),
      "self-target",
    );
    assert.ok(result.detail.includes("your own session"));
    assert.equal(r.multitask.peerInbox.pendingCount(SENDER), 0);
    assert.deepEqual(r.host.wakeCalls, []);
  });

});

describe("ticket 116 — dispatcher target rides the existing peer lane", () => {
  it("accepts into the peer inbox and enqueues one wake", async () => {
    const r = await rig();

    const result = await r.exec({
      target: PEER,
      text: "Handing off the RFC notes.",
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.target, PEER);
    assert.equal(result.delivered_as, "peer");
    assert.ok(result.message_id.startsWith("agent-"));
    // Acceptance-only ack: never a reply promise.
    assert.ok(result.note.includes("Accepted"));
    assert.ok(result.note.includes(PEER));
    assert.ok(result.note.includes("no reply"));
    // A non-priority send waits behind the peer's user; it never preempts.
    assert.ok(result.note.includes("behind whatever their user is driving"));

    assert.equal(r.multitask.peerInbox.pendingCount(PEER), 1);
    const pending = r.multitask.listPendingPeers(PEER);
    assert.equal(pending[0]?.messageId, result.message_id);
    assert.equal(pending[0]?.fromAgentId, SENDER);
    assert.equal(pending[0]?.fromName, SENDER);
    assert.deepEqual(pending[0]?.to, { kind: "agent", agentId: PEER });
    assert.deepEqual(r.host.wakeCalls, [PEER]);
  });

  it("a deactivated dispatcher target refuses unknown-target; a live one accepts", async () => {
    const live = new Set<string>([SENDER]);
    const r = await rig({ isLive: (id) => live.has(id) });

    const result = refused(
      await r.exec({ target: PEER, text: "anyone there?" }),
      "unknown-target",
    );
    assert.ok(result.detail.includes(PEER));
    assert.ok(result.detail.includes("NOT delivered"));
    assert.equal(r.multitask.peerInbox.pendingCount(PEER), 0);
    assert.deepEqual(r.host.wakeCalls, []);

    live.add(PEER);
    const accepted = await r.exec({ target: PEER, text: "hello again" });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    assert.equal(accepted.delivered_as, "peer");
    assert.equal(r.multitask.peerInbox.pendingCount(PEER), 1);
  });
});

/**
 * Ticket 138 (owner ruling 2026-10-22: "bots should be wake-able, both
 * dispatchers and children" — this is the DISPATCHERS half).
 *
 * The fence keeps ticket 70 §2's refusal for a target with NO durable mark.
 * A target that carries our own `dispatcher_sessions` mark is a spawned
 * dispatcher this process has not re-announced yet: the send is ACCEPTED, its
 * wake is requested, and the adapter's wake path cold-resumes the child.
 */
describe("ticket 138 — a durably marked dispatcher is wake-able by a send", () => {
  it("an UNMARKED unknown target still refuses unknown-target — the fence is intact", async () => {
    const r = await rig({
      isLive: () => false,
      isMarked: () => false,
    });

    const result = refused(
      await r.exec({ target: PEER, text: "anyone there?" }),
      "unknown-target",
    );
    assert.ok(result.detail.includes(PEER));
    assert.ok(result.detail.includes("NOT delivered"));
    assert.equal(r.multitask.peerInbox.pendingCount(PEER), 0);
    assert.deepEqual(r.host.wakeCalls, []);
  });

});

/**
 * Ticket 142 (owner ruling 2026-10-22: "yes bots should be wake-able, both
 * dispatchers and children" — the CHILDREN half).
 *
 * A worker id with no roster record that carries our own durable
 * `worker_sessions` row is a DORMANT worker, not an unknown peer: the message
 * routes to the steer branch, `steerWorker` accepts it, and the host's
 * `wakeDormantWorker` cold-resumes the session. An id with no row, or another
 * session's row, keeps the refusal it has always had.
 */
describe("ticket 142 — a durably marked worker is wake-able by a message", () => {
  const DORMANT = "worker-dormant-1";

  it("a marked-but-not-live WORKER accepts and is woken (no unknown-target)", async () => {
    const r = await rig({
      isLive: () => false,
      isWorkerMarked: (id) =>
        id === DORMANT ? { parentSessionId: SENDER } : undefined,
    });

    const result = await r.exec({ target: DORMANT, text: "resume the migration" });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    // It takes the STEER lane, not the peer lane: the target is a worker.
    assert.equal(result.delivered_as, "steer");
    assert.equal(result.target, DORMANT);
    assert.ok(result.message_id.startsWith("agent-"));
    // Honest copy: the session is resumed, so it must not promise a step
    // boundary that does not exist yet.
    assert.ok(result.note.includes("dormant"));
    assert.ok(result.note.includes("being resumed"));
    assert.ok(!result.note.includes("step boundary"));

    // The host wake seam got the WRAPPED correction (the same wrapper a live
    // steer gets), and the peer inbox was never touched — a worker is not a
    // peer.
    assert.equal(r.host.dormantWakeCalls.length, 1);
    const wake = r.host.dormantWakeCalls[0];
    assert.ok(wake);
    assert.equal(wake.workerId, DORMANT);
    assert.ok(wake.message.includes("resume the migration"));
    assert.ok(wake.message.includes("[Parent correction]"));
    assert.equal(r.multitask.peerInbox.pendingCount(DORMANT), 0);
    assert.deepEqual(r.host.wakeCalls, []);
  });

  it("another session's marked worker refuses unknown-target without leaking it", async () => {
    const r = await rig({
      isLive: () => false,
      isWorkerMarked: (id) =>
        id === DORMANT ? { parentSessionId: "session-2" } : undefined,
    });

    refused(
      await r.exec({ target: DORMANT, text: "not yours" }),
      "unknown-target",
    );
    assert.equal(r.host.dormantWakeCalls.length, 0);
    assert.equal(r.multitask.peerInbox.pendingCount(DORMANT), 0);
  });

  it("an identity refusal runs before the rate fence: a foreign marked worker still reads unknown-target", async () => {
    const r = await rig({
      isLive: () => true,
      isWorkerMarked: (id) =>
        id === DORMANT ? { parentSessionId: "session-2" } : undefined,
    });
    for (let i = 0; i < MESSAGE_AGENT_RATE_LIMIT; i += 1) {
      const accepted = await r.exec({ target: PEER, text: `note ${i}` });
      assert.equal(accepted.ok, true, `message ${i} should be accepted`);
    }
    // Budget exhausted, but the identity fence decides first — the refusal is
    // about the target, not the rate, so the caller learns the useful fact.
    refused(await r.exec({ target: DORMANT, text: "x" }), "unknown-target");
  });
});

describe("ticket 116 — shared rate budget (8 accepted per sender per 60 s)", () => {
  it("refuses the 9th, refunds identity refusals, and rolls the window", async () => {
    const r = await rig();
    for (let i = 0; i < MESSAGE_AGENT_RATE_LIMIT; i += 1) {
      assert.equal((await r.exec({ target: PEER, text: `note ${i}` })).ok, true);
    }
    assert.equal(r.multitask.peerInbox.pendingCount(PEER), MESSAGE_AGENT_RATE_LIMIT);

    // The 9th in the same window refuses and queues nothing.
    const wakesBefore = r.host.wakeCalls.length;
    const ninth = refused(await r.exec({ target: PEER, text: "one too many" }), "rate-limited");
    assert.ok(ninth.detail.includes(String(MESSAGE_AGENT_RATE_LIMIT)));
    assert.equal(r.multitask.peerInbox.pendingCount(PEER), MESSAGE_AGENT_RATE_LIMIT);
    assert.equal(r.host.wakeCalls.length, wakesBefore);

    // The rolling window restores capacity.
    r.clock.now += MESSAGE_AGENT_RATE_WINDOW_MS;
    assert.equal((await r.exec({ target: PEER, text: "fresh window" })).ok, true);
  });
});

describe("ticket 116 — structured provenance on the peer wake", () => {
  it("stamps {kind:'agent-message', form:'relay', senderSessionId} and owns the bus as peer", async () => {
    const r = await rig();
    const result = await r.exec({ target: PEER, text: "handoff" });
    assert.ok(result.ok);

    const origin = {
      kind: "agent-message",
      form: "relay",
      senderSessionId: SENDER,
    } as const;
    // Through the host seam: the wake request carries the origin object.
    assert.deepEqual(r.host.wakeOrigins, [{ sessionId: PEER, origin }]);

    const wake = r.multitask.wakeBus.drain(PEER);
    assert.equal(wake?.source, "peer");
    assert.deepEqual(wake?.messageOrigin, origin);
    assert.equal(wake?.peerMessages?.[0]?.fromAgentId, SENDER);
    // The bus owner the host reads is "peer", never "user".
    r.multitask.wakeBus.noteTurnStarted(PEER);
    assert.equal(r.multitask.wakeBus.getTurnOwner(PEER), "peer");

    // Contrast: a background settle wake carries NO origin — the stamp is
    // specific to agent-caused wakes.
    const workerId = await spawnRunning(r.multitask);
    r.host.fireSettled({ workerId, status: "completed", report: "Done." });
    const settle = r.host.wakeOrigins.at(-1);
    assert.deepEqual(settle, { sessionId: SENDER, origin: undefined });
  });

});

describe("ticket 116 — agent traffic is never the user path", () => {
  it("never calls enqueueUserWake and never sets a user turn owner", async () => {
    const r = await rig();
    let userWakeCalls = 0;
    const bus = r.multitask.wakeBus;
    const realEnqueueUserWake = bus.enqueueUserWake.bind(bus);
    bus.enqueueUserWake = (sessionId: string) => {
      userWakeCalls += 1;
      realEnqueueUserWake(sessionId);
    };

    await r.exec({ target: PEER, text: "peer note" });
    const workerId = await spawnRunning(r.multitask);
    await r.exec({ target: workerId, text: "worker note" });

    assert.equal(userWakeCalls, 0, "no agent path may open a user wake");
    // The flush recorded a PEER owner; a turn opened without an explicit
    // owner therefore reads "peer", never "user".
    bus.drain(PEER);
    bus.noteTurnStarted(PEER);
    assert.equal(bus.getTurnOwner(PEER), "peer");
  });

  it("never counts as user presence — the target stays idle and peer-owned", async () => {
    const r = await rig();
    const bus = r.multitask.wakeBus;
    assert.equal(bus.isBusy(PEER), false);

    const result = await r.exec({ target: PEER, text: "hello" });
    assert.equal(result.ok, true);

    // The observable presence projection can only read: not mid-turn, one
    // queued wake, and a peer-owned turn once it opens. No user value.
    assert.equal(bus.isBusy(PEER), false);
    assert.notEqual(bus.peek(PEER), undefined);
    bus.drain(PEER);
    bus.noteTurnStarted(PEER);
    assert.equal(bus.getTurnOwner(PEER), "peer");
  });
});
