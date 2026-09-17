import type { WorkerStatus, WorkerSummary } from "./types.js";
import { isTerminalStatus } from "./types.js";
import { ACCESS_CLASSES, type AccessClass, type AccessTicket } from "./access-types.js";
import type { TodoItem } from "./todo-reconciler.js";
import { RECENT_RESULT_EXCERPT_CHARS, clampRecentResultExcerpt } from "./report-clamp.js";

/**
 * Compact roster snapshot — the wire contract for the dispatcher's status
 * surface (tickets 21 + 27; design-16 §4.2, design-17 §4.1).
 *
 * This module is deliberately dependency-light so BOTH faces can use it: the
 * host projects core state into a snapshot, and the browser bundle parses the
 * mirrored value it receives through the settings-watch channel. It is a
 * projection of core state — never a second source of truth (PRD persistence
 * rule; design-17 §5 conflict 8). Runtime imports are limited to the access
 * class vocabulary (a pure contract list shared with the relay) and the pure
 * report-clamp helpers (the shared excerpt bound + clamp, ticket 41);
 * everything else crosses as types only.
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
 * `toolCallCount`, `delivered`, and structured `blocked`. v3 (ticket 41)
 * adds the bounded envelope field `recentResult` — the deliverables line's
 * most-recent settled-undelivered excerpt. v1 AND v2 payloads fail parse
 * cleanly — the panel never renders a half-roster (design-17 §6; the
 * fail-closed rule design-17 §4.1 accepted for v1→v2 applies unchanged).
 */
export const ROSTER_SNAPSHOT_SCHEMA_VERSION = 3;

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
 * The deliverables line's excerpt (ticket 41, schema v3): the most recent
 * settled-undelivered worker's result text. Bounded by
 * {@link RECENT_RESULT_EXCERPT_CHARS} at projection AND at parse (a longer
 * string is wire corruption and fails the whole snapshot). Attribution only:
 * `workerId`/`title` are the same row vocabulary already on the wire.
 */
export interface RosterSnapshotRecentResult {
  readonly workerId: string;
  readonly title: string;
  readonly text: string;
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
  /**
   * Ticket 41 (v3): the most recent completed-but-not-delivered result
   * excerpt, or `null` when nothing is owed or no honest text exists (e.g.
   * a post-restart restore — markers deliberately carry no report text).
   * Cleared by projection the moment every owed row is delivered.
   */
  readonly recentResult: RosterSnapshotRecentResult | null;
}

/**
 * One settled report excerpt the adapter observed at settle time (ticket
 * 41). Adapter-side projection of the same `SettledEvent` the core receives
 * — the core stores no report text, so this stays existing-truth-only
 * (design-17 §5 conflict 8: no new core state).
 */
export interface RosterRecentResultSource {
  /** The (unclamped) report text observed at settle. */
  readonly text: string;
  /** Host clock at settle; the projection picks the most recent row. */
  readonly settledAtMs: number;
}

/**
 * Core state the host hands to the projection (ticket 27). All optional so
 * a caller without the seam projects honest defaults (not blocked, nothing
 * owed, no excerpt). Every input is existing core truth read at publish
 * time — the projection never stores them.
 */
export interface RosterProjectionSources {
  /** Pending access tickets for the session (`Multitask.listPendingAccess`). */
  readonly pendingAccess?: readonly AccessTicket[];
  /** Ledger items for the session (`Multitask.listTodos`). */
  readonly todos?: readonly TodoItem[];
  /**
   * Ticket 41: settled report excerpts by workerId, observed adapter-side
   * at settle time. A caller without the seam projects `recentResult: null`
   * and the deliverables line degrades to count-only.
   */
  readonly recentResultOf?: (workerId: string) => RosterRecentResultSource | null;
}

/**
 * Pick the deliverables line's excerpt (ticket 41): among terminal,
 * undelivered rows, the most recently settled one with an honest (non-empty)
 * observed report. Ties resolve to the later roster position so the pick is
 * deterministic. The text is clamped to the shared excerpt bound here — the
 * wire is bounded by construction, and the parse enforces the same bound.
 */
function pickRecentResult(
  workers: readonly RosterSnapshotWorker[],
  recentResultOf: ((workerId: string) => RosterRecentResultSource | null) | undefined,
): RosterSnapshotRecentResult | null {
  if (recentResultOf === undefined) return null;
  let best: RosterSnapshotRecentResult | null = null;
  let bestSettledAtMs = Number.NEGATIVE_INFINITY;
  for (const row of workers) {
    // Landed-undelivered only: the line never speaks for delivered rows or
    // workers still running (S6: completed means delivered).
    if (!isTerminalStatus(row.status) || row.delivered) continue;
    const source = recentResultOf(row.workerId);
    if (source === null || source === undefined) continue;
    const text = clampRecentResultExcerpt(source.text);
    if (text === null) continue;
    if (source.settledAtMs >= bestSettledAtMs) {
      best = { workerId: row.workerId, title: row.title, text };
      bestSettledAtMs = source.settledAtMs;
    }
  }
  return best;
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
  const projected: RosterSnapshotWorker[] = roster.map((worker) => {
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
    });
    return {
      schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
      dispatcherSessionId,
      publishedAtMs,
      workers: projected,
      recentResult: pickRecentResult(projected, sources.recentResultOf),
    };
  }

/**
 * Defensive parse of a value received over the settings channel. Returns
 * `null` for anything that is not exactly a v3 snapshot: wrong shape, v1/v2
 * payloads or other version skew, a non-finite clock, an unknown status or
 * producer kind, a malformed `blocked` reason, a missing or malformed
 * `recentResult`, or an unbounded excerpt — the honest answer is
 * "unavailable", not a partially hidden roster.
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
  const recentResult = parseRecentResult(record.recentResult);
  if (recentResult === undefined) return null;
  return {
    schemaVersion: ROSTER_SNAPSHOT_SCHEMA_VERSION,
    dispatcherSessionId: record.dispatcherSessionId,
    publishedAtMs: record.publishedAtMs,
    workers,
    recentResult,
  };
}

/**
 * Validate one `recentResult` wire value (ticket 41). `undefined` means
 * malformed — a missing key or wrong shape fails the WHOLE snapshot
 * (fail-closed; the projection always writes the field). `null` is the
 * valid "nothing owed / no honest text". An excerpt must carry a non-empty
 * workerId, a string title, and bounded non-empty text — an over-limit
 * string is version skew or corruption, never clamped silently here.
 */
function parseRecentResult(
  value: unknown,
): RosterSnapshotRecentResult | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.workerId !== "string" ||
    record.workerId.length === 0 ||
    typeof record.title !== "string"
  ) {
    return undefined;
  }
  if (typeof record.text !== "string" || record.text.length === 0) {
    return undefined;
  }
  if (record.text.length > RECENT_RESULT_EXCERPT_CHARS) return undefined;
  return { workerId: record.workerId, title: record.title, text: record.text };
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
