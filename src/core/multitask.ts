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
  createSteerQueue,
  type SteerQueue,
  wrapParentCorrection,
} from "./steer-queue.js";
import { createWakeBus, type WakeBus, type WakeEvent } from "./wake-bus.js";
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
  createTodoLedger,
  reconcileTodos,
  type CreateTodoInput,
  type ReconcileReport,
  type TodoItem,
  type TodoLedger,
} from "./todo-reconciler.js";
import {
  toDurableMarker,
  type DurabilityPort,
  type RebuildReport,
  type UnknownStateWorker,
} from "./durability.js";

/** A drained wake plus the reconcile report for that wake. */
export interface DrainedWake {
  readonly wake: WakeEvent;
  readonly reconcile: ReconcileReport;
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
  /** Ledger items for a session. Never passed into a worker. */
  listTodos(sessionId: string): TodoItem[];
  /**
   * Mark a todo delivered to the user and completed. Call only after a
   * successful user-facing send — completed means delivered (S4).
   */
  markDelivered(todoId: string): boolean;
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
   * Rebuild the live roster from durable markers only (ADR-0006).
   * Call on a fresh core after a simulated or real restart — do not mix
   * with an already-populated roster. Terminal markers are restored so an
   * undelivered result can still finish delivery (S4). Live markers become
   * unknown-state with a transcript pointer: never replayed, never resumed.
   * Steer tickets are in-memory and are never restored.
   */
  rebuildFromDurability(parentSessionId: string): Promise<RebuildReport>;
  /**
   * Wake bus this core enqueues settles through. Settles are batched per
   * parent session; a mid-turn dispatcher queues rather than receiving an
   * injected wake. Callers use it to note dispatcher turn bounds, drain
   * wakes, and enqueue user/peer/timer wakes.
   */
  readonly wakeBus: WakeBus;
  /**
   * Fire-and-forget peer accept (ticket 14). Returns a structural ack
   * only — never a reply. Newly accepted envelopes join the priority or
   * normal lane after the target check; delivery is wake-bus + host followup.
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
   * Drop every session-scope access policy row (ticket 30). Called on
   * deactivation/unload so an "always allow (this session)" choice never
   * leaks into a later session. Profile rows are untouched.
   */
  clearSessionAccessPolicy(): void;
  /** Stored policy table (session/profile). No hit → ask. */
  readonly accessPolicy: AccessPolicyTable;
}

export function createMultitask(
  host: DshHost,
  options?: MultitaskOptions,
): Multitask {
  const durability = options?.durability;
  const workers = new Map<string, WorkerRecord>();
  /** streamKey → workerId for every live (non-terminal) worker. */
  const liveByStreamKey = new Map<string, string>();
  const steerQueue: SteerQueue = createSteerQueue();
  const todoLedger: TodoLedger = createTodoLedger();
  const peerInbox: PeerInbox = createPeerInbox(options?.peer);
  const wakeBus: WakeBus = createWakeBus({
    onDeliver: (sessionId) => {
      void host.requestDispatcherWakeup(sessionId);
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
  const accessRelay: AccessRelay = createAccessRelay({
    ...(options?.access?.timeoutMs !== undefined
      ? { timeoutMs: options.access.timeoutMs }
      : {}),
    ...(options?.access?.now !== undefined ? { now: options.access.now } : {}),
    ...(options?.access?.schedule !== undefined
      ? { schedule: options.access.schedule }
      : {}),
    lookupPolicy: (req, ctx) => accessPolicy.lookup(req, ctx),
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
      // Terminal frees the stream key for reuse.
      if (liveByStreamKey.get(record.streamKey) === workerId) {
        liveByStreamKey.delete(record.streamKey);
      }
    }
    notifyRosterChanged(record.parentSessionId);
    return next;
  }

  /** Close the linked todo when a worker is aborted for good. */
  function cancelLinkedTodo(record: WorkerRecord): void {
    if (record.todoId === null) return;
    todoLedger.markCancelled(record.todoId);
    // dsh has no cancelled status — drop the item so the list stays usable.
    todoLedger.prune(record.todoId);
  }

  /** Pure-reconcile against the session roster. Does not apply mutations. */
  function runReconcile(
    sessionId: string,
    wake: WakeEvent,
  ): ReconcileReport {
    return reconcileTodos({
      wake,
      todos: todoLedger.list(sessionId),
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
    } else if (durability !== undefined) {
      // Snapshot terminal status (+ transcript pointer) so a crash before
      // user delivery still lets a restart notice the undelivered result.
      void Promise.resolve(durability.writeWorkerMarker(toDurableMarker(record)));
    }
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
      const existingId = liveByStreamKey.get(request.streamKey);
      if (existingId !== undefined) {
        return {
          ok: false,
          reason: "duplicate-stream-key",
          detail: `stream key "${request.streamKey}" already has a running worker (${existingId})`,
        };
      }
      const workerId = await host.spawnWorker(request.prompt, {
        parentSessionId: request.parentSessionId,
        streamKey: request.streamKey,
        title: request.title,
        ...(request.credentialNames !== undefined
          ? { credentialNames: request.credentialNames }
          : {}),
      });
      const record: WorkerRecord = {
        workerId,
        parentSessionId: request.parentSessionId,
        streamKey: request.streamKey,
        title: request.title,
        status: "spawned",
        startedAtMs: Date.now(),
        toolCallCount: 0,
        transcriptRef: null,
        todoId: request.todoId ?? null,
      };
      workers.set(workerId, record);
      liveByStreamKey.set(request.streamKey, workerId);
      // Structural todo↔worker link at spawn (ADR-0007). Status stays pending
      // until the worker starts (noteTurnStarted).
      if (request.todoId !== undefined) {
        todoLedger.linkWorker(
          request.todoId,
          workerId,
          request.streamKey,
        );
      }
      // Obligation marker (ADR-0006): minimum-to-reconstruct, written at
      // spawn through the host storage seam. Awaited so the marker exists
      // before the spawn resolves.
      if (durability !== undefined) {
        await Promise.resolve(durability.writeWorkerMarker(toDurableMarker(record)));
      }
      notifyRosterChanged(request.parentSessionId);
      return { ok: true, workerId };
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

    listTodos(sessionId: string): TodoItem[] {
      return todoLedger.list(sessionId);
    },

    markDelivered(todoId: string): boolean {
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
          unknownState.push({
            workerId: marker.workerId,
            parentSessionId: marker.parentSessionId,
            streamKey: marker.streamKey,
            title: marker.title,
            lastKnownStatus: marker.status,
            transcriptRef: marker.transcriptRef ?? marker.workerId,
            todoId: marker.todoId,
          });
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

    wakeBus,
    todos: todoLedger,
    sendPeer(sessionId: string, envelope: PeerEnvelope): PeerSendAck {
      const result = peerInbox.send(sessionId, envelope);
      if (!result.ack.ok || !result.appended) {
        // Refusal or idempotent re-accept: never enqueue a second row.
        return result.ack;
      }
      // Lane placement uses effective priority (target-checked), not the
      // wire flag alone — group/broadcast always land in the normal lane.
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
    clearSessionAccessPolicy(): void {
      // Ticket 30: "always allow (this session)" rows must never outlive the
      // activated session — the plugin clears them on deactivation/unload.
      accessPolicy.clearSession();
    },
    accessPolicy,
  };
}

export type {
  AccessDecision,
  AccessTicket,
  CreateTodoInput,
  PeerEnvelope,
  PeerInbox,
  PeerInboxOptions,
  PeerSendAck,
  ReconcileReport,
  SpawnRequest,
  SpawnResult,
  SteerResult,
  StopResult,
  TodoItem,
  TodoLedger,
  WorkerRecord,
  WorkerStatus,
  WorkerSummary,
};
export type { DurabilityPort, RebuildReport };
