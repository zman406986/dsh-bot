import type { UnitId } from "../types/identity.js";
import type { ProcessingUnit } from "../units/types.js";

/**
 * The three answers one judgment can give (ISSUE-017). The judge names what it
 * keeps, or it forgets the unit whole and describes what it removed.
 *
 * There is no free-text field on `keepall` or `keeplines`. A verdict carries
 * only what the protocol acts on: the unit, the action, its payload and the
 * round it answers (owner ruling 2026-10-23). `forgetall` keeps its `summary`
 * alone, because the receipt needs that one descriptor.
 */
export type VerdictAction = "keepall" | "keeplines" | "forgetall";

/**
 * One kept span inside a unit, 1-based inclusive. `from` and `to` count lines
 * of the unit's own content from 1, so `1` is the unit's first line. Spans are
 * never unit-external: `to` stops at the unit's last line.
 */
export interface KeptLineSpan {
  readonly from: number;
  readonly to: number;
}

interface VerdictBase {
  readonly unitId: UnitId;
  /** Gate round ordinal, monotonic per session. */
  readonly answeredInRound: number;
}

/** The whole unit is kept: no removal, no receipt. */
export interface KeepAllVerdict extends VerdictBase {
  readonly action: "keepall";
}

/**
 * Named spans are kept; their complement inside the unit is removed. At least
 * one line must be kept and at least one removed: keeping every line is a
 * `keepall` and keeping none is a `forgetall` in disguise, and both are
 * refused by the guard.
 */
export interface KeepLinesVerdict extends VerdictBase {
  readonly action: "keeplines";
  /** Ordered, non-overlapping, in-bounds spans. Never empty. */
  readonly ranges: readonly KeptLineSpan[];
}

/** The whole unit is removed; the receipt carries the descriptor. */
export interface ForgetAllVerdict extends VerdictBase {
  readonly action: "forgetall";
  /**
   * The receipt descriptor: at most 25 words as advertised. `null` or a blank
   * string ships the floor receipt line without one.
   */
  readonly summary: string | null;
}

/**
 * The agent's explicit structured answer for one processing unit (ADR-0006).
 * There are no defaults: every unit above the bar receives one of these.
 */
export type Verdict = KeepAllVerdict | KeepLinesVerdict | ForgetAllVerdict;

export interface VerdictBatch {
  readonly round: number;
  readonly verdicts: readonly Verdict[];
}

/**
 * In-memory protocol state for one session. It is never persisted: every
 * verdict already leaves a durable trace in the transcript (a survivor, or a
 * receipt whose recall id is in the ledger), and PRD §3.5 bans a second source
 * of truth. A resumed gate re-asks the units still listed here.
 */
export interface VerdictState {
  readonly round: number;
  readonly units: readonly ProcessingUnit[];
  readonly verdicts: readonly Verdict[];
}
