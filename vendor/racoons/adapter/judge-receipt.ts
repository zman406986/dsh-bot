/**
 * The one receipt a judge pass leaves in main (ISSUE-026 chunk 3, ADR-0010).
 *
 * Main receives exactly one user-role message per pass and none of the fork's
 * dialogue. The receipt is terse on purpose: what the pass did, and where the
 * removed bytes can be restored from. Counts come from the pass's own tallies;
 * recall ids are the ones the applied application minted.
 */
import type { EngineResult, Verdict } from '@racoons/core';

export interface JudgeReceiptInput {
  readonly round: number;
  readonly gate: 'turn' | 'revisit';
  readonly units: number;
  /** False when no fork could be seeded: nothing was asked at all. */
  readonly seeded: boolean;
  readonly answered: number;
  readonly keepall: number;
  readonly keeplines: number;
  readonly forgetall: number;
  readonly noVerdict: number;
  readonly result: EngineResult | null;
  readonly recallIds: readonly string[];
}

/** One pass's receipt, counted from the verdicts it settled. */
export interface JudgePassReceiptInput {
  readonly round: number;
  readonly gate: 'turn' | 'revisit';
  readonly units: number;
  /** False when no fork could be seeded: nothing was asked at all. */
  readonly seeded: boolean;
  readonly verdicts: readonly Verdict[];
  readonly result: EngineResult;
  readonly recallIds: readonly string[];
}

/** Counts one pass's verdicts by action and renders its receipt line. */
export function passReceiptText(input: JudgePassReceiptInput): string {
  const count = (action: Verdict['action']): number =>
    input.verdicts.filter(verdict => verdict.action === action).length;
  return judgeReceiptText({ round: input.round, gate: input.gate, units: input.units,
    seeded: input.seeded, answered: input.verdicts.length, keepall: count('keepall'),
    keeplines: count('keeplines'), forgetall: count('forgetall'),
    noVerdict: input.units - input.verdicts.length, result: input.result,
    recallIds: input.recallIds });
}

/** One pass's receipt, with the one seam that appends it to main. */
export interface AppendPassReceiptInput
  extends Omit<JudgePassReceiptInput, 'seeded' | 'recallIds'> {
  /** False when no fork could be seeded: nothing was asked, so main is untouched. */
  readonly asking: boolean;
  /** The ids the applied application minted; drained on every pass. */
  readonly mintedRecallIds: readonly string[];
  /** The one append seam: exactly one user-role receipt per pass that asked. */
  readonly append?: (text: string) => void;
  /** Named once if the append seam throws; never rethrown into the host's step. */
  readonly onAppendError?: (error: unknown) => void;
}

/**
 * Build the pass's one receipt and append it, unless the pass asked nothing.
 * Recall ids only ride a receipt the engine reported `applied`: a refused cut
 * mints none, and quoting one would point at a removal that never happened.
 */
export function appendPassReceipt(input: AppendPassReceiptInput): string {
  const text = passReceiptText({ ...input, seeded: input.asking,
    recallIds: input.result.status === 'applied' ? input.mintedRecallIds : [] });
  if (!input.asking) return text;
  try { input.append?.(text); }
  catch (error) { input.onAppendError?.(error); }
  return text;
}

/** The receipt line: one line, counts first, recall pointers last. */
export function judgeReceiptText(input: JudgeReceiptInput): string {
  const head = `[racoons] judge round ${String(input.round)} (${input.gate})`;
  const units = String(input.units);
  if (!input.seeded) {
    return `${head}: ${units} units kept — main's sent request was not captured; nothing asked.`;
  }
  const counts = `${String(input.answered)} answered (${String(input.keepall)} keepall, `
    + `${String(input.keeplines)} keeplines, ${String(input.forgetall)} forgetall), `
    + `${String(input.noVerdict)} no verdict`;
  const status = input.result === null ? 'not settled' : `engine ${input.result.status}`;
  const recall = input.recallIds.length === 0
    ? '' : ` · recall ${input.recallIds.join(', ')}`;
  return `${head}: ${units} units — ${counts}; ${status}${recall}`;
}
