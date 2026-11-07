/**
 * Line anchors: the deterministic numbering aid the landed-then-ask checkpoint
 * and the bulk prune both carry (ISSUE-058 chunk AN-2; ADR-0022 §5–§8). The
 * mechanics are the binding design at `docs/plans/2026-10-26-anchor/design.md`;
 * this module implements that file and decides nothing new.
 *
 * One anchor names a line's 1-based number, optionally out of the result's total
 * `N`, and closes with the tail of that line's content:
 *
 *     line 67 of 201 ends with "148 rows to /var/log/app/ingest.jsonl"
 *     line 67 ends with "148 rows to /var/log/app/ingest.jsonl"
 *
 * The prune lane uses the first form, one unit per row, so each row states its
 * own total. The entry ask uses the second: it states `N` once, in the sentence
 * that introduces the quotes.
 *
 * A blank band of two or more lines is stated plainly instead of quoting a
 * far-away line:
 *
 *     lines 64–67 are blank
 *
 * The tail and not the start, because tool output repeats path prefixes and
 * timestamps on nearly every line; only the end distinguishes one line from its
 * neighbours. Because the anchor is a pure function of the bytes, a replay
 * reproduces the same text with no seed to record.
 *
 * Three functions, one rule each:
 *
 * - `quoteLineTail` is the ONE quoting routine: trim the tail, take the last
 *   whole words under the caps, and answer `""` when nothing quotable is left.
 * - `anchorsAt` is the ONE fallback-and-render core: one anchor per 1-based
 *   position a seam supplies, with the band notice, the nearest earlier
 *   quotable line, and omission.
 * - `anchorsFor` is the entry seam: `anchorsAt` at the evenly spaced positions
 *   `entryPositions` derives from `N` alone.
 *
 * Pure and total on transcript data: same lines give the same anchors; no I/O,
 * clock, randomness or environment; blank bodies and odd lines return values,
 * never throw. A non-array argument is a caller bug.
 */

/** Longest quoted span, in words: the last up to six whole words. */
export const ANCHOR_QUOTE_MAX_WORDS = 6;

/** Longest quoted span, in code points; leading words are dropped until it holds. */
export const ANCHOR_QUOTE_MAX_CODE_POINTS = 40;

/** A line with no whitespace quotes its last this many code points. */
export const ANCHOR_NO_SPACE_TAIL_CODE_POINTS = 30;

/** Shorter than this, a quote identifies nothing, so no quote ships. */
export const ANCHOR_QUOTE_MIN_CODE_POINTS = 3;

/** One entry anchor per this many lines: `k = floor(N / 100)`. */
export const ANCHOR_LINES_PER_ANCHOR = 100;

const SPACE = /\s/u;

/**
 * The ONE whitespace set, serving trimming, word splitting and the blank test,
 * so the three can never disagree: every code point `/\s/u` matches, plus every
 * C0 and C1 control code point, nothing else.
 */
function isAnchorWhitespace(codePoint: number): boolean {
  if (codePoint <= 0x1f) return true;
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true;
  return SPACE.test(String.fromCodePoint(codePoint));
}

/** True when every code point of the line is whitespace, including empty. */
function isBlankLine(line: string): boolean {
  for (const point of line) {
    if (!isAnchorWhitespace(point.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/** R1: drop every trailing whitespace code point; a CRLF line loses its CR here. */
function trimTail(line: string): string {
  let end = line.length;
  while (end > 0) {
    const unit = line.charCodeAt(end - 1);
    // Every whitespace code point is BMP and below the surrogate range, so a
    // surrogate tail belongs to a non-whitespace code point and stops the trim.
    if (unit >= 0xd800 && unit <= 0xdfff) break;
    if (!isAnchorWhitespace(unit)) break;
    end -= 1;
  }
  return end === line.length ? line : line.slice(0, end);
}

/** R2: maximal runs of non-whitespace code points, in order. */
function splitWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const point of line) {
    if (isAnchorWhitespace(point.codePointAt(0) ?? 0)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
    } else {
      current += point;
    }
  }
  if (current.length > 0) words.push(current);
  return words;
}

/** Length in code points, never UTF-16 units, so a surrogate pair counts once. */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * The code-point-safe tail: the last `count` code points, or the whole value
 * when it is not longer. `Array.from` walks code points, so a CJK character and
 * an emoji each count once and a surrogate pair is never split.
 */
export function tailCodePoints(value: string, count: number): string {
  if (!Number.isSafeInteger(count) || count <= 0) return "";
  const points = Array.from(value);
  return points.length <= count ? value : points.slice(-count).join("");
}

/** R4: a quote under three code points identifies nothing. */
function quotable(quote: string): string {
  return codePointLength(quote) < ANCHOR_QUOTE_MIN_CODE_POINTS ? "" : quote;
}

/**
 * The tail of one line, ready to paste inside an anchor's double quotes.
 * `""` means "nothing quotable on this line".
 *
 * R1 trims trailing whitespace; R2 takes the last up to six whole words joined
 * by one ASCII space and drops leading words while the quote exceeds forty code
 * points, never dropping the last word; R3 answers a line that is one unbroken
 * word with its last thirty code points; R4 refuses a quote under three code
 * points. An inner `"` stays verbatim — the quote is never escaped.
 */
export function quoteLineTail(line: string): string {
  const trimmed = trimTail(line);
  if (trimmed.length === 0) return "";
  const words = splitWords(trimmed);
  const last = words[words.length - 1];
  if (last === undefined) return "";
  if (words.length === 1) {
    return quotable(tailCodePoints(last, ANCHOR_NO_SPACE_TAIL_CODE_POINTS));
  }

  let first = Math.max(0, words.length - ANCHOR_QUOTE_MAX_WORDS);
  let quote = words.slice(first).join(" ");
  while (first < words.length - 1 && codePointLength(quote) > ANCHOR_QUOTE_MAX_CODE_POINTS) {
    first += 1;
    quote = words.slice(first).join(" ");
  }
  if (first === words.length - 1 && codePointLength(quote) > ANCHOR_QUOTE_MAX_CODE_POINTS) {
    quote = tailCodePoints(quote, ANCHOR_NO_SPACE_TAIL_CODE_POINTS);
  }
  return quotable(quote);
}

/**
 * The entry seam's positions from `N` alone (ADR-0022 §5): `k = floor(N/100)`;
 * `k = 0` yields none; otherwise `m = floor(N/(k+1))` and the positions are
 * `m, 2m, …, k·m`. For every `N ≥ 100` the interval is at least 50, so the
 * positions are distinct and inside `1…N`.
 */
export function entryPositions(lineCount: number): number[] {
  if (!Number.isSafeInteger(lineCount) || lineCount < ANCHOR_LINES_PER_ANCHOR) return [];
  const count = Math.floor(lineCount / ANCHOR_LINES_PER_ANCHOR);
  const interval = Math.floor(lineCount / (count + 1));
  const positions: number[] = [];
  for (let step = 1; step <= count; step += 1) positions.push(step * interval);
  return positions;
}

/** F1: one blank band, stated plainly with its first and last line numbers. */
export function blankBandNotice(firstLine: number, lastLine: number): string {
  return `lines ${String(firstLine)}–${String(lastLine)} are blank`;
}

/**
 * Whether a content anchor states the total (`line 67 of 201 ends with …`).
 * The prune lane reads one unit per row, so it keeps the total on every anchor.
 * The entry ask states the total once in its range sentence and drops it here,
 * so the same line never says it twice.
 */
export interface AnchorRenderOptions {
  /** Append ` of N` to each content anchor. Default `true`. */
  readonly withTotal?: boolean;
}

/**
 * One anchor line: `line L of N ends with "<quote>"`, or `line L ends with
 * "<quote>"` when the seam states the total itself. ASCII, no trailing
 * punctuation.
 */
function renderAnchor(
  lineNumber: number,
  lineCount: number,
  quote: string,
  withTotal: boolean,
): string {
  return withTotal
    ? `line ${String(lineNumber)} of ${String(lineCount)} ends with "${quote}"`
    : `line ${String(lineNumber)} ends with "${quote}"`;
}

/** One quote per line index, computed at most once per `anchorsAt` call. */
function createQuoteCache(lines: readonly string[]): (index: number) => string {
  const quotes: string[] = [];
  return (index: number): string => {
    const cached = quotes[index];
    if (cached !== undefined) return cached;
    const quote = quoteLineTail(lines[index] ?? "");
    quotes[index] = quote;
    return quote;
  };
}

/**
 * F2's search, amortized: index of the nearest quotable line before a 0-based
 * `before` index, or -1. The table fills forward on demand, so all fallbacks of
 * one call cost one pass over the lines they reach, never one pass each.
 */
function createQuotableLookup(total: number, quoteAt: (index: number) => string): (before: number) => number {
  const nearest: number[] = [];
  let lastQuotable = -1;
  let filled = 0;
  return (before: number): number => {
    const target = Math.min(before, total) - 1;
    if (target < 0) return -1;
    while (filled <= target) {
      if (quoteAt(filled).length > 0) lastQuotable = filled;
      nearest[filled] = lastQuotable;
      filled += 1;
    }
    return nearest[target] ?? -1;
  };
}

/**
 * The maximal blank run containing every index, as 0-based first/last arrays.
 *
 * ISSUE-221: this is the whole bound. The table is built in ONE pass over the
 * blank flags (O(N) time, O(N) space) no matter how many candidate positions
 * `anchorsAt` is given; a candidate never rescans its band. The previous
 * per-candidate `blankRunAround` walked the same contiguous band once for each
 * generated position, which was `floor(N / 100) * (N - 1)` loop bodies for a
 * fully blank body. No fixed cap is added: a cap would silently drop a band
 * notice, and the single pass already bounds one contiguous band.
 */
function blankRuns(blank: readonly boolean[]): {
  readonly first: readonly number[]; readonly last: readonly number[];
} {
  const first = new Array<number>(blank.length);
  const last = new Array<number>(blank.length);
  let start = 0;
  while (start < blank.length) {
    if (blank[start] !== true) {
      first[start] = start;
      last[start] = start;
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < blank.length && blank[end + 1] === true) end += 1;
    for (let index = start; index <= end; index += 1) {
      first[index] = start;
      last[index] = end;
    }
    start = end + 1;
  }
  return { first, last };
}

/**
 * One rendered anchor per 1-based position, in the given order, with the
 * fallbacks applied in F1–F4 order:
 *
 * - F1: a blank line inside a run of two or more blank lines yields the band
 *   notice for the whole run, whatever the position.
 * - F2: a lone blank line, or a content line whose quote is `""`, moves to the
 *   nearest earlier line that is content and quotable, showing THAT line's
 *   number, still out of `N`.
 * - F3: no earlier quotable line omits the anchor; nothing is fabricated.
 * - F4: one band ships one notice, at its first position; later positions in
 *   that band are omitted. Quotes are never de-duplicated — two positions that
 *   resolve to the same line both print.
 *
 * `options.withTotal = false` drops the ` of N` clause from content anchors (the
 * entry ask states `N` once in its range sentence); band notices carry no total
 * either way. Default `true`.
 *
 * A position that is not a safe integer inside `1…N` is ignored, so a seam's
 * clamping bug cannot invent a line. Never throws on transcript data.
 */
export function anchorsAt(
  lines: readonly string[],
  positions: readonly number[],
  options: AnchorRenderOptions = {},
): string[] {
  const withTotal = options.withTotal ?? true;
  const total = lines.length;
  const anchors: string[] = [];
  const noticedBands = new Set<string>();
  const blank = lines.map((line) => isBlankLine(line));
  const runs = blankRuns(blank);
  const quoteAt = createQuoteCache(lines);
  const earlierQuotable = createQuotableLookup(total, quoteAt);

  const fallback = (position: number): string | null => {
    const index = earlierQuotable(position - 1);
    if (index < 0) return null;
    return renderAnchor(index + 1, total, quoteAt(index), withTotal);
  };

  for (const position of positions) {
    if (!Number.isSafeInteger(position) || position < 1 || position > total) continue;
    const index = position - 1;
    if (blank[index] === true) {
      // One lookup into the precomputed run table, never a band walk.
      const band = { first: runs.first[index] ?? index, last: runs.last[index] ?? index };
      if (band.last - band.first + 1 >= 2) {
        const key = `${String(band.first)}:${String(band.last)}`;
        if (noticedBands.has(key)) continue;
        noticedBands.add(key);
        anchors.push(blankBandNotice(band.first + 1, band.last + 1));
      } else {
        const anchor = fallback(position);
        if (anchor !== null) anchors.push(anchor);
      }
      continue;
    }
    const quote = quoteAt(index);
    if (quote.length > 0) {
      anchors.push(renderAnchor(position, total, quote, withTotal));
      continue;
    }
    const anchor = fallback(position);
    if (anchor !== null) anchors.push(anchor);
  }
  return anchors;
}

/**
 * The entry ask's anchors: `anchorsAt(lines, entryPositions(lines.length))`.
 * `N < 100` has no anchor, and `N` alone is then the whole numbering aid. The
 * entry ask states `N` once in its range sentence, so its content anchors drop
 * the ` of N` clause and read `line 67 ends with "..."`.
 */
export function anchorsFor(lines: readonly string[]): string[] {
  return anchorsAt(lines, entryPositions(lines.length), { withTotal: false });
}
