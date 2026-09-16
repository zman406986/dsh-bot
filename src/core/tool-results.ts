/**
 * Pure formatters for dispatcher tool results (new copy only).
 * Check/steer/stop results are summarized, never dumped as raw JSON
 * and never include transcript contents.
 */

import {
  clampActivity,
  TOOL_RESULT_SUMMARY_MAX_ROWS,
} from "./report-clamp.js";
import type { WorkerStatus, WorkerSummary } from "./types.js";

/** One check row the model sees from `check_workers`. */
export interface WorkerCheckRow {
  readonly worker_id: string;
  readonly stream_key: string;
  readonly title: string;
  readonly status: WorkerStatus;
  readonly elapsed_ms: number;
  readonly tool_call_count: number;
  readonly transcript_ref: string | null;
  readonly todo_id: string | null;
  /** Last known activity phrase; null when none recorded yet. */
  readonly recent_activity: string | null;
}

export type SpawnWorkerToolResult =
  | {
      readonly ok: true;
      readonly worker_id: string;
      readonly stream_key: string;
      readonly title: string;
      /** Model-facing ack text. Not user-visible. */
      readonly ack: string;
    }
  | {
      readonly ok: false;
      readonly reason: "duplicate-stream-key";
      readonly detail: string;
    };

export type CheckWorkersToolResult =
  | {
      readonly ok: true;
      readonly rows: readonly WorkerCheckRow[];
      /** Compact table-like summary for the model. */
      readonly summary: string;
    }
  | {
      readonly ok: false;
      readonly reason: "unknown-worker";
      readonly detail: string;
    };

export type SteerWorkerToolResult =
  | { readonly ok: true; readonly note: string }
  | {
      readonly ok: false;
      readonly reason: "unknown-worker" | "not-running";
      readonly detail: string;
    };

export type StopWorkerToolResult =
  | { readonly ok: true; readonly note: string }
  | {
      readonly ok: false;
      readonly reason: "already-settled";
      readonly detail: string;
    };

export type DeliverResultToolResult = {
  readonly ok: boolean;
  readonly delivered: boolean;
  readonly todo_completed: string | null;
  readonly detail?: string;
};

/** Format elapsed milliseconds as a short human duration. */
export function formatElapsedMs(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h${remMinutes}m`;
}

/** Map a roster summary onto one check row. */
export function toCheckRow(
  summary: WorkerSummary,
  recentActivity: string | null = null,
): WorkerCheckRow {
  return {
    worker_id: summary.workerId,
    stream_key: summary.streamKey,
    title: summary.title,
    status: summary.status,
    elapsed_ms: summary.elapsedMs,
    tool_call_count: summary.toolCallCount,
    transcript_ref: summary.transcriptRef,
    todo_id: summary.todoId,
    recent_activity: clampActivity(recentActivity),
  };
}

/**
 * Compact one-line (or two-line) row — never a JSON dump.
 *
 * running · "Rewrite auth docs" · 4m12s · 7 tool calls · todo t-3 · transcript: <ref>
 *   activity: reading src/auth/session.ts
 */
export function formatCheckRowLine(row: WorkerCheckRow): string {
  const parts = [
    row.status,
    JSON.stringify(row.title),
    formatElapsedMs(row.elapsed_ms),
    `${row.tool_call_count} tool call${row.tool_call_count === 1 ? "" : "s"}`,
  ];
  if (row.todo_id !== null) parts.push(`todo ${row.todo_id}`);
  parts.push(
    row.transcript_ref !== null
      ? `transcript: ${row.transcript_ref}`
      : "transcript: (none)",
  );
  let line = parts.join(" · ");
  if (row.recent_activity !== null) {
    line += `\n  activity: ${row.recent_activity}`;
  }
  return line;
}

/** Fold a long roster into head/tail with a count line. */
export function formatCheckSummary(
  rows: readonly WorkerCheckRow[],
  maxRows: number = TOOL_RESULT_SUMMARY_MAX_ROWS,
): string {
  if (rows.length === 0) {
    return "No workers on the roster for this session.";
  }
  const shown = rows.slice(0, maxRows);
  const lines = shown.map(formatCheckRowLine);
  if (rows.length > maxRows) {
    lines.push(`… and ${rows.length - maxRows} more.`);
  }
  return lines.join("\n");
}

/** Spawn ack: background, do not wait or poll. New copy. */
export function formatSpawnAck(input: {
  title: string;
  workerId: string;
  streamKey: string;
  prompt: string;
}): string {
  return [
    `Started "${input.title}" in the background (worker ${input.workerId}, stream ${input.streamKey}).`,
    "",
    "It runs on its own. Its final response will arrive here when it finishes — you do not need to wait, poll, or keep this turn open. Answer the user now if they need a reply, then end the turn or move to other work.",
    "",
    "Self-contained prompt sent:",
    "---",
    input.prompt,
    "---",
  ].join("\n");
}

/** Steer success note. Does not re-echo the parked message. */
export function formatSteerNote(title: string): string {
  return `Correction parked for "${title}". It will fold in at the next step boundary and continue from where it is — no restart. If you send another correction before delivery, only the latest applies.`;
}

/** Stop success note. Silent to the user by default. */
export function formatStopNote(): string {
  return "Stopped. Nothing further will arrive from this worker. Any correction parked for it is dropped. Tell the user only if the work was visible and they need to know it was cancelled.";
}
