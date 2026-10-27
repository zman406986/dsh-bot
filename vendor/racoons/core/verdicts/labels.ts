import { oneLine } from "../rules/assets.js";

/**
 * The receipt label cap the product advertises, in characters. It is the
 * owner's ruled 40 (research §4) and a constant, not configuration: the gate
 * tuning that once supplied it is gone (ADR-0028), and the manual forget
 * receipt is its only reader.
 */
export const RECEIPT_LABEL_CHAR_LIMIT = 40;

/**
 * The enforced label length: the advertised cap plus one quarter of hidden
 * headroom. Agents miscount their own output and retry in loops; the slack
 * absorbs the overshoot. 40 advertised is 50 enforced.
 */
export function enforcedLabelLimit(configured: number = RECEIPT_LABEL_CHAR_LIMIT): number {
  return Math.ceil(configured * 5 / 4);
}

/**
 * One line, trimmed. CR, LF, U+2028 and U+2029 collapse to a single space
 * before the length check, so a label cannot smuggle extra lines into a
 * receipt or dodge the cap with line breaks.
 */
export function normalizeLabel(label: string): string {
  return oneLine(label).trim();
}

/**
 * The length verdict for one label. Reported only after normalisation. An
 * empty normalised label is not a length failure: it means the floor receipt
 * line ships without a label.
 */
export function labelIssue(
  label: string, configured: number = RECEIPT_LABEL_CHAR_LIMIT,
): "label-too-long" | null {
  return normalizeLabel(label).length > enforcedLabelLimit(configured) ? "label-too-long" : null;
}

/**
 * The forgetall descriptor cap, in words (ISSUE-017; owner ruling 2026-10-22).
 * It is not `RECEIPT_LABEL_CHAR_LIMIT`: that number counts characters of a topic
 * label, this one counts words of a one-line description, and the two are not
 * interchangeable. It is a constant, not configuration, because the owner's
 * ruling fixes the number; H-011 measurement can promote it later.
 */
export const RECEIPT_DESCRIPTOR_WORD_LIMIT = 25;

/** The visible mark a clamped descriptor ends with, so a cut is never silent. */
export const DESCRIPTOR_CUT_MARK = "…";

/**
 * Words in a receipt descriptor, counted after line breaks collapse to spaces.
 * A word is a whitespace-delimited run: the only count the judge and the guard
 * can agree on without a tokenizer.
 */
export function descriptorWordCount(text: string): number {
  const collapsed = oneLine(text).trim();
  return collapsed.length === 0 ? 0 : collapsed.split(/\s+/u).length;
}

/**
 * The plan layer's headroom: a descriptor past the cap is cut at the last whole
 * word that fits and ends with the cut mark. The guard still refuses the
 * over-limit answer (`descriptor-too-long`), so this clamp keeps a receipt from
 * growing an extra line; it never accepts an overshoot on the agent's behalf.
 */
export function clampDescriptor(text: string): string {
  const collapsed = oneLine(text).trim();
  const words = collapsed.length === 0 ? [] : collapsed.split(/\s+/u);
  if (words.length <= RECEIPT_DESCRIPTOR_WORD_LIMIT) return collapsed;
  return `${words.slice(0, RECEIPT_DESCRIPTOR_WORD_LIMIT).join(" ")}${DESCRIPTOR_CUT_MARK}`;
}

/**
 * The length verdict for one descriptor, after normalisation. `null` means the
 * descriptor fits the 25-word cap; a floor line (blank) fits too.
 */
export function descriptorIssue(text: string): "descriptor-too-long" | null {
  return descriptorWordCount(text) > RECEIPT_DESCRIPTOR_WORD_LIMIT ? "descriptor-too-long" : null;
}
