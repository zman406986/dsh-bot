/**
 * Pure formatters for dispatcher tool results (new copy only).
 * Check/steer/stop results are summarized, never dumped as raw JSON
 * and never include transcript contents.
 */

import {
  abortedReportBody,
  clampActivity,
  formatWakeReportBody,
  TOOL_RESULT_SUMMARY_MAX_ROWS,
} from "./report-clamp.js";
import type { WorkerLiveness } from "./liveness.js";
import type { AwaitWorkerOutcome } from "./settle-records.js";
import type { TerminalWorkerStatus, WorkerStatus, WorkerSummary } from "./types.js";
import type { WorkerStage } from "./worker-stage.js";

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
  /**
   * Ticket 171: the one stage this worker is in (see `worker-stage.ts`).
   * Nullable exactly like `liveness`, and for the same reason: `null` means
   * "not derivable here", never a guess. `check_workers` always derives it;
   * the default only protects positional callers that have no ledger.
   */
  readonly stage: WorkerStage | null;
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
      readonly reason:
        | "duplicate-stream-key"
        /** Ticket 151: a given `todo_id` named no ledger entry. No spawn ran. */
        | "unknown-todo-id"
        /** Ticket 151: the id already points at a worker. No spawn ran. */
        | "todo-already-linked";
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
  | {
      readonly ok: true;
      readonly note: string;
      /**
       * Readable-status display fields (additive): the target worker's id and
       * title, so a row can say `Steering Rewrite auth docs` instead of a
       * UUID. Optional because a dormant target has no roster title.
       */
      readonly worker_id: string;
      readonly title?: string;
      /** Present only when the target had no roster record (dormant). */
      readonly dormant?: true;
    }
  | {
      readonly ok: false;
      readonly reason: "unknown-worker" | "not-running";
      readonly detail: string;
    };

export type StopWorkerToolResult =
  | {
      readonly ok: true;
      readonly note: string;
      /** Readable-status display fields (additive). */
      readonly worker_id: string;
      readonly title?: string;
      /**
       * Which stop path ran: the ordinary live abort, or releasing the stream
       * a crash-time hold still owned. Display-only; the model-facing note
       * already distinguishes them.
       */
      readonly mode: "stopped" | "released-hold";
    }
  | {
      readonly ok: false;
      /**
       * `hold-release-failed`: the worker is a known crash-time hold, but the
       * store refused the marker drop, so nothing was released. Distinct from
       * `already-settled`, which means the id was never a live worker or hold
       * this session could see.
       */
      readonly reason: "already-settled" | "hold-release-failed";
      readonly detail: string;
    };

/**
 * `deliver_result`'s wire result.
 *
 * Delivery is conversational (ADR-0009): the shipped plugin wires no separate
 * user-facing send, so the dispatcher's own reply IS the channel. In that mode
 * `channel` is `"reply"` and `delivered` is true because the delivery
 * obligation is discharged when the result is committed to that reply — not
 * because the user has already read it. `channel: "send"` means the wired
 * send seam carried the text itself.
 *
 * `ok` is false whenever the requested effect did not happen: a failed send, a
 * todo id outside this session's ledger, or a ledger item that could not be
 * closed. `delivered` and `todo_completed` stay explicit so a caller never has
 * to infer the outcome from `ok`.
 */
export type DeliverResultToolResult =
  | {
      readonly ok: true;
      readonly delivered: true;
      /** How the text reaches the user: the wired send, or this reply. */
      readonly channel: "send" | "reply";
      readonly todo_completed: string | null;
      /** Display-only title of the completed entry (never report text). */
      readonly todo_title?: string;
      /**
       * Reply channel only: attachment paths that had no channel and were not
       * sent. The text is still recorded for the reply; files are not.
       */
      readonly attachments_not_sent?: number;
      readonly detail?: string;
    }
  | {
      readonly ok: false;
      readonly delivered: false;
      readonly todo_completed: null;
      readonly reason?: "unknown-target" | "send-failed";
      readonly detail?: string;
    };

/**
 * Honest success copy for a delivery whose channel is the dispatcher's own
 * reply (no user-facing send is wired — ADR-0009). It never says the user has
 * already seen the text: the reply has not happened yet when this is shown.
 */
export function formatDeliverResultRecorded(input: {
  readonly todoId?: string | null;
  readonly todoTitle?: string | null;
  readonly attachmentsNotSent?: number;
}): string {
  const parts = [
    "Result recorded — say it in your reply, which is how the user receives it.",
  ];
  const todoRef =
    typeof input.todoTitle === "string" && input.todoTitle.length > 0
      ? `"${input.todoTitle}"`
      : typeof input.todoId === "string" && input.todoId.length > 0
        ? deliverTodoDisplayRef(input.todoId)
        : null;
  if (todoRef !== null) {
    parts.push(`todo ${todoRef} marked done.`);
  }
  const attachments = input.attachmentsNotSent ?? 0;
  if (attachments > 0) {
    const noun = attachments === 1 ? "attachment path" : "attachment paths";
    const verb = attachments === 1 ? "was" : "were";
    parts.push(
      `${attachments} ${noun} ${verb} not sent — this build has no file channel.`,
    );
  }
  return parts.join(" ");
}

/** `todo-7` reads as `7` in a row; any other id is shown verbatim. */
export function deliverTodoDisplayRef(todoId: string): string {
  const stripped = todoId.replace(/^todo[-_]/i, "");
  return stripped.length > 0 ? stripped : todoId;
}

/**
 * Silent ledger fence for `deliver_result` (the same shape `message_agent`
 * uses for a foreign target): one line answers both a typo and another
 * dispatcher's todo, so the refusal never reveals that a foreign entry exists.
 */
export function formatDeliverResultUnknownTarget(todoId: string): string {
  return `No todo entry "${todoId}" in this session — nothing was delivered and nothing was marked completed.`;
}

/**
 * Silent worker fence shared by the roster tools: one line answers both a
 * typo and another dispatcher's worker, so existence never leaks.
 */
export function formatUnknownWorkerDetail(workerId: string): string {
  return `unknown worker: ${workerId}`;
}

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
 * spawn budget. ADR-0032 makes a summoned dispatcher a TOP-LEVEL session, so
 * only the bounds that govern a top-level session apply: the subagent
 * runtime's `maxDepth` ceiling and its live-child pool do not reach this path
 * at all.
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
 * - the child is a team-leader dispatcher with its own workers/ledger/inbox
 *   and its own user (ADR-0025 decision 4, ADR-0019 scoping, ticket 176);
 * - it gets the team-leader policy, and `spawn_dispatcher` is withheld from
 *   its surface, so it cannot summon further dispatchers (ticket 176);
 * - `message_agent` takes a dispatcher session id (ticket 116 routing);
 * - a dispatcher is NOT awaitable — `await_agent` refuses `not-awaitable`
 *   (ticket 117), so "do not wait on it" is a real constraint, not advice.
 */
export function formatSpawnDispatcherNote(input: {
  title: string;
  dispatcherId: string;
}): string {
  return [
    `Summoned "${input.title}" as a peer dispatcher — a team-leader dispatcher with its own workers, ledger, inbox and user, working from the prompt it was given; it does not see this conversation.`,
    "It cannot summon further dispatchers.",
    `Message it with message_agent addressed to ${input.dispatcherId}; its answer arrives later as its own message on a fresh turn. It is a dispatcher in its own chat with its own user and answers that user directly; what it sends you answers what you asked.`,
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
      /**
       * Readable-status display field (additive): true when the worker was
       * dormant and its session is being resumed. Absent on the live path, so
       * exact-shape callers are unaffected.
       */
      readonly dormant?: true;
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
 * Status-aware settle body shared by the await wire result and its summary.
 *
 * The settle path clamps every report through the completed-report path, so an
 * aborted or error settle with no text is stored as the "worker finished"
 * placeholder — and the adapter's own empty-error sentinel
 * ("worker failed with no message") can be stored verbatim. Neither is a
 * result. Status is authoritative: `formatWakeReportBody` substitutes the
 * honest body for that status, and a real partial report is kept but labelled
 * partial. A completed report passes through untouched.
 */
function normalizeSettledResult(
  status: TerminalWorkerStatus,
  result: string,
): string {
  return status === "completed"
    ? result
    : formatWakeReportBody(status, result);
}

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
    case "settled": {
      const body = normalizeSettledResult(outcome.workerStatus, outcome.result);
      // An aborted settle is status-aware: the placeholder is right only when
      // nothing real was stored. A worker stopped after producing findings
      // keeps them, labelled partial — discarding them would leave the
      // dispatcher with no answer to report.
      if (outcome.workerStatus === "aborted") {
        if (body === abortedReportBody()) {
          return [
            `Worker "${target}" settled: aborted.`,
            "It was stopped before it produced a report, so there is no result text to read. That is not a successful finish; decide what the user needs to know.",
          ].join("\n");
        }
        return [
          `Worker "${target}" settled: aborted.`,
          `Result:\n${body}`,
          "That report is partial — the worker was stopped before finishing, so it is not a completed deliverable. Decide what the user needs to know.",
        ].join("\n");
      }
      return [
        `Worker "${target}" settled: ${outcome.workerStatus}.`,
        body.length > 0 ? `Result:\n${body}` : "It produced no report text.",
        outcome.workerStatus === "completed"
          ? "Continue from this result."
          : "That is not a successful finish; decide what the user needs to know.",
      ].join("\n");
    }
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
    case "settled": {
      // Status is authoritative, never the stored text. The settle path clamps
      // every report through the completed-report path, so an empty abort is
      // stored as the "worker finished" placeholder and an empty error may be
      // the adapter's own sentinel. The wire result carries the status-aware
      // body; the summary gets the RAW stored text so it normalizes once.
      const result = normalizeSettledResult(
        outcome.workerStatus,
        outcome.result,
      );
      return {
        ok: true,
        status: "settled",
        target,
        worker_status: outcome.workerStatus,
        result,
        settled_at_ms: outcome.settledAtMs,
        waited_ms: outcome.waitedMs,
        summary: formatAwaitNote(target, {
          status: "settled",
          workerStatus: outcome.workerStatus,
          result: outcome.result,
        }),
      };
    }
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
  stage: WorkerStage | null = null,
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
    stage,
  };
}

/**
 * Compact one-line (or two-line) row — never a JSON dump.
 *
 * running · "Rewrite auth docs" · 4m12s · 7 tool calls · todo t-3 · transcript: <ref> · liveness: quiet · stage: working
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
  // Ticket 171: the stage rides the same row, in the same style.
  if (row.stage !== null) parts.push(`stage: ${row.stage}`);
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
 * Stop copy for a known crash-time hold whose release the store refused.
 *
 * `releaseUnknownStateHold` used to collapse this with "nothing was held", so
 * `stop_worker` reported the hold as an unknown worker while the stream key
 * stayed occupied. The core now distinguishes the two; this copy reports the
 * real state: the hold (and its stream key) is still in place.
 */
export function formatStopHoldReleaseFailedNote(workerId: string): string {
  return `Could not release the hold — the store did not confirm. ${workerId} still holds its stream key; nothing was released, so retry when the store responds.`;
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
