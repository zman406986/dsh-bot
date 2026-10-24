import type { UnitId } from "../types/identity.js";
import type { ProcessingUnit } from "../units/types.js";
import type { Verdict, VerdictState } from "./types.js";

/**
 * What one `judge` call did. A rejection is reported, never silently ignored:
 * the gate decides whether to re-ask or fail open, and the tracker never
 * overwrites a decision the agent already made.
 */
export type JudgeOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly existing: Verdict }
  | { readonly status: "unknown-unit" };

export interface VerdictTrackerOptions {
  /** The units of one gate window, in transcript order. */
  readonly units: readonly ProcessingUnit[];
  /** The window's round ordinal; monotonic per session. Defaults to 0. */
  readonly round?: number;
}

/**
 * In-memory verdict state for one gate window (design-protocol §2). It never
 * persists anything: every verdict already leaves a durable trace in the
 * transcript, and a second store of truth is banned. A resumed gate re-asks the
 * units `pending` still lists.
 *
 * The window is fixed at construction. A verdict for a unit the window does not
 * hold is `unknown-unit`, and a second verdict for a judged unit is
 * `duplicate`; neither is recorded.
 */
export class VerdictTracker {
  #round: number;
  readonly #order: readonly ProcessingUnit[];
  readonly #units: ReadonlyMap<UnitId, ProcessingUnit>;
  readonly #verdicts = new Map<UnitId, Verdict>();

  constructor(options: VerdictTrackerOptions) {
    const round = options.round ?? 0;
    if (!Number.isSafeInteger(round) || round < 0) {
      throw new Error("Verdict round must be a non-negative safe integer");
    }
    const units = new Map<UnitId, ProcessingUnit>();
    for (const unit of options.units) {
      // Two units with one id would silently shrink the window: refuse instead.
      if (units.has(unit.id)) {
        throw new Error(`Duplicate processing unit ${unit.id} in one verdict window`);
      }
      units.set(unit.id, unit);
    }
    this.#round = round;
    this.#order = [...options.units];
    this.#units = units;
  }

  /** The current gate round ordinal; verdicts answer within it. */
  get round(): number {
    return this.#round;
  }

  /** Units with no verdict yet, in window order. Never judged by omission. */
  pending(): readonly ProcessingUnit[] {
    return this.#order.filter(unit => !this.#verdicts.has(unit.id));
  }

  /** True exactly when every unit in the window carries a verdict. */
  isComplete(): boolean {
    return this.#order.every(unit => this.#verdicts.has(unit.id));
  }

  judge(verdict: Verdict): JudgeOutcome {
    if (!this.#units.has(verdict.unitId)) return { status: "unknown-unit" };
    const existing = this.#verdicts.get(verdict.unitId);
    if (existing !== undefined) return { status: "duplicate", existing };
    this.#verdicts.set(verdict.unitId, { ...verdict });
    return { status: "accepted" };
  }

  /** Opens the next round of the same window for a re-ask; returns its ordinal. */
  nextRound(): number {
    this.#round += 1;
    return this.#round;
  }

  /** The state the planner consumes; verdicts follow window order, not arrival order. */
  state(): VerdictState {
    const verdicts: Verdict[] = [];
    for (const unit of this.#order) {
      const verdict = this.#verdicts.get(unit.id);
      if (verdict !== undefined) verdicts.push({ ...verdict });
    }
    return { round: this.#round, units: this.#order, verdicts };
  }
}
