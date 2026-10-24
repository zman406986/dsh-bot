/**
 * The judge message's shape and its decision suffix (ISSUE-021, owner rulings
 * 5-7).
 *
 * The turn and message types, the decision line, and the suffix machinery
 * composition uses: the separator, the tagless suffix, the anchored suffix and
 * the helper that picks one. `./assembly.ts` re-exports every name here, so a
 * caller keeps importing from `judge/assembly.js`.
 *
 * The suffix is the message's per-call tail, built once per composition. There
 * is no strip: growing one message by suffix extension is the shape the
 * provider does not cache, and it is deleted (ISSUE-026, ADR-0010). A pass that
 * needs a second judge turn forks main's sent wire state and appends messages
 * (`./fork.ts`).
 *
 * Everything is pure and deterministic: same turns, same suffix bytes.
 */

import { buildAnchorSuffix } from "./anchors.js";
import type { AnchorMode } from "./anchors.js";

/**
 * The sentence that ends every judge user message (ISSUE-021 point 3). It is
 * an instruction, not content to judge, and it is the only per-call text after
 * the history. The system prompt quotes these exact bytes.
 */
export const VERDICT_JUDGE_DECISION_LINE =
  "The last tool result above is the unit. Decide.";

/** Who produced a turn. Only a `tool` turn can be the unit. */
export type ConversationRole = "user" | "assistant" | "tool";

/**
 * One turn of the conversation, as the runner maps it from its transcript.
 *
 * `text` is the turn's content exactly as production renders it: original
 * bytes, no reformatting, no added tags. Tool names, ids and statuses are not
 * carried because the judge never reads them; the runner supplies them only
 * where its own protocol needs them.
 */
export interface ConversationTurn {
  readonly role: ConversationRole;
  readonly text: string;
}

/** The two messages of one judge call. */
export interface JudgeMessages {
  readonly system: string;
  readonly user: string;
}

/** Options for `composeJudgeMessages`. Omitting them is the tagless arm. */
export interface ComposeOptions {
  /**
   * `"off"` (default) appends no anchor line: the message is byte-identical to
   * the tagless lane. `"on"` inserts one anchor line before the decision line.
   */
  readonly anchors?: AnchorMode;
}

/**
 * The bytes between two rendered turns. A blank line is the only thing this
 * module adds: no headers, no turn numbers, no role labels, no line tags
 * (Ruling 5a). Each turn's own text is emitted untouched.
 */
export const TURN_SEPARATOR = "\n\n";

/**
 * Every tagless user message ends with these exact bytes.
 */
export const DECISION_SUFFIX = `${TURN_SEPARATOR}${VERDICT_JUDGE_DECISION_LINE}`;

/**
 * The anchored suffix: one blank line, the anchor line, one line break, the
 * decision line. The anchor line is compact (one line, never a block), so the
 * suffix stays a suffix and the history prefix is untouched. The single line
 * break between the two is what keeps the anchor line visually distinct from
 * the instruction without spending a second blank line on every call.
 */
export function anchoredSuffix(unitText: string): string {
  return `${TURN_SEPARATOR}${buildAnchorSuffix(unitText)}\n${VERDICT_JUDGE_DECISION_LINE}`;
}

/** The bytes this module appends after the history, for one arm and unit. */
export function suffixFor(anchors: AnchorMode, unitText: string): string {
  return anchors === "on" ? anchoredSuffix(unitText) : DECISION_SUFFIX;
}

/** The unit's text: the last turn's, already asserted to be the unit. */
export function unitTextOf(turns: readonly ConversationTurn[]): string {
  return turns[turns.length - 1]?.text ?? "";
}
