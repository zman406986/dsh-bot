import type { Removal, RulePlan } from "../rules/types.js";
import type { LineRange } from "../types/identity.js";
import type { TranscriptNode, ToolResultNode } from "../types/transcript.js";
import { UnitTracker } from "../units/tracker.js";
import type { ProcessingUnit } from "../units/types.js";
import { equal } from "./bytes.js";
import type { CheckContext, Report } from "./context.js";
import { reporter } from "./context.js";
/**
 * The proof lane's guard check (ADR-0018; PRD §6.6).
 *
 * A `proof` operation claims a byte fact — the file was written after the read,
 * or a later exact re-read superseded it — and this check re-derives that claim
 * from the snapshot, exactly as `checks-verdicts.ts` re-derives a verdict
 * removal. The plan is never trusted for its arithmetic:
 *
 * - the op names a unit the snapshot holds, computed here with the tracker's own
 *   bar (a unit the snapshot has is the only thing a proof can burn);
 * - its removal is exactly that unit's own span, one source and one range;
 * - `stale-read` proves a write to one of the read's paths *after* it in
 *   transcript order (a write before the read is not proof: the read is the
 *   newer bytes);
 * - `superseded-read` proves a later read of the same non-empty target key
 *   holding the exact same bytes over the removed range (the comparison
 *   `prune/level1-families.ts` uses, restructured, never its plumbing);
 * - the receipt names the unit's path and its own line ranges and no descriptor.
 *
 * A forged proof is rejected as `proof-unproven`, never repaired. Absence of a
 * proof removes nothing (ADR-0006): the failure mode is always "keep the bytes".
 */
export function checkProofs(c: CheckContext, plans: readonly RulePlan[]): void {
  const units = paidUnits(c);
  for (const plan of plans) {
    plan.operations.forEach((op, index) => {
      // A non-proof op is `checkOperations`' and `checkVerdicts`' business.
      if (op.kind !== "proof") return;
      const report = reporter(c, plan.ruleId, index);
      const unit = units.get(op.unitId);
      if (unit === undefined) {
        report("proof-unproven", "A proof names no unit the snapshot holds");
        return;
      }
      const removal = plan.removals.find(candidate => candidate.id === op.removalId);
      if (removal === undefined || !isOwnSpan(removal, unit)) {
        report("proof-unproven", "A proof removal must archive exactly the unit's own span", unit.nodeId);
        return;
      }
      const node = c.nodes.get(unit.nodeId);
      if (node === undefined || node.kind !== "tool-result") {
        report("proof-unproven", "A proof names no authoritative node", unit.nodeId);
        return;
      }
      if (!provesBytes(c, node, unit, op.proofKind)) {
        report("proof-unproven", op.proofKind === "stale-read"
          ? "No later write to this read's path proves its bytes stale"
          : "No later read of this target holds the same bytes, so nothing is superseded",
        node.id);
      }
      const note = plan.notes.find(candidate => candidate.id === op.noteId);
      if (note === undefined || note.kind !== "proof-receipt") return; // `checkOperations` speaks.
      checkReceipt(note, unit, report);
    });
  }
}

/** The units a plan may burn: the tracker's own set, at the configured bar. */
function paidUnits(c: CheckContext): ReadonlyMap<string, ProcessingUnit> {
  const tracker = new UnitTracker({
    sessionId: c.value.snapshot.sessionId,
    barBytes: c.value.config.protocol.barBytes,
  });
  return new Map(tracker.units(c.value.snapshot).map(unit => [unit.id, unit]));
}

/** One source naming the unit's node and exactly the unit's own byte range. */
function isOwnSpan(removal: Removal, unit: ProcessingUnit): boolean {
  if (removal.sources.length !== 1) return false;
  const only = removal.sources[0];
  if (only === undefined || only.ranges.length !== 1) return false;
  const range = only.ranges[0];
  return only.source.nodeId === unit.nodeId
    && only.source.sha256 === unit.source.sha256
    && only.source.byteLength === unit.source.byteLength
    && range !== undefined
    && range.startByte === unit.span.byteRange.startByte
    && range.endByteExclusive === unit.span.byteRange.endByteExclusive;
}

/**
 * The byte fact itself, re-derived from the snapshot's own nodes. Both kinds
 * need the removed node to be a read: a write's bytes are not a claim about a
 * search space, so nothing about them can be stale or superseded content.
 */
function provesBytes(
  c: CheckContext, node: ToolResultNode, unit: ProcessingUnit,
  kind: "stale-read" | "superseded-read",
): boolean {
  if (node.evidence.kind !== "read") return false;
  const index = c.value.snapshot.nodes.findIndex(candidate => candidate.id === node.id);
  if (index < 0) return false;
  return kind === "stale-read" ? writtenAfter(c, node, index) : rereadLater(c, node, unit, index);
}

/**
 * A write after the read on one of the read's own paths. Transcript order is
 * the clock: a write that lands earlier is already reflected in the read's
 * bytes, so it proves nothing about them.
 */
function writtenAfter(c: CheckContext, node: ToolResultNode, index: number): boolean {
  const paths = new Set(node.evidence.paths.map(path => path.pathKey).filter(key => key.length > 0));
  if (paths.size === 0) return false;
  const nodes = c.value.snapshot.nodes;
  for (let at = index + 1; at < nodes.length; at++) {
    const later = nodes[at];
    if (later === undefined || later.kind !== "tool-result" || later.evidence.kind !== "write") continue;
    for (const key of writePaths(later)) if (paths.has(key)) return true;
  }
  return false;
}

/**
 * A write's paths: the observations the host recorded, plus the call's own
 * declared target when it names one (E0 keeps both truthful). A write proves a
 * path changed; it never claims a hit or a miss.
 */
function writePaths(node: ToolResultNode): readonly string[] {
  const observed = node.evidence.paths.map(path => path.pathKey);
  const target = node.evidence.target;
  return target === null || target.key.length === 0 ? observed : [...observed, target.key];
}

/**
 * A later read of the same non-empty target key holding exactly the removed
 * bytes over the removed range. An unknown target key groups nothing: two
 * unnamed reads that happen to print the same text are not one source.
 */
function rereadLater(
  c: CheckContext, node: ToolResultNode, unit: ProcessingUnit, index: number,
): boolean {
  const target = node.evidence.target;
  if (target === null || target.key.length === 0) return false;
  const { startByte, endByteExclusive } = unit.span.byteRange;
  const removed = node.bytes.slice(startByte, endByteExclusive);
  const nodes = c.value.snapshot.nodes;
  for (let at = index + 1; at < nodes.length; at++) {
    const later: TranscriptNode | undefined = nodes[at];
    if (later === undefined || later.kind !== "tool-result" || later.evidence.kind !== "read") continue;
    const other = later.evidence.target;
    if (other === null || other.key !== target.key) continue;
    const candidate = later.bytes.slice(startByte, endByteExclusive);
    if (candidate.length === removed.length && equal(candidate, removed)) return true;
  }
  return false;
}

/**
 * The receipt a proof burn leaves: the unit's path (or its node id when the host
 * named no path) and the burned line ranges, with no descriptor (ADR-0018; a
 * proven removal has nothing to describe). A whole-node burn names no range.
 */
function checkReceipt(
  note: Extract<RulePlan["notes"][number], { kind: "proof-receipt" }>,
  unit: ProcessingUnit, report: Report,
): void {
  if (note.path !== (unit.path ?? unit.nodeId)) {
    report("invalid-note", "A proof receipt names a path other than its unit's", unit.nodeId);
  }
  if (!sameLines(note.ranges, receiptRanges(unit))) {
    report("invalid-note", "A proof receipt names ranges other than the burned span", unit.nodeId);
  }
}

function receiptRanges(unit: ProcessingUnit): readonly LineRange[] {
  const { byteRange } = unit.span;
  const wholeNode = byteRange.startByte === 0 && byteRange.endByteExclusive === unit.source.byteLength;
  if (wholeNode || unit.span.lineRange === null) return [];
  return [unit.span.lineRange];
}

function sameLines(a: readonly LineRange[], b: readonly LineRange[]): boolean {
  return a.length === b.length && a.every((range, index) => {
    const other = b[index];
    return other !== undefined && range.startLine === other.startLine
      && range.endLineInclusive === other.endLineInclusive;
  });
}
