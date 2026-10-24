import { splitLineOffsets } from "../util/lines.js";
import type { ToolResultNode } from "../types/transcript.js";
import type { UnitSegmenter, UnitSpan } from "./types.js";

/**
 * Treats one tool result as one unit. No parsing, no AST: the whole-result
 * granularity is the declared fallback for every content type (PRD §7).
 *
 * The bar comparison is `>=`: a node exactly at the bar yields one unit, and a
 * node below it yields none.
 */
export class WholeResultSegmenter implements UnitSegmenter {
  split(node: ToolResultNode, barBytes: number): readonly UnitSpan[] {
    if (!Number.isSafeInteger(barBytes) || barBytes < 0) return [];
    // An empty body has no removable span: `endByteExclusive > startByte` is
    // what every Removal range must satisfy.
    if (node.bytes.length === 0 || node.bytes.length < barBytes) return [];
    const lines = splitLineOffsets(node.bytes).length;
    return [{
      byteRange: { startByte: 0, endByteExclusive: node.bytes.length },
      lineRange: lines === 0 ? null : { startLine: 1, endLineInclusive: lines },
    }];
  }
}
