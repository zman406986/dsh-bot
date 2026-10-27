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

export interface PrunePassInput {
  /** Every unit still in memory, in transcript order. Duplicate ids are ignored. */
  readonly units: readonly ProcessingUnit[];
  readonly nodes: readonly ToolResultNode[];
  readonly episodes: readonly Episode[];
  /** What the mount knows per node; see `./anchor.ts`. */
  readonly callFacts?: ReadonlyMap<NodeId, PruneCallFacts>;
  /** The pass's round ordinal; stamped on every assigned index. */
  readonly round: number;
  /** Table-builder options; production passes none. */
  readonly tableOptions?: NextTableOptions;
  /**
   * Unit ids a SETTLED entry keep already settled (ISSUE-073): the unit a
   * result checkpoint answered `keepall` for and applied. Omitted or empty
   * excludes nothing. The caller supplies it post-invalidation — a unit a later
   * write invalidated is not settled any more and must not be here.
   */
  readonly settled?: ReadonlySet<UnitId>;
}

/** One pass as a document: the two layers and its ask tables. */
export interface PrunePassPlan {
  readonly round: number;
  /** L1's own verdict. */
  readonly l1: Level1PrunePlan;
  /** L1's kept list, in transcript order. */
  readonly askRows: readonly PruneAskRow[];
  /** `askRows` in contiguous tables of at most twelve units, in order. */
  readonly tables: readonly PruneAskTable[];
  /** `index → unitId + round`, ready for `parsePruneAnswer`. */
  readonly stamps: ReadonlyMap<number, WireStamp>;
  /** Every unit the pass was given, deduplicated, in transcript order. */
  readonly units: readonly ProcessingUnit[];
  /**
   * The units this pass withheld from its ask because a settled entry keep
   * already decided them (ISSUE-073), in transcript order. Always a subset of
   * `l1.kept`; empty when the caller passed no settled set.
   */
  readonly settledWithheld: readonly UnitId[];
}

/**
 * Plans one record-only pass. L1 runs over the units first. The ask covers
 * L1's kept list minus the units a SETTLED entry keep already settled
 * (ISSUE-073): a keep-all the result checkpoint applied is final, so a later
 * pass never re-lists that unit. Every other unit still in memory is re-asked,
 * including units an earlier pass kept, because asking is the only way to learn
 * it is now unneeded (Ruling 8: L2 asks everything still in memory). The
 * settled set is the one exclusion and it is the caller's: a unit whose entry
 * ask failed open, was refused or was never asked is not in it and stays
 * listable. No content class is held back (ADR-0020).
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

  const items: PruneAskItem[] = [];
  const settled = input.settled;
  const withheld: UnitId[] = [];
  for (const unitId of l1.kept) {
    // A settled keep is final (ISSUE-073): the entry checkpoint already decided
    // this unit, so a later table never lists it again. Only the ask is
    // withheld — L1's byte proofs run over every unit regardless.
    if (settled !== undefined && settled.has(unitId)) { withheld.push(unitId); continue; }
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
    round, l1, askRows, stamps, units, settledWithheld: withheld,
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
 * `l1RemovalsBytes` counts the L1 removals this pass would act on. `askTableTokens`
 * is the sum over the pass's tables, each measured at its own rendered table (the
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
  const byId = new Map(plan.units.map(unit => [unit.id, unit] as const));
  let l1RemovalsBytes = 0;
  for (const removal of plan.l1.removals) {
    l1RemovalsBytes += byId.get(removal.unitId)?.byteLength ?? 0;
  }
  const askTableTokens = plan.tables.reduce(
    (sum, table) => sum + Math.ceil(byteLengthOf(renderPruneAskTable(table.rows)) / 4),
    0,
  );
  return { l1RemovalsBytes, askTableTokens, total: Math.ceil(l1RemovalsBytes / 4) + askTableTokens };
}
