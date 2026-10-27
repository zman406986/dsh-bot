/**
 * Pure formatters for dispatcher tool results (new copy only).
 * Check/steer/stop results are summarized, never dumped as raw JSON
 * and never include transcript contents.
 */

import {
  clampActivity,
  TOOL_RESULT_SUMMARY_MAX_ROWS,
} from "./report-clamp.js";
import type { WorkerLiveness } from "./liveness.js";
import type { AwaitWorkerOutcome } from "./settle-records.js";
import type { TerminalWorkerStatus, WorkerStatus, WorkerSummary } from "./types.js";

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
  /**
   * Ticket 61 (register A-8, ADR-0018 exception D22): derived liveness
   * verdict over this row's own fields. Visibility only — no remedy rides
   * on it, and nothing is killed or redriven from it. `null` when the
   * activity-time seam is absent: absence is honest ("not derivable
   * here"), never a guessed verdict.
   */
  readonly liveness: WorkerLiveness | null;
}

export type SpawnWorkerToolResult =
  | {
      readonly ok: true;
      readonly worker_id: string;
      readonly stream_key: string;
      readonly title: string;
      /**
       * Ticket 69 (chunk B presentation contract): present only when the
       * spawn proceeded THROUGH the review-posture gate (a posture row gated
       * the dispatch class and the host approval seam answered
       * `allowed-once`). Absent for the shipped ungated spawn, so the
       * serialized tool-call record lets the client's dispatch-card
       * projection derive honest `gating` provenance at presentation time
       * (replay-safe: the marker rides the durable record, not client state).
       */
      readonly gated?: true;
      /** Model-facing ack text. Not user-visible. */
      readonly ack: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "duplicate-stream-key"
        | "auto-review-refused"
        /** Ticket 151: a given `todo_id` named no ledger entry. No spawn ran. */
        | "unknown-todo-id";
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

/**
 * Ticket 118 / ADR-0025 mitosis: `spawn_dispatcher`'s wire result.
 *
 * The ok branch is the ticket's exact shape — `dispatcher_id`, `title`, and a
 * model-facing `note`. The note is the only place the model learns the child
 * is a PEER (message it, never wait on it); `dispatcher_id` is the address
 * `message_agent` takes.
 *
 * Failures are limited to what is real: `invalid-args` (an empty title or
 * prompt — nothing was attempted) and `host-refused` (the host's own spawn
 * error, its text passed through verbatim in `detail`). There is deliberately
 * no `recursion-limit`, no `dispatcher-cap`, no generation counter and no
 * spawn budget: ADR-0025 settles that the host's `maxDepth` ceiling and live
 * child pool are the only bounds.
 */
export type SpawnDispatcherToolResult =
  | {
      readonly ok: true;
      readonly dispatcher_id: string;
      readonly title: string;
      /** Model-facing peer/session note. Not user-visible. */
      readonly note: string;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid-args" | "host-refused";
      readonly detail: string;
    };

/**
 * Ticket 118: the `spawn_dispatcher` success note.
 *
 * Every claim here is checked against the shipped surface:
 * - the child is a dispatcher peer with the dispatcher tool set and its own
 *   workers/ledger/inbox (ADR-0025 decision 4, ADR-0019 scoping);
 * - `message_agent` takes a dispatcher session id (ticket 116 routing);
 * - a dispatcher is NOT awaitable — `await_agent` refuses `not-awaitable`
 *   (ticket 117), so "do not wait on it" is a real constraint, not advice.
 */
export function formatSpawnDispatcherNote(input: {
  title: string;
  dispatcherId: string;
}): string {
  return [
    `Summoned "${input.title}" as a peer dispatcher (session ${input.dispatcherId}).`,
    "It runs with the same dispatcher tools and policy as you, its own workers, its own ledger, and its own inbox, and it works from the prompt it was given — it does not see this conversation.",
    `Message it with message_agent addressed to ${input.dispatcherId}; its answer arrives later as its own message on a fresh turn. It cannot talk to the user, so its work reaches the user only through you.`,
    "Do not wait on it: a dispatcher is not awaitable (await_agent is workers-only). Tell the user what is underway if they need to know, then end the turn or move to other work.",
  ].join(" ");
}

/**
 * Ticket 116 / ADR-0025: the one agent-messaging verb. The ok branch is the
 * honest fire-and-forget ack — acceptance into the target's lane only
 * (`delivered_as` records WHICH lane: the steer path or the peer inbox);
 * never user delivery, never a reply, never "the agent read it". Failures
 * carry a closed refusal vocabulary with NO retry affordance and NO
 * queueing (A4; the conservative U-A reading per ticket 82).
 */
export type MessageAgentToolResult =
  | {
      readonly ok: true;
      readonly target: string;
      /** Which existing lane accepted it: the steer path or the peer inbox. */
      readonly delivered_as: "steer" | "peer";
      readonly message_id: string;
      /** Model-facing fire-and-forget ack text. Not user-visible. */
      readonly note: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "unknown-target"
        | "self-target"
        | "not-running"
        | "inbox-full"
        | "rate-limited"
        | "invalid-envelope";
      readonly detail: string;
    };

/**
 * Ticket 116: refusal copy per reason for `message_agent` — a failed send is
 * reported and dropped (no retry control, no queue). `invalid-envelope` and
 * `rate-limited` carry their detail inline at the refusal site; the rest are
 * canned here so the copy stays in one place.
 */
export function formatMessageAgentRefusal(input: {
  reason: "unknown-target" | "self-target" | "not-running" | "inbox-full";
  target: string;
}): string {
  switch (input.reason) {
    case "unknown-target":
      return `No agent "${input.target}" — it is not one of your workers and no live dispatcher session carries that id. The message was NOT delivered and was not queued. There is no retry for an agent message.`;
    case "self-target":
      return `"${input.target}" is your own session. Messaging yourself is refused — nothing was sent.`;
    case "not-running":
      return `Worker "${input.target}" is not running (it may already be done). The message was NOT delivered — there is no retry for a finished worker.`;
    case "inbox-full":
      return `"${input.target}" already has a full inbox of undelivered messages. The message was NOT delivered and was not queued.`;
  }
}

/** Ticket 116: rate-cap refusal copy (the shared agent-message budget). */
export function formatMessageAgentRateLimited(input: {
  limit: number;
  windowSeconds: number;
}): string {
  return (
    `Agent-message rate limit reached: at most ${input.limit} messages per ` +
    `${input.windowSeconds} seconds from this session. Nothing was sent and ` +
    `nothing was queued; batch your next message.`
  );
}

/**
 * Ticket 116: `message_agent` steer-branch success note. The steer path is
 * unchanged (single-slot last-wins park, interrupt, wrapped send at the next
 * step boundary) — the copy names those semantics without a restart promise.
 */
export function formatMessageAgentSteerNote(title: string): string {
  return `Message parked for "${title}". It folds in at the worker's next step boundary and the worker continues from where it is — no restart. If you message this worker again before delivery, only the latest message applies.`;
}

/**
 * Ticket 142: `message_agent`'s steer-branch note for a DORMANT worker (an id
 * carried by its durable wake row with no live session). The host resumes the
 * session and the text arrives as its next message, so the live path's "next
 * step boundary" promise would be false here. It still promises no reply and
 * keeps the last-wins rule for repeat sends before delivery.
 */
export function formatMessageAgentDormantSteerNote(title: string): string {
  return `Message accepted for dormant worker "${title}". Its session is being resumed; the message is delivered as its next turn. If you message this worker again before it comes back, only the latest message applies.`;
}

/**
 * Ticket 117 / ADR-0025: `await_agent`'s wire result. Snake_case on purpose —
 * the core's {@link AwaitWorkerOutcome} is camelCase, so the tool layer maps
 * field for field at the single boundary in {@link toAwaitAgentToolResult}.
 *
 * Success carries `ok: true` even for a timeout: `still-running` and `gone`
 * are valid outcomes, not errors. `released` says the WAIT ended early —
 * `reason` names which racer won (`user-message` waits for adapter wiring;
 * `stopped` is a turn abort or session deactivation). The worker itself keeps
 * running in every `released` case.
 */
export type AwaitAgentToolResult =
  | {
      readonly ok: true;
      readonly status: "settled";
      readonly target: string;
      readonly worker_status: TerminalWorkerStatus;
      readonly result: string;
      readonly settled_at_ms: number;
      readonly waited_ms: number;
      /** Model-facing summary text. Not user-visible. */
      readonly summary: string;
    }
  | {
      readonly ok: true;
      readonly status: "still-running" | "gone";
      readonly target: string;
      readonly waited_ms: number;
      readonly summary: string;
    }
  | {
      readonly ok: true;
      readonly status: "released";
      readonly target: string;
      readonly reason: "user-message" | "stopped";
      readonly waited_ms: number;
      readonly summary: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "unknown-target"
        | "self-target"
        | "not-awaitable"
        | "too-many-waits"
        | "invalid-timeout";
      readonly detail: string;
    };

/**
 * Ticket 117: success copy per await outcome. Short and factual — the model
 * must know whether it now has the result, whether the worker is still alive,
 * or whether the wait was cut short (and that the worker was NOT stopped).
 *
 * `settled` embeds the result text: the host's render path sends only this
 * summary block to the model, so "its result is above" would be a lie.
 */
export function formatAwaitNote(
  target: string,
  outcome:
    | {
        readonly status: "settled";
        readonly workerStatus: TerminalWorkerStatus;
        readonly result: string;
      }
    | { readonly status: "still-running" }
    | { readonly status: "gone" }
    | { readonly status: "released"; readonly reason: "user-message" | "stopped" },
): string {
  switch (outcome.status) {
    case "settled":
      return [
        `Worker "${target}" settled: ${outcome.workerStatus}.`,
        outcome.result.length > 0
          ? `Result:\n${outcome.result}`
          : "It produced no report text.",
        outcome.workerStatus === "completed"
          ? "Continue from this result."
          : "That is not a successful finish; decide what the user needs to know.",
      ].join("\n");
    case "still-running":
      return `Worker "${target}" is still running — nothing is lost. Its result will arrive later on its own. Do not wait again in this turn; answer or end the turn.`;
    case "gone":
      return `No result was recorded for "${target}" and that worker is no longer alive, so its outcome is unknown. Do not wait for it again; tell the user plainly if this work mattered.`;
    case "released":
      return outcome.reason === "user-message"
        ? `The wait on "${target}" was released because the user said something — answer them now. The worker was not stopped and keeps running.`
        : `The wait on "${target}" was released (the turn was stopped or the session went inactive). The worker was not stopped: it keeps running and its result still arrives later.`;
  }
}

/**
 * Ticket 117: map ticket 115's camelCase core outcome onto `await_agent`'s
 * snake_case wire result. The ONE place the two naming conventions meet.
 */
export function toAwaitAgentToolResult(
  target: string,
  outcome: AwaitWorkerOutcome,
): AwaitAgentToolResult {
  if (!outcome.ok) {
    // Ticket 117 copy requirement: a dispatcher target must say to message
    // it and END THE TURN — it is a refusal about the tool model (the cycle
    // rule), not a "try again later". Every other refusal keeps the core's
    // own specific detail.
    const detail =
      outcome.reason === "not-awaitable"
        ? `"${target}" is a dispatcher session, not a worker. Dispatchers are peers and cannot be awaited. Send it a message with message_agent and end the turn — its answer arrives later on its own.`
        : outcome.detail;
    return { ok: false, reason: outcome.reason, detail };
  }
  switch (outcome.status) {
    case "settled":
      return {
        ok: true,
        status: "settled",
        target,
        worker_status: outcome.workerStatus,
        result: outcome.result,
        settled_at_ms: outcome.settledAtMs,
        waited_ms: outcome.waitedMs,
        summary: formatAwaitNote(target, {
          status: "settled",
          workerStatus: outcome.workerStatus,
          result: outcome.result,
        }),
      };
    case "still-running":
    case "gone":
      return {
        ok: true,
        status: outcome.status,
        target,
        waited_ms: outcome.waitedMs,
        summary: formatAwaitNote(target, { status: outcome.status }),
      };
    case "released":
      // `user-message` comes from the adapter's structured dispatcher-session
      // watch (ticket 117); `stopped` from turn abort or deactivation.
      return {
        ok: true,
        status: "released",
        target,
        reason: outcome.reason,
        waited_ms: outcome.waitedMs,
        summary: formatAwaitNote(target, {
          status: "released",
          reason: outcome.reason,
        }),
      };
  }
}

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
  liveness: WorkerLiveness | null = null,
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
    liveness,
  };
}

/**
 * Compact one-line (or two-line) row — never a JSON dump.
 *
 * running · "Rewrite auth docs" · 4m12s · 7 tool calls · todo t-3 · transcript: <ref> · liveness: quiet
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
  // Ticket 61: the liveness verdict rides the existing row shape (R5).
  if (row.liveness !== null) parts.push(`liveness: ${row.liveness}`);
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

/**
 * Ticket 142: `steer_worker`'s success note for a DORMANT worker — same
 * honesty rule as {@link formatMessageAgentDormantSteerNote}: the session is
 * being resumed, so there is no step boundary to fold into yet.
 */
export function formatDormantSteerNote(title: string): string {
  return `Correction accepted for dormant worker "${title}". Its session is being resumed; the correction is delivered as its next turn. If you send another correction before it comes back, only the latest applies.`;
}

/** Stop success note. Silent to the user by default. */
export function formatStopNote(): string {
  return "Stopped. Nothing further will arrive from this worker. Any correction parked for it is dropped. Tell the user only if the work was visible and they need to know it was cancelled.";
}

/**
 * Stop note for a worker that was live at crash time (ticket 59).
 *
 * Deliberately different from {@link formatStopNote}, because the difference is
 * the whole point: a normal stop reaches the worker, this one cannot. Saying
 * "Stopped" here would claim an interruption that never happened — and this
 * repo has already shipped one name that promised more than it did.
 */
export function formatStopUnknownStateNote(
  workerId: string,
  streamKey: string,
): string {
  return `Released the stream held by ${workerId}. That worker was never reachable — its state has been unknown since the restart and nothing was interrupted, so if it survived it is still running. Stream "${streamKey}" can be dispatched onto again, but only do that if you know that worker is gone; otherwise use a new stream key. Any result the old worker produces is dropped, and the user has not been told anything.`;
}

/**
 * Peer-lane accept ack, used by `message_agent`'s dispatcher branch
 * (ticket 70 §2 copy, kept by ticket 116 after `send_peer` retired).
 * Acceptance only — the copy must not promise delivery to a person, a
 * reply, or that the peer has read anything.
 */
export function formatPeerSendAck(input: {
  toSession: string;
  messageId: string;
  priority: boolean;
}): string {
  const priorityLine = input.priority
    ? "Priority was requested: it jumps the peer's queue and may interrupt their background work — never a turn their user is driving."
    : "It waits in their normal lane, behind whatever their user is driving.";
  return [
    `Accepted for peer session ${input.toSession} (message ${input.messageId}).`,
    "Their next turn will see it. This send carries no reply and waits for nothing — if the peer responds, it arrives later as its own message on a fresh turn. Do not wait, poll, or keep this turn open for it.",
    priorityLine,
  ].join("\n");
}
