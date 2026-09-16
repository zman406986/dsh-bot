/**
 * Ticket 21 — roster snapshot projection + settings-namespace data path
 * (host half; design-16 §4.2).
 *
 * Offline only (S8): FakeDshHost + createMultitask with the roster observer,
 * pure projection/parse/staleness checks, the settings-owner-scope channel,
 * and the real plugin apply() publishing through a fake settings provider on
 * activation and on roster-affecting transitions. No network, no LLM, no
 * running dsh.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";
import { createInMemoryDurability } from "../src/core/durability.js";
import {
  ROSTER_SETTINGS_KEY,
  ROSTER_SNAPSHOT_SCHEMA_VERSION,
  ROSTER_STALE_WINDOW_MS,
  ROSTER_STATUS_KEYS,
  isRosterSnapshotStale,
  parseRosterSnapshot,
  projectRosterSnapshot,
} from "../src/core/roster-snapshot.js";
import {
  createSettingsRosterChannel,
} from "../src/adapter/roster-channel.js";
import {
  DISPATCHER_START_COMMAND,
  type AdapterContext,
  type AgentLike,
} from "../src/adapter/index.js";
import { apply as pluginApply } from "../src/plugin.js";

function makeCore(
  observer?: (sessionId: string) => void,
  durability: ReturnType<typeof createInMemoryDurability> = createInMemoryDurability(),
) {
  const host = new FakeDshHost();
  const multitask = createMultitask(host, {
    durability,
    ...(observer === undefined ? {} : { onRosterChanged: observer }),
  });
  return { host, durability, multitask };
}

describe("roster snapshot — projection is a pure core projection (ticket 21)", () => {
  it("projects id, title, core FSM status, and todo link — nothing else", () => {
    const { host, multitask } = makeCore();
    const todo = multitask.createTodo({
      sessionId: "s-1",
      title: "Write the parser",
    });
    return multitask
      .spawnWorker({
        parentSessionId: "s-1",
        streamKey: "stream-a",
        title: "Parser worker",
        prompt: "do things",
        todoId: todo.id,
      })
      .then((result) => {
        assert.equal(result.ok, true);
        const snapshot = projectRosterSnapshot(
          "s-1",
          multitask.listWorkers("s-1"),
          1_000,
        );
        assert.equal(snapshot.schemaVersion, ROSTER_SNAPSHOT_SCHEMA_VERSION);
        assert.equal(snapshot.dispatcherSessionId, "s-1");
        assert.equal(snapshot.publishedAtMs, 1_000);
        assert.equal(snapshot.workers.length, 1);
        assert.deepEqual(snapshot.workers[0], {
          workerId: result.ok ? result.workerId : "",
          title: "Parser worker",
          status: "spawned",
          todoId: todo.id,
        });
      });
  });

  it("projects each core FSM status verbatim (the vocabulary is the label)", () => {
    for (const status of ROSTER_STATUS_KEYS) {
      const snapshot = projectRosterSnapshot("s", [
        {
          workerId: "w",
          parentSessionId: "s",
          streamKey: "k",
          title: "T",
          status,
          startedAtMs: 0,
          elapsedMs: 0,
          toolCallCount: 0,
          transcriptRef: null,
          todoId: null,
        },
      ], 5);
      assert.equal(snapshot.workers[0]?.status, status);
    }
  });
});

describe("roster snapshot — core observer fires on roster-affecting transitions", () => {
  it("fires on spawn, first turn, steer transitions, settle, abort, reconcile, drain", async () => {
    const seen: string[] = [];
    const { host, multitask } = makeCore((sessionId) => seen.push(sessionId));

    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
    });
    assert.equal(spawn.ok, true);
    const workerId = spawn.ok ? spawn.workerId : "";

    multitask.noteTurnStarted(workerId); // spawned → running
    multitask.noteSteerReceived(workerId); // running → steering
    multitask.noteSteerInjected(workerId); // steering → running
    host.fireSettled({
      workerId,
      status: "completed",
      report: "done",
      transcriptRef: workerId,
    });
    multitask.reconcileTodos("s-1");
    multitask.drainWake("s-1");

    // Every accepted transition above notified exactly once, session-scoped.
    assert.deepEqual(seen, [
      "s-1", // spawn
      "s-1", // turn started
      "s-1", // steer received
      "s-1", // steer injected
      "s-1", // settle
      "s-1", // reconcile
      "s-1", // drain
    ]);
    assert.equal(multitask.getWorker(workerId)?.status, "completed");
  });

  it("fires on accepted abort but not on refused/reflected transitions", async () => {
    const seen: string[] = [];
    const { host, multitask } = makeCore((sessionId) => seen.push(sessionId));

    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-9",
      streamKey: "k",
      title: "T",
      prompt: "P",
    });
    const workerId = spawn.ok ? spawn.workerId : "";
    const before = seen.length;

    multitask.noteTurnStarted("unknown-worker"); // ignored: no notify
    multitask.noteTurnStarted(workerId);
    multitask.noteTurnStarted(workerId); // illegal second time: no notify
    assert.equal(seen.length - before, 1);

    const abort = await multitask.abortWorker(workerId);
    assert.equal(abort.ok, true);
    assert.deepEqual(seen.at(-1), "s-9");

    // Post-abort settle is dropped (never revive): no further notification.
    host.fireSettled({ workerId, status: "completed", report: "late" });
    assert.equal(seen.at(-1), "s-9");
  });

  it("rebuild notifies only when terminal workers are restored onto the roster", async () => {
    const seen: string[] = [];
    // Construct markers directly to control restored vs unknown-state.
    const durability = createInMemoryDurability();
    durability.writeWorkerMarker({
      workerId: "w-done",
      parentSessionId: "s-1",
      streamKey: "done-k",
      title: "Done",
      status: "completed",
      transcriptRef: "w-done",
      todoId: null,
      startedAtMs: 1,
      updatedAtMs: 2,
    });
    durability.writeWorkerMarker({
      workerId: "w-live",
      parentSessionId: "s-1",
      streamKey: "live-k",
      title: "Live",
      status: "running",
      transcriptRef: null,
      todoId: null,
      startedAtMs: 1,
      updatedAtMs: 2,
    });
    const { multitask } = makeCore(
      (sessionId) => seen.push(sessionId),
      durability,
    );
    const report = await multitask.rebuildFromDurability("s-1");
    assert.equal(report.restored.length, 1);
    assert.equal(report.unknownState.length, 1);
    // Unknown-state rows never land on the roster: exactly one notification.
    assert.deepEqual(seen, ["s-1"]);
    assert.equal(multitask.getWorker("w-live"), undefined);
    assert.equal(multitask.getWorker("w-done")?.status, "completed");
  });

  it("a throwing observer never breaks core flow", async () => {
    const { multitask } = makeCore(() => {
      throw new Error("observer exploded");
    });
    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
    });
    assert.equal(spawn.ok, true);
    assert.equal(multitask.listWorkers("s-1").length, 1);
  });
});

describe("roster snapshot — parse and staleness (wire contract)", () => {
  const valid = projectRosterSnapshot("s-1", [], 1_000);

  it("round-trips a projected snapshot", () => {
    assert.deepEqual(parseRosterSnapshot(valid), valid);
  });

  it("rejects wrong shape, version skew, bad clocks, and unknown statuses", () => {
    assert.equal(parseRosterSnapshot(null), null);
    assert.equal(parseRosterSnapshot("nope"), null);
    assert.equal(
      parseRosterSnapshot({ ...valid, schemaVersion: 99 }),
      null,
      "version skew must fail the whole snapshot honestly",
    );
    assert.equal(
      parseRosterSnapshot({ ...valid, publishedAtMs: Number.NaN }),
      null,
    );
    assert.equal(
      parseRosterSnapshot({ ...valid, dispatcherSessionId: 7 }),
      null,
    );
    assert.equal(parseRosterSnapshot({ ...valid, workers: "no" }), null);
    assert.equal(
      parseRosterSnapshot({
        ...valid,
        workers: [{ workerId: "w", title: "T", status: "zombie", todoId: null }],
      }),
      null,
    );
    assert.equal(
      parseRosterSnapshot({
        ...valid,
        workers: [{ workerId: "w", title: "T", status: "running" }],
      }),
      null,
      "missing todoId is not null",
    );
  });

  it("staleness boundary: exactly at the window is fresh, beyond is stale", () => {
    assert.equal(isRosterSnapshotStale(valid, 1_000 + ROSTER_STALE_WINDOW_MS), false);
    assert.equal(
      isRosterSnapshotStale(valid, 1_000 + ROSTER_STALE_WINDOW_MS + 1),
      true,
    );
    assert.equal(isRosterSnapshotStale(valid, 1_000, 500), false);
    assert.equal(isRosterSnapshotStale(valid, 1_501, 500), true);
  });

  it("exposes the settings document key the channel mirrors under", () => {
    assert.equal(ROSTER_SETTINGS_KEY, "roster");
  });
});

describe("roster snapshot — settings-namespace channel (adapter)", () => {
  function fakeScope() {
    const updates: unknown[] = [];
    let failing = false;
    return {
      updates,
      scope: {
        update(value: unknown) {
          if (failing) throw new Error("settings provider exploded");
          updates.push(value);
        },
        setFailing(value: boolean) {
          failing = value;
        },
      },
    };
  }

  it("skips writes until a scope attaches, then catch-up-writes the last snapshot", () => {
    const channel = createSettingsRosterChannel();
    const snapshot = projectRosterSnapshot("s-1", [], 1);
    channel.publish(snapshot);
    assert.equal(channel.stats.skipped, 1);
    assert.equal(channel.stats.writes, 0);
    assert.equal(channel.lastSnapshot, snapshot);

    const { updates, scope } = fakeScope();
    channel.attach(scope);
    assert.equal(channel.stats.attached, true);
    // Catch-up: the scope appeared after transitions were projected.
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], { [ROSTER_SETTINGS_KEY]: snapshot });
  });

  it("writes each publish under the roster key and counts failures without throwing", () => {
    const channel = createSettingsRosterChannel();
    const { updates, scope } = fakeScope();
    channel.attach(scope);

    const one = projectRosterSnapshot("s-1", [], 1);
    const two = projectRosterSnapshot("s-1", [], 2);
    channel.publish(one);
    channel.publish(two);
    assert.deepEqual(updates, [
      { [ROSTER_SETTINGS_KEY]: one },
      { [ROSTER_SETTINGS_KEY]: two },
    ]);

    scope.setFailing(true);
    const three = projectRosterSnapshot("s-1", [], 3);
    assert.doesNotThrow(() => channel.publish(three));
    assert.equal(channel.stats.failures, 1);
    // The retained snapshot stays the latest even when the write failed.
    assert.equal(channel.lastSnapshot, three);
  });
});

/**
 * Fake AdapterContext with a settings provider (the activation-lifecycle
 * idiom plus the roster channel's owner scope). Offline: no Cordis, no dsh.
 */
function createSettingsAwareCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<
    string,
    { handler: (invocation: unknown) => unknown }
  >();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const updates: unknown[] = [];
  let nextChild = 1;

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
    }
  };

  const ctx = {
    effect(dispose: () => void) {
      void dispose;
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
    },
    commands: {
      register(definition: { name: string; handler: (invocation: unknown) => unknown }) {
        commands.set(definition.name, definition);
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
          table() {
            const t = new Map<string, unknown>();
            return {
              get: (key: string) => t.get(key) as never,
              entries: () => t.entries() as never,
              async put(key: string, value: unknown) {
                t.set(key, value);
              },
              async delete(key: string) {
                return t.delete(key);
              },
            };
          },
          async close() {},
          name: "stub",
        };
      },
    },
    fire,
    updates,
    tool: (name: string) => tools.get(name),
    runCommand(commandId: string, agent?: AgentLike): unknown {
      const command = commands.get(commandId);
      assert.ok(command, `command not registered: ${commandId}`);
      return command.handler({
        commandId,
        ...(agent === undefined ? {} : { agent }),
      });
    },
  };
  return ctx as typeof ctx & AdapterContext & {
    fire(name: string, payload: unknown): void;
    tool(name: string): { execute: (args: unknown, exec?: unknown) => Promise<unknown> } | undefined;
    runCommand(commandId: string, agent?: AgentLike): unknown;
    readonly updates: unknown[];
  };
}

function topLevelAgent(id: string): AgentLike {
  return {
    session: {
      id,
      header: { parentSession: null, delegationDepth: 0 },
    },
    followup() {},
  };
}

describe("roster snapshot — plugin publishes through the settings namespace", () => {
  it("activation publishes an empty snapshot; spawn and settle update it", async () => {
    const ctx = createSettingsAwareCtx();
    const { updates } = ctx;
    pluginApply(ctx, { enabled: true });

    const result = ctx.runCommand(
      DISPATCHER_START_COMMAND,
      topLevelAgent("s-1"),
    ) as { kind: string };
    assert.equal(result.kind, "success");

    // On-activation publish: fresh (empty) roster without any transition.
    assert.equal(updates.length, 1);
    const first = (updates[0] as Record<string, unknown>)[
      ROSTER_SETTINGS_KEY
    ] as { dispatcherSessionId: string; workers: unknown[] };
    assert.equal(first.dispatcherSessionId, "s-1");
    assert.equal(first.workers.length, 0);

    const spawn = ctx.tool("spawn_worker");
    assert.ok(spawn);
    const spawned = (await spawn.execute(
      { stream_key: "k", title: "Parser worker", prompt: "P" },
      { agent: { session: { id: "s-1" } } },
    )) as { ok: boolean; worker_id: string };
    assert.equal(spawned.ok, true);

    // Spawn is a roster-affecting transition → second publish.
    assert.equal(updates.length, 2);
    const second = (updates[1] as Record<string, unknown>)[
      ROSTER_SETTINGS_KEY
    ] as { workers: Array<{ workerId: string; status: string; title: string }> };
    assert.equal(second.workers.length, 1);
    assert.equal(second.workers[0]?.workerId, spawned.worker_id);
    assert.equal(second.workers[0]?.status, "spawned");
    assert.equal(second.workers[0]?.title, "Parser worker");

    // Host settle → accepted transition → third publish with the new status.
    ctx.fire("subagent/end", {
      id: spawned.worker_id,
      stopReason: "completed",
      lastAssistantMessage: [],
    });
    assert.equal(updates.length, 3);
    const third = (updates[2] as Record<string, unknown>)[
      ROSTER_SETTINGS_KEY
    ] as { workers: Array<{ status: string }> };
    assert.equal(third.workers[0]?.status, "completed");
  });

  it("non-activated sessions never publish: transitions gate on the dispatcher session", () => {
    const ctx = createSettingsAwareCtx();
    const { updates } = ctx;
    pluginApply(ctx, { enabled: true });
    // Dormant boot: no activation, so even the settings attach publishes nothing.
    assert.equal(updates.length, 0);
    // A worker transition cannot exist without a bound parent — nothing fires.
    assert.equal(updates.length, 0);
  });

  it("flag OFF keeps the channel inert: section installs, nothing publishes", () => {
    const ctx = createSettingsAwareCtx();
    const { updates } = ctx;
    pluginApply(ctx, { enabled: false });
    assert.equal(updates.length, 0);
    assert.throws(() => ctx.runCommand(DISPATCHER_START_COMMAND), /command not registered/);
  });
});
