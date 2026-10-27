import type { RulePlan } from "../rules/types.js";
import type { ByteRange } from "../types/identity.js";
import { computeInvalidation } from "../units/invalidation.js";
import type { InvalidatedUnit } from "../units/invalidation.js";
import { UnitTracker } from "../units/tracker.js";
import type { ProcessingUnit } from "../units/types.js";
import type { CheckContext } from "./context.js";
import { reporter } from "./context.js";

/**
 * Write invalidation and edit coverage (PRD §6.7; ISSUE-045 chunk C6).
 *
 * "A write to a path invalidates that path's units and stale maps; an edit may
 * land only into ranges the agent actually holds as kept." The guard re-derives
 * the invalidation from the snapshot — `units/invalidation.ts`, never a
 * planner's note — and then asks one question of every removal anchored on an
 * invalidated unit:
 *
 *   - does the removal name exactly the unit's own bytes? Then it is a whole-unit
 *     removal — a `forgetall`, a manual forget, or a `proof` burn. It gives up
 *     the copy as it stands and anchors no line of the file, so it stands.
 *     A `proof` burn is precisely the re-derivation this clause demands, and
 *     `checks-proofs.ts` re-proves its byte fact from this same snapshot;
 *   - does the removal name a proper part of the unit's span? Then it is a
 *     `keeplines` answer whose kept lines are the ranges the agent claims to
 *     hold as current — and the later write replaced exactly those lines. The
 *     claim is provably false: the copy is not the file's current bytes (the
 *     stale-read fact, PRD §6.6), so no line span inside it is current either.
 *     This is `edit-outside-coverage`, the PRD's edit-coverage half, and the
 *     detail names the write — its node, its step and the path spelling — so the
 *     refusal is checkable against the agent's own transcript.
 *
 * A refusal removes nothing and counts on the breaker, as every validation
 * failure does (PRD §6.7). Nothing is repaired or narrowed: the plan keeps its
 * shape and the whole batch is rejected.
 */
export function checkInvalidation(c: CheckContext, plans: readonly RulePlan[]): void {
  if (!hasWrite(c)) return;
  const tracker = new UnitTracker({
    sessionId: c.value.snapshot.sessionId,
    barBytes: c.value.config.protocol.barBytes,
  });
  const invalidation = computeInvalidation({ snapshot: c.value.snapshot, units: tracker.units(c.value.snapshot) });
  if (invalidation.units.length === 0) return;
  for (const plan of plans) {
    plan.operations.forEach((op, index) => {
      // Only a verdict or proof operation names a unit. The other kinds are
      // refused by `checkOperations` before their placement could matter here;
      // a proof burn is the re-derivation this clause asks for, so it stands.
      if (op.kind !== "verdict") return;
      const row = invalidation.byUnit.get(op.unitId);
      if (row === undefined) return;
      const removal = plan.removals.find(candidate => candidate.id === op.removalId);
      if (removal === undefined || removal.sources.length !== 1) return; // `checkVerdicts` speaks.
      const only = removal.sources[0];
      if (only === undefined || only.source.nodeId !== row.unit.nodeId) return;
      if (coversWholeSpan(only.ranges, row.unit)) return;
      reporter(c, plan.ruleId, index)("edit-outside-coverage", detailFor(row), row.unit.nodeId);
    });
  }
}

/**
 * A cheap pre-test: with no write node there is nothing to invalidate, and the
 * tracker need not run at all. A write's kind is the only fact that matters
 * here, so a transcript without one is silent by construction.
 */
function hasWrite(c: CheckContext): boolean {
  return c.value.snapshot.nodes.some(node => node.kind === "tool-result" && node.evidence.kind === "write");
}

/**
 * True when the declared ranges are exactly the unit's own span: the removal
 * gives up the whole copy and claims nothing about any line inside it.
 */
function coversWholeSpan(ranges: readonly ByteRange[], unit: ProcessingUnit): boolean {
  if (ranges.length !== 1) return false;
  const only = ranges[0];
  return only !== undefined
    && only.startByte === unit.span.byteRange.startByte
    && only.endByteExclusive === unit.span.byteRange.endByteExclusive;
}

/**
 * The refusal names the write, because the write is the fact: the agent can
 * find it in its own transcript and see that the lines it kept are the replaced
 * copy's, not the file's current lines.
 */
function detailFor(row: InvalidatedUnit): string {
  const path = row.unit.path ?? row.write.pathKey;
  return `A partial removal holds lines of ${path} that the write at step `
    + `${String(row.write.atStep)} (node ${row.write.nodeId}, path ${row.write.pathKey}) replaced;`
    + " the kept ranges are not current file state";
}
