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
    "roster.landed": "Result ready — not delivered yet",
    "roster.activity.toolcalls.one": "{count} tool call",
    "roster.activity.toolcalls.other": "{count} tool calls",
    "roster.fact.started": "started {time}",
    "roster.section.active": "Active",
    "roster.section.needs-you": "Needs you",
    "roster.section.finished": "Finished",
    "roster.finished.count.one": "{count} finished",
    "roster.finished.count.other": "{count} finished",
    "status.starting": "Starting",
    "status.working": "Working",
    "status.adjusting": "Adjusting",
    "status.done": "Done",
    "status.failed": "Failed",
    "status.stopped": "Stopped",
    "toolview.degraded": "Tool call details are unavailable.",
    "toolview.details": "Details",
    "toolview.detail.worker": "Worker",
    "toolview.detail.dispatcher": "Dispatcher",
    "toolview.detail.target": "Target",
    "toolview.detail.todo": "Todo",
    "toolview.detail.stream": "Stream",
    "toolview.detail.transcript": "Transcript",
    "toolview.detail.message": "Message",
    "toolview.detail.status": "Status",
    "toolview.detail.reason": "Reason",
    "toolview.detail.elapsed": "Elapsed",
    "toolview.detail.settled": "Settled",
    "toolview.detail.waited": "Waited",
    "toolview.detail.mode": "Mode",
    "toolview.detail.call": "Call",
    "toolview.subject.worker": "the worker",
    "toolview.subject.agent": "the agent",
    "toolview.subject.dispatcher": "the dispatcher",
    "toolview.subject.todo": "the todo",
    // Ticket 180: human facts. Booleans are never rendered as true/false —
    // `priority` exists only when it is true, `delivered` selects a sentence,
    // and zero/false/null facts are omitted before they reach the row.
    "toolview.fact.attachments.one": "{count} attachment",
    "toolview.fact.attachments.other": "{count} attachments",
    "toolview.fact.priority": "priority",
    "toolview.fact.via-steer": "in the worker lane",
    "toolview.fact.via-peer": "in the peer lane",
    "toolview.fact.dormant": "its session is resuming",
    "toolview.fact.keeps-running": "the worker keeps running",
    "toolview.fact.waited": "waited {duration}",
    "toolview.fact.user-spoke": "you said something",
    "toolview.fact.turn-stopped": "the turn stopped",
    "toolview.fact.todo-completed": "{ref} completed",
    // ADR-0009 reply channel: the obligation is recorded, not yet delivered.
    "toolview.fact.todo-marked-done": "todo \"{title}\" marked done",
    "toolview.fact.todo-marked-done-ref": "{ref} marked done",
    "toolview.fact.released-stream": "the stream was released",
    "toolview.spawn.started": "Started \"{title}\"",
    "toolview.spawn.started-generic": "Started {subject}",
    "toolview.spawn.pending": "Starting \"{title}\"",
    "toolview.spawn.pending-generic": "Starting {subject}",
    "toolview.spawn.refused":
      "Couldn't start \"{title}\" — {cause}. Nothing was started.",
    "toolview.spawn.refused-generic":
      "Couldn't start the worker — {cause}. Nothing was started.",
    "toolview.check.pending": "Checking the roster",
    "toolview.check.summary.none": "No workers on the roster.",
    "toolview.check.summary.one": "Checked {count} worker",
    "toolview.check.summary.other": "Checked {count} workers",
    "toolview.check.refused": "Couldn't check the roster — {cause}.",
    "toolview.steer.pending": "Steering {subject}",
    "toolview.steer.sent": "Steering {subject}",
    "toolview.steer.refused":
      "Couldn't steer {subject} — {cause}. Nothing was queued.",
    "toolview.stop.pending": "Stopping {subject}",
    "toolview.stop.stopped": "Stopped {subject}",
    "toolview.stop.released": "Released the stream held by {subject}",
    "toolview.stop.refused":
      "Couldn't stop {subject} — {cause}. Nothing changed.",
    "toolview.deliver.pending": "Delivering",
    "toolview.deliver.done": "Delivered to you",
    "toolview.deliver.recorded": "Result recorded — say it in your reply",
    "toolview.deliver.refused":
      "Couldn't deliver — {cause}. Nothing reached the user.",
    "toolview.message.pending": "Messaging {subject}",
    "toolview.message.sent": "Message sent to {subject}",
    "toolview.message.refused":
      "Couldn't message {subject} — {cause}. Nothing was sent.",
    "toolview.await.pending": "Waiting for {subject}",
    "toolview.await.done": "{subject} finished",
    "toolview.await.failed": "{subject} failed",
    "toolview.await.stopped": "{subject} was stopped",
    "toolview.await.working": "{subject} is still running",
    "toolview.await.gone": "No result for {subject} — it is gone",
    "toolview.await.released": "Stopped waiting for {subject}",
    "toolview.await.refused": "Couldn't wait for {subject} — {cause}.",
    "toolview.dispatcher.summoned": "Summoned \"{title}\"",
    "toolview.dispatcher.summoned-generic": "Summoned {subject}",
    "toolview.dispatcher.pending": "Summoning \"{title}\"",
    "toolview.dispatcher.pending-generic": "Summoning {subject}",
    "toolview.dispatcher.refused":
      "Couldn't summon \"{title}\" — {cause}. Nothing was started.",
    "toolview.dispatcher.refused-generic":
      "Couldn't summon the dispatcher — {cause}. Nothing was started.",
    "toolview.peer.pending": "Sending to {subject}",
    "toolview.peer.sent": "Sent to {subject}",
    "toolview.peer.refused":
      "Couldn't send to {subject} — {cause}. Nothing was sent.",
    // Every refusal enum maps to a human cause. The raw enum stays in the
    // row's details area; the silent fence keeps its ambiguous wording ("no
    // worker with that id in this chat"), never "belongs to another
    // dispatcher".
    "toolview.cause.duplicate-stream-key": "that stream key is already in use",
    "toolview.cause.unknown-todo-id": "no todo with that id in this chat",
    "toolview.cause.todo-already-linked":
      "that todo is already linked to a worker",
    "toolview.cause.unknown-worker": "no worker with that id in this chat",
    "toolview.cause.not-running": "that worker has already finished",
    "toolview.cause.already-settled": "that worker has already finished",
    "toolview.cause.unknown-todo": "no todo with that id in this chat",
    "toolview.cause.no-delivery-channel": "this build has no way to send to you",
    "toolview.cause.send-failed": "the send failed",
    "toolview.cause.unknown-agent": "no agent with that id in this chat",
    "toolview.cause.unknown-dispatcher":
      "no dispatcher with that id in this chat",
    "toolview.cause.self-target": "that is your own session",
    "toolview.cause.inbox-full": "that inbox is full",
    "toolview.cause.rate-limited": "too many messages were sent just now",
    "toolview.cause.invalid-envelope":
      "the message could not be sent as written",
    "toolview.cause.message-id-reuse": "that message id was already used",
    "toolview.cause.not-awaitable": "a dispatcher is a peer, not a worker",
    "toolview.cause.too-many-waits": "too many waits are already open",
    "toolview.cause.invalid-timeout": "the timeout was not a valid number",
    "toolview.cause.invalid-args": "the title or prompt was empty",
    "toolview.cause.host-refused": "the host refused to start it",
    "toolview.cause.failed": "something went wrong",
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
      "Placed in the composer for {worker} — review and send.",
    "roster.steer.copy-fallback":
      "Composer not reachable here — type /dispatcher-steer {worker} followed by your instruction in this chat.",
    // Ticket 47: the Settings → 插件配置 card. The title is the plugin's
    // display name; the enabled hint states the ADR-0005 rule in the user's
    // words (a saved change lands in NEW chats — the running chat keeps the
    // flag it started with) so the control is never read as a live toggle.
    "settings.card.title": "Multitask Dispatcher",
    "settings.card.description":
      "The dispatcher's feature flag and its wake coalescing, inbox, RACOONS, and microcompaction settings.",
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
    // Owner ruling 2026-11-05: racoons is an optional test feature, off by
    // default. The card's first racoons control is the switch; the three
    // tuning fields below only matter while it is on.
    "settings.card.field.racoonsEnabled.label": "Enable Racoons",
    "settings.card.field.racoonsEnabled.hint":
      "Off by default. When on, racoons records every chat in this process to a per-chat ledger on disk and may prune old context; removed content stays restorable by recall id. Meant for manual test launches only.",
    "settings.card.field.racoonsRecordOnly.label":
      "Racoons record-only mode (entry checkpoint can still apply)",
    "settings.card.field.racoonsRecordOnly.hint":
      "Only used while Racoons is enabled. Off = racoons applies context cleanup to every chat in this process; on = everything is still recorded, the automatic prune and manual forget are held back, but a result's entry checkpoint answer can still rewrite that result turn. Removed content stays restorable by recall id, originals stored per session on disk.",
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
    // One shell seat failed to render; the rest of the shell stays usable.
    "shell.seat.failed": "This panel failed to render.",
    "shell.row.working.one": "{count} working",
    "shell.row.working.other": "{count} working",
    "shell.row.needs-you.one": "{count} needs you",
    "shell.row.needs-you.other": "{count} need you",
    "shell.row.finished.one": "{count} finished",
    "shell.row.finished.other": "{count} finished",
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
    // A peer dispatcher's relayed message is user-role on the wire but never
    // the user's speech: it keeps its own role. The full sender id lives in
    // the item's title attribute, never in the visible line.
    "shell.conv.role-peer": "From another dispatcher",
    "shell.conv.working": "working…",
    "shell.conv.interrupted": "(interrupted)",
    "shell.conv.attachment-only": "(no text content)",
    "shell.conv.tool-running": "running",
    "shell.conv.tool-failed": "failed",
    // The composer textarea's own accessible name. It must name the field
    // ("Message"), not the send affordance — the old key was the button's.
    "shell.conv.message": "Message",
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
    // The worker-dispatch card leads with one readable sentence. The
    // `ungated` gate value is never shown (there is no gate any more); ids
    // and the stream key live behind Details.
    "shell.dispatch.started": "Started \"{title}\"",
    "shell.dispatch.started-generic": "Started {subject}",
    "shell.dispatch.refused": "Couldn't start \"{title}\" — {cause}",
    "shell.dispatch.refused-generic": "Couldn't start the worker — {cause}",
    // Ticket 123: the session-kind glyph labels. They are accessible names /
    // tooltips on a small mark, never visible paragraph copy. Only the
    // dispatcher mark is composed (the sidebar cell ADR-0024's rider licenses;
    // see src/client/session-kind.tsx); the worker label stays with it as
    // retained machinery for the declined header seat.
    // Ticket 177: the owner split the dispatcher kind in two, so each class
    // gets its own accessible name.
    "indicator.dispatcher": "Dispatcher",
    "indicator.team-leader": "Summoned dispatcher",
    "indicator.worker": "Worker",
  },
  zh: {
    "roster.title": "工作者",
    "roster.empty": "还没有工作者。让调度器启动一些吧。",
    "roster.unavailable": "工作者状态暂时不可用。",
    "roster.loading": "正在加载工作者状态…",
    "roster.landed": "结果已就绪，尚未送达",
    "roster.activity.toolcalls.one": "{count} 次工具调用",
    "roster.activity.toolcalls.other": "{count} 次工具调用",
    "roster.fact.started": "开始于 {time}",
    "roster.section.active": "进行中",
    "roster.section.needs-you": "需要你处理",
    "roster.section.finished": "已完成",
    "roster.finished.count.one": "{count} 个已完成",
    "roster.finished.count.other": "{count} 个已完成",
    "status.starting": "启动中",
    "status.working": "工作中",
    "status.adjusting": "调整中",
    "status.done": "完成",
    "status.failed": "失败",
    "status.stopped": "已停止",
    "toolview.degraded": "工具调用详情不可用。",
    "toolview.details": "详情",
    "toolview.detail.worker": "工作者",
    "toolview.detail.dispatcher": "调度器",
    "toolview.detail.target": "目标",
    "toolview.detail.todo": "待办",
    "toolview.detail.stream": "流",
    "toolview.detail.transcript": "记录",
    "toolview.detail.message": "消息",
    "toolview.detail.status": "状态",
    "toolview.detail.reason": "原因",
    "toolview.detail.elapsed": "耗时",
    "toolview.detail.settled": "完成于",
    "toolview.detail.waited": "等待",
    "toolview.detail.mode": "模式",
    "toolview.detail.call": "调用",
    "toolview.subject.worker": "该工作者",
    "toolview.subject.agent": "该代理",
    "toolview.subject.dispatcher": "该调度器",
    "toolview.subject.todo": "该待办",
    // Ticket 180：人类可读的事实。布尔值不会显示成 true/false——只有为真时
    // 才出现“优先”，送达由整句表达，零值/假值/空值在进入行之前就被省略。
    "toolview.fact.attachments.one": "{count} 个附件",
    "toolview.fact.attachments.other": "{count} 个附件",
    "toolview.fact.priority": "优先",
    "toolview.fact.via-steer": "走工作者通道",
    "toolview.fact.via-peer": "走同伴通道",
    "toolview.fact.dormant": "其会话正在恢复",
    "toolview.fact.keeps-running": "工作者仍在运行",
    "toolview.fact.waited": "已等待 {duration}",
    "toolview.fact.user-spoke": "你说了话",
    "toolview.fact.turn-stopped": "回合已停止",
    "toolview.fact.todo-completed": "{ref} 已完成",
    "toolview.fact.todo-marked-done": "待办“{title}”已标记完成",
    "toolview.fact.todo-marked-done-ref": "{ref} 已标记完成",
    "toolview.fact.released-stream": "流已释放",
    "toolview.spawn.started": "已启动“{title}”",
    "toolview.spawn.started-generic": "已启动 {subject}",
    "toolview.spawn.pending": "正在启动“{title}”",
    "toolview.spawn.pending-generic": "正在启动 {subject}",
    "toolview.spawn.refused": "无法启动“{title}”——{cause}。没有启动任何东西。",
    "toolview.spawn.refused-generic":
      "无法启动工作者——{cause}。没有启动任何东西。",
    "toolview.check.pending": "正在查看名单",
    "toolview.check.summary.none": "名单上还没有工作者。",
    "toolview.check.summary.one": "已查看 {count} 位工作者",
    "toolview.check.summary.other": "已查看 {count} 位工作者",
    "toolview.check.refused": "无法查看名单——{cause}。",
    "toolview.steer.pending": "正在调整 {subject}",
    "toolview.steer.sent": "正在调整 {subject}",
    "toolview.steer.refused": "无法调整 {subject}——{cause}。没有排队任何内容。",
    "toolview.stop.pending": "正在停止 {subject}",
    "toolview.stop.stopped": "已停止 {subject}",
    "toolview.stop.released": "已释放 {subject} 占用的流",
    "toolview.stop.refused": "无法停止 {subject}——{cause}。没有任何更改。",
    "toolview.deliver.pending": "正在送达",
    "toolview.deliver.done": "已送达给你",
    "toolview.deliver.recorded": "结果已记录——请在你的回复中告知用户",
    "toolview.deliver.refused": "无法送达——{cause}。用户没有收到任何内容。",
    "toolview.message.pending": "正在给 {subject} 发消息",
    "toolview.message.sent": "消息已发送给 {subject}",
    "toolview.message.refused":
      "无法给 {subject} 发消息——{cause}。没有发送任何内容。",
    "toolview.await.pending": "正在等待 {subject}",
    "toolview.await.done": "{subject} 已完成",
    "toolview.await.failed": "{subject} 失败了",
    "toolview.await.stopped": "{subject} 已停止",
    "toolview.await.working": "{subject} 仍在运行",
    "toolview.await.gone": "没有 {subject} 的结果——它已不在",
    "toolview.await.released": "已停止等待 {subject}",
    "toolview.await.refused": "无法等待 {subject}——{cause}。",
    "toolview.dispatcher.summoned": "已召唤“{title}”",
    "toolview.dispatcher.summoned-generic": "已召唤 {subject}",
    "toolview.dispatcher.pending": "正在召唤“{title}”",
    "toolview.dispatcher.pending-generic": "正在召唤 {subject}",
    "toolview.dispatcher.refused":
      "无法召唤“{title}”——{cause}。没有启动任何东西。",
    "toolview.dispatcher.refused-generic":
      "无法召唤调度器——{cause}。没有启动任何东西。",
    "toolview.peer.pending": "正在发送给 {subject}",
    "toolview.peer.sent": "已发送给 {subject}",
    "toolview.peer.refused": "无法发送给 {subject}——{cause}。没有发送任何内容。",
    // 每个拒绝原因都映射为人类可读的原因；原始枚举只出现在详情里。静默围栏
    // 保持模糊措辞（“此聊天中没有该 ID 的工作者”），绝不写“属于另一个调度器”。
    "toolview.cause.duplicate-stream-key": "该流键已被占用",
    "toolview.cause.unknown-todo-id": "此聊天中没有该 ID 的待办",
    "toolview.cause.todo-already-linked": "该待办已关联到一位工作者",
    "toolview.cause.unknown-worker": "此聊天中没有该 ID 的工作者",
    "toolview.cause.not-running": "该工作者已经结束",
    "toolview.cause.already-settled": "该工作者已经结束",
    "toolview.cause.unknown-todo": "此聊天中没有该 ID 的待办",
    "toolview.cause.no-delivery-channel": "此构建没有向你发送的通道",
    "toolview.cause.send-failed": "发送失败",
    "toolview.cause.unknown-agent": "此聊天中没有该 ID 的代理",
    "toolview.cause.unknown-dispatcher": "此聊天中没有该 ID 的调度器",
    "toolview.cause.self-target": "那是你自己的会话",
    "toolview.cause.inbox-full": "该收件箱已满",
    "toolview.cause.rate-limited": "刚才发送的消息太多",
    "toolview.cause.invalid-envelope": "消息无法按原样发送",
    "toolview.cause.message-id-reuse": "该消息 ID 已被使用",
    "toolview.cause.not-awaitable": "调度器是同伴，不是工作者",
    "toolview.cause.too-many-waits": "已经打开了太多等待",
    "toolview.cause.invalid-timeout": "超时不是有效的数字",
    "toolview.cause.invalid-args": "标题或提示为空",
    "toolview.cause.host-refused": "宿主拒绝启动它",
    "toolview.cause.failed": "出了点问题",
    "activation.presence-hint":
      "调度器会在工作中随时汇报进度；结果完成后会直接送达本聊天。",
    "roster.steer.button": "纠偏",
    "roster.steer.hint": "已为 {worker} 填入输入框——请检查后发送。",
    "roster.steer.copy-fallback":
      "此处无法访问输入框——请在本聊天中输入 /dispatcher-steer {worker} 加上你的指示。",
    // Ticket 47：设置 → 插件配置 卡片。标题即插件显示名；启用项的说明用用户的话
    // 说清 ADR-0005 规则（保存的更改对新会话生效——当前会话沿用启动时的开关值），
    // 以免这个控件被读成实时开关。
    "settings.card.title": "Multitask Dispatcher",
    "settings.card.description":
      "调度器的功能开关，以及唤醒合并、收件箱、RACOONS 与微压缩设置。",
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
    "settings.card.field.wakeCoalesceWindowMs.label": "唤醒合并窗口（毫秒）",
    "settings.card.field.wakeCoalesceWindowMs.hint":
      "调度器空闲时，把窗口内先后到达的多个后台完成合并为一次唤醒；你的消息始终优先。0 表示立即唤醒（默认）。",
    // Ticket 113：可选的文件收件箱。提示同样说明“新会话生效”规则，
    // 并指出外部系统写入队列任务的目录。
    "settings.card.field.inboxEnabled.label": "启用文件收件箱",
    "settings.card.field.inboxEnabled.hint":
      "保存为调度器的设置：对新会话生效。开启后，调度器还会从下方目录接收任务。",
    // Ticket 145：只要调度器插件启用，RACOONS 就一直运行；此处只调节它——
    // 仅记录模式、存储根目录、半窗口清理的窗口大小。Ticket 150：标签说明
    // 当前真实行为——一切照常记录，但结果回合的入口检查点答案仍可落到上下文；
    // 只有自动清理和手动遗忘会被拦下。
    // 所有者决定（2026-11-05）：RACOONS 是可选测试功能，默认关闭。
    "settings.card.field.racoonsEnabled.label": "启用 RACOONS",
    "settings.card.field.racoonsEnabled.hint":
      "默认关闭。开启后，RACOONS 会把本进程内的每个会话记录到磁盘上的独立账本，并可能清理旧上下文；被移除的内容仍可通过 recall id 按原样取回。仅用于手动发起的测试。",
    "settings.card.field.racoonsRecordOnly.label":
      "RACOONS 仅记录模式（入口检查点仍可生效）",
    "settings.card.field.racoonsRecordOnly.hint":
      "仅在 RACOONS 启用时生效。关闭时，RACOONS 会对本进程内的所有会话执行上下文清理；开启时一切照常记录，自动清理和手动遗忘不再执行，但结果回合的入口检查点答案仍可改写该结果。被移除的内容仍可通过 recall id 按原样取回，原始内容按会话保存在磁盘上。",
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
    "shell.seat.failed": "此面板渲染失败。",
    "shell.row.working.one": "{count} 个进行中",
    "shell.row.working.other": "{count} 个进行中",
    "shell.row.needs-you.one": "{count} 个需要你",
    "shell.row.needs-you.other": "{count} 个需要你",
    "shell.row.finished.one": "{count} 个已完成",
    "shell.row.finished.other": "{count} 个已完成",
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
    "shell.conv.role-peer": "来自另一位调度器",
    "shell.conv.working": "输出中…",
    "shell.conv.interrupted": "（已中断）",
    "shell.conv.attachment-only": "（无文本内容）",
    "shell.conv.tool-running": "进行中",
    "shell.conv.tool-failed": "失败",
    "shell.conv.message": "消息",
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
    // 工作者派遣卡片以一句可读的句子开头；`ungated` 审批门不再显示，ID 与流键
    // 收在“详情”里。
    "shell.dispatch.started": "已启动“{title}”",
    "shell.dispatch.started-generic": "已启动 {subject}",
    "shell.dispatch.refused": "无法启动“{title}”——{cause}",
    "shell.dispatch.refused-generic": "无法启动工作者——{cause}",
    // Ticket 123：会话类别图标文案（仅作无障碍名称/悬停提示，不是可见段落）。
    // Ticket 177：调度器分成两类，各自有自己的无障碍名称。
    "indicator.dispatcher": "调度器",
    "indicator.team-leader": "被召唤的调度器",
    "indicator.worker": "工作者",
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
