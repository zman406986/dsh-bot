/**
 * Hello-world `shell.overlay` entry + locale namespace (ticket 20).
 *
 * Pure registration data — no DOM, no React, no Cordis. Tests assert this
 * module directly (offline, S8).
 *
 * Namespacing rules (design-16 §5):
 * - Slot `name`s are ONLY dsh-owned shipped slots; never invented, never
 *   `root`, and never the rejected-for-v1 surfaces `main`,
 *   `sidebar.right.pane.tab`, or `conversation.approval.detail`.
 * - Slot entry `id`s are `multitask-dispatcher-` prefixed.
 * - The locale namespace is the plugin id, matching the settings namespace
 *   (`src/adapter/settings-section.ts`).
 *
 * All copy is original clean-room text (en drafts + zh translations written
 * for this repo; no reference material was consulted).
 */

/** dsh's documented home for free-floating plugin surfaces (list slot:
 * additive, order-sorted, click-through by default — Finding 5,
 * `registry.d.ts:16-38`). */
export const SHELL_OVERLAY_SLOT = "shell.overlay";

/** Overlay entry id for the scaffold panel (`multitask-dispatcher-` prefix). */
export const HELLO_ENTRY_ID = "multitask-dispatcher-hello";

/**
 * Sort position within the additive overlay list. Low priority on purpose:
 * the scaffold is inert and the roster ticket (21) owns real ordering.
 */
export const HELLO_OVERLAY_ORDER = 100;

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

/** Build the hello-world `shell.overlay` registration options. */
export function helloOverlayRegistration(): SlotRegistrationOptions {
  return {
    name: SHELL_OVERLAY_SLOT,
    id: HELLO_ENTRY_ID,
    order: HELLO_OVERLAY_ORDER,
    locale: LOCALE_NAMESPACE,
  };
}

/** One locale face: dotted copy keys mapped to strings. */
export type LocaleFace = Readonly<Record<string, string>>;

/** `{en, zh}` dictionary shape accepted by `ctx.locale.register` (Finding 6). */
export interface LocaleDictionary {
  readonly en: LocaleFace;
  readonly zh: LocaleFace;
}

/** Scaffold panel copy (clean-room; design-16 §6 style, v1 placeholder). */
export const localeDictionary: LocaleDictionary = {
  en: {
    "panel.title": "Dispatcher",
    "panel.placeholder": "Panel scaffold — no live worker status yet.",
  },
  zh: {
    "panel.title": "调度器",
    "panel.placeholder": "面板脚手架 — 暂无实时 worker 状态。",
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
