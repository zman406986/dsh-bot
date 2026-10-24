/**
 * The `prune-recorded` event's fields (ISSUE-022 chunk 5; ADR-0009).
 *
 * Record-only means the pass is telemetry and nothing else: no receipt, no
 * recall id, no ledger kind, no transcript byte (ADR-0008). So the record is
 * counts, named by the rule or action or refusal code that produced them — a
 * reader can see what a pass decided without the units or their bytes.
 *
 * Two counting rules matter:
 *
 *   - `l1RemovalCount` counts the L1 removals the pass would ACT on, so a
 *     protected unit's proof is not counted (the proof stands, but protection
 *     overrides every layer and the pass removes nothing — the same rule
 *     `estimatePassTokens` uses).
 *   - a pass that sent no ask has no judged counts. `application: null` means
 *     exactly that (no model seam), so L2, refusals and rejections are zero
 *     rather than "every index refused" — nothing was asked, so nothing was
 *     refused.
 *
 * Pure and deterministic: the same plan and application yield the same fields,
 * the key order is fixed by the constant lists, and no input is mutated.
 */

import type { UnitId } from "../types/identity.js";
import type { PruneAnswerRefusalCode } from "./ask-answer.js";
import { PRUNE_ANSWER_REFUSAL_CODES } from "./ask-answer.js";
import type { PrunePassAttemptTotals, PruneTableAttempt } from "./attempts.js";
import type { PrunePassPlan } from "./pass.js";
import { estimatePassTokens } from "./pass.js";
import type { PrunePassApplication } from "./pass-merge.js";
import type { Level1Rule } from "./types.js";
import { LEVEL1_RULES } from "./level1.js";

/** The L2 actions a pass can act on; `keepall` removes nothing and is not counted. */
export const PRUNE_REMOVAL_ACTIONS = ["keeplines", "forgetall"] as const;

export type PruneRemovalAction = (typeof PRUNE_REMOVAL_ACTIONS)[number];

/**
 * The pass's attempt telemetry (ISSUE-022 chunk 6): one entry per table attempt
 * group and the four pass totals. `null` when the caller has no table loop (a
 * direct merge, an unasked pass), never a fabricated zero table.
 */
export interface PruneAttemptTelemetry {
  /** One entry per attempt group, in table order: `summarizeTableAttempt`'s shape. */
  readonly tables: readonly PruneTableAttempt[];
  /** `summarizePassAttempts`'s four counts. */
  readonly pass: PrunePassAttemptTotals;
}

/** One pass as counters, ready to journal. No identity of any unit is carried. */
export interface PruneRecordedFields {
  /** The pass's round ordinal, the same one stamped on every assigned index. */
  readonly round: number;
  /** Removals L1 proved and the pass would act on, one count per rule family. */
  readonly l1RemovalCount: Readonly<Record<Level1Rule, number>>;
  /** Removals the ask decided, one count per action. */
  readonly l2RemovalCount: Readonly<Record<PruneRemovalAction, number>>;
  /** Units protection kept out of the pass entirely. */
  readonly excludedCount: number;
  /** Units whose answer could not be read, one count per refusal code. */
  readonly refusedCount: Readonly<Record<PruneAnswerRefusalCode, number>>;
  /** Keys that addressed no unit of this pass; no unit is affected by one. */
  readonly rejectedCount: number;
  /** The pass's cost estimate; the same values `estimatePassTokens` returns. */
  readonly estTokens: {
    readonly l1RemovalsBytes: number;
    readonly askTableTokens: number;
    readonly total: number;
  };
  /** Per-table attempts; empty when the caller supplied none. */
  readonly tableAttempts: readonly PruneTableAttempt[];
  /** The pass's attempt totals; all zero when the caller supplied none. */
  readonly passAttempts: PrunePassAttemptTotals;
}

/** The attempt totals of a pass with no table loop: nothing asked, nothing carried. */
const NO_ATTEMPTS: PrunePassAttemptTotals = Object.freeze(
  { tables: 0, carried: 0, reasked: 0, finalRefusals: 0 },
);

/**
 * Builds the record for one pass. `application` is the merged answer document,
 * or `null` when no ask was sent (no model seam), in which case only the plan's
 * own provable layer is counted.
 */
export function pruneRecordOf(
  plan: PrunePassPlan,
  application: PrunePassApplication | null,
  attempts: PruneAttemptTelemetry | null = null,
): PruneRecordedFields {
  const excluded = new Set<UnitId>(plan.excluded.map(entry => entry.unitId));
  const l1RemovalCount: Record<Level1Rule, number> = Object.fromEntries(
    LEVEL1_RULES.map(rule => [rule, 0] as const),
  ) as Record<Level1Rule, number>;
  const l2RemovalCount: Record<PruneRemovalAction, number> = Object.fromEntries(
    PRUNE_REMOVAL_ACTIONS.map(action => [action, 0] as const),
  ) as Record<PruneRemovalAction, number>;
  const refusedCount: Record<PruneAnswerRefusalCode, number> = Object.fromEntries(
    PRUNE_ANSWER_REFUSAL_CODES.map(code => [code, 0] as const),
  ) as Record<PruneAnswerRefusalCode, number>;
  if (application === null) {
    // No ask was sent: count only what bytes proved and protection lets through.
    for (const removal of plan.l1.removals) {
      if (excluded.has(removal.unitId)) continue;
      l1RemovalCount[removal.rule] += 1;
    }
  } else {
    for (const removal of application.removals) {
      if (removal.origin === "l1") l1RemovalCount[removal.rule] += 1;
      else l2RemovalCount[removal.action] += 1;
    }
    for (const refusal of application.refused) refusedCount[refusal.code] += 1;
  }
  return {
    round: plan.round,
    l1RemovalCount,
    l2RemovalCount,
    excludedCount: plan.excluded.length,
    refusedCount,
    rejectedCount: application === null ? 0 : application.rejected.length,
    estTokens: estimatePassTokens(plan),
    tableAttempts: attempts?.tables ?? [],
    passAttempts: attempts?.pass ?? NO_ATTEMPTS,
  };
}
