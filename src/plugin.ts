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
  type AccessPromptPump,
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
 *
 * `effect` is the real Cordis effect seat (ticket 44, mirroring cordis 4.0.2
 * `Fiber.effect`): `execute` runs immediately at apply; a returned function —
 * or each value a generator function yields — is collected as the unload
 * disposer. It never takes a bare cleanup callback.
 */
type CordisContext = AdapterContext &
  SettingsInjectContext & {
    effect: (execute: () => unknown, label?: string) => unknown;
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
 *   plumbing and the `dispatcher-start` command. The six dispatcher tools
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
      // Ticket 23: `pumpFor` is declared below — this closure only runs once
      // wakes are delivered, never during apply.
      return composeWakeText(multitaskRef, sessionId, (requestId) =>
        pumpFor(sessionId).suppressesConversational(requestId),
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
    // Ticket 70 §2: the send_peer liveness fence is the activation truth —
    // a peer send to a session that is not a live dispatcher refuses with
    // `unknown-target` instead of acking into a phantom inbox. `lifecycle`
    // is assigned below; the closure only runs once sends happen, never
    // during apply (same pattern as onRosterChanged).
    isLiveDispatcherSession: (sessionId) =>
      lifecycle.isDispatcherSession(sessionId),
    // Ticket 21: mirror roster-affecting transitions into the settings
    // namespace. `lifecycle` is assigned below — the closure only runs once
    // activation exists, never during apply. ADR-0019: the gate is
    // per session — a transition publishes the CHANGED session's snapshot
    // whenever that session is an activated dispatcher (no single-active
    // slot); the snapshot itself carries its `dispatcherSessionId`.
    onRosterChanged: (sessionId) => {
      if (lifecycle.isDispatcherSession(sessionId)) {
        publishRosterSnapshot(sessionId);
      }
    },
  });
  multitaskRef = multitask;

  // Ticket 75: the ticket-29 firehose subscription already observes every
  // owned worker `tool/call`; route that observation into the core's existing
  // counter so `WorkerSummary.toolCallCount` advances in live wiring (it was
  // test-only before, structurally stuck at 0). Same subscription as the
  // activity phrase — no new seam, no polling.
  host.onWorkerToolCall((workerId) => multitask.noteToolCall(workerId));

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

  // Access-request prompt pumps (ticket 23, design-16 §4.4; ADR-0019
  // per-session): surfaces a dispatcher session's pending asks through the
  // host's EXISTING prompt seam (`ctx.userQuestions.ask`) while THAT session
  // is activated, and routes each explicit Allow/Deny answer into the
  // UNCHANGED relay via `Multitask.resolveAccess` — the same entry point a
  // conversational answer uses. One pump per activated dispatcher session:
  // its pending list, its agent, its suppression, and its reset are all
  // session-scoped, so deactivating session A never abandons session B's
  // outstanding prompts. The seam is optional: absent (or failed) prompts
  // leave the shipped conversational relay as the ask surface, and the
  // relay's deny-by-default timeout (ADR-0008) bounds every ask either way.
  const accessPumps = new Map<string, AccessPromptPump>();
  const pumpFor = (sessionId: string): AccessPromptPump => {
    let pump = accessPumps.get(sessionId);
    if (pump === undefined) {
      pump = createAccessPromptPump({
        ...(ctx.userQuestions !== undefined
          ? { userQuestions: ctx.userQuestions }
          : {}),
        isActive: () => lifecycle.isDispatcherSession(sessionId),
        getAgent: () => host.parentAgentOf(sessionId),
        listPending: () => multitask.listPendingAccess(sessionId),
        resolve: (workerId, decision) =>
          multitask.resolveAccess(workerId, decision),
        // Ticket 30: "Always allow (this session)" inserts a session-scope
        // allow row (class + exact target) attributed to the ASKING session
        // (ADR-0019 keying table) — future matching asks of that session
        // auto-answer on the shipped policy no-op path; a sibling
        // dispatcher's asks never do, and clearing the session's rows on
        // deactivation removes exactly this row. Profile/preset writes are
        // deliberately NOT plumbed (consent boundary). Wildcard fence
        // (ticket 30), last line: a session row is only ever written for
        // the exact target the human consented to. The prompt path already
        // degrades metacharacter targets, so a wildcard target reaching
        // this sink (constructed or queued always-allow) fails closed here
        // instead of remembering a whole class or prefix of targets.
        alwaysAllow: (ticket) => {
          if (isWildcardAccessTarget(ticket.body.target)) return;
          multitask.accessPolicy.set({
            class: ticket.body.class,
            targetPattern: ticket.body.target,
            decision: "allow",
            scope: "session",
            session: ticket.parentSessionId,
          });
        },
        // Ticket 30: an answer for a ticket the relay already resolved
        // (ADR-0008 timeout deny) surfaces honest expired copy on the next
        // wake instead of silence; the pump resolves nothing for it.
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
            title:
              multitask.getWorker(ticket.workerId)?.title ?? ticket.workerId,
            body: ticket.body,
          });
        },
      });
      accessPumps.set(sessionId, pump);
    }
    return pump;
  };

  // Activation lifecycle (ticket 19, ADR-0009; per session per ADR-0019):
  // boot dormant and stock. Nothing is captured on load or on
  // agent/session-start — the dispatcher exists in a chat only after the
  // explicit dispatcher-start command fires there (once per session, never
  // toggled off while running).
  //
  // Per-session dispatcher tool surface (ADR-0019 keying table): the five
  // tools register through the ACTIVATED AGENT'S OWN scoped context
  // (`agent.ctx.tools` — per-agent visibility, host-structural worker
  // exclusion), with disposers held per session; that session's
  // deactivation, session end, or our unload unregisters that session's set
  // (host-side auto-unregister is tolerated — disposers are idempotent).
  // `request_access` alone stays a GLOBAL registration (its callers are
  // workers in every session), reference-counted over active dispatcher
  // sessions: acquired at the first activation, released when the last one
  // ends.
  const sessionToolDisposers = new Map<string, Array<() => void>>();
  let globalAccessDisposer: (() => void) | null = null;
  let accessToolHolders = 0;

  const acquireGlobalAccessTool = (): void => {
    accessToolHolders += 1;
    if (globalAccessDisposer !== null) return;
    // T13: worker-only request_access tool. Emits structured asks into the
    // core. Registered on the plugin-level ctx — workers of every dispatcher
    // session resolve it through the global layer.
    globalAccessDisposer = registerWorkerAccessTool({
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
  };

  const releaseGlobalAccessTool = (): void => {
    if (accessToolHolders > 0) accessToolHolders -= 1;
    if (accessToolHolders > 0 || globalAccessDisposer === null) return;
    globalAccessDisposer();
    globalAccessDisposer = null;
  };

  const activateToolSurface = (sessionId: string): void => {
    if (sessionToolDisposers.has(sessionId)) return;
    const agent = host.parentAgentOf(sessionId);
    // Core handlers (adapter wraps; design-16 §3.8). ADR-0019: the closure
    // IS the session — every execution routes to the session that registered
    // the tool; visibility is the fence, not a refusal copy.
    const toolDeps = {
      multitask,
      getSessionId: () => sessionId,
      // Ticket 29: live activity phrases for check rows, projected from the
      // host session/event firehose (host-observed truth; no polling).
      recentActivity: (workerId: string) => host.recentActivity(workerId),
      // Ticket 61 (register A-8, ADR-0018 exception D22): the same
      // projection's observation moments, feeding the check-row liveness
      // verdict — visibility only, no watchdog, no polling.
      lastActivityAtMs: (workerId: string) => host.lastActivityAtMs(workerId),
    };
    // ADR-0019: register through the activated agent's own scoped context
    // (`agent.ctx.tools` — the host's per-agent scope seam). Agents without
    // a scoped context (stub hosts) fall back to the plugin-level global
    // registration — the shipped single-dispatcher shape, without the
    // per-agent visibility fence.
    const scopedTools = agent?.ctx?.tools;
    const disposers =
      scopedTools !== undefined && typeof scopedTools.register === "function"
        ? registerDispatcherTools({ ctx: { tools: scopedTools }, ...toolDeps })
        : registerDispatcherTools({ ctx, ...toolDeps });
    acquireGlobalAccessTool();
    sessionToolDisposers.set(sessionId, disposers);
  };

  const deactivateToolSurface = (sessionId: string): void => {
    const disposers = sessionToolDisposers.get(sessionId);
    if (disposers !== undefined) {
      // Tolerate already-inert disposers: the host's agent-scope undo may
      // have unregistered these first (session end / HMR) and is idempotent.
      for (const dispose of disposers) {
        dispose();
      }
      sessionToolDisposers.delete(sessionId);
    }
    releaseGlobalAccessTool();
  };

  const deactivateAllToolSurfaces = (): void => {
    for (const sessionId of [...sessionToolDisposers.keys()]) {
      deactivateToolSurface(sessionId);
    }
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
    // publish or inject for a session that is no longer an activated
    // dispatcher (ADR-0019: per-session liveness, not a single-active slot).
    if (!lifecycle.isDispatcherSession(sessionId)) return;
    publishRosterSnapshot(sessionId);
    // Ticket 23: prompts sync stays after the first publish, as before
    // (this session's pump only).
    pumpFor(sessionId).sync();
    if (notice !== null) {
      // Ticket 57 (D-4): route recovery through the WAKING primitive.
      // `injectNotice` only queues context; the reference re-wakes its parent
      // on boot so the notice is acted on without the user speaking first.
      // The trigger stays activation-driven (ADR-0009) — only the primitive
      // changes. A future boot hook (if ADR-0016 is signed) calls this same
      // method; item U-1 (is activation itself a deviation?) is not decided
      // here.
      lifecycle.wakeNotice(sessionId, notice);
    }
    // Ticket 58 (register D-5): activation is also a delivery opportunity.
    // A restored result that settled before the restart and was never
    // delivered gets a redrive turn — bounded, so it cannot become the
    // unbounded persistence this ticket exists to remove. Called
    // unconditionally: it is a cheap no-op when nothing is owed, and it is
    // also the pass that escalates an already-exhausted obligation to `lost`.
    multitask.redriveUndelivered(sessionId);
  };

  const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
    policyEnabled: enabled,
    onActivated: (sessionId) => {
      activateToolSurface(sessionId);
      // Ticket 21: publish immediately on activation so the panel has a
      // fresh (possibly empty) snapshot without waiting for a transition.
      // Ticket 31: the publish now happens inside `rebuildAndNotice`, AFTER
      // the durability rebuild, so restored rows are in the first snapshot.
      void rebuildAndNotice(sessionId);
    },
    // ADR-0019: exactly ONE session's surface, policy rows, and prompts end
    // here — a sibling dispatcher keeps its own.
    onDeactivated: (sessionId) => {
      deactivateToolSurface(sessionId);
      // Ticket 30: session-scope "always allow" rows belong to their session
      // — clear that session's rows here so no "always" leaks into a later
      // session (and never a sibling's).
      multitask.clearSessionAccessPolicy(sessionId);
      // Ticket 23: prompts belong to their session — abandon this session's
      // outstanding ones. Their tickets keep the armed relay timeouts
      // (ADR-0008 deny-by-default); nothing waits indefinitely.
      accessPumps.get(sessionId)?.reset();
      // Ticket 79: the session's roster mirror key goes too — the wrapper
      // sidebar reads `roster.<sessionId>` for the dispatcher flag, so a
      // deactivated session must not keep rendering as a live dispatcher.
      rosterChannel.clearSession(sessionId);
    },
  });

  // The dormant plugin's only visible affordance (design-16 §3.3).
  // Cordis effect contract (ticket 44): the generator effect registers now
  // and yields the register disposer as the unload cleanup — the shipped
  // `dsh-command-compact` idiom. Passing the disposer itself as `execute`
  // makes live cordis call it at once, silently unregistering the command.
  ctx.effect(function* () {
    yield registerDispatcherStartCommand({
      ctx,
      activeSessionId: () => lifecycle.dispatcherSessionId(),
      activate: (agent) => lifecycle.activate(agent),
    });
  }, "multitask-dispatcher: dispatcher-start command");

  // Steer input command (ticket 22, design-16 §4.3): same lifecycle pattern
  // as dispatcher-start — registered dormant, the handler gates on the
  // INVOKING chat's own dispatcher activation (ADR-0019: a set of active
  // sessions, not one slot) and routes into the existing core steer queue
  // path (`Multitask.steerWorker`, shared with the steer_worker tool).
  // Same generator-effect shape as dispatcher-start (ticket 44).
  ctx.effect(function* () {
    yield registerDispatcherSteerCommand({
      ctx,
      activeSessionIds: () => lifecycle.dispatcherSessionIds(),
      steer: (workerId, message) => multitask.steerWorker(workerId, message),
    });
  }, "multitask-dispatcher: dispatcher-steer command");

  // Ticket 23: when the core parks a pending access ask, present it through
  // the prompt seam. The core's own onAccessRequest handler was registered
  // during createMultitask, so by the time this callback runs the relay has
  // already parked the ticket (or auto-answered it from stored policy, in
  // which case sync() is a no-op — no prompt for policy-answered asks).
  // ADR-0019: each activated session's pump syncs its OWN pending asks.
  host.onAccessRequest(() => {
    for (const sessionId of lifecycle.dispatcherSessionIds()) {
      pumpFor(sessionId).sync();
    }
  });

  // Unload teardown (ticket 44): under the Cordis effect contract `execute`
  // runs at apply and must RETURN the cleanup. (The previous shape passed the
  // cleanup itself as `execute` — live cordis ran it at boot, silently
  // unregistering the command, unbinding the lifecycle, dropping the host
  // subscriptions, and disposing the marker domain before any session
  // existed, while collecting nothing for unload.)
  // With it, unload/HMR truly reverses every activation: unbind (which
  // deactivates EACH session — its tool surface, its policy rows, its
  // prompts), sweep any remainder, dispose the host, release the marker
  // domain.
  ctx.effect(
    () => () => {
      lifecycle.unbind();
      deactivateAllToolSurfaces();
      // Ticket 30 + ADR-0019: on unload every session-scope row goes —
      // no "always" can outlive the plugin that consented to it.
      multitask.clearSessionAccessPolicy();
      // Ticket 23: abandon any remaining outstanding prompts on unload/HMR;
      // the relay timeouts still deny their asks (ADR-0008).
      for (const pump of accessPumps.values()) {
        pump.reset();
      }
      // Ticket 79: no per-session roster mirror key outlives the plugin —
      // a stale `roster.<id>` would re-flag a dead session as a dispatcher
      // on the next enable.
      rosterChannel.clearAllSessions();
      host.dispose();
      void markers.dispose();
    },
    "multitask-dispatcher: plugin teardown",
  );
}
