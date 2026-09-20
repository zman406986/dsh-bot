/**
 * Ticket 69 — L1 offline COMPOSITION pin: the REAL wiring, end to end.
 *
 * The unit suites pin the pieces (projections, the feed hub, the resolve
 * transport, the dispatch seam). This file pins the COMPOSITION the shipped
 * code actually builds: no hand-reconstructed copy of the handler wiring,
 * no test-owned feed, no synthetic publish. Everything below runs the real
 * `apply` (host) and the real `applyClientModule` (client) against fakes
 * that only implement the two Cordis seams the composition rides (settings
 * section install on the host, settingsScope bind on the client), bridged
 * by ONE shared settings document — the same "one namespace, one channel"
 * the live path uses.
 *
 * The chain under test:
 *
 *   real `apply({enabled:true})` → real `/dispatcher-start` activation
 *   → real `spawn_worker` tool → real `request_access` tool
 *   → core parks the ask → `onRosterChanged` → real `rosterChannel.publish`
 *   → owner-scope `update` (the settings document)
 *   → the real `applyClientModule` settings watch (`approvalFeed.applyChannelValue`)
 *   → the shared hub → the mount's OWN `ApprovalCardsStore`
 *   → real `/dispatcher-resolve` command → core relay → re-publish
 *   → the card leaves; answering again is honestly refused.
 *
 * Ticket 99 (2026-09-20, ADR-0021): the default composition registers NO
 * displacement mounts any more (the `main` page + `root` election left the
 * posture — stock dsh is primary and never displaced). Ticket 100 re-hosts
 * the mount leg as the floating window: the launcher inject creates the
 * composition's ONE mount, and the tests below ALSO attach the REAL
 * `mountShellPage` to the composition's OWN returned feeds to drive a
 * dedicated mount. The feed/watch/hub half stays the real composition,
 * unmodified.
 *
 * Offline only (S8): no Cordis, no browser, no DOM, no network, no LLM.
 *
 * Ticket 93 host shape (2026-09-19): the fake settings provider models the
 * installed host — `register(ns, schema, {base})` returns the owner scope
 * (`@deepseek-ai/dsh-settings/lib/index.js:281-315`) while
 * `installSection(...)` returns VOID (`:327-343`;
 * `lib/types/index.d.ts:228`). The earlier fake handed a writable scope back
 * through `installSection`, a host that does not exist: it let a dead roster
 * channel pass 1,000+ offline tests. With the host shape modeled, dropping
 * the scope starves this suite exactly as it starved the live surface.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply as pluginApply } from "../src/plugin.js";
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
import { SETTINGS_NAMESPACE } from "../src/adapter/settings-section.js";
import { rosterSessionKey } from "../src/adapter/roster-channel.js";
import { APPROVAL_LOCATION_LOCAL } from "../src/adapter/access-prompt.js";
import {
  DISPATCHER_RESOLVE_COMMAND,
  DISPATCHER_START_COMMAND,
  dispatcherResolveNoPendingAsk,
  dispatcherResolveSuccess,
  type AdapterContext,
  type AgentLike,
  type CommandResultLike,
} from "../src/adapter/index.js";
import {
  ROSTER_SETTINGS_KEY,
  parseRosterSnapshot,
  type RosterSnapshot,
} from "../src/core/roster-snapshot.js";

// ── The settings bridge: one document, two ends ───────────────────────────

/**
 * The single settings document both halves share. The host end is the owner
 * scope the shipped `settings.register(ns, schema, {base})` returns
 * (`@deepseek-ai/dsh-settings/lib/index.js:281-315`; `update(partial)`); the
 * client end is the `settingsScope.bind({namespace})` snapshot. The live host
 * merges `update` into the namespace document and re-serves it to the bound
 * scopes; that is exactly what this does — nothing else.
 *
 * Ticket 93 host shape: the scope comes from `register`, NOT from
 * `installSection` — the live `installSection` returns VOID
 * (`dsh-settings/lib/index.js:327-343`; types `:228`). A fake that handed the
 * scope back through `installSection` modeled a host that does not exist and
 * hid a dead roster channel (see the host fake below).
 */
interface SettingsBridge {
  readonly document: Record<string, unknown>;
  readonly subscribers: Set<() => void>;
  update(partial: unknown): Promise<void>;
}

function createSettingsBridge(): SettingsBridge {
  const document: Record<string, unknown> = {};
  const subscribers = new Set<() => void>();
  return {
    document,
    subscribers,
    // The host scope's `update` is ASYNC (dsh-settings
    // lib/types/index.d.ts:105-108): the merge lands synchronously here, the
    // promise settles after — the shape a caller must handle.
    async update(partial: unknown) {
      if (typeof partial !== "object" || partial === null) return;
      for (const [key, value] of Object.entries(partial)) {
        document[key] = value;
      }
      for (const listener of [...subscribers]) listener();
    },
  };
}

/** The published roster snapshot, parsed the way the client parses it. */
function publishedRoster(bridge: SettingsBridge): RosterSnapshot | null {
  return parseRosterSnapshot(bridge.document[ROSTER_SETTINGS_KEY]);
}

// ── Host fake (activation-lifecycle idiom + the settings provider) ────────

function topLevelAgent(id: string): AgentLike {
  return {
    session: { id, header: { parentSession: null, delegationDepth: 0 } },
    followup() {},
  };
}

function createHostCtx(bridge: SettingsBridge) {
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
    // The optional settings service: the section installs and its owner
    // scope writes into the SHARED document (the roster mirror's write path).
    // Host shape (ticket 93): `register` returns the scope; `installSection`
    // returns VOID (dsh-settings lib/index.js:327-343, types :228) — it is
    // modeled here so a regression that reaches for its return value starves
    // exactly as it did live (zero `roster.*` keys, ticket 93).
    inject(services: readonly string[], callback: (child: unknown) => void) {
      if (!services.includes("settings")) return;
      callback({
        settings: {
          register() {
            return {
              async update(value: unknown) {
                await bridge.update(value);
              },
            };
          },
          installSection() {
            // No scope: the live host discards it. Return value is void.
          },
        },
      });
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
      async startContinuable() {
        const childId = `child-${nextChild++}`;
        return { childId, messageId: `msg-${childId}` };
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
    // Ticket 93: the plugin's unload/HMR teardown (every effect disposer,
    // reverse order — the fiber cascade) so a test can drive
    // `clearAllSessions` through the real path.
    runTeardown() {
      for (const dispose of [...disposers].reverse()) dispose();
    },
  };
  return ctx as typeof ctx & AdapterContext;
}

// ── Client fake (client-roster-panel idiom, bridged to the same document) ─

function createClientCtx(bridge: SettingsBridge) {
  const locales = new Map<string, unknown>();
  const injects: Array<{ parent: string; entries: unknown[] }> = [];
  const injectControllers: Array<() => void> = [];
  const effectDisposers: Array<() => void> = [];
  const boundNamespaces: string[] = [];
  let watchDisposed = 0;
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
    inject(services: readonly string[], callback: (child: unknown) => void) {
      if (!services.includes("settingsScope")) return;
      callback({
        settingsScope: {
          bind(spec: { namespace: string }) {
            boundNamespaces.push(spec.namespace);
            return {
              getSnapshot: () => ({ status: "ready" as const, value: bridge.document }),
              subscribe(listener: () => void) {
                bridge.subscribers.add(listener);
                return () => {
                  bridge.subscribers.delete(listener);
                  watchDisposed += 1;
                };
              },
            };
          },
        },
      });
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
    boundNamespaces,
    watchDisposedCount: () => watchDisposed,
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
    boundNamespaces: string[];
    watchDisposedCount(): number;
    setSessions(rows: Array<{ id: string; displayTitle?: string }>): void;
    runFiberTeardown(): void;
  };
}

// ── Assertion helpers ─────────────────────────────────────────────────────

/**
 * Ticket 99 (ADR-0021) + ticket 100: the default composition's ONE mount is
 * the floating window's (created by the `shell.overlay` launcher inject).
 * These tests additionally attach their OWN `mountShellPage` to the
 * composition's returned feeds — the same attach the registration site
 * performs — so the assertions below observe a dedicated mount instead of
 * sharing state with the window's.
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

describe("ticket 69 L1 — the offline composition pin (real apply → real watch → hub → mounted store → real resolve)", () => {
  it("parks a real ask, shows it on the composition's OWN mount, and resolves it through the real command", async () => {
    const bridge = createSettingsBridge();
    const host = createHostCtx(bridge);
    const client = createClientCtx(bridge);

    // ── Host half: the real plugin, activated for one dispatcher session.
    pluginApply(host, { enabled: true, accessRequestTimeoutMs: ACCESS_TIMEOUT_MS });
    const started = host.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: topLevelAgent("s-1"),
    });
    assert.deepEqual(started.kind, "success");
    await flush();
    assert.equal(publishedRoster(bridge)?.dispatcherSessionId, "s-1");

    // ── Client half: the REAL module body. Since ticket 100 (ADR-0021) the
    // composition creates exactly ONE mount — the floating window's shell,
    // created by the `shell.overlay` launcher inject. The mount data path
    // below is driven on a test-attached `mountShellPage` (same feeds, the
    // attach a registration site makes) so the assertions observe a
    // dedicated mount.
    const composition: ClientModuleComposition = applyClientModule(
      client,
      createRosterStore(),
    );
    assert.equal(
      composition.mounts.length,
      1,
      "the floating window's shell mount registers (ticket 100)",
    );
    assert.deepEqual(client.boundNamespaces, [SETTINGS_NAMESPACE]);
    const mount = attachMount(client, composition);
    // The attached mount rides the SAME feed the settings watch feeds (one
    // channel) — replayed at attach, live from then on.
    assert.equal(mount.approvals.getBox().state.kind, "ready");
    assert.deepEqual(cardsOf(mount), []);

    // ── A real worker spawns through the real tool.
    const spawn = host.tool("spawn_worker");
    assert.ok(spawn);
    const spawned = (await spawn.execute(
      { stream_key: "k-1", title: "Parser worker", prompt: "Parse." },
      { agent: { session: { id: "s-1" } } },
    )) as SpawnedWorker;
    assert.equal(spawned.ok, true);
    assert.deepEqual(cardsOf(mount), []);

    // ── The worker parks a real access ask through the real tool.
    // FINDING 4 contract (ticket 69): the tool call PARKS until the ask
    // settles — the park itself (and the roster publish) is synchronous;
    // the settlement lands when the command answers below.
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

    // The host published the pending truth through the ONE channel.
    const parked = publishedRoster(bridge);
    assert.equal(parked?.pendingAsks.length, 1);
    const askedRequestId = parked?.pendingAsks[0]?.requestId;
    // ... and the per-session mirror carries the same snapshot in the SAME write.
    assert.equal(
      (bridge.document[rosterSessionKey("s-1")] as RosterSnapshot).pendingAsks[0]
        ?.workerId,
      spawned.worker_id,
    );

    // The card is on the attached mount's own store — the hub fanned the
    // one read out through it.
    const cards = cardsOf(mount);
    assert.equal(cards.length, 1, "one pending card on the mount");
    const card = cards[0];
    assert.ok(card);
    assert.equal(card.cardKind, "access-ask");
    assert.equal(card.status, "pending");
    assert.equal(card.requestId, askedRequestId);
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
    // ... re-published truth without the ask (both the wire and the mirror)...
    assert.deepEqual(publishedRoster(bridge)?.pendingAsks, []);
    // ... the parked TOOL call settled honestly once the ask left the relay
    // (FINDING 4: the park holds the tool call, so the settlement landed
    // through it, and the worker's turn could not be settled-while-owed).
    // The waiter polls core truth, so the settle lands within one poll of
    // the resolve — await it, then assert.
    const asked = await askedPromise;
    assert.equal(asked.ok, true);
    assert.equal(askState.settled, true);
    // ... and the card LEFT the composition-fed mount's own store.
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

  it("ticket 93: the real channel publishes BOTH mirror families into the document, and unload clears the session key", async () => {
    // The live-found failure: `installSection` returns void on the host, so
    // the owner scope never attached and ZERO `roster.*` keys ever reached
    // the document (settings/describe stayed at the three config keys).
    // This pin drives the real channel through the real `register`-returned
    // scope and asserts the keys the wrapper's read side needs.
    const bridge = createSettingsBridge();
    const host = createHostCtx(bridge);
    pluginApply(host, {
      enabled: true,
      accessRequestTimeoutMs: ACCESS_TIMEOUT_MS,
    });
    host.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: topLevelAgent("s-1"),
    });
    await flush();

    // The activation publish landed under the legacy key...
    const legacy = publishedRoster(bridge);
    assert.equal(legacy?.dispatcherSessionId, "s-1");
    // ...AND under the per-session mirror key the shell store reads.
    const mirror = parseRosterSnapshot(
      bridge.document[rosterSessionKey("s-1")],
    );
    assert.equal(mirror?.dispatcherSessionId, "s-1");
    assert.equal(mirror?.workers.length, 0);

    // A real spawn republishes both families in one write.
    const spawn = host.tool("spawn_worker");
    assert.ok(spawn);
    await spawn.execute(
      { stream_key: "k-93", title: "Channel worker", prompt: "P." },
      { agent: { session: { id: "s-1" } } },
    );
    const afterSpawn = parseRosterSnapshot(
      bridge.document[rosterSessionKey("s-1")],
    );
    assert.equal(afterSpawn?.workers.length, 1);

    // Plugin unload/HMR (the fiber cascade): no mirror key outlives the
    // plugin — the host writes `null`, which the client reads as "not a
    // dispatcher here anymore" (ticket 79's clear contract).
    host.runTeardown();
    assert.equal(bridge.document[rosterSessionKey("s-1")], null);
  });

  it("ticket 94: the mount's shell store is fed the per-session mirror (flag, presence, hosted panel)", async () => {
    // The live-found failure: `applySessionMirror` had NO live call site, so
    // `state.mirrors` stayed empty — every row rendered
    // `data-dispatcher="false"` with the `状态不可用` chip, the right pane
    // hosted no roster panel, and `data-presence` never populated. This pin
    // drives the REAL composition (host publish → document → the watch's
    // mirror feed → the mount's OWN shell store) and asserts the surface.
    const bridge = createSettingsBridge();
    const host = createHostCtx(bridge);
    const client = createClientCtx(bridge);
    // The feed is the row authority: one delivered row for the dispatcher.
    client.setSessions([{ id: "s-1", displayTitle: "Dispatcher chat" }]);

    pluginApply(host, {
      enabled: true,
      accessRequestTimeoutMs: ACCESS_TIMEOUT_MS,
    });
    host.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: topLevelAgent("s-1"),
    });
    await flush();

    const composition = applyClientModule(client, createRosterStore());
    assert.equal(
      composition.mounts.length,
      1,
      "the floating window's shell mount registers (ticket 100)",
    );
    const mount = attachMount(client, composition);

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

      // The right seat HOSTS the roster panel for that session (the live
      // symptom was an empty right pane: `innerHTML` length 0).
      assert.equal(
        shellSeatHostsPanel(state.mirrors.get("s-1")),
        true,
        "the panel is hosted",
      );
      assert.notEqual(mount.hosts.rosterPanel({ sessionId: "s-1" }), null);
      // …and NOT for a session the mirrors do not vouch for.
      assert.equal(mount.hosts.rosterPanel({ sessionId: "s-other" }), null);
    }

    // A real spawn republishes through the same channel: the presence counts
    // move on the MOUNT'S OWN store (no second feed, no second store).
    const spawn = host.tool("spawn_worker");
    assert.ok(spawn);
    await spawn.execute(
      { stream_key: "k-94", title: "Mirror worker", prompt: "P." },
      { agent: { session: { id: "s-1" } } },
    );
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
    const bridge = createSettingsBridge();
    const host = createHostCtx(bridge);
    const client = createClientCtx(bridge);
    client.setSessions([{ id: "s-1", displayTitle: "Dispatcher chat" }]);

    pluginApply(host, {
      enabled: true,
      accessRequestTimeoutMs: ACCESS_TIMEOUT_MS,
    });
    host.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: topLevelAgent("s-1"),
    });
    await flush();

    const composition = applyClientModule(client, createRosterStore());
    const mount = attachMount(client, composition);
    assert.equal(mount.store.getBox().state.rows.get("s-1")?.dispatcher, true);

    // Unload the client fiber: every effect (the watch and each mount's feed
    // attach) goes with it.
    client.runFiberTeardown();

    // A later host publish reaches nothing — the detached store keeps its
    // last truth instead of being fed by a dead fiber.
    const spawn = host.tool("spawn_worker");
    assert.ok(spawn);
    await spawn.execute(
      { stream_key: "k-94b", title: "Late worker", prompt: "P." },
      { agent: { session: { id: "s-1" } } },
    );
    assert.deepEqual(mount.store.getBox().state.rows.get("s-1")?.presence, {
      working: 0,
      needsYou: 0,
      finished: 0,
    });
  });

  it("the composition detaches its mounts from the hub with the client fiber", async () => {
    const bridge = createSettingsBridge();
    const host = createHostCtx(bridge);
    const client = createClientCtx(bridge);

    pluginApply(host, { enabled: true, accessRequestTimeoutMs: ACCESS_TIMEOUT_MS });
    host.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: topLevelAgent("s-1"),
    });
    await flush();

    const composition = applyClientModule(client, createRosterStore());
    // The mount machinery attaches to the composition's own feeds (ticket
    // 99's posture); its feed attach is an effect on the same client fiber.
    const mount = attachMount(client, composition);
    const spawn = host.tool("spawn_worker");
    assert.ok(spawn);
    const spawned = (await spawn.execute(
      { stream_key: "k-2", title: "Second worker", prompt: "P." },
      { agent: { session: { id: "s-1" } } },
    )) as SpawnedWorker;
    const access = host.tool("request_access");
    assert.ok(access);
    // FINDING 4: the tool call parks until the ask settles; the park and
    // the publish are synchronous, so fire it and await the settlement
    // after the deny below.
    const settled = access
      .execute(
        { class: "network", target: "fetch_docs", reason: "docs" },
        { agent: { session: { id: spawned.worker_id } } },
      )
      .then((value) => {
        assert.equal((value as { ok: boolean }).ok, true);
      }) as Promise<void>;
    await flush();
    assert.equal(cardsOf(mount).length, 1);

    // Unload the client fiber: the settings watch, the settings card's own
    // bind (ticket 47 rides the SAME scope), and the mount's feed attach
    // are effects on it — one teardown releases all of them.
    client.runFiberTeardown();
    assert.equal(client.watchDisposedCount(), 2, "settings watch + settings card");
    assert.equal(bridge.subscribers.size, 0);

  // A later host publish reaches nothing: the detached store keeps its last
  // truth instead of being fed by a dead fiber.
  const before = cardsOf(mount);
  host.runCommand({
    commandId: DISPATCHER_RESOLVE_COMMAND,
    agent: topLevelAgent("s-1"),
    rawInput: `${spawned.worker_id} deny`,
  });
  await flush();
  assert.deepEqual(cardsOf(mount), before);
  // The parked tool call settled on the deny (FINDING 4) — no stray park.
  await settled;
});
});
