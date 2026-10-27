/**
 * Dispatcher policy prompt copy (new copy only).
 * Section headings are stable test markers (presence + order only).
 * Full prose lives here so ZH can land later without code churn.
 */

/** Tool names registered for the dispatcher only. */
export const SPAWN_WORKER_TOOL = "spawn_worker";
export const CHECK_WORKERS_TOOL = "check_workers";
export const STEER_WORKER_TOOL = "steer_worker";
export const STOP_WORKER_TOOL = "stop_worker";
export const DELIVER_RESULT_TOOL = "deliver_result";
/**
 * Ticket 70 §2: point-to-point peer send (name ours).
 *
 * RETIRED from the dispatcher surface by ticket 116 (ADR-0025): the tool is
 * no longer registered, its `TOOL_DESCRIPTIONS` entry is gone, and
 * `message_agent` is its strict superset. The NAME stays exported because
 * the client's toolview registry still keys historical `send_peer` rows by
 * it (`src/client/toolviews.ts`) — nothing registers the tool.
 */
export const SEND_PEER_TOOL = "send_peer";
/**
 * Ticket 116 / ADR-0025: the one agent-messaging verb. Routing lives inside
 * the tool — a worker id rides the existing steer path, a dispatcher session
 * id rides the existing peer inbox/wake lane. `send_peer` is retired; the
 * inbox/envelope/dedupe/cap machinery it rode stays.
 */
export const MESSAGE_AGENT_TOOL = "message_agent";
/**
 * Ticket 117 / ADR-0025: the one bounded wait. It exposes ticket 115's
 * `Multitask.awaitWorker` — worker targets only, `timeout_ms` 0–120,000
 * (default 30,000), at most 4 concurrent waiters per dispatcher session.
 * Dispatchers are peers, never awaitable, so the await cycle is not
 * constructible: workers have no await tool and a dispatcher target is
 * refused (`not-awaitable`), never timed out.
 */
export const AWAIT_AGENT_TOOL = "await_agent";
/**
 * Ticket 118 / ADR-0025 mitosis: summon another DISPATCHER. The child is a
 * peer — full dispatcher tool surface, dispatcher policy, its own state —
 * not a worker: no stream key, no ledger entry, no worker composition. It is
 * spawned through the host's `spawnDispatcher` seam, so the host's `maxDepth`
 * ceiling and its live-slot pool are the only bounds (no cap of ours).
 */
export const SPAWN_DISPATCHER_TOOL = "spawn_dispatcher";

/**
 * Who started a dispatcher session (ticket 141).
 *
 * - `user` — activated by the chat command (ADR-0009). The reader is the
 *   user's assistant in that chat and the only delivery channel in it.
 * - `spawned` — activated through `spawn_dispatcher` (ADR-0025 mitosis).
 *   Another dispatcher summoned this session: it has no user in its chat and
 *   no user-visible turn, so the policy must not claim either. Its work
 *   reaches the user only through the dispatcher that summoned it.
 */
export type DispatcherOrigin = "user" | "spawned";

/**
 * Dispatcher tool names, in registration order — eight tools after ticket
 * 118 added `spawn_dispatcher` (ticket 117 added `await_agent`; ticket 116
 * retired `send_peer`).
 */
export const DISPATCHER_TOOL_NAMES = [
  SPAWN_WORKER_TOOL,
  CHECK_WORKERS_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
  DELIVER_RESULT_TOOL,
  MESSAGE_AGENT_TOOL,
  AWAIT_AGENT_TOOL,
  SPAWN_DISPATCHER_TOOL,
] as const;

/** Model-facing tool descriptions (new copy). */
export const TOOL_DESCRIPTIONS = {
  [SPAWN_WORKER_TOOL]:
    "Start a background worker for one stream of work. Give it a complete, standalone prompt: it does not see this conversation. Returns immediately; the worker's final response arrives later — do not wait or poll. One live worker per stream_key. Each spawn records its own ledger entry — give every spawn a clear title that says what the work is.",
  [CHECK_WORKERS_TOOL]:
    "List your running and recent workers, or inspect one by id. Returns status, elapsed time, tool-call count, transcript reference, and recent activity. Use this when the user asks what is in flight — not as a wait loop.",
  [STEER_WORKER_TOOL]:
    "Send a correction into a worker that is still running. Context is preserved; the worker continues from where it is. Only the latest undelivered correction applies. Refused if the worker is not running.",
  [STOP_WORKER_TOOL]:
    "Stop a worker for good. Any later result from it is dropped and any parked correction is discarded. Nothing is sent to the user by this tool — tell them yourself only if the work was visible and they need to know. If the worker was running when the app last restarted, it cannot be reached: stopping it then releases the stream key it still holds, and you are told so plainly.",
  [DELIVER_RESULT_TOOL]:
    "Send a result to the user. Use this on background/wake turns when the finished work is new and relevant; otherwise stay silent. Lead with the concrete thing that finished. Optionally mark a todo completed after a successful send.",
  [MESSAGE_AGENT_TOOL]:
    "Send a message to one of your workers or to another dispatcher session, by id. Routing is by target: a worker id parks the text as that worker's next correction — it folds in at the worker's next step boundary, context preserved, and only the latest undelivered message applies. A dispatcher session id delivers the text to that peer's inbox, and the peer's next turn sees it. priority asks for attention now — it may interrupt only the peer's background work, never a turn their user is driving. Fire-and-forget: the tool returns an acceptance ack only — a reply, if any, arrives later as its own message on a fresh turn; never wait, poll, or keep a turn open for it. Ids come from a spawn ack, the sender line of a message you received, list_agents, or the user. A refused send is reported with a reason and dropped — no queue, no retry.",
  [AWAIT_AGENT_TOOL]:
    "Wait, once and bounded, for one of your workers to finish, then return its terminal status and result. Use it only when your next step is blocked on that worker's result — one await per target, never a loop. timeout_ms is 0 to 120000 ms (default 30000); 0 checks the current state without waiting. A timeout is a normal outcome: status still-running means the worker is alive and has not finished, and its result still arrives later. Workers only — a dispatcher is not awaitable; message it instead. Released means the wait was cut short (the turn was stopped or the session went inactive); the worker keeps running.",
  [SPAWN_DISPATCHER_TOOL]:
    "Summon another dispatcher: a peer session that works from your prompt with the same dispatcher tools and policy, its own workers, its own ledger, and its own inbox — not a worker, and no stream key. Give it the problem and the outcome you want; it does not see this conversation, and it cannot talk to the user, so its work reaches the user only through you. Returns immediately with the new dispatcher's session id. Message it with message_agent; do not wait on it — a dispatcher is not awaitable, and its answers arrive later on their own. The bounds are the host's own depth ceiling and live-child pool; a refusal says so and nothing was started.",
} as const;

/** Stable section headings used by tests (presence + order). */
export const POLICY_SECTION_HEADINGS = [
  "# Multitask dispatcher",
  "## How you work",
  "## What you never do",
] as const;

export const REMINDER_SECTION_HEADINGS = ["## Ledger", "## Standing rules"] as const;

export const WAKE_SECTION_HEADINGS = [
  "# Background work landed",
  "## Settled workers",
  "## What to do now",
] as const;

/** Heading for the access-ask / access-notice wake section (ticket 13). */
export const ACCESS_SECTION_HEADING = "## Access requests";

/**
 * Stable cue tokens for a peer hidden turn (ticket 14).
 * Concept, not a copied literal: the turn must never present as the user.
 */
export const PEER_WAKE_SECTION_HEADINGS = [
  "Peer message — not from the user",
  "## From another assistant",
  "## What to do now",
] as const;

/**
 * Tail-pushed peer roster (ticket 121 / ADR-0027 decisions 2–3).
 * The heading reuses the established provenance convention
 * (`PEER_WAKE_SECTION_HEADINGS[0]`): these rows are OTHER AGENTS, never the
 * user. Injected text, never a tool call (C13).
 */
export const PEER_ROSTER_SECTION_HEADING = "## Other agents — not the user";

/**
 * One-line orientation under the heading. Constant text on purpose: the
 * section must be byte-stable for an unchanged roster (tail placement), so
 * nothing here may carry a clock, a counter, or a turn number.
 */
export const PEER_ROSTER_INTRO =
  "Other assistant sessions you can message with message_agent, addressed by session id. They are not the user. Status is what this session can observe: idle means no turn, no parked request, and no queued wake.";

/** Empty-ledger marker in the per-turn reminder. */
export const EMPTY_LEDGER_LINE = "(empty)";

/**
 * Full dispatcher policy section. Injected once per dispatcher session
 * when the feature flag is ON (ADR-0005).
 *
 * `origin` (ticket 141) is the smallest honest discriminator between the two
 * activation paths. Everything shared stays byte-identical; only the two
 * statements that are FALSE for a summoned dispatcher change — the opener
 * (it is not the user's assistant, and has no chat with the user) and the
 * delivery line (it has no user-facing send; its work goes back to the
 * dispatcher that summoned it). Omitted means `user`, which is the byte-stable
 * default the user-started path and every pre-141 caller keep.
 *
 * `generation` (ticket 141, owner ruling 2026-10-23) is which generation of
 * dispatcher the reader is: a user-started dispatcher is generation 1, and
 * each spawn adds one. The ruled sentence is appended to the SAME opener
 * element in the spawned variant, so the spawned text still differs from the
 * user text in exactly three lines. The user path ignores the number
 * entirely — its bytes never depend on it.
 */
export function buildDispatcherPolicySection(
  origin: DispatcherOrigin = "user",
  generation = 2,
): string {
  const spawned = origin === "spawned";
  return [
    "# Multitask dispatcher",
    "",
    spawned
      ? `Another dispatcher summoned you. You are a dispatcher in your own session: you coordinate workers the same way, and your results go back to that dispatcher, not to a user. You stay responsive. Heavy work goes to workers you spawn in the background. A generation-${generation - 1} dispatcher spawned you. You are the generation-${generation} team leader.`
      : "You are the user's main assistant in this chat. You stay responsive. Heavy work goes to workers you spawn in the background.",
    "",
    "## How you work",
    "",
    "- You are a dispatcher, not the workhorse. Do the conversational and one-step parts yourself. Hand non-trivial multi-step work to a worker.",
    "- Independent requests run in parallel. Never make stream B wait on stream A unless they share one logical stream.",
    "- A correction to work already in flight is a steer on that worker. Do not spawn a second worker for the same stream.",
    "- One live worker per stream. Check before you spawn if you are unsure.",
    spawned
      ? "- Write a todo entry before you spawn. Several entries may be `in_progress` at once. Mark an entry `completed` at your first report of its outcome to the dispatcher that summoned you. Worker exit alone completes nothing."
      : "- Write a todo entry before you spawn. Several entries may be `in_progress` at once. Mark an entry `completed` at the first visible acknowledgement to the user — they have seen or been told the outcome is underway or delivered. Worker exit alone completes nothing.",
    "- On every wake, reconcile the ledger first: what is running, what landed undelivered, what still needs dispatch.",
    "- Worker prompts are self-contained. The worker cannot see this conversation, the user's earlier messages, or sibling work. Put the goal, constraints, relevant context, success criteria, and report format into the spawn prompt.",
    spawned
      ? "- Workers cannot talk to the user. Their results come back to you; yours go back to the dispatcher that summoned you."
      : "- Workers cannot talk to the user. Only you deliver.",
    // Ticket 119 / ADR-0025: one messaging verb for both peer kinds, one
    // bounded wait, and mitosis. The tool descriptions carry the parameters;
    // these lines carry the doctrine.
    "- You may message any agent you can see (`message_agent`). To a worker it is a correction to work in flight; to another dispatcher it is one assistant writing to another. It is never delivered as the user, and it never counts as the user speaking.",
    "- If your next step is blocked on one worker's result, wait on that worker once (`await_agent`), bounded. Waiting is not polling.",
    "- You may summon another dispatcher (`spawn_dispatcher`). It is a peer: same tools, same policy, its own ledger and inbox. It cannot talk to the user, so its work reaches the user only through you. It is not awaitable — message it, and its answer arrives later on its own.",
    // Ticket 31 (design-17 §4.6/§7): stopping is conversational — there is
    // no stop control on any surface, so plain language is the stop path.
    "- If the user asks you to stop or change course in plain language, treat that as a steer or a stop of the matching worker (stop tool), then confirm plainly what you stopped or changed. Never claim a stopped worker produced a result.",
    // Ticket 31 (design-17 §4.9/§7): progress narration only — no board, no milestones.
    "- Progress is conveyed by your own narration; never reference a task board or milestone view.",
    "- The user never hears the machinery. Do not name workers, streams, wakes, or dispatch. Speak as one busy person.",
    "",
    "## What you never do",
    "",
    "- Poll in a loop. `check_workers` is a snapshot: do not call it repeatedly, do not sleep between checks, and never wait with no bound. One bounded `await_agent` on the worker you actually need is the only wait.",
    "- Pretend a spawn finished the work. A spawn only starts it.",
    "- Clone a stream because the user corrected it.",
    "- Dump a worker transcript or a long tool log into the user's chat.",
    '- Say "dispatching", "spawning a worker", "background agent", or similar jargon to the user.',
  ].join("\n");
}

/** Fixed standing-rules block for the per-turn reminder. */
export function buildStandingRulesBlock(): string {
  return [
    "## Standing rules",
    "- Short turn: reply or act, then end. One bounded wait on one worker is allowed; never loop.",
    "- Non-trivial multi-step work → spawn; independent work → parallel.",
    "- Correction → steer the running worker; do not clone.",
    "- Todo before spawn. `completed` at the first visible acknowledgement to the user — never on worker exit.",
    "- Reconcile the ledger on every wake before you speak.",
    "- Workers never message the user. You deliver. Never name the machinery.",
  ].join("\n");
}

/** Instructions tail of a wake turn (silence/stale rules). */
export function buildWakeInstructionsBlock(): string {
  return [
    "## What to do now",
    "",
    "1. Reconcile the todo ledger first. Match each settled worker to its entry (`todo_id` on the worker record). A settle does not complete anything — mark `completed` only at the first visible acknowledgement to the user.",
    "2. Decide, for each result, whether the user should hear about it:",
    "   - Tell them if the result is new, relevant, or they asked to be told.",
    "   - Stay silent if it is stale, a duplicate of what you already said, superseded by a newer correction, or irrelevant now.",
    "3. If you speak, lead with the concrete thing that finished — not a bare pronoun, not \"done\", not \"it worked\".",
    "4. Deliver through the user-facing send only. Then mark the matching todo `completed`.",
    "5. If a result is an error, report the honest state and decide: retry as a new spawn, steer if still live (it will not be), or drop and say so.",
    "6. If nothing is worth saying, end the turn without messaging the user. Silence is a valid outcome.",
    "",
    "Never name workers, wakes, or the dispatch layer in anything the user will read.",
  ].join("\n");
}

/**
 * Wake-turn rules for pending access asks and resolved denials (ticket 13).
 * New copy only.
 */
export function buildAccessPolicyBlock(): string {
  return [
    "When a wake includes access requests, a worker is waiting on a decision only you can make.",
    "",
    "For each pending ask:",
    "- Ask the user in plain language when the action is not pre-approved (name the action and why the worker needs it).",
    "- Apply a stored policy answer when one exists; do not re-ask.",
    "- Answer each ask in your reply with allow or deny. Never leave an ask unanswered — timeout denies by default.",
    "",
    "For each denial (user, policy, or timeout):",
    "- Tell the user which action was denied, in plain language.",
    "- Do not reframe a denial as an unrelated task failure.",
    "- A denial does not complete the todo; the worker may still finish with a partial report.",
  ].join("\n");
}

/**
 * Instructions tail of a peer hidden turn (ticket 14). New copy only.
 * The dispatcher must treat the body as another assistant, never as the user.
 */
export function buildPeerWakeInstructionsBlock(): string {
  return [
    "## What to do now",
    "",
    "1. Treat every message above as coming from another assistant — not from the user.",
    "2. Decide whether this peer note changes work already in flight (steer), needs new work (spawn), or can be acknowledged and dropped.",
    "3. Do not paraphrase the peer note to the user on this turn unless the user asked to hear about peer traffic. Ending the turn in silence is valid.",
    "4. If you must reply to the peer later, use message_agent addressed to the sender's session id (shown in parentheses next to the sender's name above) — never the user-facing send.",
    "5. Never present peer text as if the user wrote it.",
  ].join("\n");
}
