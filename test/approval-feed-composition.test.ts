/**
 * Ticket 69 — L1 offline COMPOSITION pin: the REAL wiring, end to end.
 *
 * The unit suites pin the pieces (projections, the feed hub, the resolve
 * transport, the dispatch seam). This file pins the COMPOSITION the shipped
 * code actually builds: no hand-reconstructed copy of the handler wiring, no
 * test-owned hub. Everything below runs the real `apply` (host) and the real
 * `applyClientModule` (client) against fakes that implement only the Cordis
 * seams each half rides.
 *
 * The chain under test:
 *
 *   real `apply({enabled:true})` → real `/dispatcher-start` activation
 *   → real `spawn_worker` tool → real `request_access` tool
 *   → core parks the ask → the real `/dispatcher-resolve` command → core relay
 *   → the parked tool call settles; answering again is honestly refused.
 *
 * Client half: the composition's OWN hub (`approvalsFeed` / `mirrorsFeed`) is
 * fed the real `projectRosterSnapshot` product, exactly as the removed host
 * channel used to publish it; the REAL `mountShellPage` attaches to those
 * hubs and its own stores project the cards, the sidebar flag/presence, and
 * the hosted panel.
 *
 * dsh 0.2.1 removed the client settings-scope service and rejects undeclared
 * settings keys, so the host→document→watch leg is gone. The host half's
 * `roster`/`roster.<id>` mirror is retired with it (ADR-0024); the client
 * hub and the mount machinery stay as retained, unmounted machinery, and
 * this suite drives exactly those.
 *
 * Offline only (S8): no Cordis, no browser, no DOM, no network, no LLM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply as pluginApply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import {
  applyClientModule,
  mountShellPage,
  type ClientModuleComposition,
  type ShellPageMount,
} from "../src/client/index.js";
import type { ClientContext } from "../src/client/context.js";
import { createRosterStore } from "../src/client/roster-store.js";
import { describeShellSidebar } from "../src/client/shell-store.js";
import { shellSeatHostsPanel } from "../src/client/shell-mount.js";
import type { AccessAskCard } from "../src/client/approval-cards.js";
import { APPROVAL_LOCATION_LOCAL } from "../src/adapter/access-prompt.js";
import {
  DISPATCHER_RESOLVE_COMMAND,
  DISPATCHER_START_COMMAND,
  dispatcherResolveNoPendingAsk,
  dispatcherResolveSuccess,
  rosterSessionKey,
  type AdapterContext,
  type AgentLike,
  type CommandResultLike,
} from "../src/adapter/index.js";
import {
  ROSTER_SETTINGS_KEY,
  projectRosterSnapshot,
  type RosterSnapshot,
} from "../src/core/roster-snapshot.js";
import type { WorkerSummary } from "../src/core/types.js";

// ── The published document: the shape the removed host channel wrote ──────

/**
 * One roster document keyed the way the retired channel wrote it: the legacy
 * whole-snapshot key plus the per-session mirror key the shell stores read.
 * The value is the REAL projection product; only the envelope keys are the
 * historical wire shape the client parsers still read.
 */
function publishedRoster(snapshot: RosterSnapshot): Record<string, unknown> {
  return {
    [ROSTER_SETTINGS_KEY]: snapshot,
    [rosterSessionKey(snapshot.dispatcherSessionId)]: snapshot,
  };
}

/** A worker summary sourced from one real spawn result. */
function workerSummary(
  workerId: string,
  title: string,
  parentSessionId: string,
): WorkerSummary {
  return {
    workerId,
    parentSessionId,
    streamKey: `k-${workerId}`,
    title,
    status: "running",
    startedAtMs: Date.now(),
    elapsedMs: 0,
    toolCallCount: 0,
    transcriptRef: null,
    todoId: null,
  };
}

// ── Host fake (activation-lifecycle idiom) ────────────────────────────────

function topLevelAgent(id: string): AgentLike {
  return {
    session: { id, header: { parentSession: null, delegationDepth: 0 } },
    followup() {},
  };
}

function createHostCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<
    string,
    { handler: (invocation: unknown) => unknown }
  >();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const disposers: Array<() => void> = [];
  const sendMessageCalls: Array<{
    parentId: string;
    workerId: string;
    text: string;
  }> = [];
  let nextChild = 1;

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) cb(payload as never);
  };

  const ctx = {
    // Cordis effect contract: `execute` runs at apply; a returned function —
    // or each value a generator yields — is the unload disposer.
    effect(execute: () => unknown, label?: string) {
      void label;
      const result = execute();
      if (typeof result === "function") {
        disposers.push(result as () => void);
        return;
      }
      if (
        typeof result === "object" &&
        result !== null &&
        Symbol.iterator in result
      ) {
        for (const step of result as Iterable<unknown>) {
          if (typeof step === "function") disposers.push(step as () => void);
        }
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
      register(definition: { name: string; handler: (invocation: unknown) => unknown }) {
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
      async startActivation() {
        const childId = `child-${nextChild++}`;
        return {
          childId,
          messageId: `msg-${childId}`,
          result: Promise.resolve({ ok: true as const }),
          dispose: async () => {},
        };
      },
      interrupt() {},
      async sendMessage(
        parent: { session?: { id?: unknown } },
        workerId: string,
        blocks: Array<{ text?: string }>,
      ) {
        sendMessageCalls.push({
          parentId: String(parent?.session?.id ?? ""),
          workerId,
          text: blocks.map((block) => block.text ?? "").join(""),
        });
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
    // Test surface.
    fire,
    tool: (name: string) => tools.get(name),
    runCommand(invocation: {
      commandId: string;
      agent?: AgentLike;
      rawInput?: string;
    }): CommandResultLike {
      const command = commands.get(invocation.commandId);
      assert.ok(command, `command not registered: ${invocation.commandId}`);
      return command.handler(invocation as never) as CommandResultLike;
    },
    sendMessageCalls,
    // The plugin's unload/HMR teardown (every effect disposer, reverse
    // order — the fiber cascade).
    runTeardown() {
      for (const dispose of [...disposers].reverse()) dispose();
    },
  };
  return ctx as typeof ctx & AdapterContext;
}

// ── Client fake (client-roster-panel idiom) ───────────────────────────────

function createClientCtx() {
  const locales = new Map<string, unknown>();
  const injects: Array<{ parent: string; entries: unknown[] }> = [];
  const injectControllers: Array<() => void> = [];
  const effectDisposers: Array<() => void> = [];
  // The sessions feed state (ticket 94's pin; mutated by `setSessions`).
  let feedIds: string[] = [];
  let feedById: Record<string, { id: string; displayTitle?: string }> = {};
  const feedSubscribers = new Set<() => void>();

  const ctx = {
    effect(execute: () => unknown, label?: string) {
      void label;
      const returned = execute();
      const disposer: () => void =
        typeof returned === "function" ? returned : () => {};
      effectDisposers.push(disposer);
      return () => {};
    },
    slots: {
      inject(parent: string, callback: () => unknown) {
        const record = { parent, entries: [] as unknown[] };
        injects.push(record);
        callback();
        const controller = () => {
          const at = injects.indexOf(record);
          if (at >= 0) injects.splice(at, 1);
          record.entries.length = 0;
        };
        injectControllers.push(controller);
        return controller;
      },
      register(options: unknown, component: unknown) {
        const owner = injects.at(-1);
        assert.ok(owner, "slots.register outside of slots.inject (fake)");
        owner.entries.push({ options, component });
        return () => {};
      },
    },
    locale: {
      register(namespace: string, dictionary: unknown) {
        locales.set(namespace, dictionary);
        return () => {
          locales.delete(namespace);
        };
      },
      bind(namespace: string) {
        return (key: string) => {
          const dict = locales.get(namespace) as
            | { en: Record<string, string> }
            | undefined;
          return dict?.en[key] ?? key;
        };
      },
    },
    // The sessions feed (ticket 79's row authority; ticket 94's pin needs
    // rows so the mirror's flag/presence can be asserted on a delivered row).
    // Structural shape of the verified read face
    // (`dsh-api-session-controller` `SessionListState`): ids + byId.
    sessions: {
      list: {
        getSnapshot: () => ({ ids: feedIds, byId: feedById }),
        subscribe(listener: () => void) {
          feedSubscribers.add(listener);
          return () => {
            feedSubscribers.delete(listener);
          };
        },
      },
    },
    // Test surface.
    injects,
    setSessions(rows: Array<{ id: string; displayTitle?: string }>) {
      feedIds = rows.map((row) => row.id);
      feedById = Object.fromEntries(rows.map((row) => [row.id, row]));
      for (const listener of [...feedSubscribers]) listener();
    },
    runFiberTeardown() {
      for (const dispose of [...effectDisposers, ...injectControllers]) {
        dispose();
      }
    },
  };
  return ctx as typeof ctx & ClientContext & {
    setSessions(rows: Array<{ id: string; displayTitle?: string }>): void;
    runFiberTeardown(): void;
  };
}

// ── Assertion helpers ─────────────────────────────────────────────────────

/**
 * The default composition creates NO mounts, so the mount data path is
 * driven by attaching the REAL `mountShellPage` to the composition's returned
 * hubs — the attach a re-host registration makes at its own site.
 */
function attachMount(
  client: ReturnType<typeof createClientCtx>,
  composition: ClientModuleComposition,
): ShellPageMount {
  return mountShellPage(client, {
    approvalsFeed: composition.approvalsFeed,
    mirrorsFeed: composition.mirrorsFeed,
  });
}

/** The mount's OWN approvals store, projected cards only. */
function cardsOf(mount: ShellPageMount): readonly AccessAskCard[] {
  const state = mount.approvals.getBox().state;
  assert.equal(state.kind, "ready", "the mount's store must be fed");
  return state.kind === "ready" ? state.cards : [];
}

/** Drain the async half of activation (durability rebuild) + delivery. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface SpawnedWorker {
  readonly ok: boolean;
  readonly worker_id: string;
}

interface AskedAccess {
  readonly ok: boolean;
  readonly requestId: string;
}

/**
 * A short (but never reached) ADR-0008 ask timeout: the real plugin arms the
 * 120s default timer at park, and an offline test that fails before its ask
 * settles would keep the process alive for the full two minutes. The config
 * knob is real; 5s is still far beyond anything these tests do (every ask is
 * settled within the same test body).
 */
const ACCESS_TIMEOUT_MS = 5_000;

describe("ticket 69 L1 — the offline composition pin (real apply → real spawn/ask/resolve → the composition's own hubs)", () => {
  it("parks a real ask, shows it on the composition's OWN mount, and resolves it through the real command", async () => {
    const host = createHostCtx();
    const client = createClientCtx();

    // ── Host half: the real plugin, activated for one dispatcher session.
    pluginApply(host, volatileConfig({ enabled: true, accessRequestTimeoutMs: ACCESS_TIMEOUT_MS }));
    const started = host.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: topLevelAgent("s-1"),
    });
    assert.deepEqual(started.kind, "success");
    await flush();

    // ── Client half: the REAL module body. The composition creates NO mounts
    // — its live data path is the feed pair, and the REAL mount machinery
    // attaches to those hubs at a re-host registration site.
    const composition: ClientModuleComposition = applyClientModule(
      client,
      createRosterStore(),
    );
    assert.equal(
      composition.mounts.length,
      0,
      "the default posture registers no mounts",
    );
    const mount = attachMount(client, composition);
    // Before any publish the hub has no truth to replay: the store honestly
    // stays unfed rather than fabricating "nothing waiting".
    assert.equal(mount.approvals.getBox().state.kind, "unfed");

    // ── A real worker spawns through the real tool.
    const spawn = host.tool("spawn_worker");
    assert.ok(spawn);
    const spawned = (await spawn.execute(
      { stream_key: "k-1", title: "Parser worker", prompt: "Parse." },
      { agent: { session: { id: "s-1" } } },
    )) as SpawnedWorker;
    assert.equal(spawned.ok, true);

    // ── The worker parks a real access ask through the real tool.
    // FINDING 4 contract (ticket 69): the tool call PARKS until the ask
    // settles; the settlement lands when the command answers below.
    const access = host.tool("request_access");
    assert.ok(access);
    const askState = { settled: false };
    const askedPromise = access
      .execute(
        { class: "tool", target: "edit_file", reason: "need to edit files" },
        { agent: { session: { id: spawned.worker_id } } },
      )
      .then((value) => {
        askState.settled = true;
        return value as AskedAccess;
      });
    await flush();
    assert.equal(
      askState.settled,
      false,
      "the tool call stays parked while the ask is pending (old code acked at park time)",
    );

    // The composition's own hub takes the real projection — the product the
    // removed host channel used to publish — and fans it out.
    const parked = projectRosterSnapshot(
      "s-1",
      [workerSummary(spawned.worker_id, "Parser worker", "s-1")],
      Date.now(),
      {
        pendingAccess: [
          {
            workerId: spawned.worker_id,
            requestId: "ask-1",
            body: { class: "tool", target: "edit_file", reason: "need to edit files" },
            createdAtMs: Date.now(),
            parentSessionId: "s-1",
            status: "pending",
          },
        ],
      },
    );
    composition.approvalsFeed.applyChannelValue(publishedRoster(parked));
    composition.mirrorsFeed.applyChannelValue(publishedRoster(parked));

    // The card is on the attached mount's own store — the hub fanned the
    // one read out through it.
    const cards = cardsOf(mount);
    assert.equal(cards.length, 1, "one pending card on the mount");
    const card = cards[0];
    assert.ok(card);
    assert.equal(card.cardKind, "access-ask");
    assert.equal(card.status, "pending");
    assert.equal(card.requestId, "ask-1");
    assert.equal(card.workerId, spawned.worker_id);
    assert.equal(card.parentSessionId, "s-1");
    assert.equal(card.body.class, "tool");
    assert.equal(card.body.target, "edit_file");
    assert.ok(card.detail.includes("need to edit files"));
    // Ticket 30's full option set for an exact target; the 71 AC-4 location
    // line resolved through the card's own hook (never hard-coded here).
    assert.deepEqual(
      card.optionSet.map((option) => option.kind),
      ["allow", "always-allow", "deny"],
    );
    assert.equal(card.locationLine, APPROVAL_LOCATION_LOCAL);

    // ── The real command resolves it into the unchanged core relay.
    const resolved = host.runCommand({
      commandId: DISPATCHER_RESOLVE_COMMAND,
      agent: topLevelAgent("s-1"),
      rawInput: `${spawned.worker_id} allow`,
    });
    assert.deepEqual(resolved, {
      kind: "success",
      text: dispatcherResolveSuccess(spawned.worker_id),
    });
    await flush();

    // The relay delivered the wrapped decision to the worker...
    assert.ok(
      host.sendMessageCalls.some(
        (call) =>
          call.workerId === spawned.worker_id &&
          call.text.includes("[Parent: access allowed]"),
      ),
      "the decision reached the worker",
    );
    // ... the parked TOOL call settled honestly once the ask left the relay
    // (FINDING 4: the park holds the tool call, so the settlement landed
    // through it, and the worker's turn could not be settled-while-owed).
    const asked = await askedPromise;
    assert.equal(asked.ok, true);
    assert.equal(askState.settled, true);

    // The hub's next publish (no pending ask) takes the card off the mount.
    const afterResolve = projectRosterSnapshot(
      "s-1",
      [workerSummary(spawned.worker_id, "Parser worker", "s-1")],
      Date.now(),
    );
    composition.approvalsFeed.applyChannelValue(publishedRoster(afterResolve));
    assert.deepEqual(cardsOf(mount), []);

    // Answering again after settle is honestly refused through the SAME real
    // command (the ticket is gone, not silently re-resolved).
    const again = host.runCommand({
      commandId: DISPATCHER_RESOLVE_COMMAND,
      agent: topLevelAgent("s-1"),
      rawInput: `${spawned.worker_id} allow`,
    });
    assert.deepEqual(again, {
      kind: "error",
      text: dispatcherResolveNoPendingAsk(spawned.worker_id),
    });
  });

  it("the host half needs no settings seam at all: apply works over a context without one", async () => {
    // 0.2.1 derives the form from the row's own Config, so the plugin no
    // longer installs a settings section or holds an owner scope. The fake
    // below has no `inject`, so any settings request would be a no-op at
    // best and a crash at worst — applying cleanly is the pin.
    const host = createHostCtx();
    assert.equal(
      (host as unknown as { inject?: unknown }).inject,
      undefined,
      "the fake carries no inject seam",
    );
    pluginApply(host, volatileConfig({ enabled: true, accessRequestTimeoutMs: ACCESS_TIMEOUT_MS }));
    const started = host.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: topLevelAgent("s-1"),
    });
    assert.deepEqual(started.kind, "success");
    await flush();
    // The dispatcher tools registered on activation — the enabled path ran.
    assert.ok(host.tool("spawn_worker"));
    assert.doesNotThrow(() => host.runTeardown());
  });

  it("ticket 94: the mount's shell store is fed the per-session mirror (flag, presence, hosted panel)", async () => {
    const host = createHostCtx();
    const client = createClientCtx();
    // The feed is the row authority: one delivered row for the dispatcher.
    client.setSessions([{ id: "s-1", displayTitle: "Dispatcher chat" }]);

    pluginApply(host, volatileConfig({ enabled: true, accessRequestTimeoutMs: ACCESS_TIMEOUT_MS }));
    host.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: topLevelAgent("s-1"),
    });
    await flush();

    const composition = applyClientModule(client, createRosterStore());
    assert.equal(
      composition.mounts.length,
      0,
      "the default posture registers no mounts",
    );
    const mount = attachMount(client, composition);

    // The activation snapshot lands through the composition's mirror hub.
    const activated = projectRosterSnapshot("s-1", [], Date.now());
    composition.mirrorsFeed.applyChannelValue(publishedRoster(activated));
    {
      const state = mount.store.getBox().state;
      // The mirror landed: the row is OURS (flag true) with live presence.
      const row = state.rows.get("s-1");
      assert.equal(row?.dispatcher, true, "the dispatcher flag is live");
      assert.deepEqual(row?.presence, { working: 0, needsYou: 0, finished: 0 });
      assert.equal(state.mirrors.get("s-1")?.kind, "snapshot");

      // The sidebar view: dispatcher row first, presence available.
      const sidebar = describeShellSidebar(state, Date.now());
      assert.equal(sidebar.kind, "ready");
      assert.equal(sidebar.kind === "ready" ? sidebar.rows.length : 0, 1);
      const view = sidebar.kind === "ready" ? sidebar.rows[0] : undefined;
      assert.equal(view?.sessionId, "s-1");
      assert.equal(view?.presenceAvailable, true);
      assert.equal(view?.presence?.working, 0);

      // The right seat HOSTS the roster panel for that session.
      assert.equal(
        shellSeatHostsPanel(state.mirrors.get("s-1")),
        true,
        "the panel is hosted",
      );
      assert.notEqual(mount.hosts.rosterPanel({ sessionId: "s-1" }), null);
      // …and NOT for a session the mirrors do not vouch for.
      assert.equal(mount.hosts.rosterPanel({ sessionId: "s-other" }), null);
    }

    // A real spawn republishes through the same hub: the presence counts
    // move on the MOUNT'S OWN store (no second feed, no second store).
    const spawn = host.tool("spawn_worker");
    assert.ok(spawn);
    const spawned = (await spawn.execute(
      { stream_key: "k-94", title: "Mirror worker", prompt: "P." },
      { agent: { session: { id: "s-1" } } },
    )) as SpawnedWorker;
    const withWorker = projectRosterSnapshot(
      "s-1",
      [workerSummary(spawned.worker_id, "Mirror worker", "s-1")],
      Date.now(),
    );
    composition.mirrorsFeed.applyChannelValue(publishedRoster(withWorker));
    {
      const row = mount.store.getBox().state.rows.get("s-1");
      assert.deepEqual(row?.presence, { working: 1, needsYou: 0, finished: 0 });
    }

    // Selecting the row projects the hosted panel's OWN store onto the same
    // mirror (the seat projection) — the panel renders from a parsed
    // snapshot, not from a copy.
    mount.store.select("s-1");
    const seatState = mount.seat.getBox().state;
    assert.equal(seatState.kind, "snapshot");
    assert.equal(
      seatState.kind === "snapshot" ? seatState.snapshot.workers.length : -1,
      1,
    );
  });

  it("ticket 94: the mount's mirror feed detaches with the client fiber", async () => {
    const host = createHostCtx();
    const client = createClientCtx();
    client.setSessions([{ id: "s-1", displayTitle: "Dispatcher chat" }]);

    pluginApply(host, volatileConfig({ enabled: true, accessRequestTimeoutMs: ACCESS_TIMEOUT_MS }));
    host.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: topLevelAgent("s-1"),
    });
    await flush();

    const composition = applyClientModule(client, createRosterStore());
    const mount = attachMount(client, composition);
    composition.mirrorsFeed.applyChannelValue(
      publishedRoster(projectRosterSnapshot("s-1", [], Date.now())),
    );
    assert.equal(mount.store.getBox().state.rows.get("s-1")?.dispatcher, true);

    // Unload the client fiber: every effect (each mount's feed attach) goes
    // with it.
    client.runFiberTeardown();

    // A later publish reaches nothing — the detached store keeps its last
    // truth instead of being fed by a dead fiber.
    const spawn = host.tool("spawn_worker");
    assert.ok(spawn);
    const spawned = (await spawn.execute(
      { stream_key: "k-94b", title: "Late worker", prompt: "P." },
      { agent: { session: { id: "s-1" } } },
    )) as SpawnedWorker;
    composition.mirrorsFeed.applyChannelValue(
      publishedRoster(
        projectRosterSnapshot(
          "s-1",
          [workerSummary(spawned.worker_id, "Late worker", "s-1")],
          Date.now(),
        ),
      ),
    );
    assert.deepEqual(mount.store.getBox().state.rows.get("s-1")?.presence, {
      working: 0,
      needsYou: 0,
      finished: 0,
    });
  });

  it("the composition detaches its mounts from the hub with the client fiber", async () => {
    const host = createHostCtx();
    const client = createClientCtx();

    pluginApply(host, volatileConfig({ enabled: true, accessRequestTimeoutMs: ACCESS_TIMEOUT_MS }));
    host.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: topLevelAgent("s-1"),
    });
    await flush();

    const composition = applyClientModule(client, createRosterStore());
    // The mount machinery attaches to the composition's own hubs; its feed
    // attach is an effect on the same client fiber.
    const mount = attachMount(client, composition);
    const spawn = host.tool("spawn_worker");
    assert.ok(spawn);
    const spawned = (await spawn.execute(
      { stream_key: "k-2", title: "Second worker", prompt: "P." },
      { agent: { session: { id: "s-1" } } },
    )) as SpawnedWorker;
    composition.approvalsFeed.applyChannelValue(
      publishedRoster(
        projectRosterSnapshot(
          "s-1",
          [workerSummary(spawned.worker_id, "Second worker", "s-1")],
          Date.now(),
          {
            pendingAccess: [
              {
                workerId: spawned.worker_id,
                requestId: "ask-2",
                body: { class: "network", target: "fetch_docs", reason: "docs" },
                createdAtMs: Date.now(),
                parentSessionId: "s-1",
                status: "pending",
              },
            ],
          },
        ),
      ),
    );
    assert.equal(cardsOf(mount).length, 1);

    // Unload the client fiber: the mount's hub attaches are effects on it —
    // one teardown releases both.
    client.runFiberTeardown();

    // A later publish reaches nothing: the detached store keeps its last
    // truth instead of being fed by a dead fiber.
    const before = cardsOf(mount);
    composition.approvalsFeed.applyChannelValue(
      publishedRoster(projectRosterSnapshot("s-1", [], Date.now())),
    );
    assert.deepEqual(cardsOf(mount), before);
  });
});
