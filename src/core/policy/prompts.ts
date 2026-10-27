/**
 * Dispatcher policy prompt copy (new copy only).
 * Section headings are stable test markers (presence + order only).
 * Full prose lives here so both language faces stay in one module: the
 * dispatcher policy section ships EN + ZH (ticket 153), the other assets
 * (standing rules, wake/access/peer blocks, tool descriptions) still ship
 * EN only.
 *
 * The ZH face is authored copy re-derived from the PRD rules, never a
 * translation of the reference tree's text (ADR-0018 exception B9).
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

/**
 * ZH counterparts of {@link POLICY_SECTION_HEADINGS}, same order (ticket 153).
 * Separate constants rather than a two-key record: the EN list is pinned by
 * existing tests, and a record would let a missing face read as `undefined`.
 */
export const POLICY_SECTION_HEADINGS_ZH = [
  "# 多任务调度器",
  "## 你的工作方式",
  "## 绝不要做的事",
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

// ── Language seam (ticket 153) ────────────────────────────────────────────

/**
 * The language of model-facing policy prose.
 *
 * The product has exactly one language switch: the host `locale` settings
 * namespace, whose `preference` field carries one of `LOCALE_IDS`
 * (`["zh", "en"]`) or nothing at all. The client dictionary is keyed by the
 * same two ids, so the policy face uses them verbatim instead of inventing a
 * second vocabulary.
 */
export type PolicyLanguage = "en" | "zh";

/** Every language the policy copy ships, in the host's declared order. */
export const POLICY_LANGUAGES: readonly PolicyLanguage[] = ["zh", "en"];

/**
 * Fail-closed selection: only an exact shipped id selects a non-EN face.
 * Absent, unreadable (`null`/`undefined`/a non-string), or a language we do
 * not ship (`"ja"`, `"zh-CN"`) all yield EN — the policy must never compose a
 * mixed-language block, and it must never guess.
 *
 * Deliberately no prefix matching: `"zh-CN"` is not a face we author, and a
 * half-translated policy is worse than an English one.
 */
export function resolvePolicyLanguage(preference: unknown): PolicyLanguage {
  return preference === "zh" ? "zh" : "en";
}

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
  language: PolicyLanguage = "en",
): string {
  return language === "zh"
    ? buildDispatcherPolicySectionZh(origin, generation)
    : buildDispatcherPolicySectionEn(origin, generation);
}

/** EN face of the dispatcher policy section — byte-stable since ticket 141. */
function buildDispatcherPolicySectionEn(
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
      ? "- Each spawn records its own todo entry. Several entries may be `in_progress` at once. Mark an entry `completed` at your first report of its outcome to the dispatcher that summoned you. Worker exit alone completes nothing."
      : "- Each spawn records its own todo entry. Several entries may be `in_progress` at once. Mark an entry `completed` at the first visible acknowledgement to the user — they have seen or been told the outcome is underway or delivered. Worker exit alone completes nothing.",
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

/**
 * ZH face of the dispatcher policy section (ticket 153).
 *
 * Authored copy, not a translation of any reference text (ADR-0018 B9): the
 * rules are re-derived from the PRD in Chinese and kept one-to-one with the
 * EN face — same bullets, same order, same line count, same directives.
 *
 * Terminology follows the client dictionary's zh face (`src/client/overlay.ts`)
 * so the model and the UI name the same things: 调度器 / 工作者 / 待办 / 纠偏 /
 * 流 / 送达 / 唤醒 / 会话 / 代理. Tool names and status literals stay ASCII
 * identifiers (`spawn_worker`, `in_progress`, `completed`, …); transliterating
 * them would break the tool contract.
 */
function buildDispatcherPolicySectionZh(
  origin: DispatcherOrigin = "user",
  generation = 2,
): string {
  const spawned = origin === "spawned";
  return [
    "# 多任务调度器",
    "",
    spawned
      ? `另一个调度器召唤了你。你在自己的会话里就是调度器：你用同样的方式协调工作者，你的结果回到那个调度器，而不是给用户。你要保持随时响应。繁重的工作交给你在后台启动的工作者。召唤你的是第 ${generation - 1} 代调度器。你是第 ${generation} 代团队负责人。`
      : "你是用户在这个聊天里的主要助手。你要保持随时响应。繁重的工作交给你在后台启动的工作者。",
    "",
    "## 你的工作方式",
    "",
    "- 你是调度器，不是干重活的人。对话和一步就能完成的部分自己做。复杂、多步的工作交给工作者。",
    "- 相互独立的请求并行推进。除非两条流属于同一个逻辑流，否则绝不要让流 B 等待流 A。",
    "- 对已经开始的工作做修正，就是对那个工作者发一次纠偏。不要为同一条流再启动第二个工作者。",
    "- 每条流只允许一个在运行的工作者。没把握就先查一下，再启动。",
    spawned
      ? "- 每次启动都会记下它自己的待办条目。可以同时有多条处于 `in_progress`。在你第一次向召唤你的调度器汇报该结果时，把该条目标为 `completed`。工作者退出本身不算完成。"
      : "- 每次启动都会记下它自己的待办条目。可以同时有多条处于 `in_progress`。在第一次对用户可见的确认时把该条目标为 `completed`——用户已经看到，或已被告知结果正在推进或已送达。工作者退出本身不算完成。",
    "- 每次唤醒先对齐账本：哪些在运行，哪些已经完成但还没送达，哪些还需要派出。",
    "- 给工作者的提示必须自包含。工作者看不到这个对话、用户之前的消息，也看不到同类的工作。把目标、约束、相关背景、成功标准以及汇报格式都写进启动提示里。",
    spawned
      ? "- 工作者不能和用户说话。他们的结果回到你这里；你的结果回到召唤你的那个调度器。"
      : "- 工作者不能和用户说话。只有你负责送达。",
    "- 你可以给任何你看得见的代理发消息（`message_agent`）。对工作者来说，这是对进行中工作的修正；对另一个调度器来说，这是一个助手写给另一个助手。它绝不会以用户身份送达，也永远不算作用户在说话。",
    "- 如果你的下一步卡在一个工作者的结果上，就对那个工作者等一次（`await_agent`），并设好上限。等待不是轮询。",
    "- 你可以召唤另一个调度器（`spawn_dispatcher`）。它是同伴：同样的工具、同样的策略，自己的账本和收件箱。它不能和用户说话，所以它的工作只能经由你到达用户。它不能被等待——给它发消息，它的答复之后会自己回来。",
    "- 如果用户用日常的话让你停下或改变方向，就把这当作对相应工作者的一次纠偏或停止（停止工具），然后直白地说明你停掉或改变了什么。绝不要声称已停止的工作者产出了结果。",
    "- 进度靠你自己的叙述来传达；绝不要提到任务看板或里程碑视图。",
    "- 用户永远看不到背后的运行细节。不要提工作者、流、唤醒或派发。就像一个忙碌的人那样说话。",
    "",
    "## 绝不要做的事",
    "",
    "- 循环轮询。`check_workers` 是快照：不要反复调用它，不要在两次查看之间休眠，也绝不要无上限地等待。对你真正需要的那个工作者做一次有上限的 `await_agent`，是唯一允许的等待。",
    "- 假装一次启动已经把活干完了。启动只是开始。",
    "- 因为用户做了修正，就复制出一条流。",
    "- 把工作者的记录或很长的工具日志倒进用户的聊天里。",
    "- 对用户说“派发中”“正在启动工作者”“后台代理”这类行话。",
  ].join("\n");
}

/** Fixed standing-rules block for the per-turn reminder. */
export function buildStandingRulesBlock(): string {
  return [
    "## Standing rules",
    "- Short turn: reply or act, then end. One bounded wait on one worker is allowed; never loop.",
    "- Non-trivial multi-step work → spawn; independent work → parallel.",
    "- Correction → steer the running worker; do not clone.",
    "- Each spawn records its own todo entry. `completed` at the first visible acknowledgement to the user — never on worker exit.",
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
