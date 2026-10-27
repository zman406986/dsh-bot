import { fromBytes } from "../util/bytes.js";
import { splitLineOffsets } from "../util/lines.js";
import type { ByteRange } from "../types/identity.js";
import { anchorsAt } from "../rules/anchors.js";

/**
 * The bulk prune's anchor placement (ISSUE-022's row anchor, re-based on
 * ADR-0022 §7 and the anchor design's §8): the SAME anchor format the entry ask
 * carries, placed at the unit's own byte shares instead of the entry seam's
 * line spacing.
 *
 * The format, the quoting and every fallback come from `../rules/anchors.js`.
 * `anchorsAt` renders one anchor per 1-based line number this module supplies,
 * so there is one quoting routine and one set of fallbacks for both seams,
 * never a second copy here:
 *
 *     line 60 of 201 ends with "retries: 3, timeoutMs: 30000"
 *     lines 64–67 are blank
 *
 * **The one arithmetic difference is placement.** The entry seam spaces
 * `floor(N/100)` anchors evenly over the line count; this seam places exactly
 * two, at the lines holding ADR-0009's shipped 30th and 70th percentiles of the
 * unit's BYTE length:
 *
 *     offset = floor(share × byteLength), clamped to byteLength − 1
 *     line   = the line holding that byte, 1-based (an offset on a terminator
 *              belongs to the line it terminates), so inside 1…N
 *
 * `N` is the unit's own line count by byte arithmetic (`splitLineOffsets`), so
 * it holds even when the text will not decode. Both shares resolving to one
 * line (`N = 1`, `N = 2`) collapse to a single anchor. The shares are the swept
 * numbers, defaulted and exported, so a later sweep varies them here and no
 * caller changes.
 *
 * Pure and deterministic: same bytes and shares, same anchors; no I/O, clock,
 * randomness or environment, and nothing is mutated. Bytes that will not decode
 * as UTF-8 yield the `undecodable-unit` refusal rather than replacement
 * characters inside a quote. An invalid share throws `RangeError`, because that
 * is a caller bug, not transcript data.
 */

/** Default placement of the first anchor, as a share of the unit's byte length. */
export const PRUNE_ANCHOR_POSITION_A = 0.3;

/** Default placement of the second anchor, as a share of the unit's byte length. */
export const PRUNE_ANCHOR_POSITION_B = 0.7;

/** One unit's rendered anchors, or the reason its bytes were not decoded. */
export type PruneAnchorSet =
  | { readonly anchors: readonly string[] }
  | { readonly refusal: "undecodable-unit" };

/** The swept shares. Optional; each default is the exported constant above. */
export interface PruneAnchorShareOptions {
  /** Byte share of the first anchor. */
  readonly positionA?: number;
  /** Byte share of the second anchor. */
  readonly positionB?: number;
}

/**
 * The unit's two anchor lines, 1-based, in share order and de-duplicated.
 * `[]` only when the unit has no lines at all; a unit whose shares resolve to
 * one line answers one number.
 */
export function pruneAnchorPositions(
  content: Uint8Array,
  options: PruneAnchorShareOptions = {},
): number[] {
  const positionA = fraction(options.positionA, PRUNE_ANCHOR_POSITION_A, "positionA");
  const positionB = fraction(options.positionB, PRUNE_ANCHOR_POSITION_B, "positionB");
  const offsets = splitLineOffsets(content);
  if (offsets.length === 0) return [];
  const lastByte = content.byteLength - 1;
  const lineAt = (share: number): number =>
    lineHoldingByte(offsets, Math.min(Math.floor(share * content.byteLength), lastByte));
  return [...new Set([lineAt(positionA), lineAt(positionB)])];
}

/**
 * One unit's anchors: the placement above, then the shared renderer with its
 * fallbacks. An undecodable body refuses, because a quote needs the decoded
 * text and replacement characters would misreport the line.
 */
export function buildPruneAnchors(
  content: Uint8Array,
  options: PruneAnchorShareOptions = {},
): PruneAnchorSet {
  const positions = pruneAnchorPositions(content, options);
  if (positions.length === 0) return { anchors: [] };
  let text: string;
  try {
    text = fromBytes(content);
  } catch {
    return { refusal: "undecodable-unit" };
  }
  return { anchors: anchorsAt(linesOf(text), positions) };
}

/**
 * The line holding a byte offset, as a 1-based line number. An offset on a
 * terminator stays on the line it terminates, because a line's range includes
 * its LF and the next line starts after it. The offset is already clamped into
 * the content, so this answer is inside `1…offsets.length`.
 */
function lineHoldingByte(offsets: readonly ByteRange[], offset: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const line = offsets[middle];
    if (line !== undefined && line.startByte <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** The decoded body split on LF; a trailing terminator adds no empty line. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

/** A finite share in [0, 1]; anything else is a caller bug, not transcript data. */
function fraction(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number in [0, 1].`);
  }
  return value;
}
