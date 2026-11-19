import type { TerminalWorkerStatus, WorkerRecord } from "./types.js";

/**
 * Ticket 115: per-target settle records plus the bounded-wait engine that
 * `Multitask.awaitWorker` (second half of the ticket) delegates to.
 *
 * The core receives every worker settle with `status` and the report text and
 * immediately composes a wake; after that the result lives only in the wake
 * and the transcript. This module is the bounded, in-memory memory of that
 * result: a per-parent-session ring of {@link SETTLE_RING_SIZE} records,
 * written by the settle path BEFORE the wake is enqueued, plus the wait
 * machinery (`too-many-waits` cap, timeout, abort, `cancelWaits`) that turns
 * "did that worker finish, and what did it say?" into a record read instead
 * of a host poll or a transcript read (ADR-0025).
 *
 * Bounds (ticket-level, recorded before implementation):
 * ring 64 per parent session; default timeout 30,000 ms; max timeout
 * 120,000 ms; 4 concurrent waiters per dispatcher session; `timeoutMs: 0`
 * is a non-blocking status read.
 *
 * In-memory only (ADR-0012): a restart loses results, which is the documented
 * worker behaviour — report the loss plainly, never replay. Nothing durable,
 * no host polling, no transcript reads, and no timers except the one timeout
 * per wait.
 */

/** Bounded ring size per parent session (ticket 115). */
export const SETTLE_RING_SIZE = 64;

/** Default wait when a caller omits the timeout (matches the host's `wait_agent` default). */
export const AWAIT_DEFAULT_TIMEOUT_MS = 30_000;

/** Max wait. The dispatcher's turn is the user's chat; a longer wait is not a chat turn. */
export const AWAIT_MAX_TIMEOUT_MS = 120_000;

/** Concurrent waiters allowed per dispatcher session; a fifth is refused. */
export const MAX_CONCURRENT_WAITS = 4;

/**
 * Ticket 117: the one copy for a malformed timeout value (not a number).
 * Produced by {@link validateAwaitTimeout} so a wrong-typed argument and an
 * out-of-bounds number describe the bound identically, wherever the refusal
 * is surfaced.
 */
export const AWAIT_INVALID_TIMEOUT_DETAIL =
  "timeout_ms must be a number between 0 and 120000 milliseconds";

/** One remembered worker terminal result (ticket 115, exact fields). */
export interface SettleRecord {
  readonly workerId: string;
  /** Native stock execution identity, absent for legacy callers. */
  readonly runId?: string;
  readonly status: TerminalWorkerStatus;
  /** The settled report, clamped by the settle path before it lands here. */
  readonly resultText: string;
  readonly settledAtMs: number;
}

/**
 * Outcome of an await on a worker target.
 *
 * The ticket adopts the design-note §4.2 union; field names follow the core's
 * camelCase convention — the tool layer (ticket 117) maps them onto the wire
 * (`workerStatus` → `worker_status`, `settledAtMs` → `settled_at_ms`,
 * `waitedMs` → `waited_ms`). A timeout is a valid outcome, not an error.
 *
 * The ticket's race set is: settle-record arrival, timeout timer, `signal`
 * abort, and session deactivation. First wins; every loser is cleaned up.
 * Ticket 117 adds the design note's fourth release: a structured user message
 * observed on the awaiting dispatcher's OWN session releases its waiters with
 * `reason: "user-message"` — the adapter feeds that in through
 * {@link SettleRecords.releaseWaits}; nothing here reads text or polls.
 */
export type AwaitWorkerOutcome =
  | {
      readonly ok: true;
      readonly status: "settled";
      readonly workerStatus: TerminalWorkerStatus;
      readonly result: string;
      readonly settledAtMs: number;
      readonly waitedMs: number;
    }
  | { readonly ok: true; readonly status: "still-running"; readonly waitedMs: number }
  | { readonly ok: true; readonly status: "gone"; readonly waitedMs: number }
  | {
      readonly ok: true;
      readonly status: "released";
      readonly reason: AwaitReleasedReason;
      readonly waitedMs: number;
    }
  | { readonly ok: false; readonly reason: AwaitRefusalReason; readonly detail: string };

/**
 * Why a wait was released early. `"stopped"` is the turn abort or session
 * deactivation (ticket 115); `"user-message"` is a real user prompt observed
 * on the awaiting dispatcher's own session (ticket 117) — the user is never
 * made to wait behind a 120 s await.
 */
export type AwaitReleasedReason = "stopped" | "user-message";

export type AwaitRefusalReason =
  | "unknown-target"
  | "self-target"
  | "not-awaitable"
  | "too-many-waits"
  | "invalid-timeout";

/**
 * The `hooks` parameter of the ticket-115 signature
 * (`awaitWorker(parentSessionId, workerId, timeoutMs, signal, hooks)`).
 * Ticket 115 defines no hooks: the race set is fully covered by the signal,
 * the timeout, and `cancelWaits`.
 *
 * Ticket 117 did NOT need to fill it in: the user-message release arrives
 * through {@link SettleRecords.releaseWaits}, an explicit call the adapter
 * makes when it observes the structured source — not a closure passed per
 * wait. The parameter stays reserved and empty so a later per-wait hook is an
 * additive, non-breaking change.
 */
export interface AwaitWorkerHooks {}

/** The refusal half of {@link AwaitWorkerOutcome}. */
export type AwaitWorkerRefusal = Extract<AwaitWorkerOutcome, { ok: false }>;

/** Options for {@link createSettleRecords}. */
export interface SettleRecordsOptions {
  /** Injectable clock for tests. Defaults to Date.now. */
  readonly now?: () => number;
  /**
   * Schedule a one-shot timeout. Returns a cancel function.
   * Default uses setTimeout. Tests inject a manual scheduler.
   */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * Ticket 115: adapter-side liveness probe, wired to
   * `ctx.agents.get(id) !== undefined`. Consulted ONCE, at timeout, when no
   * settle record exists — never on a timer. False means the worker's agent
   * is gone with no recorded result: the wait reports `gone`.
   */
  readonly isAgentAlive?: (workerId: string) => boolean;
}

/**
 * The settle-record store and its waiters. One instance per multitask core;
 * the settle path writes via {@link SettleRecords.record}, the await layer
 * reads via {@link SettleRecords.lookup} and blocks via
 * {@link SettleRecords.wait}.
 */
export interface SettleRecords {
  /**
   * Write a settle into the target's parent-session ring (oldest evicted
   * past {@link SETTLE_RING_SIZE}) and release any waiter on that worker.
   * Called from the settle path BEFORE the wake is enqueued, so a wait that
   * races the wake still sees the record.
   */
  record(parentSessionId: string, settle: SettleRecord): void;
  /** The recorded result for one worker in one parent session, if still held. */
  lookup(parentSessionId: string, workerId: string, runId?: string): SettleRecord | undefined;
  /**
   * Await a settle record for one worker, bounded by `timeoutMs`
   * (`0` = non-blocking status read, no timer, no waiter registration).
   * Resolves `settled` when the record exists at call time or arrives during
   * the wait; on timeout `still-running`, or `gone` when the liveness probe
   * reports the worker's agent dead; on abort/deactivation `released`.
   * The abort signal is the awaiting turn's (design: `exec.signal`).
   * Callers validate the timeout ({@link validateAwaitTimeout}) and resolve
   * the target ({@link resolveAwaitTarget}) first; a non-positive timeout is
   * treated as the `0` read.
   */
  wait(
    parentSessionId: string,
    workerId: string,
    timeoutMs: number,
    signal?: AbortSignal,
    runId?: string,
  ): Promise<AwaitWorkerOutcome>;
  /**
   * Release every active waiter of one dispatcher session: each resolves
   * `released`, its timer cancelled. Called on session deactivation so no
   * waiter or timer outlives a deactivated dispatcher. Records are NOT
   * cleared — deactivation is not a restart.
   *
   * Always `reason: "stopped"`; the user-message release has its own entry
   * point, {@link releaseWaits}.
   */
  cancelWaits(sessionId: string): void;
  /**
   * Ticket 117: release every active waiter of one dispatcher session with an
   * explicit reason, each timer cancelled. The adapter calls this with
   * `"user-message"` when it observes a real user prompt on that session's own
   * `session/event` stream (structured `source.kind`, never text), so a user
   * is never held behind a running await. Waiters of OTHER sessions are
   * untouched; records are untouched; the awaited workers are NOT stopped.
   *
   * No-op when the session has no waiters — a call is never an error.
   */
  releaseWaits(sessionId: string, reason: AwaitReleasedReason): void;
  /** Active waiters for a session (status/tests). */
  waiterCount(sessionId: string): number;
}

interface PendingWait {
  readonly parentSessionId: string;
  readonly workerId: string;
  readonly runId?: string;
  readonly finish: (compose: (waitedMs: number) => AwaitWorkerOutcome) => void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

function settledOutcome(settle: SettleRecord, waitedMs: number): AwaitWorkerOutcome {
  return {
    ok: true,
    status: "settled",
    workerStatus: settle.status,
    result: settle.resultText,
    settledAtMs: settle.settledAtMs,
    waitedMs,
  };
}

function refused(
  reason: AwaitRefusalReason,
  detail: string,
): AwaitWorkerRefusal {
  return { ok: false, reason, detail };
}

export function createSettleRecords(
  options?: SettleRecordsOptions,
): SettleRecords {
  const now = options?.now ?? (() => Date.now());
  const schedule = options?.schedule ?? defaultSchedule;
  const isAgentAlive = options?.isAgentAlive;

  /** One insertion-ordered ring per parent session; oldest entry evicted. */
  const rings = new Map<string, Map<string, SettleRecord>>();
  const waiters = new Map<string, Set<PendingWait>>();

  function lookup(
    parentSessionId: string,
    workerId: string,
    runId?: string,
  ): SettleRecord | undefined {
    const ring = rings.get(parentSessionId);
    if (runId !== undefined) return ring?.get(JSON.stringify([workerId, runId]));
    let latest: SettleRecord | undefined;
    for (const record of ring?.values() ?? []) {
      if (record.workerId === workerId) latest = record;
    }
    return latest;
  }

  function elapsed(startedAtMs: number): number {
    return Math.max(0, now() - startedAtMs);
  }

  /**
   * Release every waiter of one session with one reason. Shared by
   * `cancelWaits` (`"stopped"`) and `releaseWaits` (`"user-message"`); the
   * release path is identical apart from the reason, so it lives once.
   */
  function releaseAll(sessionId: string, reason: AwaitReleasedReason): void {
    const pending = waiters.get(sessionId);
    if (pending === undefined) return;
    // Copy first: finish mutates the set while it is iterated.
    for (const waiter of [...pending]) {
      waiter.finish((waitedMs) => ({
        ok: true,
        status: "released",
        reason,
        waitedMs,
      }));
    }
  }

  return {
    record(parentSessionId: string, settle: SettleRecord): void {
      let ring = rings.get(parentSessionId);
      if (ring === undefined) {
        ring = new Map<string, SettleRecord>();
        rings.set(parentSessionId, ring);
      }
      const key = settle.runId === undefined ? settle.workerId : JSON.stringify([settle.workerId, settle.runId]);
      if (settle.runId !== undefined && ring.has(key)) return;
      if (!ring.has(key) && ring.size >= SETTLE_RING_SIZE) {
        // Evict the oldest record: first key in insertion order.
        const oldest = ring.keys().next();
        if (oldest.done !== true) {
          ring.delete(oldest.value);
        }
      }
      ring.set(key, settle);
      // Record arrival wins the race: release every waiter on this worker.
      const pending = waiters.get(parentSessionId);
      if (pending === undefined) return;
      for (const waiter of [...pending]) {
        if (waiter.workerId !== settle.workerId) continue;
        if (waiter.runId !== undefined && waiter.runId !== settle.runId) continue;
        waiter.finish((waitedMs) => settledOutcome(settle, waitedMs));
      }
    },

    lookup,

    wait(
      parentSessionId: string,
      workerId: string,
      timeoutMs: number,
      signal?: AbortSignal,
      runId?: string,
    ): Promise<AwaitWorkerOutcome> {
      const startedAtMs = now();
      // Record first: a record present at call time settles the wait
      // immediately, whatever the timeout — this is what makes `timeoutMs: 0`
      // a settled-result read and what a wait racing the wake relies on.
      const existing = lookup(parentSessionId, workerId, runId);
      if (existing !== undefined) {
        return Promise.resolve(settledOutcome(existing, 0));
      }
      // Ticket race set: an abort that already happened needs no timer.
      if (signal?.aborted === true) {
        return Promise.resolve({
          ok: true,
          status: "released",
          reason: "stopped",
          waitedMs: elapsed(startedAtMs),
        });
      }
      if (timeoutMs <= 0) {
        // Non-blocking status read: no timer, no waiter registration.
        const gone =
          isAgentAlive !== undefined && !isAgentAlive(workerId);
        return Promise.resolve(
          gone
            ? { ok: true, status: "gone", waitedMs: 0 }
            : { ok: true, status: "still-running", waitedMs: 0 },
        );
      }
      if ((waiters.get(parentSessionId)?.size ?? 0) >= MAX_CONCURRENT_WAITS) {
        return Promise.resolve(
          refused(
            "too-many-waits",
            `${MAX_CONCURRENT_WAITS} workers are already being awaited in this session; resolve or cancel one before waiting again`,
          ),
        );
      }
      return new Promise<AwaitWorkerOutcome>((resolve) => {
        let finished = false;
        let cancelTimeout: () => void = () => {};
        const waiter: PendingWait = {
          parentSessionId,
          workerId,
          ...(runId !== undefined ? { runId } : {}),
          finish: (compose) => {
            if (finished) return;
            finished = true;
            // Every losing racer is cleaned up exactly here: timer cancelled,
            // abort listener dropped, waiter unregistered — the "finally" the
            // ticket asks for, expressed once for all outcome paths.
            cancelTimeout();
            if (signal !== undefined) {
              signal.removeEventListener("abort", onAbort);
            }
            const set = waiters.get(parentSessionId);
            if (set !== undefined) {
              set.delete(waiter);
              if (set.size === 0) waiters.delete(parentSessionId);
            }
            resolve(compose(elapsed(startedAtMs)));
          },
        };
        const onAbort = (): void => {
          waiter.finish((waitedMs) => ({
            ok: true,
            status: "released",
            reason: "stopped",
            waitedMs,
          }));
        };
        cancelTimeout = schedule(() => {
          // The liveness port is consulted once, here at the timeout —
          // never on a timer (ticket 115).
          const gone = isAgentAlive !== undefined && !isAgentAlive(workerId);
          waiter.finish((waitedMs) =>
            gone
              ? { ok: true, status: "gone", waitedMs }
              : { ok: true, status: "still-running", waitedMs },
          );
        }, timeoutMs);
        if (signal !== undefined) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
        let set = waiters.get(parentSessionId);
        if (set === undefined) {
          set = new Set<PendingWait>();
          waiters.set(parentSessionId, set);
        }
        set.add(waiter);
      });
    },

    cancelWaits(sessionId: string): void {
      releaseAll(sessionId, "stopped");
    },

    releaseWaits(sessionId: string, reason: AwaitReleasedReason): void {
      releaseAll(sessionId, reason);
    },

    waiterCount(sessionId: string): number {
      return waiters.get(sessionId)?.size ?? 0;
    },
  };
}

/**
 * Validate an await timeout (ticket bounds: 0–120,000 ms, default 30,000).
 * `undefined` takes the default; anything non-finite, negative, or over the
 * max is refused `invalid-timeout`. `0` is valid — the non-blocking read.
 */
export function validateAwaitTimeout(
  timeoutMs: number | undefined,
):
  | { readonly ok: true; readonly timeoutMs: number }
  | AwaitWorkerRefusal {
  if (timeoutMs === undefined) {
    return { ok: true, timeoutMs: AWAIT_DEFAULT_TIMEOUT_MS };
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  ) {
    return refused("invalid-timeout", AWAIT_INVALID_TIMEOUT_DETAIL);
  }
  if (timeoutMs > AWAIT_MAX_TIMEOUT_MS) {
    return refused(
      "invalid-timeout",
      `timeout_ms is capped at ${AWAIT_MAX_TIMEOUT_MS} milliseconds; a longer wait is not a chat turn`,
    );
  }
  return { ok: true, timeoutMs };
}

/**
 * Resolve an await target exactly as the design's §5 resolution order —
 * self first, then the caller's own worker roster, then live dispatcher
 * sessions, then unknown. One dispatcher never awaits another session's
 * worker or a dispatcher: dispatchers are peers, and peer-to-peer await is
 * the deadlock the refusal exists to prevent (refused, not timed out).
 * The target's parent-session guard matches the worker roster's:
 * `record.parentSessionId === callerSessionId`.
 */
export function resolveAwaitTarget(args: {
  readonly callerSessionId: string;
  readonly targetId: string;
  readonly getWorker: (workerId: string) => WorkerRecord | undefined;
  readonly isLiveDispatcherSession?: (sessionId: string) => boolean;
}): { readonly kind: "worker" } | { readonly kind: "refused"; readonly outcome: AwaitWorkerRefusal } {
  const { callerSessionId, targetId, getWorker, isLiveDispatcherSession } = args;
  // Self is refused before any lookup — there is no reference warrant for
  // awaiting your own session (same rule as `sendPeer`).
  if (targetId === callerSessionId) {
    return {
      kind: "refused",
      outcome: refused(
        "self-target",
        "the target is the calling dispatcher's own session; dispatchers are never awaitable",
      ),
    };
  }
  const worker = getWorker(targetId);
  if (worker !== undefined) {
    if (worker.parentSessionId === callerSessionId) {
      return { kind: "worker" };
    }
    return {
      kind: "refused",
      outcome: refused(
        "unknown-target",
        `worker "${targetId}" belongs to another dispatcher session; you can only await your own workers`,
      ),
    };
  }
  if (isLiveDispatcherSession?.(targetId) === true) {
    return {
      kind: "refused",
      outcome: refused(
        "not-awaitable",
        `"${targetId}" is a dispatcher session; dispatchers are peers and cannot be awaited — message it instead`,
      ),
    };
  }
  return {
    kind: "refused",
    outcome: refused(
      "unknown-target",
      `no worker "${targetId}" in this session and no live dispatcher session under that id`,
    ),
  };
}
