/**
 * Ticket 31 — conversational stop semantics + restart honesty
 * (design-17 §4.6/§4.7/§7).
 *
 * Offline only (S8): a fake host context with a PERSISTENT marker table
 * and a settings-capturing scope drives the real plugin apply(). The
 * markers are seeded to simulate a previous host life; activation must
 * rebuild BEFORE the first roster publish and inject exactly one honest
 * restart notice. Plus: the no-stop guard (structural absence of any
 * stop/cancel affordance on the client face), the new policy rules, and
 * the aborted-worker no-revival presentation. No network, no LLM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply as pluginApply } from "../src/plugin.js";
import {
  DISPATCHER_RESOLVE_COMMAND,
  DISPATCHER_START_COMMAND,
  DISPATCHER_STEER_COMMAND,
  MARKER_TABLE_NAME,
  RESTART_DEGRADED_NOTICE,
  RESTART_NOTICE_HEADING,
  restartRestoredLine,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
} from "../src/adapter/index.js";
import type { DurableWorkerMarker } from "../src/core/durability.js";
import {
  ROSTER_SETTINGS_KEY,
  projectRosterSnapshot,
  type RosterSnapshot,
} from "../src/core/roster-snapshot.js";
import {
  buildDispatcherPolicySection,
  SPAWN_WORKER_TOOL,
} from "../src/core/policy/prompts.js";
import {
  assembleSessionPolicy,
  assembleWakeTurn,
} from "../src/core/policy/assembler.js";
import {
  abortedReportBody,
  formatWakeReportBody,
} from "../src/core/report-clamp.js";
import { describeRosterPanel, type RosterPanelState } from "../src/client/roster-store.js";
import {
  createDispatcherShellStore,
  describeShellPanes,
  describeShellSidebar,
} from "../src/client/shell-store.js";
import {
  describeToolview,
  TOOLVIEW_TOOL_NAMES,
} from "../src/client/toolviews.js";

/** Drain the async rebuild chain queued by activation (ticket 31). */
async function flushActivation(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface TestAgent extends AgentLike {
  readonly injected: unknown[];
  /** Ticket 57: waking deliveries (`followup`) — must not be confused with injects. */
  readonly woken: unknown[];
}

function createAgent(id: string): TestAgent {
  const injected: unknown[] = [];
  const woken: unknown[] = [];
  return {
    session: {
      id,
      header: { parentSession: null, delegationDepth: 0 },
    },
    followup(message: unknown) {
      woken.push(message);
    },
    inject(message: unknown) {
      injected.push(message);
    },
    injected,
    woken,
  };
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

/**
 * Host context whose marker table PERSISTS across `table()` calls (the
 * durability port re-resolves the table per operation) and whose settings
 * scope records every mirrored update. Markers can be seeded through the
 * stub before apply() to simulate a previous host life (ADR-0006 source).
 */
function createRestartCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const tables = new Map<string, Map<string, unknown>>();
  const updates: unknown[] = [];
  let nextChild = 1;
  /**
   * Ticket 90: one-shot holds on the NEXT marker-table resolution(s). The
   * durability adapter resolves the table per operation
   * (`ensureTable()` = `domainPromise.then(domain => domain.table(...))`), so
   * a hold parked here delays exactly one read or write. The restart-honesty
   * findings need a marker read that is genuinely pending while the test
   * acts — a deactivation (F1), a concurrent roster transition (F3), a
   * deactivate → re-activate (F2) — instead of a read that always resolves
   * within the same tick. A hold stays in the queue (marked `taken`) until it
   * is released, so the test can release it after the read has picked it up.
   */
  const tableHolds: Array<{
    promise: Promise<void>;
    release: () => void;
    taken: boolean;
  }> = [];

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
    }
  };

  const makeTable = (name: string) => {
    let table = tables.get(name);
    if (table === undefined) {
      table = new Map<string, unknown>();
      tables.set(name, table);
    }
    return {
      get: (key: string) => table!.get(key) as never,
      entries: () => table!.entries() as never,
      async put(key: string, value: unknown) {
        table!.set(key, value);
      },
      async delete(key: string) {
        return table!.delete(key);
      },
    };
  };

  const ctx = {
    // Cordis effect contract (ticket 44): `execute` runs at apply; whatever
    // it returns (or a generator yields) is the unload disposer — dropped
    // here because these tests never unload the fiber. Draining the iterator
    // is what runs a generator effect's body (lazy until iterated).
    effect(execute: () => unknown) {
      const result = execute();
      if (
        typeof result === "object" &&
        result !== null &&
        Symbol.iterator in result
      ) {
        for (const step of result as Iterable<unknown>) void step;
      }
    },
    inject(services: readonly string[], callback: (child: unknown) => void) {
      if (services.includes("settings")) {
        callback({
          settings: {
            installSection() {
              return {
                update(value: unknown) {
                  updates.push(value);
                },
              };
            },
          },
        });
      }
    },
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((c) => c !== cb),
        );
      };
    },
    commands: {
      register(definition: CommandDefinitionLike) {
        commands.set(definition.name, definition);
        return () => {
          commands.delete(definition.name);
        };
      },
    },
    tools: {
      schemas: () => [...tools.keys()].map((name) => ({ name })),
      register(definition: {
        name: string;
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      }) {
        tools.set(definition.name, definition);
        return () => {
          tools.delete(definition.name);
        };
      },
    },
    subagents: {
      async startContinuable() {
        const childId = `child-${nextChild++}`;
        return { childId, messageId: `msg-${childId}` };
      },
      interrupt() {},
      async sendMessage() {
        return "msg-stub";
      },
    },
    agents: { get: () => undefined },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        return {
          // Ticket 90: `table()` is awaited by the durability adapter, so a
          // parked hold here delays exactly this one resolution.
          async table(name: string) {
            const hold = tableHolds.find((candidate) => !candidate.taken);
            if (hold !== undefined) {
              hold.taken = true;
              await hold.promise;
            }
            return makeTable(name);
          },
          async close() {},
          name: "stub",
        };
      },
    },
    // Test surface
    fire,
    updates,
    commandNames: () => [...commands.keys()],
    tool: (name: string) => tools.get(name),
    /** Park the next marker-table resolution until released (ticket 90). */
    holdNextMarkerTable() {
      let release: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      tableHolds.push({ promise, release, taken: false });
    },
    /** Release the OLDEST parked marker-table resolution (ticket 90). */
    releaseMarkerTableHold() {
      tableHolds.shift()?.release();
    },
    runCommand(invocation: {
      commandId: string;
      agent?: AgentLike;
    }): CommandResultLike {
      const command = commands.get(invocation.commandId);
      if (command === undefined) {
        throw new Error(`command not registered: ${invocation.commandId}`);
      }
      return command.handler(invocation as never) as CommandResultLike;
    },
  };
  return ctx as unknown as AdapterContext & {
    fire(name: string, payload: unknown): void;
    readonly updates: unknown[];
    commandNames(): string[];
    tool(name: string):
      | { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
      | undefined;
    holdNextMarkerTable(): void;
    releaseMarkerTableHold(): void;
    runCommand(invocation: {
      commandId: string;
      agent?: AgentLike;
    }): CommandResultLike;
  };
}

async function seedMarkers(
  ctx: ReturnType<typeof createRestartCtx>,
  markers: DurableWorkerMarker[],
): Promise<void> {
  const domain = await ctx.storageDomain.open();
  const table = await domain.table(MARKER_TABLE_NAME);
  for (const marker of markers) {
    await table.put(marker.workerId, marker);
  }
}

/** Read the durable markers back through the same store (ticket 90). */
async function readMarkers(
  ctx: ReturnType<typeof createRestartCtx>,
): Promise<Map<string, DurableWorkerMarker>> {
  const domain = await ctx.storageDomain.open();
  const table = await domain.table(MARKER_TABLE_NAME);
  const entries = table.entries() as Iterable<[string, DurableWorkerMarker]>;
  return new Map([...entries]);
}

function rosterSnapshots(
  updates: readonly unknown[],
): Array<{
  dispatcherSessionId: string;
  workers: Array<{ workerId: string; status: string }>;
}> {
  return updates
    .map((update) => (update as Record<string, unknown>)[ROSTER_SETTINGS_KEY])
    .filter((snapshot) => snapshot !== undefined)
    .map(
      (snapshot) => snapshot as {
        dispatcherSessionId: string;
        workers: Array<{ workerId: string; status: string }>;
      },
    );
}

const DONE_MARKER: DurableWorkerMarker = {
  workerId: "w-done",
  parentSessionId: "s-1",
  streamKey: "todo-done",
  title: "Report generator",
  status: "completed",
  transcriptRef: "child-done",
  todoId: "todo-done",
  startedAtMs: 1_000,
  updatedAtMs: 2_000,
};

const LIVE_MARKER: DurableWorkerMarker = {
  workerId: "w-live",
  parentSessionId: "s-1",
  streamKey: "todo-live",
  title: "Live at crash",
  status: "running",
  transcriptRef: null,
  todoId: null,
  startedAtMs: 1_000,
  updatedAtMs: 2_000,
};

describe("restart honesty — rebuild on activation (design-17 §4.7)", () => {
  it("activation rebuilds durable markers BEFORE the first publish; one notice; unknown rows stay off the roster", async () => {
    const ctx = createRestartCtx();
    await seedMarkers(ctx, [DONE_MARKER, LIVE_MARKER]);

    pluginApply(ctx, { enabled: true });
    const agent = createAgent("s-1");

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(result.kind, "success");
    await flushActivation();

    // Exactly ONE restart notice, carrying the id, the transcript pointer,
    // the honest unknown wording, and the restored count (design-17 §7).
    //
    // Ticket 57 (D-4): it must arrive on the WAKING primitive. Reading it out
    // of `agent.injected` — what this test used to do — is precisely how the
    // old behaviour stayed green: `inject` queues context into a turn that
    // only opens if the user speaks next, so the recovery chain stalled.
    const notices = agent.woken
      .map(textOf)
      .filter((text) => text.includes(RESTART_NOTICE_HEADING));
    assert.equal(notices.length, 1, "recovery notice is delivered by a wake");
    assert.equal(
      agent.injected
        .map(textOf)
        .filter((text) => text.includes(RESTART_NOTICE_HEADING)).length,
      0,
      "the recovery notice must NOT go through the queueing primitive",
    );
    // R2: the activation-time session policy rides the already-open turn, so
    // it stays on `inject` (waking it would cost an extra model call).
    const policyInjects = agent.injected
      .map(textOf)
      .filter((text) => text.includes("# Multitask dispatcher"));
    assert.equal(policyInjects.length, 1, "session policy still injects");
    assert.equal(
      agent.woken
        .map(textOf)
        .filter((text) => text.includes("# Multitask dispatcher")).length,
      0,
      "session policy does not wake",
    );
    const notice = notices[0] ?? "";
    assert.ok(notice.includes("w-live"), "notice names the unknown worker");
    assert.ok(
      notice.includes("state is unknown"),
      "notice says the state is unknown",
    );
    assert.ok(
      notice.includes("nothing was replayed"),
      "notice says nothing was replayed",
    );
    assert.ok(
      notice.includes("Transcripts: w-live"),
      "notice carries the transcript pointer (id fallback)",
    );
    assert.ok(
      notice.includes("1 worker(s) were still running"),
      "notice carries the unknown count",
    );
    assert.ok(
      notice.includes(restartRestoredLine(1)),
      "notice carries the restored-count line",
    );

    // Rebuild-before-publish ordering: the FIRST mirrored snapshot already
    // contains the restored terminal row. A publish-before-rebuild bug
    // would publish an empty roster first.
    const snapshots = rosterSnapshots(ctx.updates);
    assert.ok(snapshots.length >= 1, "a roster snapshot was published");
    const first = snapshots[0];
    assert.ok(first);
    assert.equal(first.dispatcherSessionId, "s-1");
    const firstIds = first.workers.map((worker) => worker.workerId);
    assert.ok(
      firstIds.includes("w-done"),
      "restored row is in the first snapshot (rebuild before publish)",
    );
    // Unknown-state rows NEVER land on the roster (core rule) — the notice
    // is their only surface.
    for (const snapshot of snapshots) {
      assert.equal(
        snapshot.workers.some((worker) => worker.workerId === "w-live"),
        false,
        "unknown-state worker never appears on the roster",
      );
    }
  });

  it("the notice fires once per activation: a second activation rebuilds empty and stays silent", async () => {
    const ctx = createRestartCtx();
    await seedMarkers(ctx, [
      { ...DONE_MARKER, streamKey: "k1", todoId: null },
    ]);

    pluginApply(ctx, { enabled: true });
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await flushActivation();

    const noticesAfterFirst = agent.woken
      .map(textOf)
      .filter((text) => text.includes(RESTART_NOTICE_HEADING));
    assert.equal(noticesAfterFirst.length, 1);

    // Deactivate (session disposed), then re-activate the same chat. The
    // core still holds the restored worker in memory, so the rebuild report
    // is empty and no second notice may fire.
    ctx.fire("agent/disposed", { agent });
    const again = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(again.kind, "success");
    await flushActivation();

    const noticesAfterSecond = agent.woken
      .map(textOf)
      .filter((text) => text.includes(RESTART_NOTICE_HEADING));
    assert.equal(
      noticesAfterSecond.length,
      1,
      "no re-notice on the second activation",
    );
  });

  it("no durable state: activation publishes the roster and injects no notice", async () => {
    const ctx = createRestartCtx();
    pluginApply(ctx, { enabled: true });
    const agent = createAgent("s-1");
    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(result.kind, "success");
    await flushActivation();

    assert.equal(agent.injected.length, 1, "only the session policy inject");
    assert.ok(textOf(agent.injected[0]).includes("# Multitask dispatcher"));
    // Ticket 57: silence stays silence — an uneventful activation opens no
    // recovery turn. Waking unconditionally would spawn a needless model call
    // on every activation.
    assert.equal(agent.woken.length, 0, "no recovery wake without a story");
    assert.ok(
      rosterSnapshots(ctx.updates).length >= 1,
      "the (empty) roster is still published",
    );
  });

  it("rebuild failure: activation still succeeds with the degraded honest notice", async () => {
    const commands = new Map<string, CommandDefinitionLike>();
    const injected: unknown[] = [];
    const agent = createAgent("s-1");
    const ctx = {
      // Cordis effect contract (ticket 44): `execute` runs at apply; whatever
      // it returns (or a generator yields) is the unload disposer — dropped
      // here because this test never unloads the fiber. Draining the iterator
      // is what runs a generator effect's body (lazy until iterated).
      effect(execute: () => unknown) {
        const result = execute();
        if (
          typeof result === "object" &&
          result !== null &&
          Symbol.iterator in result
        ) {
          for (const step of result as Iterable<unknown>) void step;
        }
      },
      inject() {},
      on() {
        return () => {};
      },
      commands: {
        register(definition: CommandDefinitionLike) {
          commands.set(definition.name, definition);
          return () => {};
        },
      },
      tools: {
        schemas: () => [] as Array<{ name: string }>,
        register() {
          return () => {};
        },
      },
      subagents: {
        async startContinuable() {
          return { childId: "c", messageId: "m" };
        },
        interrupt() {},
        async sendMessage() {
          return "msg";
        },
      },
      agents: { get: () => undefined },
      jobs: { list: () => [] },
      // Broken marker store: open rejects. The rebuild must fail without
      // taking the activation down with it.
      storageDomain: {
        open(): Promise<never> {
          return Promise.reject(new Error("marker store unreadable"));
        },
      },
    };
    pluginApply(ctx as unknown as Parameters<typeof pluginApply>[0], {
      enabled: true,
    });

    const command = commands.get(DISPATCHER_START_COMMAND);
    assert.ok(command, "activation command registered despite broken store");
    const result = command.handler({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    } as never) as CommandResultLike;
    assert.equal(result.kind, "success", "activation survives a broken store");
    await flushActivation();

    // Ticket 57: the degraded path is still a story the dispatcher must act
    // on, so it wakes like the normal one — same primitive, same guarantee.
    const notices = agent.woken
      .map(textOf)
      .filter((text) => text.includes(RESTART_DEGRADED_NOTICE));
    assert.equal(
      notices.length,
      1,
      "exactly one degraded notice: nothing restored, nothing replayed",
    );
  });

  it("a deactivation during the marker read ends the chain: nothing published, nothing woken, no redrive spent (ticket 90 F1)", async () => {
    const ctx = createRestartCtx();
    await seedMarkers(ctx, [{ ...DONE_MARKER }]);
    pluginApply(ctx, { enabled: true });
    const agent = createAgent("s-1");

    // The marker read is genuinely pending: activation has returned, the
    // chain is parked inside `rebuildFromDurability`.
    ctx.holdNextMarkerTable();
    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(result.kind, "success");
    await flushActivation();
    assert.equal(
      rosterSnapshots(ctx.updates).length,
      0,
      "no publish while the rebuild is still reading markers",
    );

    // The activation ends mid-read.
    ctx.fire("agent/disposed", { agent });
    const snapshotsAtDeactivation = rosterSnapshots(ctx.updates).length;

    ctx.releaseMarkerTableHold();
    await flushActivation();

    // The guard's false branch: a chain that resumes for a session that is
    // no longer an activated dispatcher must not publish (a snapshot here
    // would re-flag a dead session as live), must not wake the notice, and
    // must not spend a redrive attempt of the persisted D-5 budget.
    assert.equal(
      rosterSnapshots(ctx.updates).length,
      snapshotsAtDeactivation,
      "the dead chain publishes no roster snapshot",
    );
    assert.equal(
      agent.woken.length,
      0,
      "the dead chain wakes nothing (no restart notice, no redrive turn)",
    );
    const markers = await readMarkers(ctx);
    assert.equal(
      markers.get("w-done")?.redriveAttempts ?? 0,
      0,
      "redriveUndelivered never ran: the persisted budget is untouched",
    );
  });

  it("a roster transition during the marker read cannot publish a pre-rebuild snapshot (ticket 90 F3)", async () => {
    const ctx = createRestartCtx();
    await seedMarkers(ctx, [{ ...DONE_MARKER }]);
    pluginApply(ctx, { enabled: true });
    const agent = createAgent("s-1");

    ctx.holdNextMarkerTable();
    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(result.kind, "success");
    await flushActivation();
    assert.equal(
      rosterSnapshots(ctx.updates).length,
      0,
      "no publish while the rebuild is in flight",
    );

    // A roster-affecting transition lands inside the window. A worker spawn is
    // the cheapest real one: its marker write is a LATER table resolution, so
    // it completes while the activation read is still parked.
    const spawn = ctx.tool(SPAWN_WORKER_TOOL);
    assert.ok(spawn, "the dispatcher tool surface is registered");
    const spawned = (await spawn.execute({
      stream_key: "k-race",
      title: "Raced task",
      prompt: "work",
    })) as { ok: boolean };
    assert.equal(spawned.ok, true, "the spawn completed mid-rebuild");

    ctx.releaseMarkerTableHold();
    await flushActivation();

    // Ticket 31's ordering rule, now under concurrency: the FIRST mirrored
    // snapshot must already carry the restored rows. Without the in-flight
    // gate the spawn's transition publishes first — a pre-rebuild snapshot.
    const snapshots = rosterSnapshots(ctx.updates);
    assert.ok(snapshots.length >= 1, "a roster snapshot was published");
    const first = snapshots[0];
    assert.ok(first);
    const firstIds = first.workers.map((worker) => worker.workerId);
    assert.ok(
      firstIds.includes("w-done"),
      "the first snapshot already carries the restored rows (rebuild before publish)",
    );
    // And the raced transition is not lost: the post-rebuild publish projects
    // the live roster, which includes the spawned worker.
    assert.ok(
      firstIds.includes("child-1"),
      "the raced transition is in that same first snapshot, not dropped",
    );
  });

  it("a stale chain from an earlier activation of the same session id is refused (ticket 90 F2)", async () => {
    const ctx = createRestartCtx();
    await seedMarkers(ctx, [{ ...DONE_MARKER }]);
    pluginApply(ctx, { enabled: true });
    const agent = createAgent("s-1");

    // Activation #1 starts a chain and parks on the marker read.
    ctx.holdNextMarkerTable();
    const first = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(first.kind, "success");
    await flushActivation();

    // Deactivate → re-activate the SAME session id: activation #2 owns the
    // session now, and its chain parks on its own held read. This is the
    // window the session-id check cannot see: set membership is true again.
    ctx.fire("agent/disposed", { agent });
    ctx.holdNextMarkerTable();
    const second = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(second.kind, "success");

    // The stale chain resumes first. It is no longer acting for a live
    // activation, so it must not publish and must not spend a redrive.
    ctx.releaseMarkerTableHold();
    await flushActivation();
    assert.equal(
      rosterSnapshots(ctx.updates).length,
      0,
      "the stale chain publishes nothing",
    );

    // A roster transition lands while the LIVE chain is still reading. The
    // stale chain's exit must not have cleared the in-flight gate for the
    // new activation (that is why the gate is keyed by generation).
    const spawn = ctx.tool(SPAWN_WORKER_TOOL);
    assert.ok(spawn);
    const spawned = (await spawn.execute({
      stream_key: "k-race",
      title: "Raced task",
      prompt: "work",
    })) as { ok: boolean };
    assert.equal(spawned.ok, true);
    assert.equal(
      rosterSnapshots(ctx.updates).length,
      0,
      "the live rebuild is still in flight: the transition does not publish yet",
    );

    // The live chain resumes: ONE publish (with the restored rows and the
    // raced transition) and ONE redrive pass.
    ctx.releaseMarkerTableHold();
    await flushActivation();

    const snapshots = rosterSnapshots(ctx.updates);
    assert.equal(
      snapshots.length,
      1,
      "exactly one publish for the new activation (no double publish)",
    );
    const ids = snapshots[0]?.workers.map((worker) => worker.workerId) ?? [];
    assert.ok(
      ids.includes("w-done"),
      "the restored rows are in the first publish",
    );
    assert.ok(ids.includes("child-1"), "the raced transition is in it too");
    const markers = await readMarkers(ctx);
    assert.equal(
      markers.get("w-done")?.redriveAttempts ?? 0,
      1,
      "the persisted D-5 budget was spent once, not twice",
    );
  });
});

describe("restart honesty — no-stop guard (design-17 §4.6)", () => {
  /** Recursively collect every object key in a view model tree. */
  function collectKeys(value: unknown, visit: (key: string) => void): void {
    if (Array.isArray(value)) {
      for (const entry of value) collectKeys(entry, visit);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        visit(key);
        collectKeys(child, visit);
      }
    }
  }

  /** Recursively visit every primitive string value with its own key. */
  function collectEntries(
    value: unknown,
    visit: (key: string, value: string) => void,
  ): void {
    if (Array.isArray(value)) {
      for (const entry of value) collectEntries(entry, visit);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string") visit(key, child);
        else collectEntries(child, visit);
      }
    }
  }

  const AFFORDANCE_PATTERN = /stop|cancel|button|action|affordance/i;

  it("the roster panel view model exposes no stop/cancel affordance field", () => {
    const summaries = [
      "w-running",
      "w-steering",
      "w-spawned",
      "w-blocked",
      "w-landed",
      "w-failed",
      "w-aborted",
    ].map((workerId) => ({
      workerId,
      parentSessionId: "s-1",
      streamKey: workerId,
      title: `Task ${workerId}`,
      status: workerId === "w-running"
        ? "running"
        : workerId === "w-steering"
          ? "steering"
          : workerId === "w-spawned"
            ? "spawned"
            : workerId === "w-blocked"
              ? "running"
              : workerId === "w-landed"
                ? "completed"
                : workerId === "w-failed"
                  ? "error"
                  : "aborted",
      startedAtMs: 1_000,
      elapsedMs: 5_000,
      toolCallCount: 3,
      transcriptRef: null,
      todoId: workerId === "w-landed" ? "todo-landed" : null,
    }));
    const snapshot = projectRosterSnapshot("s-1", summaries, 10_000, {
      pendingAccess: [
        {
          workerId: "w-blocked",
          requestId: "r-1",
          title: "Task w-blocked",
          body: { class: "tool", target: "shell", reason: "needs the shell" },
        },
      ],
      todos: [
        {
          id: "todo-landed",
          sessionId: "s-1",
          title: "Task w-landed",
          status: "in_progress",
          streamKey: "w-landed",
          workerId: "w-landed",
          delivered: false,
          createdAtMs: 1_000,
          updatedAtMs: 2_000,
        },
      ],
    });
    const view = describeRosterPanel(
      { kind: "snapshot", snapshot },
      10_000,
    );
    assert.equal(view.kind, "rows");
    if (view.kind === "rows") {
      // Precondition: the fixture really covers blocked + landed + terminal
      // rows, so the scan means something.
      const rows = view.sections.flatMap((section) => section.rows);
      assert.equal(rows.length, 7);
      assert.ok(rows.some((row) => row.marker?.kind === "blocked"));
      assert.ok(rows.some((row) => row.marker?.kind === "landed"));
      assert.ok(rows.some((row) => row.finished));
    }

    const keys: string[] = [];
    collectKeys(view, (key) => keys.push(key));
    const offenders = keys.filter((key) => AFFORDANCE_PATTERN.test(key));
    assert.deepEqual(
      offenders,
      [],
      `panel view model must carry no stop/cancel affordance field; found: ${offenders.join(", ")}`,
    );
  });

  it("the toolview render data carries no stop/cancel affordance for any dispatcher tool", () => {
    const richPayload = {
      args: {
        worker_id: "w-1",
        title: "T",
        stream_key: "k",
        todo_id: "todo-1",
        message: "correction text",
        attachment_paths: ["/tmp/a"],
      },
      result: {
        ok: true,
        worker_id: "w-1",
        title: "T",
        stream_key: "k",
        delivered: true,
        todo_completed: "todo-1",
        rows: [
          {
            worker_id: "w-1",
            title: "T",
            status: "running",
            recent_activity: "editing file",
          },
        ],
      },
    };
    for (const toolName of TOOLVIEW_TOOL_NAMES) {
      const model = describeToolview(toolName, richPayload);
      const keys: string[] = [];
      collectKeys(model, (key) => keys.push(key));
      const offenders = keys.filter((key) => AFFORDANCE_PATTERN.test(key));
      assert.deepEqual(
        offenders,
        [],
        `toolview for ${toolName} must carry no stop/cancel affordance field; found: ${offenders.join(", ")}`,
      );
    }
  });

  it("the shell-era view models carry no direct stop/deactivate control field (ticket 31's guard, migrated off the retired capsule models — ticket 89)", () => {
    const workers = [
      {
        kind: "worker" as const,
        workerId: "w-running",
        title: "Task w-running",
        status: "running" as const,
        todoId: null,
        startedAtMs: 1_000,
        toolCallCount: 3,
        delivered: false,
        blocked: null,
      },
      {
        kind: "worker" as const,
        workerId: "w-landed",
        title: "Task w-landed",
        status: "completed" as const,
        todoId: null,
        startedAtMs: 1_000,
        toolCallCount: 2,
        delivered: false,
        blocked: null,
      },
    ];
    const snapshot: RosterSnapshot = {
      schemaVersion: 4,
      dispatcherSessionId: "s-1",
      publishedAtMs: 10_000,
      workers,
      recentResult: null,
      pendingAsks: [],
    };

    // The live shell store drives both faces of the honest degrade: a fresh
    // snapshot (working + landed-undelivered rows) and an unavailable
    // presence. The exactly-at-window timestamp keeps the fresh row's
    // presence available at the render clock.
    const store = createDispatcherShellStore();
    store.upsertSessions([
      { sessionId: "s-1", title: "Dispatcher", dispatcher: true },
      { sessionId: "s-chat", title: "Plain chat" },
    ]);
    store.applyPresence(snapshot);
    store.select("s-1");
    const sidebarFresh = describeShellSidebar(store.getBox().state, 10_000);
    assert.equal(sidebarFresh.kind, "ready");
    store.markPresenceUnavailable("s-1");
    const sidebarUnavailable = describeShellSidebar(
      store.getBox().state,
      10_000,
    );
    assert.equal(sidebarUnavailable.kind, "ready");

    // The roster panel states keep their full matrix (the same five honest
    // shapes the retired capsule guard scanned) and the pane decisions ride
    // along. Key scan over ALL of the shell-era view models — sidebar rows,
    // pane decisions, the full panel rows: no key may offer direct
    // kill/deactivate/stop authority, and the literal "stop" never appears
    // as a value anywhere. (The conversation transcript's honest
    // `interrupted` STATE flag is presentation history, not an affordance;
    // the pane's send-only contract — area 7 — is pinned by the composer and
    // copy tests in client-conversation-surface.test.ts.)
    const panelStates: RosterPanelState[] = [
      { kind: "waiting" },
      { kind: "channel-missing" },
      { kind: "invalid" },
      { kind: "snapshot", snapshot },
      {
        kind: "snapshot",
        snapshot: { ...snapshot, publishedAtMs: 1_000 },
      },
    ];
    const models: unknown[] = [
      sidebarFresh,
      sidebarUnavailable,
      describeShellPanes(store.getBox().state),
      ...panelStates.map((state) => describeRosterPanel(state, 10_000)),
    ];
    for (const model of models) {
      const keys: string[] = [];
      const stopValues: string[] = [];
      collectKeys(model, (key) => {
        keys.push(key);
      });
      collectEntries(model, (key, value) => {
        if (value === "stop") stopValues.push(key);
      });
      const offenders = keys.filter((key) =>
        /stop|cancel|kill|abort|deactivate|terminate|destroy/i.test(key),
      );
      assert.deepEqual(
        offenders,
        [],
        `shell view model must carry no direct stop/deactivate control field; found: ${offenders.join(", ")}`,
      );
      for (const key of stopValues) {
        assert.fail(`"stop" appeared as a value under "${key}" — no client view model may carry a stop control value`);
      }
    }
  });

  it("the plugin registers no stop/cancel command — the absence is the design", () => {
    const ctx = createRestartCtx();
    pluginApply(ctx, { enabled: true });
    const names = ctx.commandNames().sort();
    assert.deepEqual(names, [
      DISPATCHER_RESOLVE_COMMAND,
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
    ]);
    const offenders = names.filter((name) => /stop|cancel/i.test(name));
    assert.deepEqual(offenders, [], "no stop/cancel command may be registered");
  });
});

describe("restart honesty — policy copy (new, clean-room)", () => {
  it("the session policy teaches conversational stopping and the no-board rule", () => {
    const policy = buildDispatcherPolicySection();
    assert.ok(
      policy.includes("asks you to stop or change course in plain language"),
      "stop/course-change rule present",
    );
    assert.ok(
      policy.includes("treat that as a steer or a stop of the matching worker"),
      "rule maps plain language onto steer/stop of the matching worker",
    );
    assert.ok(
      policy.includes("confirm plainly what you stopped or changed"),
      "rule requires plain confirmation",
    );
    assert.ok(
      policy.includes("Never claim a stopped worker produced a result"),
      "rule forbids claiming results from stopped workers",
    );
    assert.ok(
      policy.includes("never reference a task board or milestone view"),
      "no-board/no-milestone narration rule present",
    );

    const injected = assembleSessionPolicy(true);
    assert.ok(injected.includes("asks you to stop or change course"));
    assert.ok(injected.includes("task board or milestone view"));
    // Flag OFF: empty policy — the rules ride the ADR-0005 gate like all copy.
    assert.equal(assembleSessionPolicy(false), "");
  });
});

describe("restart honesty — aborted workers settle with no report (no revival)", () => {
  it("abortedReportBody is the exact no-report body and wins over any report text", () => {
    assert.equal(
      abortedReportBody(),
      "(Stopped before completion. No report.)",
    );
    // A report that raced the stop is never shown for an aborted worker.
    assert.equal(
      formatWakeReportBody("aborted", "confidential partial work", "child-1"),
      "(Stopped before completion. No report.)",
    );
    assert.equal(
      formatWakeReportBody("aborted", "", null),
      "(Stopped before completion. No report.)",
    );
  });

  it("a wake turn for an aborted worker carries the no-report body, never its text", () => {
    const wake = assembleWakeTurn([
      {
        workerId: "w-1",
        title: "Stopped task",
        status: "aborted",
        report: "secret partial output",
        transcriptRef: "child-1",
      },
    ]);
    assert.ok(wake.includes("(Stopped before completion. No report.)"));
    assert.ok(!wake.includes("secret partial output"));
  });
});
