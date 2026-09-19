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
 * happens (`cannot get property "X" without inject` — ticket 84). So the
 * always-shipped faces we read (`sessions`, `remote`, `conversation`) are
 * declared here; `layout` and `settingsScope` are genuinely OPTIONAL faces
 * reached through the runtime `ctx.inject([...])` wrapper instead (tickets
 * 46/84) — a hard declaration would hold the whole module PENDING when they
 * are absent.
 *
 * What registers (design-16 §4.2/§5):
 * 1. the `multitask-dispatcher` locale namespace ({en, zh});
 * 2. the data path: a bind on our settings namespace through the shipped
 *    `ctx.settingsScope` service, where the host half mirrors the roster
 *    snapshot under the `roster` key (the documented config-channel fallback —
 *    no invented push channel);
 * 3. ~~the dispatcher capsule entry~~ RETIRED at the ticket-78 cutover
 *    (2026-09-19): the `shell.overlay` chip/panel registration stopped (the
 *    capsule era ends; ADR-0020 supersedes ADR-0013's vehicle). Its stores,
 *    copy, and component remain as re-host assets fed by the SAME watch —
 *    dead-code disposition is the 65/66/73 lane's;
 * 4. the per-tool call views (ticket 24): keyed `tool.call.toolview` entries
 *    for the five dispatcher wire tool names — unclaimed keys, so additive-
 *    safe against the shipped composition (research Finding 5);
 * 5. the plugin's settings card (ticket 47): one keyed `settings.plugin.item`
 *    entry whose `key` is our settings namespace, so the shipped
 *    插件配置 tab pairs our card with the namespace the Host serves.
 * 6. ~~the staging launcher chip~~ RETIRED at the ticket-78 cutover
 *    (2026-09-19) alongside the capsule: the `shell.overlay` chip and its
 *    `layout` watch stopped with the frame election (item 10);
 * 7. the wrapper shell page itself (ticket 78, ADR-0020 staging): one keyed
 *    `main` entry under OUR key (the only shipped key is `conversation`),
 *    binding the shell store to the sessions feed and hosting the existing
 *    roster panel in the right seat. The `root` frame election (item 10) is
 *    the CUTOVER slice — it executes only after ticket 80's conversation
 *    surface has landed; at the cutover the page registration STAYS (the
 *    pinned staging contract), dormant behind the frame election and
 *    self-restoring on abdication.
 * 8. the wrapper conversation pane (ticket 80, ADR-0020 slice 4): the main
 *    seat renders the selected session's text-only conversation — replay +
 *    live turns from the session's verified event window
 *    (`sessions.binding(id).eventSource`, `wrapper-vehicle-seams.md`
 *    Finding 7) reduced by `conversation-store.ts`, older pages through the
 *    scoped `loadOlder()`, sends through ticket 40's plain-prompt sink. No
 *    cancel affordance exists (area 7 conformity).
 * 9. the onboarding first-run seat (ticket 68, ADR-0018 in-scope area): the
 *    shell's no-selection main state hosts the beat walk when the flow is
 *    unsuppressed — IN-SHELL, so it survives the ticket-78 cutover (never
 *    the staging-only shipped `settings.onboarding` slot). Suppression rides
 *    the SAME settings-namespace bind as the roster/card (A5): a well-formed
 *    `onboarding` seen record OR ≥1 dispatcher mirror key (`roster.<id>`,
 *    tickets 76/79) suppresses; a corrupt/unreadable record FAILS OPEN — the
 *    flow shows, it is never silently hidden.
 * 10. the wrapper shell frame's ROOT election (ticket 78 CUTOVER,
 *    ADR-0020 property 2): one DYNAMIC `root` entry that displaces the
 *    shipped AppFrame exactly while it stays live and abdicates back to it
 *    on crash (per-entry boundary) or unload (fiber cascade). The
 *    capsule/launcher overlay entries retire at this same cutover.
 *
 * Ticket 40 binds the capsule/panel intents to ticket 36's verified seams
 * at THIS composition point and nowhere else: the narrow CommandTransport
 * (start = the composer's exact `commands.execute` transaction with
 * `/dispatcher-start` verbatim; stop = the scope-addressed plain-prompt
 * sink with the locale-keyed conversational phrasing) and the per-row steer
 * prefill seat (`input.for(actx).setDraft`) are built here over lazy
 * service sources. Since the ticket-78 cutover the composition's ONE
 * transport + steer seat live in `mountShellPage` (the wrapper shell's
 * conversation pane and hosted roster panel are their only consumers; the
 * capsule factory no longer receives them — its registration is retired).
 * The faces are read lazily so their VALUES are fresh at send/click time;
 * the services themselves are DECLARED in the module inject (ticket 84 — an
 * undeclared property read throws on the real host wherever it happens),
 * and a face that is absent still degrades to honest
 * `no-channel`/copy-fallback UX via `src/client/actions.ts`.
 */

import type {
  ClientContext,
  ClientSettingsScopeLike,
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
import {
  createCapsuleFooterStore,
  createCapsuleStore,
  type CapsuleFooterStore,
  type CapsuleStore,
} from "./capsule-store.js";
import { createRosterStore, type RosterStore } from "./roster-store.js";
import { createToolviewComponent } from "./toolview-panel.js";
import {
  TOOLVIEW_TOOL_NAMES,
  TOOL_CALL_TOOLVIEW_SLOT,
  toolviewRegistration,
} from "./toolviews.js";
import {
  SETTINGS_PLUGIN_ITEM_SLOT,
  createSettingsCardStore,
  settingsCardRegistration,
  type SettingsCardStore,
} from "./settings-card-store.js";
import { createPluginSettingsCard } from "./settings-card.js";
import { createRosterPanel } from "./panel.js";
import {
  MAIN_PAGE_SLOT,
  ROOT_FRAME_SLOT,
  shellPageRegistration,
  shellRootRegistration,
  shellSeatHostsPanel,
  shellSeatPanelState,
} from "./shell-mount.js";
import {
  createDispatcherShell,
  type ShellHosts,
} from "./shell.js";
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
  createConversationPane,
  type ConversationSendOutcome,
} from "./conversation.js";
import {
  createOnboardingStore,
  writeOnboardingSeenRecord,
  type OnboardingStore,
} from "./onboarding.js";
import { createOnboardingPane } from "./onboarding-pane.js";

/**
 * Client services this module READS on `ctx`, declared per the shipped
 * Cordis idiom (ticket 84): the context proxy throws `cannot get property
 * "X" without inject` on any undeclared service property — at read time,
 * wherever it happens — so every service face the module touches must
 * appear here unless it is reached through the runtime `ctx.inject([...])`
 * wrapper instead. Declared: the always-shipped load-bearing faces
 * (`slots` ← ui-renderer, `locale` ← client-locale, `sessions` ←
 * ui-session, `remote` ← api-gateway, `conversation` ← ui-conversation).
 * Wrapper-only, deliberately NOT declared because a hard requirement would
 * hold the whole module PENDING when absent: `settingsScope` (ticket 46's
 * settings watch) and `layout` (the launcher's optional page controller,
 * watched in the staging-mount section below).
 */
export const inject: readonly string[] = [
  "slots",
  "locale",
  "sessions",
  "remote",
  "conversation",
];

/**
 * Browser plugin entry. Every registration is an effect on this module's
 * fiber, so an unload/HMR swap reverses the namespace, the settings watch,
 * and the slot entry.
 */
export function apply(ctx: ClientContext): void {
  applyClientModule(
    ctx,
    createRosterStore(),
    createCapsuleStore(),
    createCapsuleFooterStore(),
    createSettingsCardStore(),
  );
}

/**
 * The module body, factored over explicit stores so offline tests can drive
 * the data path end to end (watch payload → store → view model) without a
 * DOM harness. Not a second entry point: `apply` is the only thing the
 * loader registers. The capsule store (ticket 38) is the entry's own
 * expansion state; the footer store (ticket 42) holds the persisted flag
 * provenance read from the SAME watch; defaulting either keeps older
 * callers working and gives a fresh fiber a collapsed capsule. The
 * onboarding store (ticket 68) holds the first-run beat walk plus the seen
 * input read from that same watch; defaulting it starts a fresh fiber at
 * beat one.
 */
export function applyClientModule(
  ctx: ClientContext,
  store: RosterStore,
  capsule: CapsuleStore = createCapsuleStore(),
  footer: CapsuleFooterStore = createCapsuleFooterStore(),
  card: SettingsCardStore = createSettingsCardStore(),
  onboarding: OnboardingStore = createOnboardingStore(),
): void {
  // Locale namespace (Finding 6 idiom): labeled effect; executes immediately,
  // the returned disposer is collected for unload.
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, localeDictionary),
    "multitask-dispatcher: locale dictionaries",
  );

  // Roster data path (ticket 21, design-16 §4.2 honest gap; contract corrected
  // by ticket 46): bind our namespace's scope on the shipped settings base
  // plugin's `ctx.settingsScope` service. NOT `ctx.inject(["settings"])` — that
  // is the HOST seam; client-side the service is `settingsScope`, and the shape
  // is `bind({namespace})` → `{getSnapshot, subscribe}`, with no `watch(ns, cb)`
  // in the contract (see `context.ts`). The old name never resolved, so this
  // body never ran and the store sat at `waiting` forever (live: capsule never
  // flipped, footer flag `unknown`). The panel degrades to "unavailable" copy
  // when the service is missing or the feed is stale — never against an
  // unverified live push channel. The SAME snapshot feeds the ticket-42 footer
  // store (persisted flag provenance) — one channel, two honest readers, never
  // a second source.
  //
  // Ticket 47 attaches its settings card to this SAME bind: one namespace, one
  // scope, and the card's writes (`set`/`unset`) leave through the transport
  // that bind already owns. A second bind would be a second channel with its
  // own revision view, which is exactly what the ticket forbids.
  //
  // Ticket 68 rides this SAME bind for the onboarding suppression input: each
  // accepted document feeds the store's seen extraction, and an unavailable
  // namespace feeds an explicit `undefined` — fail-open (the flow shows when
  // the record cannot be read; it is never silently hidden). The bound scope
  // is also kept for the seen WRITE hand-off below.
  let seenScope: ClientSettingsScopeLike | null = null;
  ctx.effect(() => {
    let disposeWatch: (() => void) | undefined;
    if (typeof ctx.inject !== "function") {
      store.set({ kind: "channel-missing" });
      card.attachUnavailable();
      return () => {};
    }
    ctx.inject(["settingsScope"], (child) => {
      const binder = child.settingsScope;
      if (binder === undefined || typeof binder.bind !== "function") {
        store.set({ kind: "channel-missing" });
        card.attachUnavailable();
        return;
      }
      const scope = binder.bind({ namespace: LOCALE_NAMESPACE });
      seenScope = scope;
      card.attach(scope);
      const readSnapshot = () => {
        const snapshot = scope.getSnapshot();
        if (snapshot.status === "unavailable") {
          // Namespace not exposed to this client (or preferences are
          // process-local): no honest feed exists at all.
          store.set({ kind: "channel-missing" });
          // Ticket 68: no readable document = no seen record — the
          // fail-open reset so first-run can never be stranded.
          onboarding.applyDocument(undefined);
          return;
        }
        onboarding.applyDocument(snapshot.value);
        // `loading` (or a first-section-less `ready`) means the namespace's
        // document has not been accepted yet: stay `waiting` — the feed is
        // alive, the roster simply is not in it.
        if (snapshot.value === undefined) return;
        store.applyChannelValue(snapshot.value);
        footer.applyChannelValue(snapshot.value);
      };
      disposeWatch = scope.subscribe(readSnapshot);
      // Subscribe only fires on replacements; a scope bound after the first
      // accepted section already stands at `ready`, so read once now or the
      // roster would wait for a write that may never come.
      readSnapshot();
    });
    return () => {
      if (disposeWatch !== undefined) disposeWatch();
      seenScope = null;
      card.detach();
    };
  }, "multitask-dispatcher: roster settings watch");

  // The onboarding seen-write hand-off (ticket 68): a best-effort write of
  // the seen record through the ONE bound scope (A5 — never a second
  // channel), factored as the pure `writeOnboardingSeenRecord` (offline
  // pinned). A resolved write stays silent — the watch re-delivers the
  // document and the suppression decision closes the flow (no fake success
  // surface; the capsule's discipline). A missing write path or a rejected
  // write sets the honest save-failed notice instead: the flow closes for
  // this visit and simply shows again next launch — fail-open, so nothing
  // strands either way.
  const writeOnboardingSeen = (): void => {
    writeOnboardingSeenRecord(seenScope, () => onboarding.markSaveFailed());
  };

  // Per-tool call views (ticket 24): one inject at the shipped keyed slot,
  // one entry per dispatcher wire tool name. Keys are the plugin-owned core
  // tool names (ticket 11) — unclaimed by the shipped composition, so each
  // cell is ours by default and the generic row remains the fallback shape.
  // All five registrations ride the same inject controller: fiber unload
  // disposes the controller and every entry with it (HMR-safe).
  ctx.slots.inject(TOOL_CALL_TOOLVIEW_SLOT, () => {
    const t = ctx.locale.bind(LOCALE_NAMESPACE);
    for (const toolName of TOOLVIEW_TOOL_NAMES) {
      ctx.slots.register(
        toolviewRegistration(toolName),
        createToolviewComponent(toolName, t),
      );
    }
  });

  // Settings card (ticket 47): one keyed `settings.plugin.item` entry. The
  // slot is declared at runtime by the shipped configurable-plugins tab
  // (`dsh-client-ui-settings-plugins/lib/client.js:1773-1784`), which is why
  // this rides the declaration wait like every other entry here — the tab
  // dispatches `renderSlot("settings.plugin.item", {}, { entryKey: ns })` per
  // served namespace and renders the intersection with the cards that claim
  // them, so a served namespace without a card renders nothing at all. The key
  // is our settings namespace (the whole pairing contract); the card reads and
  // writes through the scope bound above, never a second channel.
  //
  // Deliberately no entry-level `inject`: the shipped cards pass one because
  // their components read an injected controller face as props, while ours is a
  // factory bound to its seats at composition time — the same pattern the
  // capsule and toolviews already use.
  //
  // And a plain callback returning the registration's disposer, not the shipped
  // generator: `SlotRegistry.inject` documents both forms ("callback effects
  // are synchronous disposers; iterable effects install transactionally"), the
  // return value is the declaration-lifetime disposer either way, and our
  // offline fakes drive the callback form — a generator body would simply never
  // run there, so the entry could not be pinned offline.
  ctx.slots.inject(SETTINGS_PLUGIN_ITEM_SLOT, () => {
    const t = ctx.locale.bind(LOCALE_NAMESPACE);
    return ctx.slots.register(
      settingsCardRegistration(),
      createPluginSettingsCard(t, card),
    );
  });

  // ── Wrapper shell STAGING mount (ticket 78, ADR-0020 slice 2) ──
  //
  // Cutover note (ticket 78, 2026-09-19): the staging LAUNCHER — the second
  // additive `shell.overlay` chip plus its `ctx.inject(["layout"])` watch —
  // RETIRED with the frame election below (the vehicle that opened the page
  // from the shipped app's floating layer; the page itself stays registered,
  // dormant behind the frame election and self-restoring on abdication).
  // Its pure contracts (`openShellPage`, `createShellLauncherLayout`,
  // `shellLauncherRegistration`) remain exported in `shell-mount.ts` /
  // `shell.tsx` as retired-vehicle assets; the component is `shell.tsx`'s
  // `createShellLauncher`. Dead-code disposition is the 65/66/73 lane's.

  // The shell page: one keyed `main` entry under OUR key (the only shipped
  // key is `conversation` — unclaimed cells are ours by default; claiming a
  // covered key would be a shadowing election, which staging never makes).
  // The entry mounts the live shell: store + sessions-feed binding + the
  // hosted roster panel seat, all fiber-scoped so unload/HMR reverses the
  // registration, the feed subscription, and the seat projection together.
  ctx.slots.inject(MAIN_PAGE_SLOT, () => {
    const t = ctx.locale.bind(LOCALE_NAMESPACE);
    const mount = mountShellPage(ctx, {
      store: onboarding,
      onSeen: writeOnboardingSeen,
    });
    return ctx.slots.register(
      shellPageRegistration(),
      createDispatcherShell(t, mount.store, mount.hosts),
    );
  });

  // ── Cutover: the frame election (ticket 78, ADR-0020 property 2) ──

  // The wrapper shell frame registers into the `root` single slot as a
  // DYNAMIC entry. The host assigns dynamically registered entries a LOWER
  // shadowing rank than the shipped frame's ("Page-local shadowing rank. A
  // later registration receives a lower priority.", dsh-cordis-client-runner
  // lib/client.js:383; the priority field is host-assigned — our options
  // carry none), and the outlet renders "the first live (non-abdicated)
  // entry … in priority order" (`registry.d.ts:156-164`) — so our frame wins
  // the cell exactly while it stays live. Fail-safe: a render crash
  // abdicates the entry through the per-entry boundary and "the outlet
  // re-renders onto the cell's next survivor" (dsh-client-ui-renderer
  // lib/client.js:507-514) — the shipped app frame takes the cell back;
  // module unload/HMR sweeps the entry with the caller's-fiber cascade
  // (`registry.d.ts:77-83`). The registration shape is the runtime catalog's
  // own documented example (`{name: "root"}`, `registerOptions: []`,
  // runner lib/client.js:3514-3520; the shipped AppFrame adds `locale` and
  // its child-seat declarations — dsh-client-ui-layout lib/client.js:524) —
  // no id, no key, and NO `children`: the frame is self-contained (its
  // sidebar/main/right seats are our own React seats, never host slot
  // outlets). The same `mountShellPage` composition powers this frame and
  // the `main` page above (one onboarding store shared — the suppression
  // input is one fact, never two); the shipped `conversation` main key is
  // still never claimed, and the frame swap / HMR fiber behavior /
  // fallback-on-crash confirmation stays with the live lane (tickets 45/33).
  ctx.slots.inject(ROOT_FRAME_SLOT, () => {
    const t = ctx.locale.bind(LOCALE_NAMESPACE);
    const mount = mountShellPage(ctx, {
      store: onboarding,
      onSeen: writeOnboardingSeen,
    });
    return ctx.slots.register(
      shellRootRegistration(),
      createDispatcherShell(t, mount.store, mount.hosts),
    );
  });
}

/**
 * The shell page's live mounting path (ticket 78 staging), factored over
 * explicit stores so offline tests can drive the data path end to end —
 * feed snapshot → shell store → hosted-panel seat — without a DOM harness
 * (same discipline as `applyClientModule`). Called ONLY from the `main`
 * inject above: the effects land on the caller's fiber inside the inject
 * controller, so unloading the page registration reverses the feed binding
 * and the seat projection with it (HMR-safe; the ticket's "reverse every
 * registration" constraint).
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
  /** Host seats handed to `createDispatcherShell`. */
  readonly hosts: ShellHosts;
}

/**
 * The first-run onboarding wiring (ticket 68): the store the settings watch
 * feeds and the composition's seen-write hand-off. Optional so a composition
 * (or a test) can mount the shell without the flow — the no-selection state
 * keeps its bare copy.
 */
export interface ShellOnboardingWiring {
  readonly store: OnboardingStore;
  readonly onSeen: () => void;
}

export function mountShellPage(
  ctx: ClientContext,
  onboarding?: ShellOnboardingWiring,
): ShellPageMount {
  const store = createDispatcherShellStore();
  const seat = createRosterStore();
  const conversation = createConversationStore();
  let binding: ShellFeedBinding | undefined;

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
  // store, and the two verified actions. Called per render with the selected
  // session id (the shell's main seat), the same seat pattern as the hosted
  // roster panel.
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

  const hosts: ShellHosts = {
    // Host the panel ONLY for a session our mirrors vouch for (a parsed or
    // corrupt dispatcher snapshot); anything else renders an empty pane —
    // never an invented roster for a plain chat.
    rosterPanel: (sessionId) =>
      shellSeatHostsPanel(store.getBox().state.mirrors.get(sessionId))
        ? seatPanel()
        : null,
    // The main seat: the text-only conversation surface (ticket 80), bound
    // to the reduced event-window store and the two verified host actions.
    // Send rides the capsule's OWN verified plain-prompt sink (ticket 40's
    // transport: `sessions.scope(id).conversation.send` — one sink, never a
    // parallel channel, A4: the host owns the journal); older pages ride the
    // scoped `loadOlder()` (Finding 7). NO cancel affordance exists — the
    // ticket's area-7 rule; the scoped cancel verb stays deliberately
    // unused (recorded on the ticket).
    conversation: (sessionId) => conversationPane({ sessionId }),
    // Called AFTER the store accepted the row selection; the binding re-runs
    // its guarded select (no-op) and rides the host's `open` verb.
    onSelectSession: (sessionId) => {
      binding?.open(sessionId);
    },
    // The no-selection main state hosts the first-run flow when the wiring
    // provides it (ticket 68); the seat itself settles to the no-selection
    // copy once suppressed.
    onboarding: onboardingPane,
  };

  return { store, seat, conversation, hosts };
}
