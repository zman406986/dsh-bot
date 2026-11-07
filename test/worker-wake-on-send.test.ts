/**
 * Ticket 142 (owner ruling 2026-10-22: "yes bots should be wake-able, both
 * dispatchers and children") — the CHILDREN half, at the CORE layer.
 *
 * What these pins hold:
 * 1. A steer to a worker id with no roster record is ACCEPTED when the
 *    adapter's durable-worker port answers for it, and the correction goes to
 *    `host.wakeDormantWorker` wrapped exactly like a live steer.
 * 2. An id with no durable row keeps the shipped refusal, byte-identical:
 *    `unknown-worker` from `steerWorker`, `unknown-target` from
 *    `message_agent`, no wake, no send.
 * 3. A LIVE worker never touches the dormant path (park + interrupt only).
 * 4. The `worker_sessions` row is written at spawn with the spawning
 *    dispatcher as parent, and dropped on settle, abort, and hold release —
 *    a finished worker must not be woken back (ticket 04).
 * 5. `reclaimWorker` resolves a ticket-59 unknown-state hold into a live
 *    roster record, releasing the stream key and clearing the hold.
 *
 * Offline `FakeDshHost` + in-memory durability only (S8 lane).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createInMemoryDurability } from "../src/core/durability.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import { createDispatcherTools, type DispatcherToolDef } from "../src/core/tools.js";
import { MESSAGE_AGENT_TOOL, STEER_WORKER_TOOL } from "../src/core/policy/prompts.js";
import type { MessageAgentToolResult } from "../src/core/tool-results.js";

const SENDER = "chat-1";

interface Rig {
  readonly host: FakeDshHost;
  readonly multitask: Multitask;
  readonly tools: DispatcherToolDef[];
  readonly exec: (
    args: Record<string, unknown>,
  ) => Promise<MessageAgentToolResult>;
  readonly steer: DispatcherToolDef;
}

function rig(durability = createInMemoryDurability()): Rig {
  const host = new FakeDshHost();
  const multitask = createMultitask(host, {
    durability,
    // The adapter answers both questions from its own mirrors; the core stays
    // agnostic. Wired here exactly as `src/plugin.ts` wires it.
    findDurableWorker: (workerId) => {
      const row = durability.workerSessions.get(workerId);
      return row === undefined ? undefined : { parentSessionId: row.parentSessionId };
    },
    // Ticket 70 §2's peer fence, wired the way the plugin wires it (the
    // activation registry answers; nothing is a live dispatcher here).
    isLiveDispatcherSession: () => false,
  });
  const tools = createDispatcherTools({
    multitask,
    getSessionId: () => SENDER,
    now: () => 1_000_000,
  });
  const messageAgent = tools.find((tool) => tool.name === MESSAGE_AGENT_TOOL);
  const steer = tools.find((tool) => tool.name === STEER_WORKER_TOOL);
  assert.ok(messageAgent, "message_agent is registered");
  assert.ok(steer, "steer_worker is registered");
  return {
    host,
    multitask,
    tools,
    steer,
    exec: (args) => messageAgent.execute(args) as Promise<MessageAgentToolResult>,
  };
}

async function spawnRunning(
  multitask: Multitask,
  streamKey = "s-1",
  title = "Task",
): Promise<string> {
  const spawned = await multitask.spawnWorker({
    parentSessionId: SENDER,
    streamKey,
    title,
    prompt: "Do the work.",
  });
  assert.ok(spawned.ok, spawned.ok ? "" : spawned.detail);
  if (!spawned.ok) throw new Error("unreachable");
  multitask.noteTurnStarted(spawned.workerId);
  return spawned.workerId;
}

describe("ticket 142 — the worker wake mark is durable and has a lifecycle", () => {
  it("is written at spawn with the spawning dispatcher as parent", async () => {
    const durability = createInMemoryDurability();
    const r = rig(durability);
    assert.equal(durability.workerSessions.size, 0);

    const workerId = await spawnRunning(r.multitask, "migrate", "Migration");

    assert.deepEqual(durability.workerSessions.get(workerId), {
      sessionId: workerId,
      parentSessionId: SENDER,
    });
    // The host mirror is in step, which is what the fence actually reads.
    assert.equal(r.host.workerWakes.get(workerId), SENDER);
  });

  it("is dropped on a terminal settle, so a finished worker cannot be woken", async () => {
    const durability = createInMemoryDurability();
    const r = rig(durability);
    const workerId = await spawnRunning(r.multitask);

    r.host.fireSettled({ workerId, status: "completed", report: "Done." });
    assert.equal(durability.workerSessions.has(workerId), false);
    assert.equal(r.host.workerWakes.has(workerId), false);

    // The OBLIGATION marker is untouched — a terminal result may still be
    // owed a delivery (S4, ticket 58). Only the WAKE identity goes.
    assert.equal(durability.markers.has(workerId), true);
  });

  it("is dropped on abort and on an unknown-state hold release", async () => {
    const durability = createInMemoryDurability();
    const r = rig(durability);
    const workerId = await spawnRunning(r.multitask);

    await r.multitask.abortWorker(workerId);
    assert.equal(durability.workerSessions.has(workerId), false);

    // Seed a hold directly (the rebuild path writes one for a live marker).
    const second = createInMemoryDurability();
    second.markers.set("w-held", {
      workerId: "w-held",
      parentSessionId: SENDER,
      streamKey: "held-stream",
      title: "Held",
      status: "running",
      transcriptRef: null,
      todoId: null,
      startedAtMs: 1,
      updatedAtMs: 2,
    });
    second.workerSessions.set("w-held", {
      sessionId: "w-held",
      parentSessionId: SENDER,
    });
    const after = createMultitask(new FakeDshHost(), {
      durability: second,
      findDurableWorker: (workerId) => {
        const row = second.workerSessions.get(workerId);
        return row === undefined ? undefined : { parentSessionId: row.parentSessionId };
      },
    });
    await after.rebuildFromDurability(SENDER);
    assert.equal(after.listUnknownStateHolds(SENDER).length, 1);

    assert.equal(await after.releaseUnknownStateHold("w-held"), true);
    assert.equal(second.workerSessions.has("w-held"), false);
    assert.equal(second.markers.has("w-held"), false);
  });
});

describe("ticket 142 — the steer fence accepts a durably marked dormant worker", () => {
  it("steerWorker accepts it and hands the WRAPPED correction to the wake seam", async () => {
    // A row with no roster record: the worker existed in an earlier process.
    const durability = createInMemoryDurability();
    durability.workerSessions.set("w-dormant", {
      sessionId: "w-dormant",
      parentSessionId: SENDER,
    });
    const host = new FakeDshHost();
    const core = createMultitask(host, {
      durability,
      findDurableWorker: (workerId) => {
        const row = durability.workerSessions.get(workerId);
        return row === undefined ? undefined : { parentSessionId: row.parentSessionId };
      },
    });

    const result = await core.steerWorker("w-dormant", "finish the migration");
    assert.deepEqual(result, { ok: true, dormant: true });

    assert.equal(host.dormantWakeCalls.length, 1);
    const wake = host.dormantWakeCalls[0];
    assert.ok(wake);
    assert.equal(wake.workerId, "w-dormant");
    assert.ok(wake.message.includes("[Parent correction]"));
    assert.ok(wake.message.includes("finish the migration"));
    // Never revived as a live worker by the core itself, and never delivered
    // as if it were live.
    assert.equal(core.getWorker("w-dormant"), undefined);
    assert.deepEqual(host.sendMessageCalls, []);
    assert.deepEqual(host.interruptCalls, []);
    // No row was dropped by the acceptance: the worker is still wake-able for
    // the next send.
    assert.equal(durability.workerSessions.has("w-dormant"), true);
  });

  it("message_agent routes a marked dormant worker to the steer lane, not the peer lane", async () => {
    // A durable row for an id with no roster record (a restart's shape).
    const durability = createInMemoryDurability();
    durability.workerSessions.set("w-dormant", {
      sessionId: "w-dormant",
      parentSessionId: SENDER,
    });
    const host = new FakeDshHost();
    const core = createMultitask(host, {
      durability,
      findDurableWorker: (workerId) => {
        const row = durability.workerSessions.get(workerId);
        return row === undefined ? undefined : { parentSessionId: row.parentSessionId };
      },
    });
    const coreTools = createDispatcherTools({
      multitask: core,
      getSessionId: () => SENDER,
      now: () => 1_000_000,
    });
    const messageAgent = coreTools.find((tool) => tool.name === MESSAGE_AGENT_TOOL);
    assert.ok(messageAgent);

    const result = (await messageAgent.execute({
      target: "w-dormant",
      text: "continue",
    })) as MessageAgentToolResult;
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.delivered_as, "steer");
    assert.equal(host.dormantWakeCalls.length, 1);
    // The peer inbox never saw it: a worker is not a peer.
    assert.equal(core.peerInbox.pendingCount("w-dormant"), 0);
    assert.deepEqual(host.wakeCalls, []);
  });

  it("an id with NO durable row refuses exactly as before — both entry points", async () => {
    const r = rig();
    const steered = await r.multitask.steerWorker("ghost", "hello?");
    assert.equal(steered.ok, false);
    assert.equal(steered.ok ? "" : steered.reason, "unknown-worker");
    assert.deepEqual(r.host.dormantWakeCalls, []);

    const messaged = await r.exec({ target: "ghost", text: "hello?" });
    assert.equal(messaged.ok, false);
    assert.equal(messaged.ok ? "" : messaged.reason, "unknown-target");
    assert.deepEqual(r.host.dormantWakeCalls, []);
    assert.equal(r.multitask.peerInbox.pendingCount("ghost"), 0);
  });

  it("another session's marked worker refuses unknown-target without leaking it", async () => {
    const durability = createInMemoryDurability();
    durability.workerSessions.set("w-theirs", {
      sessionId: "w-theirs",
      parentSessionId: "chat-2",
    });
    const host = new FakeDshHost();
    const core = createMultitask(host, {
      durability,
      findDurableWorker: (workerId) => {
        const row = durability.workerSessions.get(workerId);
        return row === undefined ? undefined : { parentSessionId: row.parentSessionId };
      },
    });
    const coreTools = createDispatcherTools({
      multitask: core,
      getSessionId: () => SENDER,
      now: () => 1_000_000,
    });
    const messageAgent = coreTools.find((tool) => tool.name === MESSAGE_AGENT_TOOL);
    assert.ok(messageAgent);

    const result = (await messageAgent.execute({
      target: "w-theirs",
      text: "not yours",
    })) as MessageAgentToolResult;
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.reason, "unknown-target");
    assert.deepEqual(host.dormantWakeCalls, []);
    assert.equal(core.peerInbox.pendingCount("w-theirs"), 0);
  });

  it("a LIVE worker keeps the unchanged steer path: parked, interrupt, no dormant wake", async () => {
    const r = rig();
    const workerId = await spawnRunning(r.multitask, "live", "Live work");

    const result = await r.multitask.steerWorker(workerId, "tighten it");
    assert.deepEqual(result, { ok: true });

    assert.equal(r.host.dormantWakeCalls.length, 0);
    assert.deepEqual(r.host.interruptCalls, [workerId]);
    assert.equal(r.host.sendMessageCalls.length, 0);
    assert.equal(r.multitask.getWorker(workerId)?.status, "steering");

    await r.host.fireStepBoundary(workerId);
    assert.equal(r.host.sendMessageCalls.length, 1);
    assert.ok(r.host.sendMessageCalls[0]?.message.includes("tighten it"));
  });

  it("absent host wake seam keeps the pre-142 refusal: marked but unwakeable", async () => {
    // A host that cannot wake a dormant worker (a pre-142 double). The mark
    // alone must not turn into a silent accept.
    const durability = createInMemoryDurability();
    durability.workerSessions.set("w-dormant", {
      sessionId: "w-dormant",
      parentSessionId: SENDER,
    });
    const host = new FakeDshHost();
    // Strip the seam for this test (structural stand-in for an older host).
    Object.defineProperty(host, "wakeDormantWorker", { value: undefined });
    const core = createMultitask(host, {
      durability,
      findDurableWorker: (workerId) => {
        const row = durability.workerSessions.get(workerId);
        return row === undefined ? undefined : { parentSessionId: row.parentSessionId };
      },
    });

    const result = await core.steerWorker("w-dormant", "hello?");
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.reason, "unknown-worker");
  });
});

describe("ticket 142 — reclaimWorker resolves the unknown-state hold on live evidence", () => {
  async function heldCore(): Promise<{
    core: Multitask;
    durability: ReturnType<typeof createInMemoryDurability>;
    host: FakeDshHost;
  }> {
    const durability = createInMemoryDurability();
    durability.markers.set("w-held", {
      workerId: "w-held",
      parentSessionId: SENDER,
      streamKey: "held-stream",
      title: "Held work",
      status: "running",
      transcriptRef: "w-held",
      todoId: null,
      startedAtMs: 1,
      updatedAtMs: 2,
    });
    const host = new FakeDshHost();
    const core = createMultitask(host, { durability });
    await core.rebuildFromDurability(SENDER);
    return { core, durability, host };
  }

  it("turns a hold into a live roster record and re-takes the stream key", async () => {
    const { core, host } = await heldCore();
    assert.equal(core.listUnknownStateHolds(SENDER).length, 1);
    assert.equal(core.getWorker("w-held"), undefined);

    assert.equal(core.reclaimWorker("w-held", SENDER), true);

    assert.equal(core.listUnknownStateHolds(SENDER).length, 0);
    const record = core.getWorker("w-held");
    assert.ok(record);
    assert.equal(record.status, "spawned");
    assert.equal(record.streamKey, "held-stream");
    assert.equal(record.title, "Held work");
    assert.deepEqual(
      core.listWorkers(SENDER).map((summary) => summary.workerId),
      ["w-held"],
    );
    // The stream key is held by a live worker again — the invariant a fresh
    // spawn establishes, and the one ticket 59 protects across restarts.
    const reSpawn = await core.spawnWorker({
      parentSessionId: SENDER,
      streamKey: "held-stream",
      title: "Duplicate",
      prompt: "x",
    });
    assert.equal(reSpawn.ok, false);
    assert.equal(
      reSpawn.ok ? "" : reSpawn.reason,
      "duplicate-stream-key",
    );
    assert.deepEqual(host.spawnCalls, []);
  });

  it("is a no-op for an id that was never held, and for a foreign parent", async () => {
    const { core } = await heldCore();
    assert.equal(core.reclaimWorker("nobody", SENDER), false);
    // The hold belongs to SENDER; another session claiming it is refused.
    assert.equal(core.reclaimWorker("w-held", "chat-2"), false);
    assert.equal(core.listUnknownStateHolds(SENDER).length, 1);
    assert.equal(core.getWorker("w-held"), undefined);
  });

  it("a reclaimed worker is steerable, interruptible, and settles normally", async () => {
    const { core, host } = await heldCore();
    core.reclaimWorker("w-held", SENDER);

    core.noteTurnStarted("w-held");
    const steer = await core.steerWorker("w-held", "carry on");
    assert.deepEqual(steer, { ok: true });
    assert.deepEqual(host.interruptCalls, ["w-held"]);
    assert.equal(host.dormantWakeCalls.length, 0);

    host.fireSettled({ workerId: "w-held", status: "completed", report: "Done." });
    assert.equal(core.getWorker("w-held")?.status, "completed");
  });
});
