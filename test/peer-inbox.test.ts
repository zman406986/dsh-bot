import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPeerInbox,
  DEFAULT_PEER_INBOX_CAP,
  type PeerInbox,
} from "../src/core/peer-inbox.js";
import {
  effectivePeerPriority,
  samePeerPayload,
  toPeerNotice,
  type PeerEnvelope,
} from "../src/core/peer-types.js";

const SESSION = "session-1";

function envelope(overrides: Partial<PeerEnvelope> = {}): PeerEnvelope {
  return {
    messageId: "msg-1",
    fromAgentId: "peer-a",
    fromName: "Peer A",
    to: { kind: "agent", agentId: "dispatcher-1" },
    conversationId: "conv-1",
    text: "hello dispatcher",
    priority: false,
    createdAtMs: 1_000,
    ...overrides,
  };
}

describe("peer inbox — accept / ack (AC: fire-and-forget + ack)", () => {
  it("a valid 1:1 envelope returns ok with messageId echoed and no delivery wait", () => {
    const inbox = createPeerInbox();
    const result = inbox.send(SESSION, envelope({ priority: true }));

    assert.equal(result.ack.ok, true);
    assert.ok(result.ack.ok);
    assert.equal(result.ack.messageId, "msg-1");
    // Ticket 70 §3: the ok ack reduces to {ok, messageId, acceptedAtMs}.
    assert.equal("priorityHonored" in result.ack, false);
    assert.equal("reason" in result.ack, false);
    assert.equal(typeof result.ack.acceptedAtMs, "number");
    assert.equal(result.appended, true);
    assert.equal(inbox.pendingCount(SESSION), 1);
  });

  it("invalid envelope is refused without appending a row", () => {
    const inbox = createPeerInbox();
    const missingText = inbox.send(SESSION, envelope({ text: "" }));
    assert.equal(missingText.ack.ok, false);
    assert.ok(!missingText.ack.ok);
    assert.equal(missingText.ack.reason, "invalid-envelope");

    const missingId = inbox.send(SESSION, envelope({ messageId: "" }));
    assert.equal(missingId.ack.ok, false);
    assert.ok(!missingId.ack.ok);
    assert.equal(missingId.ack.reason, "invalid-envelope");

    const missingConversation = inbox.send(
      SESSION,
      envelope({ conversationId: "" }),
    );
    assert.equal(missingConversation.ack.ok, false);
    assert.ok(!missingConversation.ack.ok);
    assert.equal(missingConversation.ack.reason, "invalid-envelope");

    assert.equal(inbox.pendingCount(SESSION), 0);
  });

  it("the same messageId with an identical payload is idempotent — one row, same ok ack", () => {
    const inbox = createPeerInbox();
    const first = inbox.send(SESSION, envelope());
    const second = inbox.send(SESSION, envelope({ createdAtMs: 2_000 }));

    assert.equal(first.ack.ok, true);
    assert.equal(second.ack.ok, true);
    assert.ok(first.ack.ok && second.ack.ok);
    assert.equal(second.ack.acceptedAtMs, first.ack.acceptedAtMs);
    assert.equal(second.appended, false);
    assert.equal(inbox.pendingCount(SESSION), 1);
  });

  it("the same messageId with a different payload is refused", () => {
    const inbox = createPeerInbox();
    assert.equal(inbox.send(SESSION, envelope()).ack.ok, true);
    const reuse = inbox.send(SESSION, envelope({ text: "different body" }));
    assert.equal(reuse.ack.ok, false);
    assert.ok(!reuse.ack.ok);
    assert.equal(reuse.ack.reason, "message-id-reuse");
    assert.equal(inbox.pendingCount(SESSION), 1);
  });

  it("message ids are sender-scoped — two senders may reuse an id", () => {
    const inbox = createPeerInbox();
    const a = inbox.send(SESSION, envelope({ fromAgentId: "peer-a" }));
    const b = inbox.send(
      SESSION,
      envelope({ fromAgentId: "peer-b", fromName: "Peer B" }),
    );
    assert.equal(a.ack.ok, true);
    assert.equal(b.ack.ok, true);
    assert.equal(inbox.pendingCount(SESSION), 2);
  });

  it("inbox full refuses new ids but keeps previously accepted undelivered rows", () => {
    const inbox = createPeerInbox({ maxPendingPerSession: 2 });
    assert.equal(inbox.send(SESSION, envelope({ messageId: "m1" })).ack.ok, true);
    assert.equal(inbox.send(SESSION, envelope({ messageId: "m2" })).ack.ok, true);
    const full = inbox.send(SESSION, envelope({ messageId: "m3" }));
    assert.equal(full.ack.ok, false);
    assert.ok(!full.ack.ok);
    assert.equal(full.ack.reason, "inbox-full");
    assert.equal(inbox.pendingCount(SESSION), 2);
  });

  it("default cap is the published constant", () => {
    assert.equal(DEFAULT_PEER_INBOX_CAP, 64);
  });
});

describe("peer inbox — C14 retirement (ticket 70 §3: point-to-point only)", () => {
  it("a group envelope is refused as invalid-envelope; nothing is appended", () => {
    const inbox = createPeerInbox();
    const result = inbox.send(
      SESSION,
      envelope({
        to: { kind: "group", groupId: "team-1" } as unknown as PeerEnvelope["to"],
        priority: true,
      }),
    );
    assert.equal(result.ack.ok, false);
    assert.ok(!result.ack.ok);
    assert.equal(result.ack.reason, "invalid-envelope");
    assert.equal(inbox.pendingCount(SESSION), 0);
  });

  it("a broadcast envelope is refused as invalid-envelope", () => {
    const inbox = createPeerInbox();
    const result = inbox.send(
      SESSION,
      envelope({ to: { kind: "broadcast" } as unknown as PeerEnvelope["to"] }),
    );
    assert.equal(result.ack.ok, false);
    assert.ok(!result.ack.ok);
    assert.equal(result.ack.reason, "invalid-envelope");
    assert.equal(inbox.pendingCount(SESSION), 0);
  });

  it("a target without an agentId is refused; the ok ack carries no priority fields", () => {
    const inbox = createPeerInbox();
    const bare = inbox.send(
      SESSION,
      envelope({ to: { kind: "agent", agentId: "" } }),
    );
    assert.equal(bare.ack.ok, false);
    assert.ok(!bare.ack.ok);
    assert.equal(bare.ack.reason, "invalid-envelope");

    const ok = inbox.send(SESSION, envelope({ priority: false }));
    assert.equal(ok.ack.ok, true);
    assert.ok(ok.ack.ok);
    assert.equal("priorityHonored" in ok.ack, false);
    assert.equal("reason" in ok.ack, false);
  });

  it("effectivePeerPriority is the 1:1 flag itself after the retirement", () => {
    assert.equal(effectivePeerPriority(envelope({ priority: true })), true);
    assert.equal(effectivePeerPriority(envelope({ priority: false })), false);
  });
});

describe("peer inbox — delivery flag and listPending", () => {
  it("listPending returns undelivered envelopes only; markDelivered is one-shot", () => {
    const inbox = createPeerInbox();
    inbox.send(SESSION, envelope({ messageId: "m1" }));
    inbox.send(SESSION, envelope({ messageId: "m2" }));

    assert.deepEqual(
      inbox.listPending(SESSION).map((e) => e.messageId),
      ["m1", "m2"],
    );
    assert.equal(inbox.markDelivered(SESSION, "m1"), true);
    assert.equal(inbox.markDelivered(SESSION, "m1"), false);
    assert.deepEqual(
      inbox.listPending(SESSION).map((e) => e.messageId),
      ["m2"],
    );
  });

  it("a late duplicate of a delivered id does not re-append", () => {
    const inbox = createPeerInbox();
    inbox.send(SESSION, envelope());
    inbox.markDelivered(SESSION, "msg-1");
    const again = inbox.send(SESSION, envelope());
    assert.equal(again.ack.ok, true);
    assert.equal(again.appended, false);
    assert.equal(inbox.pendingCount(SESSION), 0);
  });

  it("sessions are independent", () => {
    const inbox = createPeerInbox();
    inbox.send("s-a", envelope());
    assert.equal(inbox.pendingCount("s-a"), 1);
    assert.equal(inbox.pendingCount("s-b"), 0);
  });
});

describe("peer types — payload identity and notices", () => {
  it("samePeerPayload ignores createdAtMs but compares text/target/priority", () => {
    const a = envelope({ createdAtMs: 1 });
    const b = envelope({ createdAtMs: 999 });
    assert.equal(samePeerPayload(a, b), true);
    assert.equal(samePeerPayload(a, envelope({ text: "other" })), false);
    assert.equal(
      samePeerPayload(
        a,
        envelope({
          // The wire type admits only `agent`; a group target is exactly the
          // malformed input this case must still distinguish by payload.
          to: { kind: "group", groupId: "g" } as unknown as PeerEnvelope["to"],
        }),
      ),
      false,
    );
  });

  it("toPeerNotice carries the effective priority flag, not the wire flag", () => {
    const notice = toPeerNotice(envelope({ priority: true }), false);
    assert.equal(notice.priority, false);
    assert.equal(notice.messageId, "msg-1");
    assert.equal(notice.conversationId, "conv-1");
  });

  it("samePeerPayload distinguishes targets by agent id", () => {
    const a = envelope({ to: { kind: "agent", agentId: "x" } });
    const b = envelope({ to: { kind: "agent", agentId: "y" } });
    assert.equal(samePeerPayload(a, b), false);
    assert.equal(
      samePeerPayload(a, envelope({ to: { kind: "agent", agentId: "x" } })),
      true,
    );
  });
});
