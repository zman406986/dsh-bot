import type { DshHost } from "./dsh-host.js";
import {
  isTerminalStatus,
  type SpawnRequest,
  type SpawnResult,
  type SteerResult,
  type StopResult,
  type WorkerRecord,
  type WorkerStatus,
  type WorkerSummary,
} from "./types.js";
import type { AccessDecision, AccessTicket } from "./access-types.js";
import {
  createAccessRelay,
  createAccessPolicyTable,
  type AccessPolicyTable,
  type AccessRelay,
} from "./access-relay.js";
import {
  createReviewPostureTable,
  type ReviewPostureTable,
} from "./review-posture.js";
import {
  createSteerQueue,
  type SteerQueue,
  wrapParentCorrection,
} from "./steer-queue.js";
import {
  createWakeBus,
  type WakeBus,
  type WakeBusDegradedInfo,
  type WakeEvent,
} from "./wake-bus.js";
import {
  createPeerInbox,
  type PeerInbox,
  type PeerInboxOptions,
} from "./peer-inbox.js";
import type { PeerEnvelope, PeerSendAck } from "./peer-types.js";
import {
  effectivePeerPriority,
  toPeerNotice,
} from "./peer-types.js";
import { applyEvent, type WorkerEvent } from "./worker-fsm.js";
import {
  MAX_DELIVERY_REDRIVES,
  createTodoLedger,
  reconcileTodos,
  type CreateTodoInput,
  type ReconcileReport,
  type TodoExternalOrigin,
  type TodoItem,
  type TodoLedger,
} from "./todo-reconciler.js";
import {
  toDurableMarker,
  type DurabilityPort,
  type RebuildReport,
  type UnknownStateWorker,
} from "./durability.js";
import { clampReport } from "./report-clamp.js";
import {
  createSettleRecords,
  resolveAwaitTarget,
  validateAwaitTimeout,
  type AwaitWorkerHooks,
  type AwaitReleasedReason,
  type AwaitWorkerOutcome,
  type AwaitWorkerRefusal,
  type SettleRecord,
  type SettleRecords,
} from "./settle-records.js";

/** A drained wake plus the reconcile report for that wake. */
export interface DrainedWake {
  readonly wake: WakeEvent;
  readonly reconcile: ReconcileReport;
}

/**
 * Ticket 113: one inbox-origin job resolution fired through the
 * `onInboxJobResolved` hook. The core decides WHEN (terminal paths and
 * delivery); the hook implementation owns HOW (the plugin writes the job
 * dir files — the core never touches the filesystem).
 */
export type InboxJobResolution =
  | {
      /** Worker completed and the result was delivered to the user. */
      readonly kind: "replied";
      readonly todoId: string;
      readonly sessionId: string;
      readonly jobId: string;
      readonly jobDir: string;
      /** The delivered text; non-empty reply.md is the completion signal. */
      readonly replyText: string;
    }
  | {
      /** Worker errored (fires from the settle path, delivery or not). */
      readonly kind: "failed";
      readonly todoId: string;
      readonly sessionId: string;
      readonly jobId: string;
      readonly jobDir: string;
      readonly error: string;
    }
  | {
      /** Worker aborted (stop command or an abort-shaped settle). */
      readonly kind: "cancelled";
      readonly todoId: string;
      readonly sessionId: string;
      readonly jobId: string;
      readonly jobDir: string;
      readonly reason: string;
    };

/** Input to {@link Multitask.enqueueExternalJob} (ticket 113). */
export interface EnqueueExternalJobInput {
  readonly sessionId: string;
  readonly jobId: string;
  readonly jobDir: string;
  /** The job's resolved prompt (prompt.md over entry.text, adapter-side). */
  readonly promptText: string;
  /** Ledger title; defaults to a short inbox-flavored line. */
  readonly title?: string;
}

/** Result of {@link Multitask.enqueueExternalJob} (ticket 113). */
export type EnqueueExternalJobResult =
  | { readonly ok: true; readonly todoId: string }
  | { readonly ok: false; readonly reason: "duplicate-job" };

/**
 * What one delivery-redrive pass did (ticket 58, register D-5).
 * `redriven` items were re-offered to the dispatcher; `lost` items hit the
 * bound and are now terminal. Both are empty when nothing was owed — which is
 * the common case, and must stay cheap.
 */
export interface RedriveReport {
  readonly redriven: readonly TodoItem[];
  readonly lost: readonly TodoItem[];
}

/** Access-relay knobs (ticket 13). */
export interface MultitaskAccessOptions {
  /** Unanswered-ask timeout. Default 120_000. */
  readonly timeoutMs?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
  /** Injectable one-shot scheduler for tests. Returns a cancel function. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

/**
 * Ticket 108: wake-bus coalescing knobs (window size plus the clock and
 * scheduler seams, mirroring the access-relay option shape).
 */
export interface MultitaskWakeOptions {
  /**
   * Idle-side coalescing window in ms. Default 0 = immediate delivery
   * (pre-108 semantics, unchanged). When >0, idle background/peer enqueues
   * share one per-session drain per window.
   */
  readonly coalesceWindowMs?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
  /** Injectable one-shot scheduler for tests. Returns a cancel function. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /** Consecutive coalesced-drain failures before degraded immediate mode. */
  readonly coalesceFailBudget?: number;
  /** Called once when the bus degrades to immediate mode. */
  readonly onDegraded?: (info: WakeBusDegradedInfo) => void;
}

/**
 * Ticket 115: await-waiter knobs (clock and scheduler seams), mirroring the
 * access-relay option shape.
 */
export interface MultitaskAwaitOptions {
  /** Injectable clock for tests. */
  readonly now?: () => number;
  /** Injectable one-shot scheduler for tests. Returns a cancel function. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

/** Optional ports the multitask core depends on beyond the host. */
export interface MultitaskOptions {
  /**
   * Durable marker store (ADR-0006). Omit for pure in-memory operation
   * (existing unit tests). When present, the core writes a minimum
   * marker at spawn, updates it on settle, and can rebuild after a restart.
   */
  readonly durability?: DurabilityPort;
  /** Access-relay configuration (timeout, test seams). */
  readonly access?: MultitaskAccessOptions;
  /** Wake-bus coalescing configuration (ticket 108; window, test seams). */
  readonly wake?: MultitaskWakeOptions;
  /** Peer inbox knobs (ticket 14). */
  readonly peer?: PeerInboxOptions;
  /**
   * Roster-change observer (tickets 21 + 27). Fired after every
   * roster-affecting mutation — spawn, accepted FSM transition
   * (turn/steer/abort/settle), durability restore, todo reconcile, a
   * pending access ask parking or resolving (the blocked marker), and a
   * todo flipping to delivered (the delivered flag) — with the affected
   * parent session id. Fire-and-forget: observer errors are swallowed so
   * telemetry can never break core flow. The observer only READS the core
   * back to project a snapshot; the core keeps no snapshot state (no second
   * store) and no presence state (design-17 §5 conflict 8: presence is a
   * projection of existing truth).
   */
  readonly onRosterChanged?: (parentSessionId: string) => void;
  /**
   * Redrives allowed before an undelivered obligation escalates to `lost`
   * (ticket 58, D-5). Defaults to {@link MAX_DELIVERY_REDRIVES}. Exposed so
   * tests can reach the bound in one step instead of looping the whole loop.
   */
  readonly maxRedrives?: number;
  /**
   * Ticket 70 §2: liveness check consulted by `sendPeer` for the TARGET
   * session id before accept. When it returns false the send is refused with
   * `unknown-target` (the shipped lazy-inbox used to silently ack a send to
   * a nonexistent session into a phantom inbox — this is the deliberate,
   * design-recorded behavior change for sloppy senders). Absent callback
   * keeps the current behavior: the core stays host-agnostic, the plugin
   * wires `lifecycle.isDispatcherSession`. Offline-testable both ways.
   */
  readonly isLiveDispatcherSession?: (sessionId: string) => boolean;
  /**
   * Ticket 113: fired when an inbox-origin obligation reaches a terminal
   * outcome — `replied` (worker settled AND the result was delivered via
   * `markDelivered`), `failed` (worker error, delivery or not), or
   * `cancelled` (abort, delivery or not). The hook is injected like
   * `onRosterChanged` so the core never touches the filesystem; a throwing
   * hook is swallowed — it must never break the settle path. The plugin's
   * implementation writes `reply.md`/`status.json` atomically and surfaces
   * its own write failures honestly.
   */
  readonly onInboxJobResolved?: (resolution: InboxJobResolution) => void;
  /** Await-waiter configuration (ticket 115; test seams). */
  readonly awaits?: MultitaskAwaitOptions;
  /**
   * Ticket 115: adapter-side liveness probe for await timeouts, wired to
   * `ctx.agents.get(id) !== undefined`. It is checked ONCE, at timeout, when
   * no settle record exists — never on a timer. False means the worker's
   * agent is gone with no recorded result: the wait reports `gone`.
   */
  readonly isAgentAlive?: (workerId: string) => boolean;
}

/**
 * Public multitask-core surface.
 * Status changes flow through the pure worker FSM (see worker-fsm.ts);
 * illegal transitions are ignored rather than thrown.
 */
export interface Multitask {
  /**
   * Spawn a worker through the host and put it on the live roster.
   * Refused when the stream key already has a live (non-terminal) worker —
   * one stream has one worker. A terminal worker frees the stream key.
   * When `todoId` is set, the worker is structurally linked to that ledger
   * item (ADR-0007). The ledger itself is never sent into the worker.
   */
  spawnWorker(request: SpawnRequest): Promise<SpawnResult>;
  /**
   * Stop a worker for good. Interrupts through the host, clears any parked
   * steer, and leaves the worker aborted so a later settle is dropped (no
   * delivery, no wake, no revival). Closes any linked todo as cancelled.
   * The stop path never sends a user-facing message; the caller receives a
   * plain confirmation result.
   * Refused without interrupting when the worker has already settled — the
   * refusal notes the worker may already be done, and any completion already
   * delivered through the normal settle path stays delivered.
   */
  abortWorker(workerId: string): Promise<StopResult>;
  /**
   * Park a steer for a live worker and interrupt its current step.
   * Single-slot last-wins: a newer steer replaces any undelivered one.
   * Refused (and never recreates a worker) when the worker is not live mid-work.
   */
  steerWorker(workerId: string, message: string): Promise<SteerResult>;
  /**
   * First turn started: spawned → running. Marks any linked todo in_progress.
   * No-op if illegal.
   */
  noteTurnStarted(workerId: string): void;
  /** Steer received for a running worker: running → steering. No-op if illegal. */
  noteSteerReceived(workerId: string): void;
  /** Steer injected and work continues: steering → running. No-op if illegal. */
  noteSteerInjected(workerId: string): void;
  /** Increment the worker's tool-call count. No-op for unknown workers. */
  noteToolCall(workerId: string): void;
  /**
   * Roster for a parent session, including terminal entries.
   * Each entry carries elapsed time, tool-call count, and transcript reference.
   */
  listWorkers(parentSessionId: string): WorkerSummary[];
  getWorker(workerId: string): WorkerRecord | undefined;
  /**
   * Create a dispatcher-private ledger entry. Call before spawn for any
   * user-visible work; pure chat and trivial lookups create no entry.
   */
  createTodo(input: CreateTodoInput): TodoItem;
  /**
   * Present one external intake job to a dispatcher session (ticket 113,
   * ADR-0023). Creates a pending ledger item tagged with the inbox origin
   * and enqueues an `external-event` wake (background rank, ticket-108
   * coalescing applies). Idempotent per session: a job whose ledger item
   * still exists is refused with `duplicate-job` — re-presentation after a
   * restart relies on the fresh core's empty ledger, never on overwriting.
   * The inbox never spawns (ADR-0003): the dispatcher model decides via the
   * normal spawn_worker path.
   */
  enqueueExternalJob(input: EnqueueExternalJobInput): EnqueueExternalJobResult;
  /** Ledger items for a session. Never passed into a worker. */
  listTodos(sessionId: string): TodoItem[];
  /**
   * Mark a todo delivered to the user and completed. Call only after a
   * successful user-facing send — completed means delivered (S4).
   * `replyText` (ticket 113) carries the delivered text for inbox-origin
   * items so the plugin's reply writer can land it in the job dir.
   */
  markDelivered(todoId: string, replyText?: string): boolean;
  /**
   * Run the pure reconciler against current todo + roster state for a wake
   * (or an empty user/timer wake when omitted), apply the mutations, and
   * return the outstanding-work report.
   */
  reconcileTodos(sessionId: string, wake?: WakeEvent): ReconcileReport;
  /**
   * Take the ready wake for this session and reconcile the ledger against it
   * in one step. Preferred dispatcher-turn entry point.
   */
  drainWake(sessionId: string): DrainedWake | undefined;
  /**
   * Bounded delivery redrive (ticket 58, register D-5). Call it when a
   * dispatcher turn ends and on activation: any result whose worker settled
   * but which was never delivered is re-offered by **opening a turn**, up to
   * {@link MAX_DELIVERY_REDRIVES}; past the bound the item becomes terminal
   * `lost` with a reason instead of persisting forever.
   *
   * Synchronous and side-effect-safe: a no-op when nothing is owed, which is
   * the common case. Never throws.
   */
  redriveUndelivered(sessionId: string): RedriveReport;
  /**
   * Rebuild the live roster from durable markers only (ADR-0006).
   * Call on a fresh core after a simulated or real restart — do not mix
   * with an already-populated roster. Terminal markers are restored so an
   * undelivered result can still finish delivery (S4). Live markers become
   * unknown-state with a transcript pointer: never replayed, never resumed.
   * Steer tickets are in-memory and are never restored.
   */
  rebuildFromDurability(parentSessionId: string): Promise<RebuildReport>;
  /**
   * Workers that were live at crash time and were not reconstructed, whose
   * stream keys are therefore still held (ticket 59, register B-1). They never
   * appear on the roster; this is their machine-readable surface.
   */
  listUnknownStateHolds(
    parentSessionId?: string,
  ): readonly UnknownStateWorker[];
  /**
   * Resolve an unknown-state hold (ticket 59): the caller has established that
   * the worker is gone, or accepts the risk, so the stream key is released for
   * re-dispatch. Also drops the durable marker — otherwise the hold would come
   * straight back on the next activation, which is the loop this exists to
   * avoid. Returns false when nothing was held under that id.
   *
   * Async because the marker deletion is: resolving the hold but leaving the
   * marker behind would resurrect it on the next activation, so "released"
   * must not be reported before the marker is actually gone.
   */
  releaseUnknownStateHold(workerId: string): Promise<boolean>;
  /**
   * Wake bus this core enqueues settles through. Settles are batched per
   * parent session; a mid-turn dispatcher queues rather than receiving an
   * injected wake. Callers use it to note dispatcher turn bounds, drain
   * wakes, and enqueue user/peer/timer wakes.
   */
  readonly wakeBus: WakeBus;
  /**
   * Fire-and-forget peer accept (ticket 14; fences ticket 70 §2). Returns a
   * structural ack only — never a reply. Newly accepted envelopes join the
   * priority or normal lane by the 1:1 priority flag; delivery is wake-bus +
   * host followup. Self-targets refuse unconditionally; unknown targets
   * refuse when `isLiveDispatcherSession` is wired.
   */
  sendPeer(sessionId: string, envelope: PeerEnvelope): PeerSendAck;
  /** Undelivered peer envelopes for a session (status tools / tests). */
  listPendingPeers(sessionId: string): readonly PeerEnvelope[];
  /**
   * Plugin-owned peer inbox. Exposed for status/tests; prefer `sendPeer`.
   */
  readonly peerInbox: PeerInbox;
  /** Dispatcher-private todo ledger (ADR-0007). */
  readonly todos: TodoLedger;
  /**
   * Answer a pending access ask. Delivers the decision into the same
   * worker via sendMessage (no restart). Idempotent; false when unknown
   * or already resolved.
   */
  resolveAccess(workerId: string, decision: AccessDecision): boolean;
  /** Pending access tickets, optionally filtered by parent session. */
  listPendingAccess(parentSessionId?: string): readonly AccessTicket[];
  /**
   * Drop session-scope access policy rows (ticket 30). Called on
   * deactivation/unload so an "always allow (this session)" choice never
   * leaks into a later session. Profile rows are untouched.
   * ADR-0019: WITH a session id, only that dispatcher session's rows are
   * cleared — a sibling dispatcher's remembered rows survive. Without one,
   * every session-scope row is cleared (plugin unload).
   */
  clearSessionAccessPolicy(sessionId?: string): void;
  /** Stored policy table (session/profile). No hit → ask. */
  readonly accessPolicy: AccessPolicyTable;
  /**
   * Review-posture table (ticket 69, chunk A). Session-scoped deterministic
   * auto-answer consulted only on a consent "ask" miss; shipped posture is
   * EMPTY (un-configured behavior is byte-identical). Rows enter only
   * through this API (tests; any real seeder is a human decision) and never
   * outlive their session — clearance rides `clearSessionAccessPolicy`.
   */
  readonly reviewPosture: ReviewPostureTable;
  /**
   * Ticket 115: per-target settle records — a bounded ring of 64 terminal
   * worker results per parent session, written by the settle path BEFORE the
   * settle wake is enqueued, so a wait racing the wake still sees the record.
   * In-memory only (ADR-0012: a restart loses results, reported plainly,
   * never replayed). `awaitWorker` (second half of ticket 115) reads this;
   * exposed for tests and the await layer.
   */
  readonly settleRecords: SettleRecords;
  /**
   * Ticket 115: release every active await waiter of one dispatcher session —
   * each resolves `released` and its timer is cancelled. Wire this to session
   * deactivation (adapter-side) so no waiter or timer outlives a deactivated
   * dispatcher. Records are not cleared: deactivation is not a restart.
   */
  cancelWaits(sessionId: string): void;
  /**
   * Ticket 117: release one dispatcher session's await waiters with an
   * explicit reason, each timer cancelled. The adapter calls this with
   * `"user-message"` when a REAL user prompt is observed on that session's own
   * `session/event` stream (structured `source.kind`, never text) — the user
   * is never held behind a running await. The awaited workers are NOT stopped
   * and records are untouched; other sessions' waiters keep waiting.
   *
   * Same race-set slot as `cancelWaits`: first racer wins. A session with no
   * waiters is a no-op.
   */
  releaseWaits(sessionId: string, reason: AwaitReleasedReason): void;
  /**
   * Ticket 115: bounded wait on one of the calling dispatcher session's own
   * workers, reading the per-target settle record (never the host, never a
   * transcript). A record present at call time settles immediately — so
   * `timeoutMs: 0` is a non-blocking status read — and a record arriving
   * during the wait wins the race over the timeout timer and the abort
   * signal. `undefined` timeout takes the 30,000 ms default; the valid range
   * is 0–120,000 ms. On timeout the outcome is `still-running`, or `gone`
   * when the `isAgentAlive` port reports the worker's agent dead (consulted
   * once, at the timeout, never on a timer).
   *
   * Refusals (never throw): `invalid-timeout` (outside 0–120,000 or
   * non-finite), `self-target` (the target is the calling session itself),
   * `not-awaitable` (the target is a live dispatcher session — dispatchers
   * are peers; message it instead), `unknown-target` (no such worker of this
   * session, or the worker belongs to another session), and `too-many-waits`
   * (a fifth concurrent waiter in one session). `hooks` is reserved —
   * ticket 115 defines no hooks (see {@link AwaitWorkerHooks}).
   */
  awaitWorker(
    parentSessionId: string,
    workerId: string,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
    hooks?: AwaitWorkerHooks,
  ): Promise<AwaitWorkerOutcome>;
}

export function createMultitask(
  host: DshHost,
  options?: MultitaskOptions,
): Multitask {
  const durability = options?.durability;
  const isLiveDispatcherSession = options?.isLiveDispatcherSession;
  const workers = new Map<string, WorkerRecord>();
  /**
   * Live (non-terminal) worker per stream, keyed `(parentSessionId, streamKey)`
   * (ADR-0019 keying table). The stream key is model-authored per dispatcher,
   * so the uniqueness domain is the dispatcher session: two dispatchers whose
   * models both pick `"build"` must not refuse each other's spawns, while the
   * same key twice within one session still refuses.
   */
  const liveByStreamKey = new Map<string, string>();
  /**
   * Ticket 109: stream keys with a spawn currently in flight, keyed by the
   * same composite id as `liveByStreamKey` (ADR-0019 domain). The uniqueness
   * check above is check-then-set with an `await host.spawnWorker` between
   * check and registration, so two concurrent spawns with the same key could
   * both pass the check. The reservation is taken synchronously at the point
   * the check passes — before any await — and released in the spawn's
   * `finally` (success, hold refusal, or host error). A concurrent duplicate
   * reservation is refused with the existing `duplicate-stream-key` error.
   */
  const inFlightStreamKeys = new Set<string>();
  /**
   * Workers that were live at crash time, keyed by workerId (ticket 59).
   *
   * They are not on the roster and we hold no interrupt handle for them, so
   * we cannot tell whether they died with the process or are still running
   * somewhere. What we CAN refuse is putting a second live worker on the same
   * stream: each of these keeps its stream key occupied until the dispatcher
   * resolves it. This is the one-worker-per-stream invariant holding *across*
   * a restart, which it previously did not. Hold lookup is session-scoped
   * (ADR-0019): one dispatcher's unresolved hold never blocks a sibling's
   * stream.
   */
  const unknownStateHolds = new Map<string, UnknownStateWorker>();
  const steerQueue: SteerQueue = createSteerQueue();
  const todoLedger: TodoLedger = createTodoLedger();
  const peerInbox: PeerInbox = createPeerInbox(options?.peer);
  // Ticket 108: coalescing knobs flow through like the access seams —
  // conditionally spread so an unset option stays truly absent (the bus
  // applies its own defaults).
  const wakeOptions = options?.wake;
  const wakeBus: WakeBus = createWakeBus({
    ...(wakeOptions?.coalesceWindowMs !== undefined
      ? { coalesceWindowMs: wakeOptions.coalesceWindowMs }
      : {}),
    ...(wakeOptions?.now !== undefined ? { now: wakeOptions.now } : {}),
    ...(wakeOptions?.schedule !== undefined
      ? { schedule: wakeOptions.schedule }
      : {}),
    ...(wakeOptions?.coalesceFailBudget !== undefined
      ? { coalesceFailBudget: wakeOptions.coalesceFailBudget }
      : {}),
    ...(wakeOptions?.onDegraded !== undefined
      ? { onDegraded: wakeOptions.onDegraded }
      : {}),
    onDeliver: (sessionId, origin) => {
      // Ticket 116: a peer wake carries structured provenance, so the host
      // stamps an `agent-message` source on the follow-up instead of the
      // plugin kind. Absent origin → the shipped plugin source, unchanged.
      void host.requestDispatcherWakeup(sessionId, origin);
    },
    onInterrupt: (sessionId) => {
      // Soft-fallback hosts may omit the seam — priority still becomes
      // the ready wake and wins the next flush.
      if (typeof host.requestDispatcherInterrupt === "function") {
        void host.requestDispatcherInterrupt(sessionId);
      }
    },
    onDrain: (event) => {
      // One delivered turn per messageId: mark drained peer rows delivered
      // so a later re-queue never re-delivers them.
      if (event.source !== "peer" || event.peerMessages === undefined) return;
      for (const notice of event.peerMessages) {
        peerInbox.markDelivered(event.sessionId, notice.messageId);
      }
    },
  });
  const accessPolicy: AccessPolicyTable = createAccessPolicyTable();
  // Ticket 115: per-target settle records + bounded await waiters. Knobs
  // flow through like the access seams — conditionally spread so an unset
  // option stays truly absent.
  const awaits = options?.awaits;
  const settleRecords: SettleRecords = createSettleRecords({
    ...(awaits?.now !== undefined ? { now: awaits.now } : {}),
    ...(awaits?.schedule !== undefined ? { schedule: awaits.schedule } : {}),
    ...(options?.isAgentAlive !== undefined
      ? { isAgentAlive: options.isAgentAlive }
      : {}),
  });
  // Ticket 69 (chunk A): the review posture is composed AFTER the consent
  // table at this lookupPolicy wiring — consent (allow or deny) wins; only
  // a consent "ask" miss falls through to the posture; a posture miss is
  // still "ask" and lands on the shipped park/wake/timeout path. Shipped
  // posture is EMPTY, so with no rows the lookup is byte-identical.
  const reviewPosture: ReviewPostureTable = createReviewPostureTable();
  const accessRelay: AccessRelay = createAccessRelay({
    ...(options?.access?.timeoutMs !== undefined
      ? { timeoutMs: options.access.timeoutMs }
      : {}),
    ...(options?.access?.now !== undefined ? { now: options.access.now } : {}),
    ...(options?.access?.schedule !== undefined
      ? { schedule: options.access.schedule }
      : {}),
    lookupPolicy: (req, ctx) => {
      const consent = accessPolicy.lookup(req, ctx);
      if (consent !== "ask") return consent;
      return reviewPosture.lookup(req, ctx);
    },
    deliver: (workerId, message) => host.sendMessage(workerId, message),
    wakeForAsk: (notice) => {
      wakeBus.enqueueAccessRequest({
        parentSessionId: notice.parentSessionId,
        workerId: notice.workerId,
        requestId: notice.requestId,
        title: notice.title,
        body: notice.body,
      });
    },
    onResolved: (notice, parentSessionId) => {
      // Honest deny reporting: surface the denial on the next wake. Ticket
      // 27: the pending-access set changed here (timeout/policy deny), so
      // the blocked marker must re-project too.
      notifyRosterChanged(parentSessionId);
      wakeBus.enqueueAccessNotice({ parentSessionId, notice });
    },
    getWorkerTitle: (workerId) => workers.get(workerId)?.title ?? workerId,
    isWorkerLive: (workerId) => {
      const record = workers.get(workerId);
      return record !== undefined && !isTerminalStatus(record.status);
    },
  });

  /** Fire the roster observer (ticket 21); never lets it break core flow. */
  function notifyRosterChanged(parentSessionId: string): void {
    const observer = options?.onRosterChanged;
    if (observer === undefined) return;
    try {
      observer(parentSessionId);
    } catch {
      // Telemetry must never break the core.
    }
  }

  /**
   * Ticket 113: fire the inbox resolution hook. Same swallow discipline as
   * the roster observer — a throwing hook (the plugin's own fs writes live
   * behind it) must never break the settle or delivery path.
   */
  function fireInboxHook(resolution: InboxJobResolution): void {
    const hook = options?.onInboxJobResolved;
    if (hook === undefined) return;
    try {
      hook(resolution);
    } catch {
      // The plugin surfaces its own failures; the core stays unaffected.
    }
  }

  /** The inbox origin of a record's linked todo, if any (ticket 113). */
  function todoExternalOf(
    todoId: string | null,
  ): TodoExternalOrigin | undefined {
    if (todoId === null) return undefined;
    return todoLedger.get(todoId)?.external ?? undefined;
  }

  /**
   * The stream-uniqueness map's composite key (ADR-0019): one dispatcher
   * session's stream keys never collide with a sibling's.
   */
  function liveStreamKeyId(
    parentSessionId: string,
    streamKey: string,
  ): string {
    return `${parentSessionId}\u0000${streamKey}`;
  }

  /** Apply a lifecycle event; returns the new status or undefined if ignored. */
  function transition(
    workerId: string,
    event: WorkerEvent,
  ): WorkerStatus | undefined {
    const record = workers.get(workerId);
    if (record === undefined) return undefined;
    const next = applyEvent(record.status, event);
    if (next === null) return undefined;
    record.status = next;
    if (isTerminalStatus(next)) {
      // Terminal frees the stream key for reuse (this session's only).
      const streamKeyId = liveStreamKeyId(record.parentSessionId, record.streamKey);
      if (liveByStreamKey.get(streamKeyId) === workerId) {
        liveByStreamKey.delete(streamKeyId);
      }
    }
    notifyRosterChanged(record.parentSessionId);
    return next;
  }

  /** Close the linked todo when a worker is aborted for good. */
  function cancelLinkedTodo(record: WorkerRecord): void {
    if (record.todoId === null) return;
    // Read BEFORE the close: cancelled items are pruned below, and the
    // ticket-113 hook needs the inbox origin while it still exists.
    const todo = todoLedger.get(record.todoId);
    todoLedger.markCancelled(record.todoId);
    // dsh has no cancelled status — drop the item so the list stays usable.
    todoLedger.prune(record.todoId);
    if (todo?.external?.kind === "inbox") {
      fireInboxHook({
        kind: "cancelled",
        todoId: todo.id,
        sessionId: todo.sessionId,
        jobId: todo.external.jobId,
        jobDir: todo.external.jobDir,
        reason: "worker-aborted",
      });
    }
  }

  /** Pure-reconcile against the session roster. Does not apply mutations. */
  /**
   * The unknown-state hold on a stream key, if any (ticket 59). Scoped to the
   * requesting dispatcher session (ADR-0019) — a sibling session's unresolved
   * hold must never block this session's stream. A linear scan is deliberate:
   * holds are created only for workers that were live at crash time, so the
   * set is tiny and bounded by a single restart.
   */
  function findUnknownStateHold(
    parentSessionId: string,
    streamKey: string,
  ): UnknownStateWorker | undefined {
    for (const hold of unknownStateHolds.values()) {
      if (
        hold.parentSessionId === parentSessionId &&
        hold.streamKey === streamKey
      ) {
        return hold;
      }
    }
    return undefined;
  }

  function runReconcile(
    sessionId: string,
    wake: WakeEvent,
  ): ReconcileReport {
    return reconcileTodos({
      wake,
      todos: todoLedger.list(sessionId),
      maxRedrives: options?.maxRedrives ?? MAX_DELIVERY_REDRIVES,
      workers: [...workers.values()]
        .filter((worker) => worker.parentSessionId === sessionId)
        .map((worker) => ({
          workerId: worker.workerId,
          parentSessionId: worker.parentSessionId,
          streamKey: worker.streamKey,
          title: worker.title,
          status: worker.status,
          startedAtMs: worker.startedAtMs,
          elapsedMs: 0,
          toolCallCount: worker.toolCallCount,
          transcriptRef: worker.transcriptRef,
          todoId: worker.todoId,
        })),
    });
  }

  host.onWorkerSettled((event) => {
    // Settle wins over a pending access ask — drop the ticket first.
    accessRelay.clear(event.workerId);
    const next = transition(event.workerId, {
      type: "settled",
      status: event.status,
    });
    // Double settle and post-abort settles are ignored — never revive, never re-wake.
    if (next === undefined) return;
    const record = workers.get(event.workerId);
    if (record === undefined) return;
    if (event.transcriptRef !== undefined) {
      record.transcriptRef = event.transcriptRef;
    }
    // Aborted via settle: close the todo here; the wake still informs the dispatcher.
    // The marker obligation is closed too — nothing to reconstruct or deliver.
    if (event.status === "aborted") {
      cancelLinkedTodo(record);
      void durability?.deleteWorkerMarker(record.workerId);
    } else {
      // Ticket 113: an inbox-origin worker's ERROR maps to a `failed` job
      // status. The todo itself stays open (the dispatcher still reports and
      // may re-plan), but the job dir gets its honest terminal signal from
      // the terminal path, delivery or not.
      if (event.status === "error") {
        const external = todoExternalOf(record.todoId);
        if (external?.kind === "inbox") {
          fireInboxHook({
            kind: "failed",
            todoId: record.todoId ?? "",
            sessionId: record.parentSessionId,
            jobId: external.jobId,
            jobDir: external.jobDir,
            error: event.report,
          });
        }
      }
      if (durability !== undefined) {
        // Snapshot terminal status (+ transcript pointer) so a crash before
        // user delivery still lets a restart notice the undelivered result.
        // Ticket 113: the marker carries the inbox origin so a rebuild
        // re-creates the ledger link with it intact.
        void Promise.resolve(
          durability.writeWorkerMarker(
            toDurableMarker(record, todoExternalOf(record.todoId)),
          ),
        );
      }
    }
    // Ticket 115: the settle record is written BEFORE the wake is enqueued,
    // so a wait that races the wake still sees the record. Additive
    // bookkeeping read off this exact path — wake composition and ordering
    // are untouched.
    settleRecords.record(record.parentSessionId, {
      workerId: event.workerId,
      status: event.status,
      resultText: clampReport(event.report, {
        transcriptRef: record.transcriptRef,
      }),
      settledAtMs: Date.now(),
    });
    // One enqueue per accepted settle; the bus batches and routes the wake.
    // The ledger is never included — workers and host never see todos (ADR-0007).
    wakeBus.enqueueWorkerSettled({
      parentSessionId: record.parentSessionId,
      workerId: event.workerId,
      status: event.status,
      title: record.title,
      resultText: event.report,
    });
  });

  // Step boundary: pop the latest parked steer, wrap it as a parent correction,
  // and deliver it into the same worker. Last-wins — earlier steers were already
  // overwritten in the single slot and are never delivered.
  host.onStepBoundary((workerId) => {
    const record = workers.get(workerId);
    if (record === undefined || record.status !== "steering") return;
    const latest = steerQueue.pop(workerId);
    if (latest === undefined) return;
    return host.sendMessage(workerId, wrapParentCorrection(latest)).then(() => {
      transition(workerId, { type: "steer-injected" });
    });
  });

  // Structured access ask from a worker (ticket 13). Policy may auto-answer;
  // otherwise the relay parks a ticket, arms the timeout, and wakes us.
  // Ticket 27: a parked ask changes the worker's blocked marker, so the
  // roster observer fires too. Only an actual park notifies — a policy
  // auto-answer (or a refused duplicate) leaves the pending set unchanged;
  // auto-answer denials re-project through `onResolved` above.
  host.onAccessRequest((event) => {
    const record = workers.get(event.workerId);
    if (record === undefined || isTerminalStatus(record.status)) return;
    const pendingBefore = accessRelay.listPending(record.parentSessionId).length;
    accessRelay.noteRequest(event, record.parentSessionId);
    if (accessRelay.listPending(record.parentSessionId).length > pendingBefore) {
      notifyRosterChanged(record.parentSessionId);
    }
  });

  return {
    async spawnWorker(request: SpawnRequest): Promise<SpawnResult> {
      const streamKeyId = liveStreamKeyId(
        request.parentSessionId,
        request.streamKey,
      );
      const existingId = liveByStreamKey.get(streamKeyId);
      if (existingId !== undefined) {
        return {
          ok: false,
          reason: "duplicate-stream-key",
          detail: `stream key "${request.streamKey}" already has a running worker (${existingId})`,
        };
      }
      // Ticket 109: reserve the key synchronously, BEFORE any await. Between
      // the check above and the registration below sits `await
      // host.spawnWorker`; without the reservation two concurrent spawns on
      // the same key could both pass the check (check-then-set window). A
      // concurrent duplicate is refused with the existing duplicate-stream-key
      // error, unchanged shape.
      if (inFlightStreamKeys.has(streamKeyId)) {
        return {
          ok: false,
          reason: "duplicate-stream-key",
          detail: `stream key "${request.streamKey}" already has a spawn in flight`,
        };
      }
      inFlightStreamKeys.add(streamKeyId);
      try {
        // Ticket 59 (register B-1): a stream key held by a worker that was live
        // at crash time is NOT free. We hold no interrupt handle for it, so we
        // cannot prove it stopped — and "cannot prove it stopped" must not
        // silently become "assume it stopped". Refusing is the safe half; the
        // surfacing half is the restart notice and `check_workers`.
        // ADR-0019: the check is session-scoped — the uniqueness domain of a
        // model-authored stream key is the dispatcher session.
        const hold = findUnknownStateHold(request.parentSessionId, request.streamKey);
        if (hold !== undefined) {
          return {
            ok: false,
            reason: "stream-key-held-by-unknown-state",
            detail:
              `stream key "${request.streamKey}" is still held by ${hold.workerId}, ` +
              `whose state is unknown since the restart; resolve that worker (or use a new stream key) before re-dispatching onto this stream`,
          };
        }
        // Ticket 120: the record must exist BEFORE the child can emit its
        // first `agent/status: running`, which the host delivers from inside
        // `startActivation` — i.e. before `host.spawnWorker` resolves. The
        // host commits its id through `onWorkerId` and the record lands there.
        //
        // `register` is the ONE place a worker record is created for this
        // spawn. It runs from the callback, or (for a host that commits no id
        // up front) from the post-resolve path below — never both for one id,
        // so an early `running` edge can never be overwritten by a second
        // `spawned` record.
        //
        // The todo↔worker link stays in the post-resolve path: it is not
        // needed for the FSM or for `noteTurnStarted` (which reads the
        // record's own `todoId`), and a failed spawn must leave the ledger
        // untouched.
        let announcedId: string | null = null;
        const register = (id: string): void => {
          if (id === "" || announcedId !== null) return;
          announcedId = id;
          workers.set(id, {
            workerId: id,
            parentSessionId: request.parentSessionId,
            streamKey: request.streamKey,
            title: request.title,
            status: "spawned",
            startedAtMs: Date.now(),
            toolCallCount: 0,
            transcriptRef: null,
            todoId: request.todoId ?? null,
            // Fresh obligation: the settle wake is its first delivery chance,
            // so no redrive has been spent yet (ticket 58).
            redriveAttempts: 0,
          });
          // NOTE: `liveByStreamKey` is deliberately NOT set here. Ticket 109's
          // in-flight reservation already guards the concurrent-spawn window
          // and is what the duplicate check must keep reporting ("spawn in
          // flight", not "already has a running worker"). The FSM does not
          // read that map; only the terminal transition does, and the
          // post-resolve path re-checks for a settle that won the race.
        };
        /**
         * Undo a registration whose spawn then failed: no worker, no roster
         * row, no stream-key hold. The previous code created none of these
         * before the spawn resolved; a reserved id must not change that.
         */
        const unregister = (): void => {
          if (announcedId === null) return;
          const id = announcedId;
          announcedId = null;
          workers.delete(id);
          if (liveByStreamKey.get(streamKeyId) === id) {
            liveByStreamKey.delete(streamKeyId);
          }
        };
        let workerId: string;
        try {
          workerId = await host.spawnWorker(request.prompt, {
            parentSessionId: request.parentSessionId,
            streamKey: request.streamKey,
            title: request.title,
            ...(request.credentialNames !== undefined
              ? { credentialNames: request.credentialNames }
              : {}),
            // Ticket 120: the host calls this the moment the worker id is fixed
            // — before the child can emit `agent/created` or its first
            // `agent/status: running` (both fire inside `startActivation`).
            onWorkerId: register,
          });
        } catch (error) {
          unregister();
          throw error;
        }
        // Hosts that commit no id up front land here; the state is exactly the
        // pre-120 one (nothing could have been observed before this point).
        register(workerId);
        if (announcedId !== null && announcedId !== workerId) {
          // A host that announced one id and resolved another must not leave
          // the announced record behind as a phantom on the roster. Not
          // reachable through the documented contract; handled because a
          // live child exists and a throw here would report a failed spawn
          // for work that is running.
          const announced = announcedId;
          const moved = workers.get(announced);
          workers.delete(announced);
          if (moved !== undefined) {
            workers.set(workerId, { ...moved, workerId });
          }
          if (liveByStreamKey.get(streamKeyId) === announced) {
            liveByStreamKey.set(streamKeyId, workerId);
          }
          announcedId = workerId;
        }
        const record = workers.get(workerId);
        if (record === undefined) {
          throw new Error(
            `CordisDshHost: spawn resolved without a registered worker (${workerId})`,
          );
        }
        // Structural todo↔worker link at spawn (ADR-0007). Status stays
        // pending until the worker starts (noteTurnStarted), unless that
        // already happened while the spawn was in flight.
        if (request.todoId !== undefined) {
          todoLedger.linkWorker(request.todoId, workerId, request.streamKey);
        }
        // The stream key is held for a LIVE worker only. A worker that
        // settled while the spawn was in flight has already run the terminal
        // path (which could not see the mapping yet), so it must not take the
        // key now — the same outcome the pre-120 ordering had.
        if (!isTerminalStatus(record.status)) {
          liveByStreamKey.set(streamKeyId, workerId);
        }
        // Obligation marker (ADR-0006): minimum-to-reconstruct, written at
        // spawn through the host storage seam. Awaited so the marker exists
        // before the spawn resolves. Ticket 113: the inbox origin rides the
        // marker so a rebuild can re-create the ledger link with it.
        //
        // The status comes from the CURRENT record: an early `running` edge
        // may already have advanced it while the spawn was in flight, and a
        // live snapshot still holds the stream key across a restart.
        if (durability !== undefined) {
          await Promise.resolve(
            durability.writeWorkerMarker(
              toDurableMarker(record, todoExternalOf(record.todoId)),
            ),
          );
        }
        notifyRosterChanged(request.parentSessionId);
        return { ok: true, workerId };
      } finally {
        // Ticket 109: the reservation is a spawn-in-flight marker, not a
        // lease — released on every terminal path (success, hold refusal,
        // host error) so the key's state is exactly what the roster says.
        inFlightStreamKeys.delete(streamKeyId);
      }
    },

    async abortWorker(workerId: string): Promise<StopResult> {
      const record = workers.get(workerId);
      if (record === undefined) {
        throw new Error(`unknown worker: ${workerId}`);
      }
      if (isTerminalStatus(record.status)) {
        // Already settled (or previously stopped) — refuse without interrupting.
        // The completion that already arrived was delivered through the normal
        // settle path; this refusal does not undo it.
        return {
          ok: false,
          reason: "already-settled",
          detail: `worker ${workerId} is not running; it may already be done`,
        };
      }
      const next = transition(workerId, { type: "aborted" });
      if (next === undefined) {
        // Race: the worker became terminal between the check and the transition.
        return {
          ok: false,
          reason: "already-settled",
          detail: `worker ${workerId} is not running; it may already be done`,
        };
      }
      // Drop any parked steer — nothing is kept for a later revival.
      steerQueue.clear(workerId);
      // Drop any pending access ask — stop wins; late resolve is a no-op.
      accessRelay.clear(workerId);
      // Aborted → cancelled on the ledger (and pruned; dsh has no cancelled).
      cancelLinkedTodo(record);
      // Marker obligation closed: nothing to deliver after a restart.
      void durability?.deleteWorkerMarker(workerId);
      // Mark first, then interrupt: a late host settle must not revive the worker.
      // The stop path never sends a user-facing message.
      await host.interruptWorker(workerId);
      return { ok: true };
    },

    async steerWorker(workerId: string, message: string): Promise<SteerResult> {
      const record = workers.get(workerId);
      if (record === undefined) {
        return {
          ok: false,
          reason: "unknown-worker",
          detail: `unknown worker: ${workerId}`,
        };
      }
      // Only a live mid-work worker can be steered. Spawned has not started;
      // terminal states may already be done. Never silently recreate.
      if (record.status !== "running" && record.status !== "steering") {
        return {
          ok: false,
          reason: "not-running",
          detail: `worker ${workerId} is not running; it may already be done`,
        };
      }

      // Single-slot last-wins: replaces any undelivered steer for this worker.
      steerQueue.park(workerId, message);

      if (record.status === "running") {
        transition(workerId, { type: "steer-received" });
        await host.interruptWorker(workerId);
        // A settle may have raced the interrupt — do not leave a steer parked
        // for a worker that is no longer steering.
        if (workers.get(workerId)?.status !== "steering") {
          steerQueue.clear(workerId);
        }
      }
      // Already steering: a delivery is pending; it will pick up this message.
      return { ok: true };
    },

    noteTurnStarted(workerId: string): void {
      const next = transition(workerId, { type: "turn-started" });
      if (next === undefined) return;
      // Todo before spawn → in_progress when the worker actually starts.
      const record = workers.get(workerId);
      if (record?.todoId != null) {
        todoLedger.markInProgress(record.todoId);
      }
    },

    noteSteerReceived(workerId: string): void {
      transition(workerId, { type: "steer-received" });
    },

    noteSteerInjected(workerId: string): void {
      transition(workerId, { type: "steer-injected" });
    },

    noteToolCall(workerId: string): void {
      const record = workers.get(workerId);
      if (record === undefined) return;
      record.toolCallCount += 1;
    },

    listWorkers(parentSessionId: string): WorkerSummary[] {
      const now = Date.now();
      return [...workers.values()]
        .filter((worker) => worker.parentSessionId === parentSessionId)
        .map((worker) => ({
          workerId: worker.workerId,
          parentSessionId: worker.parentSessionId,
          streamKey: worker.streamKey,
          title: worker.title,
          status: worker.status,
          startedAtMs: worker.startedAtMs,
          elapsedMs: Math.max(0, now - worker.startedAtMs),
          toolCallCount: worker.toolCallCount,
          transcriptRef: worker.transcriptRef,
          todoId: worker.todoId,
        }));
    },

    getWorker(workerId: string): WorkerRecord | undefined {
      return workers.get(workerId);
    },

    createTodo(input: CreateTodoInput): TodoItem {
      return todoLedger.create(input);
    },

    enqueueExternalJob(
      input: EnqueueExternalJobInput,
    ): EnqueueExternalJobResult {
      // Idempotent per session (ticket 113): a ledger item for this job
      // means the job was already presented — never a duplicate todo, never
      // a second wake for one job. Re-presentation after a restart works
      // because the fresh core's ledger is empty (or the rebuilt item came
      // from the marker and dedupes here all the same).
      const existing = todoLedger
        .list(input.sessionId)
        .find(
          (todo) =>
            todo.external?.kind === "inbox" &&
            todo.external.jobId === input.jobId,
        );
      if (existing !== undefined) {
        return { ok: false, reason: "duplicate-job" };
      }
      const todo = todoLedger.create({
        sessionId: input.sessionId,
        title: input.title ?? `Inbox job ${input.jobId}`,
        status: "pending",
        external: { kind: "inbox", jobId: input.jobId, jobDir: input.jobDir },
      });
      // The wake carries the payload; the ledger is never sent into a
      // worker or the bus (ADR-0007). Background rank + coalescing apply
      // inside the bus exactly as they do for settles.
      wakeBus.enqueueExternalJob({
        sessionId: input.sessionId,
        job: {
          jobId: input.jobId,
          promptText: input.promptText,
          jobDir: input.jobDir,
        },
      });
      notifyRosterChanged(input.sessionId);
      return { ok: true, todoId: todo.id };
    },

    listTodos(sessionId: string): TodoItem[] {
      return todoLedger.list(sessionId);
    },

    markDelivered(todoId: string, replyText?: string): boolean {
      const ok = todoLedger.markDelivered(todoId);
      if (!ok) return false;
      // Ticket 27: the delivered flag flipped — presence must re-project.
      const todo = todoLedger.get(todoId);
      if (todo !== undefined) notifyRosterChanged(todo.sessionId);
      // Delivery obligation closed — drop the durable marker for its worker.
      if (durability !== undefined) {
        const workerId = todoLedger.get(todoId)?.workerId;
        if (workerId != null) {
          void durability.deleteWorkerMarker(workerId);
        }
      }
      // Ticket 113: an inbox-origin item's delivered completion is the
      // `replied` resolution — the settle AND delivery conditions are both
      // met exactly here.
      if (todo?.external?.kind === "inbox") {
        fireInboxHook({
          kind: "replied",
          todoId: todo.id,
          sessionId: todo.sessionId,
          jobId: todo.external.jobId,
          jobDir: todo.external.jobDir,
          replyText: replyText ?? "",
        });
      }
      return true;
    },

    reconcileTodos(sessionId: string, wake?: WakeEvent): ReconcileReport {
      const effectiveWake: WakeEvent =
        wake ??
        wakeBus.peek(sessionId) ?? {
          sessionId,
          source: "user",
          settledWorkers: [],
          accessRequests: [],
          accessNotices: [],
        };
      const report = runReconcile(sessionId, effectiveWake);
      todoLedger.apply(report.mutations);
      // Ledger shape feeds the panel's todo links (ticket 21): reconcile is
      // a roster-affecting transition per the ticket, so observe it too.
      notifyRosterChanged(sessionId);
      return report;
    },

    drainWake(sessionId: string): DrainedWake | undefined {
      const wake = wakeBus.drain(sessionId);
      if (wake === undefined) return undefined;
      const reconcile = runReconcile(sessionId, wake);
      todoLedger.apply(reconcile.mutations);
      notifyRosterChanged(sessionId);
      return { wake, reconcile };
    },

    redriveUndelivered(sessionId: string): RedriveReport {
      // Reuse the pure reconciler with an empty wake. That is the whole
      // point: with no settles in the wake, every landed-undelivered item is
      // by definition past its first delivery opportunity, so the pass below
      // is exactly the redrive set. The bound logic lives in one place (the
      // reconciler); this method is the action layer — persist the counter,
      // open the turn.
      const emptyWake: WakeEvent = {
        sessionId,
        source: "timer",
        settledWorkers: [],
        accessRequests: [],
        accessNotices: [],
      };
      const report = runReconcile(sessionId, emptyWake);
      todoLedger.apply(report.mutations);
      // Notify only when something actually moved. This pass runs on every
      // dispatcher turn end, and an unconditional notify would publish an
      // identical snapshot every time — visible churn in the panel for no
      // change, and a second publish on an activation that changed nothing.
      let changed = report.mutations.length > 0;

      const lost: TodoItem[] = [...report.lost];

      // A linked worker we no longer hold can never settle, so its item can
      // never be delivered. Escalate instead of leaving it owed forever.
      for (const todo of todoLedger.list(sessionId)) {
        if (todo.status !== "in_progress" || todo.delivered) continue;
        if (todo.workerId === null || workers.has(todo.workerId)) continue;
        if (!todoLedger.markLost(todo.id, "worker-gone")) continue;
        const after = todoLedger.get(todo.id);
        if (after !== undefined) lost.push(after);
        changed = true;
      }

      if (changed) notifyRosterChanged(sessionId);

      // Mirror the spent attempts onto the roster records and persist them,
      // so a restart continues the same budget rather than restarting it
      // (D-5: a lifetime bound, like the reference's).
      for (const todo of report.toRedrive) {
        const record =
          todo.workerId !== null ? workers.get(todo.workerId) : undefined;
        if (record === undefined) continue;
        record.redriveAttempts = todo.redriveAttempts;
        if (durability !== undefined) {
          void Promise.resolve(
            durability.writeWorkerMarker(
              toDurableMarker(record, todoExternalOf(record.todoId)),
            ),
          );
        }
      }

      if (report.toRedrive.length > 0) {
        // Opening the turn is the delivery mechanism — queueing context would
        // repeat D-4, where the notice waited for a user who never spoke.
        wakeBus.enqueueDeliveryRedrive(sessionId);
      }

      return { redriven: report.toRedrive, lost };
    },

    /**
     * Rebuild the roster from durable markers after a host restart (ADR-0006).
     *
     * Terminal rows are restored; a worker that was live at crash time becomes
     * an honest `unknownState` entry. **This is deliberately richer than the
     * reference, and it is not a fidelity deviation to "fix" (ticket 57 R4):**
     * the reference reconstructs nothing about the worker either — on boot it
     * only re-wakes the parent with a synthetic "interrupted, result unknown"
     * notice. Neither implementation resumes or replays a worker.
     *
     * The host does offer continuable-session cold-resume; our non-use of it is
     * a core design decision, not an oversight. Reversing it is a separate
     * decision, not a side effect of this rebuild path.
     */
    async rebuildFromDurability(
      parentSessionId: string,
    ): Promise<RebuildReport> {
      const restored: WorkerRecord[] = [];
      const unknownState: UnknownStateWorker[] = [];
      if (durability === undefined) {
        return { restored, unknownState };
      }
      const markers = await Promise.resolve(
        durability.readWorkerMarkers(parentSessionId),
      );
      for (const marker of markers) {
        // Fresh-core assumption: never overwrite an in-memory entry.
        if (workers.has(marker.workerId)) continue;
        if (!isTerminalStatus(marker.status)) {
          // Live at crash time: honest unknown-state. Never replayed,
          // never resumed, never invented. Stream key stays free so the
          // dispatcher may re-dispatch. Transcript pointer falls back to
          // the worker id (child session id) when no settle landed.
          // Ticket 59 (register B-1): the record keeps the stream key
          // occupied. The comment above used to end "stream key stays free so
          // the dispatcher may re-dispatch" — that is exactly the hazard: the
          // worker may still be alive, and we threw away the only handle.
          const hold: UnknownStateWorker = {
            workerId: marker.workerId,
            parentSessionId: marker.parentSessionId,
            streamKey: marker.streamKey,
            title: marker.title,
            lastKnownStatus: marker.status,
            transcriptRef: marker.transcriptRef ?? marker.workerId,
            todoId: marker.todoId,
          };
          unknownState.push(hold);
          unknownStateHolds.set(hold.workerId, hold);
          continue;
        }
        // Terminal marker: restore onto the roster. toolCallCount is live
        // and deliberately not durable. Stream key stays free (terminal).
        const record: WorkerRecord = {
          workerId: marker.workerId,
          parentSessionId: marker.parentSessionId,
          streamKey: marker.streamKey,
          title: marker.title,
          status: marker.status,
          startedAtMs: marker.startedAtMs,
          toolCallCount: 0,
          transcriptRef: marker.transcriptRef,
          todoId: marker.todoId,
          // Continue the same redrive budget across the restart (D-5). A
          // missing field means a marker written before ticket 58 → 0.
          redriveAttempts: marker.redriveAttempts ?? 0,
        };
        workers.set(record.workerId, record);
        // Recreate the dispatcher ledger link so reconcile can notice an
        // undelivered result and finish delivery (S4). Aborted workers
        // owe nothing — skip.
        if (
          marker.status !== "aborted" &&
          marker.todoId !== null &&
          todoLedger.get(marker.todoId) === undefined
        ) {
          todoLedger.create({
            sessionId: marker.parentSessionId,
            id: marker.todoId,
            title: marker.title,
            status: "in_progress",
            streamKey: marker.streamKey,
            // Restore the spent budget too — otherwise every restart would
            // hand the obligation a fresh set of redrives (D-5).
            redriveAttempts: marker.redriveAttempts ?? 0,
            // Ticket 113: the inbox origin rides the marker so the rebuilt
            // item keeps its delivery routing (and re-present dedupe works).
            ...(marker.external ? { external: marker.external } : {}),
            nowMs: marker.updatedAtMs,
          });
          todoLedger.linkWorker(
            marker.todoId,
            marker.workerId,
            marker.streamKey,
          );
        }
        restored.push(record);
      }
      // Restored entries re-join the visible roster (ticket 21 observer);
      // unknown-state rows never land on the roster, so no notification.
      if (restored.length > 0) {
        notifyRosterChanged(parentSessionId);
      }
      return { restored, unknownState };
    },

    listUnknownStateHolds(
      parentSessionId?: string,
    ): readonly UnknownStateWorker[] {
      const holds = [...unknownStateHolds.values()];
      // Optional filter: a dispatcher normally asks for its own session only.
      if (parentSessionId === undefined) return holds;
      return holds.filter((hold) => hold.parentSessionId === parentSessionId);
    },

    async releaseUnknownStateHold(workerId: string): Promise<boolean> {
      const hold = unknownStateHolds.get(workerId);
      if (hold === undefined) return false;
      unknownStateHolds.delete(workerId);
      // Drop the marker too. The in-memory release alone would unblock this
      // boot but the marker would rebuild the hold on the next activation —
      // an unresolvable-remedy loop, which is worse than the block it fixes.
      if (durability !== undefined) {
        await Promise.resolve(durability.deleteWorkerMarker(workerId));
      }
      return true;
    },

    wakeBus,
    todos: todoLedger,
    sendPeer(sessionId: string, envelope: PeerEnvelope): PeerSendAck {
      // Ticket 70 §2 fences, BEFORE the inbox (whose lazy per-session state
      // would otherwise materialize a phantom target). Self-target is
      // unconditional: the sender's claimed session (the id the adapter
      // stamps from the registration closure) equal to the target session is
      // a self-loop with no reference warrant — refused as the honest
      // default. Unknown-target is produced only when the host wired the
      // liveness knob; absent callback keeps the shipped behavior.
      if (envelope.fromAgentId === sessionId) {
        return {
          ok: false,
          messageId: envelope.messageId,
          reason: "self-target",
          detail:
            "the target dispatcher session is the sender's own session; peer messages to yourself are refused",
        };
      }
      if (isLiveDispatcherSession !== undefined && !isLiveDispatcherSession(sessionId)) {
        return {
          ok: false,
          messageId: envelope.messageId,
          reason: "unknown-target",
          detail: `no live dispatcher session "${sessionId}" — the message was not delivered`,
        };
      }
      const result = peerInbox.send(sessionId, envelope);
      if (!result.ack.ok || !result.appended) {
        // Refusal or idempotent re-accept: never enqueue a second row.
        return result.ack;
      }
      // Lane placement uses the effective priority — the 1:1 flag itself
      // after the C14 retirement (ticket 70 §3).
      const priority = effectivePeerPriority(envelope);
      wakeBus.enqueuePeer({
        sessionId,
        notice: toPeerNotice(envelope, priority),
        effectivePriority: priority,
      });
      return result.ack;
    },
    listPendingPeers(sessionId: string): readonly PeerEnvelope[] {
      return peerInbox.listPending(sessionId);
    },
    peerInbox,
    resolveAccess(workerId: string, decision: AccessDecision): boolean {
      const resolved = accessRelay.resolve(workerId, decision);
      // Ticket 27: the pending-access set changed — re-project the roster
      // so the worker's blocked marker clears promptly.
      if (resolved) {
        const record = workers.get(workerId);
        if (record !== undefined) notifyRosterChanged(record.parentSessionId);
      }
      return resolved;
    },
    listPendingAccess(parentSessionId?: string): readonly AccessTicket[] {
      return accessRelay.listPending(parentSessionId);
    },
    clearSessionAccessPolicy(sessionId?: string): void {
      // Ticket 30 + ADR-0019: "always allow (this session)" rows must never
      // outlive their session. Deactivation clears only that session's rows;
      // plugin unload clears every session-scope row.
      accessPolicy.clearSession(sessionId);
      // Ticket 69 (chunk A): posture rows never outlive their session either
      // — same attribution rules, same call sites.
      reviewPosture.clearSession(sessionId);
    },
    accessPolicy,
    reviewPosture,
    settleRecords,
    cancelWaits(sessionId: string): void {
      settleRecords.cancelWaits(sessionId);
    },
    releaseWaits(sessionId: string, reason: AwaitReleasedReason): void {
      settleRecords.releaseWaits(sessionId, reason);
    },
    async awaitWorker(
      parentSessionId: string,
      workerId: string,
      timeoutMs: number | undefined,
      signal?: AbortSignal,
      _hooks?: AwaitWorkerHooks,
    ): Promise<AwaitWorkerOutcome> {
      // Order per ticket: bounds first, then the target resolution order
      // (self → own roster → live dispatcher → unknown), then the wait.
      const timeout = validateAwaitTimeout(timeoutMs);
      if (!timeout.ok) return timeout;
      const target = resolveAwaitTarget({
        callerSessionId: parentSessionId,
        targetId: workerId,
        getWorker: (id) => workers.get(id),
        ...(isLiveDispatcherSession !== undefined
          ? { isLiveDispatcherSession }
          : {}),
      });
      if (target.kind === "refused") return target.outcome;
      return settleRecords.wait(
        parentSessionId,
        workerId,
        timeout.timeoutMs,
        signal,
      );
    },
  };
}

export type {
  AccessDecision,
  AccessTicket,
  AwaitWorkerHooks,
  AwaitReleasedReason,
  AwaitWorkerOutcome,
  AwaitWorkerRefusal,
  CreateTodoInput,
  PeerEnvelope,
  PeerInbox,
  PeerInboxOptions,
  PeerSendAck,
  ReconcileReport,
  ReviewPostureTable,
  SettleRecord,
  SettleRecords,
  SpawnRequest,
  SpawnResult,
  SteerResult,
  StopResult,
  TodoExternalOrigin,
  TodoItem,
  TodoLedger,
  WorkerRecord,
  WorkerStatus,
  WorkerSummary,
};
export type { DurabilityPort, RebuildReport };
