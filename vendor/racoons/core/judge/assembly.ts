/**
 * The v4.1 judge prompt assembly (ISSUE-021, owner rulings 5-7).
 *
 * One judge call is two messages. The system message is the static contract
 * (`VERDICT_JUDGE_SYSTEM_PROMPT`): identical bytes for every call of a run, so
 * a provider can cache it. The user message is the production conversation
 * rendered byte for byte — each turn's own text, ascending, nothing injected
 * and no line tags — followed by one short decision line.
 *
 * The unit is the conversation's last tool result. `composeJudgeMessages`
 * refuses a history that ends elsewhere: judging happens right after the
 * result lands in production (ISSUE-021 point 7), so a trailing assistant turn
 * means the caller judged a moment the conversation had already left.
 *
 * Composition is the whole of this module. Growing one message by
 * re-appending turns is the shape the provider measures at 0% cache, so the
 * extension and stripping API is deleted (ISSUE-026, ADR-0010). A pass that
 * needs a second judge turn forks main's last sent wire state and appends
 * messages to the array instead (`./fork.ts`); it never re-renders or edits a
 * message. No epoch, removal, verdict or clock state is read or written here.
 *
 * The decision suffix is the message's only per-call region: the history before
 * it is the same bytes production holds. A variant that adds per-moment text
 * (the anchor quotes of ISSUE-021 point 6) belongs in that suffix, after the
 * history and before the decision line. `DECISION_SUFFIX` is the tagless
 * suffix's one definition, `anchoredSuffix` the anchored one, and `suffixFor`
 * picks between them, so composition derives from them and the prefix stays
 * free of per-call text. Those four, and the turn and message types, are
 * `./assembly-suffix.ts`; every name there is re-exported here.
 *
 * The anchor lane is an A/B arm, not a different structure. `anchors: "off"`
 * (the default, and the only behaviour before this lane existed) appends one
 * blank line and the decision line. `anchors: "on"` inserts one anchor line
 * from `anchors.ts` between them: the unit's first and last content line,
 * quoted. The two arms are byte-identical up to the start of that line and end
 * with the same decision line, so the comparison measures the anchors and
 * nothing else.
 *
 * Everything is pure and deterministic: same turns, same bytes.
 */

import type { ComposeOptions, ConversationTurn, JudgeMessages } from "./assembly-suffix.js";
import { suffixFor, TURN_SEPARATOR, unitTextOf } from "./assembly-suffix.js";

export { VERDICT_JUDGE_DECISION_LINE } from "./assembly-suffix.js";
export type {
  ComposeOptions, ConversationRole, ConversationTurn, JudgeMessages,
} from "./assembly-suffix.js";

/**
 * Renders the conversation as production does: turn texts in the order given,
 * joined by one blank line. The last turn is the unit, so its text — the
 * original tool-result bytes — is the last content before the decision line.
 * Nothing is sorted, trimmed, normalised or tagged.
 */
export function renderHistory(turns: readonly ConversationTurn[]): string {
  return turns.map((turn) => turn.text).join(TURN_SEPARATOR);
}

/**
 * A judge history must end with the unit. The check is here, at the call
 * boundary, rather than in `renderHistory`: a plain prefix has no unit and is
 * still validly renderable.
 */
function assertUnitLast(turns: readonly ConversationTurn[]): void {
  const last = turns[turns.length - 1];
  if (last === undefined || last.role !== "tool") {
    throw new Error(
      "The judge history must end with the unit: its last turn is a tool result.",
    );
  }
}

/**
 * Builds the two messages of one judge call. `systemPrompt` is passed in
 * verbatim — the product passes `VERDICT_JUDGE_SYSTEM_PROMPT` — so this module
 * carries no copy of the contract and cannot drift from the asset.
 *
 * The user message is `renderHistory(turns)` followed by the suffix of the
 * chosen arm: the decision line alone (`anchors: "off"`, the default, whose
 * bytes are identical to the lane before anchors existed), or one anchor line
 * and the decision line (`anchors: "on"`). A history that does not end with a
 * tool result is refused, never silently rendered with a misplaced unit.
 */
export function composeJudgeMessages(
  systemPrompt: string,
  turns: readonly ConversationTurn[],
  options: ComposeOptions = {},
): JudgeMessages {
  assertUnitLast(turns);
  const anchors = options.anchors ?? "off";
  const suffix = suffixFor(anchors, unitTextOf(turns));
  return { system: systemPrompt, user: `${renderHistory(turns)}${suffix}` };
}
