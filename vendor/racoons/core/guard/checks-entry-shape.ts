import type { Removal, RulePlan, ShapeOp } from "../rules/types.js";
import type { ByteRange, UnitId } from "../types/identity.js";
import type { ToolResultNode } from "../types/transcript.js";
import { UnitTracker } from "../units/tracker.js";
import { splitLineOffsets } from "../util/lines.js";
import { normalizeKeptSpans } from "../verdicts/plan.js";
import type { KeptLineSpan } from "../verdicts/types.js";
import { complement, equal, sameRanges } from "./bytes.js";
import type { Candidate } from "./candidate.js";
import type { CheckContext, Report } from "./context.js";
import { renderShapeTurn } from "./shape-turn.js";
import type { Replacement } from "./types.js";

/**
 * The entry-shape guard check (ISSUE-056 chunk C5, reworked to the landed-node
 * contract by ISSUE-058 chunk P3b; ADR-0022 §12–§14).
 *
 * A `shape` operation says an ANSWER decided what stays of a result that has
 * ALREADY LANDED, so the plan is admitted only under the `entry-shape` rule id
 * (the exemption beside `proofUnderItsRule` in `checks-operations.ts`). Nothing
 * here reads the planner's arithmetic; every claim is re-derived from the
 * landed body's own bytes:
 *
 * - (a) the removal names the landed result and nothing else, and `originalBytes`
 *   is that node's own body byte for byte — so the bank covers what the host
 *   still holds, never the shaped turn it now shows;
 * - (b) `keptRanges` are integral, ordered, non-overlapping whole-line spans of
 *   the original — never half a line, half a CRLF pair or half a UTF-8
 *   character — and the removal is exactly their complement;
 * - (b′) for a `forgetlines` answer the NAMED ranges are validated directly
 *   against the landed body's own line count and bytes, never a hand-computed
 *   complement (ADR-0026 §4): the named spans are the removal's claim, and the
 *   kept complement must tile the body with it exactly;
 * - (c) the unit binding: `op.unitId` is the landed whole-result unit, re-derived
 *   here from the landed node's identity;
 * - (d) `replacementBytes` re-renders byte-exact from the original and the kept
 *   ranges, one marker in each dropped gap, with the kept lines, the total line
 *   count, the dropped-byte count and the archive's own recall id;
 * - (e) the archive covers the ORIGINAL body under exactly the dropped ranges,
 *   and its id is the id those bytes and ranges hash to.
 *
 * Every refusal leaves the transcript untouched: the result stays landed whole
 * and nothing is appended (ADR-0022 §14, fail-open). A refusal is ordinary
 * arithmetic over the bytes the answer named, never a claim about the content.
 */

/** One shaped entry as a plan claim: (a), (b) and the (c) unit binding. */
export function checkShape(
  c: CheckContext, op: ShapeOp, removal: Removal | undefined, report: Report,
): void {
  if (c.value.input.kind !== "entry") {
    report("invalid-plan", "A shape operation applies only to the landed entry result");
    return;
  }
  // Code decides only whether to ask, never how much (ADR-0022 §1). A shape on
  // an event that carries no answer would be a rule inventing a decision, so it
  // is refused even when its byte claims happen to add up.
  if (c.value.input.answer === undefined) {
    report("invalid-plan", "A shape plan needs an answered entry event; code never decides how much");
  }
  const node = c.value.input.result;
  // A missing removal is `checkOperations`' `unaccounted-removal`; there is no
  // shape claim to test without it.
  if (removal === undefined) return;
  const only = removal.sources[0];
  if (removal.sources.length !== 1 || only === undefined || only.source.nodeId !== node.id) {
    report("invalid-plan", "A shape removal must name the landed result and nothing else", node.id);
    return;
  }
  const original = op.originalBytes;
  if (!(original instanceof Uint8Array) || !equal(original, node.bytes)) {
    // The shaped turn is a NEW turn; the original never changes. A plan whose
    // archived body is not the landed body would bank bytes no wire carries.
    report("source-hash-mismatch",
      "A shape's original bytes must be the landed result's own body", node.id);
    return;
  }
  if (only.source.sha256 !== node.sha256 || only.source.byteLength !== node.byteLength) {
    report("source-hash-mismatch", "A shape source must be the landed result's own identity", node.id);
  }
  const unitId = wholeResultUnitId(c, node);
  if (unitId === null || op.unitId !== unitId) {
    report("unknown-unit", "A shape plan must bind the landed result's own unit", node.id);
  }
  const offsets = splitLineOffsets(original);
  if (!wholeLineRanges(op.keptRanges, offsets, original.length)) {
    report("invalid-line-span",
      "Kept ranges must be ordered whole-line spans of the landed result", node.id);
    return;
  }
  let gaps: ByteRange[];
  try {
    gaps = complement(op.keptRanges, original.length);
  } catch {
    // Unreachable after `wholeLineRanges`; a refusal, never a throw.
    report("invalid-line-span", "Kept ranges are not a usable byte partition", node.id);
    return;
  }
  if (gaps.length === 0) {
    // No dropped gap means no marker: the answer gave up nothing, which is a
    // keepall and plans no shape at all (ADR-0022 §9, §11).
    report("invalid-line-span",
      "A shape that keeps every line gives up nothing; it is a keepall", node.id);
    return;
  }
  if (!sameRanges(gaps, only.ranges)) {
    report("unaccounted-removal",
      "A shape removal must be exactly the complement of the kept ranges", node.id);
    return;
  }
  // (b′) The NAMED ranges are validated here directly — against the landed
  // body's own line offsets, never against a complement some caller computed
  // (ADR-0026 §4). `forgetlines` names what leaves; `keeplines` names what
  // stays and must equal `op.keptRanges`; `forgetall` keeps nothing; a
  // `keepall` answer plans no shape at all. This binds a plan supplied
  // independently of the planner to its answer.
  const answer = c.value.input.answer;
  if (answer !== undefined && answer.action === "keepall") {
    report("invalid-plan", "A keepall answer plans no shape", node.id);
    return;
  }
  if (answer !== undefined && answer.action === "keeplines") {
    const named = namedByteRanges(answer.ranges, offsets, original.length);
    // An empty selection is a forgetall in disguise, never a shape.
    if (named === null || named.length === 0 || !sameRanges(named, op.keptRanges)) {
      report("invalid-line-span",
        "A keeplines shape must keep exactly the lines the answer names", node.id);
      return;
    }
  }
  if (answer !== undefined && answer.action === "forgetall" && op.keptRanges.length !== 0) {
    report("invalid-line-span", "A forgetall shape keeps no line", node.id);
    return;
  }
  if (answer !== undefined && answer.action === "forgetlines") {
    const named = namedByteRanges(answer.ranges, offsets, original.length);
    if (named === null) {
      report("invalid-line-span",
        "Every named forgetlines range must be a whole-line span of the landed result", node.id);
      return;
    }
    if (!sameRanges(named, gaps)) {
      // The named spans and the kept complement must tile the body exactly: a
      // range shifted, dropped or invented surfaces as a mismatch here.
      report("unaccounted-removal",
        "A forgetlines removal must be exactly the ranges the answer names", node.id);
      return;
    }
  }
  // (d) The turn re-renders from the original and the kept ranges. The renderer
  // derives the recall id from those same bytes, so a plan whose marker names
  // another id, whose dropped-byte count is wrong or whose kept lines are stated
  // wrong cannot reproduce its own `replacementBytes`.
  const turn = renderShapeTurn({ source: only.source, original,
    keptRanges: op.keptRanges, sessionId: c.value.snapshot.sessionId });
  if (turn === null || !equal(turn.bytes, op.replacementBytes)) {
    report("invalid-generated-record",
      "A shape's replacement bytes must re-render from the landed body and the kept ranges", node.id);
  }
}

/**
 * The NAMED line ranges of a partial answer as whole-line byte ranges of the
 * landed body, or `null` when a span is not one. The named spans are checked
 * here, in the guard, against the unit's own line offsets — never by subtracting
 * them from a complement some caller computed (ADR-0026 §4). Order and overlap
 * are normalised by the same function the planner normalises with, so a
 * hand-built answer plans and validates alike; a span that starts past the body,
 * ends before it starts or reaches past it is refused, never clamped.
 */
function namedByteRanges(
  spans: readonly KeptLineSpan[], offsets: readonly ByteRange[], size: number,
): ByteRange[] | null {
  const normalized = normalizeKeptSpans(spans);
  if (normalized === null) return null;
  const named: ByteRange[] = [];
  for (const span of normalized) {
    const head = offsets[span.from - 1];
    const tail = offsets[span.to - 1];
    if (head === undefined || tail === undefined) return null;
    const startByte = head.startByte;
    const endByteExclusive = tail.endByteExclusive;
    if (endByteExclusive <= startByte || endByteExclusive > size) return null;
    named.push({ startByte, endByteExclusive });
  }
  return named;
}

/**
 * The output half of the shape check: (e), read back off the candidate the
 * builder produced. `checkOutput` has already verified the generic replacement
 * arithmetic; this says the archive covers the ORIGINAL body and that the
 * shaped turn is the bytes the plan named.
 */
export function checkShapeReplacement(
  c: CheckContext, plan: RulePlan, op: ShapeOp, removal: Removal,
  replacement: Replacement, candidate: Candidate, report: Report,
): void {
  if (c.value.input.kind !== "entry") return; // `checkShape` spoke.
  const node = c.value.input.result;
  const archive = candidate.archives.find(entry =>
    entry.ruleId === plan.ruleId && entry.removalId === removal.id);
  if (archive === undefined) return; // The archive arm of `checkOutput` speaks.
  const original = op.originalBytes;
  let gaps: readonly ByteRange[];
  try {
    gaps = complement(op.keptRanges, original.length);
  } catch {
    report("invalid-line-span", "Kept ranges are not a usable byte partition", node.id);
    return;
  }
  // (e) The bank holds the ORIGINAL landed body under exactly the dropped
  // ranges, so the recall id in the marker restores what the host still holds.
  const part = archive.recall.parts[0];
  if (archive.recall.parts.length !== 1 || part === undefined || part.source.nodeId !== node.id
    || !equal(part.bytes, original)
    || !sameRanges(part.removedRanges.map(span => span.range), gaps)) {
    report("recall-manifest-mismatch",
      "A shape archive must cover the landed result's original bytes and dropped ranges", node.id);
    return;
  }
  // The archive's id must be the id the marker names, which is the id the
  // ORIGINAL body and the dropped ranges mint. `checkRecall` proves the manifest
  // is self-consistent; this proves it is the one the shaped turn points at.
  const turn = renderShapeTurn({ source: part.source, original, keptRanges: op.keptRanges,
    sessionId: c.value.snapshot.sessionId });
  if (turn !== null && archive.recall.id !== turn.recallId) {
    report("recall-manifest-mismatch",
      "A shape archive id must be the id its original bytes and ranges mint", node.id);
  }
  if (!equal(replacement.bytes, op.replacementBytes)) {
    report("invalid-generated-record", "A shape must land exactly the turn its plan names", node.id);
  }
  if (replacement.evidenceRecallId !== archive.recall.id) {
    report("recall-manifest-mismatch",
      "A shaped turn must name the archive it can be restored from", node.id);
  }
}

/**
 * `unitIdFor` of the landed whole-result unit, re-derived from the landed node's
 * own identity. The bar is 0 on purpose: the landed result is one unit whatever
 * its size, because the answer already decided it is the checkpoint's subject.
 */
function wholeResultUnitId(c: CheckContext, node: ToolResultNode): UnitId | null {
  const units = new UnitTracker({ sessionId: c.value.snapshot.sessionId, barBytes: 0 })
    .unitsFor(node);
  return units[0]?.id ?? null;
}

/**
 * True when every range is an integral, ordered, non-overlapping span that
 * starts at a line start and ends after a line terminator of this body. An
 * empty list is the `forgetall` answer: it keeps no line, so there is no
 * boundary to prove.
 */
function wholeLineRanges(
  ranges: readonly ByteRange[], offsets: readonly ByteRange[], size: number,
): boolean {
  let previousEnd = 0;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.startByte) || !Number.isSafeInteger(range.endByteExclusive)
      || range.startByte < previousEnd || range.endByteExclusive <= range.startByte
      || range.endByteExclusive > size) return false;
    const first = offsets.findIndex(line => line.startByte === range.startByte);
    const last = offsets.findIndex(line => line.endByteExclusive === range.endByteExclusive);
    if (first < 0 || last < first) return false;
    previousEnd = range.endByteExclusive;
  }
  return true;
}
