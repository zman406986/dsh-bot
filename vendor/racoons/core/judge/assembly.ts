/**
 * The conversation renderer the ask lanes share.
 *
 * The user message of an ask is the production conversation rendered byte for
 * byte — each turn's own text, ascending, nothing injected and no line tags —
 * followed by the caller's own ask text. `renderHistory` is that prefix and
 * nothing more: it never appends a suffix and never decides where an ask's
 * per-call text goes.
 *
 * The judge's per-unit assembly (a system contract, a decision line and an
 * anchor A/B arm) is deleted with the judge pass (ADR-0028). The fork lane
 * (`./fork.ts`) still grows main's sent wire state append-only; this module
 * only renders turns.
 *
 * Everything is pure and deterministic: same turns, same bytes.
 */

/** Who produced a turn. */
export type ConversationRole = "user" | "assistant" | "tool";

/**
 * One turn of the conversation, as a caller maps it from its transcript.
 *
 * `text` is the turn's content exactly as production renders it: original
 * bytes, no reformatting, no added tags.
 */
export interface ConversationTurn {
  readonly role: ConversationRole;
  readonly text: string;
}

/**
 * The bytes between two rendered turns. A blank line is the only thing this
 * module adds: no headers, no turn numbers, no role labels, no line tags
 * (Ruling 5a). Each turn's own text is emitted untouched.
 */
export const TURN_SEPARATOR = "\n\n";

/**
 * Renders the conversation as production does: turn texts in the order given,
 * joined by one blank line. Nothing is sorted, trimmed, normalised or tagged.
 */
export function renderHistory(turns: readonly ConversationTurn[]): string {
  return turns.map((turn) => turn.text).join(TURN_SEPARATOR);
}
