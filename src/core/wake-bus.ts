import type {
  AccessNotice,
  AccessRequestNotice,
} from "./access-types.js";
import type { PeerNotice } from "./peer-types.js";
import type { TerminalWorkerStatus } from "./types.js";

/**
 * Where a wake came from. Only `user`, `worker-settled`,
 * `worker-access-request`, and `peer` produce wakes at this stage;
 * the remaining sources are accepted so later tickets can enqueue
 * them without changing the vocabulary.
 */
export type WakeSource =
  | "user"
  | "worker-settled"
  | "worker-access-request"
  | "peer"
  | "timer"
  | "external-event";

/** Every source the bus accepts. */
export const WAKE_SOURCES: readonly WakeSource[] = [
  "user",
  "worker-settled",
  "worker-access-request",
  "peer",
  "timer",
  "external-event",
] as const;

/**
 * Who owns the running dispatcher turn (ticket 14 / design-14 §3.4, §6).
 * Fail closed to `"user"` when ownership is unknown — never interrupt
 * on uncertainty.
 */
export type TurnOwner = "user" | "peer" | "worker-settled";

/** One settled worker carried by a wake. */
export interface SettledWorkerNotice {
  readonly workerId: string;
  readonly status: TerminalWorkerStatus;
  readonly title: string;
  readonly resultText: string;
}

/** A wake ready for a dispatcher session. */
export interface WakeEvent {
  readonly sessionId: string;
  readonly source: WakeSource;
  readonly settledWorkers: readonly SettledWorkerNotice[];
  /** Pending access asks for this dispatcher turn (optional; additive). */
  readonly accessRequests?: readonly AccessRequestNotice[];
  /** Resolved access notices (mostly denials) for honest user reporting. */
  readonly accessNotices?: readonly AccessNotice[];
  /**
   * Present when source === "peer". FIFO of peer messages for this wake.
   * Never mixed into a worker-settled wake.
   */
  readonly peerMessages?: readonly PeerNotice[];
}

export interface EnqueueSettledInput {
  parentSessionId: string;
  workerId: string;
  status: TerminalWorkerStatus;
  title: string;
  resultText: string;
}

export interface EnqueueAccessRequestInput {
  parentSessionId: string;
  workerId: string;
  requestId: string;
  title: string;
  body: AccessRequestNotice["body"];
}

export interface EnqueueAccessNoticeInput {
  parentSessionId: string;
  notice: AccessNotice;
}

export interface EnqueuePeerInput {
  readonly sessionId: string;
  readonly notice: PeerNotice;
  /** Already the caller's effective lane choice (1:1 priority; ticket 70 §3). */
  readonly effectivePriority: boolean;
}

/**
 * Per-session wake queue with mid-turn hold, user preemption, and
 * peer priority lanes (ticket 14).
 *
 * Delivery rules:
 * - An idle session with nothing already waiting flushes immediately.
 * - A session that is mid-turn only queues; the batch flushes on turn end.
 * - Settles/access that arrive while a background batch is already waiting
 *   join that batch, so the next turn sees one wake, not several.
 * - A user wake reclaims any waiting non-user batch (settled *or* peer)
 *   back onto the pending lists and becomes the ready wake.
 * - Peer wakes never mix with settled wakes (separate turns; peer cue
 *   is never diluted).
 * - Flush order after user: priority peer → normal peer → background.
 * - Priority peer may interrupt a live non-user dispatcher turn only.
 *   Unknown ownership fails closed as user-owned.
 * - Workers are never interrupted by peer priority — only the dispatcher
 *   *turn* is reclaimed; in-flight workers keep running.
 * - Ticket 108 (opt-in, `coalesceWindowMs > 0`): idle background/peer
 *   enqueues schedule ONE per-session drain at now+window instead of an
 *   immediate wake; enqueues landing inside the window join the pending
 *   batch. User wakes preempt the window immediately (ticket-06
 *   discipline). Consecutive failed coalesced deliveries trip a fail
 *   budget (default 3) into degraded immediate mode — wakes are never
 *   dropped, and the default (window 0) is byte-identical to pre-108.
 */
export interface WakeBus {
  /** Queue a settled-worker notice for its parent session. */
  enqueueWorkerSettled(input: EnqueueSettledInput): void;
  /** Queue a pending access ask for its parent session. */
  enqueueAccessRequest(input: EnqueueAccessRequestInput): void;
  /** Queue a resolved access notice (mostly denial) for its parent session. */
  enqueueAccessNotice(input: EnqueueAccessNoticeInput): void;
  /**
   * Queue one accepted peer notice. `effectivePriority` is already
   * target-checked by the caller (inbox). Priority may interrupt a
   * non-user turn; it never interrupts a user turn.
   */
  enqueuePeer(input: EnqueuePeerInput): void;
  /** Record a user wake; preempts any queued or ready non-user wake. */
  enqueueUserWake(sessionId: string): void;
  /**
   * Open a turn to re-attempt delivery of a settled-but-undelivered result
   * (ticket 58, register D-5). Unlike `enqueueUserWake`, this DOES ask the
   * host to open the turn — the whole point is that nobody would otherwise
   * speak, and the result would wait forever. Queued (not delivered) while
   * the dispatcher is mid-turn, so a redrive never interrupts a live turn.
   */
  enqueueDeliveryRedrive(sessionId: string): void;
  /**
   * Mark the dispatcher session mid-turn. Further settles/peers only queue
   * (unless a priority peer interrupts a non-user turn).
   * `owner` defaults to the pending owner from the last flush, else `"user"`.
   */
  noteTurnStarted(sessionId: string, owner?: TurnOwner): void;
  /** Mark the dispatcher session idle; flush pending work in rank order. */
  noteTurnEnded(sessionId: string): void;
  /**
   * Ticket 108: invalidate every pending coalescing window — bump the
   * generation, cancel all armed timers, and make any timer that still
   * fires a no-op. Pending wake data is untouched; delivery of it stays
   * the caller's business (turn-end flush or a later window).
   */
  dispose(): void;
  /** Take the ready wake for this session, or undefined when none. */
  drain(sessionId: string): WakeEvent | undefined;
  /** Read the ready wake without taking it. */
  peek(sessionId: string): WakeEvent | undefined;
  /** Whether the dispatcher session is mid-turn. */
  isBusy(sessionId: string): boolean;
  /** Owner of the running turn, or null when idle. Fail-closed to user. */
  getTurnOwner(sessionId: string): TurnOwner | null;
}

interface SessionWakeState {
  busy: boolean;
  /** Owner of the running turn when busy; null when idle. */
  currentTurn: TurnOwner | null;
  /**
   * Owner recorded when a non-user wake became ready / was delivered.
   * Consumed by the next noteTurnStarted. Null → fail closed to user.
   */
  pendingOwner: TurnOwner | null;
  /** Settled notices waiting for a future turn. */
  pending: SettledWorkerNotice[];
  /** Access asks waiting for a future turn. */
  pendingAccessRequests: AccessRequestNotice[];
  /** Access notices waiting for a future turn. */
  pendingAccessNotices: AccessNotice[];
  /** Priority peer notices (1:1 effective-priority) in FIFO order. */
  priorityPeers: PeerNotice[];
  /** Normal peer notices (non-priority 1:1; group/broadcast retired, ticket 70 §3). */
  normalPeers: PeerNotice[];
  /** Wake already prepared for the next (or current) turn. */
  ready: WakeEvent | null;
  /**
   * A delivery redrive is owed (ticket 58). Held as a flag rather than a
   * queue entry: any turn that opens will surface the undelivered items
   * anyway, so coalescing N redrives into the next turn is correct.
   */
  pendingRedrive: boolean;
  /**
   * Ticket 108: the pending coalescing window for this session, or null.
   * At most ONE timer per session; enqueues inside the window join the
   * batch instead of arming another timer.
   */
  coalescing: { cancel: () => void; dueAtMs: number } | null;
}

export interface WakeBusDegradedInfo {
  /** Consecutive coalesced-drain delivery failures at degrade time. */
  readonly consecutiveFailures: number;
  /** The last delivery error that tipped the budget. */
  readonly lastError: unknown;
}

export interface WakeBusOptions {
  /** Called when a background/peer wake is ready; the host should open a turn. */
  onDeliver: (sessionId: string) => void;
  /**
   * Called when a priority peer must abort a live non-user dispatcher
   * turn. Soft-fallback hosts may no-op; the ready peer wake still wins
   * the next flush.
   */
  onInterrupt?: (sessionId: string) => void;
  /** Called after drain hands a ready wake to the caller. */
  onDrain?: (event: WakeEvent) => void;
  /**
   * Ticket 108: idle-side coalescing window in ms. Default 0 keeps the
   * current semantics byte-for-byte: every idle background/peer enqueue
   * wakes the dispatcher immediately. When >0, an idle enqueue schedules
   * ONE per-session drain at now+window instead; further enqueues for that
   * session inside the window join the pending batch. User wakes preempt
   * the window immediately (same discipline as the ticket-06 mid-turn
   * hold). Never applies while the session is mid-turn.
   */
  coalesceWindowMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Schedule a one-shot timeout. Returns a cancel function.
   * Default uses setTimeout. Tests inject a manual scheduler — no real
   * timer may stay armed past a test.
   */
  schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * Ticket 108 fail budget: consecutive coalesced-drain deliveries whose
   * `onDeliver` throws before the bus degrades to immediate mode. Default
   * {@link DEFAULT_COALESCE_FAIL_BUDGET}. Degraded mode bypasses the window
   * for every subsequent drain — wakes are never dropped.
   */
  coalesceFailBudget?: number;
  /** Called once when the bus flips into degraded immediate mode. */
  onDegraded?: (info: WakeBusDegradedInfo) => void;
}

/** Ticket 108: consecutive coalesced-drain failures tolerated before degrade. */
export const DEFAULT_COALESCE_FAIL_BUDGET = 3;

function isBackground(source: WakeSource): boolean {
  return (
    source === "worker-settled" || source === "worker-access-request"
  );
}

/**
 * Sources whose ready wake may absorb newly arrived background content
 * (ticket 58). A pending redrive is such a turn: it exists only to surface
 * undelivered work, so a settle arriving before it drains should ride it
 * rather than wait for a second turn.
 */
function canJoinBackground(source: WakeSource): boolean {
  return isBackground(source) || source === "timer";
}

function isNonUser(source: WakeSource): boolean {
  return isBackground(source) || source === "peer";
}

function sourceFor(
  settled: readonly SettledWorkerNotice[],
  accessRequests: readonly AccessRequestNotice[],
  accessNotices: readonly AccessNotice[],
): WakeSource {
  if (settled.length > 0) return "worker-settled";
  if (accessRequests.length > 0 || accessNotices.length > 0) {
    return "worker-access-request";
  }
  return "worker-settled";
}

function ownerForSource(source: WakeSource): TurnOwner {
  if (source === "peer") return "peer";
  if (source === "user") return "user";
  return "worker-settled";
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

export function createWakeBus(options: WakeBusOptions): WakeBus {
  const { onDeliver, onInterrupt, onDrain } = options;
  const coalesceWindowMs = options.coalesceWindowMs ?? 0;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const coalesceFailBudget =
    options.coalesceFailBudget ?? DEFAULT_COALESCE_FAIL_BUDGET;
  const onDegraded = options.onDegraded;
  const sessions = new Map<string, SessionWakeState>();
  /**
   * Ticket 108: bumped by dispose; a timer armed under an older generation
   * no-ops when it fires, so a stale window can never deliver after a
   * teardown/rebuild.
   */
  let generation = 0;
  /**
   * Ticket 108: once true, every drain bypasses the window and behaves
   * exactly like window 0 (immediate). Tripped by the fail budget below.
   */
  let degraded = false;
  let coalesceFailures = 0;

  function ensure(sessionId: string): SessionWakeState {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = {
        busy: false,
        currentTurn: null,
        pendingOwner: null,
        pending: [],
        pendingAccessRequests: [],
        pendingAccessNotices: [],
        priorityPeers: [],
        normalPeers: [],
        ready: null,
        pendingRedrive: false,
        coalescing: null,
      };
      sessions.set(sessionId, state);
    }
    return state;
  }

  /** Whether idle enqueues currently coalesce instead of waking at once. */
  function coalescingActive(): boolean {
    return !degraded && coalesceWindowMs > 0;
  }

  /**
   * Arm the per-session window drain (ticket 108). Already-armed windows
   * are joined, never duplicated — one pending timer per session, and
   * sibling dispatcher sessions coexist independently.
   */
  function scheduleCoalescedDrain(
    sessionId: string,
    state: SessionWakeState,
  ): void {
    if (state.coalescing !== null) return;
    const gen = generation;
    const dueAtMs = now() + coalesceWindowMs;
    const cancel = schedule(() => {
      // Stale timer: dispose/rebuild bumped the generation — no-op.
      if (gen !== generation) return;
      const current = sessions.get(sessionId);
      if (current === undefined || current.coalescing === null) return;
      current.coalescing = null;
      // Mid-turn: the turn-end flush owns delivery (ticket-06 hold).
      if (current.busy) return;
      runCoalescedDrain(sessionId, current);
    }, coalesceWindowMs);
    state.coalescing = { cancel, dueAtMs };
  }

  /** Cancel a pending window without delivering it. */
  function cancelCoalescedDrain(state: SessionWakeState): void {
    const pending = state.coalescing;
    if (pending === null) return;
    state.coalescing = null;
    pending.cancel();
  }

  /**
   * Run the normal flush path for a coalesced window drain, wrapped in the
   * ticket-108 fail budget: N consecutive throwing deliveries flip the bus
   * into degraded immediate mode. The flush marks `ready` BEFORE notifying,
   * so a throw never drops the wake — the host just wasn't told, and
   * delivery redrive remains the backstop.
   */
  function runCoalescedDrain(sessionId: string, state: SessionWakeState): void {
    try {
      tryFlush(sessionId, state);
      coalesceFailures = 0;
    } catch (error) {
      coalesceFailures += 1;
      if (degraded) return;
      if (coalesceFailures >= coalesceFailBudget) {
        degraded = true;
        onDegraded?.({
          consecutiveFailures: coalesceFailures,
          lastError: error,
        });
      }
    }
  }

  /** Idle background enqueue: join the window when active, else wake now. */
  function coalesceOrFlush(sessionId: string, state: SessionWakeState): void {
    if (coalescingActive()) {
      scheduleCoalescedDrain(sessionId, state);
    } else {
      flushBackground(sessionId, state);
    }
  }

  /** Move pending background items into a ready batch and notify the host. */
  function flushBackground(sessionId: string, state: SessionWakeState): void {
    const hasPending =
      state.pending.length > 0 ||
      state.pendingAccessRequests.length > 0 ||
      state.pendingAccessNotices.length > 0;
    if (!hasPending) return;
    const settledWorkers = state.pending;
    const accessRequests = state.pendingAccessRequests;
    const accessNotices = state.pendingAccessNotices;
    state.pending = [];
    state.pendingAccessRequests = [];
    state.pendingAccessNotices = [];
    const source = sourceFor(settledWorkers, accessRequests, accessNotices);
    state.ready = {
      sessionId,
      source,
      settledWorkers,
      accessRequests,
      accessNotices,
    };
    // A real background batch subsumes any owed redrive: this turn will
    // surface the undelivered items anyway, so a second turn would be noise.
    state.pendingRedrive = false;
    state.pendingOwner = ownerForSource(source);
    onDeliver(sessionId);
  }

  /** Build a peer wake from a FIFO of notices. */
  function makePeerWake(
    sessionId: string,
    peerMessages: readonly PeerNotice[],
  ): WakeEvent {
    return {
      sessionId,
      source: "peer",
      settledWorkers: [],
      accessRequests: [],
      accessNotices: [],
      peerMessages,
    };
  }

  /**
   * Rank order on idle/turn-end (design-14 §6.4):
   * priority peers → normal peers → existing background flush.
   */
  function tryFlush(sessionId: string, state: SessionWakeState): void {
    if (state.ready !== null) return;
    if (state.priorityPeers.length > 0) {
      const peerMessages = state.priorityPeers;
      state.priorityPeers = [];
      state.ready = makePeerWake(sessionId, peerMessages);
      state.pendingOwner = "peer";
      onDeliver(sessionId);
      return;
    }
    if (state.normalPeers.length > 0) {
      const peerMessages = state.normalPeers;
      state.normalPeers = [];
      state.ready = makePeerWake(sessionId, peerMessages);
      state.pendingOwner = "peer";
      onDeliver(sessionId);
      return;
    }
    // Real background content first — it subsumes an owed redrive, because
    // the same turn surfaces the undelivered items.
    flushBackground(sessionId, state);
    if (state.ready !== null) return;
    if (state.pendingRedrive) {
      state.pendingRedrive = false;
      state.ready = {
        sessionId,
        source: "timer",
        settledWorkers: [],
        accessRequests: [],
        accessNotices: [],
      };
      state.pendingOwner = "worker-settled";
      onDeliver(sessionId);
    }
  }

  /**
   * Put a ready *non-user* wake back onto the pending lists.
   * Peer notices return to the front of their matching lane (effective
   * priority preserved). User wakes are never reclaimed here.
   */
  function reclaimReadyNonUser(state: SessionWakeState): void {
    if (state.ready === null || state.ready.source === "user") return;
    if (state.ready.source === "peer") {
      const msgs = state.ready.peerMessages ?? [];
      const toPriority: PeerNotice[] = [];
      const toNormal: PeerNotice[] = [];
      for (const msg of msgs) {
        if (msg.priority) toPriority.push(msg);
        else toNormal.push(msg);
      }
      state.priorityPeers.unshift(...toPriority);
      state.normalPeers.unshift(...toNormal);
    } else if (state.ready.source === "timer") {
      // A reclaimed redrive has no payload to re-queue — it is a flag
      // (ticket 58). Re-arming it keeps the obligation alive for the next
      // idle turn instead of silently dropping it.
      state.pendingRedrive = true;
    } else {
      state.pending.unshift(...state.ready.settledWorkers);
      state.pendingAccessRequests.unshift(
        ...(state.ready.accessRequests ?? []),
      );
      state.pendingAccessNotices.unshift(...(state.ready.accessNotices ?? []));
    }
    state.ready = null;
  }

  /**
   * Promote a priority peer to the ready wake, reclaiming any undelivered
   * non-user ready batch. Already-queued priority peers join the same wake.
   */
  function becomeReadyPriorityPeer(
    sessionId: string,
    state: SessionWakeState,
    notice: PeerNotice,
  ): void {
    reclaimReadyNonUser(state);
    const peerMessages = [notice, ...state.priorityPeers];
    state.priorityPeers = [];
    state.ready = makePeerWake(sessionId, peerMessages);
    state.pendingOwner = "peer";
  }

  return {
    enqueueWorkerSettled(input: EnqueueSettledInput): void {
      const state = ensure(input.parentSessionId);
      const notice: SettledWorkerNotice = {
        workerId: input.workerId,
        status: input.status,
        title: input.title,
        resultText: input.resultText,
      };
      // Join the batch already waiting for the next turn — one wake, not several.
      // Never join a peer wake (design-14: no mix). A pending redrive turn is
      // joinable: it exists only to surface undelivered work (ticket 58).
      if (state.ready !== null && canJoinBackground(state.ready.source)) {
        state.ready = {
          ...state.ready,
          settledWorkers: [...state.ready.settledWorkers, notice],
          source: "worker-settled",
        };
        return;
      }
      state.pending.push(notice);
      // Mid-turn: queue only. Idle with a user/peer wake waiting: stay behind it.
      // Ticket 108: idle and nothing ready → join/arm the coalescing window
      // instead of waking immediately (immediate at the default window 0).
      if (!state.busy && state.ready === null) {
        coalesceOrFlush(input.parentSessionId, state);
      }
    },

    enqueueAccessRequest(input: EnqueueAccessRequestInput): void {
      const state = ensure(input.parentSessionId);
      const notice: AccessRequestNotice = {
        workerId: input.workerId,
        requestId: input.requestId,
        title: input.title,
        body: input.body,
      };
      if (state.ready !== null && canJoinBackground(state.ready.source)) {
        const existing = state.ready.accessRequests ?? [];
        state.ready = {
          ...state.ready,
          accessRequests: [...existing, notice],
          source:
            state.ready.settledWorkers.length > 0
              ? state.ready.source
              : "worker-access-request",
        };
        return;
      }
      state.pendingAccessRequests.push(notice);
      if (!state.busy && state.ready === null) {
        coalesceOrFlush(input.parentSessionId, state);
      }
    },

    enqueueAccessNotice(input: EnqueueAccessNoticeInput): void {
      const state = ensure(input.parentSessionId);
      if (state.ready !== null && canJoinBackground(state.ready.source)) {
        const existing = state.ready.accessNotices ?? [];
        state.ready = {
          ...state.ready,
          accessNotices: [...existing, input.notice],
        };
        return;
      }
      state.pendingAccessNotices.push(input.notice);
      if (!state.busy && state.ready === null) {
        coalesceOrFlush(input.parentSessionId, state);
      }
    },

    enqueuePeer(input: EnqueuePeerInput): void {
      const state = ensure(input.sessionId);
      const { notice, effectivePriority } = input;

      // Fail closed: busy with unknown ownership is treated as user-owned.
      const turnIsUser =
        state.busy &&
        (state.currentTurn === null || state.currentTurn === "user");

      if (turnIsUser) {
        if (effectivePriority) state.priorityPeers.push(notice);
        else state.normalPeers.push(notice);
        return;
      }

      // Mid non-user turn + priority → interrupt (design-14 §3.4).
      if (
        state.busy &&
        (state.currentTurn === "worker-settled" ||
          state.currentTurn === "peer")
      ) {
        if (effectivePriority) {
          becomeReadyPriorityPeer(input.sessionId, state, notice);
          onInterrupt?.(input.sessionId);
          onDeliver(input.sessionId);
        } else {
          state.normalPeers.push(notice);
        }
        return;
      }

      // Idle, user wake ready → wait (user stays first).
      if (state.ready !== null && state.ready.source === "user") {
        if (effectivePriority) state.priorityPeers.push(notice);
        else state.normalPeers.push(notice);
        return;
      }

      // Idle, undelivered non-user ready batch.
      if (state.ready !== null) {
        if (effectivePriority) {
          becomeReadyPriorityPeer(input.sessionId, state, notice);
          // Host may already have been notified for the reclaimed batch;
          // re-notify so it can drain the replacement peer wake.
          onDeliver(input.sessionId);
        } else {
          // Separate turns: do not join a settled/peer ready wake.
          state.normalPeers.push(notice);
        }
        return;
      }

      // Nothing ready, not busy → queue then flush in rank order.
      // Ticket 108: the flush rides the coalescing window when active.
      if (effectivePriority) state.priorityPeers.push(notice);
      else state.normalPeers.push(notice);
      if (coalescingActive()) {
        scheduleCoalescedDrain(input.sessionId, state);
      } else {
        tryFlush(input.sessionId, state);
      }
    },

    enqueueUserWake(sessionId: string): void {
      const state = ensure(sessionId);
      // Ticket 108: a pending coalescing window is flushed immediately —
      // same preemption discipline as the ticket-06 mid-turn hold. The
      // drain runs now (timer cancelled); the reclaim below then puts the
      // non-user batch back behind the user wake so the user goes first.
      if (state.coalescing !== null) {
        cancelCoalescedDrain(state);
        if (!state.busy && state.ready === null) {
          runCoalescedDrain(sessionId, state);
        }
      }
      // Reclaim any undelivered non-user batch so the user goes first.
      reclaimReadyNonUser(state);
      // The host opens the user's turn itself — no onDeliver for user wakes.
      state.ready = {
        sessionId,
        source: "user",
        settledWorkers: [],
        accessRequests: [],
        accessNotices: [],
      };
      state.pendingOwner = "user";
    },

    enqueueDeliveryRedrive(sessionId: string): void {
      const state = ensure(sessionId);
      // Mid-turn: hold it as a flag. Waking now would interrupt a live turn
      // for work that is already waiting on that turn's outcome.
      if (state.busy) {
        state.pendingRedrive = true;
        return;
      }
      // Ticket 108: a pending coalescing window opens a turn momentarily,
      // and its flush subsumes an owed redrive (the same rule as a real
      // background batch) — no separate immediate wake is needed.
      if (state.coalescing !== null) {
        state.pendingRedrive = true;
        return;
      }
      if (state.ready !== null) {
        // A background batch already queued surfaces the undelivered items in
        // this turn, so the redrive is subsumed. A peer or user turn is not
        // about our workers at all — keep the redrive owed for the next one.
        state.pendingRedrive = !isBackground(state.ready.source);
        return;
      }
      state.ready = {
        sessionId,
        source: "timer",
        settledWorkers: [],
        accessRequests: [],
        accessNotices: [],
      };
      state.pendingOwner = "worker-settled";
      onDeliver(sessionId);
    },

    noteTurnStarted(sessionId: string, owner?: TurnOwner): void {
      const state = ensure(sessionId);
      state.busy = true;
      // Ticket 108: a window timer can do nothing useful mid-turn — the
      // turn-end flush owns delivery of anything pending. Cancel it here so
      // no stale timer lingers across the turn.
      cancelCoalescedDrain(state);
      // Explicit owner wins; else pending owner from the last flush;
      // else fail closed to user.
      state.currentTurn = owner ?? state.pendingOwner ?? "user";
      state.pendingOwner = null;
    },

    noteTurnEnded(sessionId: string): void {
      const state = ensure(sessionId);
      state.busy = false;
      state.currentTurn = null;
      // A ready user wake still owns the next turn; background waits.
      if (state.ready !== null && state.ready.source === "user") {
        return;
      }
      if (state.ready === null) {
        tryFlush(sessionId, state);
      }
    },

    dispose(): void {
      // Ticket 108: bump first, then cancel — any timer that still fires
      // sees a stale generation and no-ops, even if the host scheduler
      // ignores the cancel.
      generation += 1;
      for (const state of sessions.values()) {
        cancelCoalescedDrain(state);
      }
    },

    drain(sessionId: string): WakeEvent | undefined {
      const state = sessions.get(sessionId);
      if (state === undefined || state.ready === null) return undefined;
      const event = state.ready;
      state.ready = null;
      onDrain?.(event);
      return event;
    },

    peek(sessionId: string): WakeEvent | undefined {
      return sessions.get(sessionId)?.ready ?? undefined;
    },

    isBusy(sessionId: string): boolean {
      return sessions.get(sessionId)?.busy ?? false;
    },

    getTurnOwner(sessionId: string): TurnOwner | null {
      return sessions.get(sessionId)?.currentTurn ?? null;
    },
  };
}
