/**
 * Dispatcher visibility — the ONE ancestry/workspace rule shared by the prompt
 * peer roster and \`message_agent\` (\`Multitask.sendPeer\`).
 *
 * Scope of this file (bounded slice):
 * 1. the pure predicate, including Windows cwd normalization and fail-closed
 *    missing-cwd behavior;
 * 2. \`sendPeer\` refusing a hidden target with the existing \`unknown-target\`
 *    shape (no existence leak) while still accepting allowed peers;
 * 3. \`message_agent\` using that same fence;
 * 4. \`peerRosterFor\` filtering through \`multitask.canSeePeer\` — the SAME
 *    method — plus one focused assertion that roster and message_agent agree;
 * 5. the narrow \`CordisDshHost.dispatcherCwdOf\` accessor the plugin wiring
 *    reads (live header cwd only, never a durable cwd field).
 *
 * Offline fakes only (S8): no network, no LLM, no live dsh.
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
  type CordisDshHost,
  type CreateAgentOptionsLike,
} from "../src/adapter/cordis-dsh-host.js";
import {
  bindDispatcherLifecycle,
  type BindDispatcherLifecycleResult,
} from "../src/adapter/parent-agent.js";
import {
  canSeeDispatcherPeer,
  normalizeWorkspaceCwd,
  sameWorkspace,
  type DispatcherVisibilityNode,
} from "../src/core/dispatcher-visibility.js";
import type { DshHost } from "../src/core/dsh-host.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import type { PeerEnvelope, PeerSendAck } from "../src/core/peer-types.js";
import {
  MESSAGE_AGENT_TOOL,
  PEER_ROSTER_SECTION_HEADING,
} from "../src/core/policy/prompts.js";
import {
  createDispatcherTools,
  type DispatcherToolDef,
} from "../src/core/tools.js";
import type { MessageAgentToolResult } from "../src/core/tool-results.js";

/** A node with only the facts a case needs. */
function node(
  sessionId: string,
  parentSessionId?: string,
  cwd?: string,
  marked?: boolean,
): DispatcherVisibilityNode {
  return {
    sessionId,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(marked === undefined ? {} : { marked }),
  };
}

function sees(
  viewer: DispatcherVisibilityNode,
  target: DispatcherVisibilityNode,
): boolean {
  return canSeeDispatcherPeer(viewer, target);
}

describe("dispatcher visibility predicate — roots", () => {
  it("a root sees its own direct child team leader", () => {
    assert.equal(
      sees(node("root", undefined, "C:\\work"), node("leader", "root", "C:\\work")),
      true,
    );
  });

  it("a root sees another root in the same workspace, normalized", () => {
    assert.equal(
      sees(node("root-a", undefined, "C:\\Work"), node("root-b", undefined, "c:/work/")),
      true,
    );
    assert.equal(sameWorkspace("C:\\Work\\", "c:/work"), true);
  });

  it("a root does not see another root's child, or its own grandchild", () => {
    assert.equal(
      sees(node("root-a", undefined, "C:\\work"), node("other-leader", "root-b", "C:\\work")),
      false,
    );
    // A grandchild's dispatcher parent is the child, never the root.
    assert.equal(
      sees(node("root-a", undefined, "C:\\work"), node("grandchild", "leader-a", "C:\\work")),
      false,
    );
  });

  it("a root does not see another root in a different or unknown workspace", () => {
    assert.equal(
      sees(node("root-a", undefined, "C:\\work"), node("root-c", undefined, "D:\\other")),
      false,
    );
    assert.equal(
      sees(node("root-a", undefined, "C:\\work"), node("root-unknown", undefined)),
      false,
    );
    assert.equal(
      sees(node("root-unknown", undefined), node("root-b", undefined, "C:\\work")),
      false,
    );
    assert.equal(
      sees(node("root-blank", undefined, "   "), node("root-b", undefined, "C:\\work")),
      false,
    );
  });

  it("never sees itself", () => {
    assert.equal(sees(node("root", undefined, "C:\\work"), node("root", undefined, "C:\\work")), false);
    assert.equal(sees(node("leader", "root"), node("leader", "root")), false);
  });
});

describe("dispatcher visibility predicate — team leaders", () => {
  const leader = node("leader-a", "root-a", "C:\\work");

  it("sees its parent, its siblings, and its own direct child", () => {
    assert.equal(sees(leader, node("root-a", undefined, "C:\\work")), true, "parent");
    assert.equal(sees(leader, node("sibling", "root-a")), true, "sibling");
    assert.equal(sees(leader, node("own-child", "leader-a")), true, "own child");
  });

  it("does not see an unrelated dispatcher or another team", () => {
    assert.equal(sees(leader, node("root-b", undefined, "C:\\work")), false, "unrelated root, same cwd");
    assert.equal(sees(leader, node("root-c", undefined, "D:\\other")), false, "unrelated root");
    assert.equal(sees(leader, node("other-leader", "root-c")), false, "another team leader");
    assert.equal(sees(leader, node("other-team-child", "other-leader")), false, "another team's child");
  });

  it("does not see a grandparent", () => {
    const grandparent = node("grand", undefined, "C:\\work");
    const parent = node("middle", "grand");
    const leaf = node("leaf", "middle");
    assert.equal(sees(leaf, grandparent), false);
    assert.equal(sees(leaf, parent), true);
  });

  it("does not need cwd on lineage edges", () => {
    // The spawn cwd is inherited; absent header cwd cannot hide a parent/child
    // edge the durable parent mark proves.
    assert.equal(sees(node("leader-a", "root-a"), node("root-a", undefined)), true);
    assert.equal(sees(node("root-a", undefined), node("leader-a", "root-a")), true);
  });
});

describe("dispatcher visibility predicate — marked parentless (unknown lineage)", () => {
  // Pre-138 legacy row or a torn/empty parent: the session is durably a
  // dispatcher, but its summoner is not recorded. It must never inherit root
  // rights just because the parent is missing.
  const orphan = node("orphan-leader", undefined, "C:\\work", true);
  const root = node("root-a", undefined, "C:\\work");
  const child = node("orphan-child", "orphan-leader", "C:\\work");

  it("is hidden from a same-cwd root, which also sees no root peer in it", () => {
    assert.equal(sees(root, orphan), false, "root → marked parentless");
    assert.equal(sees(orphan, root), false, "marked parentless → root");
  });

  it("sees its own direct child but not a root peer", () => {
    assert.equal(sees(orphan, child), true, "own child");
    assert.equal(sees(orphan, node("root-b", undefined, "C:\\work")), false, "root peer");
    assert.equal(sees(orphan, node("other-child", "root-b", "C:\\work")), false, "another root's child");
  });

  it("its child still sees and reaches it through the parent edge", () => {
    assert.equal(sees(child, orphan), true);
  });

  it("a marked leader WITH a parent is unchanged, and unmarked roots still peer", () => {
    const leader = node("leader", "root-a", "C:\\work", true);
    const root = node("root-a", undefined, "C:\\work");
    assert.equal(sees(leader, root), true, "leader → parent");
    assert.equal(sees(root, leader), true, "root → own marked child");
    assert.equal(sees(root, node("root-b", undefined, "C:\\work", false)), true);
  });
});

describe("workspace normalization", () => {
  it("is case-insensitive and separator-insensitive on Windows paths", () => {
    assert.equal(normalizeWorkspaceCwd("C:\\Work\\"), "c:\\work");
    assert.equal(normalizeWorkspaceCwd("c:/work"), "c:\\work");
    assert.equal(sameWorkspace("C:\\Work\\", "c:/work/"), true);
  });

  it("keeps POSIX paths case-sensitive and strips the trailing separator", () => {
    assert.equal(normalizeWorkspaceCwd("/srv/work/"), "/srv/work");
    assert.equal(sameWorkspace("/srv/work/", "/srv/work"), true);
    assert.equal(sameWorkspace("/srv/work", "/srv/Work"), false);
  });

  it("treats absent/blank cwd as unknown", () => {
    assert.equal(normalizeWorkspaceCwd(undefined), undefined);
    assert.equal(normalizeWorkspaceCwd(""), undefined);
    assert.equal(normalizeWorkspaceCwd("  "), undefined);
    assert.equal(sameWorkspace(undefined, undefined), false);
  });
});

/** One envelope from \`fromAgentId\` to \`toAgentId\`. */
function envelope(fromAgentId: string, toAgentId: string, messageId: string): PeerEnvelope {
  return {
    messageId,
    fromAgentId,
    fromName: fromAgentId,
    to: { kind: "agent", agentId: toAgentId },
    conversationId: "direct",
    text: "hello",
    priority: false,
    createdAtMs: 1_700_000_000_000,
  };
}

function refused(ack: PeerSendAck): Extract<PeerSendAck, { ok: false }> {
  assert.equal(ack.ok, false);
  if (ack.ok) throw new Error("unreachable");
  assert.equal(ack.reason, "unknown-target");
  return ack;
}

describe("Multitask.canSeePeer and sendPeer", () => {
  it("defaults to true when no callback is wired, and fails closed when it throws", () => {
    const bare = createMultitask(new FakeDshHost());
    assert.equal(bare.canSeePeer("a", "b"), true);
    assert.equal(bare.canSeePeer("a", "a"), false, "self is never visible");

    const guarded = createMultitask(new FakeDshHost(), {
      canSeePeer: () => {
        throw new Error("host read exploded");
      },
    });
    assert.equal(guarded.canSeePeer("a", "b"), false);
  });

  it("refuses a hidden target with the existing unknown-target shape and queues nothing", () => {
    const host = new FakeDshHost();
    const nodes = new Map<string, DispatcherVisibilityNode>([
      ["root-a", node("root-a", undefined, "C:\\work")],
      ["root-b", node("root-b", undefined, "C:\\work")],
      ["child-b", node("child-b", "root-b", "C:\\work")],
    ]);
    const multitask = createMultitask(host, {
      isLiveDispatcherSession: () => true,
      canSeePeer: (from, to) =>
        canSeeDispatcherPeer(
          nodes.get(from) ?? node(from),
          nodes.get(to) ?? node(to),
        ),
    });

    const hidden = refused(
      multitask.sendPeer("child-b", envelope("root-a", "child-b", "m-hidden")),
    );
    const unknown = refused(
      multitask.sendPeer("nobody", envelope("root-a", "nobody", "m-unknown")),
    );
    // The refusal must look exactly like a nonexistent target: no leak that
    // "child-b" exists.
    assert.equal(
      hidden.detail,
      unknown.detail?.replace('"nobody"', '"child-b"'),
    );
    assert.equal(multitask.peerInbox.pendingCount("child-b"), 0);
    assert.deepEqual(host.wakeCalls, []);

    const allowed = multitask.sendPeer("root-b", envelope("root-a", "root-b", "m-allowed"));
    assert.equal(allowed.ok, true);
    assert.equal(multitask.peerInbox.pendingCount("root-b"), 1);
  });
});

/**
 * The lifecycle + message_agent rig. The visibility callback is wired the way
 * the plugin wires it: parent from the dispatcher mark, cwd from the live
 * session header (both faked here), then the ONE pure predicate.
 */
const NODES: readonly DispatcherVisibilityNode[] = [
  node("root-a", undefined, "C:\\Work"),
  node("root-b", undefined, "c:/work/"),
  node("root-c", undefined, "D:\\Other"),
  node("leader-a", "root-a", "C:\\Work"),
  node("leader-a-sibling", "root-a", "C:\\Work"),
  node("leader-b", "root-b", "C:\\Work"),
  node("child-a", "leader-a", "C:\\Work"),
  node("child-b", "leader-b", "C:\\Work"),
];

interface StubAgent extends AgentLike {
  readonly injected: unknown[];
}

function createStubAgent(entry: DispatcherVisibilityNode): StubAgent {
  const injected: unknown[] = [];
  return {
    // A summoned team leader is a stock TOP-LEVEL session (ADR-0032): no
    // header.parentSession. The durable mark is the parent source below.
    session: {
      id: entry.sessionId,
      header: { delegationDepth: 0, ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }) },
    },
    injected,
    inject(message: unknown) {
      injected.push(message);
    },
    followup() {},
  } as unknown as StubAgent;
}

function createVisibilityHost(
  entries: readonly DispatcherVisibilityNode[],
  markedIds: ReadonlySet<string> = new Set(),
): CordisDshHost {
  const parentIds = new Map<string, string>();
  const cwds = new Map<string, string>();
  for (const entry of entries) {
    if (entry.parentSessionId !== undefined) {
      parentIds.set(entry.sessionId, entry.parentSessionId);
    }
    if (entry.cwd !== undefined) cwds.set(entry.sessionId, entry.cwd);
  }
  const bound = new Map<string, AgentLike>();
  const host = {
    async spawnWorker(): Promise<string> {
      return "stub-worker";
    },
    async spawnDispatcher() {
      return { dispatcherId: "stub-dispatcher" };
    },
    async interruptWorker(): Promise<void> {},
    async sendMessage(): Promise<void> {},
    onWorkerSettled(): void {},
    onStepBoundary(): void {},
    async requestDispatcherWakeup(): Promise<void> {},
    dispatcherParentOf(sessionId: string): string | undefined {
      return parentIds.get(sessionId);
    },
    dispatcherCwdOf(sessionId: string): string | undefined {
      return cwds.get(sessionId);
    },
    isDurablyMarkedDispatcher(sessionId: string): boolean {
      return markedIds.has(sessionId);
    },
    bindParent(agent: AgentLike, sessionId: string): void {
      bound.set(sessionId, agent);
    },
    unbindParent(sessionId?: string): void {
      if (sessionId === undefined) bound.clear();
      else bound.delete(sessionId);
    },
    hasParent(): boolean {
      return bound.size > 0;
    },
    parentAgentOf(sessionId: string): AgentLike | undefined {
      return bound.get(sessionId);
    },
    listLiveJobs: () => [],
    markers: undefined,
    workerIdOf: () => undefined,
    owns: () => false,
    peerToolActivity: () => null,
    emitStepBoundary(): void {},
    dispose(): void {},
  };
  return host as unknown as CordisDshHost;
}

interface StubCtx extends AdapterContext {
  emit(name: string, ...payload: unknown[]): void;
}

function createStubCtx(): StubCtx {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const ctx = {
    on(name: string, cb: (...args: never[]) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((entry) => entry !== cb),
        );
      };
    },
    emit(name: string, ...payload: unknown[]): void {
      for (const cb of listeners.get(name) ?? []) {
        (cb as (...args: unknown[]) => void)(...payload);
      }
    },
    subagents: {
      async startActivation(_spec: ActivationSpecLike): Promise<ActivationLike> {
        throw new Error("this rig never spawns through startActivation");
      },
      interrupt() {},
      async sendMessage() {
        return "stub-message";
      },
    },
    agents: {
      get: () => undefined,
      async create(_options: CreateAgentOptionsLike): Promise<AgentHandleLike> {
        throw new Error("this rig never creates sessions");
      },
    },
    jobs: { list: () => [] },
    storageDomain: {},
  };
  return ctx as unknown as StubCtx;
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

interface Rig {
  readonly ctx: StubCtx;
  readonly host: CordisDshHost;
  readonly multitask: Multitask;
  readonly lifecycle: BindDispatcherLifecycleResult;
  readonly agents: Map<string, StubAgent>;
  /** The roster block of one session's newest reminder ("" when absent). */
  rosterOf(sessionId: string): string;
  /** Drive one message_agent call from a sender session. */
  messageAgent(
    senderSessionId: string,
    target: string,
    text: string,
  ): Promise<MessageAgentToolResult>;
}

interface RigOptions {
  /** Extra sessions beyond {@link NODES}. */
  readonly extraNodes?: readonly DispatcherVisibilityNode[];
  /** Session ids the fake warm mark mirror reports as durably marked. */
  readonly marked?: readonly string[];
}

function createRig(options?: RigOptions): Rig {
  const ctx = createStubCtx();
  const entries = [...NODES, ...(options?.extraNodes ?? [])];
  const host = createVisibilityHost(
    entries,
    new Set(options?.marked ?? []),
  );
  // Exactly the plugin's wiring: parent from the durable mark, cwd from the
  // live header, mark presence from the warm mirror, then the one pure
  // predicate.
  const visibilityNode = (sessionId: string): DispatcherVisibilityNode =>
    node(
      sessionId,
      host.dispatcherParentOf(sessionId),
      host.dispatcherCwdOf(sessionId),
      host.isDurablyMarkedDispatcher(sessionId),
    );
  const multitask = createMultitask(host as unknown as DshHost, {
    isLiveDispatcherSession: () => true,
    canSeePeer: (fromSessionId, toSessionId) =>
      canSeeDispatcherPeer(
        visibilityNode(fromSessionId),
        visibilityNode(toSessionId),
      ),
  });
  const lifecycle: BindDispatcherLifecycleResult = bindDispatcherLifecycle(
    ctx,
    host,
    multitask,
    { policyEnabled: true },
  );

  const agents = new Map<string, StubAgent>();
  for (const entry of entries) {
    const agent = createStubAgent(entry);
    agents.set(entry.sessionId, agent);
    assert.equal(lifecycle.activate(agent).ok, true);
  }

  const toolsBySender = new Map<string, DispatcherToolDef>();
  const messageAgentTool = (senderSessionId: string): DispatcherToolDef => {
    const cached = toolsBySender.get(senderSessionId);
    if (cached !== undefined) return cached;
    const tool = createDispatcherTools({
      multitask,
      getSessionId: () => senderSessionId,
      now: () => 1_000_000,
    }).find((definition) => definition.name === MESSAGE_AGENT_TOOL);
    assert.ok(tool, "message_agent is registered");
    toolsBySender.set(senderSessionId, tool);
    return tool;
  };

  return {
    ctx,
    host,
    multitask,
    lifecycle,
    agents,
    rosterOf(sessionId: string): string {
      const agent = agents.get(sessionId);
      assert.ok(agent, `no stub agent ${sessionId}`);
      const before = agent.injected.length;
      ctx.emit("agent/status", { agent, status: "running" });
      assert.ok(
        agent.injected.length > before,
        `no turn reminder injected for ${sessionId}`,
      );
      const text = textOf(agent.injected.at(-1));
      const at = text.indexOf(PEER_ROSTER_SECTION_HEADING);
      return at < 0 ? "" : text.slice(at);
    },
    messageAgent(senderSessionId, target, text) {
      return messageAgentTool(senderSessionId).execute({
        target,
        text,
      }) as Promise<MessageAgentToolResult>;
    },
  };
}

/**
 * A durably marked session with NO recorded parent: pre-138 legacy row, or a
 * torn/empty parent. It is unknown lineage, not a root.
 */
const ORPHAN_NODES: readonly DispatcherVisibilityNode[] = [
  node("orphan-leader", undefined, "C:\\Work", true),
  node("orphan-child", "orphan-leader", "C:\\Work"),
];

function createOrphanRig(): Rig {
  return createRig({ extraNodes: ORPHAN_NODES, marked: ["orphan-leader"] });
}

/** Row ids from a rendered roster block (labels are absent in this rig). */
function rosterIds(roster: string): string[] {
  return roster
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).split(" ")[0] ?? "");
}

function expectRows(roster: string, expected: readonly string[]): void {
  assert.deepEqual([...rosterIds(roster)].sort(), [...expected].sort(), roster);
}

function expectMessageRefused(
  result: MessageAgentToolResult,
  reason: "unknown-target" | "self-target" | "rate-limited",
): void {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) return;
  assert.equal(result.reason, reason);
}

describe("peerRosterFor — the roster filters through multitask.canSeePeer", () => {
  it("a root roster keeps same-workspace roots and own children, hides another team", () => {
    const rig = createRig();
    try {
      const roster = rig.rosterOf("root-a");
      expectRows(roster, ["leader-a", "leader-a-sibling", "root-b"]);
      assert.ok(!roster.includes("root-c"), roster);
      assert.ok(!roster.includes("leader-b"), roster);
      assert.ok(!roster.includes("child-a"), "own grandchild must not be listed");
      assert.ok(!roster.includes("child-b"), roster);
    } finally {
      rig.lifecycle.unbind();
    }
  });

  it("a team-leader roster keeps parent, sibling, own child — nothing else", () => {
    const rig = createRig();
    try {
      const roster = rig.rosterOf("leader-a");
      expectRows(roster, ["root-a", "leader-a-sibling", "child-a"]);
      assert.ok(!roster.includes("root-b"), roster);
      assert.ok(!roster.includes("leader-b"), "another team must not be listed");
      assert.ok(!roster.includes("child-b"), roster);
    } finally {
      rig.lifecycle.unbind();
    }
  });

  it("the prompt roster and message_agent share the same rule for the same pair", async () => {
    const rig = createRig();
    try {
      // Hidden pair: absent from the roster AND refused by message_agent.
      const rootRoster = rig.rosterOf("root-a");
      assert.ok(!rosterIds(rootRoster).includes("child-b"));
      const hiddenSend = await rig.messageAgent("root-a", "child-b", "not visible");
      expectMessageRefused(hiddenSend, "unknown-target");

      // Allowed pair: present in the roster AND accepted by message_agent.
      assert.ok(rosterIds(rootRoster).includes("root-b"));
      const allowedSend = await rig.messageAgent("root-a", "root-b", "visible peer");
      assert.equal(allowedSend.ok, true, JSON.stringify(allowedSend));
      if (!allowedSend.ok) return;
      assert.equal(allowedSend.delivered_as, "peer");
      assert.equal(rig.multitask.peerInbox.pendingCount("root-b"), 1);
      assert.equal(rig.multitask.peerInbox.pendingCount("child-b"), 0);
    } finally {
      rig.lifecycle.unbind();
    }
  });
});

describe("message_agent — the shared visibility fence", () => {
  it("a root trying another root's child gets unknown-target", async () => {
    const rig = createRig();
    try {
      const result = await rig.messageAgent("root-a", "child-b", "hey");
      expectMessageRefused(result, "unknown-target");
      assert.equal(rig.multitask.peerInbox.pendingCount("child-b"), 0);
    } finally {
      rig.lifecycle.unbind();
    }
  });

  it("a team leader trying an unrelated dispatcher gets unknown-target", async () => {
    const rig = createRig();
    try {
      const result = await rig.messageAgent("leader-a", "root-b", "hey");
      expectMessageRefused(result, "unknown-target");
      assert.equal(rig.multitask.peerInbox.pendingCount("root-b"), 0);
    } finally {
      rig.lifecycle.unbind();
    }
  });

  it("a marked parentless leader is hidden from a same-cwd root, cannot see a root peer, but its child still reaches it", async () => {
    const rig = createOrphanRig();
    try {
      // Neither surface leaks it to the same-cwd root...
      assert.ok(
        !rosterIds(rig.rosterOf("root-a")).includes("orphan-leader"),
        "root roster must not list the unknown-lineage leader",
      );
      const hidden = await rig.messageAgent("root-a", "orphan-leader", "hey");
      expectMessageRefused(hidden, "unknown-target");
      assert.equal(rig.multitask.peerInbox.pendingCount("orphan-leader"), 0);

      // ...and it cannot act as a root toward a same-cwd root peer.
      const peerHidden = await rig.messageAgent("orphan-leader", "root-b", "hey");
      expectMessageRefused(peerHidden, "unknown-target");
      assert.equal(rig.multitask.peerInbox.pendingCount("root-b"), 0);

      // Its own team is still reachable in both directions.
      expectRows(rig.rosterOf("orphan-leader"), ["orphan-child"]);
      const toChild = await rig.messageAgent("orphan-leader", "orphan-child", "to child");
      assert.equal(toChild.ok, true, JSON.stringify(toChild));
      const childToOrphan = await rig.messageAgent("orphan-child", "orphan-leader", "to parent");
      assert.equal(childToOrphan.ok, true, JSON.stringify(childToOrphan));
      assert.equal(rig.multitask.peerInbox.pendingCount("orphan-child"), 1);
      assert.equal(rig.multitask.peerInbox.pendingCount("orphan-leader"), 1);
    } finally {
      rig.lifecycle.unbind();
    }
  });

  it("allowed parent, sibling, and child sends still work", async () => {
    const rig = createRig();
    try {
      const parent = await rig.messageAgent("leader-a", "root-a", "to parent");
      assert.equal(parent.ok, true, JSON.stringify(parent));
      const sibling = await rig.messageAgent("leader-a", "leader-a-sibling", "to sibling");
      assert.equal(sibling.ok, true, JSON.stringify(sibling));
      const child = await rig.messageAgent("leader-a", "child-a", "to own child");
      assert.equal(child.ok, true, JSON.stringify(child));
      for (const target of ["root-a", "leader-a-sibling", "child-a"]) {
        assert.equal(rig.multitask.peerInbox.pendingCount(target), 1, target);
      }
    } finally {
      rig.lifecycle.unbind();
    }
  });
});

/** Minimal registry context for the REAL host accessor. */
function createAgentRegistryCtx(
  agents: Map<string, AgentLike>,
): AdapterContext {
  const ctx = {
    on() {
      return () => {};
    },
    subagents: {
      async startActivation(): Promise<ActivationLike> {
        throw new Error("unused");
      },
      interrupt() {},
      async sendMessage() {
        return "unused";
      },
    },
    agents: {
      get(id: unknown): AgentLike | undefined {
        const key = String(id);
        if (key === "throws") throw new Error("registry exploded");
        return agents.get(key);
      },
    },
    jobs: { list: () => [] },
    storageDomain: {},
  };
  return ctx as unknown as AdapterContext;
}

describe("CordisDshHost.dispatcherCwdOf — live header cwd only", () => {
  it("answers the live header cwd and undefined when unknown or unreadable", () => {
    const agents = new Map<string, AgentLike>([
      [
        "root-a",
        { session: { id: "root-a", header: { delegationDepth: 0, cwd: "C:\\Work" } }, followup() {} },
      ],
      [
        "blank",
        { session: { id: "blank", header: { delegationDepth: 0, cwd: "  " } }, followup() {} },
      ],
      [
        "no-cwd",
        { session: { id: "no-cwd", header: { delegationDepth: 0 } }, followup() {} },
      ],
    ]);
    const host = createCordisDshHost(createAgentRegistryCtx(agents));
    assert.equal(host.dispatcherCwdOf("root-a"), "C:\\Work");
    assert.equal(host.dispatcherCwdOf("missing"), undefined);
    assert.equal(host.dispatcherCwdOf("blank"), undefined);
    assert.equal(host.dispatcherCwdOf("no-cwd"), undefined);
    assert.equal(host.dispatcherCwdOf("throws"), undefined);
  });
});
