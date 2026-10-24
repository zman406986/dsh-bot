/**
 * Roster `shell.overlay` entry + locale namespace (ticket 21; scaffold from
 * ticket 20).
 *
 * Pure registration data — no DOM, no React, no Cordis. Tests assert this
 * module directly (offline, S8).
 *
 * Namespacing rules (design-16 §5):
 * - Slot `name`s are ONLY dsh-owned shipped slots; never invented, never
 *   `root`, and never the rejected-for-v1 surfaces `main`,
 *   `sidebar.right.pane.tab`, or `conversation.approval.detail`.
 *   (2026-09-19, ticket 78 / ADR-0020: `main` — and at the cutover `root` —
 *   are now DELIBERATE elections for the wrapper shell's own registrations,
 *   composed in `shell-mount.ts` + `index.ts`. This module's roster entry is
 *   untouched and stays the additive `shell.overlay` entry it always was;
 *   the v1 prohibition barred capsule-era shadowing, not the ADR-0020
 *   vehicle.)
 * - Slot entry `id`s are `multitask-dispatcher-` prefixed and unique;
 *   `shell.overlay` is an additive list slot (order-sorted, click-through
 *   by default — Finding 5, `registry.d.ts:16-38`), so coexistence is by
 *   unique id, not shadowing.
 * - The locale namespace is the plugin id, matching the settings namespace
 *   (`src/adapter/settings-section.ts`).
 *
 * All copy is original clean-room text (design-16 §6 drafts + zh
 * translations written for this repo; no reference material was consulted).
 */

/** dsh's documented home for free-floating plugin surfaces (list slot). */
export const SHELL_OVERLAY_SLOT = "shell.overlay";

/**
 * Overlay entry id for the roster panel (`multitask-dispatcher-` prefix).
 * Replaces ticket 20's retired `multitask-dispatcher-hello` placeholder.
 */
export const ROSTER_ENTRY_ID = "multitask-dispatcher-roster";

/**
 * Sort position within the additive overlay list. Low on purpose (design-16
 * §4.2 "low order"): the roster is a quiet status surface, sorted early in
 * the list ahead of higher-order entries, mirroring the shipped `-10`
 * convention from dsh-client-ui-agent-preset's header action.
 */
export const ROSTER_OVERLAY_ORDER = -10;

/** Locale namespace = plugin id (Finding 6 / design-16 §5). */
export const LOCALE_NAMESPACE = "multitask-dispatcher";

/** One slot entry's registration options (Finding 5 options shape, narrowed). */
export interface SlotRegistrationOptions {
  /** The shipped slot key this entry renders into. */
  readonly name: string;
  /** Unique entry id, `multitask-dispatcher-` prefixed for our entries. */
  readonly id: string;
  /** Additive-list sort key (`order ?? 0` on the dsh side). */
  readonly order: number;
  /** Locale namespace declared on the entry so the kit's `t` seat binds. */
  readonly locale: string;
}

/** Build the roster panel's `shell.overlay` registration options. */
export function rosterOverlayRegistration(): SlotRegistrationOptions {
  return {
    name: SHELL_OVERLAY_SLOT,
    id: ROSTER_ENTRY_ID,
    order: ROSTER_OVERLAY_ORDER,
    locale: LOCALE_NAMESPACE,
  };
}

/** One locale face: dotted copy keys mapped to strings. */
export type LocaleFace = Readonly<Record<string, string>>;

/** Bound translate seat (`ctx.locale.bind(namespace)`). */
export type TranslateFn = (key: string) => string;

/** `{en, zh}` dictionary shape accepted by `ctx.locale.register` (Finding 6). */
export interface LocaleDictionary {
  readonly en: LocaleFace;
  readonly zh: LocaleFace;
}

/**
 * Roster panel copy (clean-room, design-16 §6 + design-17 §7): title, empty
 * state, the loading and honest stale/unavailable states, and the ticket-27
 * presence phrases — blocked-with-reason per access class (the panel
 * composes the localized phrase from the structured wire fields; the target
 * is a name, never a secret value), the landed-undelivered marker, and the
 * derived activity-line tool-call count. Status labels are NOT localized —
 * the core FSM vocabulary (`spawned`/`running`/`steering`/`completed`/
 * `error`/`aborted`) renders verbatim, as-is.
 *
 * Ticket 24 adds the per-tool call view copy: field labels for the compact
 * detail rows and the degraded-row fallback. Outcome values and check-row
 * status labels stay verbatim payload/core vocabulary, never localized.
 *
 * Ticket 40 adds the per-row steer affordance copy: the button, the
 * post-prefill hint (focus is not exposed so the user must review and send),
 * and the copy-only fallback for when the composer draft is unreachable.
 *
 * Ticket 89 (2026-09-19): the capsule-era copy — the ticket-38 chip labels,
 * the ticket-39 activation row, the ticket-40 action/stop phrasing, the
 * ticket-41 deliverables line, and the ticket-42 footer — was DELETED with
 * the capsule (no live renderer consumed it; the live conversation pane has
 * its own `shell.conv.*` copy). Both faces dropped the same keys, so the
 * en/zh key sets stay identical.
 *
 * Ticket 47 adds the `settings.card.*` block: the card's chrome (title,
 * description, the expand/collapse accessible labels, the unsaved marker,
 * the read-only note, save/discard, and the failed-save line) plus one
 * label/hint pair per schema field and the shared overridden / reset /
 * invalid copy. The title is the plugin's display name — the same name the
 * ticket-42 footer hint tells the user to look for.
 */
export const localeDictionary: LocaleDictionary = {
  en: {
    "roster.title": "Workers",
    "roster.empty": "No workers yet. Ask the dispatcher to start some.",
    "roster.unavailable": "Worker status is unavailable right now.",
    "roster.loading": "Loading worker status…",
    "roster.blocked.tool": 'Waiting for your approval: use the tool "{target}"',
    "roster.blocked.credential":
      'Waiting for your approval: use the credential "{target}"',
    "roster.blocked.network":
      'Waiting for your approval: network access to "{target}"',
    "roster.blocked.filesystem":
      'Waiting for your approval: file access to "{target}"',
    "roster.blocked.other": "Waiting for your approval: {target}",
    "roster.landed": "Result ready — not delivered yet",
    "roster.activity.toolcalls": "{count} tool calls",
    "roster.section.active": "Active",
    "roster.section.needs-you": "Needs you",
    "roster.section.finished": "Finished",
    "roster.finished.count": "{count} finished",
    "toolview.degraded": "Tool call details are unavailable.",
    "toolview.field.worker": "Worker",
    "toolview.field.title": "Title",
    "toolview.field.stream": "Stream",
    "toolview.field.todo": "Todo",
    "toolview.field.outcome": "Outcome",
    "toolview.field.steer": "Steer",
    "toolview.field.delivered": "Delivered",
    "toolview.field.attachments": "Attachments",
    // Ticket 70: send_peer row labels (the conversation-visible trace of
    // peer traffic; the message body itself never renders on the row).
    "toolview.field.peer": "To session",
    "toolview.field.priority": "Priority",
    // Ticket 32 (design-17 §7): the activation success presence hint. The
    // host command copy (`src/adapter/activation-command.ts`
    // `ACTIVATION_PRESENCE_HINT`) is the en authority; this face carries the
    // identical en string plus the zh translation so the pair stays a single
    // localized copy unit. The client face does not render it today — the
    // host command result is the surface — but the key set is shared. The
    // panel claim was removed by ticket 134 (ADR-0024: no panel is mounted).
    "activation.presence-hint":
      "The dispatcher reports progress as it works; results arrive in this chat as they finish.",
    // Ticket 40: the per-row steer affordance. The hint renders after a
    // successful prefill (focus is not exposed — review and send); the
    // fallback is the copy-only degrade for when the draft is unreachable.
    "roster.steer.button": "Steer",
    "roster.steer.hint":
      "Placed in the composer for {workerId} — review and send.",
    "roster.steer.copy-fallback":
      "Composer not reachable here — type /dispatcher-steer {workerId} followed by your instruction in this chat.",
    // Ticket 47: the Settings → 插件配置 card. The title is the plugin's
    // display name; the enabled hint states the ADR-0005 rule in the user's
    // words (a saved change lands in NEW chats — the running chat keeps the
    // flag it started with) so the control is never read as a live toggle.
    "settings.card.title": "Multitask Dispatcher",
    "settings.card.description":
      "The dispatcher's feature flag and how long an unanswered permission request waits.",
    "settings.card.expand": "Expand",
    "settings.card.collapse": "Collapse",
    "settings.card.unsaved": "Unsaved",
    "settings.card.readonly":
      "This deployment keeps settings in this browser only, so nothing here can be saved.",
    "settings.card.save": "Save",
    "settings.card.discard": "Discard",
    "settings.card.failed":
      "Not saved — the change did not land as written. Your edits are still here.",
    "settings.card.overridden": "Set here",
    "settings.card.reset": "Use default",
    "settings.card.invalid":
      "Enter a whole number of milliseconds, or leave it empty to use the default.",
    "settings.card.field.enabled.label": "Enable the dispatcher",
    "settings.card.field.enabled.hint":
      "Saved as the dispatcher's setting: it applies to new chats. The chat you are in keeps the flag it started with.",
    "settings.card.field.accessRequestTimeoutMs.label":
      "Access-request timeout (ms)",
    "settings.card.field.accessRequestTimeoutMs.hint":
      "How long an unanswered permission request waits before it is denied. Leave empty to use the default.",
    "settings.card.field.wakeCoalesceWindowMs.label":
      "Wake coalescing window (ms)",
    "settings.card.field.wakeCoalesceWindowMs.hint":
      "Batches rapid background completions into one dispatcher turn per window while the dispatcher is idle; a message from you always goes first. 0 wakes immediately (default).",
    // Ticket 113: the opt-in file inbox. The hint states the same
    // new-chats rule as `enabled` and points at the queue file the external
    // system writes.
    "settings.card.field.inboxEnabled.label": "Enable the file inbox",
    "settings.card.field.inboxEnabled.hint":
      "Saved as the dispatcher's setting: it applies to new chats. When on, the dispatcher also picks up jobs from the inbox directory below.",
    "settings.card.field.inboxDir.label": "Inbox directory",
    "settings.card.field.inboxDir.hint":
      "The folder the external system writes queue jobs into. Leave empty to keep the inbox off.",
    "settings.card.field.inboxRescanIntervalMs.label":
      "Inbox rescan interval (ms)",
    "settings.card.field.inboxRescanIntervalMs.hint":
      "How often the inbox directory is re-scanned as a safety net. Minimum 1000; leave empty to use the default.",
    "settings.card.field.microcompactEnabled.label":
      "Microcompact old tool results",
    "settings.card.field.microcompactEnabled.hint":
      "When on, older tool output is emptied once a chat fills past a fixed share of the model window, keeping the newest few. This rewrites history, so the provider's prompt cache restarts from the oldest cleared entry.",
    // Ticket 145: racoons is always on while the multitask plugin is
    // enabled, so the card only tunes it — record-only, storage root and the
    // half-window prune denominator.
    "settings.card.field.racoonsRecordOnly.label":
      "Racoons record-only mode (no context edits)",
    "settings.card.field.racoonsRecordOnly.hint":
      "Off = racoons applies context cleanup to every chat in this process; removed content stays restorable by recall id, originals stored per session on disk.",
    "settings.card.field.racoonsStorageRoot.label":
      "Racoons storage root (empty = default <DSH_HOME>/storages/racoons)",
    "settings.card.field.racoonsStorageRoot.hint":
      "Folder that holds one ledger per chat. Leave empty to use the default location.",
    "settings.card.field.racoonsContextWindowTokens.label":
      "Racoons context window tokens (0 = auto half-window prune off)",
    "settings.card.field.racoonsContextWindowTokens.hint":
      "When set, a chat that reaches half this many tokens runs a prune pass. 0 leaves the automatic pass off.",
    // Ticket 77 (ADR-0020 slice 1): the wrapper shell's chrome copy. The
    // main-surface line survives as the no-seat fallback: since ticket 80
    // the pane is a host seat, and this copy shows only when a composition
    // mounts the shell without it (never a fake composer or a fake
    // transcript). All names and phrasing are ours (exception B9: no
    // verbatim reference text).
    "shell.title": "Dispatchers",
    "shell.sidebar.label": "Dispatcher sessions",
    "shell.empty": "No dispatcher sessions yet.",
    "shell.noselection": "Select a dispatcher to see its work.",
    "shell.conversation.pending":
      "The conversation surface is not wired into this shell yet.",
    "shell.row.working": "{count} working",
    "shell.row.needs-you": "{count} need you",
    "shell.row.finished": "{count} finished",
    "shell.row.presence-unavailable": "presence unavailable",
    // Ticket 70: the copy-session-id affordance on dispatcher rows — the
    // session id is what a peer addresses send_peer with (no directory; C13).
    "shell.row.copy-id": "Copy session id",
    // Ticket 80 (ADR-0020 slice 4): the conversation pane's copy. Text-only
    // surface, honest states (waiting / unavailable / empty are different
    // facts), send-only composer (area 7: no stop affordance anywhere).
    // All names and phrasing are ours (exception B9).
    "shell.conv.waiting": "History has not arrived for this session yet.",
    "shell.conv.unavailable":
      "Conversation history is unavailable for this session.",
    "shell.conv.empty": "No messages yet.",
    "shell.conv.more": "Load older messages",
    "shell.conv.role-user": "You",
    "shell.conv.role-assistant": "Dispatcher",
    "shell.conv.working": "working…",
    "shell.conv.interrupted": "(interrupted)",
    "shell.conv.attachment-only": "(no text content)",
    "shell.conv.tool-running": "running",
    "shell.conv.tool-failed": "failed",
    "shell.conv.send": "Send",
    "shell.conv.sending": "Sending…",
    "shell.conv.no-channel": "No send channel is reachable in this runtime.",
    "shell.conv.send-failed": "The send failed — the message was not delivered.",
    // Ticket 68 (ADR-0018 in-scope area): the first-run onboarding beats.
    // Five beats, all new/adapted copy (exception B9) mapping the reference's
    // sequence onto dsh honestly: no sign-in or account beat (U-A gap), no
    // computer-readiness beat (ticket 71's capability gate), the
    // background-jobs beat narrowed to our single worker kind (C15), and the
    // first-agent beat kept user-driven (U-G). Failure copy is the one honest
    // save-failed line — retry-less (U-A); the suppression read itself fails
    // open, so unreadable never hides this flow.
    "shell.onboard.intro.title": "Your dispatchers live here",
    "shell.onboard.intro.body":
      "This window is the dispatch shell. Each sidebar entry is a dispatcher session — a chat that can plan work and run background workers for you.",
    "shell.onboard.background.title": "Work continues without you",
    "shell.onboard.background.body":
      "When a dispatcher starts a worker, the worker runs on its own. You can keep using the window; results arrive in the conversation as ordinary replies, and the sidebar shows what is still in flight.",
    "shell.onboard.tools.title": "You approve what workers may do",
    "shell.onboard.tools.body":
      "Workers act through tools under your control. When something sensitive comes up — a command, a file, network access — the dispatcher asks you first and waits for your answer.",
    "shell.onboard.first.title": "Create your first dispatcher",
    "shell.onboard.first.body":
      "A dispatcher starts as an ordinary chat. Create a new chat and ask it to start dispatching — once it activates, it appears in the sidebar with its own worker status.",
    "shell.onboard.handoff.title": "You are set",
    "shell.onboard.handoff.body":
      "Select a dispatcher in the sidebar to open its conversation; its workers' progress shows in the panel beside it. This introduction does not repeat.",
    "shell.onboard.next": "Next",
    "shell.onboard.done": "Get started",
    "shell.onboard.skip": "Skip",
    "shell.onboard.step": "Step {current} of {total}",
    "shell.onboard.save-failed":
      "Couldn't save that you have seen this introduction — it may appear again next time.",
    // Ticket 81 (ADR-0020 slice 5): approval cards in the conversation
    // surface, re-hosting ticket 30's anatomy. The option labels, the
    // location line, the expired copy, and the secret-stored reassurance are
    // ticket 30's shipped copy riding the projections verbatim (its
    // supersession record) — not re-keyed here. These keys are the card's
    // own chrome: field label, the pending secret's never-shown promise,
    // the submit outcome lines (honest, retry-less — U-A), and the
    // dispatch card's gate label. The section heading reuses the roster's
    // "Needs you" key; decision reasons render as core vocabulary verbatim.
    "shell.approval.target": "Target",
    "shell.approval.secret-promise":
      "The value stays stored securely — it is never shown to workers or in this chat.",
    "shell.approval.unavailable":
      "Answering is not available in this surface yet.",
    "shell.approval.no-channel":
      "No approval channel is reachable here — nothing was changed.",
    "shell.approval.failed":
      "The answer could not be delivered — nothing was changed.",
    "shell.approval.submitted":
      "Answer sent — this card updates when the dispatcher confirms.",
    "shell.dispatch.gating": "Gate",
    // Ticket 123: the session-kind glyph labels. They are accessible names /
    // tooltips on a small mark, never visible paragraph copy. Only the
    // dispatcher mark is composed (the sidebar cell ADR-0024's rider licenses;
    // see src/client/session-kind.tsx); the worker label stays with it as
    // retained machinery for the declined header seat.
    "indicator.dispatcher": "Dispatcher session",
    "indicator.worker": "Worker session",
  },
  zh: {
    "roster.title": "工作者",
    "roster.empty": "还没有工作者。让调度器启动一些吧。",
    "roster.unavailable": "工作者状态暂时不可用。",
    "roster.loading": "正在加载工作者状态…",
    "roster.blocked.tool": "等待你的批准：使用工具“{target}”",
    "roster.blocked.credential": "等待你的批准：使用凭据“{target}”",
    "roster.blocked.network": "等待你的批准：访问网络“{target}”",
    "roster.blocked.filesystem": "等待你的批准：访问文件“{target}”",
    "roster.blocked.other": "等待你的批准：{target}",
    "roster.landed": "结果已就绪，尚未送达",
    "roster.activity.toolcalls": "{count} 次工具调用",
    "roster.section.active": "进行中",
    "roster.section.needs-you": "需要你处理",
    "roster.section.finished": "已完成",
    "roster.finished.count": "{count} 个已完成",
    "toolview.degraded": "工具调用详情不可用。",
    "toolview.field.worker": "工作者",
    "toolview.field.title": "标题",
    "toolview.field.stream": "流",
    "toolview.field.todo": "待办",
    "toolview.field.outcome": "结果",
    "toolview.field.steer": "纠偏",
    "toolview.field.delivered": "已送达",
    "toolview.field.attachments": "附件",
    // Ticket 70：send_peer 行标签（同伴流量的对话可见痕迹；消息正文不出现在行上）。
    "toolview.field.peer": "目标会话",
    "toolview.field.priority": "优先",
    "activation.presence-hint":
      "调度器会在工作中随时汇报进度；结果完成后会直接送达本聊天。",
    "roster.steer.button": "纠偏",
    "roster.steer.hint": "已为 {workerId} 填入输入框——请检查后发送。",
    "roster.steer.copy-fallback":
      "此处无法访问输入框——请在本聊天中输入 /dispatcher-steer {workerId} 加上你的指示。",
    // Ticket 47：设置 → 插件配置 卡片。标题即插件显示名；启用项的说明用用户的话
    // 说清 ADR-0005 规则（保存的更改对新会话生效——当前会话沿用启动时的开关值），
    // 以免这个控件被读成实时开关。
    "settings.card.title": "Multitask Dispatcher",
    "settings.card.description":
      "调度器的功能开关，以及未获答复的权限请求可等待的时长。",
    "settings.card.expand": "展开",
    "settings.card.collapse": "收起",
    "settings.card.unsaved": "未保存",
    "settings.card.readonly":
      "此部署仅把设置保存在本浏览器中，因此此处无法保存。",
    "settings.card.save": "保存",
    "settings.card.discard": "放弃",
    "settings.card.failed":
      "未保存——更改没有按填写的内容生效。你的编辑仍在这里。",
    "settings.card.overridden": "已在此设置",
    "settings.card.reset": "使用默认值",
    "settings.card.invalid": "请输入整数毫秒，或留空以使用默认值。",
    "settings.card.field.enabled.label": "启用调度器",
    "settings.card.field.enabled.hint":
      "保存为调度器的设置：对新会话生效。当前所在会话仍沿用启动时的开关值。",
    "settings.card.field.accessRequestTimeoutMs.label": "访问请求超时（毫秒）",
    "settings.card.field.accessRequestTimeoutMs.hint":
      "权限请求未获答复时可等待的时长，超时后按拒绝处理。留空以使用默认值。",
    "settings.card.field.wakeCoalesceWindowMs.label": "唤醒合并窗口（毫秒）",
    "settings.card.field.wakeCoalesceWindowMs.hint":
      "调度器空闲时，把窗口内先后到达的多个后台完成合并为一次唤醒；你的消息始终优先。0 表示立即唤醒（默认）。",
    // Ticket 113：可选的文件收件箱。提示同样说明“新会话生效”规则，
    // 并指出外部系统写入队列任务的目录。
    "settings.card.field.inboxEnabled.label": "启用文件收件箱",
    "settings.card.field.inboxEnabled.hint":
      "保存为调度器的设置：对新会话生效。开启后，调度器还会从下方目录接收任务。",
    // Ticket 145：只要调度器插件启用，RACOONS 就一直运行；此处只调节它——
    // 仅记录模式、存储根目录、半窗口清理的窗口大小。
    "settings.card.field.racoonsRecordOnly.label":
      "RACOONS 仅记录模式（不改动上下文）",
    "settings.card.field.racoonsRecordOnly.hint":
      "关闭时，RACOONS 会对本进程内的所有会话执行上下文清理；被移除的内容仍可通过 recall id 按原样取回，原始内容按会话保存在磁盘上。",
    "settings.card.field.racoonsStorageRoot.label":
      "RACOONS 存储根目录（留空使用默认 <DSH_HOME>/storages/racoons）",
    "settings.card.field.racoonsStorageRoot.hint":
      "每个会话一份账本，都放在这个目录下。留空则使用默认位置。",
    "settings.card.field.racoonsContextWindowTokens.label":
      "RACOONS 上下文窗口 token 数（0 表示关闭半窗口自动清理）",
    "settings.card.field.racoonsContextWindowTokens.hint":
      "设置后，会话占用达到该数值的一半时会执行一次清理。0 表示不自动执行。",
    "settings.card.field.inboxDir.label": "收件箱目录",
    "settings.card.field.inboxDir.hint":
      "外部系统写入队列任务的文件夹。留空则保持收件箱关闭。",
    "settings.card.field.inboxRescanIntervalMs.label": "收件箱重扫间隔（毫秒）",
    "settings.card.field.inboxRescanIntervalMs.hint":
      "作为兜底，重新扫描收件箱目录的间隔。最小 1000；留空以使用默认值。",
    "settings.card.field.microcompactEnabled.label": "微压缩旧工具结果",
    "settings.card.field.microcompactEnabled.hint":
      "开启后，当会话占用超过模型窗口的固定比例时，清空较早的工具输出，只保留最新的若干条。这会改写历史，因此从最早被清空的位置起，提供方的提示缓存会重新开始。",
    // Ticket 77（ADR-0020 切片 1）：外壳的界面文案。主 surface 的一行是
    // 诚实的骨架状态——会话表面随 ticket 80 接入，文案如实说明。命名与措辞
    // 均为自创（例外 B9：不逐字复制参考文本）。
    "shell.title": "调度台",
    "shell.sidebar.label": "调度会话",
    "shell.empty": "暂无调度会话。",
    "shell.noselection": "选择一个调度会话以查看其工作。",
    "shell.conversation.pending": "会话表面尚未接入此外壳。",
    "shell.row.working": "{count} 个进行中",
    "shell.row.needs-you": "{count} 个需要你",
    "shell.row.finished": "{count} 个已完成",
    "shell.row.presence-unavailable": "状态不可用",
    // Ticket 70：调度会话行上的“复制会话 ID”入口——同伴互发消息以会话 ID 寻址
    // （不设目录；C13 维持）。
    "shell.row.copy-id": "复制会话 ID",
    // Ticket 80（ADR-0020 切片 4）：对话面板文案。纯文本表面，状态如实区分
    // （等待 / 不可用 / 空是三种不同的事实）；输入框只发不停（领域 7：任何
    // 位置都不设停止控件）。命名与措辞均为自创（例外 B9）。
    "shell.conv.waiting": "此会话的历史尚未到达。",
    "shell.conv.unavailable": "此会话的对话历史不可用。",
    "shell.conv.empty": "暂无消息。",
    "shell.conv.more": "载入更早的消息",
    "shell.conv.role-user": "你",
    "shell.conv.role-assistant": "调度",
    "shell.conv.working": "输出中…",
    "shell.conv.interrupted": "（已中断）",
    "shell.conv.attachment-only": "（无文本内容）",
    "shell.conv.tool-running": "进行中",
    "shell.conv.tool-failed": "失败",
    "shell.conv.send": "发送",
    "shell.conv.sending": "发送中…",
    "shell.conv.no-channel": "当前运行时没有可用的发送通道。",
    "shell.conv.send-failed": "发送失败——消息未送达。",
    // Ticket 68（ADR-0018 纳管范围）：首次运行引导。五拍均为自创/改写文案
    // （例外 B9），把参考的顺序诚实地映射到 dsh：没有登录或账户节拍
    // （U-A 缺口），没有电脑就绪演示（ticket 71 的能力门），后台任务节拍
    // 收窄到我们的单一工作者类别（C15），首个代理节拍保持用户主动（U-G）。
    // 失败文案只有一句诚实的保存失败——不设重试（U-A）；抑制读取本身
    // 失败开放，读不到时绝不会隐藏此流程。
    "shell.onboard.intro.title": "调度会话都在这里",
    "shell.onboard.intro.body":
      "这个窗口就是调度外壳。侧栏中的每一项都是一个调度会话——可以规划工作并为你运行后台工作者的聊天。",
    "shell.onboard.background.title": "工作在后台继续",
    "shell.onboard.background.body":
      "调度器启动工作者后，工作者会独立运行。你可以继续使用窗口；结果会以普通回复的形式送达对话，侧栏会显示仍在进行的工作。",
    "shell.onboard.tools.title": "工作者能做什么由你批准",
    "shell.onboard.tools.body":
      "工作者通过工具行事，并受你的控制。当涉及敏感操作——命令、文件、网络访问——调度器会先征求你的同意并等待答复。",
    "shell.onboard.first.title": "创建你的第一个调度器",
    "shell.onboard.first.body":
      "调度器从普通聊天开始。新建一个聊天并让它开始调度——激活后，它会出现在侧栏，并带有自己的工作者状态。",
    "shell.onboard.handoff.title": "一切就绪",
    "shell.onboard.handoff.body":
      "在侧栏选择一个调度器即可打开其对话；其工作者的进度会显示在旁边的面板中。本引导不会再次出现。",
    "shell.onboard.next": "下一步",
    "shell.onboard.done": "开始使用",
    "shell.onboard.skip": "跳过",
    "shell.onboard.step": "第 {current} 步，共 {total} 步",
    "shell.onboard.save-failed":
      "未能保存“已完成引导”的记录——下次可能会再次显示。",
    // Ticket 81（ADR-0020 切片 5）：会话表面中的审批卡片，承接 ticket 30 的结构。
    // 选项标签、位置行、过期文案、密钥“已安全存储”的安抚文案随投影原样复用
    // （其被取代记录）——不在此处重新建立键。这些键是卡片自身的镶边：字段标签、
    // 待决密钥的“永不显示”承诺、提交结果行（如实、不设重试——U-A），以及
    // 派发卡片的审批门标签。区块标题复用 roster 的“需要你处理”键；决定原因
    // 以核心词汇原样呈现。
    "shell.approval.target": "目标",
    "shell.approval.secret-promise":
      "数值始终安全存储——不会显示给工作者，也不会出现在此聊天中。",
    "shell.approval.unavailable": "此表面暂不支持审批答复。",
    "shell.approval.no-channel": "此处没有可用的审批通道——没有任何更改。",
    "shell.approval.failed": "答复未能送达——没有任何更改。",
    "shell.approval.submitted": "答复已提交——待调度器确认后此卡片会更新。",
    "shell.dispatch.gating": "审批门",
    // Ticket 123：会话类别图标文案（仅作无障碍名称/悬停提示，不是可见段落）。
    "indicator.dispatcher": "调度会话",
    "indicator.worker": "工作者会话",
  },
};

/**
 * Validate a locale dictionary shape: both faces present, every value a
 * string, and identical key sets across faces. Returns the list of problems
 * (empty means valid) so tests can assert on exact failures.
 */
export function validateLocaleDictionary(dict: unknown): string[] {
  const problems: string[] = [];
  if (typeof dict !== "object" || dict === null) {
    return ["dictionary is not an object"];
  }
  const record = dict as Record<string, unknown>;
  for (const face of ["en", "zh"] as const) {
    const value = record[face];
    if (typeof value !== "object" || value === null) {
      problems.push(`face "${face}" is missing or not an object`);
    }
  }
  if (problems.length > 0) return problems;

  const en = record.en as Record<string, unknown>;
  const zh = record.zh as Record<string, unknown>;
  for (const [face, values] of [
    ["en", en],
    ["zh", zh],
  ] as const) {
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== "string") {
        problems.push(`face "${face}" key "${key}" is not a string`);
      }
    }
  }
  for (const key of Object.keys(en)) {
    if (!(key in zh)) problems.push(`key "${key}" is missing from the zh face`);
  }
  for (const key of Object.keys(zh)) {
    if (!(key in en)) problems.push(`key "${key}" is missing from the en face`);
  }
  return problems;
}
