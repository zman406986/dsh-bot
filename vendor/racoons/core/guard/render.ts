import { negativeFact, receiptLine } from "../rules/assets.js";
import type { Note } from "../rules/types.js";
import type {
  ByteRange, Bytes, EventId, LineRange, NodeId, NoteId, RecallId, RuleId, SessionId, SourceRef,
} from "../types/identity.js";
import type { PathEvidence } from "../types/transcript.js";
import { complement, digest, join } from "./bytes.js";
import type { RenderedRecord, Replacement, RetainedCopy } from "./types.js";

/** The facts a receipt line names; the recall id comes from `makeRecall`. */
export interface ReceiptAssets {
  readonly path: string;
  readonly ranges: readonly LineRange[];
  readonly label: string | null;
  readonly recallId: RecallId;
}
/**
 * A proof burn's receipt assets. There is no `label` member at all: a proven
 * removal has nothing to describe, so no descriptor can reach the line
 * (ADR-0018; PRD §6.6). The type is the guard against one appearing.
 */
export interface ProofReceiptAssets {
  readonly path: string;
  readonly ranges: readonly LineRange[];
  readonly recallId: RecallId;
}
export interface RecordAssets {
  readonly negative: ReadonlyMap<string, {
    readonly target: string;
    readonly entries: readonly PathEvidence[];
  }>;
  readonly receipt: ReadonlyMap<string, ReceiptAssets>;
  /**
   * Proof receipts, keyed by note id. Optional so an assets object that carries
   * no proof notes needs no empty map; a `proof-receipt` note without its assets
   * is a refusal, never a blank line.
   */
  readonly proof?: ReadonlyMap<string, ProofReceiptAssets>;
}
/**
 * The record id a note carries once rendered: derived from the session, event,
 * rule and the note's own id, so one plan renders the same record ids on every
 * run and a note id from another application cannot be replayed.
 */
export function renderedNoteId(
  value: { readonly snapshot: { readonly sessionId: SessionId };
    readonly input: { readonly eventId: EventId } },
  ruleId: RuleId,
  noteId: NoteId,
): NodeId {
  return `racoons:${digest(new TextEncoder().encode(JSON.stringify([
    value.snapshot.sessionId, value.input.eventId, ruleId, noteId,
  ])))}`;
}
/** A body to shape: its authoritative bytes plus the identity they are filed under. */
export interface ShapeSource extends SourceRef {
  readonly bytes: Bytes;
}

export type ShapeRenderReason = "nothing-dropped" | "dropped-bytes-need-marker";

/**
 * Why a shaped render was refused. Both reasons are programmer errors on the
 * entry path: shaping always drops at least one byte and always carries one
 * marker, so a caller that hands either empty is asking for a rewrite that
 * changes nothing (design S17 — the old renderer appended a marker after a
 * full-keep copy; that branch is gone).
 */
export class ShapeRenderError extends Error {
  readonly reason: ShapeRenderReason;

  constructor(reason: ShapeRenderReason, message: string) {
    super(message);
    this.name = "ShapeRenderError";
    this.reason = reason;
  }
}
/** The byte that terminates a marker block. */
const LINE_FEED = 0x0a;

/**
 * Builds the bytes that land at a shaped entry: every kept source range copied
 * in order, with one generated marker block standing in each dropped gap
 * (leading, between, or trailing). Retained ranges are never decoded, so BOM,
 * CRLF and multibyte bytes survive exactly; the output sha256 is computed over
 * the joined result.
 *
 * **Every marker block owns its line.** The shipped templates
 * (`SHAPE_MARKER_TEMPLATE`, `SHAPE_MARKER_EMPTY_TEMPLATE`) end in a newline, so
 * `shapeMarker` hands over a whole line and this function splices it verbatim.
 * A marker spliced in front of a kept range without that terminator glues its
 * `<id>` slot onto the next kept line — the live R-3 defect
 * (`…recall:sha256:7391633c…d2bC:\Users\…`, 9 of 10 shaped turns, ISSUE-063) —
 * and the recall id stops parsing. The invariant is enforced HERE as well as in
 * the template, so a caller that passes a bare line still gets a block on its
 * own line: the terminator is added when, and only when, the marker lacks one.
 */
export function renderShaped(
  source: ShapeSource,
  keepRanges: readonly ByteRange[],
  markerBytes: Bytes,
): Replacement {
  const gaps = complement(keepRanges, source.bytes.length);
  if (gaps.length === 0) {
    throw new ShapeRenderError("nothing-dropped",
      `Shape render of ${source.nodeId} retains every byte; there is nothing to mark`);
  }
  if (markerBytes.length === 0) {
    throw new ShapeRenderError("dropped-bytes-need-marker",
      `Shape render of ${source.nodeId} drops ${gaps.length} gap(s) but carries no marker`);
  }
  const chunks: Bytes[] = [];
  const retainedCopies: RetainedCopy[] = [];
  const generatedRanges: ByteRange[] = [];
  let outputCursor = 0;
  let coveredThrough = 0;
  // One marker block per gap, emitted lazily at the gap itself so the ranges are
  // recorded in the order they appear in the output. A block is exactly one
  // marker LINE: a marker that shared a line with the kept bytes after it would
  // put the recall id into that line's text (ISSUE-063). The shipped templates
  // already end in a newline; a bare line from any other caller gets one here, so
  // this renderer cannot emit a glued marker whatever it is handed.
  const terminated = (): Bytes => {
    if (markerBytes[markerBytes.length - 1] === LINE_FEED) return markerBytes.slice();
    const block = new Uint8Array(markerBytes.length + 1);
    block.set(markerBytes, 0);
    block[markerBytes.length] = LINE_FEED;
    return block;
  };
  const markerBlock = terminated();
  const emitMarker = (): void => {
    const copy = markerBlock.slice();
    generatedRanges.push({ startByte: outputCursor, endByteExclusive: outputCursor + copy.length });
    chunks.push(copy);
    outputCursor += copy.length;
  };
  for (const keep of keepRanges) {
    if (keep.startByte > coveredThrough) emitMarker();
    const kept = source.bytes.slice(keep.startByte, keep.endByteExclusive);
    chunks.push(kept);
    retainedCopies.push({
      sourceRange: { startByte: keep.startByte, endByteExclusive: keep.endByteExclusive },
      outputRange: { startByte: outputCursor, endByteExclusive: outputCursor + kept.length },
    });
    outputCursor += kept.length;
    coveredThrough = keep.endByteExclusive;
  }
  if (coveredThrough < source.bytes.length) emitMarker();
  const bytes = join(chunks);
  return {
    source: { nodeId: source.nodeId, sha256: source.sha256, byteLength: source.byteLength },
    bytes,
    sha256: digest(bytes),
    retainedCopies,
    generatedRanges,
    evidenceRecallId: null,
  };
}
/**
 * The cap marker's replacement renderer left the product with the entry-time
 * cap (ADR-0014, 2026-10-23): no in-place rewrite exists any more, so a
 * `cap-marker` note has no render path. The entry checkpoint revives the
 * splice as `renderShaped` above, under the `shape` operation, not `cap`.
 */
export function renderRecords(notes: readonly Note[], assets: RecordAssets): RenderedRecord[] {
  return notes.map(note => {
    let text: string;
    if (note.kind === "negative-fact") {
      const data = assets.negative.get(note.id);
      if (data === undefined) throw new Error(`Missing episode assets for ${note.id}`);
      text = negativeFact(data);
    } else if (note.kind === "receipt") {
      const data = assets.receipt.get(note.id);
      if (data === undefined) throw new Error(`Missing receipt assets for ${note.id}`);
      // The note's own fields are the plan's; the assets carry the archive id.
      // They must agree, or a receipt would name a different label than planned.
      if (data.path !== note.path || data.label !== note.label
        || !sameLineRanges(data.ranges, note.ranges)) {
        throw new Error(`Receipt assets disagree with note ${note.id}`);
      }
      text = receiptLine(data);
    } else if (note.kind === "proof-receipt") {
      // A proof burn's receipt line names path, ranges and recall id and nothing
      // else: there is no descriptor slot to fill (ADR-0018; PRD §6.6).
      const data = assets.proof?.get(note.id);
      if (data === undefined) throw new Error(`Missing proof receipt assets for ${note.id}`);
      if (data.path !== note.path || !sameLineRanges(data.ranges, note.ranges)) {
        throw new Error(`Proof receipt assets disagree with note ${note.id}`);
      }
      text = receiptLine({ path: data.path, ranges: data.ranges, label: null,
        recallId: data.recallId });
    } else throw new Error(`Unsupported record kind: ${note.kind}`);
    const bytes = new TextEncoder().encode(text);
    return { recordId: note.id, bytes, sha256: digest(bytes) };
  });
}
function sameLineRanges(a: readonly LineRange[], b: readonly LineRange[]): boolean {
  return a.length === b.length && a.every((range, i) => range.startLine === b[i]?.startLine
    && range.endLineInclusive === b[i]?.endLineInclusive);
}
