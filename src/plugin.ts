import z from "@deepseek-ai/schemastery";
import { createMultitask, type Multitask } from "./core/multitask.js";
import {
  bindDispatcherLifecycle,
  createCordisDshHost,
  createStorageDomainDurability,
  type AdapterContext,
  type CordisDshHost,
  type StorageDomainDurability,
} from "./adapter/index.js";

/**
 * Plugin config. Scaffold-level only — later tickets add real knobs.
 * Feature flag `multitask_dispatcher` is read once at dispatcher-session start (ADR-0005).
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
});

export const name = "multitask-dispatcher";
/**
 * Host services the adapter wires (ticket 09):
 * - subagents: spawn / interrupt / sendMessage / listChildren
 * - agents: live Agent registry (wake via followup)
 * - jobs: live job listing for the check surface
 * - storageDomain: durable worker markers (ADR-0006)
 */
export const inject: string[] = [
  "subagents",
  "agents",
  "jobs",
  "storageDomain",
];

export interface PluginConfig {
  enabled: boolean;
}

/**
 * Narrow Cordis context surface. Prefer a local interface over importing
 * full Cordis types until peerDeps grow.
 */
type CordisContext = AdapterContext & {
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

  const markers: StorageDomainDurability = createStorageDomainDurability(
    ctx.storageDomain,
  );
  const host: CordisDshHost = createCordisDshHost(ctx, { markers });
  const multitask: Multitask = createMultitask(host, { durability: markers });

  // Capture the live dispatcher Agent + bind session-id turn bounds to wakeBus.
  const lifecycle = bindDispatcherLifecycle(ctx, host, multitask);

  ctx.effect(() => () => {
    lifecycle.unbind();
    host.dispose();
    void markers.dispose();
  });
}
