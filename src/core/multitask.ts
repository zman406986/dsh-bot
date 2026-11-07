import type { DshHost } from "./dsh-host.js";
import {
  isTerminalStatus,
  type SettledEvent,
  type SpawnRequest,
  type SpawnResult,
  type SteerResult,
  type StopResult,
  type WorkerRecord,
  type WorkerStatus,
  type WorkerSummary,
} from "./types.js";
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
 * Why an unknown-state hold release did or did not happen. `not-held` is the
 * ordinary "this id holds no stream" answer; `hold-release-failed` is a real
 * store failure and deliberately distinct — reporting it as an unknown worker
 * would hide that the hold (and its stream key) is still occupied.
 */
export type UnknownStateReleaseOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not-held" | "hold-release-failed";
      readonly detail: string;
    };

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

/**
 * Ticket 108: wake-bus coalescing knobs (window size plus the clock and
 * scheduler seams).
 */
export interface MultitaskWakeOptions {
  /**
   * Idle-side coalescing window in ms. Default 0 = immediate delivery
   * (pre-108 semantics, unchanged). When >0, idle background/peer enqueues
   * share one per-session drain per window.
   */
  readonly coalesceWindowMs?: number;
  /** Injectable one-shot scheduler for tests. Returns a cancel function. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /** Consecutive coalesced-drain failures before degraded immediate mode. */
  readonly coalesceFailBudget?: number;
  /**
   * Called once when the bus degrades to immediate mode. Observer code: a
   * throw is swallowed, and a returned promise (accepted by the `void` return
   * type) is observed — telemetry can never break the bus.
   */
  readonly onDegraded?: (info: WakeBusDegradedInfo) => void;
}

/**
 * Ticket 115: await-waiter knobs (clock and scheduler seams).
 */
export interface MultitaskAwaitOptions {
  /** Injectable clock for tests. */
  readonly now?: () => number;
  /** Injectable one-shot scheduler for tests. Returns a cancel function. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

/**
 * Step-boundary steer delivery knobs.
 *
 * A failed `sendMessage` leaves the correction parked (it was peeked, not
 * popped) and the worker in `steering`. The next step boundary retries it, but
 * a worker that has gone idle emits no further boundary — so the core also
 * schedules a small bounded retry of its own. Bounded on purpose: a dead host
 * seam must not become an endless timer loop, and the next boundary still
 * retries after the bound is spent.
 */
export interface MultitaskSteerOptions {
  /** Delay before one retry attempt, in ms. Default 100. */
  readonly retryDelayMs?: number;
  /** Retry attempts per failure burst. Default 2 (the next boundary still retries). */
  readonly maxRetries?: number;
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
  /** Wake-bus coalescing configuration (ticket 108; window, test seams). */
  readonly wake?: MultitaskWakeOptions;
  /** Peer inbox knobs (ticket 14). */
  readonly peer?: PeerInboxOptions;
  /**
   * Roster-change observer (tickets 21 + 27). Fired after every
   * roster-affecting mutation — spawn, accepted FSM transition
   * (turn/steer/abort/settle), durability restore, todo reconcile, and a
   * todo flipping to delivered (the delivered flag) — with the affected
   * parent session id. Fire-and-forget: observer errors are swallowed so
   * telemetry can never break core flow. An async observer is accepted too;
   * its rejection is swallowed for the same reason. The observer only READS
   * the core back to project a snapshot; the core keeps no snapshot state (no
   * second store) and no presence state (design-17 §5 conflict 8: presence is
   * a projection of existing truth).
   */
  readonly onRosterChanged?: (
    parentSessionId: string,
  ) => void | Promise<void>;
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
   * Ticket 138 (owner ruling 2026-10-22: "bots should be wake-able, both
   * dispatchers and children"): the DURABLE half of the same question. True
   * when the session carries our own `dispatcher_sessions` mark — i.e. this
   * plugin spawned it as a dispatcher in an earlier process. A marked target
   * that is not live is not a phantom: it is a spawned dispatcher the host
   * has not cold-resumed yet, so the send is ACCEPTED and the wake path
   * resumes it (the adapter's `requestDispatcherWakeup`). A target with no
   * mark keeps ticket 70 §2's `unknown-target` refusal — the fence is intact.
   *
   * Synchronous by design: the peer fence is synchronous and must not await
   * a store read. The adapter keeps a warm in-memory set of marks.
   */
  readonly isDurablyMarkedDispatcher?: (sessionId: string) => boolean;
  /**
   * Ticket 142 (owner ruling 2026-10-22 — the CHILDREN half): the durable
   * wake identity of a worker this plugin spawned, read synchronously from
   * the adapter's mirror of the `worker_sessions` table. Present means "this
   * id is a worker we spawned and it has a spawner we can resume from".
   *
   * A marked id that is NOT on the live roster is not unknown: it is a
   * dormant worker, so `steerWorker` accepts the correction and the host's
   * `wakeDormantWorker` cold-resumes it. An id with no row (or a store with
   * no such table) keeps the shipped `unknown-worker` refusal — ticket 70's
   * fence is untouched.
   *
   * Synchronous for the same reason as the dispatcher port: the fence must
   * not await a store read.
   */
  readonly findDurableWorker?: (
    workerId: string,
  ) => { readonly parentSessionId: string } | undefined;
  /**
   * Ticket 113: fired when an inbox-origin obligation reaches a terminal
   * outcome — `replied` (worker settled AND the result was delivered via
   * `markDelivered`), `failed` (worker error, delivery or not), or
   * `cancelled` (abort, delivery or not). The hook is injected like
   * `onRosterChanged` so the core never touches the filesystem; a throwing
   * hook is swallowed — it must never break the settle path. It may return a
   * promise (the plugin's fs write is async); a rejection is swallowed the
   * same way. The plugin's implementation writes `reply.md`/`status.json`
   * atomically and surfaces its own write failures honestly.
   */
  readonly onInboxJobResolved?: (
    resolution: InboxJobResolution,
  ) => void | Promise<void>;
  /** Await-waiter configuration (ticket 115; test seams). */
  readonly awaits?: MultitaskAwaitOptions;
  /** Step-boundary steer delivery configuration (bounded failed-send retry). */
  readonly steer?: MultitaskSteerOptions;
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
   *
   * Ticket 142 (owner ruling 2026-10-22 — children half): the one exception is
   * a worker the adapter reports through `findDurableWorker` as a session this
   * plugin spawned whose spawner is known. Such a worker is not unknown, so
   * the correction is ACCEPTED and handed to `host.wakeDormantWorker`, which
   * cold-resumes the session and delivers it as its next steer. An id with no
   * durable row keeps the shipped `unknown-worker` refusal.
   */
  steerWorker(workerId: string, message: string): Promise<SteerResult>;
  /**
   * Ticket 142: re-adopt a worker the host just brought back from the dormant
   * state (a cold resume announced on `agent/created`). The adapter calls this
   * once, after it has registered the worker and composed the child, with the
   * id and the spawner read off the durable row.
   *
   * It resolves the ticket-59 unknown-state hold for that id into a live
   * roster record — the hold says "we cannot tell whether this worker is
   * alive", and a session the host just re-created is evidence that it is —
   * so `check_workers` lists it again and `stop_worker` can interrupt it.
   * Returns false when the id was not held (a worker already on the roster is
   * left untouched).
   */
  reclaimWorker(workerId: string, parentSessionId: string): boolean;
  /**
   * First turn started: spawned → running. Marks any linked todo in_progress.
   * No-op if illegal. An edge observed while an adopted worker's marker is
   * still loading is buffered and replayed by the rebuild (ticket 190).
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
   * Ticket 142: the spawner recorded on a worker's durable wake row, or
   * undefined when the id carries no row (never spawned by us, already
   * terminal, or abandoned). Synchronous — the adapter mirrors the table.
   * `message_agent` consults it to route a dormant worker to the steer
   * branch and to keep refusing ANOTHER session's worker as `unknown-target`
   * without leaking that it exists.
   */
  durableWorkerParent(workerId: string): string | undefined;
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
   *
   * Idempotent: a repeat call on an already-delivered item returns true and
   * changes nothing — one obligation must not fire the roster projection or
   * the inbox `replied` resolution twice.
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
   * avoid. Returns false when nothing was held under that id, and also when
   * the marker could not be dropped: the hold then stays in place so memory
   * and disk agree rather than reporting a release the next activation undoes.
   *
   * Async because the marker deletion is: resolving the hold but leaving the
   * marker behind would resurrect it on the next activation, so "released"
   * must not be reported before the marker is actually gone.
   */
  releaseUnknownStateHold(workerId: string): Promise<boolean>;
  /**
   * The same release, with the reason attached. `releaseUnknownStateHold`
   * collapses "nothing was held" and "the store refused the drop" into
   * `false`; a caller that wants to report the failure truthfully (rather
   * than as an unknown worker) needs them distinguished. `hold-release-failed`
   * means the hold is still in place: memory and disk agree, and a later call
   * can retry.
   */
  releaseUnknownStateHoldOutcome(
    workerId: string,
  ): Promise<UnknownStateReleaseOutcome>;
  /**
   * Wake bus this core enqueues settles through. Settles are batched per
   * parent session; a mid-turn dispatcher queues rather than receiving an
   * injected wake. Callers use it to note dispatcher turn bounds, drain
   * wakes, and enqueue user/peer/timer wakes.
   */
  readonly wakeBus: WakeBus;
  /**
   * Release this core's timers on teardown: the wake bus's armed coalescing
   * window (ticket 112 — a stale timer that still fires is a
   * generation-checked no-op, so no wake can reach a host that is being
   * disposed). Pending wake data is untouched — delivery was always the
   * caller's business. Idempotent.
   */
  dispose(): void;
  /**
   * Fire-and-forget peer accept (ticket 14; fences ticket 70 §2). Returns a
   * structural ack only — never a reply. Newly accepted envelopes join the
   * priority or normal lane by the 1:1 priority flag; delivery is wake-bus +
   * host followup. Self-targets refuse unconditionally; a target that is not
   * a live dispatcher refuses `unknown-target` when `isLiveDispatcherSession`
   * is wired — UNLESS `isDurablyMarkedDispatcher` says the session carries
   * our own durable dispatcher mark (ticket 138, owner ruling 2026-10-22):
   * then it is accepted and the host's wake path cold-resumes it.
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
   * A roster record already terminal with no settle record (a stopped worker,
   * a rebuild-restored terminal row) resolves `settled` immediately with an
   * empty result — waiting the timeout would report a live worker that is
   * provably not live.
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
  const isDurablyMarkedDispatcher = options?.isDurablyMarkedDispatcher;
  const findDurableWorker = options?.findDurableWorker;
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
  /**
   * Ticket 142: workers the host adopted back (a cold resume on send) for
   * which THIS core had no unknown-state hold yet — the narrow window where a
   * send lands before the activation chain's `rebuildFromDurability` finishes.
   * The rebuild consults this so the marker restores a normal live record
   * instead of turning live evidence into a hold that would block the stream
   * key forever.
   */
  const adoptedAwaitingMarker = new Map<string, string>();
  /**
   * Settles that arrived after the host adopted a worker back but before
   * `rebuildFromDurability` restored its record. The settle callback finds no
   * roster record, and dropping the event would leave the rebuilt worker live
   * with its terminal result (and stream key) lost. First settle wins, exactly
   * like the normal path (a duplicate settle is ignored by `transition`).
   * Only ids in {@link adoptedAwaitingMarker} are buffered: a settle for a
   * genuinely unknown id is not ours to invent a record for.
   */
  const pendingSettles = new Map<string, SettledEvent>();
  /**
   * Ticket 190: first-turn running edges observed after the host adopted a
   * worker back but before `rebuildFromDurability` restored its record — the
   * same adopt-before-rebuild window `pendingSettles` covers, for the live
   * edge instead of the terminal one. The rebuild replays the edge onto the
   * record it creates, so a resumed turn is not silently left `spawned`.
   */
  const pendingTurnStarts = new Set<string>();
  /**
   * Worker ids with a step-boundary steer send in flight. Two boundaries can
   * arrive inside one send window; the second must not send the same parked
   * correction again.
   */
  const steerSendInFlight = new Set<string>();
  /**
   * Ticket 195: worker ids where a step boundary arrived while a steer send
   * was in flight. That boundary is the only delivery opportunity a newer
   * correction parked during the send would otherwise get, so the successful
   * send drains the newer slot instead of waiting for an unrelated boundary.
   */
  const steerBoundaryDeferred = new Set<string>();
  /** Armed bounded retry for a failed steer send, keyed by worker id. */
  const steerRetryTimers = new Map<string, () => void>();
  /** Retries already spent in the current failure burst. */
  const steerRetryAttempts = new Map<string, number>();
  const steerOptions = options?.steer;
  const steerRetryDelayMs = steerOptions?.retryDelayMs ?? 100;
  const steerMaxRetries = steerOptions?.maxRetries ?? 2;
  const steerSchedule =
    steerOptions?.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });
  const steerQueue: SteerQueue = createSteerQueue();
  const todoLedger: TodoLedger = createTodoLedger();
  /**
   * Ticket 198: the first restart rebuild seeds the generated todo id
   * sequence from the whole marker table (once). Until it succeeds, a later
   * rebuild retries; restoreLedgerLink's foreign-owner branch is the safety
   * net when the store cannot answer or a todo was created too early.
   */
  let durableTodoIdsReserved = false;
  const peerInbox: PeerInbox = createPeerInbox(options?.peer);
  // Ticket 108: coalescing knobs flow through conditionally spread so an
  // unset option stays truly absent (the bus applies its own defaults).
  const wakeOptions = options?.wake;
  const wakeBus: WakeBus = createWakeBus({
    ...(wakeOptions?.coalesceWindowMs !== undefined
      ? { coalesceWindowMs: wakeOptions.coalesceWindowMs }
      : {}),
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
      //
      // Return the host promise: the bus owns the rejection (and counts it
      // toward its degrade budget). A discarded `void` here made a failed
      // host wake an unhandled rejection that dsh treats as fatal.
      return host.requestDispatcherWakeup(sessionId, origin);
    },
    onInterrupt: (sessionId) => {
      // Soft-fallback hosts may omit the seam — priority still becomes
      // the ready wake and wins the next flush.
      if (typeof host.requestDispatcherInterrupt === "function") {
        return host.requestDispatcherInterrupt(sessionId);
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
  // Ticket 115: per-target settle records + bounded await waiters. Knobs
  // flow through conditionally spread so an unset option stays truly absent.
  const awaits = options?.awaits;
  const settleRecords: SettleRecords = createSettleRecords({
    ...(awaits?.now !== undefined ? { now: awaits.now } : {}),
    ...(awaits?.schedule !== undefined ? { schedule: awaits.schedule } : {}),
    ...(options?.isAgentAlive !== undefined
      ? { isAgentAlive: options.isAgentAlive }
      : {}),
  });
  /**
   * Log one best-effort failure. The core has already committed its state
   * when these run (a spawn was accepted, a worker settled), so the failure
   * is reported and owned here; it is never rethrown and never becomes an
   * unhandled rejection.
   */
  function warnBestEffort(what: string, error: unknown): void {
    try {
      console.warn(`[multitask-dispatcher] ${what}:`, error);
    } catch {
      // A broken console must not break the core path either.
    }
  }

  /**
   * Run one best-effort durability write/drop and own its failure. The
   * marker store is external I/O whose methods are `void | Promise<void>`,
   * so both a synchronous throw and a rejected promise are possible. A
   * discarded rejection is an unhandled rejection, which dsh treats as
   * fatal — bookkeeping must never take the process (or the settle path)
   * down with it.
   */
  function durabilityBestEffort(
    what: string,
    run: () => void | Promise<void>,
  ): void {
    try {
      const result = run();
      if (result === undefined) return;
      void Promise.resolve(result).catch((error: unknown) => {
        warnBestEffort(what, error);
      });
    } catch (error) {
      warnBestEffort(what, error);
    }
  }

  /** Fire the roster observer (ticket 21); never lets it break core flow. */
  function notifyRosterChanged(parentSessionId: string): void {
    const observer = options?.onRosterChanged;
    if (observer === undefined) return;
    try {
      const result = observer(parentSessionId);
      if (result !== undefined) {
        // An async observer is observed, not discarded: a rejection must not
        // surface as an unhandled rejection either.
        void Promise.resolve(result).catch(() => {
          // Telemetry must never break the core.
        });
      }
    } catch {
      // Telemetry must never break the core.
    }
  }

  /**
   * Ticket 142: a worker became terminal or was abandoned, so it must stop
   * being wake-able. Drops the durable `worker_sessions` row AND the adapter's
   * in-memory mirror (through the host seam) so a send arriving in the same
   * process cannot park against a dead worker. Both halves are best-effort:
   * the settle/stop path must never fail on bookkeeping.
   */
  function forgetWorkerWake(workerId: string): void {
    adoptedAwaitingMarker.delete(workerId);
    pendingTurnStarts.delete(workerId);
    try {
      host.forgetWorkerWake?.(workerId);
    } catch {
      // A host mirror failure must not break the settle path.
    }
    if (durability === undefined) return;
    durabilityBestEffort(
      `worker session row for ${workerId} could not be dropped`,
      () => durability.deleteWorkerSession?.(workerId),
    );
  }

  /**
   * Ticket 113: fire the inbox resolution hook. Same swallow discipline as
   * the roster observer — a throwing (or rejecting) hook (the plugin's own
   * fs writes live behind it) must never break the settle or delivery path.
   */
  function fireInboxHook(resolution: InboxJobResolution): void {
    const hook = options?.onInboxJobResolved;
    if (hook === undefined) return;
    try {
      const result = hook(resolution);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {
          // The plugin surfaces its own failures; the core stays unaffected.
        });
      }
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
   * Best-effort drop of a worker's durable obligation marker after delivery.
   * Dropping a marker that is already absent is a no-op, so this is safe to
   * repeat — which is what lets `markDelivered` retry a transient store
   * failure on an already-delivered item without re-firing its one-shot side
   * effects.
   */
  function dropObligationMarker(workerId: string | null): void {
    if (durability === undefined || workerId === null) return;
    durabilityBestEffort(
      `worker marker for ${workerId} could not be dropped`,
      () => durability.deleteWorkerMarker(workerId),
    );
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

  /**
   * Ticket 190: the first-turn edge and its side effects, shared by the host
   * status handler and the rebuild's replay of an edge observed before the
   * adopted worker's record existed. Advancing the FSM also promotes the
   * linked todo (spawn → in_progress), exactly like `noteTurnStarted`.
   */
  function applyTurnStarted(workerId: string): void {
    const next = transition(workerId, { type: "turn-started" });
    if (next === undefined) return;
    const record = workers.get(workerId);
    if (record?.todoId != null) {
      todoLedger.markInProgress(record.todoId);
    }
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

  /**
   * Ticket 198: reserve every todo id any durable marker still points at,
   * including a sibling dispatcher that has not been rebuilt yet. Recovery
   * is lazy and parent-scoped, while the generated id sequence is process-
   * local, so without this a new todo created after rebuilding A can take
   * the id B's marker owns; B's restore then finds a foreign row instead of
   * its own obligation. Best-effort: a store without the listing seam, or a
   * failed read, leaves restoreLedgerLink's collision path as the safety
   * net.
   */
  async function reserveDurableTodoIds(): Promise<void> {
    if (durableTodoIdsReserved || durability === undefined) return;
    try {
      const listed = durability.listWorkerMarkers?.();
      if (listed === undefined) return;
      for (const marker of await Promise.resolve(listed)) {
        if (marker.todoId !== null) todoLedger.reserveId(marker.todoId);
      }
      durableTodoIdsReserved = true;
    } catch (error) {
      warnBestEffort(
        "durable worker markers could not be listed for todo id reservation",
        error,
      );
    }
  }

  /**
   * Recreate the dispatcher ledger link for a worker restored from durable
   * state (ticket 59 / 142). The roster record alone is not enough: without
   * the item the ledger forgets what the worker was doing, so reconcile can
   * neither notice an undelivered result (S4) nor continue the item's redrive
   * budget (D-5). An existing item is never duplicated, and `aborted` workers
   * owe nothing — callers skip those before calling.
   */
  function restoreLedgerLink(args: {
    readonly workerId: string;
    readonly sessionId: string;
    readonly title: string;
    readonly streamKey: string;
    readonly todoId: string | null;
    /**
     * `pending` when the worker had not taken its first turn yet; every other
     * restored live state was already in progress.
     */
    readonly status: "pending" | "in_progress";
    readonly redriveAttempts: number;
    readonly external?: TodoExternalOrigin;
    readonly nowMs?: number;
  }): void {
    if (args.todoId === null) return;
    const existing = todoLedger.get(args.todoId);
    // An item this same session already restored IS the link (ticket 151):
    // never duplicate it. An item owned by ANOTHER session is not (ticket
    // 198): that id is what the process-local sequence handed out before the
    // sibling recovered, and adopting it would silently move this worker's
    // obligation onto a foreign row. Fall through and re-link under a fresh
    // generated id instead.
    if (existing !== undefined && existing.sessionId === args.sessionId) return;
    const todo = todoLedger.create({
      sessionId: args.sessionId,
      ...(existing === undefined ? { id: args.todoId } : {}),
      title: args.title,
      status: args.status,
      streamKey: args.streamKey,
      // Continue the same budget across the restart (D-5); a missing durable
      // value reads as 0.
      redriveAttempts: args.redriveAttempts,
      ...(args.external !== undefined ? { external: args.external } : {}),
      ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
    });
    todoLedger.linkWorker(todo.id, args.workerId, args.streamKey);
    if (todo.id === args.todoId) return;
    // The re-link changed the id this worker owns. The roster record is the
    // live truth; write the corrected marker too (best-effort) so the next
    // restart does not have to relink again.
    const record = workers.get(args.workerId);
    if (record === undefined) return;
    record.todoId = todo.id;
    if (durability !== undefined) {
      durabilityBestEffort(
        `worker marker for ${args.workerId} could not be re-linked to ${todo.id}`,
        () =>
          durability.writeWorkerMarker(
            toDurableMarker(record, args.external ?? null),
          ),
      );
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

  /**
   * Apply one host settle to a live roster record: the FSM transition plus
   * every side effect the terminal path owns (todo close, durable marker, wake
   * row, settle record, wake enqueue). Extracted from the host callback so the
   * rebuild path can replay a settle buffered during the adopt-before-rebuild
   * window through the exact same code.
   *
   * Returns false when the transition was illegal (double settle, post-abort
   * settle), which is also what makes a replay idempotent.
   */
  function applySettle(event: SettledEvent): boolean {
    const next = transition(event.workerId, {
      type: "settled",
      status: event.status,
    });
    // Double settle and post-abort settles are ignored — never revive, never re-wake.
    if (next === undefined) return false;
    const record = workers.get(event.workerId);
    if (record === undefined) return false;
    if (event.transcriptRef !== undefined) {
      record.transcriptRef = event.transcriptRef;
    }
    // A settled worker has no delivery point left for a parked correction;
    // a retry timer for it must not fire against a terminal record.
    steerQueue.clear(event.workerId);
    clearSteerRetry(event.workerId);
    steerBoundaryDeferred.delete(event.workerId);
    // Aborted via settle: close the todo here; the wake still informs the dispatcher.
    // The marker obligation is closed too — nothing to reconstruct or deliver.
    if (event.status === "aborted") {
      cancelLinkedTodo(record);
      if (durability !== undefined) {
        durabilityBestEffort(
          `worker marker for ${record.workerId} could not be dropped`,
          () => durability.deleteWorkerMarker(record.workerId),
        );
      }
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
        //
        // Deliberately fire-and-forget, not awaited: `onWorkerSettled` is a
        // SYNCHRONOUS host callback, and the settle wake (enqueued below)
        // must keep its current ordering relative to other settles. The
        // catch keeps a store failure from becoming an unhandled rejection;
        // the remaining window is a crash between a failed write and the
        // wake, which delivery redrive covers like any other undelivered
        // result.
        durabilityBestEffort(
          `worker marker for ${record.workerId} could not be written`,
          () =>
            durability.writeWorkerMarker(
              toDurableMarker(record, todoExternalOf(record.todoId)),
            ),
        );
      }
    }
    // Ticket 142: every settle is terminal, and a finished worker must not be
    // woken back (ticket 04: stop is for good). Drop the durable wake row and
    // the adapter's mirror. The worker OBLIGATION marker above is untouched —
    // a terminal result may still be owed a delivery (S4, ticket 58).
    forgetWorkerWake(record.workerId);
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
    return true;
  }

  host.onWorkerSettled((event) => {
    // Ticket 142 race: the host adopted this worker back (a send landed
    // before the activation chain's rebuild finished), so the id is known but
    // its roster record does not exist yet. Losing the settle here would
    // rebuild the worker as live and keep its stream key occupied forever
    // even though it is provably done. Buffer it; the rebuild replays it as
    // soon as the record exists.
    if (
      workers.get(event.workerId) === undefined &&
      adoptedAwaitingMarker.has(event.workerId)
    ) {
      if (!pendingSettles.has(event.workerId)) {
        pendingSettles.set(event.workerId, event);
      }
      return;
    }
    applySettle(event);
  });

  /** Cancel a pending retry timer without touching the burst counter. */
  function cancelSteerRetryTimer(workerId: string): void {
    const cancel = steerRetryTimers.get(workerId);
    if (cancel === undefined) return;
    steerRetryTimers.delete(workerId);
    try {
      cancel();
    } catch {
      // A scheduler cancel failure must not break the delivery path.
    }
  }

  /** Cancel a pending retry timer and clear the burst counter for one worker. */
  function clearSteerRetry(workerId: string): void {
    cancelSteerRetryTimer(workerId);
    steerRetryAttempts.delete(workerId);
  }

  /**
   * Arm one bounded retry for a failed send. A worker that has gone idle emits
   * no further step boundary, so without this an accepted correction would
   * sit parked in `steering` forever. The bound is per failure burst; the next
   * real boundary is still a fresh opportunity after it is spent.
   */
  function scheduleSteerRetry(workerId: string): void {
    if (steerRetryTimers.has(workerId)) return;
    const spent = steerRetryAttempts.get(workerId) ?? 0;
    if (spent >= steerMaxRetries) return;
    steerRetryAttempts.set(workerId, spent + 1);
    const cancel = steerSchedule(() => {
      steerRetryTimers.delete(workerId);
      // `attemptSteerSend` owns its failure handling (no rejection escapes).
      // `fromRetry` keeps the burst counter: resetting it here would make the
      // bound infinite.
      void attemptSteerSend(workerId, true);
    }, steerRetryDelayMs);
    steerRetryTimers.set(workerId, cancel);
  }

  /**
   * Deliver the latest parked steer at a step boundary (or on a retry).
   * PEEK + send + conditional pop: the correction survives until the send
   * resolves, so a rejected send never leaves the worker stuck in `steering`
   * with the accepted correction gone. On success only OUR message is popped —
   * a newer steer that replaced the slot mid-send stays parked and the worker
   * stays `steering`. It is delivered by the next boundary, or immediately
   * when its own boundary already arrived during this send (ticket 195).
   *
   * Re-entrant boundaries are skipped while a send is in flight: two
   * boundaries inside one send window are one delivery point, and sending
   * twice would deliver the same correction twice. A skipped boundary is
   * remembered so a newer correction parked during the window is not stranded.
   */
  function attemptSteerSend(
    workerId: string,
    fromRetry = false,
  ): Promise<void> | undefined {
    const record = workers.get(workerId);
    if (record === undefined || record.status !== "steering") {
      clearSteerRetry(workerId);
      steerSendInFlight.delete(workerId);
      steerBoundaryDeferred.delete(workerId);
      return undefined;
    }
    const pending = steerQueue.peek(workerId);
    if (pending === undefined) {
      clearSteerRetry(workerId);
      steerSendInFlight.delete(workerId);
      steerBoundaryDeferred.delete(workerId);
      return undefined;
    }
    if (steerSendInFlight.has(workerId)) {
      // Ticket 195: remember that this boundary was consumed inside the send
      // window. If a newer correction replaced the slot meanwhile, the
      // success continuation below must deliver it — no later boundary is
      // guaranteed to arrive.
      steerBoundaryDeferred.add(workerId);
      return undefined;
    }
    // A real boundary supersedes an armed retry and starts a fresh burst; a
    // timer-driven retry keeps the burst counter so the bound is finite.
    if (fromRetry) {
      cancelSteerRetryTimer(workerId);
    } else {
      clearSteerRetry(workerId);
    }
    steerSendInFlight.add(workerId);
    const onFailure = (error: unknown): void => {
      steerSendInFlight.delete(workerId);
      // The failed send keeps its parked correction, and the retry (or the
      // next boundary) is its delivery path; a deferred boundary is spent.
      steerBoundaryDeferred.delete(workerId);
      // The correction was never delivered, so it remains parked (or was
      // already replaced by a newer one — last-wins). The worker stays
      // `steering`; the retry below (and the next boundary) try again. Never
      // reject out of the callback: the host's boundary hook must not see an
      // unhandled rejection.
      warnBestEffort(
        `steer for ${workerId} could not be delivered; it stays parked`,
        error,
      );
      scheduleSteerRetry(workerId);
    };
    let result: void | Promise<void>;
    try {
      result = host.sendMessage(workerId, wrapParentCorrection(pending));
    } catch (error) {
      onFailure(error);
      return undefined;
    }
    return Promise.resolve(result).then(
      () => {
        steerSendInFlight.delete(workerId);
        clearSteerRetry(workerId);
        const replaced = steerQueue.peek(workerId) !== pending;
        if (!replaced) steerQueue.pop(workerId);
        // A newer correction arrived while this send was in flight. Its step
        // boundary may already have arrived and been skipped: if so, this is
        // its delivery opportunity, so drain it now rather than stranding it
        // until an unrelated later boundary. With no newer correction the
        // worker is back to `running`.
        if (steerQueue.peek(workerId) === undefined) {
          steerBoundaryDeferred.delete(workerId);
          transition(workerId, { type: "steer-injected" });
        } else if (steerBoundaryDeferred.delete(workerId)) {
          void attemptSteerSend(workerId);
        }
      },
      onFailure,
    );
  }

  host.onStepBoundary((workerId) => attemptSteerSend(workerId));

  /**
   * The one release implementation behind both public shapes. The boolean
   * shape cannot distinguish "nothing was held" from "the store refused the
   * drop"; that distinction is what lets `stop_worker` report a real store
   * failure instead of claiming the worker is unknown.
   */
  async function releaseHold(
    workerId: string,
  ): Promise<UnknownStateReleaseOutcome> {
    const hold = unknownStateHolds.get(workerId);
    if (hold === undefined) {
      return {
        ok: false,
        reason: "not-held",
        detail: `no unknown-state hold for worker ${workerId}`,
      };
    }
    // Drop the marker FIRST, while the in-memory hold still exists. The
    // in-memory release alone would unblock this boot but the marker would
    // rebuild the hold on the next activation — an unresolvable-remedy
    // loop, which is worse than the block it fixes. Deleting memory first
    // made a store failure leave exactly that disagreement (memory says
    // released, disk says held); on failure the hold is kept and
    // `hold-release-failed` reports that nothing was released.
    if (durability !== undefined) {
      try {
        await Promise.resolve(durability.deleteWorkerMarker(workerId));
      } catch (error) {
        warnBestEffort(
          `worker marker for ${workerId} could not be dropped; the hold was not released`,
          error,
        );
        return {
          ok: false,
          reason: "hold-release-failed",
          detail:
            `the durable marker for ${workerId} could not be dropped; ` +
            `the stream key is still held and the release can be retried`,
        };
      }
      // Ticket 142: the marker deletion answers "no delivery is owed"; the
      // wake row answers "this id is a worker we can wake" and must go too,
      // or the hold would be released while a send could still resurrect the
      // worker the dispatcher just abandoned.
      try {
        await Promise.resolve(durability.deleteWorkerSession?.(workerId));
      } catch (error) {
        warnBestEffort(
          `worker session row for ${workerId} could not be dropped`,
          error,
        );
      }
    }
    unknownStateHolds.delete(workerId);
    // The adapter's mirror goes with it, for the same reason.
    try {
      host.forgetWorkerWake?.(workerId);
    } catch {
      // Mirror failures never break the release.
    }
    return { ok: true };
  }

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
            // Ticket 285: the resolved route for THIS worker, forwarded only
            // when the tool actually resolved one. Omitting the key keeps a
            // host that does not implement the option on exactly today's
            // inheritance path (the leader's worker default, then its own
            // live route).
            ...(request.model !== undefined ? { model: request.model } : {}),
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
        // before the spawn resolves — but BEST-EFFORT: the host already
        // accepted the spawn, so a store failure is logged, never rethrown
        // as a failed spawn (which would also report a dead spawn for a live
        // child and hold the stream key). Ticket 113: the inbox origin rides
        // the marker so a rebuild can re-create the ledger link with it.
        //
        // A worker that already SETTLED while the spawn was in flight is
        // skipped: its settle path wrote the terminal marker, and rewriting
        // a live snapshot here would be a stale overwrite.
        //
        // The status comes from the CURRENT record: an early `running` edge
        // may already have advanced it while the spawn was in flight, and a
        // live snapshot still holds the stream key across a restart.
        if (durability !== undefined) {
          if (!isTerminalStatus(record.status)) {
            try {
              await Promise.resolve(
                durability.writeWorkerMarker(
                  toDurableMarker(record, todoExternalOf(record.todoId)),
                ),
              );
            } catch (error) {
              warnBestEffort(
                `worker marker for ${workerId} could not be written`,
                error,
              );
            }
          }
          // Ticket 142: the durable WAKE identity, beside the obligation
          // marker but a separate row with a separate lifecycle. Written at
          // the same moment (after the spawn resolved — there is no id to key
          // on before that) so a send to this worker can wake it after a
          // restart. A store without the table keeps the pre-142 refusal.
          //
          // The host mirror is fed FIRST, synchronously, so a send arriving
          // before the store write settles already sees the mark (same rule
          // as the dispatcher mark).
          //
          // A worker that already SETTLED while the spawn was in flight is
          // skipped: the settle path dropped its wake row, and re-writing it
          // here would make a finished worker wake-able again (ticket 04).
          if (!isTerminalStatus(record.status)) {
            try {
              host.rememberWorkerWake?.(workerId, request.parentSessionId);
            } catch {
              // A mirror failure must not break an accepted spawn.
            }
            try {
              await Promise.resolve(
                durability.writeWorkerSession?.({
                  sessionId: workerId,
                  parentSessionId: request.parentSessionId,
                }),
              );
            } catch (error) {
              // The host already accepted the spawn; a store failure must
              // never read as a refusal. The lost row is the accepted crash
              // window, one step wider.
              try {
                console.warn(
                  `[multitask-dispatcher] worker session row for ${workerId} could not be written:`,
                  error,
                );
              } catch {
                // A broken console must not break the spawn either.
              }
            }
          }
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
      clearSteerRetry(workerId);
      steerBoundaryDeferred.delete(workerId);
      // Aborted → cancelled on the ledger (and pruned; dsh has no cancelled).
      cancelLinkedTodo(record);
      // Marker obligation closed: nothing to deliver after a restart.
      if (durability !== undefined) {
        durabilityBestEffort(
          `worker marker for ${workerId} could not be dropped`,
          () => durability.deleteWorkerMarker(workerId),
        );
      }
      // Ticket 142: and the wake identity goes with it — a stopped worker is
      // not wake-able (ticket 04). Done BEFORE the interrupt so a settle that
      // races the stop cannot leave a row behind either.
      forgetWorkerWake(workerId);
      // Mark first, then interrupt: a late host settle must not revive the worker.
      // The stop path never sends a user-facing message.
      try {
        await host.interruptWorker(workerId);
      } catch (error) {
        // The abort is already COMMITTED (terminal status, parked steer
        // dropped, markers closed). A host interrupt failure cannot undo
        // that, and reporting a failed stop would be a lie about the state
        // the core now holds; it is logged instead.
        warnBestEffort(`interrupt for stopped worker ${workerId} failed`, error);
      }
      return { ok: true };
    },

    async steerWorker(workerId: string, message: string): Promise<SteerResult> {
      const record = workers.get(workerId);
      if (record === undefined) {
        // Ticket 142 (owner ruling 2026-10-22 — children half): a worker id
        // this plugin durably spawned is not unknown just because it carries
        // no roster record. It is dormant — a live marker became an
        // unknown-state hold at rebuild, or the child was never re-announced
        // this boot — so the correction is ACCEPTED and the host cold-resumes
        // the session through `wakeDormantWorker`. An id with NO durable row
        // keeps the shipped refusal, byte-identical to before this ticket.
        const durable = findDurableWorker?.(workerId);
        if (durable !== undefined) {
          const wake = host.wakeDormantWorker;
          if (wake !== undefined) {
            // Accepted either way: the mark is the whole permission. A wake
            // that cannot be issued is the host's to log (it keeps the text
            // parked for the next activation); it never becomes a refusal.
            await wake.call(host, workerId, wrapParentCorrection(message));
            return { ok: true, dormant: true };
          }
        }
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
        try {
          await host.interruptWorker(workerId);
        } catch (error) {
          // The steer is already ACCEPTED (parked, `steering`): the interrupt
          // only makes the delivery point arrive sooner, and the host's own
          // step boundary still delivers it. A rejected stop never turns an
          // accepted correction into a failed steer.
          warnBestEffort(
            `interrupt for steered worker ${workerId} failed; the correction stays parked`,
            error,
          );
        }
        // A settle may have raced the interrupt — a terminal worker keeps no
        // parked steer. A worker back in `running` is NOT terminal: that is a
        // successful delivery of an EARLIER steer, and this call's newer
        // correction must stay parked for the next boundary. Clearing on
        // "not steering" would drop that newer correction (the bug this
        // guard replaces).
        const current = workers.get(workerId);
        if (current !== undefined && isTerminalStatus(current.status)) {
          steerQueue.clear(workerId);
          clearSteerRetry(workerId);
          steerBoundaryDeferred.delete(workerId);
        }
      }
      // Already steering: a delivery is pending; it will pick up this message.
      return { ok: true };
    },

    noteTurnStarted(workerId: string): void {
      if (!workers.has(workerId)) {
        // Ticket 190: the edge can land after the host adopted this worker but
        // before the rebuild's marker read resolves. Buffer it exactly like a
        // settle; the rebuild replays it onto the record it creates. An id with
        // no adoption evidence is still ignored.
        if (adoptedAwaitingMarker.has(workerId)) {
          pendingTurnStarts.add(workerId);
        }
        return;
      }
      applyTurnStarted(workerId);
    },

    reclaimWorker(workerId: string, parentSessionId: string): boolean {
      // Ticket 142: a host announcement brought this session back. Only a held
      // id is adopted — a worker already on the roster (or one this core never
      // saw) is left exactly as it is, so a re-announcement cannot reset a
      // live record's status, stream key, or redrive budget.
      const hold = unknownStateHolds.get(workerId);
      if (hold === undefined) {
        // A worker already on the roster needs nothing (the host re-announced
        // a live session). One this core has not seen yet may be a
        // send-before-rebuild: the host has just proved the worker live, so
        // remember it and let the pending rebuild restore a live record
        // instead of turning that evidence into a stream-key hold.
        if (!workers.has(workerId)) {
          adoptedAwaitingMarker.set(workerId, parentSessionId);
        }
        return false;
      }
      if (hold.parentSessionId !== parentSessionId) return false;
      adoptedAwaitingMarker.delete(workerId);
      unknownStateHolds.delete(workerId);
      workers.set(workerId, {
        workerId,
        parentSessionId,
        streamKey: hold.streamKey,
        title: hold.title,
        // The host re-created the session; it has not taken a turn yet in this
        // process, so `spawned` is the honest starting state — the first
        // `agent/status: running` advances it exactly like a fresh spawn.
        status: "spawned",
        // The hold carried no clock: elapsed time is measured from the new
        // activation rather than invented.
        startedAtMs: Date.now(),
        toolCallCount: 0,
        transcriptRef: hold.transcriptRef,
        todoId: hold.todoId,
        // The durable marker's spent budget rides the hold (D-5): a reclaim
        // must not hand the same obligation a fresh set of redrives.
        redriveAttempts: hold.redriveAttempts ?? 0,
      });
      // The roster is back but the ledger is not: recreate the item the
      // marker links to, exactly like the terminal rebuild path. A worker
      // the hold reports as not-yet-started has a pending item; anything
      // later was already in progress.
      restoreLedgerLink({
        workerId,
        sessionId: parentSessionId,
        title: hold.title,
        streamKey: hold.streamKey,
        todoId: hold.todoId,
        status:
          hold.lastKnownStatus === "spawned" ? "pending" : "in_progress",
        redriveAttempts: hold.redriveAttempts ?? 0,
        // Ticket 113: the hold carried the marker's inbox origin, so the
        // reclaimed item keeps its delivery routing and re-present dedupe.
        ...(hold.external !== undefined ? { external: hold.external } : {}),
      });
      // The stream key is held again by a LIVE worker — the same invariant a
      // fresh spawn establishes, and the reason ticket 59 exists.
      liveByStreamKey.set(
        liveStreamKeyId(parentSessionId, hold.streamKey),
        workerId,
      );
      notifyRosterChanged(parentSessionId);
      return true;
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

    durableWorkerParent(workerId: string): string | undefined {
      return findDurableWorker?.(workerId)?.parentSessionId;
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
      const before = todoLedger.get(todoId);
      if (before === undefined) return false;
      // A repeat call must be a no-op, not a second delivery: the ledger's
      // own markDelivered is not one-shot (it would log another delivered
      // event), and the side effects below (roster re-projection, the inbox
      // `replied` resolution) answer "this obligation just closed". Firing
      // them again for one obligation would publish a duplicate completion.
      // `true` because the item IS delivered — the second call changed
      // nothing and lost nothing.
      if (before.delivered) {
        // The marker drop IS idempotent and may have failed on the first call
        // (a transient store failure). Retrying it here is the difference
        // between a recoverable bookkeeping failure and an obligation that
        // resurrects on the next activation. No roster event and no second
        // `replied` resolution — those answer the close, not the cleanup.
        dropObligationMarker(before.workerId);
        return true;
      }
      const ok = todoLedger.markDelivered(todoId);
      if (!ok) return false;
      // Ticket 27: the delivered flag flipped — presence must re-project.
      const todo = todoLedger.get(todoId);
      if (todo !== undefined) notifyRosterChanged(todo.sessionId);
      // Delivery obligation closed — drop the durable marker for its worker.
      dropObligationMarker(todo?.workerId ?? null);
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
          durabilityBestEffort(
            `worker marker for ${record.workerId} could not be written`,
            () =>
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
      // Ticket 198: seed the generated todo id sequence from EVERY durable
      // marker before this parent's rebuild can hand out a new id. Recovery
      // is lazy and parent-scoped, so a sibling's marker is not otherwise
      // visible here until that sibling activates.
      await reserveDurableTodoIds();
      const markers = await Promise.resolve(
        durability.readWorkerMarkers(parentSessionId),
      );
      for (const marker of markers) {
        // Fresh-core assumption: never overwrite an in-memory entry.
        if (workers.has(marker.workerId)) continue;
        // Ticket 142: the host adopted this worker back while this rebuild was
        // still in flight (a send landed first). That is live evidence, so a
        // live marker restores a normal roster record instead of a hold —
        // which would otherwise block the stream key with a worker that is
        // provably running.
        if (adoptedAwaitingMarker.has(marker.workerId)) {
          adoptedAwaitingMarker.delete(marker.workerId);
          // Ticket 190: an observed first-turn running edge buffered while
          // this read was pending. Consumed here; replayed once the record
          // exists, before any buffered terminal settle.
          const observedRunning = pendingTurnStarts.delete(marker.workerId);
          const recovered: WorkerRecord = {
            workerId: marker.workerId,
            parentSessionId: marker.parentSessionId,
            streamKey: marker.streamKey,
            title: marker.title,
            status: "spawned",
            startedAtMs: Date.now(),
            toolCallCount: 0,
            transcriptRef: marker.transcriptRef,
            todoId: marker.todoId,
            redriveAttempts: marker.redriveAttempts ?? 0,
          };
          workers.set(recovered.workerId, recovered);
          liveByStreamKey.set(
            liveStreamKeyId(marker.parentSessionId, marker.streamKey),
            recovered.workerId,
          );
          // The roster is back but the ledger is not: recreate the linked
          // item so reconcile sees the work and keeps the inbox origin, and
          // carry the spent redrive budget like the terminal path does.
          restoreLedgerLink({
            workerId: marker.workerId,
            sessionId: marker.parentSessionId,
            title: marker.title,
            streamKey: marker.streamKey,
            todoId: marker.todoId,
            status: marker.status === "spawned" ? "pending" : "in_progress",
            redriveAttempts: marker.redriveAttempts ?? 0,
            ...(marker.external !== undefined
              ? { external: marker.external }
              : {}),
            nowMs: marker.updatedAtMs,
          });
          // Ticket 190: replay the buffered running edge through the normal
          // first-turn path (status, todo promotion, roster publish). A
          // buffered settle is applied AFTER it, so a worker that finished in
          // this window still ends terminal — the settle wins.
          if (observedRunning) {
            applyTurnStarted(recovered.workerId);
          }
          // A settle that landed inside the adopt-before-rebuild window was
          // buffered because no roster record existed yet. The record exists
          // now, so replay it through the normal terminal path: status,
          // marker, wake identity, settle record and wake all land exactly
          // once. The stream key set above is freed by the terminal
          // transition, which is the point: a provably finished worker must
          // not keep its stream occupied.
          const buffered = pendingSettles.get(marker.workerId);
          if (buffered !== undefined) {
            pendingSettles.delete(marker.workerId);
            applySettle(buffered);
          }
          restored.push(recovered);
          continue;
        }
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
            // The hold must carry the spent budget so a later reclaim of
            // this id continues the same lifetime bound (D-5).
            redriveAttempts: marker.redriveAttempts ?? 0,
            // Ticket 113: and the inbox origin, or a reclaim would recreate
            // the ledger item with no delivery routing and let the same job
            // be presented again as a new one.
            ...(marker.external !== undefined
              ? { external: marker.external }
              : {}),
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
        if (marker.status !== "aborted") {
          restoreLedgerLink({
            workerId: marker.workerId,
            sessionId: marker.parentSessionId,
            title: marker.title,
            streamKey: marker.streamKey,
            todoId: marker.todoId,
            status: "in_progress",
            // Restore the spent budget too — otherwise every restart would
            // hand the obligation a fresh set of redrives (D-5).
            redriveAttempts: marker.redriveAttempts ?? 0,
            // Ticket 113: the inbox origin rides the marker so the rebuilt
            // item keeps its delivery routing (and re-present dedupe works).
            ...(marker.external !== undefined
              ? { external: marker.external }
              : {}),
            nowMs: marker.updatedAtMs,
          });
        }
        restored.push(record);
      }
      // Nothing restored means there is no record to replay a buffered settle
      // into; holding it would leak an event for a worker this boot cannot
      // represent. The buffer is shared by every dispatcher on this core
      // instance, so only THIS parent's phantoms are ours to drop: a sibling's
      // buffered settle must survive until that sibling's own rebuild replays
      // it (ticket 191). The adoption record is the buffer entry's ownership
      // proof — an entry is only ever buffered for an adopted worker.
      for (const workerId of [...pendingSettles.keys()]) {
        if (workers.has(workerId)) continue;
        if (adoptedAwaitingMarker.get(workerId) === parentSessionId) {
          pendingSettles.delete(workerId);
        }
      }
      // Ticket 190: the same ownership rule for a buffered running edge whose
      // marker never restored a record — it must not leak into a later
      // rebuild (or a sibling's) and revive an unrelated worker.
      for (const workerId of [...pendingTurnStarts]) {
        if (workers.has(workerId)) continue;
        if (adoptedAwaitingMarker.get(workerId) === parentSessionId) {
          pendingTurnStarts.delete(workerId);
        }
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
      const outcome = await releaseHold(workerId);
      return outcome.ok;
    },

    releaseUnknownStateHoldOutcome(
      workerId: string,
    ): Promise<UnknownStateReleaseOutcome> {
      return releaseHold(workerId);
    },

    wakeBus,
    dispose(): void {
      // Ticket 112: teardown reaches the bus so a pending coalesced drain
      // can never open a turn on a host that is going away. Idempotent, so a
      // repeated teardown is safe.
      wakeBus.dispose();
      // No steer retry may outlive the core either.
      for (const workerId of [...steerRetryTimers.keys()]) {
        clearSteerRetry(workerId);
      }
      steerBoundaryDeferred.clear();
    },
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
        // Ticket 138 (owner ruling 2026-10-22): a target that carries our own
        // durable dispatcher mark is not a phantom. It is a spawned dispatcher
        // this process has not cold-resumed yet, so the send is accepted and
        // the wake path resumes it (the adapter reaches the host's
        // `subagents.sendMessage`, which cold-resumes an absent child). A
        // target with NO mark keeps ticket 70 §2's refusal — the fence still
        // holds for true phantoms.
        const durablyMarked =
          isDurablyMarkedDispatcher !== undefined &&
          isDurablyMarkedDispatcher(sessionId);
        if (!durablyMarked) {
          return {
            ok: false,
            messageId: envelope.messageId,
            reason: "unknown-target",
            detail: `no live dispatcher session "${sessionId}" — the message was not delivered`,
          };
        }
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
      // A terminal roster record with no settle record is a known outcome, not
      // a pending wait: the worker settled before the ring existed (a stop
      // that dropped its late settle, a rebuild-restored terminal row) and
      // blocking the full timeout would end in a false `still-running`.
      // Report the terminal status with no result text — the honest answer:
      // the result, if any, was never captured here.
      const record = workers.get(workerId);
      if (
        record !== undefined &&
        isTerminalStatus(record.status) &&
        settleRecords.lookup(parentSessionId, workerId) === undefined
      ) {
        return {
          ok: true,
          status: "settled",
          workerStatus: record.status,
          result: "",
          // No record survived, so the settle instant is unknown; the wait
          // observed it now and spent no time waiting.
          settledAtMs: Date.now(),
          waitedMs: 0,
        };
      }
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
