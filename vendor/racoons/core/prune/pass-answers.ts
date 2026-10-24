/**
 * Reading a pass's answers into per-index outcomes (ISSUE-022 chunk 6; ADR-0009).
 *
 * Split from `./pass-merge.ts` at the file cap, by concern: this module reads
 * answer TEXTS against the pass's assigned indices and decides each index; that
 * module turns the decisions into the pass's decision document. The split keeps
 * one reading of a reply per purpose — the carry scheduler reads a single table,
 * this reads a whole pass.
 *
 * FINAL-ANSWER precedence (chunk 6): the texts are one pass's attempts, in
 * attempt order. A valid answer outranks every refusal for its index — a
 * malformed table-1 row never poisons table 2's valid answer, and a malformed
 * later row never undoes an earlier valid one. With no valid answer the LAST
 * attempt's refusal is the reported one, so the code names what finally
 * happened. Two valid answers for one index stay ambiguous and keep the unit.
 *
 * Fail-open, per index (a prune asks; it never burns a unit by silence):
 * `keepall` keeps; a refusal — missing, duplicated, malformed, unreadable —
 * keeps the unit and is reported in `refused`; an answer with a duplicate index
 * is kept whole, never partly read; a key the ask never assigned lands in
 * `rejected` and names no unit. The only throws are caller bugs — an index this
 * pass never assigned, an index listed twice, a stamp naming another unit.
 * Answer data never throws.
 */

import type { UnitId } from "../types/identity.js";
import type { WireAnswer, WireStamp } from "../verdicts/wire.js";
import { parsePruneAnswer } from "./ask-answer.js";
import type { PruneAnswerRejection } from "./ask-answer.js";
import type { PruneAskRow } from "./ask.js";
import type { PrunePassPlan } from "./pass.js";
import { mergePass } from "./pass-merge.js";
import type { PrunePassApplication, PrunePassRefusal } from "./pass-merge.js";

export interface PrunePassAnswerInput {
  /** The indices the supplied answers cover; each must be assigned by this pass. */
  readonly indices: readonly number[];
  /** The stamp per index, as the asks were sent. */
  readonly stamps: ReadonlyMap<number, WireStamp>;
}

type ParsedRefusal = PrunePassRefusal & { readonly status: "refused" };
type ParsedAnswered = { readonly status: "answered"; readonly index: number; readonly answer: WireAnswer };
type ParsedRow = ParsedAnswered | ParsedRefusal;

/**
 * Merges the answer texts into the pass. Each text is one batch's answer, read
 * against the SAME index space, so a split display still yields one decision set
 * and one epoch break (ADR-0009).
 *
 * A single answer per index decides it, whatever any other text said about
 * that index. Two answers for one index keep the unit: the pair is ambiguous,
 * and the pass would rather keep than pick. With no answer, the last text's
 * refusal is reported; with nothing at all the fallback is `missing-index`, so
 * a parser bug keeps, never burns.
 */
export function applyPruneAnswers(
  plan: PrunePassPlan,
  answerTexts: readonly string[],
  input: PrunePassAnswerInput,
): PrunePassApplication {
  const rows = new Map<number, PruneAskRow>(plan.askRows.map(row => [row.index, row] as const));
  const indices = assignedIndices(rows, input);
  const outcomes = new Map<number, ParsedRow[]>();
  const rejected: (PruneAnswerRejection & { readonly answerIndex: number })[] = [];
  for (const [answerIndex, text] of answerTexts.entries()) {
    if (indices.length === 0) break;
    const parsed = parsePruneAnswer(text, { indices, stamps: input.stamps });
    for (const row of parsed.rows) {
      const list = outcomes.get(row.index) ?? [];
      list.push(row.status === "answered"
        ? { status: "answered", index: row.index, answer: row.answer }
        : {
            status: "refused", unitId: row.unitId, index: row.index, code: row.code,
            message: row.message, wireCode: row.wireCode, answerIndex,
          });
      outcomes.set(row.index, list);
    }
    for (const entry of parsed.rejected) rejected.push({ ...entry, answerIndex });
  }

  const verdicts = new Map<UnitId, WireAnswer>();
  const refusals = new Map<UnitId, PrunePassRefusal>();
  for (const index of indices) {
    const row = rows.get(index);
    if (row === undefined) continue;
    const list = outcomes.get(index) ?? [];
    const answered = list.filter((entry): entry is ParsedAnswered => entry.status === "answered");
    const only = answered[0];
    // Final-answer precedence: one valid answer decides the index, whatever an
    // earlier or later attempt said. Two valid answers are ambiguous, so keep.
    if (answered.length === 1 && only !== undefined) {
      verdicts.set(row.unit.id, only.answer);
      continue;
    }
    if (answered.length > 1) {
      refusals.set(row.unit.id, {
        unitId: row.unit.id, index, code: "duplicate-index", answerIndex: null, wireCode: null,
        message: `Index ${String(index)} was answered more than once; that unit is kept.`,
      });
      continue;
    }
    // No valid answer: the LAST attempt's refusal names what finally happened.
    const last = list[list.length - 1];
    refusals.set(row.unit.id, last?.status === "refused" ? last : {
      unitId: row.unit.id, index, code: "missing-index", answerIndex: null, wireCode: null,
      message: `No verdict was given for index ${String(index)}; that unit is kept.`,
    });
  }

  return mergePass(plan, verdicts, refusals, rejected);
}

/** The supplied indices, each assigned by this pass and stamped with its unit. */
function assignedIndices(
  rows: ReadonlyMap<number, PruneAskRow>,
  input: PrunePassAnswerInput,
): readonly number[] {
  const seen = new Set<number>();
  const indices: number[] = [];
  for (const index of input.indices) {
    const row = rows.get(index);
    if (row === undefined) throw new RangeError(`Index ${String(index)} is not assigned by this pass.`);
    if (seen.has(index)) throw new RangeError(`Index ${String(index)} is listed twice.`);
    seen.add(index);
    const stamp = input.stamps.get(index);
    if (stamp?.unitId !== row.unit.id) {
      throw new RangeError(`The stamp for index ${String(index)} does not name its unit.`);
    }
    indices.push(index);
  }
  return indices;
}
