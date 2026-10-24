/**
 * The wrapper-line rule of the big prune's excerpts (ISSUE-022 §Unit
 * addressing; ADR-0009). An excerpt must begin and end on content, so
 * decoration is skipped rather than quoted.
 *
 * A line is a wrapper when it is any of:
 *
 * - blank, or only whitespace;
 * - a markdown fence: it opens with three backticks or three tildes, with or
 *   without an info string;
 * - free of every letter and digit — all of its characters are punctuation,
 *   symbols or whitespace.
 *
 * A line holding any letter or digit is content, however decorative the rest
 * of it looks. The rule is Unicode-aware (`\p{L}`, `\p{N}`), so a CJK line and
 * an emoji-only line are judged by what they carry, not by ASCII accident.
 *
 * Exported as one function and used by `./excerpt.ts` alone: a second copy of
 * this rule would drift, and a reader would have two answers for one line.
 */
export function isPruneWrapperLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (/^(?:```|~~~)/u.test(trimmed)) return true;
  return !/[\p{L}\p{N}]/u.test(trimmed);
}
