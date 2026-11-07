import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toPeerNotice, type PeerEnvelope } from "../src/core/peer-types.js";
import {
  createWakeBus,
  type SettledWorkerNotice,
  type WakeBus,
} from "../src/core/wake-bus.js";

const SESSION = "session-1";

function envelope(overrides: Partial<PeerEnvelope> = {}): PeerEnvelope {
  return {
    messageId: "msg-1",
    fromAgentId: "peer-a",
    fromName: "Peer A",
    to: { kind: "agent", agentId: "dispatcher-1" },
    conversationId: "conv-1",
    text: "hello",
    priority: false,
    createdAtMs: 1_000,
    ...overrides,
  };
}

function notice(
  overrides: Partial<PeerEnvelope> = {},
  effectivePriority?: boolean,
) {
  const env = envelope(overrides);
  const priority =
    effectivePriority ?? (env.priority && env.to.kind === "agent");
  return toPeerNotice(env, priority);
}

function settled(
  workerId: string,
  title = "Task",
  resultText = "done",
): SettledWorkerNotice {
  return { workerId, status: "completed", title, resultText };
}

interface Recorder {
  delivered: string[];
  interrupted: string[];
  drainedSources: string[];
  bus: WakeBus;
}

function createBus(): Recorder {
  const delivered: string[] = [];
  const interrupted: string[] = [];
  const drainedSources: string[] = [];
  const bus = createWakeBus({
    onDeliver: (id) => {
      delivered.push(id);
    },
    onInterrupt: (id) => {
      interrupted.push(id);
    },
    onDrain: (event) => drainedSources.push(event.source),
  });
  return { delivered, interrupted, drainedSources, bus };
}

describe("wake bus — peer enqueue and hidden-turn payload", () => {
  it("an idle priority peer flushes immediately as source peer with peerMessages", () => {
    const { delivered, bus } = createBus();
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p1", priority: true }, true),
      effectivePriority: true,
    });

    assert.deepEqual(delivered, [SESSION]);
    const wake = bus.drain(SESSION);
    assert.ok(wake);
    assert.equal(wake.source, "peer");
    assert.equal(wake.settledWorkers.length, 0);
    assert.equal(wake.peerMessages?.length, 1);
    assert.equal(wake.peerMessages?.[0]?.messageId, "p1");
    assert.equal(wake.peerMessages?.[0]?.fromAgentId, "peer-a");
    assert.equal(wake.peerMessages?.[0]?.conversationId, "conv-1");
    assert.equal(wake.peerMessages?.[0]?.text, "hello");
  });

  it("an idle non-priority peer also flushes immediately when nothing else is ready", () => {
    const { delivered, bus } = createBus();
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "n1" }),
      effectivePriority: false,
    });
    assert.deepEqual(delivered, [SESSION]);
    assert.equal(bus.drain(SESSION)?.source, "peer");
  });

  it("several priority peers flush as one FIFO peer wake", () => {
    const { bus } = createBus();
    bus.noteTurnStarted(SESSION, "user");
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p1", priority: true }, true),
      effectivePriority: true,
    });
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p2", priority: true }, true),
      effectivePriority: true,
    });
    bus.noteTurnEnded(SESSION);

    const wake = bus.drain(SESSION);
    assert.equal(wake?.source, "peer");
    assert.deepEqual(
      wake?.peerMessages?.map((m) => m.messageId),
      ["p1", "p2"],
    );
  });

  it("several normal peers flush as one FIFO peer wake", () => {
    const { bus } = createBus();
    bus.noteTurnStarted(SESSION, "user");
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "n1" }),
      effectivePriority: false,
    });
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "n2" }),
      effectivePriority: false,
    });
    bus.noteTurnEnded(SESSION);

    const wake = bus.drain(SESSION);
    assert.equal(wake?.source, "peer");
    assert.deepEqual(
      wake?.peerMessages?.map((m) => m.messageId),
      ["n1", "n2"],
    );
  });

  it("a peer wake never mixes with settled notices (separate turns)", () => {
    const { delivered, bus } = createBus();
    bus.noteTurnStarted(SESSION, "user");
    bus.enqueueWorkerSettled({
      parentSessionId: SESSION,
      ...settled("w1"),
    });
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "n1" }),
      effectivePriority: false,
    });
    bus.noteTurnEnded(SESSION);

    // One flush at turn end: peer only. Settled stays pending.
    assert.deepEqual(delivered, [SESSION]);
    const first = bus.drain(SESSION);
    assert.equal(first?.source, "peer");
    assert.equal(first?.settledWorkers.length, 0);

    // Settled flushes on its own subsequent turn.
    bus.noteTurnStarted(SESSION, "peer");
    bus.noteTurnEnded(SESSION);
    assert.deepEqual(delivered, [SESSION, SESSION]);
    const second = bus.drain(SESSION);
    assert.equal(second?.source, "worker-settled");
    assert.equal(second?.peerMessages, undefined);
    assert.equal(second?.settledWorkers.length, 1);
  });
});

describe("wake bus — ordering (AC: behind user / ahead of background)", () => {
  it("user wake ready + idle → user drains first; peer remains pending", () => {
    const { bus } = createBus();
    bus.enqueueUserWake(SESSION);
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "n1" }),
      effectivePriority: false,
    });

    const first = bus.drain(SESSION);
    assert.equal(first?.source, "user");

    bus.noteTurnStarted(SESSION, "user");
    bus.noteTurnEnded(SESSION);
    const second = bus.drain(SESSION);
    assert.equal(second?.source, "peer");
    assert.equal(second?.peerMessages?.[0]?.messageId, "n1");
  });

  it("non-priority peer + worker-settled both pending, idle → next flush is peer; settled stays pending", () => {
    const { delivered, bus } = createBus();
    bus.noteTurnStarted(SESSION, "user");
    bus.enqueueWorkerSettled({
      parentSessionId: SESSION,
      ...settled("w-bg"),
    });
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "n1" }),
      effectivePriority: false,
    });
    bus.noteTurnEnded(SESSION);

    // One deliver for the peer flush; settled waits.
    assert.deepEqual(delivered, [SESSION]);
    const peerWake = bus.drain(SESSION);
    assert.equal(peerWake?.source, "peer");

    bus.noteTurnStarted(SESSION, "peer");
    bus.noteTurnEnded(SESSION);
    const settledWake = bus.drain(SESSION);
    assert.equal(settledWake?.source, "worker-settled");
    assert.equal(settledWake?.settledWorkers[0]?.workerId, "w-bg");
  });

  it("priority peer waits behind a ready user wake", () => {
    const { bus } = createBus();
    bus.enqueueUserWake(SESSION);
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p1", priority: true }, true),
      effectivePriority: true,
    });
    assert.equal(bus.peek(SESSION)?.source, "user");
  });

  it("priority lane flushes before normal lane on the same turn end", () => {
    const { bus } = createBus();
    bus.noteTurnStarted(SESSION, "user");
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "n1" }),
      effectivePriority: false,
    });
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p1", priority: true }, true),
      effectivePriority: true,
    });
    bus.noteTurnEnded(SESSION);

    const first = bus.drain(SESSION);
    assert.equal(first?.source, "peer");
    assert.deepEqual(
      first?.peerMessages?.map((m) => m.messageId),
      ["p1"],
    );

    bus.noteTurnStarted(SESSION, "peer");
    bus.noteTurnEnded(SESSION);
    const second = bus.drain(SESSION);
    assert.deepEqual(
      second?.peerMessages?.map((m) => m.messageId),
      ["n1"],
    );
  });
});

describe("wake bus — priority interrupt (AC: non-user only, never user)", () => {
  it("mid worker-settled turn: priority interrupts, reclaims the ready batch, becomes the ready peer wake", () => {
    const { delivered, interrupted, bus } = createBus();
    bus.enqueueWorkerSettled({
      parentSessionId: SESSION,
      ...settled("w-bg", "Background", "bg result"),
    });
    // Ready settled + host notified. Simulate the host starting that turn
    // without yet draining (FakeDshHost does not compose/drain).
    bus.noteTurnStarted(SESSION);

    assert.equal(bus.getTurnOwner(SESSION), "worker-settled");

    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p1", priority: true }, true),
      effectivePriority: true,
    });

    assert.deepEqual(interrupted, [SESSION]);
    assert.deepEqual(delivered, [SESSION, SESSION]);
    const wake = bus.drain(SESSION);
    assert.equal(wake?.source, "peer");
    assert.equal(wake?.peerMessages?.[0]?.messageId, "p1");

    // Reclaimed background flushes after the peer turn ends.
    bus.noteTurnEnded(SESSION);
    bus.noteTurnStarted(SESSION, "peer");
    bus.noteTurnEnded(SESSION);
    const background = bus.drain(SESSION);
    assert.equal(background?.source, "worker-settled");
    assert.equal(background?.settledWorkers[0]?.workerId, "w-bg");
  });

  it("mid user turn: no interrupt; priority stays in the lane and flushes after the user turn", () => {
    const { interrupted, bus } = createBus();
    bus.noteTurnStarted(SESSION, "user");
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p1", priority: true }, true),
      effectivePriority: true,
    });

    assert.deepEqual(interrupted, []);
    assert.equal(bus.peek(SESSION), undefined);
    assert.equal(bus.getTurnOwner(SESSION), "user");

    bus.noteTurnEnded(SESSION);
    // User-owned turn end with nothing ready still flushes priority.
    const wake = bus.drain(SESSION);
    assert.equal(wake?.source, "peer");
    assert.equal(wake?.peerMessages?.[0]?.messageId, "p1");
  });

  it("ownership unknown while busy is treated as user-owned — no interrupt", () => {
    const { interrupted, bus } = createBus();
    bus.noteTurnStarted(SESSION, "user");
    // Force-clear by ending and restarting without owner → fail closed.
    bus.noteTurnEnded(SESSION);
    bus.noteTurnStarted(SESSION); // pendingOwner null → user
    assert.equal(bus.getTurnOwner(SESSION), "user");

    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p1", priority: true }, true),
      effectivePriority: true,
    });
    assert.deepEqual(interrupted, []);
  });

  it("priority while a non-priority peer wake is ready: non-priority re-queued to normal front; no duplicate delivery", () => {
    const { bus } = createBus();
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "n1" }),
      effectivePriority: false,
    });
    // Ready normal peer. Priority arrives idle → replaces ready.
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p1", priority: true }, true),
      effectivePriority: true,
    });

    const first = bus.drain(SESSION);
    assert.equal(first?.source, "peer");
    assert.deepEqual(
      first?.peerMessages?.map((m) => m.messageId),
      ["p1"],
    );

    bus.noteTurnStarted(SESSION, "peer");
    bus.noteTurnEnded(SESSION);
    const second = bus.drain(SESSION);
    assert.deepEqual(
      second?.peerMessages?.map((m) => m.messageId),
      ["n1"],
    );
    assert.equal(bus.drain(SESSION), undefined);
  });

  it("non-priority peer mid non-user turn queues and does not interrupt", () => {
    const { interrupted, bus } = createBus();
    bus.enqueueWorkerSettled({
      parentSessionId: SESSION,
      ...settled("w-bg"),
    });
    bus.noteTurnStarted(SESSION);
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "n1" }),
      effectivePriority: false,
    });
    assert.deepEqual(interrupted, []);
    assert.equal(bus.peek(SESSION)?.source, "worker-settled");
  });

  it("workers are not interrupted — interrupt is only a dispatcher-turn signal", () => {
    const { interrupted, bus } = createBus();
    bus.noteTurnStarted(SESSION, "worker-settled");
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p1", priority: true }, true),
      effectivePriority: true,
    });
    assert.deepEqual(interrupted, [SESSION]);
    // The bus never touches worker ids; only the session turn is reclaimed.
    const wake = bus.drain(SESSION);
    assert.equal(wake?.settledWorkers.length, 0);
  });
});

describe("wake bus — re-queue without duplicate", () => {
  it("after priority interrupt of a background wake, N settled + later peers each drain exactly once", () => {
    const { bus } = createBus();
    bus.noteTurnStarted(SESSION, "user");
    bus.enqueueWorkerSettled({
      parentSessionId: SESSION,
      ...settled("w1", "One", "r1"),
    });
    bus.enqueueWorkerSettled({
      parentSessionId: SESSION,
      ...settled("w2", "Two", "r2"),
    });
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "n1" }),
      effectivePriority: false,
    });
    bus.noteTurnEnded(SESSION);

    // Ready peer (ahead of background). Priority replaces it.
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p1", priority: true }, true),
      effectivePriority: true,
    });

    const priority = bus.drain(SESSION);
    assert.deepEqual(
      priority?.peerMessages?.map((m) => m.messageId),
      ["p1"],
    );

    // Next flush: normal peer (re-queued from ready).
    bus.noteTurnStarted(SESSION, "peer");
    bus.noteTurnEnded(SESSION);
    const normal = bus.drain(SESSION);
    assert.deepEqual(
      normal?.peerMessages?.map((m) => m.messageId),
      ["n1"],
    );

    // Next flush: reclaimed settled batch, both workers once.
    bus.noteTurnStarted(SESSION, "peer");
    bus.noteTurnEnded(SESSION);
    const background = bus.drain(SESSION);
    assert.equal(background?.source, "worker-settled");
    assert.deepEqual(
      background?.settledWorkers.map((n) => n.workerId),
      ["w1", "w2"],
    );

    assert.equal(bus.drain(SESSION), undefined);
  });

  it("user preemption also reclaims a ready peer wake back into the matching lane", () => {
    const { bus } = createBus();
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "n1" }),
      effectivePriority: false,
    });
    assert.equal(bus.peek(SESSION)?.source, "peer");

    bus.enqueueUserWake(SESSION);
    assert.equal(bus.drain(SESSION)?.source, "user");

    bus.noteTurnStarted(SESSION, "user");
    bus.noteTurnEnded(SESSION);
    const peer = bus.drain(SESSION);
    assert.equal(peer?.source, "peer");
    assert.deepEqual(
      peer?.peerMessages?.map((m) => m.messageId),
      ["n1"],
    );
  });
});

describe("wake bus — turn ownership", () => {
  it("noteTurnStarted consumes the pending owner from the last flush", () => {
    const { bus } = createBus();
    bus.enqueuePeer({
      sessionId: SESSION,
      notice: notice({ messageId: "p1", priority: true }, true),
      effectivePriority: true,
    });
    bus.noteTurnStarted(SESSION);
    assert.equal(bus.getTurnOwner(SESSION), "peer");
    bus.noteTurnEnded(SESSION);
    assert.equal(bus.getTurnOwner(SESSION), null);
  });

  it("explicit owner overrides the pending owner", () => {
    const { bus } = createBus();
    bus.enqueueWorkerSettled({
      parentSessionId: SESSION,
      ...settled("w1"),
    });
    bus.noteTurnStarted(SESSION, "user");
    assert.equal(bus.getTurnOwner(SESSION), "user");
  });

  it("noteTurnStarted with no pending owner fails closed to user", () => {
    const { bus } = createBus();
    bus.noteTurnStarted(SESSION);
    assert.equal(bus.getTurnOwner(SESSION), "user");
  });

  it("cancelTurn clears the turn and ready wake without flushing or delivering", () => {
    const { bus, delivered } = createBus();
    // Mid-turn work queued for a turn that is ending with the activation.
    bus.noteTurnStarted(SESSION);
    bus.enqueueWorkerSettled({
      parentSessionId: SESSION,
      ...settled("w-mid"),
    });
    assert.deepEqual(delivered, []);

    bus.cancelTurn(SESSION);
    assert.equal(bus.isBusy(SESSION), false);
    assert.equal(bus.getTurnOwner(SESSION), null);
    assert.equal(bus.peek(SESSION), undefined);
    assert.deepEqual(delivered, [], "cancelTurn never opens a turn");

    // An already-ready wake is cleared without being re-delivered.
    bus.enqueueWorkerSettled({
      parentSessionId: "idle-session",
      ...settled("w-ready"),
    });
    assert.deepEqual(delivered, ["idle-session"]);
    assert.ok(bus.peek("idle-session"));
    bus.cancelTurn("idle-session");
    assert.equal(bus.peek("idle-session"), undefined);
    assert.deepEqual(delivered, ["idle-session"]);
  });
});
