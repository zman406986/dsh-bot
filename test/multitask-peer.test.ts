import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  assemblePeerWakeTurn,
} from "../src/core/policy/assembler.js";
import {
  PEER_WAKE_SECTION_HEADINGS,
} from "../src/core/policy/prompts.js";
import type { PeerEnvelope } from "../src/core/peer-types.js";
import type { SpawnResult } from "../src/core/types.js";

const SESSION = "session-1";

function envelope(overrides: Partial<PeerEnvelope> = {}): PeerEnvelope {
  return {
    messageId: "msg-1",
    fromAgentId: "peer-a",
    fromName: "Peer A",
    to: { kind: "agent", agentId: "dispatcher-1" },
    conversationId: "conv-1",
    text: "hello from another assistant",
    priority: false,
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

async function spawnRunning(
  multitask: Multitask,
  parentSessionId: string,
  streamKey: string,
  title: string,
): Promise<string> {
  const workerId = unwrapSpawn(
    await multitask.spawnWorker({
      parentSessionId,
      streamKey,
      title,
      prompt: "Do the work.",
    }),
  );
  multitask.noteTurnStarted(workerId);
  return workerId;
}

describe("multitask peer — fire-and-forget send + ack (AC)", () => {
  it("sendPeer returns a structural ack only and may request a host wake", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const ack = multitask.sendPeer(SESSION, envelope({ priority: true }));

    assert.equal(ack.ok, true);
    assert.ok(ack.ok);
    assert.equal(ack.messageId, "msg-1");
    // Ticket 70 §3: the ok ack reduces to {ok, messageId, acceptedAtMs} —
    // `priorityHonored` retired with the shapes it reported on.
    assert.equal("priorityHonored" in ack, false);
    // Structural only — no reply payload field exists on the ack.
    assert.equal("reply" in ack, false);
    assert.deepEqual(host.wakeCalls, [SESSION]);

    const wake = multitask.wakeBus.drain(SESSION);
    assert.equal(wake?.source, "peer");
    assert.equal(wake?.peerMessages?.[0]?.fromName, "Peer A");
  });

  it("idempotent re-send does not double-enqueue or double-wake", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.sendPeer(SESSION, envelope());
    multitask.sendPeer(SESSION, envelope());

    assert.equal(host.wakeCalls.length, 1);
    const wake = multitask.wakeBus.drain(SESSION);
    assert.equal(wake?.peerMessages?.length, 1);
    assert.equal(multitask.wakeBus.drain(SESSION), undefined);
  });

  it("payload-mismatch reuse is refused and never enqueues", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.sendPeer(SESSION, envelope());
    const reuse = multitask.sendPeer(SESSION, envelope({ text: "changed" }));
    assert.equal(reuse.ok, false);
    assert.ok(!reuse.ok);
    assert.equal(reuse.reason, "message-id-reuse");
    assert.equal(multitask.wakeBus.drain(SESSION)?.peerMessages?.length, 1);
  });
});

describe("multitask peer — C14 retirement (ticket 70 §3: point-to-point only)", () => {
  it("a group envelope is refused at accept; nothing enqueues or wakes", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const ack = multitask.sendPeer(
      SESSION,
      envelope({
        to: { kind: "group", groupId: "team-1" } as unknown as PeerEnvelope["to"],
        priority: true,
      }),
    );

    assert.equal(ack.ok, false);
    assert.ok(!ack.ok);
    assert.equal(ack.reason, "invalid-envelope");
    assert.equal(multitask.listPendingPeers(SESSION).length, 0);
    assert.deepEqual(host.wakeCalls, []);
    assert.deepEqual(host.interruptDispatcherCalls, []);
    assert.equal(multitask.wakeBus.drain(SESSION), undefined);
  });

  it("a broadcast envelope is refused at accept — the reference broadcast is a user cue, not a peer send", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const ack = multitask.sendPeer(
      SESSION,
      envelope({ to: { kind: "broadcast" } as unknown as PeerEnvelope["to"] }),
    );
    assert.equal(ack.ok, false);
    assert.ok(!ack.ok);
    assert.equal(ack.reason, "invalid-envelope");
    assert.equal(multitask.listPendingPeers(SESSION).length, 0);
    assert.deepEqual(host.wakeCalls, []);
  });
});

describe("multitask peer — priority interrupt vs user (AC)", () => {
  it("priority mid non-user turn requests interrupt and delivers as peer wake", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, SESSION, "s1", "Work");

    // Settle → background ready + host wake. Start that non-user turn
    // without draining (host compose path is not used by FakeDshHost).
    host.fireSettled({ workerId, status: "completed", report: "done" });
    multitask.wakeBus.noteTurnStarted(SESSION);
    assert.equal(multitask.wakeBus.getTurnOwner(SESSION), "worker-settled");

    const ack = multitask.sendPeer(
      SESSION,
      envelope({ messageId: "p1", priority: true }),
    );
    assert.equal(ack.ok, true);
    assert.deepEqual(host.interruptDispatcherCalls, [SESSION]);

    const wake = multitask.wakeBus.drain(SESSION);
    assert.equal(wake?.source, "peer");
    assert.equal(wake?.peerMessages?.[0]?.messageId, "p1");

    // Delivered flag: drained peer is no longer pending.
    assert.equal(multitask.listPendingPeers(SESSION).length, 0);
  });

  it("priority mid user turn never interrupts", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.wakeBus.noteTurnStarted(SESSION, "user");
    multitask.sendPeer(SESSION, envelope({ messageId: "p1", priority: true }));

    assert.deepEqual(host.interruptDispatcherCalls, []);
    assert.equal(multitask.wakeBus.peek(SESSION), undefined);
  });

  it("non-priority peer queues behind user and ahead of settled on the next flush", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, SESSION, "s1", "Work");

    multitask.wakeBus.noteTurnStarted(SESSION, "user");
    host.fireSettled({ workerId, status: "completed", report: "done" });
    multitask.sendPeer(SESSION, envelope({ messageId: "n1" }));

    multitask.wakeBus.noteTurnEnded(SESSION);
    const first = multitask.wakeBus.drain(SESSION);
    assert.equal(first?.source, "peer");

    multitask.wakeBus.noteTurnStarted(SESSION, "peer");
    multitask.wakeBus.noteTurnEnded(SESSION);
    const second = multitask.wakeBus.drain(SESSION);
    assert.equal(second?.source, "worker-settled");
  });
});

describe("multitask peer — re-queue without duplicate (AC)", () => {
  it("interrupt of a ready background wake re-queues settled; peers drain once", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.wakeBus.noteTurnStarted(SESSION, "user");
    multitask.sendPeer(SESSION, envelope({ messageId: "n1" }));
    // Fake a settled notice already in the bus pending via direct enqueue
    // after we hold the turn so both wait together.
    const w = await spawnRunning(multitask, SESSION, "s1", "Work");
    host.fireSettled({ workerId: w, status: "completed", report: "r" });
    multitask.wakeBus.noteTurnEnded(SESSION);

    // Peer is ready (ahead of background). Priority replaces it.
    multitask.sendPeer(
      SESSION,
      envelope({ messageId: "p1", priority: true }),
    );
    const priority = multitask.wakeBus.drain(SESSION);
    assert.deepEqual(
      priority?.peerMessages?.map((m) => m.messageId),
      ["p1"],
    );
    assert.equal(multitask.listPendingPeers(SESSION).map((e) => e.messageId).includes("p1"), false);

    multitask.wakeBus.noteTurnStarted(SESSION, "peer");
    multitask.wakeBus.noteTurnEnded(SESSION);
    const normal = multitask.wakeBus.drain(SESSION);
    assert.deepEqual(
      normal?.peerMessages?.map((m) => m.messageId),
      ["n1"],
    );

    multitask.wakeBus.noteTurnStarted(SESSION, "peer");
    multitask.wakeBus.noteTurnEnded(SESSION);
    const background = multitask.wakeBus.drain(SESSION);
    assert.equal(background?.source, "worker-settled");
    assert.equal(background?.settledWorkers.length, 1);
    assert.equal(multitask.wakeBus.drain(SESSION), undefined);
    assert.equal(multitask.listPendingPeers(SESSION).length, 0);
  });

  it("drainWake marks peer rows delivered so a later accept cannot re-deliver the same id", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.sendPeer(SESSION, envelope());
    const drained = multitask.drainWake(SESSION);
    assert.equal(drained?.wake.source, "peer");
    assert.equal(multitask.listPendingPeers(SESSION).length, 0);

    const again = multitask.sendPeer(SESSION, envelope());
    assert.equal(again.ok, true);
    assert.ok(again.ok);
    // Still no second wake: appended is false for a delivered id.
    assert.equal(
      host.wakeCalls.filter((id) => id === SESSION).length,
      1,
    );
  });
});

describe("multitask peer — envelope carries sender, target, conversation (AC)", () => {
  it("the delivered notice carries fromAgentId, fromName, to, conversationId, text", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    multitask.sendPeer(
      SESSION,
      envelope({
        messageId: "m-conv",
        fromAgentId: "alpha",
        fromName: "Alpha",
        to: { kind: "agent", agentId: "omega" },
        conversationId: "thread-9",
        text: "status?",
      }),
    );

    const wake = multitask.wakeBus.drain(SESSION);
    const notice = wake?.peerMessages?.[0];
    assert.ok(notice);
    assert.equal(notice.fromAgentId, "alpha");
    assert.equal(notice.fromName, "Alpha");
    assert.deepEqual(notice.to, { kind: "agent", agentId: "omega" });
    // Schema-fenced carrier (ticket 70 §3): still carried on the envelope
    // and notice, never surfaced in rendered copy.
    assert.equal(notice.conversationId, "thread-9");
    assert.equal(notice.text, "status?");
  });
});

describe("peer hidden-turn copy (AC: other-assistant cue, never the user)", () => {
  it("assemblePeerWakeTurn includes stable cue tokens and never claims to be the user", () => {
    const text = assemblePeerWakeTurn([
      {
        messageId: "msg-1",
        fromAgentId: "peer-a",
        fromName: "Peer A",
        to: { kind: "agent", agentId: "dispatcher-1" },
        conversationId: "conv-1",
        text: "payload body",
        priority: true,
        createdAtMs: 42,
      },
    ]);

    for (const heading of PEER_WAKE_SECTION_HEADINGS) {
      assert.ok(text.includes(heading), `missing heading: ${heading}`);
    }
    assert.ok(text.includes("not from the user"));
    assert.ok(text.includes("Peer A"));
    assert.ok(text.includes("peer-a"));
    assert.ok(text.includes("payload body"));
    assert.ok(text.includes("Priority: yes"));
    // Ticket 70 §3: the fenced conversationId is never surfaced.
    assert.equal(text.includes("conv-1"), false);
    // Must not present as a user message.
    assert.equal(text.includes("The user said"), false);
  });

  it("empty peer batch still produces the other-assistant shell", () => {
    const text = assemblePeerWakeTurn([]);
    assert.ok(text.includes(PEER_WAKE_SECTION_HEADINGS[0]));
    assert.ok(text.includes("(none)"));
  });

  it("core never uses the user-messaging path for peer delivery", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, SESSION, "s1", "Work");

    multitask.sendPeer(SESSION, envelope());
    // Peer delivery is requestDispatcherWakeup only — no sendMessage to a worker.
    assert.deepEqual(host.sendMessageCalls, []);
    assert.deepEqual(host.wakeCalls, [SESSION]);
    // Worker still live; peer did not touch it.
    assert.equal(multitask.getWorker(workerId)?.status, "running");
  });
});

describe("multitask peer — worker barrier unchanged", () => {
  it("workers gain no peer send surface from the core", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnRunning(multitask, SESSION, "s1", "Work");
    // sendPeer is on the dispatcher surface, not addressable as a worker tool.
    assert.equal(typeof multitask.sendPeer, "function");
    assert.equal(
      (multitask as unknown as Record<string, unknown>).send_peer,
      undefined,
    );
    assert.notEqual(workerId, "");
  });
});
