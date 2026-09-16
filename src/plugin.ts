import z from "@deepseek-ai/schemastery";
import { createMultitask, type Multitask } from "./core/multitask.js";
import {
  assembleTurnReminder,
  assembleWakeTurn,
  noticeFromSettled,
  type WakeNotice,
} from "./core/policy/assembler.js";
import {
  bindDispatcherLifecycle,
  createCordisDshHost,
  createStorageDomainDurability,
  registerDispatcherTools,
  type AdapterContext,
  type CordisDshHost,
  type StorageDomainDurability,
} from "./adapter/index.js";
import { createWorkerAgentDef } from "./worker/agent-def.js";

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
 * - tools: global tool names for the worker deny-list intersection (T10)
 *         + dispatcher tool registration (T11)
 */
export const inject: string[] = [
  "subagents",
  "agents",
  "jobs",
  "storageDomain",
  "tools",
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
 * Compose the wake follow-up body: drain the ready wake (reconcile runs),
 * map settle notices, and include undelivered landed items whose report
 * text is only in the child transcript (T10 follow-up).
 */
function composeWakeText(multitask: Multitask, sessionId: string): string | null {
  const drained = multitask.drainWake(sessionId);
  if (drained === undefined) return null;

  const roster = multitask.listWorkers(sessionId);
  const byId = new Map(roster.map((row) => [row.workerId, row]));

  const notices: WakeNotice[] = drained.wake.settledWorkers.map((settled) => {
    const summary = byId.get(settled.workerId);
    const transcriptRef = summary?.transcriptRef ?? settled.workerId;
    // Restored markers carry no report text; the placeholder points at the
    // transcript so the dispatcher can fetch the full play-by-play.
    return noticeFromSettled(settled, transcriptRef);
  });

  // Landed-undelivered items from an earlier rebuild may not be in this
  // wake's settle list — surface them with a transcript pointer.
  const seen = new Set(notices.map((n) => n.workerId));
  for (const todo of drained.reconcile.landedUndelivered) {
    if (todo.workerId === null || seen.has(todo.workerId)) continue;
    const summary = byId.get(todo.workerId);
    if (summary === undefined) continue;
    if (summary.status !== "completed" && summary.status !== "error") continue;
    notices.push({
      workerId: todo.workerId,
      title: summary.title,
      status: summary.status,
      report: "",
      transcriptRef: summary.transcriptRef ?? todo.workerId,
    });
    seen.add(todo.workerId);
  }

  if (notices.length === 0) return null;

  const reminder = assembleTurnReminder(multitask.listTodos(sessionId));
  const wake = assembleWakeTurn(notices);
  return `${reminder}\n\n${wake}`;
}

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
  // T10: real worker agent type — self-contained prompt + tool barrier + leaf depth.
  let multitaskRef: Multitask | null = null;
  const host: CordisDshHost = createCordisDshHost(ctx, {
    markers,
    workerAgentDef: createWorkerAgentDef(),
    composeWakeText: (sessionId) => {
      if (multitaskRef === null) return null;
      return composeWakeText(multitaskRef, sessionId);
    },
  });
  const multitask: Multitask = createMultitask(host, { durability: markers });
  multitaskRef = multitask;

  // Capture the live dispatcher Agent + bind session-id turn bounds to wakeBus.
  // Policy flag is session-scoped (ADR-0005); plugin config.enabled already
  // gates apply, so the session flag is ON whenever we are here.
  const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
    policyEnabled: true,
  });

  // T11: five dispatcher tools on ctx.tools (core handlers; adapter wraps).
  const toolDisposers = registerDispatcherTools({
    ctx,
    multitask,
    getSessionId: () => lifecycle.dispatcherSessionId(),
  });
  for (const dispose of toolDisposers) {
    ctx.effect(dispose);
  }

  ctx.effect(() => () => {
    lifecycle.unbind();
    host.dispose();
    void markers.dispose();
  });
}
