import z from "@deepseek-ai/schemastery";
import { createMultitask, type Multitask } from "./core/multitask.js";
import { projectRosterSnapshot } from "./core/roster-snapshot.js";
import {
  assemblePeerWakeTurn,
  assembleTurnReminder,
  assembleWakeTurn,
  noticeFromSettled,
  type WakeNotice,
} from "./core/policy/assembler.js";
import {
  accessExpiredNotice,
  assembleRestartNotice,
  bindDispatcherLifecycle,
  createAccessPromptPump,
  createCordisDshHost,
  createSettingsRosterChannel,
  createStorageDomainDurability,
  installMultitaskSettingsSection,
  isWildcardAccessTarget,
  registerDispatcherStartCommand,
  registerDispatcherSteerCommand,
  registerDispatcherTools,
  resolveExecSessionId,
  RESTART_DEGRADED_NOTICE,
  secretStoredAccessNotice,
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
 *         + dispatcher tool registration (T11, deferred to activation)
 * - commands: host slash-command registry for the activation command
 *         (ticket 19, ADR-0009)
 * - userQuestions: structured user-question seam for access-ask prompts
 *         (ticket 23, design-16 §4.4)
 */
export const inject: string[] = [
  "subagents",
  "agents",
  "jobs",
  "storageDomain",
  "tools",
  "commands",
  "userQuestions",
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
 *
 * `suppressPromptedAccessAsk` (ticket 23) filters asks that are currently
 * presented through the host prompt seam so an ask is never rendered both
 * ways at once (design-16 §4.4 dedupe; one presentation per ask at a time).
 */
function composeWakeText(
  multitask: Multitask,
  sessionId: string,
  suppressPromptedAccessAsk?: (requestId: string) => boolean,
): string | null {
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

  // Ticket 23 dedupe: an ask owned by the prompt seam is not re-rendered
  // conversationally mid-wait. Resolved-access notices are never filtered —
  // denials must reach the user through the shipped honest-reporting path.
  const accessRequests = (drained.wake.accessRequests ?? []).filter(
    (request) => suppressPromptedAccessAsk?.(request.requestId) !== true,
  );

  if (
    notices.length === 0 &&
    accessRequests.length === 0 &&
    (drained.wake.accessNotices ?? []).length === 0
  ) {
    return null;
  }

  const reminder = assembleTurnReminder(multitask.listTodos(sessionId));
  const wake = assembleWakeTurn(notices, {
    requests: accessRequests,
    resolved: drained.wake.accessNotices ?? [],
  });
  return `${reminder}\n\n${wake}`;
}

/**
 * Cordis plugin entry. Registers only through `ctx` so unload is reversible.
 * The multitask core itself is host-free and exercised in unit tests via FakeDshHost.
 *
 * Flag semantics (ADR-0005 / ticket 12) with the activation model
 * (ticket 19 / ADR-0009 / design-16 §3.7):
 * - `enabled` is copied once at apply entry and frozen for this session.
 * - Settings section is always installed so the user can flip the flag for
 *   the *next* session (no file hand-editing, no rebuild).
 * - Disabled path returns early: stock dsh — no core, no command, no tools,
 *   no policy, no wake handling.
 * - Enabled path boots dormant: stock experience plus the passive core/host
 *   plumbing and the `dispatcher-start` command. The five dispatcher tools
 *   and request_access register only when a session activates, and the
 *   primary chat is never captured on load.
 */
export function apply(ctx: CordisContext, config: PluginConfig): void {
  // ADR-0005: read once at session start; freeze for this session's lifetime.
  // Copy the primitive — do not hold a live reference into `config`.
  const enabled: boolean = Boolean(config.enabled);

  // Always install the settings section (design-12 §5.2 option A). Present
  // on both paths so OFF can be flipped back ON from the UI for next session.
  //
  // Roster mirror channel (ticket 21, design-16 §4.2): attaches to the
  // section's owner scope when the settings service appears; the activated
  // dispatcher's roster snapshot is mirrored into our namespace under the
  // `roster` key for the client panel to watch. Inert on the OFF path (no
  // core exists to project from).
  const rosterChannel = createSettingsRosterChannel();
  installMultitaskSettingsSection(ctx, Config, config, {
    onScope: (scope) => rosterChannel.attach(scope),
  });

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
      // Ticket 23: `accessPrompts` is declared below — this closure only
      // runs once wakes are delivered, never during apply.
      return composeWakeText(multitaskRef, sessionId, (requestId) =>
        accessPrompts.suppressesConversational(requestId),
      );
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
    // Ticket 21: mirror roster-affecting transitions into the settings
    // namespace. `lifecycle` is assigned below — the closure only runs once
    // activation exists, never during apply.
    onRosterChanged: (sessionId) => {
      if (lifecycle.dispatcherSessionId() === sessionId) {
        publishRosterSnapshot(sessionId);
      }
    },
  });
  multitaskRef = multitask;

  // Roster snapshot projection (tickets 21 + 27). Pure projection of the
  // core roster — never a second source of truth. The core observer fires on
  // every roster-affecting transition (including access-ask park/resolve and
  // todo delivery), gated to the activated dispatcher session; before
  // activation nothing is published (no dispatcher roster exists). On
  // deactivation publishing simply stops: the snapshot ages past the stale
  // window and the panel degrades to "unavailable" copy (design-16 §3.6 —
  // the panel shows state only while a live session exists). The v2
  // presence fields join existing core truth at publish time: pending
  // access asks (blocked, names only) and the ledger's delivered state.
  // Ticket 41 (v3): the deliverables line's `recentResult` joins at publish
  // time too — the adapter's own settle observation (`host.recentResult`,
  // clamped), never a core store. No new core state holds report text.
  const publishRosterSnapshot = (sessionId: string): void => {
    rosterChannel.publish(
      projectRosterSnapshot(sessionId, multitask.listWorkers(sessionId), Date.now(), {
        pendingAccess: multitask.listPendingAccess(sessionId),
        todos: multitask.listTodos(sessionId),
        recentResultOf: (workerId) => host.recentResult(workerId),
      }),
    );
  };

  // Access-request prompt pump (ticket 23, design-16 §4.4): surfaces the
  // core relay's pending asks through the host's EXISTING prompt seam
  // (`ctx.userQuestions.ask`) while a dispatcher session is activated, and
  // routes each explicit Allow/Deny answer into the UNCHANGED relay via
  // `Multitask.resolveAccess` — the same entry point a conversational
  // answer uses. The seam is optional: absent (or failed) prompts leave
  // the shipped conversational relay as the ask surface, and the relay's
  // deny-by-default timeout (ADR-0008) bounds every ask either way.
  // `lifecycle` is assigned below — the closures only run after apply,
  // never during it.
  const accessPrompts = createAccessPromptPump({
    ...(ctx.userQuestions !== undefined
      ? { userQuestions: ctx.userQuestions }
      : {}),
    isActive: () => lifecycle.dispatcherSessionId() !== null,
    getAgent: () => host.parentAgent ?? undefined,
    listPending: () => {
      const sessionId = lifecycle.dispatcherSessionId();
      if (sessionId === null) return [];
      return multitask.listPendingAccess(sessionId);
    },
    resolve: (workerId, decision) => multitask.resolveAccess(workerId, decision),
    // Ticket 30: "Always allow (this session)" inserts a session-scope allow
    // row (class + exact target) into the relay's existing policy table —
    // future matching asks auto-answer on the shipped policy no-op path.
    // Profile/preset writes are deliberately NOT plumbed (consent boundary).
    // Wildcard fence (ticket 30), last line: a session row is only ever
    // written for the exact target the human consented to. The prompt path
    // already degrades metacharacter targets, so a wildcard pattern reaching
    // this sink (constructed or queued always-allow) fails closed here
    // instead of remembering a whole class or prefix of targets.
    alwaysAllow: (ticket) => {
      if (isWildcardAccessTarget(ticket.body.target)) return;
      multitask.accessPolicy.set({
        class: ticket.body.class,
        targetPattern: ticket.body.target,
        decision: "allow",
        scope: "session",
      });
    },
    // Ticket 30: an answer for a ticket the relay already resolved (ADR-0008
    // timeout deny) surfaces honest expired copy on the next wake instead of
    // silence; the pump resolves nothing for it.
    notifyExpired: (ticket) => {
      multitask.wakeBus.enqueueAccessNotice({
        parentSessionId: ticket.parentSessionId,
        notice: accessExpiredNotice(
          ticket,
          multitask.getWorker(ticket.workerId)?.title ?? ticket.workerId,
        ),
      });
    },
    // Ticket 30: an allowed credential ask reports the names-never-values
    // reassurance as its post-decision notice.
    notifySecretStored: (ticket) => {
      multitask.wakeBus.enqueueAccessNotice({
        parentSessionId: ticket.parentSessionId,
        notice: secretStoredAccessNotice(
          ticket,
          multitask.getWorker(ticket.workerId)?.title ?? ticket.workerId,
        ),
      });
    },
    requeueConversational: (ticket) => {
      // Fallback presentation after a seam failure: the same wake-bus
      // enqueue the core relay uses for conversational asks.
      multitask.wakeBus.enqueueAccessRequest({
        parentSessionId: ticket.parentSessionId,
        workerId: ticket.workerId,
        requestId: ticket.requestId,
        title: multitask.getWorker(ticket.workerId)?.title ?? ticket.workerId,
        body: ticket.body,
      });
    },
  });

  // Activation lifecycle (ticket 19, ADR-0009): boot dormant and stock.
  // Nothing is captured on load or on agent/session-start — the dispatcher
  // exists in a chat only after the explicit dispatcher-start command fires
  // there (once per session, never toggled off while running).
  //
  // Deferred dispatcher tool surface: registered when a session activates,
  // unregistered when the activation ends (session disposed / unload).
  let activationTools: Array<() => void> = [];
  const activateToolSurface = (): void => {
    if (activationTools.length > 0) return;
    // T11: five dispatcher tools on ctx.tools (core handlers; adapter wraps
    // and gates execution on the activated session, design-16 §3.8).
    const toolDisposers = registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => lifecycle.dispatcherSessionId(),
      resolveCallerSessionId: resolveExecSessionId,
      // Ticket 29: live activity phrases for check rows, projected from the
      // host session/event firehose (host-observed truth; no polling).
      recentActivity: (workerId) => host.recentActivity(workerId),
    });
    // T13: worker-only request_access tool. Emits structured asks into the core.
    const disposeAccessTool = registerWorkerAccessTool({
      ctx,
      deps: {
        resolveWorkerId: (exec) => {
          // Structural: pull session id from common exec shapes.
          const sessionId = resolveExecSessionId(exec);
          if (sessionId === null) return null;
          return host.owns(sessionId) ? sessionId : null;
        },
        hasPendingAsk: (workerId) =>
          multitask.listPendingAccess().some((t) => t.workerId === workerId),
        emit: (event) => {
          host.emitAccessRequest(event);
        },
      },
    });
    activationTools = [...toolDisposers, disposeAccessTool];
  };
  const deactivateToolSurface = (): void => {
    for (const dispose of activationTools) {
      dispose();
    }
    activationTools = [];
  };

  // Passive status wiring (wake bounds, worker FSM, steer delivery) plus the
  // activate/deactivate hooks. Policy flag is session-scoped (ADR-0005); the
  // frozen `enabled` is the authority — policy is ON whenever we are here.
  // Ticket 31 (design-17 §4.7): restart honesty. The rebuild is async, so
  // activation completes immediately; the chain below lands the first roster
  // publish and the one-time restart notice once markers have been read.
  // Ordering is the acceptance rule: `rebuildFromDurability` runs BEFORE the
  // first `publishRosterSnapshot`, so restored terminal rows are in the very
  // first snapshot the panel sees, and landed-undelivered items flush on the
  // first wake (S4 across restart). Core rebuild semantics are frozen
  // (ADR-0006); this is adapter ordering only.
  const rebuildAndNotice = async (sessionId: string): Promise<void> => {
    let notice: string | null = null;
    try {
      notice = assembleRestartNotice(
        await multitask.rebuildFromDurability(sessionId),
      );
    } catch {
      // Marker store unreadable: activation still succeeds; the honest
      // degraded notice says nothing was restored or replayed.
      notice = RESTART_DEGRADED_NOTICE;
    }
    // The activation may have ended while markers were being read — never
    // publish or inject for a session that is no longer the dispatcher.
    if (lifecycle.dispatcherSessionId() !== sessionId) return;
    publishRosterSnapshot(sessionId);
    // Ticket 23: prompts sync stays after the first publish, as before.
    accessPrompts.sync();
    if (notice !== null) lifecycle.injectNotice(notice);
  };

  const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
    policyEnabled: enabled,
    onActivated: (sessionId) => {
      activateToolSurface();
      // Ticket 21: publish immediately on activation so the panel has a
      // fresh (possibly empty) snapshot without waiting for a transition.
      // Ticket 31: the publish now happens inside `rebuildAndNotice`, AFTER
      // the durability rebuild, so restored rows are in the first snapshot.
      void rebuildAndNotice(sessionId);
    },
    onDeactivated: () => {
      deactivateToolSurface();
      // Ticket 30: session-scope "always allow" rows belong to the activated
      // session — clear them here so no "always" leaks into a later session.
      multitask.clearSessionAccessPolicy();
      // Ticket 23: prompts belong to the activated session — abandon the
      // outstanding ones. Their tickets keep the armed relay timeouts
      // (ADR-0008 deny-by-default); nothing waits indefinitely.
      accessPrompts.reset();
    },
  });

  // The dormant plugin's only visible affordance (design-16 §3.3).
  const disposeCommand = registerDispatcherStartCommand({
    ctx,
    activeSessionId: () => lifecycle.dispatcherSessionId(),
    activate: (agent) => lifecycle.activate(agent),
  });
  ctx.effect(disposeCommand);

  // Steer input command (ticket 22, design-16 §4.3): same lifecycle pattern
  // as dispatcher-start — registered dormant, the handler gates on the
  // activated dispatcher session and routes into the existing core steer
  // queue path (`Multitask.steerWorker`, shared with the steer_worker tool).
  const disposeSteerCommand = registerDispatcherSteerCommand({
    ctx,
    activeSessionId: () => lifecycle.dispatcherSessionId(),
    steer: (workerId, message) => multitask.steerWorker(workerId, message),
  });
  ctx.effect(disposeSteerCommand);

  // Ticket 23: when the core parks a pending access ask, present it through
  // the prompt seam. The core's own onAccessRequest handler was registered
  // during createMultitask, so by the time this callback runs the relay has
  // already parked the ticket (or auto-answered it from stored policy, in
  // which case sync() is a no-op — no prompt for policy-answered asks).
  host.onAccessRequest(() => {
    accessPrompts.sync();
  });

  // Register a direct dispose callback (CordisContext.effect contract) so
  // unload/HMR truly reverses the activation: unbind, drop the tool surface,
  // dispose the host, release the marker domain.
  ctx.effect(() => {
    lifecycle.unbind();
    deactivateToolSurface();
    // Ticket 30: clear session-scope policy rows on unload/HMR too.
    multitask.clearSessionAccessPolicy();
    // Ticket 23: abandon outstanding prompts on unload/HMR; the relay
    // timeouts still deny their asks (ADR-0008).
    accessPrompts.reset();
    host.dispose();
    void markers.dispose();
  });
}
