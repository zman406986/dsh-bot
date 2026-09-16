/**
 * dsh client module entry (ticket 20).
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
 * `inject: ["slots", "locale", ...]`).
 *
 * The scaffold registers exactly two things, both benign (design-16 §5):
 * 1. the `multitask-dispatcher` locale namespace ({en, zh});
 * 2. one hello-world entry into the shipped `shell.overlay` list slot.
 */

import type { ClientContext } from "./context.js";
import {
  helloOverlayRegistration,
  LOCALE_NAMESPACE,
  localeDictionary,
  SHELL_OVERLAY_SLOT,
} from "./overlay.js";
import { createHelloPanel } from "./panel.js";

/** Client services this module binds (vendored Cordis inject list). */
export const inject: readonly string[] = ["slots", "locale"];

/**
 * Browser plugin entry. Every registration is an effect on this module's
 * fiber, so an unload/HMR swap reverses the namespace and the slot entry.
 */
export function apply(ctx: ClientContext): void {
  // Locale namespace (Finding 6 idiom): labeled effect; executes immediately,
  // the returned disposer is collected for unload.
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, localeDictionary),
    "multitask-dispatcher: locale dictionaries",
  );

  // Hello-world overlay entry (Finding 5 universal idiom): inject waits for
  // the shipped `shell.overlay` declaration, then registers on OUR fiber —
  // the entry never outlives the module.
  ctx.slots.inject(SHELL_OVERLAY_SLOT, () => {
    ctx.slots.register(
      helloOverlayRegistration(),
      createHelloPanel(ctx.locale.bind(LOCALE_NAMESPACE)),
    );
  });
}
