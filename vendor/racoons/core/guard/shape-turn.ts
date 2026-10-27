import { shapeMarker } from "../rules/assets.js";
import type { ByteRange, Bytes, LineRange, RecallId, SourceRef } from "../types/identity.js";
import { splitLineOffsets } from "../util/lines.js";
import { complement, digest, equal, length } from "./bytes.js";
import { recallManifestFor, recallManifestParts } from "./recall.js";
import { renderShaped } from "./render.js";

/**
 * The one composition of a shaped entry turn (ISSUE-058 chunk P3b; ADR-0022
 * §12–§13).
 *
 * Under the corrected protocol a forget does NOT edit the landed result. It
 * rewinds the surface past that result's turn and appends ONE new turn carrying
 * the kept partial lines with one marker standing in each dropped gap, plus the
 * answer's own summary. This module is that turn's bytes, and its one job is
 * that the planner, the candidate builder and the guard all read ONE
 * implementation: the plan states the bytes, the builder lands them, and the
 * guard re-renders them to prove the claim.
 *
 * The archived recall id is derived here too, from the ORIGINAL body and the
 * dropped ranges, by the same `recallManifestFor` the guard's `makeRecall`
 * mints an archive under. A caller therefore gets the id the marker names and
 * the id the archive will carry as one value, and they cannot drift.
 */
export interface ShapeTurnInput {
  /** The landed result's own identity; its bytes are `original`, never the shaped ones. */
  readonly source: SourceRef;
  readonly original: Bytes;
  /** Whole-line byte ranges of `original`, in source order, merged and non-empty. */
  readonly keptRanges: readonly ByteRange[];
  readonly sessionId: string;
}

export interface ShapeTurn {
  /** The new turn's whole body: kept partials with one marker in each gap. */
  readonly bytes: Bytes;
  readonly sha256: string;
  /** Retained copies, as the candidate's replacement arithmetic reads them. */
  readonly retainedCopies: readonly {
    readonly sourceRange: ByteRange;
    readonly outputRange: ByteRange;
  }[];
  /** One range per dropped gap, in output order. */
  readonly generatedRanges: readonly ByteRange[];
  /** The dropped gaps of the original, in source order. */
  readonly gaps: readonly ByteRange[];
  /** The kept ranges as the marker's line numbers. */
  readonly keptLines: readonly LineRange[];
  /** The landed result's total line count, as the marker states it. */
  readonly totalLines: number;
  /** The dropped byte count, as the marker states it. */
  readonly droppedBytes: number;
  readonly recallId: RecallId;
  /** The marker line itself, exactly as it appears in `bytes`. */
  readonly marker: string;
}

/**
 * The new turn for one kept selection, or `null` when nothing was dropped.
 *
 * A full keep has no gap for a marker and no turn to append; the answer for that
 * case is `keepall`, which plans nothing at all (ADR-0022 §9, §11). A range that
 * is not a whole-line span of `original` also yields `null`: the caller refuses,
 * never renders a line the answer did not name.
 */
export function renderShapeTurn(input: ShapeTurnInput): ShapeTurn | null {
  const offsets = splitLineOffsets(input.original);
  const keptLines: LineRange[] = [];
  for (const range of input.keptRanges) {
    const first = offsets.findIndex(line => line.startByte === range.startByte);
    const last = offsets.findIndex(line => line.endByteExclusive === range.endByteExclusive);
    if (first < 0 || last < first) return null;
    keptLines.push({ startLine: first + 1, endLineInclusive: last + 1 });
  }
  const gaps = complement(input.keptRanges, input.original.length);
  if (gaps.length === 0) return null;
  const droppedBytes = gaps.reduce((sum, range) => sum + length(range), 0);
  const { id } = recallManifestFor(input.sessionId, recallManifestParts([{
    source: { ...input.source },
    bytes: input.original.slice(),
    removedRanges: gaps.map(range => ({ range: { ...range },
      sha256: digest(input.original.slice(range.startByte, range.endByteExclusive)) })),
  }]));
  const marker = shapeMarker({ keptLines, totalLines: offsets.length, droppedBytes, recallId: id });
  const rendered = renderShaped({ ...input.source, bytes: input.original },
    input.keptRanges, new TextEncoder().encode(marker));
  return { bytes: rendered.bytes, sha256: rendered.sha256,
    retainedCopies: rendered.retainedCopies, generatedRanges: rendered.generatedRanges,
    gaps, keptLines, totalLines: offsets.length, droppedBytes, recallId: id, marker };
}

/** True when a plan's stated turn bytes are exactly the ones this module renders. */
export function shapeTurnMatches(turn: ShapeTurn, stated: Bytes): boolean {
  return equal(turn.bytes, stated);
}