import z from "@deepseek-ai/schemastery";
import { createMultitask, type Multitask } from "./core/multitask.js";
import {
  assemblePeerWakeTurn,
  assembleTurnReminder,
  assembleWakeTurn,
  noticeFromSettled,
  type WakeNotice,
} from "./core/policy/assembler.js";
import {
  bindDispatcherLifecycle,
  createCordisDshHost,
  createStorageDomainDurability,
  installMultitaskSettingsSection,
  registerDispatcherTools,
  type AdapterContext,
  type CordisDshHost,
  type SettingsInjectContext,
  type StorageDomainDurability,
} from "./adapter/index.js";
import { registerWorkerAccessTool } from "./adapter/worker-access-tool.js";
import { createWorkerAgentDef } from "./worker/agent-def.js";

/**
 * Plugin config (ADR-0005 / ticket 12).
 * Conceptual feature name `multitask_dispatcher`; on-disk key is `enabled`
 * inside the `multitask-dispatcher` plugin namespace. Default true because
 * stock isolation is the installation gate, not the flag default — the
 * multitask profile's insert row sets `enabled: true` explicitly.
 *
 * Read once at dispatcher-session start and frozen for that session's
 * lifetime. A settings change persists for the *next* session only.
 */
export const Config = z.object({
  /**
   * Feature flag `multitask_dispatcher` (ADR-0005).
   * Read once at dispatcher-session start and fixed for that session's lifetime.
   * A settings change persists for the *next* session; it is not live-applied.
   */
  enabled: z.boolean().default(true),
  /**
   * Unanswered access-ask timeout in ms (ticket 13).
   * Default deny after this wait. Tests inject a tiny value.
   */
  accessRequestTimeoutMs: z.number().default(120_000),
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
  accessRequestTimeoutMs?: number;
}

/**
 * Narrow Cordis context surface. Prefer a local interface over importing
 * full Cordis types until peerDeps grow. `settings` is optional so stub
 * contexts stay minimal; the live host injects it for the UI control.
 */
type CordisContext = AdapterContext &
  SettingsInjectContext & {
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

  // Peer hidden turn: dedicated other-assistant cue, never settle copy.
  if (
    drained.wake.source === "peer" &&
    (drained.wake.peerMessages ?? []).length > 0
  ) {
    return assemblePeerWakeTurn(drained.wake.peerMessages ?? []);
  }

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

  if (notices.length === 0 && (drained.wake.accessRequests ?? []).length === 0 && (drained.wake.accessNotices ?? []).length === 0) {
    return null;
  }

  const reminder = assembleTurnReminder(multitask.listTodos(sessionId));
  const wake = assembleWakeTurn(notices, {
    requests: drained.wake.accessRequests ?? [],
    resolved: drained.wake.accessNotices ?? [],
  });
  return `${reminder}\n\n${wake}`;
}

/**
 * Cordis plugin entry. Registers only through `ctx` so unload is reversible.
 * The multitask core itself is host-free and exercised in unit tests via FakeDshHost.
 *
 * Flag semantics (ADR-0005 / ticket 12):
 * - `enabled` is copied once at apply entry and frozen for this session.
 * - Settings section is always installed so the user can flip the flag for
 *   the *next* session (no file hand-editing, no rebuild).
 * - Disabled path returns early: stock dsh — no core, no tools, no policy,
 *   no wake handling.
 */
export function apply(ctx: CordisContext, config: PluginConfig): void {
  // ADR-0005: read once at session start; freeze for this session's lifetime.
  // Copy the primitive — do not hold a live reference into `config`.
  const enabled: boolean = Boolean(config.enabled);

  // Always install the settings section (design-12 §5.2 option A). Present
  // on both paths so OFF can be flipped back ON from the UI for next session.
  installMultitaskSettingsSection(ctx, Config, config);

  if (!enabled) {
    // Stock dsh behavior: no Multitask core, no dispatcher tools,
    // no policy, no wake handling, no worker agent type.
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
  const accessTimeoutMs =
    typeof config.accessRequestTimeoutMs === "number"
      ? config.accessRequestTimeoutMs
      : undefined;
  const multitask: Multitask = createMultitask(host, {
    durability: markers,
    ...(accessTimeoutMs !== undefined
      ? { access: { timeoutMs: accessTimeoutMs } }
      : {}),
  });
  multitaskRef = multitask;

  // Capture the live dispatcher Agent + bind session-id turn bounds to wakeBus.
  // Policy flag is session-scoped (ADR-0005); the frozen `enabled` is the
  // authority — policy is ON whenever we are here.
  const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
    policyEnabled: enabled,
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

  // T13: worker-only request_access tool. Emits structured asks into the core.
  const disposeAccessTool = registerWorkerAccessTool({
    ctx,
    deps: {
      resolveWorkerId: (exec) => {
        // Structural: pull session id from common exec shapes.
        const record = exec as {
          agent?: { session?: { id?: unknown } };
          session?: { id?: unknown };
          sessionId?: unknown;
        } | null | undefined;
        if (record == null || typeof record !== "object") return null;
        const raw =
          record.agent?.session?.id ??
          record.session?.id ??
          record.sessionId;
        if (raw === undefined || raw === null) return null;
        const workerId = String(raw);
        return host.owns(workerId) ? workerId : null;
      },
      hasPendingAsk: (workerId) =>
        multitask.listPendingAccess().some((t) => t.workerId === workerId),
      emit: (event) => {
        host.emitAccessRequest(event);
      },
    },
  });
  ctx.effect(disposeAccessTool);

  ctx.effect(() => () => {
    lifecycle.unbind();
    host.dispose();
    void markers.dispose();
  });
}
