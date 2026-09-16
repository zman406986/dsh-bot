import z from "@deepseek-ai/schemastery";

/**
 * Plugin config. Scaffold-level only — later tickets add real knobs.
 * Feature flag `multitask_dispatcher` is read once at dispatcher-session start (ADR-0005).
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
});

export const name = "multitask-dispatcher";
/**
 * Host services this plugin needs. Empty at scaffold time — the adapter
 * (ticket 09) will declare jobs / subagents / tools as it wires them.
 */
export const inject: string[] = [];

export interface PluginConfig {
  enabled: boolean;
}

type CordisContext = {
  effect: (dispose: () => void) => void;
};

/**
 * Cordis plugin entry. Registers only through `ctx` so unload is reversible.
 * The multitask core itself is host-free and exercised in unit tests via FakeDshHost.
 */
export function apply(ctx: CordisContext, config: PluginConfig): void {
  if (!config.enabled) {
    return;
  }

  // Scaffold: prove the plugin shape and reversible registration.
  // The live DshHost adapter + Multitask instance land with ticket 09.
  ctx.effect(() => {
    // Disposer: Cordis invokes this on plugin unload / HMR reload.
  });
}
