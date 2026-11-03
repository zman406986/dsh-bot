/**
 * Worker liveness verdict (ticket 61; register A-8, ADR-0018 exception D22).
 *
 * A wedged worker was previously invisible: `check_workers` projects elapsed
 * time, tool-call count, and the latest activity phrase, and a human reads
 * all four and decides. This module derives the verdict the human was making
 * implicitly — `active` / `quiet` / `stalled` — as a PURE function over the
 * fields the check surface already carries, plus the caller's clock.
 *
 * Deliberately NOT a watchdog (the fidelity audit's §2 stage-4 finding
 * stands): the signal only makes a stalled worker visible; nothing is
 * killed, redriven, polled, or timed. Pull-only stays pull-only — the
 * observation moment is the `session/event` firehose arrival the adapter
 * already subscribes to (ticket 29), now recorded alongside the phrase.
 * No timers, no intervals, no background task; fully offline-testable by
 * passing `nowMs` (same discipline as todo-reconciler and report-clamp).
 * The reference has no worker-health probe at all — this is an approved
 * addition (D22), not a fidelity gap, and it must not be oversold: it lets
 * a user SEE a stalled worker; it does not recover one.
 */

import { isTerminalStatus, type WorkerStatus } from "./types.js";

/**
 * Liveness verdict vocabulary. `stalled` is a claim of silence beyond
 * {@link WORKER_STALL_THRESHOLD_MS}; `active` is advancement observed within
 * {@link WORKER_ACTIVE_WINDOW_MS}; `quiet` is everything else — "not
 * advancing, and nothing wrong inferred".
 */
export type WorkerLiveness = "active" | "quiet" | "stalled";

/**
 * Silence longer than this on a live, unblocked worker reads `stalled`
 * (ticket 61, R2: named constant, never a literal at a call site). Generous
 * on purpose: workers legitimately think between tool calls, and one false
 * `stalled` would make the whole signal untrustworthy.
 */
export const WORKER_STALL_THRESHOLD_MS = 10 * 60_000;

/** Activity observed within this window reads `active`. */
export const WORKER_ACTIVE_WINDOW_MS = 60_000;

/** Inputs — every field the check surface already projects (R4). */
export interface WorkerLivenessInput {
  /** Core FSM status. Terminal states never read `stalled` (R3). */
  readonly status: WorkerStatus;
  /** Host clock at worker creation (WorkerSummary.startedAtMs). */
  readonly startedAtMs: number;
  /** Tool calls the core counted (WorkerSummary.toolCallCount). */
  readonly toolCallCount: number;
  /**
   * Host clock of the last firehose-observed activity, projected
   * adapter-side (ticket 29's activity map, now carrying its observation
   * moment). `null` when nothing was ever observed or the worker settled.
   */
  readonly lastActivityAtMs: number | null;
}

/**
 * Derive the liveness verdict. Purity contract (R1): the ONLY clock is the
 * passed-in `nowMs` — no `Date.now()`, no timers, no polling.
 * Exactly-at-window is not yet stalled (same convention as
 * `isRosterSnapshotStale`).
 *
 * R3 precedence: terminal workers NEVER read `stalled` (completed / error /
 * aborted are settled states with their own meanings) — they read `quiet`,
 * meaning "not advancing, no problem inferred".
 *
 * When activity was never observed but the core HAS counted tool calls, the
 * advancement happened at an unknown moment between start and now —
 * claiming `stalled` from an unknown reference would be a guess, so the
 * honest verdict is `quiet`. Only a worker with no observed advancement AT
 * ALL (no timestamp, zero counted calls) can be measured from
 * `startedAtMs`.
 *
 * Ticket 75: the counted-calls/unknown-moment state below is now REACHABLE
 * in production, not just in tests — the adapter firehose advances the
 * count on every owned `tool/call` (including unreadable payloads, which
 * record no activity timestamp). Before that wiring the count was
 * structurally stuck at 0, so such a worker was measured from
 * `startedAtMs` and could read `stalled`; it now honestly reads `quiet`.
 */
export function deriveWorkerLiveness(
  input: WorkerLivenessInput,
  nowMs: number,
): WorkerLiveness {
  // R3: settled and aborted are distinct states with their own meanings; the
  // liveness signal must never rename them.
  if (isTerminalStatus(input.status)) return "quiet";
  const referenceMs =
    input.lastActivityAtMs ??
    (input.toolCallCount > 0 ? null : input.startedAtMs);
  // Unknown reference (advancement happened, moment unobserved): cannot
  // claim silence, cannot claim freshness — quiet, never guessed.
  // Reachable in production since ticket 75 (firehose counts calls whose
  // payloads record no activity timestamp).
  if (referenceMs === null) return "quiet";
  const quietForMs = Math.max(0, nowMs - referenceMs);
  if (quietForMs > WORKER_STALL_THRESHOLD_MS) return "stalled";
  if (input.lastActivityAtMs !== null && quietForMs <= WORKER_ACTIVE_WINDOW_MS) {
    return "active";
  }
  return "quiet";
}
