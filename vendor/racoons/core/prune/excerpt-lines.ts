import { fromBytes, toBytes } from "../util/bytes.js";
import { splitLineOffsets } from "../util/lines.js";
import { isPruneWrapperLine } from "./wrapper.js";

/**
 * The line machinery behind the big prune's excerpts (ISSUE-022 §Unit
 * addressing; ADR-0009). `./excerpt.ts` owns the public call and the four
 * numbers; this module owns how one sample is taken once they are known.
 *
 * Taking one sample:
 *
 * 1. Resolve the position to a byte offset, then to the line holding that byte;
 *    an offset on a terminator belongs to the line it terminates.
 * 2. Walk forward to the first content line, falling back to the nearest
 *    content line before the position when nothing content follows.
 * 3. Grow by whole lines. A line is taken while the sample stays inside its
 *    byte share **or** inside its word cap — the owner's `max(2% of the result,
 *    40 words)`: the allowance that permits more is the one that decides. A
 *    small unit is therefore bounded by its 40 words and a large one by its
 *    2%; a test exists for each regime.
 * 4. One exception, and only one: a line with no whitespace is a single
 *    unbroken token, and a word cap cannot shorten one word. Such a line is
 *    held to the byte share instead of being quoted whole, which is what stops
 *    a minified JSON line from passing as "one word".
 * 5. A first line that fits neither cap is cut inside it at a word boundary; a
 *    later line that fits neither ends the sample.
 * 6. Trailing wrapper lines are dropped, so the sample ends on content.
 *
 * A cut lands on a whole word wherever a word boundary exists. A token with no
 * whitespace has none, so it is cut on a code-point boundary — never inside a
 * UTF-8 character, which is what keeps CJK and emoji intact.
 *
 * Byte counts come from the unit's own span, so a line's size is exact. A line
 * that will not decode as UTF-8 (a span edge inside a character) makes the
 * sample unreadable rather than shipping replacement characters; the caller
 * turns that into a refused anchor.
 */

/** The mark a shortened sample ends with, owned here because cuts happen here. */
export const PRUNE_EXCERPT_CUT_MARK = "…";

/**
 * The byte share's floor, one short line's worth. A unit of a few hundred bytes
 * has a 2% share too small to hold a single word, so without the floor an
 * arithmetic artifact — not the owner's rule — would chop it. The floor never
 * widens a large unit's excerpt: there the share is far above it.
 */
export const PRUNE_EXCERPT_MIN_SHARE_BYTES = 40;

/**
 * The unit's lines, ready for sampling, or `null` when a line will not decode
 * as UTF-8. A terminator stays in the byte bounds and out of the text; the CR
 * of a CRLF goes with it.
 */
export interface UnitLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function readUnitLines(content: Uint8Array): readonly UnitLine[] | null {
  const lines: UnitLine[] = [];
  for (const { startByte, endByteExclusive } of splitLineOffsets(content)) {
    let textEnd = endByteExclusive;
    if (textEnd > startByte && content[textEnd - 1] === 0x0a) textEnd -= 1;
    if (textEnd > startByte && content[textEnd - 1] === 0x0d) textEnd -= 1;
    try {
      lines.push({
        text: fromBytes(content.subarray(startByte, textEnd)),
        start: startByte,
        end: endByteExclusive,
      });
    } catch {
      return null;
    }
  }
  return lines;
}

/** The byte share the caps apply, floored so a word always has room. */
export function shareBytesOf(contentBytes: number, maxShare: number): number {
  return Math.max(PRUNE_EXCERPT_MIN_SHARE_BYTES, Math.floor(maxShare * contentBytes));
}

/**
 * One sample of the lines: the content block holding `position` of the unit's
 * bytes, bounded by the share or the word cap. `""` when no line carries
 * content.
 */
export function sampleLines(
  lines: readonly UnitLine[],
  position: number,
  share: number,
  maxWords: number,
): string {
  const last = lines[lines.length - 1];
  if (last === undefined) return "";
  const offset = Math.min(Math.floor(position * last.end), last.end - 1);
  const start = contentIndexAt(lines, lineIndexAt(lines, Math.max(offset, 0)));
  if (start === -1) return "";

  const accepted: string[] = [];
  let bytes = 0;
  let words = 0;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    const nextBytes = bytes + (accepted.length === 0 ? 0 : 1) + toBytes(line.text).byteLength;
    const nextWords = words + countWords(line.text);
    if (fitsLine(line.text, nextBytes, nextWords, share, maxWords)) {
      accepted.push(line.text);
      bytes = nextBytes;
      words = nextWords;
      continue;
    }
    // Nothing taken yet: this single line alone is over both caps.
    if (accepted.length === 0) return cutInside(line.text, share, maxWords);
    break;
  }
  while (accepted.length > 1 && isPruneWrapperLine(accepted[accepted.length - 1] ?? "")) {
    accepted.pop();
  }
  return accepted.join("\n");
}

/**
 * Inside the byte share **or** inside the word cap: `max(2%, 40 words)`, so the
 * allowance that permits more decides. The word branch never covers an unbroken
 * token — a word cap cannot shorten one word — so such a line is held to the
 * share instead of being quoted whole.
 */
function fitsLine(
  text: string,
  bytes: number,
  words: number,
  share: number,
  maxWords: number,
): boolean {
  if (bytes <= share) return true;
  if (words > maxWords) return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && /\s/u.test(trimmed);
}

/** The index of the line holding a byte offset; an offset on a terminator stays on its line. */
function lineIndexAt(lines: readonly UnitLine[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const line = lines[middle];
    if (line !== undefined && line.start <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** First content line at or after `from`; failing that, the last one before it. */
function contentIndexAt(lines: readonly UnitLine[], from: number): number {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && !isPruneWrapperLine(line.text)) return index;
  }
  for (let index = Math.min(from, lines.length) - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && !isPruneWrapperLine(line.text)) return index;
  }
  return -1;
}

/** Words are whitespace-delimited runs, the unit the receipt caps count too. */
function countWords(text: string): number {
  return (text.match(/\S+/gu) ?? []).length;
}

/**
 * A single line over both caps. With whitespace it is cut at a word boundary:
 * the longer of its first `maxWords` words and its word-boundary prefix inside
 * the byte share. A line with no whitespace is one unbroken token, and a word
 * cap cannot shorten one word, so only the share's prefix applies — cut on a
 * code-point boundary, the one cut that never splits a character.
 */
function cutInside(line: string, share: number, maxWords: number): string {
  const shareCut = retreatToWordBoundary(cutAtByteBudget(line, share)).replace(/\s+$/u, "");
  const unbroken = !/\s/u.test(line.trim());
  const chosen = unbroken
    ? shareCut
    : longerOf(shareCut, prefixByWords(line, maxWords).replace(/\s+$/u, ""));
  return `${chosen}${PRUNE_EXCERPT_CUT_MARK}`;
}

/** The longer of two candidates by UTF-8 bytes; the first wins a tie. */
function longerOf(left: string, right: string): string {
  return toBytes(right).byteLength > toBytes(left).byteLength ? right : left;
}

/** The first `maxWords` words, ending on the last one's final character. */
function prefixByWords(line: string, maxWords: number): string {
  let words = 0;
  let end = 0;
  for (const match of line.matchAll(/\S+/gu)) {
    words += 1;
    end = (match.index ?? 0) + match[0].length;
    if (words >= maxWords) break;
  }
  return line.slice(0, end);
}

/** The longest prefix of `text` inside a UTF-8 byte budget, on a character boundary. */
function cutAtByteBudget(text: string, byteBudget: number): string {
  let bytes = 0;
  let end = 0;
  for (const point of text) {
    const size = utf8Size(point.codePointAt(0) ?? 0);
    if (bytes + size > byteBudget) break;
    bytes += size;
    end += point.length;
  }
  return text.slice(0, end);
}

function utf8Size(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Cuts a prefix back to its last whole word; the untouched prefix when it holds
 * no whitespace, so a single long token keeps its code-point-safe cut.
 */
function retreatToWordBoundary(prefix: string): string {
  let end = prefix.length;
  while (end > 0 && !isSpaceAt(prefix, end - 1)) end -= 1;
  if (end === 0) return prefix;
  while (end > 0 && isSpaceAt(prefix, end - 1)) end -= 1;
  return end === 0 ? prefix : prefix.slice(0, end);
}

function isSpaceAt(text: string, index: number): boolean {
  const unit = text[index];
  return unit !== undefined && /\s/u.test(unit);
}
