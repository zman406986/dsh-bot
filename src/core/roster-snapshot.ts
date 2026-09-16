import type { WorkerStatus, WorkerSummary } from "./types.js";

/**
 * Compact roster snapshot — the wire contract for the dispatcher's status
 * surface (ticket 21, design-16 §4.2).
 *
 * This module is deliberately dependency-free (only type imports from the
 * core) so BOTH faces can use it: the host projects core state into a
 * snapshot, and the browser bundle parses the mirrored value it receives
 * through the settings-watch channel. It is a projection of core state —
 * never a second source of truth (PRD persistence rule).
 *
 * The channel itself is the documented honest gap (design-16 §4.2): the
 * settings namespace is a config channel doing telemetry duty. Every read
 * therefore validates defensively (`parseRosterSnapshot`) and the panel
 * degrades to "unavailable" copy when the value is missing, malformed, or
 * stale.
 */

/** Wire schema version. A mismatch fails parse → panel shows unavailable. */
export const ROSTER_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * A snapshot older than this (host clock vs client clock at render time)
 * is treated as stale: the channel has no heartbeat, so a silent gap means
 * "unconfirmed" and the panel says so honestly instead of showing data it
 * can no longer vouch for.
 */
export const ROSTER_STALE_WINDOW_MS = 60_000;

/**
 * The exact core FSM vocabulary, used verbatim as the panel's status labels
 * (design-16 §6: "reuse the core FSM vocabulary … as-is" — no remapping into
 * a second display vocabulary). Note the design's prose predates the shipped
 * core; the actual vocabulary is the six WorkerStatus values.
 */
export const ROSTER_STATUS_KEYS: readonly WorkerStatus[] = [
  "spawned",
  "running",
  "steering",
  "completed",
  "error",
  "aborted",
];

const STATUS_SET: ReadonlySet<string> = new Set(ROSTER_STATUS_KEYS);

/** Key under the plugin's settings-namespace document that carries the snapshot. */
export const ROSTER_SETTINGS_KEY = "roster";

/** One roster row on the wire: the ticket's compact projection fields. */
export interface RosterSnapshotWorker {
  readonly workerId: string;
  readonly title: string;
  /** Core FSM vocabulary, verbatim. */
  readonly status: WorkerStatus;
  /** Linked ledger item id, when the spawn was todo-driven (ADR-0007). */
  readonly todoId: string | null;
}

/** The full snapshot envelope written into the settings namespace. */
export interface RosterSnapshot {
  readonly schemaVersion: number;
  /** The activated dispatcher session this roster belongs to. */
  readonly dispatcherSessionId: string;
  /** Host clock at projection time; the client checks this for staleness. */
  readonly publishedAtMs: number;
  readonly workers: readonly RosterSnapshotWorker[];
}

/**
 * Project the activated dispatcher's roster into a snapshot. Pure: reads
 * only the summaries it is handed plus the injected clock — the snapshot is
 * derived data, never stored back anywhere.
 */
export function projectRosterSnapshot(
  dispatcherSessionId: string,
  roster: readonly WorkerSummary[],
  publishedAtMs: number,
): RosterSnapshot {
  return {
    schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
    dispatcherSessionId,
    publishedAtMs,
    workers: roster.map((worker) => ({
      workerId: worker.workerId,
      title: worker.title,
      status: worker.status,
      todoId: worker.todoId,
    })),
  };
}

/**
 * Defensive parse of a value received over the settings channel. Returns
 * `null` for anything that is not exactly a v1 snapshot: wrong shape, wrong
 * schema version, non-finite clock, or an unknown status (a version skew —
 * the honest answer is "unavailable", not a partially hidden roster).
 */
export function parseRosterSnapshot(value: unknown): RosterSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== ROSTER_SNAPSHOT_SCHEMA_VERSION) return null;
  if (typeof record.dispatcherSessionId !== "string") return null;
  if (
    typeof record.publishedAtMs !== "number" ||
    !Number.isFinite(record.publishedAtMs) ||
    record.publishedAtMs < 0
  ) {
    return null;
  }
  if (!Array.isArray(record.workers)) return null;
  const workers: RosterSnapshotWorker[] = [];
  for (const entry of record.workers) {
    if (typeof entry !== "object" || entry === null) return null;
    const row = entry as Record<string, unknown>;
    if (typeof row.workerId !== "string") return null;
    if (typeof row.title !== "string") return null;
    if (typeof row.status !== "string" || !STATUS_SET.has(row.status)) {
      return null;
    }
    if (row.todoId !== null && typeof row.todoId !== "string") return null;
    workers.push({
      workerId: row.workerId,
      title: row.title,
      status: row.status as WorkerStatus,
      todoId: row.todoId,
    });
  }
  return {
    schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
    dispatcherSessionId: record.dispatcherSessionId,
    publishedAtMs: record.publishedAtMs,
    workers,
  };
}

/**
 * Staleness check: `true` when the snapshot is older than `windowMs`.
 * Exactly-at-window counts as fresh; beyond it, stale.
 */
export function isRosterSnapshotStale(
  snapshot: RosterSnapshot,
  nowMs: number,
  windowMs: number = ROSTER_STALE_WINDOW_MS,
): boolean {
  return nowMs - snapshot.publishedAtMs > windowMs;
}
