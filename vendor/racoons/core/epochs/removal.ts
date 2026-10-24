import type { LineRange } from "../types/identity.js";
import type { AppliedRemoval, EpochDecision } from "./types.js";

/** The frozen empty range list: a keepall decision's `ranges`. */
const KEEPALL_RANGES: readonly LineRange[] = Object.freeze([]);

/**
 * A turn is a non-negative safe integer. Turn numbers index a session's calls;
 * nothing here reads a clock, so a turn is always supplied by the caller.
 */
export function isTurn(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Locale-independent string order, so `unitId` sorting never varies by host. */
export function stableCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function toLineRange(range: unknown): LineRange {
  const candidate = range as Partial<LineRange> | null | undefined;
  const startLine = candidate?.startLine;
  const endLineInclusive = candidate?.endLineInclusive;
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLineInclusive) ||
    (startLine as number) < 1 ||
    (endLineInclusive as number) < (startLine as number)
  ) {
    throw new RangeError(`Invalid line range: ${JSON.stringify(range)}`);
  }
  return { startLine: startLine as number, endLineInclusive: endLineInclusive as number };
}

/**
 * Sorts and merges 1-based inclusive line ranges, freezing the result.
 *
 * Adjacent spans merge because the removed bytes and the kept complement are
 * identical either way, and the merged form is what a receipt names. Validation
 * is strict: a range that is not a positive integer pair, or that ends before it
 * starts, is refused rather than repaired.
 */
export function canonicalRanges(ranges: readonly unknown[]): readonly LineRange[] {
  const ordered = ranges
    .map(toLineRange)
    .sort((a, b) => a.startLine - b.startLine || a.endLineInclusive - b.endLineInclusive);
  const merged: LineRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.startLine <= previous.endLineInclusive + 1) {
      merged[merged.length - 1] = {
        startLine: previous.startLine,
        endLineInclusive: Math.max(previous.endLineInclusive, range.endLineInclusive),
      };
    } else {
      merged.push(range);
    }
  }
  return freezeRanges(merged);
}

export function freezeRanges(ranges: readonly LineRange[]): readonly LineRange[] {
  return Object.freeze(ranges.map(range => Object.freeze({
    startLine: range.startLine,
    endLineInclusive: range.endLineInclusive,
  })));
}

/**
 * One decision in canonical form: `{turn, unitId, ranges}` with ranges sorted,
 * merged and frozen. Extra fields are dropped: epoch identity is
 * `(turn, unitId, ranges)` only. A caller's own log keeps its labels.
 *
 * `index` only names the decision in a thrown message.
 */
export function normalizeDecision(decision: unknown, index: number | null = null): EpochDecision {
  const where = index === null ? "decision" : `decisions[${index}]`;
  if (decision === null || typeof decision !== "object") {
    throw new TypeError(`${where} must be an object`);
  }
  const candidate = decision as Partial<EpochDecision>;
  const { turn, unitId, ranges } = candidate;
  if (!isTurn(turn)) {
    throw new TypeError(`${where}.turn must be a non-negative safe integer`);
  }
  if (typeof unitId !== "string" || unitId.length === 0) {
    throw new TypeError(`${where}.unitId must be a non-empty string`);
  }
  if (!Array.isArray(ranges)) {
    throw new TypeError(`${where}.ranges must be an array (empty means keepall)`);
  }
  return Object.freeze({
    turn,
    unitId,
    ranges: ranges.length === 0 ? KEEPALL_RANGES : canonicalRanges(ranges),
  });
}

/** Decision lists arrive from callers; every entry is validated on the way in. */
export function normalizeDecisions(decisions: readonly unknown[]): readonly EpochDecision[] {
  if (!Array.isArray(decisions)) throw new TypeError("decisions must be an array");
  return Object.freeze(decisions.map((decision, index) => normalizeDecision(decision, index)));
}

/**
 * Union of ranges per unit, units and ranges in stable order. Keepall decisions
 * contribute nothing, so a list of them canonicalises to `[]`.
 */
function canonicalEntries(decisions: readonly EpochDecision[]): readonly AppliedRemoval[] {
  const byUnit = new Map<string, LineRange[]>();
  for (const decision of decisions) {
    if (decision.ranges.length === 0) continue; // keepall removes nothing
    const current = byUnit.get(decision.unitId);
    const copies = decision.ranges.map(range => ({
      startLine: range.startLine,
      endLineInclusive: range.endLineInclusive,
    }));
    if (current === undefined) {
      byUnit.set(decision.unitId, copies);
    } else {
      current.push(...copies);
    }
  }
  return Object.freeze([...byUnit.keys()].sort(stableCompare).map(unitId => Object.freeze({
    unitId,
    ranges: canonicalRanges(byUnit.get(unitId) ?? []),
  })));
}

/**
 * The applied set a call at `turn` sees, over already-normalized decisions.
 * Internal to the epoch package: callers use `appliedSetAt`, which validates.
 */
export function appliedEntriesAt(
  decisions: readonly EpochDecision[],
  turn: number,
): readonly AppliedRemoval[] {
  return canonicalEntries(decisions.filter(decision => decision.turn < turn));
}

/**
 * The applied-removal set visible at `turn`: every canonical entry of a decision
 * made at a strictly earlier turn, frozen and sorted by `unitId` then ranges.
 *
 * End-of-turn semantics: a removal decided at turn T is applied at the END of T,
 * so a call at T does not see it and a call at T+1 does.
 */
export function appliedSetAt(
  decisions: readonly EpochDecision[],
  turn: number,
): readonly AppliedRemoval[] {
  if (!isTurn(turn)) {
    throw new TypeError("appliedSetAt(decisions, turn) needs a non-negative integer turn");
  }
  return appliedEntriesAt(normalizeDecisions(decisions), turn);
}

/**
 * The turn a removal decision applies at, validating the decision on the way.
 * It is applied at the END of that turn, not at its start.
 */
export function removalPoint(decision: unknown): number {
  return normalizeDecision(decision).turn;
}

/**
 * Stable serialization of a decision list's union: sorted `unitId`, then sorted
 * merged ranges, fixed key order. Two lists that remove the same lines from the
 * same units produce byte-identical strings, so equality is a string compare.
 * Keepall decisions contribute nothing.
 */
export function canonicalRemovalSet(decisions: readonly EpochDecision[]): string {
  return JSON.stringify(canonicalEntries(normalizeDecisions(decisions)));
}

export { KEEPALL_RANGES };
