import type { TerminalWorkerStatus } from "./types.js";

/**
 * Where a wake came from. Only `user` and `worker-settled` produce wakes
 * at this stage; the remaining sources are accepted so later tickets can
 * enqueue them without changing the vocabulary.
 */
export type WakeSource =
  | "user"
  | "worker-settled"
  | "peer"
  | "timer"
  | "external-event";

/** Every source the bus accepts. */
export const WAKE_SOURCES: readonly WakeSource[] = [
  "user",
  "worker-settled",
  "peer",
  "timer",
  "external-event",
] as const;

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
}

export interface EnqueueSettledInput {
  parentSessionId: string;
  workerId: string;
  status: TerminalWorkerStatus;
  title: string;
  resultText: string;
}

/**
 * Per-session wake queue with mid-turn hold and user preemption.
 *
 * Delivery rules:
 * - An idle session with nothing already waiting flushes immediately.
 * - A session that is mid-turn only queues; the batch flushes on turn end.
 * - Settles that arrive while a background batch is already waiting join
 *   that batch, so the next turn sees one wake, not several.
 * - A user wake reclaims any waiting background batch back onto the pending
 *   list and becomes the ready wake — background never goes first.
 * - `onDeliver` fires only for background (worker-settled) flushes; the host
 *   already opens a turn for a user message.
 */
export interface WakeBus {
  /** Queue a settled-worker notice for its parent session. */
  enqueueWorkerSettled(input: EnqueueSettledInput): void;
  /** Record a user wake; preempts any queued or ready background wake. */
  enqueueUserWake(sessionId: string): void;
  /** Mark the dispatcher session mid-turn. Further settles only queue. */
  noteTurnStarted(sessionId: string): void;
  /** Mark the dispatcher session idle; flush any pending background batch. */
  noteTurnEnded(sessionId: string): void;
  /** Take the ready wake for this session, or undefined when none. */
  drain(sessionId: string): WakeEvent | undefined;
  /** Read the ready wake without taking it. */
  peek(sessionId: string): WakeEvent | undefined;
  /** Whether the dispatcher session is mid-turn. */
  isBusy(sessionId: string): boolean;
}

interface SessionWakeState {
  busy: boolean;
  /** Settled notices waiting for a future turn. */
  pending: SettledWorkerNotice[];
  /** Wake already prepared for the next (or current) turn. */
  ready: WakeEvent | null;
}

export interface WakeBusOptions {
  /** Called when a background wake is ready; the host should open a turn. */
  onDeliver: (sessionId: string) => void;
}

export function createWakeBus(options: WakeBusOptions): WakeBus {
  const { onDeliver } = options;
  const sessions = new Map<string, SessionWakeState>();

  function ensure(sessionId: string): SessionWakeState {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { busy: false, pending: [], ready: null };
      sessions.set(sessionId, state);
    }
    return state;
  }

  /** Move pending settled notices into a ready batch and notify the host. */
  function flushBackground(sessionId: string, state: SessionWakeState): void {
    if (state.pending.length === 0) return;
    const settledWorkers = state.pending;
    state.pending = [];
    state.ready = {
      sessionId,
      source: "worker-settled",
      settledWorkers,
    };
    onDeliver(sessionId);
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
      if (state.ready !== null && state.ready.source === "worker-settled") {
        state.ready = {
          sessionId: state.ready.sessionId,
          source: "worker-settled",
          settledWorkers: [...state.ready.settledWorkers, notice],
        };
        return;
      }
      state.pending.push(notice);
      // Mid-turn: queue only. Idle with a user wake waiting: stay behind it.
      if (!state.busy && state.ready === null) {
        flushBackground(input.parentSessionId, state);
      }
    },

    enqueueUserWake(sessionId: string): void {
      const state = ensure(sessionId);
      // Reclaim any undelivered background batch so the user goes first.
      if (state.ready !== null && state.ready.source === "worker-settled") {
        state.pending.unshift(...state.ready.settledWorkers);
        state.ready = null;
      }
      // The host opens the user's turn itself — no onDeliver for user wakes.
      state.ready = { sessionId, source: "user", settledWorkers: [] };
    },

    noteTurnStarted(sessionId: string): void {
      ensure(sessionId).busy = true;
    },

    noteTurnEnded(sessionId: string): void {
      const state = ensure(sessionId);
      state.busy = false;
      // A ready user wake still owns the next turn; background waits.
      if (state.ready !== null && state.ready.source === "user") {
        return;
      }
      if (state.ready === null) {
        flushBackground(sessionId, state);
      }
    },

    drain(sessionId: string): WakeEvent | undefined {
      const state = sessions.get(sessionId);
      if (state === undefined || state.ready === null) return undefined;
      const event = state.ready;
      state.ready = null;
      return event;
    },

    peek(sessionId: string): WakeEvent | undefined {
      return sessions.get(sessionId)?.ready ?? undefined;
    },

    isBusy(sessionId: string): boolean {
      return sessions.get(sessionId)?.busy ?? false;
    },
  };
}
