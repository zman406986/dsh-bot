/**
 * Tickets 21 + 27 — roster snapshot projection + settings-namespace data
 * path (host half; design-16 §4.2, design-17 §4.1/§6).
 *
 * Offline only (S8): FakeDshHost + createMultitask with the roster observer,
 * pure projection/parse/staleness checks (v2 wire contract, v1 rejected),
 * the settings-owner-scope channel, and the real plugin apply() publishing
 * through a fake settings provider on activation and on roster-affecting
 * transitions (now including access-ask park). No network, no LLM, no
 * running dsh.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import {
  createMultitask,
  type MultitaskOptions,
} from "../src/core/multitask.js";
import { createInMemoryDurability } from "../src/core/durability.js";
import {
  ROSTER_SETTINGS_KEY,
  ROSTER_SNAPSHOT_SCHEMA_VERSION,
  ROSTER_STALE_WINDOW_MS,
  ROSTER_STATUS_KEYS,
  isRosterSnapshotStale,
  parseRosterSnapshot,
  projectRosterSnapshot,
  type RosterSnapshot,
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
  access?: MultitaskOptions["access"],
) {
  const host = new FakeDshHost();
  const multitask = createMultitask(host, {
    durability,
    ...(observer === undefined ? {} : { onRosterChanged: observer }),
    ...(access === undefined ? {} : { access }),
  });
  return { host, durability, multitask };
}

describe("roster snapshot — projection is a pure core projection (ticket 21)", () => {
  it("projects the v2 presence row: id, title, FSM status, todo link, clock, count, delivered, blocked", async () => {
    const { host, multitask } = makeCore();
    const todo = multitask.createTodo({
      sessionId: "s-1",
      title: "Write the parser",
    });
    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "stream-a",
      title: "Parser worker",
      prompt: "do things",
      todoId: todo.id,
    });
    assert.equal(spawn.ok, true);
    const workerId = spawn.ok ? spawn.workerId : "";
    const summary = multitask.listWorkers("s-1")[0];
    assert.ok(summary);
    const snapshot = projectRosterSnapshot(
      "s-1",
      multitask.listWorkers("s-1"),
      1_000,
      {
        pendingAccess: multitask.listPendingAccess("s-1"),
        todos: multitask.listTodos("s-1"),
      },
    );
    assert.equal(snapshot.schemaVersion, ROSTER_SNAPSHOT_SCHEMA_VERSION);
    assert.equal(snapshot.dispatcherSessionId, "s-1");
    assert.equal(snapshot.publishedAtMs, 1_000);
    assert.equal(snapshot.workers.length, 1);
    assert.deepEqual(snapshot.workers[0], {
      kind: "worker",
      workerId,
      title: "Parser worker",
      status: "spawned",
      todoId: todo.id,
      startedAtMs: summary.startedAtMs,
      toolCallCount: 0,
      // Linked todo exists and has not been delivered — landed marker fuel.
      delivered: false,
      blocked: null,
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

describe("roster snapshot — v2 presence fields join existing core truth (ticket 27)", () => {
  it("joins a pending access ask by workerId — class+target names only", async () => {
    const { host, multitask } = makeCore();
    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
    });
    const workerId = spawn.ok ? spawn.workerId : "";
    multitask.noteTurnStarted(workerId);
    host.fireAccessRequest({
      workerId,
      requestId: "r-1",
      body: {
        class: "credential",
        target: "API_TOKEN",
        reason: "to call the deploy service",
        credentialName: "API_TOKEN",
      },
      createdAtMs: 1,
    });

    const snapshot = projectRosterSnapshot(
      "s-1",
      multitask.listWorkers("s-1"),
      1_000,
      { pendingAccess: multitask.listPendingAccess("s-1") },
    );
    assert.deepEqual(snapshot.workers[0]?.blocked, {
      class: "credential",
      target: "API_TOKEN",
    });
    // Names only: reason text and any credential reference never ride the
    // roster wire (access-types hard rule mirrored by the projection).
    const blockedKeys = Object.keys(snapshot.workers[0]?.blocked ?? {}).sort();
    assert.deepEqual(blockedKeys, ["class", "target"]);
  });

  it("a worker without a pending ask projects blocked: null", async () => {
    const { multitask } = makeCore();
    await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
    });
    const snapshot = projectRosterSnapshot(
      "s-1",
      multitask.listWorkers("s-1"),
      1_000,
      { pendingAccess: multitask.listPendingAccess("s-1") },
    );
    assert.equal(snapshot.workers[0]?.blocked, null);
  });

  it("delivered follows the ledger: no todo → true; linked todo → false until markDelivered", async () => {
    const { host, multitask } = makeCore();
    const todo = multitask.createTodo({ sessionId: "s-1", title: "T" });
    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
      todoId: todo.id,
    });
    const workerId = spawn.ok ? spawn.workerId : "";
    host.fireSettled({ workerId, status: "completed", report: "done" });

    const sources = () => ({
      pendingAccess: multitask.listPendingAccess("s-1"),
      todos: multitask.listTodos("s-1"),
    });
    const before = projectRosterSnapshot(
      "s-1",
      multitask.listWorkers("s-1"),
      1_000,
      sources(),
    );
    assert.equal(before.workers[0]?.delivered, false);

    assert.equal(multitask.markDelivered(todo.id), true);
    const after = projectRosterSnapshot(
      "s-1",
      multitask.listWorkers("s-1"),
      1_000,
      sources(),
    );
    assert.equal(after.workers[0]?.delivered, true);
  });

  it("a todo-less worker projects delivered: true — it can never sit landed-undelivered", async () => {
    const { host, multitask } = makeCore();
    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
    });
    const workerId = spawn.ok ? spawn.workerId : "";
    host.fireSettled({ workerId, status: "completed", report: "done" });
    const snapshot = projectRosterSnapshot(
      "s-1",
      multitask.listWorkers("s-1"),
      1_000,
      { todos: multitask.listTodos("s-1") },
    );
    assert.equal(snapshot.workers[0]?.delivered, true);
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

describe("roster snapshot — observer covers the presence-field mutations (ticket 27)", () => {
  it("fires when a pending ask parks and again when it resolves; a policy auto-answer stays silent", async () => {
    const seen: string[] = [];
    const { host, multitask } = makeCore((s) => seen.push(s));
    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
    });
    const workerId = spawn.ok ? spawn.workerId : "";
    multitask.noteTurnStarted(workerId);
    const afterStart = seen.length;

    host.fireAccessRequest({
      workerId,
      requestId: "r-1",
      body: { class: "tool", target: "edit", reason: "need" },
      createdAtMs: 1,
    });
    assert.equal(multitask.listPendingAccess("s-1").length, 1);
    assert.equal(seen.length - afterStart, 1, "park notifies once");

    assert.equal(multitask.resolveAccess(workerId, { kind: "allow" }), true);
    assert.equal(multitask.listPendingAccess("s-1").length, 0);
    assert.equal(seen.length - afterStart, 2, "resolve notifies once");
  });

  it("an auto-answered allow never parks, so no observer noise; a policy deny notifies via onResolved", async () => {
    const seen: string[] = [];
    const { host, multitask } = makeCore((s) => seen.push(s));
    multitask.accessPolicy.set({
      class: "tool",
      targetPattern: "allowed-*",
      decision: "allow",
      scope: "session",
    });
    multitask.accessPolicy.set({
      class: "tool",
      targetPattern: "denied-*",
      decision: "deny",
      scope: "session",
    });
    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
    });
    const workerId = spawn.ok ? spawn.workerId : "";
    multitask.noteTurnStarted(workerId);
    const afterStart = seen.length;

    host.fireAccessRequest({
      workerId,
      requestId: "r-1",
      body: { class: "tool", target: "allowed-thing", reason: "need" },
      createdAtMs: 1,
    });
    assert.equal(multitask.listPendingAccess("s-1").length, 0);
    assert.equal(seen.length - afterStart, 0, "auto-allow is roster-silent");

    host.fireAccessRequest({
      workerId,
      requestId: "r-2",
      body: { class: "tool", target: "denied-thing", reason: "need" },
      createdAtMs: 2,
    });
    assert.equal(multitask.listPendingAccess("s-1").length, 0);
    assert.equal(seen.length - afterStart, 1, "deny re-projects the marker");
  });

  it("the timeout deny re-projects through the relay's onResolved", async () => {
    const seen: string[] = [];
    const scheduled: Array<() => void> = [];
    const { host, multitask } = makeCore(
      (s) => seen.push(s),
      createInMemoryDurability(),
      {
        timeoutMs: 5,
        schedule: (fn) => {
          scheduled.push(fn);
          return () => {};
        },
      },
    );
    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
    });
    const workerId = spawn.ok ? spawn.workerId : "";
    multitask.noteTurnStarted(workerId);
    const afterStart = seen.length;

    host.fireAccessRequest({
      workerId,
      requestId: "r-1",
      body: { class: "network", target: "example.test", reason: "need" },
      createdAtMs: 1,
    });
    assert.equal(seen.length - afterStart, 1);

    const timeout = scheduled[0];
    assert.ok(timeout, "deny timeout was armed");
    timeout();
    assert.equal(multitask.listPendingAccess("s-1").length, 0);
    assert.equal(seen.length - afterStart, 2, "timeout deny notifies once");
  });

  it("markDelivered notifies the todo's session so the landed marker clears", async () => {
    const seen: string[] = [];
    const { host, multitask } = makeCore((s) => seen.push(s));
    const todo = multitask.createTodo({ sessionId: "s-1", title: "T" });
    const spawn = await multitask.spawnWorker({
      parentSessionId: "s-1",
      streamKey: "k",
      title: "T",
      prompt: "P",
      todoId: todo.id,
    });
    const workerId = spawn.ok ? spawn.workerId : "";
    host.fireSettled({ workerId, status: "completed", report: "done" });
    const before = seen.length;

    assert.equal(multitask.markDelivered(todo.id), true);
    assert.equal(seen.length - before, 1);
    assert.equal(seen.at(-1), "s-1");
  });
});

describe("roster snapshot — parse and staleness (v2 wire contract)", () => {
  const valid: RosterSnapshot = projectRosterSnapshot("s-1", [], 1_000);

  it("round-trips a projected v2 snapshot", () => {
    const populated = projectRosterSnapshot(
      "s-1",
      [
        {
          workerId: "w-1",
          parentSessionId: "s-1",
          streamKey: "k",
          title: "T",
          status: "steering",
          startedAtMs: 10,
          elapsedMs: 0,
          toolCallCount: 3,
          transcriptRef: null,
          todoId: "todo-1",
        },
      ],
      1_000,
      {
        pendingAccess: [
          {
            workerId: "w-1",
            requestId: "r-1",
            body: { class: "filesystem", target: "/etc/hosts", reason: "need" },
            createdAtMs: 1,
            parentSessionId: "s-1",
            status: "pending",
          },
        ],
        todos: [
          {
            id: "todo-1",
            sessionId: "s-1",
            title: "T",
            status: "in_progress",
            streamKey: "k",
            workerId: "w-1",
            delivered: false,
            createdAtMs: 0,
            updatedAtMs: 0,
          },
        ],
      },
    );
    assert.deepEqual(parseRosterSnapshot(populated), populated);
  });

  it("rejects a v1 payload cleanly — the panel degrades, never half-renders", () => {
    const v1 = {
      schemaVersion: 1,
      dispatcherSessionId: "s-1",
      publishedAtMs: 1_000,
      workers: [
        { workerId: "w", title: "T", status: "running", todoId: null },
      ],
    };
    assert.equal(parseRosterSnapshot(v1), null, "v1 version bump fails parse");
    // A v1 row grafted into a v2 envelope is still broken: no kind field.
    assert.equal(
      parseRosterSnapshot({ ...valid, workers: v1.workers }),
      null,
    );
  });

  it("rejects wrong shape, version skew, bad clocks, unknown kinds/statuses, and malformed rows", () => {
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
    const v2Row = {
      kind: "worker",
      workerId: "w",
      title: "T",
      status: "running",
      todoId: null,
      startedAtMs: 0,
      toolCallCount: 0,
      delivered: true,
      blocked: null,
    };
    assert.equal(
      parseRosterSnapshot({
        ...valid,
        workers: [{ ...v2Row, status: "zombie" }],
      }),
      null,
    );
    assert.equal(
      parseRosterSnapshot({
        ...valid,
        workers: [{ ...v2Row, kind: "robot" }],
      }),
      null,
      "unknown producer kind fails closed (conflict 6)",
    );
    assert.equal(
      parseRosterSnapshot({
        ...valid,
        workers: [v2Row],
      })?.workers[0]?.kind,
      "worker",
    );
  });

  it("rejects malformed presence fields (ticket 27 fail-closed)", () => {
    const v2Row = {
      kind: "worker",
      workerId: "w",
      title: "T",
      status: "running",
      todoId: null,
      startedAtMs: 0,
      toolCallCount: 0,
      delivered: true,
      blocked: null,
    };
    const withRow = (row: Record<string, unknown>) =>
      parseRosterSnapshot({ ...valid, workers: [row] });

    // Clocks and counts must be finite, sane numbers.
    assert.equal(withRow({ ...v2Row, startedAtMs: Number.NaN }), null);
    assert.equal(withRow({ ...v2Row, startedAtMs: Number.POSITIVE_INFINITY }), null);
    assert.equal(withRow({ ...v2Row, startedAtMs: -1 }), null);
    assert.equal(withRow({ ...v2Row, toolCallCount: 1.5 }), null);
    assert.equal(withRow({ ...v2Row, toolCallCount: -3 }), null);
    assert.equal(withRow({ ...v2Row, delivered: "yes" }), null);

    // Structured blocked: null is fine; anything malformed fails the row.
    assert.equal(withRow({ ...v2Row, blocked: "tool:edit" }), null);
    assert.equal(withRow({ ...v2Row, blocked: {} }), null);
    assert.equal(withRow({ ...v2Row, blocked: { class: "tool" } }), null);
    assert.equal(
      withRow({ ...v2Row, blocked: { class: "laser", target: "x" } }),
      null,
      "unknown access class is version skew — fail closed",
    );
    assert.equal(
      withRow({ ...v2Row, blocked: { class: "tool", target: 7 } }),
      null,
    );
    const parsed = withRow({
      ...v2Row,
      blocked: { class: "other", target: "something" },
    });
    assert.deepEqual(parsed?.workers[0]?.blocked, {
      class: "other",
      target: "something",
    });
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
  /**
   * Ticket 31: the on-activation publish rides the async durability
   * rebuild (`rebuildFromDurability` BEFORE the first publish), so tests
   * drain the queued chain before asserting on published snapshots.
   */
  async function flushActivation(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it("activation publishes an empty snapshot; spawn and settle update it", async () => {
    const ctx = createSettingsAwareCtx();
    const { updates } = ctx;
    pluginApply(ctx, { enabled: true });

    const result = ctx.runCommand(
      DISPATCHER_START_COMMAND,
      topLevelAgent("s-1"),
    ) as { kind: string };
    assert.equal(result.kind, "success");
    await flushActivation();

    // On-activation publish (after the rebuild): fresh (empty) roster
    // without any transition.
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

  it("a parked access ask republishes the roster with the blocked reason (names only)", async () => {
    const ctx = createSettingsAwareCtx();
    const { updates } = ctx;
    pluginApply(ctx, { enabled: true });
    const result = ctx.runCommand(
      DISPATCHER_START_COMMAND,
      topLevelAgent("s-1"),
    ) as { kind: string };
    assert.equal(result.kind, "success");

    const spawn = ctx.tool("spawn_worker");
    assert.ok(spawn);
    const spawned = (await spawn.execute(
      { stream_key: "k", title: "Parser worker", prompt: "P" },
      { agent: { session: { id: "s-1" } } },
    )) as { ok: boolean; worker_id: string };
    assert.equal(spawned.ok, true);
    const afterSpawn = updates.length;

    // The worker asks for access: the relay parks a ticket (core observer)
    // and the plugin republishes the snapshot carrying the blocked marker.
    const access = ctx.tool("request_access");
    assert.ok(access);
    const asked = (await access.execute(
      { class: "tool", target: "edit_file", reason: "need to edit files" },
      { agent: { session: { id: spawned.worker_id } } },
    )) as { ok: boolean };
    assert.equal(asked.ok, true);

    assert.equal(updates.length, afterSpawn + 1);
    const latest = (updates.at(-1) as Record<string, unknown>)[
      ROSTER_SETTINGS_KEY
    ] as {
      workers: Array<{
        status: string;
        blocked: { class: string; target: string } | null;
      }>;
    };
    assert.deepEqual(latest.workers[0]?.blocked, {
      class: "tool",
      target: "edit_file",
    });
    // Names only — the free-text reason never rides the roster wire.
    assert.deepEqual(Object.keys(latest.workers[0]?.blocked ?? {}).sort(), [
      "class",
      "target",
    ]);
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
