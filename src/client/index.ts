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
 * happens (`cannot get property "X" without inject` — ticket 84). So every
 * always-shipped face we read is declared here.
 *
 * What registers (design-16 §4.2/§5):
 * 1. the `multitask-dispatcher` locale namespace ({en, zh});
 * 2. the per-tool call views (ticket 24): keyed `tool.call.toolview` entries
 *    for the six dispatcher wire tool names (five at 24; `send_peer` joined
 *    under ticket 70) — unclaimed keys, so additive-
 *    safe against the shipped composition (research Finding 5);
 * 3. the plugin's configuration page: one keyed `plugins.row.config` entry
 *    for the row `<package name>#<settings namespace>`, whose form comes from
 *    the slot owner's props (0.2.1 replaced the removed `settings.plugin.item`
 *    slot and `ctx.settingsScope` service with this path);
 * 4. the session-kind indicators (ticket 123; extended by ticket 140):
 *    the dispatcher glyph in the stock sidebar row's leading cell (the seat
 *    ADR-0024's rider licenses), plus the dispatcher header chip in a
 *    session's own conversation header (the 2026-10-28 ruling — a spawned
 *    dispatcher has no sidebar row). The WORKER marker is still declined and
 *    not composed in either seat.
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
 * The faces are read lazily so their VALUES are fresh at send/click time;
 * the services themselves are DECLARED in the module inject (ticket 84 — an
 * undeclared property read throws on the real host wherever it happens),
 * and a face that is absent still degrades to honest
 * `no-channel`/copy-fallback UX via `src/client/actions.ts`.
 */

import { createElement } from "react";
import type { JSX } from "react";
import type { ClientContext } from "./context.js";
import {
  LOCALE_NAMESPACE,
  localeDictionary,
} from "./overlay.js";
import {
  bindCommandTransport,
  submitAccessResolve,
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
  createApprovalCardsStore,
  type ApprovalCardsStore,
} from "./approval-cards.js";
import {
  createApprovalRelayFeed,
  type ApprovalRelayFeed,
} from "./approval-feed.js";
import {
  createShellMirrorFeed,
  type ShellMirrorFeed,
} from "./shell-mirror-feed.js";
import type { ApprovalCardActions } from "./approval-pane.js";
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
  createSessionHeaderKindGlyph,
  createSessionKindGlyph,
  dispatcherGlyphRegistration,
  dispatcherHeaderGlyphRegistration,
} from "./session-kind.js";

/**
 * Client services this module READS on `ctx`, declared per the shipped
 * Cordis idiom (ticket 84): the context proxy throws `cannot get property
 * "X" without inject` on any undeclared service property — at read time,
 * wherever it happens — so every service face the module touches appears
 * here. Declared: `slots` ← ui-renderer, `locale` ← client-locale,
 * `sessions` ← ui-session, `remote` ← api-gateway, `remote.commands` (its
 * own nested entry — the resolver matches exact strings and never
 * dot-splits), `conversation` ← ui-conversation, and `configForms` ←
 * ui-settings (the settings page's shared form service; the Plugins page
 * itself requires it, `dsh-client-ui-plugin-manager/lib/client.js:4357-4367`).
 */
export const inject: readonly string[] = [
  "slots",
  "locale",
  "sessions",
  "remote",
  "conversation",
  "remote.commands",
  "configForms",
];

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
 * - `approvalsFeed` — the relay feed every mount may attach to (the shared
 *   hub). No live channel feeds it on 0.2.1.
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
  readonly approvalsFeed: ApprovalRelayFeed;
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

  // Roster/approval/mirror data path: NOT composed. dsh 0.2.1 removed the
  // client settings-scope service this watch rode, and the host half's
  // `roster`/`roster.<id>` keys are no longer accepted by the settings
  // document (undeclared keys are rejected as non-volatile). The feeds stay
  // as retained machinery with no live channel: a surface that returns needs
  // a 0.2.1-native transport, not a smuggled config key (ADR-0024).
  const approvalFeed = createApprovalRelayFeed();
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
  // All six registrations ride the same inject controller: fiber unload
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
  // dispatcher glyph in the stock sidebar row's 16px leading cell
  // (`sidebar.session.row.leading`).
  //
  // The ADR-0024 rider (2026-10-18) licenses "exactly one additional additive
  // registration, and it is this one ... no other slot is licensed by this
  // rider". The header seat below is a SEPARATE, later dated ruling (ticket
  // 140, 2026-10-28) extending the rider — not a widening of this one.
  //
  // Identity: dispatchers are identified by the `sessionKind` projection the
  // adapter registers, which folds the `command/run` + `command/done` pair
  // `/dsh-bot` already writes (plus, since ticket 140, the adapter's
  // dispatcher-mark mirror at `init` for spawned children) — so the identity
  // is durable and needs no event of our own. `agentPreset` is unusable here
  // (every durable header reads "standard").
  ctx.slots.inject(
    dispatcherGlyphRegistration().name,
    () => {
      const t = ctx.locale.bind(LOCALE_NAMESPACE);
      return ctx.slots.register(
        dispatcherGlyphRegistration(),
        createSessionKindGlyph("dispatcher", t),
      );
    },
  );

  // Session-kind header chip (ticket 140; ruling 2026-10-28): a spawned
  // dispatcher is `origin: 'subagent'`, and stock dsh hides those sessions
  // from the sidebar — so the licensed sidebar cell never mounts for it. Its
  // own conversation header is the only reachable seat. Additive in the same
  // list band, above every stock occupant (`subagent-catalog` at 10,
  // `job-list` at 20). Resolved from `projectionValues.sessionKind` AND
  // `origin === 'subagent'` (review fix): the child IS a subagent, and the
  // origin gate is what keeps a user-started dispatcher's header from growing
  // a second mark beside its sidebar glyph. `resolveSessionKind` untouched.
  ctx.slots.inject(
    dispatcherHeaderGlyphRegistration().name,
    () => {
      const t = ctx.locale.bind(LOCALE_NAMESPACE);
      return ctx.slots.register(
        dispatcherHeaderGlyphRegistration(),
        createSessionHeaderKindGlyph(t),
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

  return { approvalsFeed: approvalFeed, mirrorsFeed, mounts };
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
 *   `ctx.sessions` — a DECLARED read (ticket 84), so it cannot throw; an
 *   absent face (offline fakes) leaves the store empty and the shell renders
 *   its honest empty copy — the mount never blocks.
 * - Row selection re-routes through the binding's guarded `open`, which
 *   rides the host's `sessions.open(id)` verb after the store accepted the
 *   row (unknown ids are refused on both sides).
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
  /**
   * Ticket 81: the approval-cards store behind the conversation pane's
   * "Needs you" area. Fed from the shared relay feed when the composition
   * provides it (ticket 69 L1 — the roster snapshot's v4 `pendingAsks`),
   * else honestly `unfed`; exposed so tests can drive the data path end to
   * end without a second store.
   */
  readonly approvals: ApprovalCardsStore;
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
 * The approval-cards relay feed the composition shares (ticket 69, L1).
 * Optional so a composition (or a test) can mount the shell without it —
 * the approvals store then stays `unfed` and the pane renders no cards
 * area (honest unknown, never a fabricated "nothing needs you").
 */
export interface ShellApprovalFeedWiring {
  readonly approvalsFeed?: ApprovalRelayFeed;
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

export function mountShellPage(
  ctx: ClientContext,
  wiring?: ShellOnboardingWiring &
    ShellApprovalFeedWiring &
    ShellMirrorFeedWiring,
): ShellPageMount {
  const onboarding = wiring && wiring.store ? wiring : undefined;
  const approvals =
    wiring && wiring.approvalsFeed !== undefined ? wiring : undefined;
  const mirrors =
    wiring && wiring.mirrorsFeed !== undefined ? wiring : undefined;
  const store = createDispatcherShellStore();
  const seat = createRosterStore();
  const conversation = createConversationStore();
  // Ticket 81/69: the approval-cards store (the "Needs you" area's data
  // seam). Fed through the shared relay hub when the wiring provides it
  // (below); unfed stores render nothing — honest unknown, never a
  // fabricated "nothing needs you".
  const approvalsStore = createApprovalCardsStore();
  let binding: ShellFeedBinding | undefined;

  // Approval relay feed attach (ticket 69, L1 offline half): this mount's
  // store joins the shared hub — replaying the last good pending set
  // immediately, then every publish — and detaches with the mount's fiber
  // (the sessions-feed-binding pattern: unsubscribes on unload/HMR).
  ctx.effect(() => {
    const feed = approvals?.approvalsFeed;
    if (feed === undefined) return () => {};
    return feed.attach(approvalsStore);
  }, "multitask-dispatcher: shell approval relay feed");

  // Per-session mirror attach (ticket 94): this mount's shell store joins the
  // shared hub — replaying the last-known `roster.<sessionId>` mirrors
  // immediately, then every publish — and detaches with the mount's fiber
  // (same pattern as the approvals feed above). WITHOUT this the sidebar's
  // `data-dispatcher` flag, the presence chips, the needs-you marker, and the
  // hosted roster panel have no live data at all (the live-found bug).
  ctx.effect(() => {
    const feed = mirrors?.mirrorsFeed;
    if (feed === undefined) return () => {};
    return feed.attach(store);
  }, "multitask-dispatcher: shell per-session mirror feed");

  // Feed binding (ticket 79's projection, wired at THIS composition point —
  // the ticket-79 comment's "ticket 78's registration"). `sessions` is
  // DECLARED in the module inject (ticket 84 — an undeclared read throws on
  // the real host), so this guard reads only the face's VALUE: `undefined`
  // means the face is absent (offline fakes) and the mount degrades to an
  // empty store. The `onOpen` hook rides the host's selection verb; optional
  // chaining keeps a runtime without `open` degrading to store-only
  // selection.
  ctx.effect(() => {
    if (ctx.sessions === undefined) return () => {};
    const bound = bindShellSessionsFeed(store, ctx.sessions, {
      onOpen: (sessionId) => ctx.sessions?.open?.(sessionId),
    });
    binding = bound;
    return bound.dispose;
  }, "multitask-dispatcher: shell sessions feed binding");

  // Conversation window binding (ticket 80, Finding 7): the SELECTED
  // session's event window feeds the conversation store; the window opens
  // because the selection above stages the session via `open`. `sessions` is
  // a declared read (ticket 84); `undefined` here is the offline absence of
  // the face, and the pane degrades to honest unavailability — never a
  // fabricated transcript.
  ctx.effect(() => {
    if (ctx.sessions === undefined) return () => {};
    const bound = bindConversationFeed(conversation, ctx.sessions, store);
    return bound.dispose;
  }, "multitask-dispatcher: shell conversation window binding");

  // The conversation send transport: ticket 40's verified plain-prompt sink
  // (the SAME one the capsule's stop ask uses), resolved lazily at send
  // time. One sink for the whole module — the composer never builds a
  // parallel channel (A4).
  const sendTransport = bindCommandTransport({
    remote: () => ctx.remote,
    sessions: () => ctx.sessions,
  });

  // The pane factory: bound once to the translate seat, the conversation
  // store, and the two verified actions — plus ticket 81's approvals seat
  // WITH ticket 69's resolve seat (L1): a card answer executes the host's
  // `/dispatcher-resolve` command through the SAME command transaction the
  // start transport used (ticket 36 seam 2 — the composer's exact
  // transaction, `ctx.remote.commands.execute`, verbatim line, no second
  // channel). The card's own `parentSessionId` addresses the dispatcher
  // chat, so the answer routes regardless of the current selection.
  // Await-truth, no optimism: `routed` only means the host ran the command;
  // the card settles when the relay feed re-publishes the worker unblocked
  // (the store's pending-outranks-notice design).
  const approvalActions: ApprovalCardActions = {
    onResolve: (card, choice) => submitAccessResolve(sendTransport, card, choice),
  };
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
      onLoadOlder: (sessionId) => requestOlder(ctx.sessions, sessionId),
    },
    { cards: approvalsStore, actions: approvalActions },
  );

  // The hosted panel's per-row steer affordance uses the same verified
  // prefill seam as the capsule (lazily resolved at click time).
  const onRowSteer = (workerId: string): SteerPrefillOutcome =>
    tryPrefillSteer(
      {
        sessions: () => ctx.sessions,
        conversation: () => ctx.conversation,
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

  return { store, seat, conversation, approvals: approvalsStore, hosts };
}
