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
 * binds — the shipped idiom (e.g. dsh-client-ui-agent-preset exports
 * `inject: ["slots", "locale", ...]`). The settings service is deliberately
 * NOT listed: it is optional, reached through the runtime `ctx.inject` idiom.
 *
 * What registers (design-16 §4.2/§5):
 * 1. the `multitask-dispatcher` locale namespace ({en, zh});
 * 2. the data path: a watch on our settings namespace, where the host half
 *    mirrors the roster snapshot under the `roster` key (the documented
 *    config-channel fallback — no invented push channel);
 * 3. the dispatcher capsule entry (ticket 38, ADR-0013) into the shipped
 *    `shell.overlay` list slot: collapsed chip → expandable panel, one
 *    entry, unchanged id (tickets 39–42 add the activation row, the wired
 *    intents, the deliverables line, and the provenance footer);
 * 4. the per-tool call views (ticket 24): keyed `tool.call.toolview` entries
 *    for the five dispatcher wire tool names — unclaimed keys, so additive-
 *    safe against the shipped composition (research Finding 5).
 *
 * Ticket 40 binds the capsule/panel intents to ticket 36's verified seams
 * at THIS composition point and nowhere else: the narrow CommandTransport
 * (start = the composer's exact `commands.execute` transaction with
 * `/dispatcher-start` verbatim; stop = the scope-addressed plain-prompt
 * sink with the locale-keyed conversational phrasing) and the per-row steer
 * prefill seat (`input.for(actx).setDraft`) are built here over lazy
 * service sources and closed into the capsule factory. The services are
 * read at send/click time, never declared as boot-time binds (ADR-0014's
 * smallest-set rule — same runtime-dynamic idiom as the settings watch), so
 * a runtime without them degrades to honest `no-channel`/copy-fallback UX
 * via `src/client/actions.ts`.
 */

import type { ClientContext } from "./context.js";
import {
  LOCALE_NAMESPACE,
  localeDictionary,
  SHELL_OVERLAY_SLOT,
  rosterOverlayRegistration,
} from "./overlay.js";
import {
  CAPSULE_STOP_MESSAGE_KEY,
  activationOutcomeCopyKey,
  bindCommandTransport,
  createCapsuleActionStatus,
  sendActivationIntent,
  tryPrefillSteer,
  type SteerPrefillOutcome,
} from "./actions.js";
import {
  createDispatcherCapsule
} from "./capsule.js";
import {
  createCapsuleFooterStore,
  createCapsuleStore,
  type CapsuleFooterStore,
  type CapsuleStore,
  type OnActivationIntent,
} from "./capsule-store.js";
import { createRosterStore, type RosterStore } from "./roster-store.js";
import { createToolviewComponent } from "./toolview-panel.js";
import {
  TOOLVIEW_TOOL_NAMES,
  TOOL_CALL_TOOLVIEW_SLOT,
  toolviewRegistration,
} from "./toolviews.js";

/** Client services this module binds (vendored Cordis inject list). */
export const inject: readonly string[] = ["slots", "locale"];

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
  );
}

/**
 * The module body, factored over explicit stores so offline tests can drive
 * the data path end to end (watch payload → store → view model) without a
 * DOM harness. Not a second entry point: `apply` is the only thing the
 * loader registers. The capsule store (ticket 38) is the entry's own
 * expansion state; the footer store (ticket 42) holds the persisted flag
 * provenance read from the SAME watch; defaulting either keeps older
 * callers working and gives a fresh fiber a collapsed capsule.
 */
export function applyClientModule(
  ctx: ClientContext,
  store: RosterStore,
  capsule: CapsuleStore = createCapsuleStore(),
  footer: CapsuleFooterStore = createCapsuleFooterStore(),
): void {
  // Locale namespace (Finding 6 idiom): labeled effect; executes immediately,
  // the returned disposer is collected for unload.
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, localeDictionary),
    "multitask-dispatcher: locale dictionaries",
  );

  // Roster data path (ticket 21, design-16 §4.2 honest gap): watch the
  // plugin's settings namespace for the host-mirrored snapshot. The panel
  // degrades to "unavailable" copy when the service is missing or the feed
  // is stale — never against an unverified live push channel. The SAME
  // watch payload feeds the ticket-42 footer store (persisted flag
  // provenance) — one channel, two honest readers, never a second source.
  ctx.effect(() => {
    let disposeWatch: (() => void) | undefined;
    if (typeof ctx.inject !== "function") {
      store.set({ kind: "channel-missing" });
      return () => {};
    }
    ctx.inject(["settings"], (child) => {
      const settings = child.settings;
      if (settings === undefined) {
        store.set({ kind: "channel-missing" });
        return;
      }
      disposeWatch = settings.watch(LOCALE_NAMESPACE, (value) => {
        store.applyChannelValue(value);
        footer.applyChannelValue(value);
      });
    });
    return () => {
      if (disposeWatch !== undefined) disposeWatch();
    };
  }, "multitask-dispatcher: roster settings watch");

  // Capsule overlay entry (ticket 38, ADR-0013; Finding 5 universal idiom):
  // inject waits for the shipped `shell.overlay` declaration, then registers
  // on OUR fiber — the entry never outlives the module. Still exactly ONE
  // entry with the unchanged id `multitask-dispatcher-roster`; only the
  // component changes (chip + expandable panel instead of the bare panel).
  ctx.slots.inject(SHELL_OVERLAY_SLOT, () => {
    const t = ctx.locale.bind(LOCALE_NAMESPACE);

    // Ticket 40: bind the intents to the verified seams at composition
    // time. The transport and the seats resolve the service faces lazily at
    // send/click time; unavailability settles into honest degrade outcomes
    // inside `actions.ts`, never into a crash or a fake success.
    const transport = bindCommandTransport({
      remote: () => ctx.remote,
      sessions: () => ctx.sessions,
    });
    const actionStatus = createCapsuleActionStatus();
    const currentSessionId = () => ctx.sessions?.list.getSnapshot().current;
    const onActivationIntent: OnActivationIntent = (intent) => {
      // Clear the previous notice at dispatch; a `sent` outcome stays
      // silent (no fake success — the roster feed is the success truth).
      actionStatus.set(null);
      const seat = ctx.locale.bind(LOCALE_NAMESPACE);
      void sendActivationIntent(
        transport,
        currentSessionId,
        intent,
        seat(CAPSULE_STOP_MESSAGE_KEY),
      ).then((outcome) => actionStatus.set(activationOutcomeCopyKey(outcome)));
    };
    const onRowSteer = (workerId: string): SteerPrefillOutcome =>
      tryPrefillSteer(
        {
          sessions: () => ctx.sessions,
          conversation: () => ctx.conversation,
        },
        workerId,
      );

    ctx.slots.register(
      rosterOverlayRegistration(),
      createDispatcherCapsule(
        t,
        store,
        capsule,
        onActivationIntent,
        actionStatus,
        onRowSteer,
        footer,
      ),
    );
  });

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
}
