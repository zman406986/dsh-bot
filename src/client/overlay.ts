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
 * Ticket 38 adds the collapsed capsule chip copy: accessible labels for the
 * expand/collapse controls and the activation-dot states, plus the badge
 * text templates (ADR-0013).
 *
 * Ticket 39 adds the expanded activation row's copy: the start and stop
 * INTENT affordance labels (the stop label is honest conversational-stop
 * wording — an ask handed to the dispatcher, never a kill control,
 * ADR-0005/0009) and the dormant composition's activation-pitch body. The
 * row's state lines reuse the `capsule.dot.*` keys above.
 *
 * Ticket 40 adds the action-wiring copy: the SUBMITTED conversational stop
 * phrasing (`capsule.stop.message` — sent verbatim as the user's own plain
 * message, matching ticket 31's stop/course-change policy rule, design-17
 * §7), the honest failure lines for the activation intents (send failure /
 * command-not-available / no channel — never a fake success), and the
 * per-row steer affordance copy (button, post-prefill hint — focus is not
 * exposed so the user must review and send — and the copy-only fallback for
 * when the composer draft is unreachable).
 *
 * Ticket 41 adds the expanded card's deliverables-line copy: the S6 label
 * ("undelivered results" — completed means delivered, so only owed results
 * count), the `{count}` phrasing, and the excerpt's expand/collapse
 * affordance. The excerpt text itself is wire truth, never localized.
 *
 * Ticket 42 adds the footer copy: the flag-provenance lines (the persisted
 * `enabled` value from the watched settings namespace — phrased as the
 * SETTING, never the live session state, per ADR-0005's frozen flag) and
 * the copy-only Settings hint (degraded seam 4: no deep-link exists, so the
 * path is named and nothing navigates). No profile key exists: seam 5 found
 * no client-visible profile identity, and the segment is omitted rather
 * than invented from `$host.home`.
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
    // Ticket 32 (design-17 §7): the activation success presence hint. The
    // host command copy (`src/adapter/activation-command.ts`
    // `ACTIVATION_PRESENCE_HINT`) is the en authority; this face carries the
    // identical en string plus the zh translation so the pair stays a single
    // localized copy unit. The client face does not render it today — the
    // host command result is the surface — but the key set is shared.
    "activation.presence-hint":
      "The Workers panel shows live progress; results arrive in this chat as they finish.",
    // Ticket 38 (ADR-0013): the collapsed capsule chip. Accessible labels
    // for the expand/collapse controls and the three activation-dot states,
    // plus the badge text templates ({count} substituted by
    // `formatTemplate`). Status vocabulary stays unlocalized store truth;
    // only the chip's own copy lives here.
    "capsule.chip.open": "Open the Workers panel",
    "capsule.chip.workers": "{count} workers",
    "capsule.chip.wake": "{count} ready",
    "capsule.collapse": "Collapse",
    "capsule.dot.dormant": "Dispatcher not started",
    "capsule.dot.active": "Dispatcher active",
    "capsule.dot.error": "Worker status unavailable",
    // Ticket 41: the expanded card's deliverables line — the label, the
    // count phrasing ({count} substituted), and the excerpt's expand/
    // collapse affordance. S6 wording: completed means DELIVERED, so the
    // line speaks only of results not yet delivered to the user.
    "capsule.deliverables.label": "Undelivered results",
    "capsule.deliverables.count": "{count} awaiting delivery",
    "capsule.deliverables.expand": "Show latest result",
    "capsule.deliverables.collapse": "Hide latest result",
    // Ticket 42: the footer. The flag lines report the PERSISTED setting
    // (ADR-0005: the running chat froze its own flag; a change takes effect
    // in new chats), and the Settings hint is copy-only — no deep-link seam
    // exists, so the path is named and nothing navigates.
    "capsule.footer.flag.on": "Dispatcher setting: enabled",
    "capsule.footer.flag.off": "Dispatcher setting: disabled",
    "capsule.footer.settings-hint":
      "Change it in Settings → Multitask Dispatcher — takes effect in new chats.",
    // Ticket 39: the activation row. The stop label is an honest
    // conversational-stop ask (the intent rides the user-verbatim command
    // path in ticket 40) — never phrased as a kill/deactivate control.
    "capsule.activation.start": "Start dispatcher in this chat",
    "capsule.activation.stop": "Ask the dispatcher to stop",
    "capsule.activation.pitch":
      "Start the dispatcher to run workers in this chat; results arrive here as they finish.",
    // Ticket 40: the action-wiring copy. The stop message is SUBMITTED
    // verbatim as the user's own plain-language ask (ticket 31's policy rule
    // treats it as steer/stop + honest confirmation); the failure lines are
    // the only notices the capsule itself renders — there is deliberately no
    // success key (the roster feed is the only success truth).
    "capsule.stop.message":
      "Please stop the dispatcher: stop the running workers and do not start new ones. Confirm what you stopped.",
    "capsule.action.send-failed":
      "The message could not be sent. Nothing was changed.",
    "capsule.action.not-available":
      "The dispatcher command is not available in this chat.",
    "capsule.action.no-channel": "No command channel is available here.",
    // Ticket 40: the per-row steer affordance. The hint renders after a
    // successful prefill (focus is not exposed — review and send); the
    // fallback is the copy-only degrade for when the draft is unreachable.
    "roster.steer.button": "Steer",
    "roster.steer.hint":
      "Placed in the composer for {workerId} — review and send.",
    "roster.steer.copy-fallback":
      "Composer not reachable here — type /dispatcher-steer {workerId} followed by your instruction in this chat.",
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
    "activation.presence-hint":
      "“工作者”面板会显示实时进度；结果完成后会直接送达本聊天。",
    "capsule.chip.open": "打开工作者面板",
    "capsule.chip.workers": "{count} 个工作者",
    "capsule.chip.wake": "{count} 个就绪",
    "capsule.collapse": "收起",
    "capsule.dot.dormant": "调度器未启动",
    "capsule.dot.active": "调度器运行中",
    "capsule.dot.error": "工作者状态不可用",
    "capsule.deliverables.label": "未送达结果",
    "capsule.deliverables.count": "{count} 个等待送达",
    "capsule.deliverables.expand": "显示最新结果",
    "capsule.deliverables.collapse": "隐藏最新结果",
    // Ticket 42: 页脚。旗标行报告的是持久化设置（ADR-0005：运行中的会话已冻结
    // 自己的旗标；更改对新会话生效），设置提示仅为文案——不存在深链 seam，
    // 只指明路径，不做任何跳转。
    "capsule.footer.flag.on": "调度器设置：已启用",
    "capsule.footer.flag.off": "调度器设置：已停用",
    "capsule.footer.settings-hint":
      "可在 设置 → Multitask Dispatcher 中更改——对新会话生效。",
    "capsule.activation.start": "在本聊天中启动调度器",
    "capsule.activation.stop": "请求调度器停止",
    "capsule.activation.pitch":
      "启动调度器以在本聊天中运行工作者；结果完成后会送达此处。",
    "capsule.stop.message":
      "请停止调度器：停止运行中的工作者，不要再启动新的。请确认你停止了哪些工作者。",
    "capsule.action.send-failed": "消息未能发送。没有任何更改。",
    "capsule.action.not-available": "此聊天中调度器命令不可用。",
    "capsule.action.no-channel": "此处没有可用的命令通道。",
    "roster.steer.button": "纠偏",
    "roster.steer.hint": "已为 {workerId} 填入输入框——请检查后发送。",
    "roster.steer.copy-fallback":
      "此处无法访问输入框——请在本聊天中输入 /dispatcher-steer {workerId} 加上你的指示。",
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
