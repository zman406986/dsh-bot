import type { UnitId } from "../types/identity.js";
import { appliedEntriesAt, isTurn, normalizeDecisions, stableCompare } from "./removal.js";
import type {
  AppliedRemoval, Epoch, EpochCall, EpochDecision, EpochSameTurnGroup,
} from "./types.js";

/**
 * Deterministic prefix epochs (ISSUE-020 chunk 3, promoted from the spike-008
 * harness).
 *
 * PM ruling, exact: a removal decided at turn T is applied at the END of turn T.
 * Every call with `turnIndex > T` sees it; every call with `turnIndex <= T` does
 * not. An epoch is a maximal run of consecutive calls that share the same
 * applied-removal set.
 *
 * Within one epoch the applied set is constant, so the rendered context is a
 * pure function of (transcript, seed, decisions) and each call's prefix extends
 * the previous one: byte-identical for calls of the same turn, byte-extending
 * for later turns. No boundary can split a same-turn group, because the applied
 * set depends on `turnIndex` alone; `sameTurnGroups` names those groups so a
 * chain gate can check equality without re-deriving them.
 *
 * At an epoch boundary the prefix is re-rendered from pristine turn blocks plus
 * the new applied set, never patched from the previous epoch. That is why
 * `basePrefixRequired` is true on every epoch.
 *
 * A decision with empty `ranges` is a keepall decision: nothing is removed, so
 * it never changes the applied set and never creates an epoch.
 */

function validateCalls(calls: readonly unknown[]): readonly EpochCall[] {
  if (!Array.isArray(calls)) throw new TypeError("calls must be an array of {callId, turnIndex}");
  const seen = new Set<string>();
  const timeline: EpochCall[] = [];
  let previousTurn = -1;
  calls.forEach((call: unknown, index: number) => {
    if (call === null || typeof call !== "object") {
      throw new TypeError(`calls[${index}] must be an object`);
    }
    const { callId, turnIndex } = call as Partial<EpochCall>;
    if (typeof callId !== "string" || callId.length === 0) {
      throw new TypeError(`calls[${index}].callId must be a non-empty string`);
    }
    if (!isTurn(turnIndex)) {
      throw new TypeError(`calls[${index}].turnIndex must be a non-negative safe integer`);
    }
    if (turnIndex < previousTurn) {
      throw new RangeError(
        `calls must ascend by turnIndex: calls[${index}] turn ${turnIndex} follows ${previousTurn}`);
    }
    if (seen.has(callId)) throw new RangeError(`duplicate callId ${callId}`);
    seen.add(callId);
    previousTurn = turnIndex;
    timeline.push({ callId, turnIndex });
  });
  return Object.freeze(timeline);
}

/** Consecutive same-turn calls, in call order. The planner never reorders. */
function sameTurnGroups(calls: readonly EpochCall[]): readonly EpochSameTurnGroup[] {
  const groups: { turnIndex: number; callIds: string[] }[] = [];
  for (const call of calls) {
    const group = groups[groups.length - 1];
    if (group !== undefined && group.turnIndex === call.turnIndex) {
      group.callIds.push(call.callId);
    } else {
      groups.push({ turnIndex: call.turnIndex, callIds: [call.callId] });
    }
  }
  return Object.freeze(groups.map(group => Object.freeze({
    turnIndex: group.turnIndex,
    callIds: Object.freeze([...group.callIds]),
  })));
}

interface EpochDraft {
  readonly epochIndex: number;
  readonly calls: EpochCall[];
  readonly applied: readonly AppliedRemoval[];
  readonly appliedSet: string;
  readonly previousUnits: ReadonlySet<UnitId>;
}

function firstCallOf(draft: EpochDraft): EpochCall {
  const call = draft.calls[0];
  if (call === undefined) throw new Error("epoch has no calls"); // unreachable: drafts fill per call
  return call;
}

function lastCallOf(draft: EpochDraft): EpochCall {
  const call = draft.calls[draft.calls.length - 1];
  if (call === undefined) throw new Error("epoch has no calls"); // unreachable: drafts fill per call
  return call;
}

function finishEpoch(draft: EpochDraft): Epoch {
  const first = firstCallOf(draft);
  const last = lastCallOf(draft);
  return Object.freeze({
    epochIndex: draft.epochIndex,
    firstCallId: first.callId,
    lastCallId: last.callId,
    firstTurnIndex: first.turnIndex,
    lastTurnIndex: last.turnIndex,
    callCount: draft.calls.length,
    callIds: Object.freeze(draft.calls.map(call => call.callId)),
    // Canonical JSON: sorted unitId, sorted merged ranges. Byte-comparable.
    appliedRemovalSet: draft.appliedSet,
    // Every epoch starts at a new base: epoch 0 because nothing precedes it, a
    // later epoch because the applied set changed and the prefix re-renders from
    // pristine blocks. A caller hashes the base it renders here.
    basePrefixRequired: true,
    // Consecutive calls with the same turnIndex. Their prefixes must be
    // byte-equal (same applied set, same turn blocks); no boundary can split
    // such a group because the applied set depends on turnIndex alone.
    sameTurnGroups: sameTurnGroups(draft.calls),
    // Unit ids that became visible at this boundary (empty for a pristine epoch
    // 0), so a run can log what forced the re-render.
    activatedUnitIds: Object.freeze(
      draft.applied.map(entry => entry.unitId)
        .filter(unitId => !draft.previousUnits.has(unitId))
        .sort(stableCompare),
    ),
  });
}

/**
 * Segments an ascending call list into epochs.
 *
 * `calls` are `{callId, turnIndex}`, ascending by `turnIndex` (same-turn calls
 * adjacent, in any order), with unique ids. `decisions` are
 * `{turn, unitId, ranges}`; empty ranges means keepall.
 *
 * Returns frozen epochs in order, each carrying `epochIndex`, `firstCallId`,
 * `lastCallId`, `firstTurnIndex`, `lastTurnIndex`, `callCount`, `callIds`,
 * `appliedRemovalSet` (canonical JSON), `basePrefixRequired`, `sameTurnGroups`
 * and `activatedUnitIds`.
 *
 * Pure: inputs are never mutated, decision order does not matter, and two calls
 * with equal inputs return deep-equal output. An empty call list yields no
 * epochs at all.
 */
export function epochsFor(
  calls: readonly EpochCall[],
  decisions: readonly EpochDecision[] = [],
): readonly Epoch[] {
  const active = normalizeDecisions(decisions).filter(decision => decision.ranges.length > 0);
  const timeline = validateCalls(calls);
  if (timeline.length === 0) return Object.freeze([]);

  const epochs: Epoch[] = [];
  let draft: EpochDraft | null = null;

  for (const call of timeline) {
    const applied = appliedEntriesAt(active, call.turnIndex);
    const serialized = JSON.stringify(applied);
    if (draft === null || serialized !== draft.appliedSet) {
      if (draft !== null) epochs.push(finishEpoch(draft));
      draft = {
        epochIndex: epochs.length,
        calls: [],
        applied,
        appliedSet: serialized,
        previousUnits: draft === null
          ? new Set()
          : new Set(draft.applied.map(entry => entry.unitId)),
      };
    }
    draft.calls.push(call);
  }
  if (draft !== null) epochs.push(finishEpoch(draft));
  return Object.freeze(epochs);
}
