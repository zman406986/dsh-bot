/**
 * Lane C2a/C3 — the automatic final-answer push from a spawned team leader to
 * the dispatcher that summoned it, over the EXISTING peer lane.
 *
 * What this file pins, against the real host + real core + the real lifecycle
 * listener (the same fake-host/lifecycle harness the other adapter suites use;
 * no live dsh, no LLM):
 *
 * 1. text-change dedupe: a new answer pushes, a repeat idle with the same
 *    text is a no-op, and the leader's text is preserved verbatim;
 * 2. an interim progress idle pushes, and a later final idle with different
 *    text pushes a second envelope (one-push-per-episode is gone);
 * 3. only a peer message from the leader's own summoner re-arms the push; a
 *    third-party status/stop wake raises a one-idle hold instead;
 * 4. a successful manual `message_agent` report to the summoner marks its text
 *    reported, so the idle that follows the same text sends nothing;
 * 5. a live worker suppresses the push: that is lane C1's gate, asserted here
 *    so this caller cannot regress it;
 * 6. the stop-reason line: `error` / `max-tokens` add exactly one
 *    `Leader ended: <reason>.` line — inline with a changed answer or alone
 *    after a text push — even while a ledger obligation is still open, and
 *    `completed` adds none;
 * 7. never upward from the human's own dispatcher (C1's spawned gate plus the
 *    pusher's defensive class read), never with no recorded summoner;
 * 8. the delivery is a PEER envelope — the parent gets no plugin notice row
 *    and no injected plugin message.
 *
 * The parent id is whatever `CordisDshHost.dispatcherParentOf` answers: a
 * SESSION id. `sendPeer` and the `message_agent` handler both address peers
 * by session id, so nothing here maps a session id to an agent id.
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
  type ToolsLike,
} from "../src/adapter/cordis-dsh-host.js";
import {
  bindDispatcherLifecycle,
  type BindDispatcherLifecycleResult,
} from "../src/adapter/parent-agent.js";
import {
  createInMemoryDurability,
  type InMemoryDurability,
} from "../src/core/durability.js";
import type { DshHost } from "../src/core/dsh-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import type { PeerEnvelope } from "../src/core/peer-types.js";
import type { DispatcherOrigin } from "../src/core/policy/prompts.js";
import { createTeamLeaderPusher, type TeamLeaderPusher } from "../src/plugin.js";
import { createWorkerAgentDef } from "../src/worker/agent-def.js";

const PARENT = "disp-parent";
const LEADER = "team-leader-1";
const CHILD = "stock-child-1";
const ORPHAN = "team-leader-no-parent";
const USER_DISPATCHER = "user-dispatch-1";

interface StubAgent extends AgentLike {
  readonly injected: unknown[];
  readonly followups: unknown[];
  readonly appended: Array<{ readonly type: string; readonly data: unknown }>;
}

/** One agent handle: the narrow surface the lifecycle/host read, plus recorders. */
function createAgent(
  id: string,
  header: Record<string, unknown> = { delegationDepth: 0 },
): StubAgent {
  const injected: unknown[] = [];
  const followups: unknown[] = [];
  const appended: Array<{ type: string; data: unknown }> = [];
  return {
    session: {
      id,
      header,
      append(type: string, data: unknown) {
        appended.push({ type, data });
        return undefined;
      },
    },
    injected,
    followups,
    appended,
    followup(message: unknown) {
      followups.push(message);
    },
    inject(message: unknown) {
      injected.push(message);
      return undefined;
    },
  } as unknown as StubAgent;
}

interface Composed {
  sections: string[];
  restrictions: Array<{ deny?: readonly string[]; allow?: readonly string[] }>;
  localTools: unknown[];
}

type StubCtx = AdapterContext & {
  fire(name: string, ...payloads: unknown[]): void;
  bindAgent(agent: AgentLike): void;
};

/** The parts of the adapter context these paths touch (stock-child rig shape). */
function createStubCtx(agents: Map<string, AgentLike>): StubCtx {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const ctx = {
    fire(name: string, ...payloads: unknown[]): void {
      for (const cb of listeners.get(name) ?? []) {
        (cb as (...args: unknown[]) => void)(...payloads);
      }
    },
    bindAgent(agent: AgentLike): void {
      agents.set(String(agent.session.id), agent);
    },
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
    subagents: {
      async startActivation(_spec: ActivationSpecLike): Promise<ActivationLike> {
        throw new Error("this rig announces children through the event bus");
      },
      interrupt() {},
      async sendMessage() {
        return undefined;
      },
    },
    agents: {
      get(id: unknown): AgentLike | undefined {
        return agents.get(String(id));
      },
      async create(_options: CreateAgentOptionsLike): Promise<AgentHandleLike> {
        throw new Error("this rig never creates sessions");
      },
    },
    jobs: { list: () => [] },
    storageDomain: {},
  };
  return ctx as unknown as StubCtx;
}

/** The child's scoped world, so the stock adoption composition has real seams. */
function createChildScope(composed: Composed): unknown {
  return {
    systemPrompt: {
      section(section: { name: string }) {
        composed.sections.push(section.name);
        return () => {};
      },
      getSectionOrder() {
        return 0;
      },
    },
    tools: {
      schemas(): Array<{ name: string }> {
        return [
          { name: "present" },
          { name: "subagent" },
          { name: "check_workers" },
          { name: "deliver_result" },
          { name: "read" },
        ];
      },
      restrict(filter: { deny?: readonly string[]; allow?: readonly string[] }) {
        composed.restrictions.push(filter);
        return () => {};
      },
      register(definition: unknown) {
        composed.localTools.push(definition);
        return () => {};
      },
    } as ToolsLike,
  };
}

interface Rig {
  readonly ctx: StubCtx;
  readonly host: CordisDshHost;
  readonly multitask: Multitask;
  readonly lifecycle: BindDispatcherLifecycleResult;
  readonly pusher: TeamLeaderPusher;
  readonly durability: InMemoryDurability;
  readonly classBySession: Map<string, DispatcherOrigin>;
  readonly parent: StubAgent;
  readonly leader: StubAgent;
  readonly child: StubAgent;
  readonly orphan: StubAgent;
  readonly userDispatcher: StubAgent;
  readonly warnings: string[];
  activate(agent: StubAgent, origin?: DispatcherOrigin): void;
  dispose(): void;
}

/**
 * The harness. Every piece below mirrors its `src/plugin.ts` counterpart:
 * the host hooks are the plugin's three reset points, the wakeup wrapper is
 * the plugin's peer-wake classification, and the lifecycle receives the
 * plugin's `onTeamLeaderIdle`. The parent mark row is the record a spawn
 * writes (lane C4's `dispatcherParentOf` source) — seeded here instead of
 * running a spawn.
 */
function createRig(options?: { seedLeaderMark?: boolean }): Rig {
  const durability = createInMemoryDurability();
  if (options?.seedLeaderMark !== false) {
    durability.dispatcherMarks.set(LEADER, {
      sessionId: LEADER,
      parentSessionId: PARENT,
      generation: 2,
    });
    durability.dispatcherMarks.set(USER_DISPATCHER, {
      sessionId: USER_DISPATCHER,
      parentSessionId: PARENT,
      generation: 2,
    });
  }
  const agents = new Map<string, AgentLike>();
  const ctx = createStubCtx(agents);
  const warnings: string[] = [];
  const classBySession = new Map<string, DispatcherOrigin>();
  const parent = createAgent(PARENT);
  const leader = createAgent(LEADER);
  const orphan = createAgent(ORPHAN);
  const userDispatcher = createAgent(USER_DISPATCHER);
  const composed: Composed = { sections: [], restrictions: [], localTools: [] };
  const child = {
    session: {
      id: CHILD,
      header: {
        parentSession: LEADER,
        delegationDepth: 1,
        origin: "subagent",
      },
    },
    ctx: createChildScope(composed),
    followup() {},
  } as unknown as StubAgent;
  classBySession.set(PARENT, "user");
  classBySession.set(LEADER, "spawned");

  let multitask: Multitask | undefined;
  const host = createCordisDshHost(ctx, {
    markers: durability,
    workerAgentDef: createWorkerAgentDef("en"),
    workerLocalTools: () => [],
    // The plugin's two worker-appearance resets (stock adoption + the legacy
    // path's re-attach). Both clear the leader's third-party peer hold.
    onStockWorkerAdopted: (workerId, parentSessionId) => {
      multitask?.adoptSpawnedWorker({
        workerId,
        parentSessionId,
        label: "Leader worker",
      });
      pusher?.noteEpisodeReset(parentSessionId);
    },
    onWorkerReattached: (workerId, parentSessionId) => {
      multitask?.reclaimWorker(workerId, parentSessionId);
      pusher?.noteEpisodeReset(parentSessionId);
    },
  });

  // The plugin's DshHost view: peer wakes are classified (lane C3 — only the
  // summoner re-arms) and a legacy worker spawn clears the hold, observed on
  // the same seams the plugin wraps.
  const multitaskHost = Object.create(host) as DshHost;
  multitaskHost.requestDispatcherWakeup = async (sessionId, origin) => {
    // The plugin's lane-C3 wake classification: only the summoner re-arms;
    // any other agent-message holds exactly one idle.
    pusher.noteWakeOrigin(sessionId, origin);
    await host.requestDispatcherWakeup(sessionId, origin);
  };
  const spawnWorkerOnHost = host.spawnWorker.bind(host);
  multitaskHost.spawnWorker = async (prompt, spawnOptions) => {
    const workerId = await spawnWorkerOnHost(prompt, spawnOptions);
    pusher.noteEpisodeReset(spawnOptions.parentSessionId);
    return workerId;
  };

  const core = createMultitask(multitaskHost, {
    durability,
    isLiveDispatcherSession: (sessionId) =>
      lifecycle.isDispatcherSession(sessionId),
    isDurablyMarkedDispatcher: (sessionId) =>
      host.isDurablyMarkedDispatcher(sessionId),
  });
  multitask = core;

  const pusher: TeamLeaderPusher = createTeamLeaderPusher({
    host,
    // The RAW bound method, exactly as the plugin passes it: the pusher must
    // bypass the manual-report observer installed below.
    sendPeer: core.sendPeer.bind(core),
    classOfSession: (sessionId) => classBySession.get(sessionId) ?? null,
    logWarning: (message) => {
      warnings.push(message);
    },
  });

  // The plugin's lane-C3 manual-report observer: a successful leader→summoner
  // peer send marks that text as already reported.
  const rawSendPeer = core.sendPeer.bind(core);
  core.sendPeer = (sessionId, envelope) => {
    const ack = rawSendPeer(sessionId, envelope);
    if (ack.ok) {
      const parentSessionId = host.dispatcherParentOf(envelope.fromAgentId);
      if (
        parentSessionId !== undefined &&
        parentSessionId !== "" &&
        envelope.to.agentId === parentSessionId
      ) {
        pusher.noteManualReport(envelope.fromAgentId, envelope.text);
      }
    }
    return ack;
  };

  // The plugin's third reset point: a real user prompt handled by a leader.
  // The host reports structured user sources on ANY session (ticket 117), the
  // same seam the plugin's await-release uses; lane C3 clears the peer hold.
  host.onDispatcherUserMessage((sessionId) => {
    pusher.noteEpisodeReset(sessionId);
  });

  const lifecycle = bindDispatcherLifecycle(ctx, host, core, {
    policyEnabled: false,
    onTeamLeaderIdle: (sessionId, signal) =>
      pusher.onTeamLeaderIdle(sessionId, signal),
  });

  ctx.bindAgent(parent);
  ctx.bindAgent(leader);
  ctx.bindAgent(orphan);
  ctx.bindAgent(userDispatcher);

  const activate = (agent: StubAgent, origin?: DispatcherOrigin): void => {
    const outcome =
      origin === undefined
        ? lifecycle.activate(agent)
        : lifecycle.activate(agent, {
            origin,
            generation: origin === "spawned" ? 2 : 1,
          });
    assert.equal(outcome.ok, true);
  };
  activate(parent, "user");
  activate(leader, "spawned");

  return {
    ctx,
    host,
    multitask: core,
    lifecycle,
    pusher,
    durability,
    classBySession,
    parent,
    leader,
    child,
    orphan,
    userDispatcher,
    warnings,
    activate,
    dispose(): void {
      lifecycle.unbind();
    },
  };
}

/** The leader's committed assistant text (the C1 observer's source). */
function say(rig: Rig, text: string, sessionId: string = LEADER): void {
  rig.ctx.fire(
    "session/event",
    { id: sessionId },
    {
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text }] } },
    },
  );
}

/**
 * The leader's latest turn/end kind (C1's stop-reason source). `seq` is the
 * host's durable per-turn sequence; omitting it exercises the parent's local
 * previous+1 fallback.
 */
function endTurn(rig: Rig, kind: string, seq?: number): void {
  rig.ctx.fire(
    "session/event",
    { id: String(rig.leader.session.id) },
    {
      type: "turn/end",
      ...(seq === undefined ? {} : { seq }),
      data: { reason: { kind } },
    },
  );
}

/** One peer message from `fromSessionId` to the leader, plus its wake drain. */
function peerMessage(
  rig: Rig,
  fromSessionId: string,
  text: string,
  messageId: string,
): void {
  const ack = rig.multitask.sendPeer(LEADER, {
    messageId,
    fromAgentId: fromSessionId,
    fromName: fromSessionId,
    to: { kind: "agent", agentId: LEADER },
    conversationId: "direct",
    text,
    priority: false,
    createdAtMs: 1_700_000_000_000,
  });
  assert.ok(ack.ok);
  rig.multitask.wakeBus.drain(LEADER);
}

/** One real user prompt on the leader's session. */
function userPrompt(rig: Rig): void {
  rig.ctx.fire(
    "session/event",
    { id: String(rig.leader.session.id) },
    // The host's ticket-117 fan-out needs the message shape (role + source);
    // the lifecycle's notice gate only needs the source kind.
    {
      type: "user/message",
      data: { role: "user", source: { kind: "user" } },
    },
  );
}

/** The leader going idle — the only moment C1 calls `onTeamLeaderIdle`. */
function idle(rig: Rig, agent: StubAgent = rig.leader): void {
  rig.ctx.fire("agent/status", { agent, status: "idle" });
}

function announceStockChild(rig: Rig): void {
  rig.ctx.fire("agent/created", { agent: rig.child, source: "startup" });
}

function settleStockChild(rig: Rig): void {
  rig.ctx.fire("subagent/end", {
    id: CHILD,
    stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "worker done" }],
  });
}

/** Envelopes waiting for the parent — one per accepted push. */
function pushesToParent(rig: Rig): readonly PeerEnvelope[] {
  return rig.multitask.listPendingPeers(PARENT);
}

/**
 * Only the pusher's envelopes. A manual `message_agent` report is also a peer
 * envelope waiting for the parent, so a dedupe test must not count it as a
 * push.
 */
function pushesFromPusher(rig: Rig): readonly PeerEnvelope[] {
  return pushesToParent(rig).filter((envelope) =>
    envelope.messageId.startsWith("agent-"),
  );
}

describe("lane C2a/C3: team-leader final-answer push", () => {
  it("pushes the new answer once, preserving the leader's text verbatim", () => {
    const rig = createRig();
    try {
      const answer = "Audited the widget.\nOne migration is still risky.";
      // Activation may have appended its own confirmation row (ticket 295);
      // what must not grow is the surface across the PUSH.
      const appendsBefore = rig.parent.appended.length;
      const injectsBefore = rig.parent.injected.length;
      say(rig, `  ${answer}  `);
      idle(rig);

      const first = pushesToParent(rig);
      assert.equal(first.length, 1);
      const envelope = first[0];
      assert.ok(envelope !== undefined);
      assert.equal(envelope.text, answer);
      assert.equal(envelope.fromAgentId, LEADER);
      assert.deepEqual(envelope.to, { kind: "agent", agentId: PARENT });
      assert.equal(envelope.priority, false);
      assert.match(envelope.messageId, /^agent-/);
      assert.equal(typeof envelope.createdAtMs, "number");

      // Not a plugin notice: the push adds no surface row and no injected
      // plugin message, and no appended row carries the leader's text.
      assert.equal(rig.parent.appended.length, appendsBefore);
      assert.equal(rig.parent.injected.length, injectsBefore);
      assert.equal(JSON.stringify(rig.parent.appended).includes(answer), false);

      // A second idle carrying the same text is a no-op.
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);
      assert.equal(pushesToParent(rig)[0]?.messageId, envelope.messageId);
      assert.equal(rig.warnings.length, 0);
    } finally {
      rig.dispose();
    }
  });

  it("a new worker adoption allows one more push for the new answer", () => {
    const rig = createRig();
    try {
      say(rig, "First pass is in.");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);

      announceStockChild(rig);
      assert.equal(rig.multitask.listWorkers(LEADER).length, 1);
      // Live worker: lane C1's gate suppresses the push.
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);

      settleStockChild(rig);
      assert.equal(rig.multitask.listWorkers(LEADER)[0]?.status, "completed");
      // Dedupe is the text now: the next answer must actually differ.
      say(rig, "Worker pass is in.");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 2);

      const twice = pushesToParent(rig);
      assert.notEqual(twice[0]?.messageId, twice[1]?.messageId);
      assert.equal(twice[1]?.text, "Worker pass is in.");
      // A repeat idle with the same text is still a no-op.
      idle(rig);
      assert.equal(pushesToParent(rig).length, 2);
    } finally {
      rig.dispose();
    }
  });

  it("retries after a refused send (never marks a failure)", () => {
    const rig = createRig();
    try {
      say(rig, "Answer while the parent is dormant.");
      // The summoner is not a live dispatcher here, so the peer lane refuses
      // with `unknown-target` — the plugin logs and leaves the dedupe marks
      // unchanged, which is what makes the retry below possible.
      rig.lifecycle.deactivate(PARENT);
      idle(rig);
      assert.equal(pushesToParent(rig).length, 0);
      assert.equal(rig.warnings.length, 1);
      assert.match(rig.warnings[0] ?? "", /could not push/);

      rig.activate(rig.parent, "user");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);
      assert.equal(pushesToParent(rig)[0]?.text, "Answer while the parent is dormant.");
      assert.equal(rig.warnings.length, 1);
    } finally {
      rig.dispose();
    }
  });

  it("a summoner peer message clears the way for the next changed answer", () => {
    const rig = createRig();
    try {
      say(rig, "Waiting on the dispatcher.");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);

      const ack = rig.multitask.sendPeer(LEADER, {
        messageId: "peer-from-parent-1",
        fromAgentId: PARENT,
        fromName: PARENT,
        to: { kind: "agent", agentId: LEADER },
        conversationId: "direct",
        text: "Please also check the migration.",
        priority: false,
        createdAtMs: 1_700_000_000_000,
      });
      assert.ok(ack.ok);
      // The wake was delivered through the host seam (the plugin's reset
      // point); the ready turn is drained the way a real wake turn drains it.
      rig.multitask.wakeBus.drain(LEADER);

      say(rig, "Migration checked too.");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 2);
      assert.equal(pushesToParent(rig)[1]?.text, "Migration checked too.");
    } finally {
      rig.dispose();
    }
  });

  it("a real user message clears the way for the next changed answer", () => {
    const rig = createRig();
    try {
      say(rig, "First answer.");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);

      userPrompt(rig);
      say(rig, "Answer after the user spoke.");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 2);
      assert.equal(pushesToParent(rig)[1]?.text, "Answer after the user spoke.");

      idle(rig);
      assert.equal(pushesToParent(rig).length, 2);
    } finally {
      rig.dispose();
    }
  });

  it("a third-party peer status/stop never re-arms the push", () => {
    const rig = createRig();
    try {
      say(rig, "First pass is in.");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);

      // A sibling dispatcher's status/stop wakes the leader. The wake is not
      // from its summoner, so the ack turn is held rather than pushed.
      peerMessage(
        rig,
        USER_DISPATCHER,
        "Status: the sibling team is stopping.",
        "third-party-1",
      );
      say(rig, "Noted.");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);

      // The summoner clears the hold; the next changed answer pushes.
      peerMessage(rig, PARENT, "Please continue.", "summoner-1");
      say(rig, "Continuing with the second lane.");
      idle(rig);
      const pushes = pushesToParent(rig);
      assert.equal(pushes.length, 2);
      assert.equal(pushes[1]?.text, "Continuing with the second lane.");
    } finally {
      rig.dispose();
    }
  });

  it("dedupes a manual message_agent report against the idle that follows", () => {
    const rig = createRig();
    try {
      say(rig, "Audit in progress.");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);

      const reportText = "Interim: the migration is the risky part.";
      const ack = rig.multitask.sendPeer(PARENT, {
        messageId: "manual-report-1",
        fromAgentId: LEADER,
        fromName: LEADER,
        to: { kind: "agent", agentId: PARENT },
        conversationId: "direct",
        text: reportText,
        priority: false,
        createdAtMs: 1_700_000_000_000,
      });
      assert.ok(ack.ok);
      // The leader's own turn repeats the reported text; no second envelope.
      say(rig, `  ${reportText}  `);
      idle(rig);
      assert.equal(pushesFromPusher(rig).length, 1);

      // Only the reported text is deduped — a changed answer still pushes.
      say(rig, "Final: the migration is clean.");
      idle(rig);
      const pushes = pushesFromPusher(rig);
      assert.equal(pushes.length, 2);
      assert.equal(pushes[1]?.text, "Final: the migration is clean.");
    } finally {
      rig.dispose();
    }
  });

  it("sends a stop-line-only envelope once when a later turn fails", () => {
    const rig = createRig();
    try {
      endTurn(rig, "completed", 1);
      say(rig, "Audit done.");
      idle(rig);
      assert.equal(pushesToParent(rig)[0]?.text, "Audit done.");

      // No new assistant text: the old answer must not be pushed again, but
      // the error line is still owed exactly once.
      endTurn(rig, "error", 2);
      idle(rig);
      const pushes = pushesToParent(rig);
      assert.equal(pushes.length, 2);
      assert.equal(pushes[1]?.text, "Leader ended: error.");

      idle(rig);
      assert.equal(pushesToParent(rig).length, 2);
    } finally {
      rig.dispose();
    }
  });

  it("appends the stop line on a changed answer while an obligation is open", () => {
    const rig = createRig();
    try {
      const todo = rig.multitask.createTodo({
        sessionId: LEADER,
        title: "Audit the widget",
      });
      say(rig, "Progress: one lane is still running.");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);
      assert.equal(
        pushesToParent(rig)[0]?.text,
        "Progress: one lane is still running.",
      );

      // The failing turn writes a NEW answer while the ledger still owes the
      // user a result. Audit #4: the open obligation may not suppress the
      // line, so it rides this push inline.
      say(rig, "The audit lane errored before finishing.");
      endTurn(rig, "error", 2);
      idle(rig);

      const open = rig.multitask.todos.get(todo.id);
      assert.equal(open?.delivered, false);
      assert.equal(open?.status, "pending");
      const pushes = pushesToParent(rig);
      assert.equal(pushes.length, 2);
      assert.equal(
        pushes[1]?.text,
        "The audit lane errored before finishing.\nLeader ended: error.",
      );
    } finally {
      rig.dispose();
    }
  });

  it("sends a stop-line-only report while an obligation is open", () => {
    const rig = createRig();
    try {
      const todo = rig.multitask.createTodo({
        sessionId: LEADER,
        title: "Audit the widget",
      });
      endTurn(rig, "completed", 1);
      say(rig, "Audit done.");
      idle(rig);
      assert.equal(pushesToParent(rig)[0]?.text, "Audit done.");

      // No new assistant text: the error line is the whole report, and the
      // open obligation must not swallow it.
      endTurn(rig, "error", 2);
      idle(rig);
      const open = rig.multitask.todos.get(todo.id);
      assert.equal(open?.delivered, false);
      const pushes = pushesToParent(rig);
      assert.equal(pushes.length, 2);
      assert.equal(pushes[1]?.text, "Leader ended: error.");

      idle(rig);
      assert.equal(pushesToParent(rig).length, 2);
    } finally {
      rig.dispose();
    }
  });

  it("pushes an interim text change and then the final answer", () => {
    const rig = createRig();
    try {
      const todo = rig.multitask.createTodo({
        sessionId: LEADER,
        title: "Audit the widget",
      });
      assert.equal(todo.status, "pending");

      say(rig, "Progress: one lane is still running.");
      idle(rig);
      const first = pushesToParent(rig);
      assert.equal(first.length, 1);
      assert.equal(first[0]?.text, "Progress: one lane is still running.");

      // Same text again while the obligation is still open: nothing.
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);

      // Close the obligation; this idle is final and the answer changed.
      assert.equal(rig.multitask.markDelivered(todo.id), true);
      say(rig, "Final: the widget audit passed.");
      idle(rig);
      const pushes = pushesToParent(rig);
      assert.equal(pushes.length, 2);
      assert.equal(pushes[1]?.text, "Final: the widget audit passed.");

      idle(rig);
      assert.equal(pushesToParent(rig).length, 2);
    } finally {
      rig.dispose();
    }
  });

  it("keeps the stop line on a changed answer while an obligation is open", () => {
    const rig = createRig();
    try {
      // The todo stays undelivered for the whole test: obligationsOpen is true
      // on every idle below.
      const todo = rig.multitask.createTodo({
        sessionId: LEADER,
        title: "Audit the widget",
      });

      say(rig, "Progress: one lane is still running.");
      idle(rig);
      assert.equal(pushesToParent(rig).length, 1);

      // The failing turn ends before the leader commits a NEW answer. Audit #4:
      // the open obligation may not drop the line, so it rides this push.
      endTurn(rig, "error", 1);
      say(rig, "The audit lane errored before finishing.");
      idle(rig);

      assert.equal(rig.multitask.todos.get(todo.id)?.delivered, false);
      const pushes = pushesToParent(rig);
      assert.equal(pushes.length, 2);
      assert.equal(
        pushes[1]?.text,
        "The audit lane errored before finishing.\nLeader ended: error.",
      );

      idle(rig);
      assert.equal(pushesToParent(rig).length, 2);
    } finally {
      rig.dispose();
    }
  });

  it("adds the stop-reason line only for a non-completed end", () => {
    const rig = createRig();
    try {
      endTurn(rig, "error");
      say(rig, "Could not finish the audit.");
      idle(rig);
      assert.equal(
        pushesToParent(rig)[0]?.text,
        "Could not finish the audit.\nLeader ended: error.",
      );

      userPrompt(rig);
      endTurn(rig, "max-tokens");
      say(rig, "Partial answer.");
      idle(rig);
      assert.equal(
        pushesToParent(rig)[1]?.text,
        "Partial answer.\nLeader ended: max-tokens.",
      );

      userPrompt(rig);
      endTurn(rig, "completed");
      say(rig, "All done.");
      idle(rig);
      assert.equal(pushesToParent(rig)[2]?.text, "All done.");
    } finally {
      rig.dispose();
    }
  });

  it("never pushes from the human's own dispatcher", () => {
    const rig = createRig();
    try {
      // The mark row DOES name a parent here, so only the class stops this
      // push: C1's spawned-origin gate keeps the callback from firing at all.
      assert.equal(rig.host.dispatcherParentOf(USER_DISPATCHER), PARENT);
      rig.classBySession.set(USER_DISPATCHER, "user");
      rig.activate(rig.userDispatcher, "user");
      say(rig, "This must never travel upward.", USER_DISPATCHER);
      idle(rig, rig.userDispatcher);
      assert.equal(pushesToParent(rig).length, 0);

      // Second lock: a caller that drives the pusher directly still gets no
      // envelope from a session this process classifies as the human's own.
      rig.pusher.onTeamLeaderIdle(USER_DISPATCHER, {
        text: "This must never travel upward.",
        stopReason: null,
      });
      assert.equal(pushesToParent(rig).length, 0);
    } finally {
      rig.dispose();
    }
  });

  it("never pushes when no summoner is recorded", () => {
    const rig = createRig();
    try {
      assert.equal(rig.host.dispatcherParentOf(ORPHAN), undefined);
      rig.classBySession.set(ORPHAN, "spawned");
      rig.activate(rig.orphan, "spawned");
      say(rig, "Nobody summoned me.", ORPHAN);
      idle(rig, rig.orphan);
      assert.equal(pushesToParent(rig).length, 0);
      assert.equal(rig.warnings.length, 0);
    } finally {
      rig.dispose();
    }
  });
});
