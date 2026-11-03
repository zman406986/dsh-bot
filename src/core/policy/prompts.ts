/**
 * Dispatcher policy prompt copy (new copy only).
 * Section headings are stable test markers (presence + order only).
 * Full prose lives here so both language faces stay in one module: every
 * asset in this module ships EN + ZH (ticket 153) — the policy section, the
 * standing rules, the wake/access/peer blocks, the peer roster, and the
 * eight tool descriptions. The worker contract keeps its two faces beside
 * this module in `src/worker/prompt.ts`.
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
 * not a worker: no stream key, no ledger entry, no worker composition.
 * ADR-0032: it is a TOP-LEVEL session (the host's `spawnDispatcher` seam
 * calls `ctx.agents.create` with no parent), so the subagent runtime's
 * `maxDepth` ceiling and its live-child pool do not bound it, and we set no
 * cap of ours — a tree of summoned dispatchers is uncapped (observed, not a
 * promise).
 */
export const SPAWN_DISPATCHER_TOOL = "spawn_dispatcher";

/**
 * Who started a dispatcher session (ticket 141).
 *
 * The two members select two policy CLASSES (owner-directed, 2026-11-02;
 * supersedes the 2026-10-28 ruling that every dispatcher got one text):
 * `user` is the chief of staff in the human's own chat, `spawned` is the team
 * leader another dispatcher summoned for one massive job. Both answer their
 * own user directly — ADR-0032 Q1 stands. The split governs the shape of the
 * work, not who may speak.
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
    "Start a background worker for one stream. Give it the problem, constraints and context it cannot look up — it cannot see this conversation, and it decides the method. Returns at once; its result arrives later. One live worker per stream_key. Each spawn records a todo entry, so title it clearly.",
  [CHECK_WORKERS_TOOL]:
    "List your running and recent workers, or inspect one by id: status, elapsed, tool count, transcript, recent activity. A snapshot — never a wait loop.",
  [STEER_WORKER_TOOL]:
    "Send a correction into a running worker. Context is kept; only the latest undelivered correction applies. Refused when the worker is not running.",
  [STOP_WORKER_TOOL]:
    "Stop a worker for good. Its later result and any parked correction are dropped. Nothing reaches the user from this tool. A worker that was live before a restart cannot be reached: stopping it releases the stream key it holds, and you are told so.",
  [DELIVER_RESULT_TOOL]:
    "Send a result to the user. Use it on wake turns only when the work is new and relevant; otherwise stay silent. Lead with the concrete thing finished. Optionally mark the matching todo completed.",
  [MESSAGE_AGENT_TOOL]:
    "Send text to a worker or another dispatcher, by id. A worker id parks it as that worker's next correction (latest wins; folds in at its next step). A dispatcher id drops it in that peer's inbox for its next turn; priority may interrupt only that peer's background work, never its user's turn. Fire-and-forget: you get an ack, and any reply arrives later on a fresh turn — never wait or hold a turn open. A refused send is reported and dropped.",
  [AWAIT_AGENT_TOOL]:
    "Wait once, bounded, for one worker to finish; return its terminal status and result. Use it only when your next step is blocked on that worker. timeout_ms 0–120000 (default 30000); 0 reads the current state. still-running and released are normal: the worker keeps going and its result still arrives. Workers only — a dispatcher is not awaitable.",
  [SPAWN_DISPATCHER_TOOL]:
    "Summon another dispatcher: a peer with your tools and policy, its own workers, ledger and inbox — not a worker. Give it the problem and the wanted outcome; it cannot see this conversation. It has its own chat and user, and answers them directly. Returns its session id at once. Message it with message_agent; never wait on it. Being top-level, it is not bound by the subagent depth limit or the live-child pool.",
} as const;

/**
 * ZH face of {@link TOOL_DESCRIPTIONS} (ticket 153). Same keys, same rules,
 * same numbers, same parameter names — only the prose is Chinese. Tool names
 * and argument names stay ASCII: they are the tool contract.
 */
export const TOOL_DESCRIPTIONS_ZH: Record<
  (typeof DISPATCHER_TOOL_NAMES)[number],
  string
> = {
  [SPAWN_WORKER_TOOL]:
    "为一条工作流启动一个后台工作者。把问题、约束，以及它自己查不到的背景交给它——它看不到这个对话，方法由它自己定。工具立即返回；结果稍后送到。每条 `stream_key` 只允许一个在运行的工作者。每次启动都会记下待办条目，所以标题要写清楚。",
  [CHECK_WORKERS_TOOL]:
    "列出在运行和最近的工作者，或按 id 查看其中一个：状态、已用时间、工具调用次数、记录、最近活动。这是快照，不是等待循环。",
  [STEER_WORKER_TOOL]:
    "向仍在运行的工作者发一次修正。上下文保留；只有最新一条尚未送达的修正生效。工作者没有在运行时会拒绝。",
  [STOP_WORKER_TOOL]:
    "永久停止一个工作者。它之后的结果和已停放的修正都会被丢弃。这个工具不会向用户发送任何东西。在上次重启时还活着的工作者联系不到：停止它会释放它占用的流键，并会明确告诉你。",
  [DELIVER_RESULT_TOOL]:
    "把结果送给用户。只在唤醒回合里、完成的工作是新的且相关时用它；否则保持沉默。开头先说清具体完成的是什么。可以选择把对应的待办标为完成。",
  [MESSAGE_AGENT_TOOL]:
    "按 id 给某个工作者或另一个调度器发文本。工作者 id 会把文本停放为它的下一条修正（以最新一条为准，在它的下一个步骤折入）。调度器 id 会把文本送进那个同伴的收件箱，等它下一个回合处理；`priority` 只能打断同伴的后台工作，绝不打断它用户的回合。发完即走：你只拿到受理回执，答复之后会作为新回合上的独立消息到达——绝不等待，也不要为它保持回合打开。被拒绝的发送会报告并丢弃。",
  [AWAIT_AGENT_TOOL]:
    "对一个工作者做一次有上限的等待，等它结束，返回最终状态和结果。只在你下一步卡在那个工作者上时使用。`timeout_ms` 为 0 到 120000（默认 30000）；0 表示只读当前状态。`still-running` 和 `released` 都是正常结果：工作者继续运行，结果之后仍会送到。只能等工作者——调度器不能被等待。",
  [SPAWN_DISPATCHER_TOOL]:
    "召唤另一个调度器：一个拥有你的工具和策略的同伴，有自己的工作者、账本和收件箱——不是工作者。把问题和你要的结果交给它；它看不到这个对话。它有自己的聊天和用户，会直接答复他们。立即返回它的会话 id。用 `message_agent` 给它发消息；绝不要等它。它是顶层会话，不受子代理深度上限和存活子会话池的限制。",
};

/**
 * Select the tool description face (ticket 153). Fail-closed to EN, exactly
 * like {@link resolvePolicyLanguage}.
 */
export function toolDescriptionsFor(
  language: PolicyLanguage,
): Readonly<Record<(typeof DISPATCHER_TOOL_NAMES)[number], string>> {
  return language === "zh" ? TOOL_DESCRIPTIONS_ZH : TOOL_DESCRIPTIONS;
}

/** Stable section headings used by tests (presence + order). */
export const POLICY_SECTION_HEADINGS = [
  "# Multitask dispatcher",
] as const;

/**
 * ZH counterparts of {@link POLICY_SECTION_HEADINGS}, same order (ticket 153).
 * Separate constants rather than a two-key record: the EN list is pinned by
 * existing tests, and a record would let a missing face read as `undefined`.
 */
export const POLICY_SECTION_HEADINGS_ZH = [
  "# 多任务调度器",
] as const;

export const REMINDER_SECTION_HEADINGS = ["## Ledger", "## Standing rules"] as const;

/** ZH counterparts of {@link REMINDER_SECTION_HEADINGS}, same order (ticket 153). */
export const REMINDER_SECTION_HEADINGS_ZH = ["## 账本", "## 常设规则"] as const;

export const WAKE_SECTION_HEADINGS = [
  "# Background work landed",
  "## Settled workers",
  "## What to do now",
] as const;

/** ZH counterparts of {@link WAKE_SECTION_HEADINGS}, same order (ticket 153). */
export const WAKE_SECTION_HEADINGS_ZH = [
  "# 后台工作已完成",
  "## 已结束的工作者",
  "## 现在该做什么",
] as const;

/**
 * Stable cue tokens for a peer hidden turn (ticket 14).
 * Concept, not a copied literal: the turn must never present as the user.
 */
export const PEER_WAKE_SECTION_HEADINGS = [
  "Peer message — not from the user",
  "## From another assistant",
  "## What to do now",
] as const;

/** ZH counterparts of {@link PEER_WAKE_SECTION_HEADINGS}, same order (ticket 153). */
export const PEER_WAKE_SECTION_HEADINGS_ZH = [
  "同伴消息——不是来自用户",
  "## 来自另一个助手",
  "## 现在该做什么",
] as const;

/**
 * Tail-pushed peer roster (ticket 121 / ADR-0027 decisions 2–3).
 * The heading reuses the established provenance convention
 * (`PEER_WAKE_SECTION_HEADINGS[0]`): these rows are OTHER AGENTS, never the
 * user. Injected text, never a tool call (C13).
 */
export const PEER_ROSTER_SECTION_HEADING = "## Other agents — not the user";

/** ZH counterpart of {@link PEER_ROSTER_SECTION_HEADING} (ticket 153). */
export const PEER_ROSTER_SECTION_HEADING_ZH = "## 其他代理——不是用户";

/**
 * One-line orientation under the heading. Constant text on purpose: the
 * section must be byte-stable for an unchanged roster (tail placement), so
 * nothing here may carry a clock, a counter, or a turn number.
 */
export const PEER_ROSTER_INTRO =
  "Other assistant sessions you can message with message_agent, addressed by session id. They are not the user. Status is what this session can observe: idle means no turn, no parked request, and no queued wake.";

/** ZH counterpart of {@link PEER_ROSTER_INTRO} (ticket 153). */
export const PEER_ROSTER_INTRO_ZH =
  "这些是你能用 message_agent 按会话 id 发消息的其他助手会话。它们不是用户。状态是本会话能观察到的东西：idle 表示没有回合、没有停放的请求、也没有排队的唤醒。";

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
 * TWO classes (owner-directed, 2026-11-02; supersedes the 2026-10-28 ruling
 * that one text served every dispatcher):
 *
 * - `user` — a dispatcher the human started in their own chat.
 * - `spawned` — a dispatcher another dispatcher summoned. It leads one large
 *   job and dispatches every part of it to workers. It is a different role
 *   with a different working shape, so it gets its own text.
 *
 * Both still answer their own user directly (ADR-0032 Q1 stands): the split
 * is about the shape of the work, not about who may speak.
 */
export function buildDispatcherPolicySection(
  origin: DispatcherOrigin = "user",
  generation = 2,
  language: PolicyLanguage = "en",
): string {
  if (origin === "spawned") {
    return language === "zh"
      ? buildSpawnedDispatcherSectionZh()
      : buildSpawnedDispatcherSectionEn();
  }
  return language === "zh"
    ? buildDispatcherPolicySectionZh(origin, generation)
    : buildDispatcherPolicySectionEn(origin, generation);
}

/** EN face of the dispatcher policy section — one text for every dispatcher. */
function buildDispatcherPolicySectionEn(
  _origin: DispatcherOrigin = "user",
  _generation = 2,
): string {
  return [
    "# Multitask dispatcher",
    "",
    "- You are the user's chief of staff for a large project.",
    "- You stay responsive. All work goes to workers and teams (`spawn_dispatcher`) you spawn. Do not do anything yourself unless extremely trivial.",
    "- Keep a timed ledger to track both progress and team/worker state and update it after any dispatch you send or receive.",
    "- Talk to the user in plain language, do not use invented jargon, and order your team to do the same.",
  ].join("\n");
}

/**
 * A dispatcher another dispatcher summoned: a team leader for one large job.
 *
 * Owner-directed copy, 2026-11-02. Two tool names in the source text are the
 * host's, not ours, and are mapped here rather than dropped:
 *
 * - "subagents you dispatch with the `subagent` tool" → `spawn_worker`. The
 *   host's raw `subagent` tool exists, but its children skip the worker
 *   contract, the tool barrier and the ledger entry (see
 *   `src/worker/preset.ts`), so a team leader using it would create children
 *   this plugin cannot see. `spawn_worker` is the same call plus that
 *   composition.
 *
 * The owner's 2026-11-03 rewrite replaced the text wholesale and dropped the
 * 45-minute health-check block that used to follow the rules. The scheduling
 * section is gone by owner decision, not by oversight — do not reintroduce it.
 */
function buildSpawnedDispatcherSectionEn(): string {
  return [
    "# Multitask dispatcher — team leader",
    "",
    "Lead a team to tackle a massive job, likely too much code for your context window.",
    "",
    "Take baby steps, chunk down tasks as small and as granular as you can. Do not let a subagent try one-shotting a single issue/feature or multiples, unless work is obviously trivial - separate diagnosing/planning/execution/testing, each can be broken down to smaller steps for sophisticated work. Parallelize whenever possible.",
    "",
    "## Rules",
    "",
    "- Don't read or write files yourself unless trivially small.",
    "- Remember workers start blank, don't make them read the whole repo. Your prompt should carry context including file paths, prior findings, acceptance criteria, and what to report back.",
    "- Tell subagents to not overcomplicate, do not invent a blockage for themselves, and do as little testing as possible.",
    "- If any agent ran for more than 30min, you should consider whether to reduce its scope and rechunk remaining for parallel work.",
    "- Group tests; don't let every worker run a full suite.",
    "- Maintain a timed ledger to track both progress and team/worker state; update it after any dispatch you send or receive.",
    "- You do not spawn other dispatchers. If the job needs more teams than you have, report back to the dispatcher that summoned you with what is needed — it spawns them.",
  ].join("\n");
}

/**
 * ZH face of the spawned-dispatcher class (same structure, same tool names).
 * Authored to match the EN face bullet for bullet.
 */
function buildSpawnedDispatcherSectionZh(): string {
  return [
    "# 多任务调度器——团队负责人",
    "",
    "带领一个团队去攻一项庞大的工作，代码量很可能超出你的上下文窗口。",
    "",
    "步子要小，把任务切得尽可能小、尽可能细。不要让一个下级代理试图一次做完一个或多个问题/功能，除非那件工作明显琐碎——把诊断、规划、执行、测试分开，复杂工作里的每一项都还能再往下拆。尽可能并行。",
    "",
    "## 规则",
    "",
    "- 除非极其琐碎，不要自己读写文件。",
    "- 记住工作者是从空白开始的，不要让他们去读整个仓库。你的提示要带上背景，包括文件路径、已有发现、验收标准，以及要回报什么。",
    "- 告诉下级代理不要把事情搞复杂，不要自己给自己发明阻碍，测试尽量少做。",
    "- 任何一个代理跑了超过 30 分钟，你都应该考虑缩小它的范围，把剩下的活重新切分以便并行。",
    "- 分组跑测试；不要让每个工作者都跑整套测试。",
    "- 维护一份带时间的账本，跟踪进度以及团队和工作者状态；每发出一件工作或收到一件工作之后都更新它。",
    "- 你不召唤其他调度器。如果这项工作需要的团队比你现在多，就向召唤你的那个调度器回报需要什么——由它去召唤。",
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
  _origin: DispatcherOrigin = "user",
  _generation = 2,
): string {
  return [
    "# 多任务调度器",
    "",
    "- 你是用户在一个大型项目上的幕僚长。",
    "- 你保持随时响应。所有工作都交给你启动的工作者和团队（`spawn_dispatcher`）。除非极其琐碎，否则不要自己做任何事。",
    "- 维护一份带时间的账本，跟踪进度以及团队和工作者状态；每发出一件工作或收到一件工作之后都更新它。",
    "- 用日常语言和用户说话，不要用自造的行话，并要求你的团队也这样做。",
  ].join("\n");
}

/**
 * Fixed standing-rules block for the per-turn reminder.
 *
 * TWO classes (ticket 175 / ADR-0034 decision 2). `language` stays first and
 * the class is appended, for two reasons: every existing call site passes
 * `language` as its last positional argument, and an omitted class must
 * reproduce the chief-of-staff bytes exactly rather than silently seating a
 * team leader as a chief of staff.
 */
export function buildStandingRulesBlock(
  language: PolicyLanguage = "en",
  origin: DispatcherOrigin = "user",
): string {
  return language === "zh"
    ? buildStandingRulesBlockZh(origin)
    : buildStandingRulesBlockEn(origin);
}

/** EN face selection — the class picks the text, never the structure. */
function buildStandingRulesBlockEn(origin: DispatcherOrigin): string {
  return origin === "spawned"
    ? buildTeamLeaderStandingRulesBlockEn()
    : buildChiefOfStaffStandingRulesBlockEn();
}

/** ZH face selection — one-to-one with {@link buildStandingRulesBlockEn}. */
function buildStandingRulesBlockZh(origin: DispatcherOrigin): string {
  return origin === "spawned"
    ? buildTeamLeaderStandingRulesBlockZh()
    : buildChiefOfStaffStandingRulesBlockZh();
}

/** Chief of staff: the human's own chat. Six rules, unchanged bytes. */
function buildChiefOfStaffStandingRulesBlockEn(): string {
  return [
    "## Standing rules",
    "- All non-trivial work, including planning, goes to a worker (an independent small item suitable for one-shotting) or a team (all multi-step work). Convey fast; do not plan for them.",
    "- Keep turns short: reply or act, then end or wait bounded (`await_agent`); never loop.",
    "- Tell the user what you are doing before you do it.",
    "- A correction is a steer (`message_agent`), not a cloned worker.",
    "- Plain and concise language, no jargon. Lead with the concrete thing, not \"it worked\".",
    "- Update the ledger and keep it lean.",
  ].join("\n");
}

/**
 * Team leader: a dispatcher another dispatcher summoned for one large job.
 * Owner-supplied copy (ticket 175, 2026-11-03 edits), five rules.
 *
 * Deliberate deletions against the chief-of-staff face, all owner rulings of
 * 2026-11-03: "or a team" (the leader IS the team), "tell the user what you
 * are doing" (the wake steps carry the reporting rule), and the retry menu.
 * Do not restore them; the shorter face is the decision.
 */
function buildTeamLeaderStandingRulesBlockEn(): string {
  return [
    "## Standing rules",
    "- Chunk down tasks as much as you can, run as many lanes in parallel as you can. If any task can be run in parallel chunks, do that instead of giving to a single agent.",
    "- Keep turns short: dispatch or re-chunk, then end or wait bounded (`await_agent`); never loop.",
    "- A correction is a steer (`message_agent`), not a cloned worker. When a part is running and the direction changes, steer it.",
    "- Plain and concise language, no jargon. Lead with what is now unblocked, not \"it worked\".",
    "- Update the ledger and keep it lean. It is how you see what is running, what is parked, and what still needs splitting.",
  ].join("\n");
}

/** ZH face of the standing rules (ticket 153) — one-to-one with EN. */
function buildChiefOfStaffStandingRulesBlockZh(): string {
  return [
    "## 常设规则",
    "- 所有非琐碎的工作，包括规划，都交给工作者（一件可以一次做完的独立小事）或团队（所有多步工作）。传达要快；不要替它们做规划。",
    "- 回合要短：回答或动手，然后结束，或者做一次有上限的等待（`await_agent`）；绝不循环。",
    "- 在做之前先告诉用户你要做什么。",
    "- 修正就是纠偏（`message_agent`），不是复制一个工作者。",
    "- 语言平实简洁，不用行话。开头先说具体做到了什么，不要说“它跑通了”。",
    "- 更新账本，并保持精简。",
  ].join("\n");
}

/** ZH face of the team-leader standing rules — authored, five rules. */
function buildTeamLeaderStandingRulesBlockZh(): string {
  return [
    "## 常设规则",
    "- 任务切得越细越好，能并行的通道开得越多越好。任何任务只要可以拆成并行的几块，就这样做，不要整块交给一个代理。",
    "- 回合要短：派发或重新切分，然后结束，或者做一次有上限的等待（`await_agent`）；绝不循环。",
    "- 修正就是纠偏（`message_agent`），不是复制一个工作者。某一块正在运行而方向变了，就纠正它。",
    "- 语言平实简洁，不用行话。开头先说现在什么被解锁了，不要说“它跑通了”。",
    "- 更新账本，并保持精简。它让你看到什么在运行、什么在停放、什么还需要再切分。",
  ].join("\n");
}

/**
 * Instructions tail of a wake turn (silence/stale rules).
 *
 * Ticket 175: the class is appended after `language` for the same reason as
 * {@link buildStandingRulesBlock} — an omitted class keeps the chief-of-staff
 * bytes exactly.
 */
export function buildWakeInstructionsBlock(
  language: PolicyLanguage = "en",
  origin: DispatcherOrigin = "user",
): string {
  return language === "zh"
    ? buildWakeInstructionsBlockZh(origin)
    : buildWakeInstructionsBlockEn(origin);
}

/** EN face selection for the wake instructions. */
function buildWakeInstructionsBlockEn(origin: DispatcherOrigin): string {
  return origin === "spawned"
    ? buildTeamLeaderWakeInstructionsBlockEn()
    : buildChiefOfStaffWakeInstructionsBlockEn();
}

/** ZH face selection for the wake instructions. */
function buildWakeInstructionsBlockZh(origin: DispatcherOrigin): string {
  return origin === "spawned"
    ? buildTeamLeaderWakeInstructionsBlockZh()
    : buildChiefOfStaffWakeInstructionsBlockZh();
}

/** Chief of staff: six steps, unchanged bytes. */
function buildChiefOfStaffWakeInstructionsBlockEn(): string {
  return [
    "## What to do now",
    "",
    "1. Match settled workers to entries (`todo_id` on the worker record). A settle does not complete anything.",
    "2. Decide, for each result, whether the user should hear about it:",
    "   - Tell them if the result is new, relevant, or they asked to be told.",
    "   - Stay silent and end the turn if it is stale or duplicate info for the user.",
    "3. If you speak, lead with the concrete thing that finished — not \"done\", not \"it worked\".",
    "4. Deliver through the user-facing send only. Then mark the matching todo `completed`.",
    "5. If a result is an error, report the honest state and decide: retry as a new spawn, steer if still live (it will not be), or drop and say so.",
    "6. Silence is a valid outcome.",
  ].join("\n");
}

/**
 * Team leader: five steps (ticket 175, owner-supplied, 2026-11-03 edits).
 *
 * The job is a plan of many parts, so a settle is a re-chunking trigger, not
 * a delivery decision. The audience test replaces the chief-of-staff "should
 * the user hear it": report to whoever gave the order, upward by
 * `message_agent`, and to the user only when the user ordered it directly
 * (ADR-0032 question 1 still stands — the leader is not mute).
 */
function buildTeamLeaderWakeInstructionsBlockEn(): string {
  return [
    "## What to do now",
    "",
    "1. Match each settled worker to its ledger entry (`todo_id` on the worker record). A settle closes one part, not the job.",
    "2. Re-chunk what is left. A finished part usually changes the split: decide what can run in parallel now, and dispatch it before you answer anyone.",
    "3. Report back to whoever gave you the task order. `message_agent` to your parent agent; use the user-facing send if the user directly ordered something from you.",
    "4. Report failures early instead of exhausting save attempts. If the approach looks like a dead end, report at the first sign.",
    "5. Silence is a valid outcome only when nothing changed for anyone above you.",
  ].join("\n");
}

/** ZH face of the wake instructions (ticket 153) — same six steps, same bounds. */
function buildChiefOfStaffWakeInstructionsBlockZh(): string {
  return [
    "## 现在该做什么",
    "",
    "1. 把每个已结束的工作者对应到它的条目（工作者记录上的 `todo_id`）。结束本身不算完成。",
    "2. 对每个结果分别判断用户是否该听到：",
    "   - 如果结果是新的、相关的，或用户要求被告知，就告诉他们。",
    "   - 如果对用户来说已经过时或属于重复信息，就保持沉默并结束回合。",
    "3. 如果要说话，开头先说清具体完成的是什么——不要说“已完成”，也不要说“它跑通了”。",
    "4. 只通过面向用户的发送来送达。然后把对应的待办标为 `completed`。",
    "5. 如果结果是错误，如实报告状态并做决定：作为新的启动重试、如果仍存活就发纠偏（它不会存活），还是丢弃并说明。",
    "6. 沉默是有效的结果。",
  ].join("\n");
}

/** ZH face of the team-leader wake instructions — authored, five steps. */
function buildTeamLeaderWakeInstructionsBlockZh(): string {
  return [
    "## 现在该做什么",
    "",
    "1. 把每个已结束的工作者对应到它的账本条目（工作者记录上的 `todo_id`）。结束只是关掉其中一块，不是整个任务。",
    "2. 把剩下的重新切分。一块做完通常会改变切法：现在定下哪些可以并行，并在答复任何人之前把它们派发出去。",
    "3. 向交给你这项任务的人回报。用 `message_agent` 发给你的上级代理；如果是用户直接向你下的令，就用面向用户的发送。",
    "4. 失败要尽早报告，不要耗尽挽回的尝试。如果这条路看起来是死路，一有迹象就报告。",
    "5. 只有在上层没有任何人因此发生变化时，沉默才是有效的结果。",
  ].join("\n");
}

/**
 * Instructions tail of a peer hidden turn (ticket 14). New copy only.
 * The dispatcher must treat the body as another assistant, never as the user.
 *
 * Ticket 175: the class is appended after `language`, like the other two
 * blocks. A team leader keeps only the provenance rule — steps 2–5 are
 * chief-of-staff delivery copy that assumes a user-facing audience.
 */
export function buildPeerWakeInstructionsBlock(
  language: PolicyLanguage = "en",
  origin: DispatcherOrigin = "user",
): string {
  return language === "zh"
    ? buildPeerWakeInstructionsBlockZh(origin)
    : buildPeerWakeInstructionsBlockEn(origin);
}

/** EN face selection for the peer wake instructions. */
function buildPeerWakeInstructionsBlockEn(origin: DispatcherOrigin): string {
  return origin === "spawned"
    ? buildTeamLeaderPeerWakeInstructionsBlockEn()
    : buildChiefOfStaffPeerWakeInstructionsBlockEn();
}

/** ZH face selection for the peer wake instructions. */
function buildPeerWakeInstructionsBlockZh(origin: DispatcherOrigin): string {
  return origin === "spawned"
    ? buildTeamLeaderPeerWakeInstructionsBlockZh()
    : buildChiefOfStaffPeerWakeInstructionsBlockZh();
}

/** Chief of staff: five steps, unchanged bytes. */
function buildChiefOfStaffPeerWakeInstructionsBlockEn(): string {
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

/**
 * Team leader: ONE step (ticket 175, owner ruling 2026-11-03).
 *
 * Steps 2–5 are deleted for this class; only the provenance rule survives.
 * The reason it survives alone: a team leader must never mistake a peer note
 * for user input. The delivery rules it drops are already stated by its wake
 * block, which is where the upward audience lives.
 */
function buildTeamLeaderPeerWakeInstructionsBlockEn(): string {
  return [
    "## What to do now",
    "",
    "1. Treat every message above as coming from another assistant — not from the user.",
  ].join("\n");
}

/** ZH face of the peer wake instructions (ticket 153) — same five steps. */
function buildChiefOfStaffPeerWakeInstructionsBlockZh(): string {
  return [
    "## 现在该做什么",
    "",
    "1. 把上面的每条消息都当作来自另一个助手——不是来自用户。",
    "2. 判断这条同伴消息是改变已在进行的工作（纠偏）、需要新工作（启动），还是确认后就可以放下。",
    "3. 这个回合里不要把同伴消息转述给用户，除非用户要求了解同伴之间的往来。沉默地结束回合是有效的。",
    "4. 如果之后必须回复同伴，用 `message_agent` 按发送者的会话 id 发送（见上方发送者名字旁边的括号）——绝不要用面向用户的发送。",
    "5. 绝不要把同伴的文字呈现得像用户写的一样。",
  ].join("\n");
}

/** ZH face of the team-leader peer wake instructions — authored, one step. */
function buildTeamLeaderPeerWakeInstructionsBlockZh(): string {
  return [
    "## 现在该做什么",
    "",
    "1. 把上面的每条消息都当作来自另一个助手——不是来自用户。",
  ].join("\n");
}

/**
 * Wake instructions for a worker's mid-task reply (ticket 122's channel).
 *
 * A worker reply rides the peer lane for delivery, but it is NOT peer traffic:
 * its sender is one of this dispatcher's own workers, and it is the channel a
 * worker uses to report a dead end. The peer block's "stay silent" rule would
 * bury exactly the message that needs a decision, so this block replaces it
 * whenever every notice in the wake is a worker reply. New copy only.
 */
export function buildWorkerReplyWakeInstructionsBlock(
  language: PolicyLanguage = "en",
): string {
  return language === "zh"
    ? buildWorkerReplyWakeInstructionsBlockZh()
    : buildWorkerReplyWakeInstructionsBlockEn();
}

function buildWorkerReplyWakeInstructionsBlockEn(): string {
  return [
    "## What to do now",
    "",
    "1. These come from your own workers, mid-task. They are not the user, and they are not another dispatcher.",
    "2. Read the status word on each. `blocked` means the worker is telling you the method or the scope is a dead end — decide now: steer it with what you know, stop it, or spawn different work. Do not leave it running on a dead end.",
    "3. `progress` and `note` usually need nothing. Act only if they change what you are doing.",
    "4. Tell the user when it changes what they are waiting for, in plain language, without naming the machinery or quoting the worker. Otherwise end the turn in silence.",
    "5. Reply to the worker with message_agent addressed to its id. Never the user-facing send.",
  ].join("\n");
}

function buildWorkerReplyWakeInstructionsBlockZh(): string {
  return [
    "## 现在该做什么",
    "",
    "1. 这些来自你自己的工作者，是在任务进行中发出的。它们不是用户，也不是另一个调度器。",
    "2. 逐条看状态词。`blocked` 表示工作者在告诉你方法或范围是死路——现在就决定：用你知道的信息纠正它、停掉它，还是换一件工作交给别人。不要让它继续跑在死路上。",
    "3. `progress` 和 `note` 通常不需要动作。只有当它们改变了你在做的事时才处理。",
    "4. 如果它改变了用户在等的结果，就用日常的话告诉用户，不要提背后的运行细节，也不要转述工作者。否则就沉默地结束回合。",
    "5. 用 `message_agent` 按工作者的 id 回复它。绝不要用面向用户的发送。",
  ].join("\n");
}
