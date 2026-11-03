import type { AgentMessageWakeOrigin, PeerNotice } from "./peer-types.js";
import type { TerminalWorkerStatus } from "./types.js";

/**
 * Where a wake came from. Only `user`, `worker-settled`, and `peer` produce
 * wakes at this stage; the remaining sources are accepted so later tickets can
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

/**
 * One external intake job carried by a wake (ticket 113, ADR-0023).
 * The adapter claims the job from the watched directory and hands the
 * payload here; the core never touches the filesystem. `promptText` is the
 * job's resolved prompt (prompt.md over entry.text, resolved adapter-side).
 */
export interface ExternalJobNotice {
  readonly jobId: string;
  readonly promptText: string;
  readonly jobDir: string;
}

/**
 * Structured provenance for a wake that was caused by another agent
 * (ticket 116 / ADR-0025). The shape is the host's own adjacent-agent
 * source (`dsh-subagent/lib/index.js:444-449`). Re-exported from
 * `peer-types` so the peer envelope and the wake share one declaration.
 */
export type { AgentMessageWakeOrigin };

/** A wake ready for a dispatcher session. */
export interface WakeEvent {
  readonly sessionId: string;
  readonly source: WakeSource;
  readonly settledWorkers: readonly SettledWorkerNotice[];
  /**
   * Present when source === "peer". FIFO of peer messages for this wake.
   * Never mixed into a worker-settled wake.
   */
  readonly peerMessages?: readonly PeerNotice[];
  /**
   * Ticket 116: structured origin for an agent-caused wake. Present on peer
   * wakes; absent on user and background wakes (which keep the plugin
   * source). Presentation text never decides this field.
   */
  readonly messageOrigin?: AgentMessageWakeOrigin;
  /**
   * Ticket 113: external intake jobs for this wake. Background-rank —
   * they join the settled batch lane, never a peer wake.
   */
  readonly externalJobs?: readonly ExternalJobNotice[];
}

export interface EnqueueSettledInput {
  parentSessionId: string;
  workerId: string;
  status: TerminalWorkerStatus;
  title: string;
  resultText: string;
}

export interface EnqueuePeerInput {
  readonly sessionId: string;
  readonly notice: PeerNotice;
  /** Already the caller's effective lane choice (1:1 priority; ticket 70 §3). */
  readonly effectivePriority: boolean;
}

export interface EnqueueExternalJobInput {
  readonly sessionId: string;
  readonly job: ExternalJobNotice;
}

/**
 * Per-session wake queue with mid-turn hold, user preemption, and
 * peer priority lanes (ticket 14).
 *
 * Delivery rules:
 * - An idle session with nothing already waiting flushes immediately.
 * - A session that is mid-turn only queues; the batch flushes on turn end.
 * - Settles that arrive while a background batch is already waiting
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
  /**
   * Queue one accepted peer notice. `effectivePriority` is already
   * target-checked by the caller (inbox). Priority may interrupt a
   * non-user turn; it never interrupts a user turn.
   */
  enqueuePeer(input: EnqueuePeerInput): void;
  /**
   * Queue one external intake job (ticket 113, ADR-0023). Background-rank:
   * joins the settled batching lane and the ticket-108 coalescing
   * window exactly like a worker settle — never a peer lane, never an
   * interrupt. The core (not the bus) owns todo creation.
   */
  enqueueExternalJob(input: EnqueueExternalJobInput): void;
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
  /** Priority peer notices (1:1 effective-priority) in FIFO order. */
  priorityPeers: PeerNotice[];
  /** Normal peer notices (non-priority 1:1; group/broadcast retired, ticket 70 §3). */
  normalPeers: PeerNotice[];
  /** External intake jobs waiting for a future turn (ticket 113). */
  pendingExternalJobs: ExternalJobNotice[];
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
   * batch instead of arming another timer. Only the cancel handle is kept
   * (ticket 112: a stored due-time was never read).
   */
  coalescing: { cancel: () => void } | null;
}

export interface WakeBusDegradedInfo {
  /** Consecutive coalesced-drain delivery failures at degrade time. */
  readonly consecutiveFailures: number;
  /** The last delivery error that tipped the budget. */
  readonly lastError: unknown;
}

export interface WakeBusOptions {
  /**
   * Called when a background/peer wake is ready; the host should open a
   * turn. Ticket 116: `origin` is the wake's STRUCTURED provenance when the
   * wake was caused by another agent (a peer wake). The host stamps it on
   * the follow-up message's source; it is never re-derived from text.
   */
  onDeliver: (sessionId: string, origin?: AgentMessageWakeOrigin) => void;
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
    source === "worker-settled" ||
    // Ticket 113: external intake rides the background rank — it joins
    // settle batches and subsumes an owed redrive like any other batch.
    source === "external-event"
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
  externalJobs: readonly ExternalJobNotice[],
): WakeSource {
  if (settled.length > 0) return "worker-settled";
  if (externalJobs.length > 0) return "external-event";
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
        priorityPeers: [],
        normalPeers: [],
        pendingExternalJobs: [],
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
    state.coalescing = { cancel };
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
      state.pending.length > 0 || state.pendingExternalJobs.length > 0;
    if (!hasPending) return;
    const settledWorkers = state.pending;
    const externalJobs = state.pendingExternalJobs;
    state.pending = [];
    state.pendingExternalJobs = [];
    const source = sourceFor(settledWorkers, externalJobs);
    state.ready = {
      sessionId,
      source,
      settledWorkers,
      externalJobs,
    };
    // A real background batch subsumes any owed redrive: this turn will
    // surface the undelivered items anyway, so a second turn would be noise.
    state.pendingRedrive = false;
    state.pendingOwner = ownerForSource(source);
    onDeliver(sessionId);
  }

  /**
   * Build a peer wake from a FIFO of notices (ticket 116).
   *
   * `messageOrigin` is the STRUCTURED provenance: every peer wake carries
   * `{kind:"agent-message", form:"relay", senderSessionId}` so the host
   * stamps the same source on the durable follow-up message — never the
   * plugin kind, and never anything that reads as the user. The sender is
   * the notice that opened the wake (`peerMessages[0]`; for the priority
   * lane that is the triggering notice, since it is put first), filled from
   * `fromAgentId` — which the sending tool derives from its registration
   * closure, never from text.
   *
   * A flush that batched notices from several senders is attributed at the
   * TURN level to its opening sender: the durable follow-up is one message
   * and can carry one sender. Each notice keeps its own `fromAgentId` and
   * the rendered body names every sender, so nothing is hidden — the source
   * field answers "which agent opened this turn", not "every agent in it".
   */
  function makePeerWake(
    sessionId: string,
    peerMessages: readonly PeerNotice[],
  ): WakeEvent {
    const opener = peerMessages[0];
    return {
      sessionId,
      source: "peer",
      settledWorkers: [],
      peerMessages,
      ...(opener !== undefined
        ? {
            messageOrigin: {
              kind: "agent-message" as const,
              form: "relay" as const,
              senderSessionId: opener.fromAgentId,
            },
          }
        : {}),
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
      const wake = makePeerWake(sessionId, peerMessages);
      state.ready = wake;
      state.pendingOwner = "peer";
      onDeliver(sessionId, wake.messageOrigin);
      return;
    }
    if (state.normalPeers.length > 0) {
      const peerMessages = state.normalPeers;
      state.normalPeers = [];
      const wake = makePeerWake(sessionId, peerMessages);
      state.ready = wake;
      state.pendingOwner = "peer";
      onDeliver(sessionId, wake.messageOrigin);
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
    } else if (state.ready.source === "external-event") {
      // Ticket 113: external jobs re-queue at the FRONT of their lane so
      // the reclaimed batch re-presents in its original order.
      state.pendingExternalJobs.unshift(
        ...(state.ready.externalJobs ?? []),
      );
    } else {
      state.pending.unshift(...state.ready.settledWorkers);
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
          onDeliver(input.sessionId, state.ready?.messageOrigin);
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
          onDeliver(input.sessionId, state.ready?.messageOrigin);
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

    enqueueExternalJob(input: EnqueueExternalJobInput): void {
      const state = ensure(input.sessionId);
      // Join the batch already waiting for the next turn — one wake, not
      // several. Same join rule as settles (never a peer/user wake).
      if (state.ready !== null && canJoinBackground(state.ready.source)) {
        state.ready = {
          ...state.ready,
          externalJobs: [...(state.ready.externalJobs ?? []), input.job],
          // A wake that carried only a redrive flag (source "timer") is now
          // an external-event wake; one with real settles keeps its more
          // specific source.
          source:
            state.ready.settledWorkers.length > 0
              ? state.ready.source
              : "external-event",
        };
        return;
      }
      state.pendingExternalJobs.push(input.job);
      // Mid-turn: queue only. Idle with a user/peer wake waiting: stay
      // behind it. Ticket 108: idle and nothing ready → join/arm the
      // coalescing window instead of waking immediately.
      if (!state.busy && state.ready === null) {
        coalesceOrFlush(input.sessionId, state);
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
