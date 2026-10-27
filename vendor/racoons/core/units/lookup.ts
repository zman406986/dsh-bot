import type { ForgetRequest } from "../engine/types.js";
import type { LineRange, SessionId } from "../types/identity.js";
import type { SessionSnapshot, ToolResultNode } from "../types/transcript.js";
import { UnitTracker } from "./tracker.js";
import type { ProcessingUnit } from "./types.js";

/**
 * Resolving a manual forget request to the one unit that holds it (PRD §6.2;
 * ISSUE-045 chunk C1).
 *
 * A request names a source path and line ranges in the transcript's own
 * spellings. Resolution is a lookup, never a guess: a request that no held unit
 * covers, or that more than one held unit covers, is refused with the reason
 * and nothing else. A wrong unit is unrecoverable in the direction that
 * matters — the bytes are gone and the receipt names something the human never
 * asked about.
 *
 * Three choices define what "held" means here:
 *
 * - Only a `hit` path evidence of a non-write result counts. A miss returned an
 *   error, never the file; a write returned a confirmation, never the content.
 *   Forgetting either would resolve the request to bytes the path never had.
 * - Units are built at bar 0. The bar is the size above which a unit must be
 *   judged (PRD §6.2); it decides what must be asked, never whether content the
 *   transcript already holds exists to forget. `unitIdFor` does not read the
 *   bar, so a unit resolved here carries the same id the gates would give it.
 * - Every non-empty tool result yields its unit, so "the agent does not hold
 *   these lines" means exactly "no result of that path covers them".
 *
 * Line numbers are 1-based within the result as the transcript holds it, exactly
 * as a `keeplines` verdict reads its spans. Nothing here can recover a read
 * offset the harness never recorded, so no attempt is made to reinterpret them.
 */
export type ForgetResolution =
  | {
      readonly status: "resolved";
      readonly unit: ProcessingUnit;
      /** The path the request named, spelled as it asked. */
      readonly path: string;
      /**
       * What the receipt names: the unit's own line span, empty when the unit
       * is the whole result (the receipt line then omits the range segment).
       */
      readonly receiptRanges: readonly LineRange[];
    }
  | {
      readonly status: "refused";
      readonly reason: "malformed-request" | "absent" | "ambiguous";
      readonly detail: string;
    };

export interface ForgetLookupInput {
  readonly snapshot: SessionSnapshot;
  readonly sessionId: SessionId;
  readonly request: ForgetRequest;
}

/** Resolve one request against the snapshot. Pure: no ledger, clock or config. */
export function resolveForget(input: ForgetLookupInput): ForgetResolution {
  const shape = readRequest(input.request);
  if (shape === null) {
    return { status: "refused", reason: "malformed-request",
      detail: "A forget request needs a non-empty source path and ordered 1-based line ranges" };
  }
  const units: ProcessingUnit[] = [];
  const seen = new Set<string>();
  let matchedResults = 0;
  const tracker = new UnitTracker({ sessionId: input.sessionId, barBytes: 0 });
  for (const node of input.snapshot.nodes) {
    if (node.kind !== "tool-result" || !namesPath(node, shape.source)) continue;
    matchedResults += 1;
    for (const unit of tracker.unitsFor(node)) {
      if (seen.has(unit.id) || !holds(unit, shape.ranges)) continue;
      seen.add(unit.id);
      units.push(unit);
    }
  }
  const only = units[0];
  if (units.length === 1 && only !== undefined) {
    return { status: "resolved", unit: only, path: shape.source,
      receiptRanges: receiptRangesFor(only) };
  }
  if (units.length > 1) {
    return { status: "refused", reason: "ambiguous",
      detail: `${String(units.length)} held units of ${shape.source} contain the requested ranges; a forget names one` };
  }
  return { status: "refused", reason: "absent",
    detail: `No held unit of ${shape.source} contains the requested ranges (${String(matchedResults)} result(s) name the path)` };
}

/**
 * The receipt's line span: the unit's own lines, empty when the unit is the
 * whole result (the receipt line then omits the range segment), exactly as a
 * whole-unit verdict receipt does.
 */
export function receiptRangesFor(unit: ProcessingUnit): readonly LineRange[] {
  const whole = unit.span.byteRange.startByte === 0
    && unit.span.byteRange.endByteExclusive === unit.source.byteLength;
  if (whole || unit.span.lineRange === null) return [];
  return [{ ...unit.span.lineRange }];
}

/**
 * The request as plain data, or `null` when its shape is not a forget request.
 * The event is runtime input; the declared type is the contract it must meet.
 */
function readRequest(value: unknown): { readonly source: string; readonly ranges: readonly LineRange[] } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const request = value as { readonly source?: unknown; readonly ranges?: unknown };
  const source = request.source;
  if (typeof source !== "string" || source.trim().length === 0) return null;
  if (!Array.isArray(request.ranges)) return null;
  const ranges: LineRange[] = [];
  for (const item of request.ranges) {
    if (typeof item !== "object" || item === null) return null;
    const range = item as { readonly startLine?: unknown; readonly endLineInclusive?: unknown };
    if (!Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLineInclusive)) return null;
    const startLine = range.startLine as number, endLineInclusive = range.endLineInclusive as number;
    if (startLine < 1 || endLineInclusive < startLine) return null;
    ranges.push({ startLine, endLineInclusive });
  }
  return { source, ranges };
}

/** True when this result's evidence says the call returned the path itself. */
function namesPath(node: ToolResultNode, source: string): boolean {
  // A write's bytes prove the path changed; they are never the content a forget
  // names (PRD §6.7; ISSUE-045 chunk E0 classifies it).
  if (node.evidence.kind === "write") return false;
  return node.evidence.paths.some(path => path.outcome === "hit"
    && (path.pathKey === source || path.displayPath === source));
}

/** True when one unit covers every requested range; no ranges names the unit whole. */
function holds(unit: ProcessingUnit, ranges: readonly LineRange[]): boolean {
  if (ranges.length === 0) return true;
  const lines = unit.span.lineRange;
  if (lines === null) return false;
  return ranges.every(range => range.startLine >= lines.startLine
    && range.endLineInclusive <= lines.endLineInclusive);
}
