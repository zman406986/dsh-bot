import { readUnitLines, sampleLines, shareBytesOf } from "./excerpt-lines.js";

/**
 * The excerpt half of the big prune's row anchor (ISSUE-022 §Unit addressing;
 * ADR-0009): two verbatim samples of a unit's bytes at a pair of positions,
 * each bounded by a byte share of the unit and by a word count.
 *
 * Rule, stated once and never varied per call:
 *
 * - A position is a share of the unit's byte length (0.3 and 0.7 by default),
 *   resolved to a byte offset and then to the line holding that byte. An offset
 *   on a terminator belongs to the line it terminates.
 * - A sample begins at the first content line at or after the position and
 *   grows by whole lines. A line is taken while the sample stays inside its
 *   byte share OR inside its word cap — the owner's `max(2% of the result, 40
 *   words)`, whichever is bigger. A small unit is therefore bounded by its
 *   words and a large one by its share; a test exists for each regime.
 * - One oversized token is the exception to "whichever is bigger": a word cap
 *   cannot shorten a single word, so a line with no whitespace that exceeds the
 *   share is cut at the share's code-point boundary rather than taken whole.
 *   That is the only rule that keeps a single huge line inside the caps.
 * - A line over both caps is cut inside it at a word boundary: the longer of
 *   its first `maxWords` words and its word-boundary prefix inside the share.
 *   A token with no whitespace keeps the code-point prefix, never a split
 *   character, so CJK and emoji stay intact.
 * - Wrapper lines are skipped at the leading edge and dropped at the trailing
 *   edge, so a sample begins and ends on content (`isPruneWrapperLine`).
 * - Lines are joined with LF, terminators are not part of the text, and a
 *   shortened sample ends `PRUNE_EXCERPT_CUT_MARK`. The mark is added after the
 *   caps and is not counted by them.
 *
 * The byte share is floored at four bytes (one maximum-size UTF-8 character),
 * so a tiny unit yields a character rather than a bare cut mark.
 *
 * Degenerate shapes, all deterministic: no bytes, or every line a wrapper,
 * yields two empty samples; a short unit whose positions land on one line
 * yields that line twice (windows may overlap; uniqueness was never claimed);
 * bytes that will not decode as UTF-8 — a span edge inside a character — yield
 * `undecodable-unit` rather than replacement characters.
 *
 * Pure: same bytes and options, same samples; nothing is mutated. An invalid
 * option value throws `RangeError`, because that is a caller bug, not
 * transcript data. All four numbers are exported constants below, so a later
 * sweep varies them without touching this code.
 */

/** Default position of the first sample, as a share of the unit's byte length. */
export const PRUNE_ANCHOR_POSITION_A = 0.3;
/** Default position of the second sample, as a share of the unit's byte length. */
export const PRUNE_ANCHOR_POSITION_B = 0.7;
/** Default byte share of the unit one sample may draw. */
export const PRUNE_ANCHOR_MAX_SHARE = 0.02;
/** Default word cap of one sample. */
export const PRUNE_ANCHOR_MAX_WORDS = 40;

/** Re-exported from `./excerpt-lines.ts`, which appends it at every cut. */
export { PRUNE_EXCERPT_CUT_MARK } from "./excerpt-lines.js";

/** The four swept numbers. Optional; each default is the exported constant above. */
export interface PruneExcerptOptions {
  readonly positionA?: number;
  readonly positionB?: number;
  readonly maxShare?: number;
  readonly maxWords?: number;
}

export type PruneExcerptPair =
  | { readonly excerptA: string; readonly excerptB: string }
  | { readonly refusal: "undecodable-unit" };

/** Two samples of one unit's bytes, or the refusal that says they were not decoded. */
export function buildPruneExcerpts(
  content: Uint8Array,
  options: PruneExcerptOptions = {},
): PruneExcerptPair {
  const positionA = fraction(options.positionA, PRUNE_ANCHOR_POSITION_A, "positionA", true);
  const positionB = fraction(options.positionB, PRUNE_ANCHOR_POSITION_B, "positionB", true);
  const maxShare = fraction(options.maxShare, PRUNE_ANCHOR_MAX_SHARE, "maxShare", false);
  const maxWords = whole(options.maxWords, PRUNE_ANCHOR_MAX_WORDS, "maxWords");

  const lines = readUnitLines(content);
  if (lines === null) return { refusal: "undecodable-unit" };
  if (lines.length === 0) return { excerptA: "", excerptB: "" };

  const share = shareBytesOf(content.byteLength, maxShare);
  return {
    excerptA: sampleLines(lines, positionA, share, maxWords),
    excerptB: sampleLines(lines, positionB, share, maxWords),
  };
}

/** A number in [0, 1], or in (0, 1] when `allowZero` is false. */
function fraction(value: number | undefined, fallback: number, name: string, allowZero: boolean): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1 || (!allowZero && value === 0)) {
    throw new RangeError(`${name} must be a finite number in ${allowZero ? "[0, 1]" : "(0, 1]"}.`);
  }
  return value;
}

function whole(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}
