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
 * declared here; `settingsScope` is the one genuinely OPTIONAL face, reached
 * through the runtime `ctx.inject([...])` wrapper instead (tickets 46/84) — a
 * hard declaration would hold the whole module PENDING when it is absent.
 * (The launcher's optional `layout` face and its `ctx.inject(["layout"])`
 * watch were DELETED with the launcher; ticket 89, 2026-09-19.)
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
 *    copy, and component were retained briefly as re-host assets and are now
 *    DELETED outright (ticket 89, 2026-09-19) — nothing consumed them.
 * 4. the per-tool call views (ticket 24): keyed `tool.call.toolview` entries
 *    for the six dispatcher wire tool names (five at 24; `send_peer` joined
 *    under ticket 70) — unclaimed keys, so additive-
 *    safe against the shipped composition (research Finding 5);
 * 5. the plugin's settings card (ticket 47): one keyed `settings.plugin.item`
 *    entry whose `key` is our settings namespace, so the shipped
 *    插件配置 tab pairs our card with the namespace the Host serves.
 * 6. ~~the staging launcher chip~~ RETIRED at the ticket-78 cutover
 *    (2026-09-19) alongside the capsule: the `shell.overlay` chip and its
 *    `layout` watch stopped with the frame election (item 10). Its contracts
 *    and component were retained briefly as re-host assets and are now
 *    DELETED outright (ticket 89, 2026-09-19) — nothing consumed them; the
 *    main-page contracts (item 7) stay as retained machinery.
 * 7. ~~the wrapper shell page~~ + ~~the `root` frame election~~ RETIRED from
 *    the DEFAULT POSTURE (2026-09-20, ticket 99, ADR-0021 — the human-ruled
 *    coexistence vehicle): stock dsh is the user's primary UI and is never
 *    displaced, so this composition no longer registers the keyed `main`
 *    page (ticket 78 staging), the conversation pane / onboarding seats that
 *    hosted inside it (tickets 80/68), or the DYNAMIC `root` entry that
 *    displaced the shipped AppFrame (ticket 78 CUTOVER). The registration
 *    machinery — `mountShellPage` (store + feeds + pane/seat wiring) and the
 *    `shell-mount.ts` contracts (`MAIN_PAGE_SLOT`/`shellPageRegistration`,
 *    `ROOT_FRAME_SLOT`/`shellRootRegistration`) — stays in the tree,
 *    reversible at ONE registration site. Fail isolation is re-based onto
 *    the additive posture: our registrations fail within our own module and
 *    the stock app is never shadowed.
 * 8. the floating dispatcher window + its stock-UI launcher (ticket 100,
 *    ADR-0021 decisions 2 + 4): ONE additive `shell.overlay` entry — a
 *    small chip that toggles a floating window hosting the EXISTING shell
 *    surfaces (re-hosted, not rebuilt: sidebar roster, conversation pane,
 *    approval cards, roster panel, onboarding — the `mountShellPage`
 *    wiring runs again, pushed into `mounts`). The window portals into a
 *    body-level container (the DOM-technique decision + citations live in
 *    `floating-window.tsx`); the shell sits behind our own error boundary
 *    inside the window, so a crashed window never takes the chip — or
 *    stock dsh — down (isolation re-based onto the additive posture; the
 *    host's per-entry boundary stands underneath as the second layer).
 *    No `root` entry, no `main` entry: the window is additive, never a
 *    displacement.
 *
 * Ticket 40 binds the capsule/panel intents to ticket 36's verified seams
 * at THIS composition point and nowhere else: the narrow CommandTransport
 * (start = the composer's exact `commands.execute` transaction with
 * `/dispatcher-start` verbatim; stop = the scope-addressed plain-prompt
 * sink with the locale-keyed conversational phrasing) and the per-row steer
 * prefill seat (`input.for(actx).setDraft`) are built in `mountShellPage`
 * over lazy service sources — the conversation pane and hosted roster panel
 * are their only consumers. Since ticket 100 (ADR-0021) the floating-window
 * launcher inject composes `mountShellPage` again — the window hosts those
 * two surfaces.
 * The faces are read lazily so their VALUES are fresh at send/click time;
 * the services themselves are DECLARED in the module inject (ticket 84 — an
 * undeclared property read throws on the real host wherever it happens),
 * and a face that is absent still degrades to honest
 * `no-channel`/copy-fallback UX via `src/client/actions.ts`.
 */

import { createElement } from "react";
import type { JSX } from "react";
import type {
  ClientContext,
  ClientSettingsScopeLike,
} from "./context.js";
import {
  LOCALE_NAMESPACE,
  SHELL_OVERLAY_SLOT,
  launcherOverlayRegistration,
  localeDictionary,
} from "./overlay.js";
import { createDispatcherShell, type ShellHosts } from "./shell.js";
import {
  bindCommandTransport,
  DISPATCHER_START_LINE,
  DISPATCHER_STOP_LINE,
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
  SETTINGS_PLUGIN_ITEM_SLOT,
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
  writeOnboardingSeenRecord,
  type OnboardingStore,
} from "./onboarding.js";
import { createOnboardingPane } from "./onboarding-pane.js";
import { createFloatingWindowStore } from "./floating-window-store.js";
import {
  createLauncherChip,
  disposeWindowLayer,
} from "./floating-window.js";

/**
 * Client services this module READS on `ctx`, declared per the shipped
 * Cordis idiom (ticket 84): the context proxy throws `cannot get property
 * "X" without inject` on any undeclared service property — at read time,
 * wherever it happens — so every service face the module touches must
 * appear here unless it is reached through the runtime `ctx.inject([...])`
 * wrapper instead. A NESTED face is its own entry under its full dotted
 * name (`remote.commands`): the resolver matches inject entries by EXACT
 * STRING and never dot-splits, so declaring only the parent service
 * instance does not authorize reading a member of it. Declared: the
 * always-shipped load-bearing faces (`slots` ← ui-renderer, `locale` ←
 * client-locale, `sessions` ← ui-session, `remote` ← api-gateway and its
 * nested `remote.commands` transaction face, `conversation` ←
 * ui-conversation).
 * Wrapper-only, deliberately NOT declared because a hard requirement would
 * hold the whole module PENDING when absent: `settingsScope` (ticket 46's
 * settings watch — since ticket 69 L1 also the approval-cards relay feed's
 * channel). (`layout` — the retired staging launcher's optional page
 * controller — stopped being requested at the ticket-78 cutover, and the
 * launcher contracts themselves were deleted by ticket 89.)
 *
 * Ticket 69 (L1/L3) face audit — why NO NEW SERVICE is declared here: the
 * relay FEED rides the settingsScope wrapper above (the roster mirror, one
 * channel); the resolve TRANSPORT rides the `remote.commands` transaction
 * declared below (`remote` for the parent instance, `remote.commands` for
 * the nested face — the exact shipped precedent is
 * `@deepseek-ai/dsh-client-ui-commands`' client, whose
 * `static inject = ["inputTriggers","sessions","remote","remote.commands"]`
 * declares BOTH the parent and the full nested path; every shipped caller
 * of a nested face does the same, without exception) plus the card's own
 * `parentSessionId`; and the
 * dispatch ANSWERER (`ctx.approval`, `@deepseek-ai/dsh-user-approval` —
 * adapter notes :220/:390) is a HOST service wired in `src/plugin.ts`'s
 * inject, never read client-side: the client half of that waterfall is the
 * shipped `dsh-client-ui-approval` composer over the forwarded
 * `approval/request` Remote event, which composes independently of this
 * module (with the ADR-0021 coexistence posture the shipped frame is never
 * displaced, so the composer should answer natively — deferred ticket 98's
 * gap 1 is expected-moot, pending the live lane's confirmation).
 */
export const inject: readonly string[] = [
  "slots",
  "locale",
  "sessions",
  "remote",
  // Ticket 102b: the nested transaction face is its OWN inject entry — the
  // resolver matches by exact string, so the parent `remote` above does not
  // authorize this read (the shipped ui-commands precedent declares both).
  "remote.commands",
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
    createSettingsCardStore(),
  );
}

/**
 * What the composition built, handed back so offline tests can drive the
 * REAL wiring instead of reconstructing it by hand (ticket 69, L1 offline
 * composition pin). Two facts, both live references:
 *
 * - `approvalsFeed` — the ONE relay feed the settings watch feeds and every
 *   mount attaches to (the shared hub).
 * - `mirrorsFeed` — the ONE per-session mirror feed the same settings watch
 *   feeds and every mount attaches its shell store to (ticket 94; the
 *   read side the live surface was missing).
 * - `mounts` — every `mountShellPage` result the slot injects created, in
 *   registration order. Since ticket 100 (ADR-0021) the default composition
 *   creates exactly ONE mount — the floating window's shell (the
 *   `shell.overlay` launcher inject) — so it holds that mount after
 *   `apply`. Offline tests can also attach MORE `mountShellPage` results to
 *   the returned feeds to drive the mount data path (the ticket-99 pin
 *   idiom). The array is the SAME array the inject pushes into, so it also
 *   collects mounts that arrive AFTER the call returns. Offline fakes run
 *   the callback synchronously, so the list is complete at return there.
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
 * the data path end to end (watch payload → store → view model) without a
 * DOM harness. Not a second entry point: `apply` is the only thing the
 * loader registers. The onboarding store (ticket 68) holds the first-run
 * beat walk plus the seen input read from the SAME watch; defaulting it
 * starts a fresh fiber at beat one. (The capsule-era store parameters were
 * deleted with the capsule — ticket 89; older callers passing them would
 * now misalign, and `apply` is the only production caller.)
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

  // Roster data path (ticket 21, design-16 §4.2 honest gap; contract corrected
  // by ticket 46): bind our namespace's scope on the shipped settings base
  // plugin's `ctx.settingsScope` service. NOT `ctx.inject(["settings"])` — that
  // is the HOST seam; client-side the service is `settingsScope`, and the shape
  // is `bind({namespace})` → `{getSnapshot, subscribe}`, with no `watch(ns, cb)`
  // in the contract (see `context.ts`). The old name never resolved, so this
  // body never ran and the store sat at `waiting` forever (live: the roster
  // never flipped). The panel degrades to "unavailable" copy
  // when the service is missing or the feed is stale — never against an
  // unverified live push channel. (The ticket-42 footer store — once the
  // snapshot's second reader — was deleted with the capsule, ticket 89.)
  //
  // Ticket 47 attaches its settings card to this SAME bind: one namespace, one
  // scope, and the card's writes (`set`/`unset`) leave through the transport
  // that bind already owns. A second bind would be a second channel with its
  // own revision view, which is exactly what the ticket forbids.
  //
  // Ticket 68 rides this SAME bind for the onboarding suppression input: each
  // accepted document feeds the store's seen extraction, and an unavailable
  // namespace feeds an explicit `undefined` — fail-open (the flow shows when
  // the record cannot be read; it is never silently hidden).
  //
  // Ticket 69 (L1 offline half): the SAME document also feeds the
  // approval-cards relay feed — the roster snapshot's v4 `pendingAsks`
  // envelope field IS the relay's pending-ask truth, re-published by the
  // host on every park/resolve transition. One channel, one more honest
  // reader (the roster panel's own "Needs you" list was already on it);
  // never a second feed. The hub fans out to the per-mount approvals stores
  // (each `mountShellPage` attaches its own) with last-truth replay, and a
  // corrupt or unrelated document leaves every store untouched — the roster
  // panel owns corruption/staleness presentation, and this feed never
  // fabricates a "nothing waiting" from a document it cannot vouch for.
  const approvalFeed = createApprovalRelayFeed();
  /**
   * Ticket 94: the shell stores' mirror hub. The live surface had NO reader
   * for the per-session family at all — `applySessionMirror` was defined and
   * pinned but never called, so `state.mirrors` stayed empty forever
   * (`data-dispatcher="false"`, the `状态不可用` chip, no hosted panel). Fed
   * from the SAME single settings read as the two readers above, fanned out
   * to every mount's shell store with a last-truth replay. (Since ticket
   * 100 the floating-window launcher inject attaches the default mount's
   * store to this hub; offline tests may attach more.)
   */
  const mirrorsFeed = createShellMirrorFeed();
  /**
   * Ticket 69 (L1): every mount this composition creates, in order. Since
   * ticket 100 (ADR-0021) the floating-window launcher inject creates the
   * ONE default mount — the array stays the one place a registration site
   * pushes into.
   */
  const mounts: ShellPageMount[] = [];
  /**
   * The ONE bound settings scope, kept for the onboarding seen-write
   * hand-off below (A5: the write rides the same scope the watch reads —
   * never a second channel). Nulled when the watch disposes.
   */
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
          // Ticket 68/87: a SETTLED unreadable read — the explicit fail-open
          // reset (the flow shows) with the pane's read no longer in flight.
          onboarding.applySnapshot("unavailable", undefined);
          return;
        }
        // Ticket 87: the suppression input settles WITH the document. A
        // `loading` snapshot (the shipped controller's pre-acceptance state —
        // the describe read our own bind starts is still on the wire) sets
        // the pane's buffering flag instead of deciding from the fail-open
        // default; the document's arrival feeds the store and re-evaluates
        // the decision reactively. A runtime that never binds a scope never
        // buffers: the flow shows (the original fail-open pin).
        onboarding.applySnapshot(snapshot.status, snapshot.value);
        // `loading` (or a first-section-less `ready`) means the namespace's
        // document has not been accepted yet: stay `waiting` — the feed is
        // alive, the roster simply is not in it.
        if (snapshot.value === undefined) return;
        store.applyChannelValue(snapshot.value);
        approvalFeed.applyChannelValue(snapshot.value);
        // Ticket 94: the same accepted document feeds the shell stores'
        // per-session mirrors (`roster.<sessionId>`) — the reader the live
        // surface was missing. One document, three honest readers.
        mirrorsFeed.applyChannelValue(snapshot.value);
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

  // The onboarding seen-write hand-off (ticket 68; restored with the
  // floating-window mount, ticket 100): a best-effort write of the seen
  // record through the ONE bound scope (A5 — never a second channel),
  // factored as the pure `writeOnboardingSeenRecord` (offline pinned). A
  // resolved write stays silent — the watch re-delivers the document and
  // the suppression decision closes the flow. A missing write path or a
  // rejected write sets the honest save-failed notice instead: the flow
  // closes for this visit and simply shows again next launch — fail-open,
  // so nothing strands either way.
  const writeOnboardingSeen = (): void => {
    writeOnboardingSeenRecord(seenScope, () => onboarding.markSaveFailed());
  };

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

  // ── The floating dispatcher window + its stock-UI launcher (ticket 100,
  // ADR-0021 decisions 2 + 4) ──
  //
  // ONE additive `shell.overlay` entry (ADR-0013's sanctioned seam; unique
  // `multitask-dispatcher-` id — coexistence by id, never shadowing): a
  // small chip that toggles the floating window. The inject callback ALSO
  // creates the window's shell mount HERE — the same `mountShellPage`
  // wiring the retired `main`/`root` injects ran (the feed attaches, the
  // sessions/conversation bindings, the seat projection — all effects on
  // this module's fiber) — and pushes the result into `mounts`, the
  // designated push-site, so offline tests drive the REAL data path. The
  // mount's feeds stay attached while the window is CLOSED (the hubs
  // replay last truth at attach), so opening shows live data immediately;
  // fiber teardown detaches everything.
  //
  // DOM technique (this ticket's evidence, per ADR-0021's open question):
  // the window PORTALS into a body-level container — see floating-window.tsx
  // for the rejected second-overlay-entry alternative and the citations.
  // The container's lifecycle rides this fiber (unload/HMR removes it);
  // offline (no `document`) both the container and the window no-op.
  //
  // Crash isolation (ADR-0021 decision 2, re-based onto the additive
  // posture — the retired root abdication has no successor because nothing
  // is shadowed): dsh renders every slot entry inside its per-entry error
  // boundary, and a crashing LIST entry abdicates — retired from the
  // layer while siblings and the app stand (dsh-capsule-seams.md Seam 1,
  // ui-renderer lib/client.js:511-532). The window additionally wraps the
  // hosted shell in OUR OWN boundary inside the window
  // (floating-window.tsx), so a shell crash never even reaches the host's:
  // the chip and stock dsh survive, the window shows its honest failed
  // line with working chrome, and close + reopen recovers.
  const floatingWindow = createFloatingWindowStore();
  ctx.effect(
    () => () => disposeWindowLayer(),
    "multitask-dispatcher: floating window layer",
  );
  ctx.slots.inject(SHELL_OVERLAY_SLOT, () => {
    const t = ctx.locale.bind(LOCALE_NAMESPACE);
    const mount = mountShellPage(ctx, {
      store: onboarding,
      onSeen: writeOnboardingSeen,
      approvalsFeed: approvalFeed,
      mirrorsFeed: mirrorsFeed,
    });
    mounts.push(mount);
    return ctx.slots.register(
      launcherOverlayRegistration(),
      createLauncherChip(
        t,
        floatingWindow,
        createElement(createDispatcherShell(t, mount.store, mount.hosts)),
      ),
    );
  });

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
  // is the user's primary UI and is never displaced. The re-host site this
  // retired posture was waiting for is the floating-window registration
  // ABOVE (ticket 100): the same surfaces, in a separate window, behind an
  // additive launcher. The machinery stays retained, NOT deleted: the
  // registration contracts stay exported from `shell-mount.ts`
  // (`shellPageRegistration`, `shellRootRegistration`, the priority
  // constant) and the mounting path stays exported below
  // (`mountShellPage`). Fail isolation is re-based onto the additive
  // posture (see the launcher inject above). The retired-path tests remain
  // records of that machinery in `test/client-shell-mount.test.ts`.

  return { approvalsFeed: approvalFeed, mirrorsFeed, mounts };
}

/**
 * The shell page's live mounting path (ticket 78 staging), factored over
 * explicit stores so offline tests can drive the data path end to end —
 * feed snapshot → shell store → hosted-panel seat — without a DOM harness
 * (same discipline as `applyClientModule`). RETAINED MACHINERY re-hosted
 * (ticket 100, ADR-0021): the `main`/`root` injects that used to call it
 * left the default composition (ticket 99), and the floating-window
 * launcher inject is now its ONE production caller — the window hosts the
 * same surfaces, additively. Offline tests also drive it directly (also
 * against the real composition's feeds). Its effects still land on the
 * caller's fiber, so unloading the caller's registration reverses the feed
 * bindings and the seat projection with it (HMR-safe; the ticket's
 * "reverse every registration" constraint).
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
 * The first-run onboarding wiring (ticket 68): the store the settings watch
 * feeds and the composition's seen-write hand-off. Optional so a composition
 * (or a test) can mount the shell without the flow — the no-selection state
 * keeps its bare copy.
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
  // seam). Fed from the ONE settings watch through the shared relay feed
  // when the wiring provides it (below); unfed stores render nothing —
  // honest unknown, never a fabricated "nothing needs you".
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
  // (historical: the same transport the retired capsule's stop ask once used),
  // resolved lazily at send time. One sink for the whole module — the
  // composer never builds a parallel channel (A4).
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

  // Ticket 102b diagnostic — the session-lifecycle seats' console-only
  // tripwire. Contained must not mean SILENT: the seats are fire-and-forget
  // (the mirrors are the truth, never an optimistic flip), but before this
  // every failure mode of the ONE command egress vanished without a signal,
  // so an under-declared Cordis inject read exactly like a dead click. This
  // reports `executed` as the only silent outcome — `no-channel`,
  // `unresolved`, or a rejected transport all warn, once, in the browser
  // console. Deliberately NOT a UI surface: no state, no copy, no new result
  // kinds (ticket 102b's defect scope is the egress, not the presentation).
  const reportCommandFailure = (
    line: string,
    sessionId: string,
    outcome: unknown,
  ): void => {
    const kind =
      typeof outcome === "object" && outcome !== null
        ? (outcome as { readonly kind?: unknown }).kind
        : undefined;
    if (kind === "executed") return;
    console.warn(
      `[multitask-dispatcher] "${line}" in session ${sessionId} did not reach the host command channel`,
      outcome,
    );
  };

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
    // Ticket 101 (ADR-0021 decision 3) — the session-lifecycle seats, both
    // riding the ONE command transport (the composer's exact transaction,
    // `commands.execute(sessionId, line, [])` — never a second channel):
    // add = `/dispatcher-start` verbatim in the chosen session (the same
    // host command a typed line reaches there); delete = `/dispatcher-stop`
    // verbatim in that session (deactivates the binding through the host
    // dispose path; never disposes the chat). Outcomes are host-owned: the
    // command result copy is the surface, and the sidebar's dispatcher flags
    // follow the MIRRORS (the roster publish / clear), never an optimistic
    // flip — ADR-0010 honesty, honest mirror lag allowed. The seats are
    // fire-and-forget: a transport rejection is contained (nothing was
    // changed anywhere — the mirrors are the truth either way).
    //
    // Ticket 102b diagnostic: contained must not mean SILENT. Both seats
    // previously ended in `.catch(() => {})` and ignored the result kind, so
    // every failure mode of this egress — a throwing nested-face read (an
    // under-declared Cordis inject), `no-channel`, `unresolved` — vanished
    // with no signal, and the live symptom was indistinguishable from a dead
    // click. `reportCommandFailure` (above) is a console-only tripwire: no
    // UI, no copy, no state, no new result kinds.
    onAddDispatcherSession: (sessionId) => {
      void sendTransport
        .sendCommand(sessionId, DISPATCHER_START_LINE)
        .then((result) =>
          reportCommandFailure(DISPATCHER_START_LINE, sessionId, result),
        )
        .catch((error: unknown) =>
          reportCommandFailure(DISPATCHER_START_LINE, sessionId, error),
        );
    },
    onDeleteDispatcherSession: (sessionId) => {
      void sendTransport
        .sendCommand(sessionId, DISPATCHER_STOP_LINE)
        .then((result) =>
          reportCommandFailure(DISPATCHER_STOP_LINE, sessionId, result),
        )
        .catch((error: unknown) =>
          reportCommandFailure(DISPATCHER_STOP_LINE, sessionId, error),
        );
    },
    // Ticket 106 — the CLOSE seat: the sidebar rows' right-click context
    // menu sends the exact same line through the exact same ONE command
    // transport as the delete seat above (`/dispatcher-stop` verbatim, the
    // composer's transaction), with the same `reportCommandFailure`
    // tripwire. Nothing new here but the seat itself: no second transport,
    // no host-side change. After a confirmed stop the row re-renders as a
    // normal session only when the host's mirror clear arrives — never an
    // optimistic local flip (ADR-0010). The key says "close" (the
    // affordance's word) and stays clear of the pinned banned-verb scan.
    onCloseDispatcherSession: (sessionId) => {
      void sendTransport
        .sendCommand(sessionId, DISPATCHER_STOP_LINE)
        .then((result) =>
          reportCommandFailure(DISPATCHER_STOP_LINE, sessionId, result),
        )
        .catch((error: unknown) =>
          reportCommandFailure(DISPATCHER_STOP_LINE, sessionId, error),
        );
    },
  };

  return { store, seat, conversation, approvals: approvalsStore, hosts };
}
