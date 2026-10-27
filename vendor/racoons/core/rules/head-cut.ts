import type { ByteRange, Bytes } from "../types/identity.js";
import { complementByteRanges, splitLineOffsets } from "../util/lines.js";

/**
 * Line arithmetic for entry shaping: given a body and the number of leading
 * lines an answer keeps, decide the exact byte boundary and the bytes beyond
 * it. The count is LINES, never bytes (#G3 in the checkpoint design), so no
 * threshold or byte budget reaches this module.
 */

/** The one line-offset enumeration, owned by util/lines.ts; named here for callers. */
export const lineOffsets = splitLineOffsets;

export type HeadCutReason = "keep-lines-below-one";

export class HeadCutError extends Error {
  readonly reason: HeadCutReason;

  constructor(reason: HeadCutReason, message: string) {
    super(message);
    this.name = "HeadCutError";
    this.reason = reason;
  }
}

export interface HeadCut {
  /** Bytes retained, in source order: the whole-line head, or the whole body. */
  readonly kept: readonly ByteRange[];
  /** Byte ranges that leave the body: always the complement of `kept`. */
  readonly dropped: readonly ByteRange[];
  /** End of the retained head; every dropped range starts at or after it. */
  readonly headEndByte: number;
  /** Lines the body holds; a final line without a newline counts. */
  readonly totalLines: number;
  /** Lines actually kept: the request, clamped to `totalLines`. */
  readonly keptLineCount: number;
  /** True when the request covers every line: nothing would be dropped. */
  readonly whole: boolean;
}

/**
 * Keeps bytes `[0, offsets[k-1].endByteExclusive)` — the head ends after the
 * newline of line `k`, never inside a CRLF pair and never inside a UTF-8
 * character, because the boundary is a byte offset measured by `lineOffsets`.
 * `k >= totalLines` keeps the whole body: a prefix that runs past the end is
 * self-limiting, so it is a silent whole keep rather than a refusal.
 */
export function headCut(body: Bytes, keepLines: number): HeadCut {
  if (!Number.isSafeInteger(keepLines) || keepLines < 1) {
    throw new HeadCutError("keep-lines-below-one", `head cut: line count must be a whole number of at least 1, got ${String(keepLines)}`);
  }
  const offsets = lineOffsets(body);
  const totalLines = offsets.length;
  const whole = keepLines >= totalLines;
  let headEndByte = body.byteLength;
  if (!whole) {
    const boundary = offsets[keepLines - 1]?.endByteExclusive;
    if (boundary === undefined) {
      // Unreachable: 1 <= keepLines < totalLines means the index exists.
      throw new Error("head cut: line boundary missing below the line count");
    }
    headEndByte = boundary;
  }
  const kept = headEndByte === 0 ? [] : [{ startByte: 0, endByteExclusive: headEndByte }];
  return {
    kept,
    dropped: complementByteRanges(body.byteLength, kept),
    headEndByte,
    totalLines,
    keptLineCount: whole ? totalLines : keepLines,
    whole,
  };
}
