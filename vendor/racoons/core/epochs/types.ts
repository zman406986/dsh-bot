import type { LineRange, UnitId } from "../types/identity.js";

/**
 * One judge call as the epoch planner sees it: an opaque call id and the turn
 * it belongs to. The planner never reorders calls; it requires them ascending by
 * `turnIndex`, with same-turn calls adjacent.
 */
export interface EpochCall {
  readonly callId: string;
  readonly turnIndex: number;
}

/**
 * One removal decision, in the shape a caller records it.
 *
 * `ranges` are 1-based inclusive line ranges. An empty array is a keepall
 * decision: nothing is removed, so it never changes an applied set and never
 * creates an epoch. Extra fields on the caller's object (a label, a path, a
 * whole-unit flag) are ignored here: epoch identity is `(turn, unitId, ranges)`
 * only, and canonical judgement of the decision is `normalizeDecision`'s job.
 */
export interface EpochDecision {
  readonly turn: number;
  readonly unitId: UnitId;
  readonly ranges: readonly LineRange[];
}

/**
 * The lines one unit has lost, as a call at some turn sees them. `ranges` are
 * sorted, merged and frozen; `appliedRemovalSet` serialises a list of these
 * entries in `unitId` order, so two callers that removed the same lines compare
 * as strings.
 */
export interface AppliedRemoval {
  readonly unitId: UnitId;
  readonly ranges: readonly LineRange[];
}

/**
 * Consecutive calls of one epoch that share a turn. Their rendered prefixes must
 * be byte-equal (same applied set, same turn blocks), and no epoch boundary can
 * split such a group, because the applied set depends on `turnIndex` alone.
 */
export interface EpochSameTurnGroup {
  readonly turnIndex: number;
  readonly callIds: readonly string[];
}

/**
 * One maximal run of consecutive calls sharing the same applied-removal set
 * (PM ruling: a removal decided at turn T is applied at the END of turn T, so
 * every call with `turnIndex > T` sees it and every call with `turnIndex <= T`
 * does not).
 *
 * `basePrefixRequired` is `true` on every epoch and its type is the literal
 * `true`: epoch 0 has nothing before it, and a later epoch re-renders its prefix
 * from pristine turn blocks plus its applied set instead of patching the
 * previous epoch. A caller therefore renders a base at each epoch and hashes it.
 */
export interface Epoch {
  readonly epochIndex: number;
  readonly firstCallId: string;
  readonly lastCallId: string;
  readonly firstTurnIndex: number;
  readonly lastTurnIndex: number;
  readonly callCount: number;
  readonly callIds: readonly string[];
  /** Canonical JSON of the epoch's applied removals; byte-comparable. */
  readonly appliedRemovalSet: string;
  readonly basePrefixRequired: true;
  readonly sameTurnGroups: readonly EpochSameTurnGroup[];
  /** Units that became visible at this boundary, sorted; empty for a pristine epoch 0. */
  readonly activatedUnitIds: readonly UnitId[];
}
