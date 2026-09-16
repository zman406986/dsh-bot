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
 * Roster panel copy (clean-room, design-16 §6): title, empty state, and the
 * honest stale/unavailable state. Status labels are NOT localized — the core
 * FSM vocabulary (`spawned`/`running`/`steering`/`completed`/`error`/
 * `aborted`) renders verbatim, as-is.
 *
 * Ticket 24 adds the per-tool call view copy: field labels for the compact
 * detail rows and the degraded-row fallback. Outcome values and check-row
 * status labels stay verbatim payload/core vocabulary, never localized.
 */
export const localeDictionary: LocaleDictionary = {
  en: {
    "roster.title": "Workers",
    "roster.empty": "No workers yet. Ask the dispatcher to start some.",
    "roster.unavailable": "Worker status is unavailable right now.",
    "toolview.degraded": "Tool call details are unavailable.",
    "toolview.field.worker": "Worker",
    "toolview.field.title": "Title",
    "toolview.field.stream": "Stream",
    "toolview.field.todo": "Todo",
    "toolview.field.outcome": "Outcome",
    "toolview.field.steer": "Steer",
    "toolview.field.delivered": "Delivered",
    "toolview.field.attachments": "Attachments",
  },
  zh: {
    "roster.title": "工作者",
    "roster.empty": "还没有工作者。让调度器启动一些吧。",
    "roster.unavailable": "工作者状态暂时不可用。",
    "toolview.degraded": "工具调用详情不可用。",
    "toolview.field.worker": "工作者",
    "toolview.field.title": "标题",
    "toolview.field.stream": "流",
    "toolview.field.todo": "待办",
    "toolview.field.outcome": "结果",
    "toolview.field.steer": "纠偏",
    "toolview.field.delivered": "已送达",
    "toolview.field.attachments": "附件",
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
