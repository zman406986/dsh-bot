/**
 * Anchor quotes: the line-counting aid of the anchored A/B lane (ISSUE-021
 * point 6).
 *
 * Line tags died in v4.1: the history is production's bytes, so the judge gets
 * no `N|` prefix and must count the unit's lines itself. The anchored arm makes
 * that counting cheap without touching the history: it appends one short line
 * to the message's suffix, after the history and before the decision line,
 * quoting the unit's first and last line that carry content together with
 * their 1-based numbers.
 *
 *     Line 1 begins "first words". Line 17 ends "last words".
 *
 * The tagless arm appends no such line, so the two arms are byte-identical up
 * to the suffix and both end with the exact decision line. `assembly.ts` owns
 * placement; this module owns only the line's bytes.
 *
 * Quoting rules, all deterministic:
 *
 * - A line is collapsed before it is quoted: every run of whitespace (spaces,
 *   tabs, CR, LF, U+2028, U+2029) becomes one space, then the ends are trimmed.
 * - A collapsed line is bounded to `ANCHOR_MAX_WORDS` words and
 *   `ANCHOR_MAX_CHARS` code points, whichever cuts first. A cut quote ends
 *   with `ANCHOR_CUT_MARK`. The character bound counts code points, never
 *   UTF-16 units, so a CJK character or an emoji is never split.
 * - The quote is wrapped in ASCII double quotes. Backslash and double quote
 *   inside it are backslash-escaped; every other character passes through. The
 *   bounds apply before escaping, so an escape sequence is never cut in half.
 *
 * Degenerate units never throw on the production path. A unit with no line
 * that carries content anchors to `ANCHOR_EMPTY_UNIT`; a unit whose first and
 * last content lines are the same gets one mention, not two. Both forms and
 * the input cases are exported as data (`ANCHOR_EMPTY_UNIT`,
 * `ANCHOR_DEGENERATE_CASES`) so tests pin them instead of pinning whatever the
 * implementation happens to print.
 *
 * Pure: same text, same bytes, no I/O.
 */

/** The two arms a judge message can be composed in. */
export type AnchorMode = "off" | "on";

/**
 * Longest quoted span, in words. Words are whitespace-delimited runs, the same
 * unit the receipt descriptor cap counts, so the two caps agree.
 */
export const ANCHOR_MAX_WORDS = 12;

/**
 * Longest quoted span, in code points. Code points, not UTF-16 units: a cut
 * between the two halves of a surrogate pair would ship a broken character.
 */
export const ANCHOR_MAX_CHARS = 60;

/** The mark a shortened quote ends with, so a cut is never silent. */
export const ANCHOR_CUT_MARK = "…";

/**
 * The whole anchor line for a unit that has no line carrying content. It states
 * the fact instead of quoting nothing: an empty quote would read as a line that
 * exists but is blank, and the judge would count from it.
 */
export const ANCHOR_EMPTY_UNIT = "The unit is empty.";

/**
 * The degenerate inputs `buildAnchorSuffix` handles without throwing, named as
 * data so tests pin every case. Each name fixes one behaviour:
 *
 * - `empty-unit`: no line carries content; the line is `ANCHOR_EMPTY_UNIT`.
 * - `single-content-line`: the first and last content line are one; it gets
 *   one mention and never an `ends` claim for the same position.
 * - `blank-edge-lines`: leading or trailing blank lines are skipped; the
 *   quoted lines keep their own numbers inside the unit.
 * - `invalid-line-count`: a zero, negative, fractional, non-finite or unsafe
 *   `unitLineCount` is ignored; the text's own count is used.
 */
export const ANCHOR_DEGENERATE_CASES = [
  "empty-unit",
  "single-content-line",
  "blank-edge-lines",
  "invalid-line-count",
] as const;

/** One degenerate input case name. */
export type AnchorDegenerateCase = (typeof ANCHOR_DEGENERATE_CASES)[number];

const QUOTE = '"';
const BACKSLASH_ESCAPE = "\\\\";
const QUOTE_ESCAPE = '\\"';

/**
 * Collapses a line to one space-separated line and trims it. Whitespace runs
 * include CR, LF, U+2028 and U+2029, so a quoted span can never smuggle a line
 * break into the suffix.
 */
function collapseLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Splits the unit the way `util/lines` counts lines from bytes: LF terminates a
 * line, and a final LF starts no additional line. CRLF lines keep their CR
 * here; `collapseLine` turns it into the separating space.
 */
function splitUnitLines(unitText: string): readonly string[] {
  const lines = unitText.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** True for a count that can label a line: a positive safe integer. */
function isLineCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

/**
 * The first and last line that carries content, as zero-based indices, or
 * `null` when the unit has none. Blank edge lines are skipped rather than
 * quoted: a blank quote tells the judge nothing and reads as content.
 */
function contentLineIndices(
  lines: readonly string[],
): { readonly first: number; readonly last: number } | null {
  let first = -1;
  let last = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (collapseLine(lines[index] ?? "").length === 0) continue;
    if (first === -1) first = index;
    last = index;
  }
  return first === -1 ? null : { first, last };
}

/**
 * Bounds one collapsed line: at most `ANCHOR_MAX_WORDS` words and at most
 * `ANCHOR_MAX_CHARS` code points, whichever cuts first, with the cut mark
 * appended when anything was cut.
 *
 * The character cut lands on a code-point boundary first; when the cut text
 * still holds a space it retreats to the last whole word, so a normal line is
 * never cut mid-token. A single token longer than the bound has no whole word
 * to retreat to and is cut at the code-point bound, which is still safe.
 */
function boundContent(collapsed: string): string {
  const words = collapsed.split(" ");
  let cut = words.length > ANCHOR_MAX_WORDS;
  let content = cut ? words.slice(0, ANCHOR_MAX_WORDS).join(" ") : collapsed;
  const points = Array.from(content);
  if (points.length > ANCHOR_MAX_CHARS) {
    content = points.slice(0, ANCHOR_MAX_CHARS).join("");
    cut = true;
    const lastSpace = content.lastIndexOf(" ");
    if (lastSpace > 0) content = content.slice(0, lastSpace);
  }
  return cut ? `${content}${ANCHOR_CUT_MARK}` : content;
}

/**
 * One quoted line, ready to paste into the anchor sentence: collapsed, bounded,
 * escaped, wrapped in ASCII double quotes.
 *
 * Escaping doubles the backslash first and then turns each double quote into
 * `\"`. Doing it in that order means an original `\"` cannot be read as an
 * escaped quote. Bounds are applied before escaping, so an escape sequence is
 * never split and the quoted span can be a few bytes longer than the bound.
 */
function quoteLine(raw: string): string {
  const bounded = boundContent(collapseLine(raw));
  const escaped = bounded
    .replace(/\\/gu, BACKSLASH_ESCAPE)
    .replace(/"/gu, QUOTE_ESCAPE);
  return `${QUOTE}${escaped}${QUOTE}`;
}

/**
 * The anchor line for one unit: a quote of the unit's first and last line that
 * carries content, with their 1-based line numbers.
 *
 * - Both lines when they differ: `Line 1 begins "…". Line 17 ends "…".`
 * - One mention when the first and last content line are the same:
 *   `Line 4 begins "…".` Quoting one line twice would claim two positions.
 * - `ANCHOR_EMPTY_UNIT` when no line carries content.
 *
 * `unitLineCount` is the unit's line count as its owner counts it (LF
 * semantics: a final LF starts no extra line), for callers whose count is
 * authoritative. The end quote is labelled with it only when it is a positive
 * safe integer larger than the text's own count; any other value — absent,
 * zero, negative, fractional, non-finite, too small — is ignored and the text's
 * own last line number is used. A single content line is always quoted as the
 * unit's beginning: one visible line cannot show both ends, so no count can
 * label it as the end without guessing. The quoted content always comes from
 * `unitText`.
 *
 * Never throws and reads nothing but its arguments: same inputs, same bytes,
 * so the anchored arm can be hashed like the tagless one.
 */
export function buildAnchorSuffix(unitText: string, unitLineCount?: number): string {
  const lines = splitUnitLines(unitText);
  const content = contentLineIndices(lines);
  if (content === null) return ANCHOR_EMPTY_UNIT;
  const firstNumber = content.first + 1;
  const claimed = isLineCount(unitLineCount) && unitLineCount > lines.length
    ? unitLineCount
    : 0;
  const lastNumber = claimed > 0 ? claimed : content.last + 1;
  const firstQuote = quoteLine(lines[content.first] ?? "");
  if (content.first === content.last) {
    return `Line ${firstNumber} begins ${firstQuote}.`;
  }
  const lastQuote = quoteLine(lines[content.last] ?? "");
  return `Line ${firstNumber} begins ${firstQuote}. Line ${lastNumber} ends ${lastQuote}.`;
}
