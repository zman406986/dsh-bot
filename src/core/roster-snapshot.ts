import type { WorkerStatus, WorkerSummary } from "./types.js";
import { ACCESS_CLASSES, type AccessClass, type AccessTicket } from "./access-types.js";
import type { TodoItem } from "./todo-reconciler.js";

/**
 * Compact roster snapshot — the wire contract for the dispatcher's status
 * surface (tickets 21 + 27; design-16 §4.2, design-17 §4.1).
 *
 * This module is deliberately dependency-light so BOTH faces can use it: the
 * host projects core state into a snapshot, and the browser bundle parses the
 * mirrored value it receives through the settings-watch channel. It is a
 * projection of core state — never a second source of truth (PRD persistence
 * rule; design-17 §5 conflict 8). Runtime imports are limited to the access
 * class vocabulary (a pure contract list shared with the relay); everything
 * else crosses as types only.
 *
 * The channel itself is the documented honest gap (design-16 §4.2): the
 * settings namespace is a config channel doing telemetry duty. Every read
 * therefore validates defensively (`parseRosterSnapshot`) and the panel
 * degrades to "unavailable" copy when the value is missing, malformed, or
 * stale.
 */

/**
 * Wire schema version. A mismatch fails parse → panel shows unavailable.
 * v2 (ticket 27) adds the presence fields: `kind`, `startedAtMs`,
 * `toolCallCount`, `delivered`, and structured `blocked`. v1 payloads fail
 * parse cleanly — the panel never renders a half-roster (design-17 §6).
 */
export const ROSTER_SNAPSHOT_SCHEMA_VERSION = 2;

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
const ACCESS_CLASS_SET: ReadonlySet<string> = new Set(ACCESS_CLASSES);

/** Key under the plugin's settings-namespace document that carries the snapshot. */
export const ROSTER_SETTINGS_KEY = "roster";

/** Structured blocked reason. Names only — never a secret value, never a
 * pre-rendered phrase (the panel localizes it; design-17 §4.1). */
export interface RosterSnapshotBlocked {
  readonly class: AccessClass;
  readonly target: string;
}

/**
 * One roster row on the wire (v2). `kind` types the producer for forward
 * compatibility (design-17 §5 conflict 6: workers are the only implemented
 * kind; the schema admits others without a second migration).
 */
export interface RosterSnapshotWorker {
  /** Producer kind; v2 ships exactly one: `"worker"`. */
  readonly kind: "worker";
  readonly workerId: string;
  readonly title: string;
  /** Core FSM vocabulary, verbatim. */
  readonly status: WorkerStatus;
  /** Linked ledger item id, when the spawn was todo-driven (ADR-0007). */
  readonly todoId: string | null;
  /** Host clock when the worker record was created (WorkerSummary). */
  readonly startedAtMs: number;
  /** Tool calls the core counted for this worker (WorkerSummary). */
  readonly toolCallCount: number;
  /**
   * Ledger delivered state for the linked todo (S4: completed means
   * delivered to the user). A worker with no ledger link owes nothing and
   * projects `true` — it can never sit landed-undelivered.
   */
  readonly delivered: boolean;
  /** Pending access ask joined by workerId, names only; `null` = not blocked. */
  readonly blocked: RosterSnapshotBlocked | null;
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
 * Core state the host hands to the projection (ticket 27). All optional so
 * a caller without the seam projects honest defaults (not blocked, nothing
 * owed). Both inputs are existing core truth read at publish time — the
 * projection never stores them.
 */
export interface RosterProjectionSources {
  /** Pending access tickets for the session (`Multitask.listPendingAccess`). */
  readonly pendingAccess?: readonly AccessTicket[];
  /** Ledger items for the session (`Multitask.listTodos`). */
  readonly todos?: readonly TodoItem[];
}

/**
 * Project the activated dispatcher's roster into a snapshot. Pure: reads
 * only the summaries, sources, and injected clock it is handed — the
 * snapshot is derived data, never stored back anywhere.
 */
export function projectRosterSnapshot(
  dispatcherSessionId: string,
  roster: readonly WorkerSummary[],
  publishedAtMs: number,
  sources: RosterProjectionSources = {},
): RosterSnapshot {
  const pendingAccess = sources.pendingAccess ?? [];
  const todos = sources.todos ?? [];
  return {
    schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
    dispatcherSessionId,
    publishedAtMs,
    workers: roster.map((worker) => {
      // First pending ask wins: the relay parks at most one per worker.
      const ask = pendingAccess.find((ticket) => ticket.workerId === worker.workerId);
      const linkedTodo =
        worker.todoId !== null
          ? todos.find((todo) => todo.id === worker.todoId)
          : undefined;
      return {
        kind: "worker",
        workerId: worker.workerId,
        title: worker.title,
        status: worker.status,
        todoId: worker.todoId,
        startedAtMs: worker.startedAtMs,
        toolCallCount: worker.toolCallCount,
        // No ledger link → no delivery obligation → nothing to mark landed.
        delivered: linkedTodo !== undefined ? linkedTodo.delivered : true,
        blocked:
          ask === undefined
            ? null
            : // Names only: class + target. Never `reason`, never a
              // credential value (access-types hard rule).
              { class: ask.body.class, target: ask.body.target },
      };
    }),
  };
}

/**
 * Defensive parse of a value received over the settings channel. Returns
 * `null` for anything that is not exactly a v2 snapshot: wrong shape, v1
 * payloads or other version skew, a non-finite clock, an unknown status or
 * producer kind, a malformed `blocked` reason, or a bad count — the honest
 * answer is "unavailable", not a partially hidden roster.
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
    if (row.kind !== "worker") return null;
    if (typeof row.workerId !== "string") return null;
    if (typeof row.title !== "string") return null;
    if (typeof row.status !== "string" || !STATUS_SET.has(row.status)) {
      return null;
    }
    if (row.todoId !== null && typeof row.todoId !== "string") return null;
    if (
      typeof row.startedAtMs !== "number" ||
      !Number.isFinite(row.startedAtMs) ||
      row.startedAtMs < 0
    ) {
      return null;
    }
    if (
      typeof row.toolCallCount !== "number" ||
      !Number.isSafeInteger(row.toolCallCount) ||
      row.toolCallCount < 0
    ) {
      return null;
    }
    if (typeof row.delivered !== "boolean") return null;
    const blocked = parseBlocked(row.blocked);
    if (blocked === undefined) return null;
    workers.push({
      kind: "worker",
      workerId: row.workerId,
      title: row.title,
      status: row.status as WorkerStatus,
      todoId: row.todoId,
      startedAtMs: row.startedAtMs,
      toolCallCount: row.toolCallCount,
      delivered: row.delivered,
      blocked,
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
 * Validate one `blocked` wire value. `undefined` means malformed (the whole
 * snapshot fails); `null` is a valid "not blocked". The class must be in the
 * shared access vocabulary — an unknown class is version skew, and unknown
 * vocabulary fails closed like an unknown status.
 */
function parseBlocked(value: unknown): RosterSnapshotBlocked | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.class !== "string" ||
    !ACCESS_CLASS_SET.has(record.class) ||
    typeof record.target !== "string"
  ) {
    return undefined;
  }
  return { class: record.class as AccessClass, target: record.target };
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
