/**
 * The L2 ask's attempt counters (ISSUE-022 chunk 6; ADR-0009 §Amendment
 * 2026-10-24 — twelve-unit tables, carry-over re-ask).
 *
 * The amendment's tuning promise is "tune the 12 by the agent's wrong-answer
 * rate", so the loop needs counters: one per table attempt group, and four per
 * pass. This module owns those counters and the answer-reading primitives they
 * share with the scheduler; `./ask-carry.ts` owns the scheduler itself (what the
 * next table carries) and imports the primitives from here, so one reading of a
 * reply serves both.
 *
 * A refusal code here means KEEP: every count is a fail-open branch, never a
 * removal claim.
 */

import type { PruneAnswerRefusalCode, PruneAnswerRow } from "./ask-answer.js";
import { PRUNE_ANSWER_REFUSAL_CODES } from "./ask-answer.js";
import type { PruneAskRow } from "./ask-message.js";
import type { PruneCarryOverPlan } from "./ask-carry.js";

/** The code for an index with no outcome (no verdict given). */
export const ABSENT_CODE: PruneAnswerRefusalCode = "missing-index";

/** One table attempt as counters — the unit a wrong-answer rate is figured from. */
export interface PruneTableAttempt {
  /** Rows the table asked; the unit limit is `PRUNE_ASK_MAX_TABLE_UNITS`. */
  readonly tableUnits: number;
  readonly attempt: number;
  readonly answered: number;
  /** One count per refusal code, the key order fixed by the code list. */
  readonly refusedByCode: Readonly<Record<PruneAnswerRefusalCode, number>>;
}

/** The pass counts: tables sent, rows carried, rows re-asked, rows kept. */
export interface PrunePassAttemptTotals {
  readonly tables: number;
  readonly carried: number;
  readonly reasked: number;
  /** Rows whose last attempt still refused; every one is kept. */
  readonly finalRefusals: number;
}

/**
 * Counts one table attempt. An index absent from the reply counts as
 * `missing-index`, so `answered` plus the `refusedByCode` sum is the table's
 * unit count. Outcomes naming an index this table never asked are ignored: they
 * belong to another table of the pass and no unit of this one is affected.
 */
export function summarizeTableAttempt(
  table: readonly PruneAskRow[],
  outcomes: readonly PruneAnswerRow[],
  attempt: number,
): PruneTableAttempt {
  checkedTable(table);
  checkedAttempt(attempt);
  const byIndex = outcomeMap(outcomes);
  const refusedByCode = Object.fromEntries(
    PRUNE_ANSWER_REFUSAL_CODES.map(code => [code, 0] as const),
  ) as Record<PruneAnswerRefusalCode, number>;
  let answered = 0;
  for (const row of table) {
    const outcome = byIndex.get(row.index);
    if (outcome?.status === "answered") answered += 1;
    else refusedByCode[codeOf(outcome)] += 1;
  }
  return { tableUnits: table.length, attempt, answered, refusedByCode };
}

/**
 * Folds the pass's per-table plans into its four counts. A carry counts as
 * `carried` the moment it is flagged; it counts as `reasked` only when a later
 * table actually asks that index — a pass cut short after a halt carries rows it
 * never re-asks, and the gap shows here instead of hiding. Indices are assigned
 * once per pass, so a match by index names one row.
 *
 * `tables` is the count of tables actually SENT and must come from the table
 * loop (CRITIC-022 P2 #4): a table settles ONE PLAN PER ATTEMPT GROUP, so a
 * single table mixing fresh rows with carried re-asks settles two or more
 * plans, and counting `plans.length` over-reports a pass of eight tables as
 * twelve or more — exactly the number the 12-unit tuning is judged by. A table
 * whose reply never arrived still counts (it was sent); its rows are halt
 * refusals in the pass record (`refusedCount`), where a non-zero refusal count
 * beside a zero answered count is read as a halt, never as an untried pass.
 */
export function summarizePassAttempts(
  plans: readonly PruneCarryOverPlan[],
  tables: number,
): PrunePassAttemptTotals {
  if (!Number.isSafeInteger(tables) || tables < 0) {
    throw new RangeError("tables must be a non-negative safe integer.");
  }
  let carried = 0;
  let reasked = 0;
  let finalRefusals = 0;
  for (const [position, plan] of plans.entries()) {
    carried += plan.carry.length;
    finalRefusals += plan.final.length;
    if (plan.carry.length === 0) continue;
    const later = new Set<number>();
    for (const next of plans.slice(position + 1)) {
      for (const row of next.table) later.add(row.index);
    }
    for (const entry of plan.carry) if (later.has(entry.index)) reasked += 1;
  }
  return { tables, carried, reasked, finalRefusals };
}

/** The code an outcome reads as; an absent outcome is a missing answer. */
export function codeOf(outcome: PruneAnswerRow | undefined): PruneAnswerRefusalCode {
  if (outcome === undefined) return ABSENT_CODE;
  return outcome.status === "refused" ? outcome.code : ABSENT_CODE;
}

/** One outcome per index; a repeat keeps the last, the latest attempt's reading. */
export function outcomeMap(
  outcomes: readonly PruneAnswerRow[],
): ReadonlyMap<number, PruneAnswerRow> {
  const byIndex = new Map<number, PruneAnswerRow>();
  for (const outcome of outcomes) byIndex.set(outcome.index, outcome);
  return byIndex;
}

/** A table is one address per row; a duplicate or bad index is a caller bug. */
export function checkedTable(table: readonly PruneAskRow[]): void {
  const seen = new Set<number>();
  for (const row of table) {
    if (!Number.isSafeInteger(row.index) || row.index < 1) {
      throw new RangeError("Every carry-over row index must be a positive safe integer.");
    }
    if (seen.has(row.index)) {
      throw new RangeError(`A carry-over table names index ${String(row.index)} twice.`);
    }
    seen.add(row.index);
  }
}

/** An attempt ordinal is 1-based; anything else is a caller bug. */
export function checkedAttempt(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt must be a positive safe integer.");
  }
  return attempt;
}
