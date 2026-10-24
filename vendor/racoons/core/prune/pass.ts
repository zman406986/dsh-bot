/**
 * The big prune's pass planner (ISSUE-022 chunk 4; ADR-0009).
 *
 * One pass, in cost order: L1 runs first and removes only what bytes prove, L2
 * asks every unit still in memory by an index we assigned, L3 keeps the rest.
 * This module binds the two layers into ONE record-only plan document; reading
 * the answers back into that document is `./pass-merge.ts`.
 *
 * What the plan is NOT: a receipt, a recall id, a ledger event or a transcript
 * change. Record-only means nothing moves and nothing is archived, so a receipt
 * line or recall id would be a false claim — the id only exists after the bytes
 * are archived. The plan names unit ids, actions, line ranges and L1 proofs;
 * chunk 5 renders it, and the apply rollout turns it into one checkpoint-revert.
 *
 * Ordering: every list follows transcript order — the input unit order. L1's own
 * lists are transcript-ordered by construction, ask rows are numbered over L1's
 * kept list, and the merge walks the pass's unit list. Nothing here reorders.
 *
 * Nothing here calls a model: the ask's round trip is the caller's job, so the
 * planner stays pure, deterministic and testable. The only throw is a caller bug
 * — an invalid round, an index this pass never assigned, a stamp naming another
 * unit. Transcript data never throws.
 */

import type { Episode } from "../episodes/types.js";
import type { NodeId, UnitId } from "../types/identity.js";
import type { ToolResultNode } from "../types/transcript.js";
import type { ProcessingUnit } from "../units/types.js";
import { byteLengthOf } from "../util/bytes.js";
import type { WireStamp } from "../verdicts/wire.js";
import type { PruneCallFacts } from "./anchor.js";
import { buildPruneAskRows, nextTable, renderPruneAskTable } from "./ask.js";
import type { NextTableOptions, PruneAskItem, PruneAskRow, PruneAskTable } from "./ask.js";
import { planLevel1Prune } from "./level1.js";
import type { Level1PrunePlan } from "./types.js";

/** Every reason a unit is out of this pass, as data. Adding one needs a ruling. */
export const PRUNE_PASS_EXCLUSION_REASONS = ["protected"] as const;

/**
 * Why a unit is out of the pass. `protected` covers both directions: the unit is
 * never asked (a verdict on it is unusable — the guard refuses
 * `protected-content`, so the ask would spend a round on an impossible answer)
 * and an L1 removal of it is never applied.
 */
export type PrunePassExclusionReason = (typeof PRUNE_PASS_EXCLUSION_REASONS)[number];

export interface PrunePassExclusion {
  readonly unitId: UnitId;
  readonly reason: PrunePassExclusionReason;
}

export interface PrunePassInput {
  /** Every unit still in memory, in transcript order. Duplicate ids are ignored. */
  readonly units: readonly ProcessingUnit[];
  readonly nodes: readonly ToolResultNode[];
  readonly episodes: readonly Episode[];
  /** Units protection covers; they are neither asked nor removed. */
  readonly protectedUnitIds: readonly UnitId[];
  /** What the mount knows per node; see `./anchor.ts`. */
  readonly callFacts?: ReadonlyMap<NodeId, PruneCallFacts>;
  /** The pass's round ordinal; stamped on every assigned index. */
  readonly round: number;
  /** Table-builder options; production passes none. */
  readonly tableOptions?: NextTableOptions;
}

/** One pass as a document: the two layers, its ask tables and the exclusions. */
export interface PrunePassPlan {
  readonly round: number;
  /** L1's own verdict, untouched by protection; `excluded` overrides it. */
  readonly l1: Level1PrunePlan;
  /** L1's kept list minus protected units, in transcript order. */
  readonly askRows: readonly PruneAskRow[];
  /** `askRows` in contiguous tables of at most twelve units, in order. */
  readonly tables: readonly PruneAskTable[];
  /** Protected units still in memory, in transcript order. */
  readonly excluded: readonly PrunePassExclusion[];
  /** `index → unitId + round`, ready for `parsePruneAnswer`. */
  readonly stamps: ReadonlyMap<number, WireStamp>;
  /** Every unit the pass was given, deduplicated, in transcript order. */
  readonly units: readonly ProcessingUnit[];
}

/**
 * Plans one record-only pass. L1 runs over the units first. The ask covers
 * EXACTLY L1's kept list minus protected units — every unit still in memory is
 * re-asked, including units an earlier pass kept, because asking is the only way
 * to learn it is now unneeded (Ruling 8: L2 asks everything still in memory). A
 * protected unit that L1 could prove removable stays in `l1.removals` (the proof
 * stands, and L1 is not weakened by protection) but is `excluded`, and the merge
 * never turns it into a removal.
 */
export function planPrunePass(input: PrunePassInput): PrunePassPlan {
  const { round } = input;
  if (!Number.isSafeInteger(round) || round < 0) {
    throw new RangeError("round must be a non-negative safe integer.");
  }
  const units: ProcessingUnit[] = [];
  const seen = new Set<UnitId>();
  for (const unit of input.units) {
    if (seen.has(unit.id)) continue;
    seen.add(unit.id);
    units.push(unit);
  }
  const l1 = planLevel1Prune({ units, nodes: input.nodes, episodes: input.episodes });
  const byId = new Map(units.map(unit => [unit.id, unit] as const));
  const nodes = new Map<NodeId, ToolResultNode>();
  for (const node of input.nodes) {
    if (node.kind === "tool-result" && !nodes.has(node.id)) nodes.set(node.id, node);
  }
  const protectedIds = new Set(input.protectedUnitIds);
  const excluded: PrunePassExclusion[] = units
    .filter(unit => protectedIds.has(unit.id))
    .map(unit => ({ unitId: unit.id, reason: "protected" }));

  const items: PruneAskItem[] = [];
  for (const unitId of l1.kept) {
    if (protectedIds.has(unitId)) continue;
    const unit = byId.get(unitId);
    // L1's kept list is drawn from these units, so this cannot miss; skipping
    // would drop a unit from the ask, which is the one thing the ask must not do.
    if (unit === undefined) continue;
    const node = nodes.get(unit.nodeId);
    const facts = input.callFacts?.get(unit.nodeId);
    items.push({
      unit,
      ...(node === undefined ? {} : { node }),
      ...(facts === undefined ? {} : { callFacts: facts }),
    });
  }
  const askRows = buildPruneAskRows(items);
  const stamps = new Map<number, WireStamp>();
  for (const row of askRows) {
    stamps.set(row.index, { unitId: row.unit.id, answeredInRound: round });
  }
  return {
    round, l1, askRows, excluded, stamps, units,
    tables: buildAskTables(askRows, input.tableOptions),
  };
}

/**
 * The pass's tables: repeated `nextTable` over the ask rows until the queue is
 * empty. A pass plan carries no re-asks (no reply exists yet), so no table has
 * carried rows; the fresh rows a table took are exactly its rows.
 */
function buildAskTables(
  rows: readonly PruneAskRow[],
  options: NextTableOptions = {},
): readonly PruneAskTable[] {
  const tables: PruneAskTable[] = [];
  let queue: readonly PruneAskRow[] = rows;
  while (queue.length > 0) {
    const table = nextTable(queue, options);
    tables.push(table);
    queue = queue.slice(table.rows.length - table.carried);
  }
  return tables;
}

/**
 * The estimate the bench and the meter share: four bytes per token, rounded up —
 * `CharHeuristicTokenMeter`'s rule, computed without materialising the bytes.
 *
 * `l1RemovalsBytes` counts the L1 removals this pass would act on, so an
 * excluded unit's proof adds nothing (it removes nothing). `askTableTokens` is
 * the sum over the pass's tables, each measured at its own rendered table (the
 * heading repeats per table). `total` is `ceil(l1RemovalsBytes / 4) +
 * askTableTokens`: the cost of the pass in the one unit the product reports,
 * with the history and the final instruction line excluded because they are the
 * caller's budget, not the pass's.
 */
export function estimatePassTokens(plan: PrunePassPlan): {
  readonly l1RemovalsBytes: number;
  readonly askTableTokens: number;
  readonly total: number;
} {
  const excluded = new Set(plan.excluded.map(entry => entry.unitId));
  const byId = new Map(plan.units.map(unit => [unit.id, unit] as const));
  let l1RemovalsBytes = 0;
  for (const removal of plan.l1.removals) {
    if (excluded.has(removal.unitId)) continue;
    l1RemovalsBytes += byId.get(removal.unitId)?.byteLength ?? 0;
  }
  const askTableTokens = plan.tables.reduce(
    (sum, table) => sum + Math.ceil(byteLengthOf(renderPruneAskTable(table.rows)) / 4),
    0,
  );
  return { l1RemovalsBytes, askTableTokens, total: Math.ceil(l1RemovalsBytes / 4) + askTableTokens };
}
