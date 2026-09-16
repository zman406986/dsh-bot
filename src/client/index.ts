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
 * 3. the roster panel entry into the shipped `shell.overlay` list slot;
 * 4. the per-tool call views (ticket 24): keyed `tool.call.toolview` entries
 *    for the five dispatcher wire tool names — unclaimed keys, so additive-
 *    safe against the shipped composition (research Finding 5).
 */

import type { ClientContext } from "./context.js";
import {
  LOCALE_NAMESPACE,
  localeDictionary,
  SHELL_OVERLAY_SLOT,
  rosterOverlayRegistration,
} from "./overlay.js";
import { createRosterPanel } from "./panel.js";
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
  applyClientModule(ctx, createRosterStore());
}

/**
 * The module body, factored over an explicit store so offline tests can
 * drive the data path end to end (watch payload → store → view model)
 * without a DOM harness. Not a second entry point: `apply` is the only
 * thing the loader registers.
 */
export function applyClientModule(ctx: ClientContext, store: RosterStore): void {
  // Locale namespace (Finding 6 idiom): labeled effect; executes immediately,
  // the returned disposer is collected for unload.
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, localeDictionary),
    "multitask-dispatcher: locale dictionaries",
  );

  // Roster data path (ticket 21, design-16 §4.2 honest gap): watch the
  // plugin's settings namespace for the host-mirrored snapshot. The panel
  // degrades to "unavailable" copy when the service is missing or the feed
  // is stale — never against an unverified live push channel.
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
      });
    });
    return () => {
      if (disposeWatch !== undefined) disposeWatch();
    };
  }, "multitask-dispatcher: roster settings watch");

  // Roster overlay entry (Finding 5 universal idiom): inject waits for the
  // shipped `shell.overlay` declaration, then registers on OUR fiber —
  // the entry never outlives the module.
  ctx.slots.inject(SHELL_OVERLAY_SLOT, () => {
    ctx.slots.register(
      rosterOverlayRegistration(),
      createRosterPanel(ctx.locale.bind(LOCALE_NAMESPACE), store),
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
