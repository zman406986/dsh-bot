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
  /** Already target-checked (priority && to.kind === "agent"). */
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
   * Mark the dispatcher session mid-turn. Further settles/peers only queue
   * (unless a priority peer interrupts a non-user turn).
   * `owner` defaults to the pending owner from the last flush, else `"user"`.
   */
  noteTurnStarted(sessionId: string, owner?: TurnOwner): void;
  /** Mark the dispatcher session idle; flush pending work in rank order. */
  noteTurnEnded(sessionId: string): void;
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
  /** Normal peer notices (non-priority 1:1 + all group/broadcast). */
  normalPeers: PeerNotice[];
  /** Wake already prepared for the next (or current) turn. */
  ready: WakeEvent | null;
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
}

function isBackground(source: WakeSource): boolean {
  return (
    source === "worker-settled" || source === "worker-access-request"
  );
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

export function createWakeBus(options: WakeBusOptions): WakeBus {
  const { onDeliver, onInterrupt, onDrain } = options;
  const sessions = new Map<string, SessionWakeState>();

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
      };
      sessions.set(sessionId, state);
    }
    return state;
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
    flushBackground(sessionId, state);
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
      // Never join a peer wake (design-14: no mix).
      if (state.ready !== null && isBackground(state.ready.source)) {
        state.ready = {
          ...state.ready,
          settledWorkers: [...state.ready.settledWorkers, notice],
          source: "worker-settled",
        };
        return;
      }
      state.pending.push(notice);
      // Mid-turn: queue only. Idle with a user/peer wake waiting: stay behind it.
      if (!state.busy && state.ready === null) {
        flushBackground(input.parentSessionId, state);
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
      if (state.ready !== null && isBackground(state.ready.source)) {
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
        flushBackground(input.parentSessionId, state);
      }
    },

    enqueueAccessNotice(input: EnqueueAccessNoticeInput): void {
      const state = ensure(input.parentSessionId);
      if (state.ready !== null && isBackground(state.ready.source)) {
        const existing = state.ready.accessNotices ?? [];
        state.ready = {
          ...state.ready,
          accessNotices: [...existing, input.notice],
        };
        return;
      }
      state.pendingAccessNotices.push(input.notice);
      if (!state.busy && state.ready === null) {
        flushBackground(input.parentSessionId, state);
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
      if (effectivePriority) state.priorityPeers.push(notice);
      else state.normalPeers.push(notice);
      tryFlush(input.sessionId, state);
    },

    enqueueUserWake(sessionId: string): void {
      const state = ensure(sessionId);
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

    noteTurnStarted(sessionId: string, owner?: TurnOwner): void {
      const state = ensure(sessionId);
      state.busy = true;
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
