import type { Note, Removal, RulePlan, VerdictOp } from "../rules/types.js";
import type { ByteRange, LineRange, Revision } from "../types/identity.js";
import type { TranscriptNode } from "../types/transcript.js";
import { splitLineOffsets } from "../util/lines.js";
import { unitRemoval } from "../units/tracker.js";
import type { ProcessingUnit } from "../units/types.js";
import { clampDescriptor, normalizeLabel } from "./labels.js";
import type { KeptLineSpan, Verdict, VerdictState } from "./types.js";

/** The rule id a verdict plan carries; the guard accepts `verdict` ops under it. */
export const VERDICT_RULE_ID = "verdict";

export interface VerdictPlanInput {
  /** The tracker's state for one gate window (design-protocol §2). */
  readonly state: VerdictState;
  /** The snapshot revision the plan is built against. */
  readonly baseRevision: Revision;
  /**
   * The transcript nodes the units came from. A `keeplines` or `forgetlines`
   * verdict names lines, and a removal is declared in bytes: the node bytes are
   * the only source of line offsets, so the planner cannot derive a partial
   * removal without them. A `forgetall` verdict ignores this list.
   */
  readonly nodes: readonly TranscriptNode[];
}

/**
 * What one verdict gives up: the byte ranges its removal archives and the line
 * ranges its receipt names. Both are `null`-free and derived from the unit and
 * the verdict alone, so the guard can recompute them without the plan.
 */
export interface VerdictRemoval {
  readonly byteRanges: readonly ByteRange[];
  /** What was removed, never the kept spans (ISSUE-017 §3). */
  readonly receiptRanges: readonly LineRange[];
}

/**
 * Turns verdict state into operations (design-protocol §5, Slice 2; the format
 * is ISSUE-017's).
 *
 * A `keepall` verdict produces nothing. A `forgetall` verdict archives the
 * unit's own byte span and its receipt carries the descriptor. A `keeplines`
 * verdict keeps the named spans and archives their complement inside the unit,
 * so a mixed unit loses only its junk lines; its receipt names the removed
 * ranges and no descriptor. A `forgetlines` verdict names the spans it DROPS
 * and archives exactly them; the kept complement is derived here, so the answer
 * is the removal and the agent never computes one (ADR-0026 §4). Its receipt
 * names the removed ranges and carries no descriptor.
 *
 * A verdict whose spans cannot be satisfied — malformed, out of the unit's
 * bounds, keeping every line or keeping none — is planned as nothing. The
 * planner never repairs an answer: the guard refuses the batch instead, and a
 * hand-built state that skips the batch is still refused by the same guard
 * re-derivation. There are no defaults in either direction, so an unanswered
 * unit is never burned by silence.
 *
 * A keep-only window has nothing to apply: there is no `ack` operation in the
 * plan vocabulary. The ack is a seam-level record (design-protocol §7 item 2),
 * so this returns `null` and the engine reports `unchanged`.
 *
 * This function does not render the receipt, touch the ledger, or pick the
 * revert cut; those belong to the guard, the ledger and `revert/plan.ts`.
 */
export function planVerdictApplication(input: VerdictPlanInput): RulePlan | null {
  const { state } = input;
  const byUnit = new Map<string, Verdict>();
  for (const verdict of state.verdicts) {
    // The tracker rejects a second verdict; if a hand-built state repeats one,
    // the first answer stands rather than the last arriving silently winning.
    if (!byUnit.has(verdict.unitId)) byUnit.set(verdict.unitId, verdict);
  }
  const bytesByNode = new Map<string, Uint8Array>();
  for (const node of input.nodes) {
    if (node.kind === "tool-result") bytesByNode.set(node.id, node.bytes);
  }

  const removals: Removal[] = [];
  const notes: Note[] = [];
  const operations: VerdictOp[] = [];
  // Window order, not arrival order: the same state always yields the same plan.
  for (const unit of state.units) {
    const verdict = byUnit.get(unit.id);
    if (verdict === undefined || verdict.action === "keepall") continue;
    const derived = deriveVerdictRemoval(unit, verdict, bytesByNode.get(unit.nodeId) ?? null);
    if (derived === null) continue;
    const base = unitRemoval(unit);
    const removal: Removal = {
      id: base.id,
      title: base.title,
      sources: [{ source: { ...unit.source }, ranges: derived.byteRanges.map(range => ({ ...range })) }],
    };
    const noteId = `receipt:${unit.id}`;
    removals.push(removal);
    notes.push({
      id: noteId,
      kind: "receipt",
      removalId: removal.id,
      unitId: unit.id,
      // A receipt must name something non-empty. A node with no hit path has no
      // path; its node id is the factual name the harness gave it.
      path: unit.path ?? unit.nodeId,
      ranges: derived.receiptRanges.map(range => ({ ...range })),
      label: receiptLabelFor(verdict),
    });
    operations.push({ kind: "verdict", removalId: removal.id, unitId: unit.id, noteId });
  }

  if (operations.length === 0) return null;
  return {
    ruleId: VERDICT_RULE_ID,
    baseRevision: input.baseRevision,
    removals,
    notes,
    operations,
  };
}

/**
 * The removal one verdict claims, derived from the unit and the verdict alone.
 * `null` when the verdict names no legal removal: a `keepall`, a unit that is
 * not line-addressable under a partial class, malformed or out-of-unit spans, or
 * a partial class that keeps every line or gives up none of them.
 *
 * Span semantics (ISSUE-017): `from`/`to` are 1-based, inclusive and relative
 * to the unit's own content, so `1` is the unit's first line whatever line of
 * the node that is. Input spans are sorted and merged first — overlapping and
 * adjacent spans collapse — so unsorted or overlapping judge output is
 * normalised rather than misread. Out-of-bounds spans are refused, not
 * clamped: a span past the unit means the judge misread the unit, and all-or-
 * nothing is the protocol's answer to a misread.
 *
 * `keeplines` names the KEPT spans; `forgetlines` names the DROPPED ones and the
 * kept region is their complement (ADR-0026 §4). Both derive through
 * `complementLineSpans`, so there is one source of the removal and one function
 * for its complement: the named spans of a `forgetlines` answer are checked
 * against the unit first, and no caller ever hands in a complement.
 */
export function deriveVerdictRemoval(
  unit: ProcessingUnit,
  verdict: Verdict,
  nodeBytes: Uint8Array | null,
): VerdictRemoval | null {
  if (verdict.action === "keepall") return null;
  if (verdict.action === "forgetall") {
    return {
      byteRanges: [{ ...unit.span.byteRange }],
      receiptRanges: wholeUnitRange(unit),
    };
  }
  const lines = unit.span.lineRange;
  if (lines === null || nodeBytes === null) return null;
  const count = lines.endLineInclusive - lines.startLine + 1;
  if (count < 1) return null;
  const named = normalizeKeptSpans(verdict.ranges);
  if (named === null || named.length === 0) return null;
  const first = named[0], last = named[named.length - 1];
  if (first === undefined || last === undefined || first.from < 1 || last.to > count) return null;
  // Both-ends rule (ADR-0026 §5). For `keeplines`: keeping every line is a
  // `keepall` and keeping none is a `forgetall` without a descriptor. For
  // `forgetlines` the same two degenerate answers are the same two refusals:
  // naming no line is no drop at all, naming every line is the whole unit.
  if (named.length === 1 && first.from === 1 && first.to === count) return null;
  // `keeplines` KEEPS the named spans, `forgetlines` DROPS them; the other side
  // is always the complement, computed here and nowhere else.
  const kept = verdict.action === "keeplines"
    ? named : complementLineSpans(named, count);
  const removed = verdict.action === "keeplines"
    ? complementLineSpans(named, count) : named;
  if (kept.length === 0 || removed.length === 0) return null;
  const offsets = splitLineOffsets(nodeBytes);
  const keptBytes: ByteRange[] = [];
  for (const span of kept) {
    const head = offsets[lines.startLine + span.from - 2];
    const tail = offsets[lines.startLine + span.to - 2];
    if (head === undefined || tail === undefined) return null;
    const startByte = Math.max(head.startByte, unit.span.byteRange.startByte);
    const endByteExclusive = Math.min(tail.endByteExclusive, unit.span.byteRange.endByteExclusive);
    if (endByteExclusive > startByte) keptBytes.push({ startByte, endByteExclusive });
  }
  const byteRanges = complementWithin(unit.span.byteRange, keptBytes);
  if (byteRanges.length === 0) return null;
  return {
    byteRanges,
    receiptRanges: removed.map(span => ({
      startLine: lines.startLine + span.from - 1,
      endLineInclusive: lines.startLine + span.to - 1,
    })),
  };
}

/**
 * Sorts and merges the named spans of one partial verdict — `keeplines` names
 * what stays, `forgetlines` names what leaves; this function does not care which
 * (ADR-0026 §3). `null` when a span is not an integral `from`/`to` pair with
 * `1 <= from <= to`. Adjacent spans merge because the complement is identical
 * either way and the merged form is the canonical claim the guard compares.
 */
export function normalizeKeptSpans(spans: readonly unknown[]): readonly KeptLineSpan[] | null {
  const ordered: KeptLineSpan[] = [];
  for (const value of spans) {
    if (typeof value !== "object" || value === null) return null;
    const from: unknown = (value as { readonly from?: unknown }).from;
    const to: unknown = (value as { readonly to?: unknown }).to;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
    if ((from as number) < 1 || (to as number) < (from as number)) return null;
    ordered.push({ from: from as number, to: to as number });
  }
  ordered.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: KeptLineSpan[] = [];
  for (const span of ordered) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && span.from <= previous.to + 1) {
      merged[merged.length - 1] = { from: previous.from, to: Math.max(previous.to, span.to) };
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** The gaps the kept spans leave inside `1..count`, in order, non-empty. */
export function complementLineSpans(
  kept: readonly KeptLineSpan[],
  count: number,
): readonly KeptLineSpan[] {
  const removed: KeptLineSpan[] = [];
  let cursor = 1;
  for (const span of kept) {
    if (span.from > cursor) removed.push({ from: cursor, to: span.from - 1 });
    cursor = Math.max(cursor, span.to + 1);
  }
  if (cursor <= count) removed.push({ from: cursor, to: count });
  return removed;
}

/**
 * The label a receipt may show for one verdict: the clamped descriptor for a
 * `forgetall`, normalised to one line, with blank becoming `null` so the floor
 * line ships without one. A `keeplines` or `forgetlines` receipt carries no
 * descriptor.
 *
 * The clamp is the plan layer's headroom: an over-long descriptor is cut and
 * marked rather than silently shipped. The guard still refuses an over-limit
 * answer, so an agent's overshoot is re-asked, never absorbed.
 */
export function receiptLabelFor(verdict: Verdict): string | null {
  if (verdict.action !== "forgetall") return null;
  return receiptLabel(clampDescriptor(verdict.summary ?? ""));
}

/**
 * The note label, normalised and blank-collapsed. `receiptLabelOf` in the guard
 * derives the same value; this copy lets the plan say what it claims.
 */
function receiptLabel(label: string): string | null {
  const normalized = normalizeLabel(label);
  return normalized.length === 0 ? null : normalized;
}

/**
 * The line ranges a whole-unit receipt names. Empty when the whole node was
 * forgotten (`receiptLine` then omits the range segment), empty also when the
 * content is not line-addressable.
 */
function wholeUnitRange(unit: ProcessingUnit): readonly LineRange[] {
  const { byteRange } = unit.span;
  const wholeNode = byteRange.startByte === 0 && byteRange.endByteExclusive === unit.source.byteLength;
  if (wholeNode || unit.span.lineRange === null) return [];
  return [{ ...unit.span.lineRange }];
}

/** The gaps `kept` leaves inside one byte span; `kept` need not be ordered. */
function complementWithin(span: ByteRange, kept: readonly ByteRange[]): ByteRange[] {
  const ordered = [...kept].sort((a, b) => a.startByte - b.startByte);
  const result: ByteRange[] = [];
  let cursor = span.startByte;
  for (const range of ordered) {
    if (range.endByteExclusive <= cursor) continue;
    if (range.startByte > cursor) {
      result.push({ startByte: cursor, endByteExclusive: range.startByte });
    }
    cursor = Math.max(cursor, range.endByteExclusive);
  }
  if (cursor < span.endByteExclusive) result.push({ startByte: cursor, endByteExclusive: span.endByteExclusive });
  return result;
}
