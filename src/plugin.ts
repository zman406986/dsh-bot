import z from "@deepseek-ai/schemastery";
import { join, resolve } from "node:path";
import {
  createMultitask,
  type InboxJobResolution,
  type Multitask,
} from "./core/multitask.js";
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
  createDispatchApprovalSeam,
  createStorageDomainDurability,
  isWildcardAccessTarget,
  readInboxJobDiskState,
  registerDispatcherResolveCommand,
  registerDispatcherStartCommand,
  registerDispatcherSteerCommand,
  registerDispatcherTools,
  registerSessionKindProjection,
  registerMicrocompact,
  resolveExecSessionId,
  resolveInboxJobText,
  RESTART_DEGRADED_NOTICE,
  secretStoredAccessNotice,
  startInboxWatcher,
  writeInboxCancelled,
  writeInboxFailed,
  writeInboxReply,
  type DispatchApprovalFn,
  type InboxJobCheckpoint,
  type InboxJobDiskState,
  type InboxJobState,
  type InboxQueueEntry,
  type AccessPromptPump,
  type AdapterContext,
  type CordisDshHost,
  type DispatcherSpawnOptions,
  type SessionProjectionChildLike,
  type StorageDomainDurability,
  type TokenMeterLike,
} from "./adapter/index.js";
import { registerWorkerAccessTool, createPendingAskSettleWaiter } from "./adapter/worker-access-tool.js";
import type { WorkerActivityEntry } from "./adapter/cordis-dsh-host.js";
import { registerRacoons } from "./adapter/racoons.js";
import { clampActivity, clampReport } from "./core/report-clamp.js";
import { createWorkerLocalToolDefs } from "./core/tools.js";
import { createWorkerAgentDef } from "./worker/agent-def.js";

/**
 * Plugin config (ADR-0005 / ticket 12).
 * Conceptual feature name `multitask_dispatcher`; on-disk key is `enabled`
 * inside the `multitask-dispatcher` plugin namespace. Default true because
 * stock isolation is the installation gate, not the flag default — the
 * multitask profile's insert row sets `enabled: true` explicitly.
 *
 * Every field is `.volatile()`: 0.2.1 derives the settings form from this
 * schema and rejects any field that is not volatile, so an unmarked field is
 * invisible and unwritable. The host passes volatile fields as stable
 * references; `apply` reads each one ONCE and freezes it for the session.
 */
export const Config = z.object({
  /**
   * Feature flag `multitask_dispatcher` (ADR-0005).
   * Read once at dispatcher-session start and fixed for that session's lifetime.
   * A settings change persists for the *next* session; it is not live-applied.
   */
  enabled: z.boolean().default(true).volatile(),
  /**
   * Unanswered access-ask timeout in ms (ticket 13).
   * Default deny after this wait. Tests inject a tiny value.
   */
  accessRequestTimeoutMs: z.number().default(120_000).volatile(),
  /**
   * Ticket 108: idle-side wake coalescing window in ms. 0 (default) keeps
   * current semantics — every idle settle/peer wakes the dispatcher at once.
   * >0 batches rapid background wakes into one dispatcher turn per window;
   * user messages still preempt the window immediately. Read once at
   * dispatcher-session start like `enabled`.
   */
  wakeCoalesceWindowMs: z.number().min(0).default(0).volatile(),
  /**
   * Ticket 113 / ADR-0023: opt-in file inbox. When on and `inboxDir` is
   * non-empty, the adapter watches `<inboxDir>/queue.jsonl` plus per-job
   * dirs and presents each claimed job to the earliest-activated dispatcher
   * session as a wake. Off (default) starts nothing at all.
   *
   * Flat keys (not a nested `inbox` object) deliberately: the settings card
   * maps Config rows 1:1 to flat controls (pinned parity test), and the
   * settings service writes flat fields only. Read once at apply like
   * `enabled`.
   */
  inboxEnabled: z.boolean().default(false).volatile(),
  /**
   * RACOONS M1 context cleanup, merged from the racoons-integration lane.
   * Off by default. M1 scope: cap + append-mode seal; library config and
   * structured evidence still apply. In-memory ledger and blobs expire on unload.
   * No recall tool is registered. Independent of other opt-in flags.
   * Read once at apply like `enabled`.
   */
  racoonsEnabled: z.boolean().default(false).volatile(),
  /** Inbox root directory. Empty (default) disables intake even when enabled. */
  inboxDir: z.string().default("").volatile(),
  /**
   * Fallback rescan interval in ms (ADR-0023 decision 1: fs.watch plus an
   * interval). Clamped to the protocol floor of 1000 ms.
   */
  inboxRescanIntervalMs: z.number().min(1000).default(5000).volatile(),
  /**
   * Ticket 124 / ADR-0029: deterministic microcompact on activated dispatcher
   * sessions. When on, an `agent/pre-step` listener clears the CONTENT of old
   * tool results once measured usage crosses a fixed ratio of the advertised
   * window, keeps the newest few, and records the compaction boundary as the
   * success marker resume reads. No model call, no full compaction.
   *
   * Off by default: a pass rewrites the surface, which invalidates the
   * provider prefix cache from the oldest cleared node, and the ticket's live
   * verification has not run. Read once at apply like `enabled`; a change
   * lands in the next session.
   */
  microcompactEnabled: z.boolean().default(false).volatile(),
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
 * - approval: the host approval answerer (`ctx.approval`,
 *         `@deepseek-ai/dsh-user-approval`; adapter notes :220/:390) — the
 *         dispatch approval seam's live face (ticket 69 L3). Optional at
 *         runtime: the seam degrades to `unavailable` when the service is
 *         absent and the chunk-A gate refuses fail-closed.
 */
export const inject: string[] = [
  "subagents",
  "agents",
  "jobs",
  "storageDomain",
  "tools",
  "commands",
  "userQuestions",
  "approval",
];

export interface PluginConfig {
  /**
   * Volatile fields arrive from the host as stable references (schemastery
   * `.volatile()`); `apply` reads each once with `get()`. Optional so stub
   * contexts in tests can omit a field.
   */
  enabled: { get(): boolean };
  accessRequestTimeoutMs?: { get(): number | undefined };
  /** Opt-in RACOONS M1; in-memory ledger, independent of other flags. */
  racoonsEnabled?: { get(): boolean | undefined };
  /** Ticket 108: idle wake coalescing window in ms (0 = off). */
  wakeCoalesceWindowMs?: { get(): number | undefined };
  /** Ticket 113: opt-in file inbox (flat keys — see Config doc). */
  inboxEnabled?: { get(): boolean | undefined };
  /** Ticket 113: inbox root directory; empty disables intake. */
  inboxDir?: { get(): string | undefined };
  /** Ticket 113: fallback rescan interval in ms (min 1000). */
  inboxRescanIntervalMs?: { get(): number | undefined };
  /** Ticket 124: deterministic microcompact on dispatcher sessions. */
  microcompactEnabled?: { get(): boolean | undefined };
}

/**
 * Narrow Cordis context surface. Prefer a local interface over importing
 * full Cordis types until peerDeps grow.
 *
 * `effect` is the real Cordis effect seat (ticket 44, mirroring cordis 4.0.2
 * `Fiber.effect`): `execute` runs immediately at apply; a returned function —
 * or each value a generator function yields — is collected as the unload
 * disposer. It never takes a bare cleanup callback.
 */
type CordisContext = AdapterContext & {
  effect: (execute: () => unknown, label?: string) => unknown;
  /**
   * Optional-service injection (the host's contributor route for
   * `sessionProjections`, `dsh-session-projection/lib/types/index.d.ts:125-140`).
   * Optional so stub contexts in tests stay minimal; the projection is
   * skipped when the service is unavailable.
   */
  inject?: (
    services: readonly string[],
    callback: (child: SessionProjectionChildLike) => void,
  ) => unknown;
  /**
   * Ticket 124: guarded service read (cordis `ctx.get`, `lib/index.js:763`).
   * Used for `tokenMeter`, which lives on the host plane rather than in this
   * plugin's inject list. Optional so stub contexts stay minimal; an absent
   * getter means the microcompact pass declines with a stated reason.
   */
  get?: (name: string) => unknown;
};

/**
 * Ticket 69 (L3 offline half): the dispatch approval seam's live face as
 * THIS plugin wires it — `ctx.approval.request` (`@deepseek-ai/dsh-user-approval`,
 * adapter notes :220/:390) scoped to the activated dispatcher session's own
 * Agent (`host.parentAgentOf(sessionId)`; a UI answerer only answers for
 * agents it owns — the service's routing rule). Factored as an exported
 * builder so OFFLINE tests can drive the plugin's OWN construction chained
 * into the chunk-A spawn gate instead of a hand-built lookalike: the
 * shipped posture is EMPTY, so the plugin-level gate never fires without a
 * posture row, and no seeder ships (Q1 ruling / U-D) — this function is the
 * regression-visible surface for the wiring. The seam degrades every
 * failure (service absent, agent gone, throw, rogue outcome) to
 * `unavailable`; the chunk-A spawn gate refuses on anything but
 * `allowed-once`, so a gated dispatch with no live answerer refuses
 * honestly and the dispatcher re-plans — it cannot wedge the turn (design
 * §6 Q2's offline half). The ask is time-bounded with the relay's ADR-0008
 * deadline (`DEFAULT_ACCESS_TIMEOUT_MS`, `src/adapter/dispatch-approval.ts`
 * `timeoutMs`): a SILENT answerer (live pass 5 B-3, FINDING 3 — the
 * approval composer can ship without ever answering) also lands in
 * `unavailable` at the deadline, so the wedge FINDING 3 observed is
 * unreachable from this seam. Whether the shipped client approval composer
 * still answers under the wrapper's root frame stays the LIVE lane's
 * verification (L3).
 */
export function dispatchApprovalSeamFor(
  ctx: Pick<AdapterContext, "approval">,
  host: Pick<CordisDshHost, "parentAgentOf">,
  sessionId: string,
): DispatchApprovalFn {
  return createDispatchApprovalSeam({
    getApproval: () => ctx.approval,
    getAgent: () => host.parentAgentOf(sessionId),
  });
}

/**
 * Ticket 110: digest-side view of the host's bounded per-worker activity
 * ring (`CordisDshHost.recentActivities`) — newest-first entries. A narrow
 * structural type so offline tests can stub the provider without a host.
 */
type WakeActivitySource = (
  workerId: string,
  n: number,
) => readonly WorkerActivityEntry[];

/** Max activity phrases shown per worker in the wake digest (ticket 110). */
export const WAKE_DIGEST_ACTIVITY_COUNT = 3;

/** Heading of the wake digest's recent-activity section (ticket 110). */
export const WAKE_ACTIVITY_DIGEST_HEADING = "## Recent worker activity";

/** Heading of the wake turn's external inbox-jobs section (ticket 113). */
export const INBOX_JOBS_HEADING = "## Inbox jobs";

/**
 * Ticket 110: the "Recent worker activity" digest section for a wake turn.
 * Inline text only (U-F): for every worker referenced by the wake's settle
 * notices, up to {@link WAKE_DIGEST_ACTIVITY_COUNT} firehose-observed
 * phrases, newest-first, each re-clamped through the core activity clamp
 * (`clampActivity` — import, never a rewrite of stored state; the core
 * stores no report or activity text). Empty string when no referenced
 * worker has observed activity — the post-restart honest-amnesia case —
 * so the section is omitted entirely rather than rendered empty.
 *
 * Exported as the regression-visible surface for offline tests, mirroring
 * `dispatchApprovalSeamFor`'s rationale: the shipped wiring is exercised
 * through `composeWakeText`, and this helper is its digest half.
 */
export function assembleActivityDigest(
  notices: readonly WakeNotice[],
  recentActivities: WakeActivitySource,
): string {
  const lines: string[] = [];
  for (const notice of notices) {
    const entries = recentActivities(
      notice.workerId,
      WAKE_DIGEST_ACTIVITY_COUNT,
    );
    for (const entry of entries) {
      const phrase = clampActivity(entry.phrase);
      if (phrase !== null) {
        lines.push(`- ${notice.workerId} · ${phrase}`);
      }
    }
  }
  if (lines.length === 0) return "";
  return [WAKE_ACTIVITY_DIGEST_HEADING, "", ...lines].join("\n");
}

/**
 * Compose the wake follow-up body: drain the ready wake (reconcile runs),
 * map settle notices, and include undelivered landed items whose report
 * text is only in the child transcript (T10 follow-up).
 *
 * `suppressPromptedAccessAsk` (ticket 23) filters asks that are currently
 * presented through the host prompt seam so an ask is never rendered both
 * ways at once (design-16 §4.4 dedupe; one presentation per ask at a time).
 *
 * `recentActivities` (ticket 110) appends the inline "Recent worker
 * activity" digest for the workers referenced by the wake's settle
 * notices — the wake turn stays self-contained (D21): the digest lives in
 * the wake text itself, with no storage writes and no prompt-side
 * references to stored outputs.
 *
 * Exported for offline tests (see `dispatchApprovalSeamFor`): the shipped
 * caller is the `composeWakeText` option wired into `createCordisDshHost`
 * in `apply` below.
 */
export function composeWakeText(
  multitask: Multitask,
  sessionId: string,
  suppressPromptedAccessAsk?: (requestId: string) => boolean,
  recentActivities?: WakeActivitySource,
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

  // Ticket 113: drained external (inbox) jobs render as inline sections —
  // job id plus the prompt clamped through the core report clamp (D21:
  // the wake turn is self-contained, inline text only, no stored text and
  // no file pointers). The peer-wake early-return above is untouched:
  // external jobs ride normal and background wakes only.
  const externalJobs = drained.wake.externalJobs ?? [];

  if (
    notices.length === 0 &&
    accessRequests.length === 0 &&
    (drained.wake.accessNotices ?? []).length === 0 &&
    externalJobs.length === 0
  ) {
    return null;
  }

  const reminder = assembleTurnReminder(multitask.listTodos(sessionId));
  const wake = assembleWakeTurn(notices, {
    requests: accessRequests,
    resolved: drained.wake.accessNotices ?? [],
  });
  const inboxSection =
    externalJobs.length > 0
      ? [
          INBOX_JOBS_HEADING,
          "",
          ...externalJobs.map(
            (job) =>
              `### Inbox job ${job.jobId}\n${clampReport(job.promptText)}`,
          ),
        ].join("\n")
      : "";
  const body = inboxSection.length > 0
    ? `${reminder}\n\n${wake}\n\n${inboxSection}`
    : `${reminder}\n\n${wake}`;
  // Ticket 110: the digest rides the wake turn itself — inline text,
  // appended after the wake body, and only when at least one referenced
  // worker has observed activity (empty rings contribute no lines).
  const digest =
    recentActivities !== undefined
      ? assembleActivityDigest(notices, recentActivities)
      : "";
  return digest.length > 0 ? `${body}\n\n${digest}` : body;
}

/**
 * Cordis plugin entry. Registers only through `ctx` so unload is reversible.
 * The multitask core itself is host-free and exercised in unit tests via FakeDshHost.
 *
 * Flag semantics (ADR-0005 / ticket 12) with the activation model
 * (ticket 19 / ADR-0009 / design-16 §3.7):
 * - `enabled` is a volatile config reference; it is read once at apply entry
 *   and frozen for this session.
 * - The settings form is the plugin's own Config schema, keyed by the
 *   `multitask-dispatcher` Loader row id; the user flips the flag for the
 *   *next* session from that form (no file hand-editing, no rebuild).
 * - Disabled path returns early: stock dsh — no core, no command, no tools,
 *   no policy, no wake handling.
 * - Enabled path boots dormant: stock experience plus the passive core/host
 *   plumbing and the `dsh-bot` command (renamed from `dispatcher-start` by
 *   ADR-0030, 2026-10-21). The six dispatcher tools
 *   and request_access register only when a session activates, and the
 *   primary chat is never captured on load.
 */
export function apply(ctx: CordisContext, config: PluginConfig): void {
  // ADR-0005: read the volatile reference once at apply; freeze for this
  // session's lifetime. Copy the primitive — do not hold a live reference.
  const enabled: boolean = Boolean(config.enabled.get());

  if (!enabled) {
    // Stock dsh behavior: no Multitask core, no dispatcher tools,
    // no policy, no wake handling, no worker agent type.
    return;
  }

  // Ticket 123: the session-kind projection — the durable host-side marker
  // the client reads as `projectionValues.sessionKind`. It folds the host's
  // OWN declared command log (`command/run` + `command/done` for
  // `/dsh-bot`; dsh-commands `lib/index.js:334/:341`), so nothing is
  // appended by us and no event kind is invented. `/dispatcher-stop` is
  // withdrawn (ADR-0030, ticket 129 removed the command) — the projection
  // still matches the legacy literal so persisted pre-rename logs keep
  // marking their sessions. Per-session by construction: the pair lands in
  // the invoking session's log only (ADR-0019). Registration is an effect
  // on the calling fiber, so unloading this plugin removes the key.
  registerSessionKindProjection(ctx);

  const markers: StorageDomainDurability = createStorageDomainDurability(
    ctx.storageDomain,
  );

  // ── Ticket 113 / ADR-0023: opt-in file inbox ──────────────────────────
  // Flat config keys (see Config doc — settings-card parity pin). The
  // watcher is the only fs dependency and lives in the adapter; the core
  // never sees a filesystem (ADR-0023 consequence 1).
  const inboxEnabled = config.inboxEnabled?.get() === true;
  const rawInboxDir = config.inboxDir?.get();
  const inboxRoot =
    typeof rawInboxDir === "string" && rawInboxDir.trim().length > 0
      ? resolve(rawInboxDir.trim())
      : "";
  // Defensive floor — the schema enforces min 1000; apply never trusts it.
  const rawRescan = config.inboxRescanIntervalMs?.get();
  const inboxRescanIntervalMs =
    typeof rawRescan === "number" && Number.isFinite(rawRescan)
      ? Math.max(1000, rawRescan)
      : 5000;

  /**
   * Honest error sink for inbox intake/checkpoint problems (malformed queue
   * lines, failed claims, failed writes). The plugin has no logger seam, so
   * `console.warn` is the shipped channel. Never fatal — intake outlives
   * every individual failure.
   */
  const inboxError = (error: unknown, context: string): void => {
    try {
      console.warn(`[multitask-dispatcher] inbox ${context}:`, error);
    } catch {
      // A broken console must never break intake.
    }
  };

  /**
   * The `onInboxJobResolved` hook — the reply writer (ticket 113). The core
   * fires it from terminal paths: delivery (`markDelivered`) → replied,
   * worker error → failed, abort → cancelled. This writes the job-dir files
   * (reply.md + status.json on replied; status.json only otherwise — a
   * non-empty reply.md IS the done signal) and closes the checkpoint row.
   * One immediate retry on write failure; persistent failure leaves the
   * checkpoint non-terminal so the boot rescan re-presents the job (the
   * redrive-safe retry the ticket allows — documented: the job may then
   * re-run, because the external system never saw a reply). Hook failures
   * never crash the settle path: the core swallows synchronous throws and
   * every async rejection lands in `inboxError`.
   *
   * Intentionally NOT gated on `inboxEnabled`: a job taken while the inbox
   * was on is finished even if intake is off by the time it resolves (the
   * job dir comes from the todo's own origin, not from current config).
   */
  const writeInboxResolution = (resolution: InboxJobResolution): void => {
    void (async () => {
      const checkpoint: InboxJobCheckpoint | undefined = await markers.inbox
        .get(resolution.jobId)
        .catch(() => undefined);
      const startedAtMs =
        checkpoint?.presentedAtMs ?? checkpoint?.claimedAtMs ?? null;
      const dir =
        resolution.jobDir.length > 0
          ? resolution.jobDir
          : join(inboxRoot, resolution.jobId);
      const write = async (): Promise<void> => {
        const nowMs = Date.now();
        if (resolution.kind === "replied") {
          await writeInboxReply(
            dir,
            resolution.jobId,
            resolution.replyText,
            startedAtMs,
            nowMs,
          );
        } else if (resolution.kind === "failed") {
          await writeInboxFailed(
            dir,
            resolution.jobId,
            resolution.error,
            startedAtMs,
            nowMs,
          );
        } else {
          await writeInboxCancelled(
            dir,
            resolution.jobId,
            resolution.reason,
            startedAtMs,
            nowMs,
          );
        }
      };
      try {
        await write();
      } catch (first) {
        try {
          await write();
        } catch (second) {
          inboxError(
            [first, second],
            `reply write ${resolution.jobId} (${resolution.kind}); the boot rescan will retry`,
          );
          return;
        }
      }
      await markers.inbox
        .record({
          jobId: resolution.jobId,
          state: resolution.kind,
          jobDir: dir,
          sessionId: resolution.sessionId,
          todoId: resolution.todoId,
          claimedAtMs: checkpoint?.claimedAtMs ?? startedAtMs ?? Date.now(),
          presentedAtMs: checkpoint?.presentedAtMs ?? startedAtMs,
          endedAtMs: Date.now(),
          presentAttempts: checkpoint?.presentAttempts ?? 1,
        })
        .catch((error) =>
          inboxError(error, `checkpoint terminal ${resolution.jobId}`),
        );
    })().catch((error) => inboxError(error, `resolution ${resolution.jobId}`));
  };

  // T10: real worker agent type — preset id + contract text + leaf depth.
  let multitaskRef: Multitask | null = null;
  const host: CordisDshHost = createCordisDshHost(ctx, {
    markers,
    workerAgentDef: createWorkerAgentDef(),
    composeWakeText: (sessionId) => {
      if (multitaskRef === null) return null;
      // Ticket 23: `pumpFor` is declared below — this closure only runs once
      // wakes are delivered, never during apply. Ticket 110: `host` is read
      // under the same rule — the binding is initialized by the very call
      // this closure is passed to, and the first invocation happens at wake
      // delivery, long after apply has returned, so the closure never sees
      // the uninitialized binding.
      return composeWakeText(
        multitaskRef,
        sessionId,
        (requestId) =>
          pumpFor(sessionId).suppressesConversational(requestId),
        (workerId, n) => host.recentActivities(workerId, n),
      );
    },
    // Ticket 122: the child's mid-task reply channel. Registered on the
    // child's own scope at `agent/created`, so the dispatcher's surface never
    // lists it. `multitaskRef` is initialized by the time a child exists.
    workerLocalTools: () => {
      if (multitaskRef === null) return [];
      return createWorkerLocalToolDefs({
        multitask: multitaskRef,
        // Same resolution as the worker access tool: the exec session id IS
        // the worker id once this host owns it. The reply addresses
        // `getWorker(workerId).parentSessionId` — never a tool argument.
        resolveWorkerId: (exec) => {
          const sessionId = resolveExecSessionId(exec);
          if (sessionId === null) return null;
          return host.owns(sessionId) ? sessionId : null;
        },
      });
    },
    // Ticket 118 chunk 3 / ADR-0025: the spawned-dispatcher activation path.
    // The host fires this once per successful `spawnDispatcher` — from the
    // child's `agent/created` (before its first turn), or from `ctx.agents`
    // after the spawn resolves when the host announced nothing. It routes
    // into the SAME lifecycle map as a command activation, minus the
    // top-level gate: the child is a subagent by construction. `lifecycle` is
    // assigned below; this closure only runs once a spawn happens, never
    // during apply (same rule as `pumpFor`).
    onDispatcherSpawned: (agent, sessionId, generation) => {
      lifecycle.activateSpawnedDispatcher(agent, sessionId, generation);
    },
    // Ticket 141: a spawn from a CHILD must read that child's generation, not
    // assume the spawner is a user-started generation 1. `lifecycle` is
    // assigned below; this closure only runs when a spawn happens, never
    // during apply (same deferred-closure rule as `pumpFor`).
    dispatcherGenerationOf: (sessionId) =>
      lifecycle.dispatcherGeneration(sessionId),
    // Ticket 142 (owner ruling 2026-10-22 — children half): the host adopted a
    // worker session it re-created. Resolve the ticket-59 unknown-state hold
    // into a live roster record so the worker is visible and stoppable again.
    // A throwing hook is swallowed inside the host.
    onWorkerReattached: (workerId, parentSessionId) => {
      multitaskRef?.reclaimWorker(workerId, parentSessionId);
    },
  });
  const accessTimeoutMs = config.accessRequestTimeoutMs?.get();
  // Ticket 108: clamped defensively here too — the schema enforces min 0,
  // but apply() must never trust raw config for a window that arms timers.
  const rawWakeCoalesce = config.wakeCoalesceWindowMs?.get();
  const wakeCoalesceWindowMs =
    typeof rawWakeCoalesce === "number" && Number.isFinite(rawWakeCoalesce)
      ? Math.max(0, rawWakeCoalesce)
      : 0;
  const multitask: Multitask = createMultitask(host, {
    durability: markers,
    ...(accessTimeoutMs !== undefined
      ? { access: { timeoutMs: accessTimeoutMs } }
      : {}),
    // Ticket 108: the coalescing window is opt-in — omitted entirely at the
    // default so the bus keeps pre-108 semantics byte-for-byte.
    ...(wakeCoalesceWindowMs > 0
      ? { wake: { coalesceWindowMs: wakeCoalesceWindowMs } }
      : {}),
    // Ticket 70 §2: the send_peer liveness fence is the activation truth —
    // a peer send to a session that is not a live dispatcher refuses with
    // `unknown-target` instead of acking into a phantom inbox. `lifecycle`
    // is assigned below; the closure only runs once sends happen, never
    // during apply.
    isLiveDispatcherSession: (sessionId) =>
      lifecycle.isDispatcherSession(sessionId),
    // Ticket 138 (owner ruling 2026-10-22): the DURABLE half of the same
    // fence. A target this plugin spawned as a dispatcher in an earlier
    // process carries a `dispatcher_sessions` mark, so a send to it is
    // ACCEPTED instead of refused — the adapter's wake path then cold-resumes
    // it (`ctx.subagents.sendMessage`) and delivers the parked turn on
    // activation. A target with no mark still refuses `unknown-target`
    // (ticket 70 §2's fence is intact). Synchronous on purpose: the host
    // keeps a warm mirror of the mark table (warmed on each dispatcher
    // activation, extended on every in-process write), so the fence never
    // awaits a store read.
    isDurablyMarkedDispatcher: (sessionId) =>
      host.isDurablyMarkedDispatcher(sessionId),
    // Ticket 142 (owner ruling 2026-10-22 — the CHILDREN half of "bots should
    // be wake-able"): the durable WORKER wake identity, from the host's warm
    // mirror of the `worker_sessions` table. A steer aimed at an id with no
    // roster record is still accepted when this answers — the worker is
    // dormant, not unknown — and the host's `wakeDormantWorker` cold-resumes
    // it. An id with no row keeps the shipped `unknown-worker` refusal.
    findDurableWorker: (workerId) => host.workerSessionMark(workerId),
    // Ticket 115: the await-timeout liveness probe. Worker ids ARE dsh
    // subagent session ids, and `ctx.agents` is the same live-agent registry
    // the host's wake path already resolves (`requestDispatcherWakeup`,
    // cordis-dsh-host.ts). Consulted once, at the timeout, only when no
    // settle record exists — never on a timer.
    isAgentAlive: (workerId) => ctx.agents.get(workerId) !== undefined,
    // Ticket 113: the reply writer — the core decides WHEN (terminal paths),
    // this owns HOW (job-dir files; the core never touches the filesystem).
    onInboxJobResolved: writeInboxResolution,
  });
  multitaskRef = multitask;

  // Ticket 75: the ticket-29 firehose subscription already observes every
  // owned worker `tool/call`; route that observation into the core's existing
  // counter so `WorkerSummary.toolCallCount` advances in live wiring (it was
  // test-only before, structurally stuck at 0). Same subscription as the
  // activity phrase — no new seam, no polling.
  host.onWorkerToolCall((workerId) => multitask.noteToolCall(workerId));

  // Ticket 117: the user-message early release. The host's existing
  // `session/event` subscription now reports STRUCTURED user prompts (a
  // `UserMessage` whose `source.kind === "user"`, on either the inbox splice
  // the host commits synchronously inside `Agent.send`/`followup`/`steer` or
  // the `user/message` committed at a turn's pre-step); text is never read.
  // A release here means the user spoke while a dispatcher turn sits inside
  // `await_agent` — the wait ends `released` / `user-message` instead of
  // holding the chat for up to 120 s. `releaseWaits` is a no-op for a session
  // with no waiters, so every dispatcher session's events can flow through
  // unconditionally; the core scopes the release to the watching session.
  host.onDispatcherUserMessage((sessionId) => {
    multitask.releaseWaits(sessionId, "user-message");
  });

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
  // explicit dsh-bot command fires there (once per session, never
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
  /**
   * Ticket 118 chunk 3: sessions that actually ACQUIRED the global
   * `request_access` tool. The refcount is shared, so the release side must be
   * paired with a real acquisition: a registration that threw before
   * `acquireGlobalAccessTool()` leaves this session out of the holder set, and
   * its later deactivation must not decrement somebody else's hold. In the
   * success path the session is always in the set, so deactivation behaves
   * exactly as before.
   */
  const accessToolHoldersBySession = new Set<string>();
  let globalAccessDisposer: (() => void) | null = null;
  let accessToolHolders = 0;

  const acquireGlobalAccessTool = (): void => {
    accessToolHolders += 1;
    if (globalAccessDisposer !== null) return;
    // The relay's pending-set read, shared by the duplicate-ask refusal and
    // the FINDING 4 settle waiter below — one truth, one lambda.
    const pendingAskOf = (workerId: string): boolean =>
      multitask.listPendingAccess().some((t) => t.workerId === workerId);
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
        hasPendingAsk: pendingAskOf,
        emit: (event) => {
          host.emitAccessRequest(event);
        },
        // Ticket 69 (live FINDING 4, ticket 33 Session B-4): the ask parks
        // the TOOL call, not the turn-end — execute stays pending while the
        // ask sits in the relay, so the worker's turn cannot finish and dsh
        // settlement cannot mark the worker completed+delivered while a
        // decision is owed (the core's settle path drops a pending ticket,
        // which is exactly how the live ask was lost). The wait is bounded
        // by core truth: the relay ends every ticket (explicit resolve, the
        // armed ADR-0008 timeout deny, or a stop/settle clear), so the tool
        // always settles honestly and can never out-wait its own park.
        awaitSettled: createPendingAskSettleWaiter({
          isPending: pendingAskOf,
        }),
      },
    });
  };

  const releaseGlobalAccessTool = (): void => {
    if (accessToolHolders > 0) accessToolHolders -= 1;
    if (accessToolHolders > 0 || globalAccessDisposer === null) return;
    globalAccessDisposer();
    globalAccessDisposer = null;
  };

  /**
   * Ticket 118 chunk 3: release only a hold THIS session actually took. A
   * registration that threw on the scoped surface never reached
   * `acquireGlobalAccessTool`, and decrementing anyway would drop a sibling
   * dispatcher's `request_access` while it is still live.
   */
  const releaseGlobalAccessToolForSession = (sessionId: string): void => {
    if (!accessToolHoldersBySession.delete(sessionId)) return;
    releaseGlobalAccessTool();
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
      // Ticket 69 (L3 offline half): the dispatch approval seam's live
      // face, built by `dispatchApprovalSeamFor` over the injected
      // `ctx.approval` and THIS session's activated Agent (its doc comment
      // carries the contract and the L3 remainder).
      requestDispatchApproval: dispatchApprovalSeamFor(ctx, host, sessionId),
      // Ticket 118 / ADR-0025 mitosis: the host's dispatcher-spawn seam —
      // what `spawn_dispatcher` calls. Without it the registered tool THROWS
      // at execute (a missing seam is a wiring bug, never a host refusal).
      // The parent is the closure's session id; the host resolves its bound
      // Agent and applies the depth ceiling (parent depth + 2).
      spawnDispatcher: (opts: DispatcherSpawnOptions) =>
        host.spawnDispatcher(opts),
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
    accessToolHoldersBySession.add(sessionId);
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
    releaseGlobalAccessToolForSession(sessionId);
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
  // activation completes immediately; the chain below lands the one-time
  // restart notice and the delivery redrive once markers have been read.
  // Ordering is the acceptance rule: `rebuildFromDurability` runs first, and
  // landed-undelivered items flush on the first wake (S4 across restart).
  // Core rebuild semantics are frozen (ADR-0006); this is adapter ordering
  // only.
  const rebuildAndNotice = async (sessionId: string): Promise<void> => {
    // Ticket 90 (F2): the chain acts for the activation it started under.
    // Captured before the first await; `onActivated` guarantees a live one.
    const activation = lifecycle.activationGeneration(sessionId);
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
    // inject or redrive for a session that is no longer an activated
    // dispatcher (ADR-0019: per-session liveness, not a single-active slot).
    // Ticket 90 (F2): the comparison is the ACTIVATION GENERATION, not the
    // session id. `isDispatcherSession` is set membership, so a chain from
    // activation #1 resuming after a deactivate → re-activate of the SAME
    // id would pass it and act for activation #2 — a second redrive attempt
    // against the persisted D-5 budget. The generation is null once its
    // activation ends, so this single compare covers the deactivation and
    // the stale-chain window alike.
    if (
      activation === null ||
      lifecycle.activationGeneration(sessionId) !== activation
    ) {
      return;
    }
    // Ticket 23: prompts sync runs once the rebuild has landed.
    pumpFor(sessionId).sync();
    // Ticket 138: warm the durable mark mirror for this activation. It runs
    // HERE — after the rebuild's marker read and behind the generation guard
    // — so it can never consume a build-time marker read that ticket 90
    // deliberately parks, and a chain that ends mid-read warms nothing. A
    // send can only exist once a dispatcher turn is open, which is after this
    // chain starts, so the fence always sees the warmed mirror. A read
    // failure is swallowed inside the host: an empty mirror means unmarked
    // targets refuse exactly as before 138 (fail-closed, never a phantom
    // accept), and marks written in THIS process are already in the mirror.
    void host.refreshDispatcherMarks();
    // Ticket 142: and the WORKER wake mirror beside it, under the same guard
    // and for the same reasons. A read failure is swallowed inside the host:
    // an empty mirror means an unmarked id refuses exactly as before 142, and
    // rows written in THIS process are already in the mirror.
    void host.refreshWorkerSessionMarks();
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
    // Ticket 113: activation is also the inbox re-presentation opportunity.
    // Claimed-but-unpresented jobs (no dispatcher was live) and crash
    // orphans route to the earliest live session — idempotent (core
    // dedupe by jobId; a still-live owner is never stolen). No-op when
    // the inbox is off or was never on for this install.
    if (inboxEnabled && inboxRoot.length > 0) {
      await rescanInboxCheckpoints().catch((error) =>
        inboxError(error, "boot rescan"),
      );
    }
  };

  const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
    policyEnabled: enabled,
    onActivated: (sessionId) => {
      activateToolSurface(sessionId);
      // Ticket 31: the restart notice and redrive ride the durability
      // rebuild, so activation itself returns immediately.
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
      // Ticket 115: this session's await waiters end here — each resolves
      // `released` and its timeout timer is cancelled, so no waiter or timer
      // outlives a deactivated dispatcher. Settle records stay: deactivation
      // is not a restart. Plugin unload reaches this too — `unbind`
      // deactivates each session through the same path.
      multitask.cancelWaits(sessionId);
      // Ticket 23: prompts belong to their session — abandon this session's
      // outstanding ones. Their tickets keep the armed relay timeouts
      // (ADR-0008 deny-by-default); nothing waits indefinitely.
      accessPumps.get(sessionId)?.reset();
    },
  });

  // ── Ticket 124 / ADR-0029: deterministic microcompact ────────────────
  // Registered ONLY on activated dispatcher sessions (`shouldHandle`) — the
  // listener otherwise sits on the outer scope and would rewrite an ordinary
  // user chat (the scope rule: an outer scope receives descendants). The
  // token meter is read through `ctx.get`: it is mounted on the host plane
  // (`dsh-base/cordis.patch.yml:348`), not in this plugin's inject list, and
  // a direct property read on an un-injected service throws.
  const microcompactEnabled = config.microcompactEnabled?.get() === true;
  if (microcompactEnabled) {
    ctx.effect(
      function* () {
        yield registerMicrocompact(
          ctx,
          {
            enabled: true,
            shouldHandle: (sessionId) =>
              lifecycle.isDispatcherSession(sessionId),
            onOutcome: (outcome) => {
              // Audit line only (design constraint 6): cleared count and bytes
              // go to the host log, which is the evidence path for this
              // feature. Never fatal.
              if (!outcome.compacted) return;
              const boundary = outcome.boundary;
              try {
                console.info(
                  `[multitask-dispatcher] microcompact ${boundary?.sessionId ?? "?"} #${boundary?.passSeq ?? "?"}: cleared ${outcome.clearedCount} tool results, ${boundary?.clearedBytes ?? 0} bytes, freed ${outcome.freedTokens} tokens`,
                );
              } catch {
                // A broken console must never break the turn.
              }
            },
          },
          markers,
          () => {
            // Cordis throws when a service is absent on a context that never
            // injected it, so the read is guarded here rather than at the call
            // site in the adapter.
            try {
              return (ctx.get?.("tokenMeter") ?? undefined) as
                | TokenMeterLike
                | undefined;
            } catch {
              return undefined;
            }
          },
        );
      },
      "multitask-dispatcher: microcompact",
    );
  }

  // ── Ticket 113: presentation + intake wiring (needs `lifecycle`) ──────

  /**
   * Present one claimed job to the routing policy's session (ticket 113):
   * exactly one live dispatcher session → it; several → the
   * earliest-activated (`dispatcherSessionIds()[0]` — the lifecycle map is
   * insertion-ordered); none → stay claimed-but-unpresented (the boot
   * rescan re-presents on the next activation). A job owned by a STILL-LIVE
   * session is never re-presented elsewhere — one presentation, ever. Core
   * dedupe (ledger scan by jobId) makes repeated calls idempotent.
   */
  const presentInboxJob = async (
    jobId: string,
    jobDir: string,
    promptText: string,
  ): Promise<void> => {
    const sessionId = lifecycle.dispatcherSessionIds()[0];
    if (sessionId === undefined) return;
    const checkpoint: InboxJobCheckpoint | undefined = await markers.inbox
      .get(jobId)
      .catch(() => undefined);
    if (
      checkpoint !== undefined &&
      checkpoint.sessionId !== null &&
      lifecycle.isDispatcherSession(checkpoint.sessionId)
    ) {
      // One presentation, ever — but only while the owner's core still holds
      // the todo. After a crash restart the fresh ledger is empty (the marker
      // rebuild only recreates todos that had a worker), so the same session
      // id re-activating must re-present instead of leaving the job stuck.
      const ownerTodo = multitask
        .listTodos(checkpoint.sessionId)
        .find(
          (todo) =>
            todo.external?.kind === "inbox" && todo.external.jobId === jobId,
        );
      if (ownerTodo !== undefined) return;
    }
    const result = multitask.enqueueExternalJob({
      sessionId,
      jobId,
      jobDir,
      promptText,
    });
    const nowMs = Date.now();
    await markers.inbox
      .record({
        jobId,
        state: "presented",
        jobDir,
        sessionId,
        todoId: result.ok ? result.todoId : (checkpoint?.todoId ?? null),
        claimedAtMs: checkpoint?.claimedAtMs ?? nowMs,
        presentedAtMs: checkpoint?.presentedAtMs ?? nowMs,
        endedAtMs: null,
        presentAttempts: (checkpoint?.presentAttempts ?? 0) + 1,
      })
      .catch((error) => inboxError(error, `checkpoint presented ${jobId}`));
  };

  /**
   * Watcher claim callback: persist the claimed state (A5 — what WE did)
   * and present immediately. Both halves are independently failure-tolerant;
   * a failed present leaves the row claimed for the boot rescan.
   */
  const onInboxJobClaimed = async (entry: InboxQueueEntry): Promise<void> => {
    await markers.inbox
      .record({
        jobId: entry.jobId,
        state: "claimed",
        jobDir: entry.dir,
        sessionId: null,
        todoId: null,
        claimedAtMs: Date.now(),
        presentedAtMs: null,
        endedAtMs: null,
        presentAttempts: 0,
      })
      .catch((error) => inboxError(error, `checkpoint claimed ${entry.jobId}`));
    await presentInboxJob(entry.jobId, entry.dir, entry.text).catch((error) =>
      inboxError(error, `present ${entry.jobId}`),
    );
  };

  /**
   * Boot rescan (ticket 113): re-present checkpoint rows that never reached
   * a terminal state — claimed-but-unpresented jobs plus crash orphans.
   * Disk truth wins: a job dir whose status.json (or non-empty reply.md)
   * already shows a terminal outcome is ADOPTED into that outcome instead
   * of re-presented (the file write succeeded but the checkpoint update
   * crashed); only a job still showing claimed/queued/no-reply on disk is
   * re-presented, and only when its prompt is still resolvable.
   */
  const rescanInboxCheckpoints = async (): Promise<void> => {
    let checkpoints: readonly InboxJobCheckpoint[];
    try {
      checkpoints = await markers.inbox.list();
    } catch (error) {
      inboxError(error, "boot rescan list");
      return;
    }
    for (const checkpoint of checkpoints) {
      // Defensive row-shape guard: a tolerant fake (or a corrupted row) must
      // never take the activation chain down. Real rows always carry both.
      if (
        checkpoint === null ||
        typeof checkpoint !== "object" ||
        typeof (checkpoint as InboxJobCheckpoint).jobId !== "string" ||
        typeof (checkpoint as InboxJobCheckpoint).jobDir !== "string" ||
        typeof (checkpoint as InboxJobCheckpoint).state !== "string"
      ) {
        continue;
      }
      if (
        checkpoint.state === "replied" ||
        checkpoint.state === "failed" ||
        checkpoint.state === "cancelled"
      ) {
        continue;
      }
      const dir =
        checkpoint.jobDir.length > 0
          ? checkpoint.jobDir
          : join(inboxRoot, checkpoint.jobId);
      const disk: InboxJobDiskState | null = await readInboxJobDiskState(
        dir,
      ).catch(() => null);
      const diskOutcome: InboxJobState | null = disk?.replyPresent
        ? "replied"
        : disk !== null &&
            (disk.status === "replied" ||
              disk.status === "failed" ||
              disk.status === "cancelled")
          ? disk.status
          : null;
      if (diskOutcome !== null) {
        await markers.inbox
          .record({
            ...checkpoint,
            state: diskOutcome,
            endedAtMs: checkpoint.endedAtMs ?? Date.now(),
          })
          .catch((error) =>
            inboxError(error, `checkpoint adopt ${checkpoint.jobId}`),
          );
        continue;
      }
      const text = await resolveInboxJobText(inboxRoot, dir, checkpoint.jobId);
      if (text === null) {
        inboxError(
          new Error(
            `no resolvable prompt for job ${checkpoint.jobId}; keeping ${checkpoint.state}`,
          ),
          "boot rescan",
        );
        continue;
      }
      await presentInboxJob(checkpoint.jobId, dir, text).catch((error) =>
        inboxError(error, `boot re-present ${checkpoint.jobId}`),
      );
    }
  };

  // The watcher starts ONLY when the inbox is on and a root is set:
  // disabled or empty dir → nothing starts at all (no fs.watch, no timers,
  // no directory creation). Cleanup under the effect contract (ticket 44):
  // the disposer is RETURNED, never passed as execute.
  if (inboxEnabled && inboxRoot.length > 0) {
    const inboxWatcher = startInboxWatcher({
      root: inboxRoot,
      rescanIntervalMs: inboxRescanIntervalMs,
      onJob: (entry) => {
        void onInboxJobClaimed(entry);
      },
      onError: (error, context) => inboxError(error, context),
    });
    ctx.effect(
      () => () => {
        inboxWatcher.stop();
      },
      "multitask-dispatcher: inbox watcher",
    );
  }

  if (config.racoonsEnabled?.get() === true) {
    ctx.effect(
      () => registerRacoons(ctx, {
        enabled: true,
        shouldHandle: (sessionId) => lifecycle.isDispatcherSession(sessionId),
      }),
      "multitask-dispatcher: racoons",
    );
  }

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
  }, "multitask-dispatcher: dsh-bot command");

  // Steer input command (ticket 22, design-16 §4.3): same lifecycle pattern
  // as dsh-bot — registered dormant, the handler gates on the
  // INVOKING chat's own dispatcher activation (ADR-0019: a set of active
  // sessions, not one slot) and routes into the existing core steer queue
  // path (`Multitask.steerWorker`, shared with the steer_worker tool).
  // Same generator-effect shape as dsh-bot (ticket 44).
  ctx.effect(function* () {
    yield registerDispatcherSteerCommand({
      ctx,
      activeSessionIds: () => lifecycle.dispatcherSessionIds(),
      steer: (workerId, message) => multitask.steerWorker(workerId, message),
    });
  }, "multitask-dispatcher: dispatcher-steer command");

  // Access-ask answer command (ticket 69, L1 offline half): the resolve
  // TRANSPORT the wrapper's approval-card buttons execute through the
  // composer's own command transaction (ticket 36 seam 2 / ticket 40's
  // start precedent). The handler routes into the UNCHANGED relay via
  // `Multitask.resolveAccess` — the same entry point the ticket-23 prompt
  // pump uses — and "always-allow" inserts the SAME session-scope row the
  // pump's sink inserts (ADR-0019 attribution + ticket-30 wildcard fence;
  // the sink below is authoritative, the command re-checks defensively).
  ctx.effect(function* () {
    yield registerDispatcherResolveCommand({
      ctx,
      activeSessionIds: () => lifecycle.dispatcherSessionIds(),
      findPending: (workerId, parentSessionId) =>
        multitask
          .listPendingAccess(parentSessionId)
          .find((t) => t.workerId === workerId),
      resolve: (workerId, decision) =>
        multitask.resolveAccess(workerId, decision),
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
      isWildcardTarget: isWildcardAccessTarget,
    });
  }, "multitask-dispatcher: dispatcher-resolve command");

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
  // prompts), sweep any remainder, dispose the core's timers (access relay
  // then wake bus), dispose the host, release the marker domain.
  ctx.effect(
    () => () => {
      lifecycle.unbind();
      deactivateAllToolSurfaces();
      // Ticket 30 + ADR-0019: on unload every session-scope row goes —
      // no "always" can outlive the plugin that consented to it.
      multitask.clearSessionAccessPolicy();
      // Ticket 23: abandon any remaining outstanding prompts on unload/HMR.
      // Ticket 137: the pump sweep runs BEFORE the relay is closed, so an
      // answer already in flight from a prompt lands (or is dropped as
      // expired) while the relay still accepts it; any later resolve is a
      // no-op once the relay is closed.
      for (const pump of accessPumps.values()) {
        pump.reset();
      }
      // Ticket 112/137: disarm every core-owned timer BEFORE the host goes
      // away. `Multitask.dispose()` clears the access relay's parked deny
      // timeouts first (ticket 137 — a late fire would call `onResolved`
      // and re-arm a coalescing window on a disposed bus), then the wake
      // bus (ticket 112 — a window armed at unload must never open a turn
      // on a host that is being disposed). Idempotent, so a repeated
      // teardown is safe.
      multitask.dispose();
      host.dispose();
      void markers.dispose();
    },
    "multitask-dispatcher: plugin teardown",
  );
}
