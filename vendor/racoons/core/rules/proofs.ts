import type { LineRange, NodeId, NoteId, RemovalId } from "../types/identity.js";
import type { ToolResultNode } from "../types/transcript.js";
import { UnitTracker, unitRemoval } from "../units/tracker.js";
import type { ProcessingUnit } from "../units/types.js";
import type {
  Note, ProofKind, ProofOp, Removal, RuleContext, RulePlan,
} from "./types.js";

/**
 * The shared body of the two proof rules (PRD §6.6; ADR-0018; ISSUE-045 chunk
 * C3). A proof rule claims one byte fact about one read, and the guard re-derives
 * that fact from the snapshot's own nodes (`guard/checks-proofs.ts`), so a rule
 * that claims more than the bytes prove is refused, never repaired. This module
 * therefore emits exactly the shape the guard proves: one unit, one `proof`
 * operation, one `proof-receipt` note over the unit's own span.
 *
 * The rules claim only what they can also see is applicable. A unit below a
 * warm watermark, or in a node another rule already reserved, would be refused
 * by the guard; a refusal with no request behind it would spend a breaker
 * failure for nothing, so the rule plans nothing instead. No content class is
 * held back (ADR-0020): the automatic protection layer is deleted, and every
 * candidate byte competes on its merits.
 *
 * There is no numeric bar and no heuristic (ADR-0006): each rule's callback
 * answers one question about witnessed bytes, and a `false` keeps the unit.
 */

/** One read the snapshot holds: the unit a proof may burn and where it sits. */
export interface ProofSubject {
  readonly unit: ProcessingUnit;
  readonly node: ToolResultNode;
  /** The node's index in the snapshot: transcript order is the clock, and the cut. */
  readonly index: number;
}

/**
 * The units a proof rule may consider, in transcript order. Only a `read` is a
 * proof subject: a write's bytes say a path changed, never what it held, and a
 * search or unknown result is evidence of nothing (E0).
 *
 * Rules run on every rule-pass input, but a proof removal applies by
 * checkpoint-revert on an at-rest pass: an entry pass replaces the incoming
 * result in place and has no history to cut, so no proof is planned there.
 */
export function proofSubjects(context: RuleContext): readonly ProofSubject[] {
  if (context.input.kind !== "at-rest") return [];
  // ADR-0018 §3: one gate, `capabilities.revertHistory === true`. Absent the
  // seam a proof could only be refused, so nothing is planned.
  if (context.capabilities.revertHistory !== true) return [];
  const snapshot = context.snapshot;
  const reserved = new Set(context.reservedNodeIds);
  const tracker = new UnitTracker({
    sessionId: snapshot.sessionId,
    barBytes: context.config.protocol.barBytes,
  });
  const subjects: ProofSubject[] = [];
  for (const unit of tracker.units(snapshot)) {
    if (reserved.has(unit.nodeId)) continue;
    const index = snapshot.nodes.findIndex(candidate => candidate.id === unit.nodeId);
    const node = index < 0 ? undefined : snapshot.nodes[index];
    if (node === undefined || node.kind !== "tool-result") continue;
    if (node.evidence.kind !== "read") continue;
    // A proof removal's node index is its cut; ADR-0012 refuses a cut below a
    // real warm watermark, so nothing below it is planned.
    if (snapshot.cache.kind === "warm" && index < context.freshZone.startNodeIndex) continue;
    subjects.push({ unit, node, index });
  }
  return subjects;
}

/**
 * Plans one proof kind over the subjects `proves` selects. One node yields at
 * most one burn: a second removal over the same node would collide at
 * materialization (one node, one receipt), so the first provable unit stands.
 * `null` when no subject is provable — absence of a proof removes nothing.
 */
export function planProofs(
  context: RuleContext,
  kind: ProofKind,
  proves: (subject: ProofSubject) => boolean,
): RulePlan | null {
  const removals: Removal[] = [];
  const notes: Note[] = [];
  const operations: ProofOp[] = [];
  const claimed = new Set<NodeId>();
  for (const subject of proofSubjects(context)) {
    if (claimed.has(subject.node.id) || !proves(subject)) continue;
    claimed.add(subject.node.id);
    const removal = unitRemoval(subject.unit);
    const noteId = `proof:${subject.unit.id}`;
    removals.push(removal);
    notes.push(proofReceipt(noteId, kind, removal.id, subject.unit));
    operations.push({
      kind: "proof",
      proofKind: kind,
      removalId: removal.id,
      unitId: subject.unit.id,
      noteId,
    });
  }
  if (operations.length === 0) return null;
  return {
    ruleId: kind,
    baseRevision: context.snapshot.revision,
    removals,
    notes,
    operations,
  };
}

/**
 * The receipt a burn leaves in place of the unit: the unit's path (its node id
 * when the host named no path) and the burned line ranges, with no descriptor.
 * A proven removal has nothing to describe (ADR-0018; PRD §6.6).
 */
function proofReceipt(
  id: NoteId,
  kind: ProofKind,
  removalId: RemovalId,
  unit: ProcessingUnit,
): Note {
  return {
    id,
    kind: "proof-receipt",
    proofKind: kind,
    removalId,
    unitId: unit.id,
    path: unit.path ?? unit.nodeId,
    ranges: receiptRanges(unit),
  };
}

/**
 * The line ranges a receipt names: none when the whole node went (the recall id
 * alone identifies it), otherwise the unit's own lines. A node that is not
 * line-addressable names no range rather than an invented one.
 */
function receiptRanges(unit: ProcessingUnit): readonly LineRange[] {
  const { byteRange } = unit.span;
  const wholeNode = byteRange.startByte === 0
    && byteRange.endByteExclusive === unit.source.byteLength;
  if (wholeNode || unit.span.lineRange === null) return [];
  return [{ ...unit.span.lineRange }];
}
