/**
 * Ticket 70 §4 — two-dispatcher peer isolation (offline S8 pin, expected
 * pass: the inbox and wake bus have been session-keyed since 76; a failure
 * here is a bug to fix, not new design).
 *
 * Two dispatcher sessions A/B drive ONE Multitask + one FakeDshHost. The
 * suite pins: B-only wakeup (case 1), no list leakage (2), per-session
 * delivered flags against the sender-scoped id index (3), cross-session
 * interrupt containment (4), user-turn safety pinned ACROSS sessions (5),
 * and the post-retirement refusal of group/broadcast shapes at accept (6,
 * the §3 sort). A second section pins the ticket-70 §2 fences: the
 * `isLiveDispatcherSession` knob finally producing `unknown-target`, the
 * unconditional `self-target` refusal, and the absent-knob shipped behavior.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import type { PeerEnvelope } from "../src/core/peer-types.js";
import type { SpawnResult } from "../src/core/types.js";

const A = "dispatcher-a";
const B = "dispatcher-b";

/** An envelope from A, addressed to a target session id. */
function fromA(overrides: Partial<PeerEnvelope> = {}): PeerEnvelope {
  return {
    messageId: "m-1",
    fromAgentId: A,
    fromName: A,
    to: { kind: "agent", agentId: B },
    conversationId: "direct",
    text: "hello from A",
    priority: false,
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** An envelope from B, addressed to a target session id. */
function fromB(overrides: Partial<PeerEnvelope> = {}): PeerEnvelope {
  return {
    messageId: "m-1",
    fromAgentId: B,
    fromName: B,
    to: { kind: "agent", agentId: A },
    conversationId: "direct",
    text: "hello from B",
    priority: false,
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

/** Spawn a worker for a session and leave it running (its turn untouched). */
async function spawnRunning(
  multitask: Multitask,
  parentSessionId: string,
  streamKey: string,
): Promise<string> {
  const workerId = unwrapSpawn(
    await multitask.spawnWorker({
      parentSessionId,
      streamKey,
      title: "Work",
      prompt: "Do the work.",
    }),
  );
  multitask.noteTurnStarted(workerId);
  return workerId;
}

describe("two-dispatcher peer isolation (ticket 70 §4, one core, sessions A/B)", () => {
  it("case 1 — A's send wakes B only: A gains no wake, no rows, no state", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const ack = multitask.sendPeer(B, fromA());
    assert.equal(ack.ok, true);
    assert.ok(ack.ok);

    assert.deepEqual(host.wakeCalls, [B]);
    assert.equal(multitask.wakeBus.peek(A), undefined);
    assert.equal(multitask.wakeBus.peek(B)?.source, "peer");
    assert.equal(multitask.listPendingPeers(A).length, 0);
    assert.equal(multitask.peerInbox.pendingCount(A), 0);
  });

  it("case 2 — no list leakage: listPendingPeers(A) stays empty while B holds the row", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.sendPeer(B, fromA({ messageId: "m-leak" }));

    assert.deepEqual(
      multitask.listPendingPeers(B).map((envelope) => envelope.messageId),
      ["m-leak"],
    );
    assert.deepEqual(multitask.listPendingPeers(A), []);
  });

  it("case 3 — delivered flags are per-session: draining B leaves the same-id row in A untouched", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    // The same messageId from BOTH directions: the sender-scoped index
    // admits it, since each session's inbox keys rows by its own sender.
    multitask.sendPeer(B, fromA({ messageId: "m-both" })); // A → B
    multitask.sendPeer(A, fromB({ messageId: "m-both" })); // B → A
    assert.equal(multitask.listPendingPeers(A).length, 1);
    assert.equal(multitask.listPendingPeers(B).length, 1);

    // Draining B's peer wake marks B's row delivered — only B's.
    const drained = multitask.drainWake(B);
    assert.equal(drained?.wake.source, "peer");
    assert.equal(multitask.listPendingPeers(B).length, 0);
    assert.deepEqual(
      multitask.listPendingPeers(A).map((envelope) => envelope.messageId),
      ["m-both"],
    );
    assert.equal(multitask.peerInbox.has(A, "m-both"), true);
  });

  it("case 4 — priority into mid-non-user-turn B interrupts B only; A's turn state is untouched", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerB = await spawnRunning(multitask, B, "build-b");

    // B goes mid background turn (a settled wake is ready, turn started).
    host.fireSettled({ workerId: workerB, status: "completed", report: "r" });
    multitask.wakeBus.noteTurnStarted(B);
    assert.equal(multitask.wakeBus.getTurnOwner(B), "worker-settled");
    assert.equal(multitask.wakeBus.isBusy(B), true);

    // A is idle and stays untouched by everything that follows.
    const ack = multitask.sendPeer(B, fromA({ messageId: "m-prio", priority: true }));

    assert.equal(ack.ok, true);
    assert.ok(ack.ok);
    // Interrupt containment: exactly B, never A.
    assert.deepEqual(host.interruptDispatcherCalls, [B]);
    assert.equal(
      host.wakeCalls.filter((id) => id === A).length,
      0,
    );
    assert.equal(multitask.wakeBus.isBusy(A), false);
    assert.equal(multitask.wakeBus.getTurnOwner(A), null);
    assert.equal(multitask.wakeBus.peek(A), undefined);
    assert.equal(multitask.listPendingPeers(A).length, 0);

    // B's ready wake is now the priority peer wake.
    const wake = multitask.wakeBus.drain(B);
    assert.equal(wake?.source, "peer");
    assert.equal(wake?.peerMessages?.[0]?.messageId, "m-prio");
  });

  it("case 5 — priority into mid-user-turn B queues without interrupt, across two sessions", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    await spawnRunning(multitask, A, "build-a");

    multitask.wakeBus.noteTurnStarted(B, "user");
    const ack = multitask.sendPeer(B, fromA({ messageId: "m-safe", priority: true }));

    assert.equal(ack.ok, true);
    assert.deepEqual(host.interruptDispatcherCalls, []);
    assert.equal(multitask.wakeBus.peek(B), undefined);
    assert.equal(multitask.wakeBus.getTurnOwner(B), "user");
    // A, running its own worker, never hears about B's traffic.
    assert.equal(multitask.wakeBus.isBusy(A), false);
    assert.equal(multitask.wakeBus.getTurnOwner(A), null);
    assert.equal(multitask.wakeBus.peek(A), undefined);

    multitask.wakeBus.noteTurnEnded(B);
    const wake = multitask.wakeBus.drain(B);
    assert.equal(wake?.source, "peer");
    assert.equal(wake?.peerMessages?.[0]?.messageId, "m-safe");
  });

  it("case 6 — post-retirement: group/broadcast envelopes are refused at accept, nothing enqueues", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const group = multitask.sendPeer(
      B,
      fromA({
        to: { kind: "group", groupId: "crew" } as unknown as PeerEnvelope["to"],
        priority: true,
      }),
    );
    const broadcast = multitask.sendPeer(
      B,
      fromA({
        messageId: "m-bc",
        to: { kind: "broadcast" } as unknown as PeerEnvelope["to"],
      }),
    );

    assert.equal(group.ok, false);
    assert.ok(!group.ok);
    assert.equal(group.reason, "invalid-envelope");
    assert.equal(broadcast.ok, false);
    assert.ok(!broadcast.ok);
    assert.equal(broadcast.reason, "invalid-envelope");
    assert.equal(multitask.listPendingPeers(B).length, 0);
    assert.equal(multitask.listPendingPeers(A).length, 0);
    assert.deepEqual(host.wakeCalls, []);
    assert.deepEqual(host.interruptDispatcherCalls, []);
  });
});

describe("sendPeer liveness + self fences (ticket 70 §2)", () => {
  it("with the knob wired, a send to a non-live session refuses unknown-target and creates no phantom state", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host, {
      isLiveDispatcherSession: (id) => id === A,
    });

    const ack = multitask.sendPeer(B, fromA());

    assert.equal(ack.ok, false);
    assert.ok(!ack.ok);
    assert.equal(ack.reason, "unknown-target");
    // No phantom inbox: no rows, no wake, no wake-bus state.
    assert.equal(multitask.listPendingPeers(B).length, 0);
    assert.equal(multitask.peerInbox.pendingCount(B), 0);
    assert.deepEqual(host.wakeCalls, []);
    assert.equal(multitask.wakeBus.peek(B), undefined);
  });

  it("with the knob wired, a send to a live session still lands normally", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host, {
      isLiveDispatcherSession: (id) => id === B,
    });

    const ack = multitask.sendPeer(B, fromA({ messageId: "m-live" }));
    assert.equal(ack.ok, true);
    assert.deepEqual(host.wakeCalls, [B]);
    assert.equal(multitask.listPendingPeers(B).length, 1);
  });

  it("self-target refuses unconditionally — even when the target is a live session", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host, {
      isLiveDispatcherSession: () => true,
    });

    // A sends to itself: fromAgentId (the adapter-stamped sender session)
    // equals the target session — the self-loop refusal.
    const ack = multitask.sendPeer(A, fromA({ to: { kind: "agent", agentId: A } }));

    assert.equal(ack.ok, false);
    assert.ok(!ack.ok);
    assert.equal(ack.reason, "self-target");
    assert.equal(multitask.listPendingPeers(A).length, 0);
    assert.deepEqual(host.wakeCalls, []);
    assert.deepEqual(host.interruptDispatcherCalls, []);
  });

  it("absent knob keeps the shipped behavior: an unknown session still accepts (core stays host-agnostic)", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const ack = multitask.sendPeer("no-such-session", fromA({ messageId: "m-lazy" }));
    assert.equal(ack.ok, true);
    assert.ok(ack.ok);
    assert.equal(multitask.listPendingPeers("no-such-session").length, 1);
    assert.deepEqual(host.wakeCalls, ["no-such-session"]);
  });
});
