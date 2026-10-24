import type {
  ByteRange,
  LineRange,
  NodeId,
  SourceRef,
  UnitId,
} from "../types/identity.js";
import type { ToolResultNode } from "../types/transcript.js";

/** The byte span a unit covers and its line form when the content is line-addressable. */
export interface UnitSpan {
  readonly byteRange: ByteRange;
  readonly lineRange: LineRange | null;
}

/**
 * Splits one tool result into processing units. Implementations are pure: the
 * same node and bar always yield the same spans, in transcript byte order.
 */
export interface UnitSegmenter {
  split(node: ToolResultNode, barBytes: number): readonly UnitSpan[];
}

/**
 * The unit of judgment, removal and recall (PRD §6.2). It carries identity and
 * location only; the bytes stay in the transcript node the `source` names.
 */
export interface ProcessingUnit {
  readonly id: UnitId;
  readonly nodeId: NodeId;
  /** Exact node hash and byte length, ready for `Removal.sources` unchanged. */
  readonly source: SourceRef;
  /** First hit path of the node evidence; null when the harness named no path. */
  readonly path: string | null;
  readonly span: UnitSpan;
  readonly byteLength: number;
}
