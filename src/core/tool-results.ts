/**
 * Pure formatters for dispatcher tool results (new copy only).
 * Delivery, peer-message and dispatcher-summon results are summarized, never
 * dumped as raw JSON and never include transcript contents.
 */

import { sanitizeModelOptionValue } from "./model-option-value.js";
import type {
  ModelFallbackNotice,
  ModelResolutionFailure,
} from "./types.js";

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
 * Silent worker fence, kept as the shared helper for any caller that needs the
 * one-line unknown-worker answer: it reads the same for a typo and for another
 * dispatcher's worker, so existence never leaks.
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
      /**
       * Ticket 285: one entry per non-empty model option that fell back to
       * the inherited route. Absent when both options resolved or were
       * omitted.
       */
      readonly model_fallbacks?: readonly ModelFallbackNotice[];
    }
  | {
      readonly ok: false;
      readonly reason: "invalid-args" | "host-refused";
      readonly detail: string;
    };

/**
 * Ticket 285: the model-facing reason a rejected model option was not
 * used. One table for both spawn results, so the wording cannot drift.
 */
function modelFallbackReasonText(reason: ModelResolutionFailure): string {
  switch (reason) {
    case "unknown-model":
      return "not in the model catalog";
    case "ambiguous-model":
      return "it matches more than one provider; use provider/model";
    case "catalog-unavailable":
      return "the model catalog is unavailable";
    case "catalog-error":
      return "the model catalog could not be read";
  }
}

/**
 * Ticket 118: the `spawn_dispatcher` success note.
 *
 * Every claim here is checked against the shipped surface:
 * - the child is a team-leader dispatcher with its own workers/ledger/inbox
 *   and its own user (ADR-0025 decision 4, ADR-0019 scoping, ticket 176);
 * - it gets the team-leader policy, and `spawn_dispatcher` is withheld from
 *   its surface, so it cannot summon further dispatchers (ticket 176);
 * - `message_agent` takes a dispatcher session id (the peer lane);
 * - its answer arrives later as its own message on a fresh turn, and no wait
 *   tool exists, so ending the turn is the only correct move.
 */
export function formatSpawnDispatcherNote(input: {
  title: string;
  dispatcherId: string;
  /** Ticket 285: rejected model options; absent means none. */
  modelFallbacks?: readonly ModelFallbackNotice[];
}): string {
  const parts = [
    `Summoned "${input.title}" as a peer dispatcher — a team-leader dispatcher with its own workers, ledger, inbox and user, working from the prompt it was given; it does not see this conversation.`,
    "It cannot summon further dispatchers.",
    `Message it with message_agent addressed to ${input.dispatcherId}; its answer arrives later as its own message on a fresh turn. It is a dispatcher in its own chat with its own user and answers that user directly; what it sends you answers what you asked.`,
    "Do not wait or poll: its answer starts a new turn on its own. Tell the user what is underway if they need to know, then end the turn or move to other work.",
  ];
  // Ticket 285: one sentence per rejected value, appended at the end. A
  // resolved or omitted value adds nothing, so the pre-285 note is
  // byte-identical.
  for (const notice of input.modelFallbacks ?? []) {
    // Finding 8: the display value, not the raw model-authored string, so a
    // long or multi-line value cannot bloat or forge this note.
    const requested = sanitizeModelOptionValue(notice.requested);
    parts.push(
      notice.option === "model"
        ? `Leader model "${requested}" was not used (${modelFallbackReasonText(notice.reason)}); the summoned dispatcher uses your route.`
        : `Worker model "${requested}" was not used (${modelFallbackReasonText(notice.reason)}); the summoned dispatcher's workers use its route.`,
    );
  }
  return parts.join(" ");
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
