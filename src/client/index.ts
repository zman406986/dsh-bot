/**
 * dsh client module entry (tickets 20 + 21 + 24).
 *
 * The host half of `@deepseek-ai/dsh-client-modules` scans this package's
 * `dsh.client` record, composes it into the boot graph, and serves
 * `exports["./client"]` (Finding 4). The BUILT bundle — not this source —
 * registers through `window.__ModuleLoader__.load({id, factory})`; the build
 * path (`scripts/build-client.ts`) wraps the compiled module in that shell.
 *
 * Inside the browser the module is an ordinary Cordis plugin: `apply(ctx)`
 * registers only through `ctx` services, so unload/HMR reverses everything
 * (Findings 1/2/5 lifecycle). `inject` names the client services the module
 * READS on `ctx` — the shipped idiom (dsh-client-ui-session exports
 * `inject = ["sessions", "slots"]`): the context proxy THROWS on any service
 * property the module's inject list does not declare, wherever the read
 * happens (`cannot get property "X" without inject` — ticket 84). The live
 * entries read only `slots`/`locale`, so those are the whole list; the
 * dormant shell resolves its own faces at the mount point.
 *
 * What registers (design-16 §4.2/§5):
 * 1. the `dsh-bot` locale namespace ({en, zh});
 * 2. the per-tool call views (ticket 24): keyed `tool.call.toolview` entries
 *    for the eight dispatcher wire tool names plus the retained historical
 *    `send_peer` key (five at 24; `send_peer` joined under ticket 70;
 *    `message_agent`, `await_agent` and `spawn_dispatcher` completed the set
 *    under ticket 152) — unclaimed keys, so additive-
 *    safe against the shipped composition (research Finding 5);
 * 3. the plugin's configuration page: one keyed `plugins.row.config` entry
 *    for the row `<package name>#<settings namespace>`, whose form comes from
 *    the slot owner's props (0.2.1 replaced the removed `settings.plugin.item`
 *    slot and `ctx.settingsScope` service with this path);
 * 4. the session-kind indicators (ticket 123): the dispatcher glyph in the
 *    stock sidebar row's trailing icon list (the seat ADR-0024's rider
 *    licenses, moved there by the owner's 2026-11-06 ruling, and the only seat
 *    composed — ticket 140's header chip was removed on 2026-10-28, since a
 *    summoned dispatcher is now a top-level session with its own sidebar row).
 *    The WORKER marker is still declined and not composed in any seat.
 *
 * The roster/config watch and its feeds are NOT composed: no client service
 * serves that document on 0.2.1. `mountShellPage` and the shell-mount
 * contracts stay in the tree as retained, unmounted machinery (ADR-0024),
 * reversible at ONE registration site.
 *
 * Ticket 40 binds the capsule/panel intents to ticket 36's verified seams
 * at THIS composition point and nowhere else: the narrow CommandTransport
 * (start = the composer's exact `commands.execute` transaction with
 * `/dsh-bot` verbatim; stop = the scope-addressed plain-prompt
 * sink with the locale-keyed conversational phrasing) and the per-row steer
 * prefill seat (`input.for(actx).setDraft`) are built in `mountShellPage`
 * over lazy service sources — the conversation pane and hosted roster panel
 * are their only consumers. `mountShellPage` is NOT composed by default (no
 * inject calls it); offline tests drive it directly.
 * The faces are resolved lazily so their VALUES are fresh at send/click time;
 * they are resolved AT THE MOUNT POINT (`resolveShellService` — the
 * service-method boundary plus a guarded property fallback), NOT declared in
 * the module inject: the live entries read only `slots`/`locale`, and a
 * module-level requirement on sessions/remote/conversation/configForms would
 * disable them whenever one of those clients is absent. A face that is absent
 * still degrades to honest `no-channel`/copy-fallback UX via
 * `src/client/actions.ts`.
 */

import { createElement } from "react";
import type { JSX } from "react";
import type {
  ClientContext,
  ClientConversationLike,
  ClientRemoteLike,
  ClientSessionsLike,
} from "./context.js";
import {
  LOCALE_NAMESPACE,
  localeDictionary,
} from "./overlay.js";
import {
  bindCommandTransport,
  tryPrefillSteer,
  type SteerPrefillOutcome,
} from "./actions.js";
import { createRosterStore, type RosterStore } from "./roster-store.js";
import { createToolviewComponent } from "./toolview-panel.js";
import {
  TOOLVIEW_TOOL_NAMES,
  TOOL_CALL_TOOLVIEW_SLOT,
  toolviewRegistration,
} from "./toolviews.js";
import {
  PLUGINS_ROW_CONFIG_SLOT,
  createSettingsCardStore,
  settingsCardRegistration,
  type SettingsCardStore,
} from "./settings-card-store.js";
import { createPluginSettingsCard } from "./settings-card.js";
import { createRosterPanel } from "./panel.js";
import {
  shellSeatHostsPanel,
  shellSeatPanelState,
} from "./shell-mount.js";
import type { ShellHosts } from "./shell.js";
import {
  createDispatcherShellStore,
  type DispatcherShellStore,
} from "./shell-store.js";
import {
  bindShellSessionsFeed,
  type ShellFeedBinding,
} from "./shell-feed.js";
import {
  createConversationStore,
  type ConversationStore,
} from "./conversation-store.js";
import { bindConversationFeed, requestOlder } from "./conversation-feed.js";
import {
  createShellMirrorFeed,
  type ShellMirrorFeed,
} from "./shell-mirror-feed.js";
import {
  createConversationPane,
  type ConversationSendOutcome,
} from "./conversation.js";
import {
  createOnboardingStore,
  type OnboardingStore,
} from "./onboarding.js";
import { createOnboardingPane } from "./onboarding-pane.js";
import {
  createDispatcherClassGlyph,
  dispatcherGlyphRegistration,
} from "./session-kind.js";

/**
 * Client services this module READS on `ctx`, declared per the shipped
 * Cordis idiom (ticket 84): the context proxy throws `cannot get property
 * "X" without inject` on any undeclared service property — at read time,
 * wherever it happens — so every service face a LIVE entry touches appears
 * here. The live entries are exactly the ones composed below: the locale
 * namespace, the nine tool views, the settings card, and the sidebar glyph.
 * They read only `slots` ← ui-renderer and `locale` ← client-locale.
 *
 * The dormant shell vehicle's faces — `sessions` ← ui-session, `remote` /
 * `remote.commands` ← api-gateway, `conversation` ← ui-conversation, and
 * `configForms` ← ui-settings — are DELIBERATELY not declared here. They are
 * needed only when `mountShellPage` runs, and demanding them at module load
 * held the live surface hostage to clients that may be absent: a missing
 * settings/sessions client silently disabled the glyph and the tool views.
 * `mountShellPage` resolves them at its own mount point through the
 * service-method boundary (`ctx.get(name)`) with a guarded property read as
 * the offline-fake fallback — see `resolveShellService`.
 */
export const inject: readonly string[] = ["slots", "locale"];

/**
 * Browser plugin entry. Every registration is an effect on this module's
 * fiber, so an unload/HMR swap reverses the namespace, the toolviews, and the
 * settings entry.
 */
export function apply(ctx: ClientContext): void {
  applyClientModule(
    ctx,
    createRosterStore(),
    createSettingsCardStore(),
  );
}

/**
 * What the composition built, handed back so offline tests can drive the
 * REAL wiring instead of reconstructing it by hand (ticket 69, L1 offline
 * composition pin). Three facts, all live references:
 *
 * - `mirrorsFeed` — the per-session mirror hub every mount's shell store may
 *   join. No live channel feeds it on 0.2.1.
 * - `mounts` — every `mountShellPage` result the slot injects created, in
 *   registration order. The default composition creates NO mounts (no inject
 *   calls it); it stays the push-site for a registration that re-hosts the
 *   shell, and offline tests attach the real `mountShellPage` to the returned
 *   feeds to drive the mount data path. The array is the SAME array such an
 *   inject pushes into, so it also collects mounts that arrive AFTER the call
 *   returns. Offline fakes run the callback synchronously, so the list is
 *   complete at return there.
 *
 * Additive only: `apply` ignores the return, and the mounted stores were
 * previously reachable only through the React component closure.
 */
export interface ClientModuleComposition {
  /** Ticket 94: the per-session mirror hub every mount's shell store joins. */
  readonly mirrorsFeed: ShellMirrorFeed;
  readonly mounts: readonly ShellPageMount[];
}

/**
 * The module body, factored over explicit stores so offline tests can drive
 * each surface without a DOM harness. Not a second entry point: `apply` is
 * the only thing the loader registers. The trailing parameters are kept as
 * the seam offline tests pass their own stores through; production `apply`
 * defaults them.
 *
 * Returns the {@link ClientModuleComposition} (ticket 69, L1): the feed and
 * every mount, so the composition itself — not a hand-rebuilt copy of it —
 * can be driven offline.
 */
export function applyClientModule(
  ctx: ClientContext,
  store: RosterStore,
  card: SettingsCardStore = createSettingsCardStore(),
  onboarding: OnboardingStore = createOnboardingStore(),
): ClientModuleComposition {
  // Locale namespace (Finding 6 idiom): labeled effect; executes immediately,
  // the returned disposer is collected for unload.
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, localeDictionary),
    "multitask-dispatcher: locale dictionaries",
  );

  // Roster/mirror data path: NOT composed. dsh 0.2.1 removed the client
  // settings-scope service this watch rode, and the host half's
  // `roster`/`roster.<id>` keys are no longer accepted by the settings
  // document (undeclared keys are rejected as non-volatile). The feeds stay
  // as retained machinery with no live channel: a surface that returns needs
  // a 0.2.1-native transport, not a smuggled config key (ADR-0024).
  /**
   * The shell stores' mirror hub. It has no live channel on 0.2.1; offline
   * tests attach the real `mountShellPage` to it to drive the mount data
   * path, and the mount machinery stays reversible at one registration site.
   */
  const mirrorsFeed = createShellMirrorFeed();
  /** Every mount this composition creates; none by default (ADR-0024). */
  const mounts: ShellPageMount[] = [];

  // The onboarding store's suppression inputs are no longer fed: the
  // settings-backed seen record and the per-session mirrors both rode the
  // removed client channel. The beat walk and the decision logic stay pure
  // and offline-pinned; the pane is unmounted with the shell machinery.

  // Per-tool call views (ticket 24): one inject at the shipped keyed slot,
  // one entry per dispatcher wire tool name. Keys are the plugin-owned core
  // tool names (ticket 11) — unclaimed by the shipped composition, so each
  // cell is ours by default and the generic row remains the fallback shape.
  // All nine registrations ride the same inject controller: fiber unload
  // disposes the controller and every entry with it (HMR-safe).
  //
  // Ticket 89 (2026-09-19), rationale re-based by ticket 99 (ADR-0021) —
  // these STAY: the keyed cells are ours by default and the shipped chat's
  // tool rows render them. Under the ADR-0021 coexistence posture stock dsh
  // is ALWAYS the primary UI, so these entries are the live surface (not an
  // abdication-only fallback): our dispatcher tool rows render in the
  // shipped chat instead of the generic fallback. Deleting them would
  // regress a reachable (live-pass-4-proven) surface. Justification on
  // ticket 89, AC 3; coexistence posture on ADR-0021.
  ctx.slots.inject(TOOL_CALL_TOOLVIEW_SLOT, () => {
    const t = ctx.locale.bind(LOCALE_NAMESPACE);
    for (const toolName of TOOLVIEW_TOOL_NAMES) {
      ctx.slots.register(
        toolviewRegistration(toolName),
        createToolviewComponent(toolName, t),
      );
    }
  });

  // Settings page (ticket 47): one keyed `plugins.row.config` entry. The
  // Plugins page declares the slot while its `main` entry is mounted
  // (`dsh-client-ui-plugin-manager/lib/client.js:4440-4444`) and dispatches
  // the row's cell with the entry's form as owner props (`:2815-2822`), so a
  // row the Host serves no namespace for gets no configure control at all.
  // The key is `<package name>#<row id>` (`:27-29`), both strings the Host
  // owns; the card edits the form the page hands it.
  //
  // Deliberately no entry-level `inject`: the shipped cards pass one because
  // their components read an injected controller face as props, while ours is a
  // factory bound to its seats at composition time — the same pattern the
  // toolviews use.
  //
  // And a plain callback returning the registration's disposer, not the shipped
  // generator: `SlotRegistry.inject` documents both forms ("callback effects
  // are synchronous disposers; iterable effects install transactionally"), the
  // return value is the declaration-lifetime disposer either way, and our
  // offline fakes drive the callback form — a generator body would simply never
  // run there, so the entry could not be pinned offline.
  ctx.slots.inject(PLUGINS_ROW_CONFIG_SLOT, () => {
    const t = ctx.locale.bind(LOCALE_NAMESPACE);
    return ctx.slots.register(
      settingsCardRegistration(),
      createPluginSettingsCard(t, card),
    );
  });

  // Session-kind indicator (ticket 123; ADR-0024 rider + addendum): the
  // dispatcher glyph in the stock sidebar row's trailing icon list
  // (`sidebar.session.row.trailing`).
  //
  // The ADR-0024 rider (2026-10-18) licenses "exactly one additional additive
  // registration, and it is this one ... no other slot is licensed by this
  // rider". The owner's 2026-11-06 ruling moved that one licence from
  // `sidebar.session.row.leading` to the trailing seat: the leading cell is
  // mutually exclusive with the row's own running status dot (the host
  // unmounts its occupant there whenever the row is not idle), while the
  // trailing seat is not status-gated, so the mark and the dot show together.
  // The ticket-140 header seat (2026-10-28) was a later dated ruling extending
  // the rider; it was removed under the owner's 2026-10-28 mitosis change — a
  // summoned dispatcher is now a real top-level session with its own sidebar
  // row. Seat count stays at one; the seat moved.
  //
  // Identity: dispatchers are identified by the `sessionKind` projection the
  // adapter registers, which folds the `command/run` + `command/done` pair
  // `/dsh-bot` already writes — so the identity is durable and needs no event
  // of our own. `agentPreset` is unusable here (every durable header reads
  // "standard").
  //
  // Ticket 177: the ONE entry marks BOTH dispatcher classes and draws the
  // portrait for the class the row actually is (chief of staff vs team
  // leader). Still one registration — a second entry for the second icon
  // would spend ADR-0024's single licensed seat on a decoration.
  ctx.slots.inject(
    dispatcherGlyphRegistration().name,
    () => {
      const t = ctx.locale.bind(LOCALE_NAMESPACE);
      return ctx.slots.register(
        dispatcherGlyphRegistration(),
        createDispatcherClassGlyph(t),
      );
    },
  );

  // ── The displacement registrations RETIRED from the default posture
  // (2026-09-20, ticket 99, ADR-0021) ──
  //
  // Until ticket 99 this composition made TWO more injects:
  //
  // 1. the keyed `main` page (ticket 78 staging; `MAIN_PAGE_SLOT` +
  //    `shellPageRegistration()`, key `SHELL_PAGE_KEY`
  //    "multitask-dispatcher-shell"), and
  // 2. the `root` frame election (ticket 78 CUTOVER; `ROOT_FRAME_SLOT` +
  //    `shellRootRegistration()` at the explicit shadowing priority
  //    `SHELL_ROOT_DYNAMIC_PRIORITY` -1, ticket 85) that displaced the
  //    shipped AppFrame with an abdication failsafe.
  //
  // ADR-0021 (the human-ruled coexistence vehicle) retires both: stock dsh
  // is the user's primary UI and is never displaced. This module now renders
  // NOTHING into dsh's layout — the intermediate state before ticket 100
  // re-hosts the shell surfaces into a separate floating window behind an
  // additive launcher. The machinery is retained, NOT deleted: the
  // registration contracts stay exported from `shell-mount.ts`
  // (`shellPageRegistration`, `shellRootRegistration`, the priority
  // constant) and the mounting path stays exported below
  // (`mountShellPage`), so the vehicle is reversible at ONE registration
  // site — exactly the site ticket 100 adds. Fail isolation is re-based
  // onto the additive posture: with no shadowing entry there is no cell to
  // abdicate; our registrations fail within our own module and the stock
  // app is never shadowed. The retired-path tests remain records of that
  // machinery in `test/client-shell-mount.test.ts`.

  return { mirrorsFeed, mounts };
}

/**
 * The shell page's live mounting path (ticket 78 staging), factored over
 * explicit stores so offline tests can drive the data path end to end —
 * feed snapshot → shell store → hosted-panel seat — without a DOM harness
 * (same discipline as `applyClientModule`). RETAINED MACHINERY (ticket 99,
 * ADR-0021): the `main`/`root` injects that used to call it left the
 * default composition, so nothing in production calls it today — ticket
 * 100's floating-window registration is its next caller, and offline tests
 * drive it directly (also against the real composition's feeds). Its
 * effects still land on the caller's fiber, so unloading the caller's
 * registration reverses the feed bindings and the seat projection with it
 * (HMR-safe; the ticket's "reverse every registration" constraint).
 *
 * - The sidebar rides `bindShellSessionsFeed` (ticket 79's projection) over
 *   the sessions face resolved at the mount (`resolveShellService`, through
 *   the service-method boundary — the module inject no longer carries it);
 *   an absent face (offline fakes, or a deployment without the sessions
 *   client) leaves the store empty and the shell renders its honest empty
 *   copy — the mount never blocks.
 * - Row selection is a store update; 0.2.x has no host `open(id)` verb. The
 *   conversation binding retains the selected session (`sessions.retain` +
 *   `reference.ready`), which is what opens its window and what a send's
 *   scoped face needs.
 * - The right seat hosts the EXISTING `createRosterPanel` (ADR-0020: hosted,
 *   not rebuilt) with its store projected from the SELECTED session's
 *   per-session mirror (`shellSeatPanelState`): a session that is not one of
 *   our dispatcher sessions hosts no panel at all.
 */
export interface ShellPageMount {
  readonly store: DispatcherShellStore;
  /** The hosted roster panel's store (projected; see `shellSeatPanelState`). */
  readonly seat: RosterStore;
  /** The conversation store feeding the main seat (ticket 80). */
  readonly conversation: ConversationStore;
  /** Host seats handed to `createDispatcherShell`. */
  readonly hosts: ShellHosts;
}

/**
 * The first-run onboarding wiring (ticket 68): the store the pane reads and
 * the composition's seen-write hand-off. Optional so a composition (or a
 * test) can mount the shell without the flow — the no-selection state keeps
 * its bare copy.
 */
export interface ShellOnboardingWiring {
  readonly store: OnboardingStore;
  readonly onSeen: () => void;
}

/**
 * The per-session mirror feed the composition shares (ticket 94). Optional so
 * a composition (or a test) can mount the shell without it — the store then
 * keeps `mirrors` empty and the sidebar renders its honest
 * "not a dispatcher / presence unavailable" state, never a fabricated roster.
 */
export interface ShellMirrorFeedWiring {
  readonly mirrorsFeed?: ShellMirrorFeed;
}

/**
 * Resolve one service the DORMANT shell needs, at its mount point rather than
 * in the module inject. The service-method boundary is `ctx.get(name)`
 * (cordis `reflect.get`, `lib/index.js:762-764`): it resolves through the
 * isolate-keyed service store with no fiber walk, so it works for a face the
 * module's inject list does not declare (the same verified shape ticket 92
 * uses for scoped conversation). A structural fake without `get` exposes its
 * faces as plain properties, read defensively: an undeclared property read on
 * the real host THROWS, which is an absent face here, never a crash.
 */
export function resolveShellService<T>(
  ctx: ClientContext,
  name: string,
): T | undefined {
  const get = (ctx as { get?: unknown }).get;
  if (typeof get === "function") {
    try {
      const value = (get as (name: string) => unknown).call(ctx, name);
      if (value !== undefined) return value as T;
    } catch {
      // Not resolvable on this context: fall through to the structural read.
    }
  }
  try {
    const value = (ctx as unknown as Record<string, unknown>)[name];
    return value === undefined ? undefined : (value as T);
  } catch {
    return undefined;
  }
}

export function mountShellPage(
  ctx: ClientContext,
  wiring?: ShellOnboardingWiring & ShellMirrorFeedWiring,
): ShellPageMount {
  const onboarding = wiring && wiring.store ? wiring : undefined;
  const mirrors =
    wiring && wiring.mirrorsFeed !== undefined ? wiring : undefined;
  const store = createDispatcherShellStore();
  const seat = createRosterStore();
  const conversation = createConversationStore();
  let binding: ShellFeedBinding | undefined;

  /**
   * Bind BOTH sessions-dependent feeds to one resolved face, returning the
   * disposer that releases them together. Selection is view-owned, so the
   * shell-feed binding is also what makes rows selectable; the conversation
   * binding retains the selected session and follows its window.
   */
  const bindSessionFeeds = (sessions: ClientSessionsLike): (() => void) => {
    const shellFeed = bindShellSessionsFeed(store, sessions);
    binding = shellFeed;
    const conversationFeed = bindConversationFeed(
      conversation,
      sessions,
      store,
    );
    return () => {
      conversationFeed.dispose();
      shellFeed.dispose();
      if (binding === shellFeed) binding = undefined;
    };
  };

  // Dormant-vehicle service resolution (0.2.x posture): the module inject
  // carries only what the live entries read, so the shell resolves its faces
  // HERE. Getters, because a service can materialize (or be replaced) after
  // the mount and the send paths must see the face that exists at send time.
  const sessionsOf = (): ClientSessionsLike | undefined =>
    resolveShellService<ClientSessionsLike>(ctx, "sessions");
  const conversationServiceOf = (): ClientConversationLike | undefined =>
    resolveShellService<ClientConversationLike>(ctx, "conversation");
  /**
   * The composer's command transaction (`remote.commands`). The nested face
   * is its own service on 0.2.x (`remote.commands`, matched by exact string);
   * a runtime that only exposes the parent returns its face and
   * `bindCommandTransport` still guards the nested read.
   */
  const remoteOf = (): ClientRemoteLike | undefined => {
    const commands = resolveShellService<ClientRemoteLike["commands"]>(
      ctx,
      "remote.commands",
    );
    if (
      commands !== undefined &&
      commands !== null &&
      typeof commands.execute === "function"
    ) {
      return { commands };
    }
    return resolveShellService<ClientRemoteLike>(ctx, "remote");
  };

  // Per-session mirror attach (ticket 94): this mount's shell store joins the
  // shared hub — replaying the last-known `roster.<sessionId>` mirrors
  // immediately, then every publish — and detaches with the mount's fiber.
  // WITHOUT this the sidebar's
  // `data-dispatcher` flag, the presence chips, the needs-you marker, and the
  // hosted roster panel have no live data at all (the live-found bug).
  ctx.effect(() => {
    const feed = mirrors?.mirrorsFeed;
    if (feed === undefined) return () => {};
    return feed.attach(store);
  }, "multitask-dispatcher: shell per-session mirror feed");

  // Feed binding (ticket 79's projection, wired at THIS composition point —
  // the ticket-79 comment's "ticket 78's registration"). The sessions face is
  // resolved at the mount (see `sessionsOf`), because the module inject no
  // longer carries it for the live entries; `undefined` means the face is
  // absent (offline fakes or a deployment without the sessions client) and
  // the mount degrades to an empty store. 0.2.x has NO host selection verb:
  // the row click updates the store, and the conversation binding below
  // retains the selected session (which is what opens its window).
  //
  // The face can materialize AFTER this mount (client-module composition
  // order is not a promise). Capturing its absence forever left the shell
  // permanently empty; instead watch the dependency with cordis
  // `ctx.inject(["sessions"], …)`, which runs when the service appears and
  // re-runs when it is replaced. A structural fake without `inject` keeps
  // today's resolve-now behavior and re-checks on each shell store change, so
  // a late face still binds on the next row/selection update.
  const watchSessions = (): boolean => {
    const inject = ctx.inject;
    if (typeof inject !== "function") return false;
    try {
      ctx.effect(() => {
        const fiber = inject.call(ctx, ["sessions"], (injected) => {
          const sessions = resolveShellService<ClientSessionsLike>(
            injected,
            "sessions",
          );
          if (sessions === undefined) return () => {};
          return bindSessionFeeds(sessions);
        }) as { dispose?: unknown } | undefined;
        return () => {
          const dispose = fiber?.dispose;
          if (typeof dispose === "function") void dispose.call(fiber);
        };
      }, "multitask-dispatcher: shell sessions dependency");
      return true;
    } catch {
      return false; // a host-shaped ctx without a live registry: fall back
    }
  };

  if (!watchSessions()) {
    ctx.effect(() => {
      let disposeFeeds: (() => void) | undefined;
      // Re-entrancy guard: the feed's first sync can emit into the very
      // subscription that is about to install it.
      let bindingNow = false;
      const bindIfReady = (): void => {
        if (disposeFeeds !== undefined || bindingNow) return;
        const sessions = sessionsOf();
        if (sessions === undefined) return;
        bindingNow = true;
        try {
          disposeFeeds = bindSessionFeeds(sessions);
        } finally {
          bindingNow = false;
        }
      };
      bindIfReady();
      const unsubscribe = store.subscribe(bindIfReady);
      return () => {
        unsubscribe();
        disposeFeeds?.();
        disposeFeeds = undefined;
      };
    }, "multitask-dispatcher: shell sessions feed binding");
  }

  // The conversation send transport: ticket 40's verified plain-prompt sink
  // (the SAME one the capsule's stop ask uses), resolved lazily at send
  // time. One sink for the whole module — the composer never builds a
  // parallel channel (A4).
  const sendTransport = bindCommandTransport({
    remote: remoteOf,
    sessions: sessionsOf,
  });

  // The pane factory: bound once to the translate seat, the conversation
  // store, and the two verified actions.
  const conversationPane = createConversationPane(
    ctx.locale.bind(LOCALE_NAMESPACE),
    conversation,
    {
      onSend: async (sessionId, text): Promise<ConversationSendOutcome> => {
        try {
          const result = await sendTransport.sendPrompt(sessionId, text);
          return result.kind === "no-channel"
            ? { kind: "no-channel" }
            : { kind: "sent" };
        } catch {
          return { kind: "failed" };
        }
      },
      onLoadOlder: (sessionId) => requestOlder(sessionsOf(), sessionId),
    },
  );

  // The hosted panel's per-row steer affordance uses the same verified
  // prefill seam as the capsule (lazily resolved at click time). 0.2.x has no
  // feed `current` selection, so the CURRENT session is this shell's own
  // selection — the view owns selection and the store is the view's state.
  const currentSessionId = (): string | undefined => {
    const selection = store.getBox().state.selection;
    return selection.kind === "session" ? selection.sessionId : undefined;
  };
  const onRowSteer = (workerId: string): SteerPrefillOutcome =>
    tryPrefillSteer(
      {
        sessions: sessionsOf,
        conversation: conversationServiceOf,
        currentSessionId,
      },
      workerId,
    );
  const seatPanel = createRosterPanel(
    ctx.locale.bind(LOCALE_NAMESPACE),
    seat,
    onRowSteer,
  );

  // Seat projection: keep the hosted panel's store on the selected session's
  // mirror. Subscribed BEFORE any React listener (the shell component mounts
  // later), so the seat is always in sync before the pane re-renders.
  ctx.effect(() => {
    const syncSeat = () => {
      const state = store.getBox().state;
      const selectedId =
        state.selection.kind === "session"
          ? state.selection.sessionId
          : null;
      const mirror =
        selectedId === null ? undefined : state.mirrors.get(selectedId);
      seat.set(shellSeatPanelState(mirror) ?? { kind: "waiting" });
    };
    syncSeat();
    return store.subscribe(syncSeat);
  }, "multitask-dispatcher: shell roster seat projection");

  // The first-run onboarding seat (ticket 68): bound to the wired store and
  // the seen-write hand-off, reading the dispatcher mirrors from THIS mount's
  // shell store (the "≥1 dispatcher session" suppression input). Without the
  // wiring the seat stays absent and the shell keeps its bare no-selection
  // copy.
  const onboardingPane = onboarding
    ? createOnboardingPane(
        ctx.locale.bind(LOCALE_NAMESPACE),
        onboarding.store,
        store,
        { onSeen: onboarding.onSeen },
      )
    : undefined;

  // Host seats (ticket 88 discipline): every seat is a COMPONENT the shell
  // renders as an element, never a function the shell calls. The live pass-4
  // crash (React minified #300 on selection) was the seats' hooks being
  // inlined into the SHELL's hook list via direct calls — the no-selection →
  // selection flip then changed the shell's hook count and the whole `root`
  // entry abdicated. As elements, each seat owns its fiber: mount/unmount
  // across branch flips is ordinary React, never a hook-count change.
  const RosterSeat = (props: { readonly sessionId: string }): JSX.Element | null =>
    // The host-or-not gate reads the CURRENT shell store box at render time
    // (the shell re-renders on every store emit, so the gate stays live —
    // same reactivity the seat function always had). Zero hooks here: the
    // gate's null flip only mounts/unmounts the panel element below.
    shellSeatHostsPanel(store.getBox().state.mirrors.get(props.sessionId))
      ? createElement(seatPanel)
      : null;

  const hosts: ShellHosts = {
    // Host the panel ONLY for a session our mirrors vouch for (a parsed or
    // corrupt dispatcher snapshot); anything else renders an empty pane —
    // never an invented roster for a plain chat.
    rosterPanel: RosterSeat,
    // The main seat: the text-only conversation surface (ticket 80), bound
    // to the reduced event-window store and the two verified host actions.
    // Send rides the capsule's OWN verified plain-prompt sink (ticket 40's
    // transport, shape corrected by ticket 92:
    // `sessions.scope(id).get("conversation").send(text)` — one sink, never
    // a parallel channel, A4: the host owns the journal); older pages ride
    // the scoped `loadOlder()` (Finding 7). NO cancel affordance exists —
    // the ticket's area-7 rule; the scoped cancel verb stays deliberately
    // unused (recorded on the ticket). The pane factory's output IS the
    // component (ticket 88: rendered by the shell, never called by it).
    conversation: conversationPane,
    // Called AFTER the store accepted the row selection; the binding re-runs
    // its guarded select (no-op) and rides the host's `open` verb.
    onSelectSession: (sessionId) => {
      binding?.open(sessionId);
    },
    // The no-selection main state hosts the first-run flow when the wiring
    // provides it (ticket 68); the seat itself settles to the no-selection
    // copy once suppressed. (Ticket 88: a component, rendered as an element.)
    onboarding: onboardingPane,
  };

  return { store, seat, conversation, hosts };
}
