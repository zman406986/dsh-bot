import type { SessionId } from "../types/identity.js";
import type { Clock } from "../types/transcript.js";
import type { TelemetrySink } from "../types/telemetry.js";
import type { ProcessingUnit } from "../units/types.js";
import type { VerdictBatch } from "../verdicts/types.js";
import { GateCore } from "./turn-gate.js";
import type { GateBudget, GateOutcome, GatePresentation } from "./types.js";

export interface RevisitGateOptions {
  readonly sessionId: SessionId;
  readonly budget: GateBudget;
  /** The share of the healthy window at which a full revisit falls due; (0, 1]. */
  readonly revisitShare: number;
  readonly clock: Clock;
  readonly onTelemetry?: TelemetrySink;
  /** The circuit breaker probe; see `GateCoreOptions.enabled`. */
  readonly enabled?: () => boolean;
}

/**
 * The full revisit (PRD §6.5, ADR-0007). It fires **early**: `due` is true only
 * while the healthy window's usage is still at or below `revisitShare`, never
 * because context pressure demanded a pass. At the pressure point the room to
 * pay for a full pass is gone, so the gate refuses there and native compaction
 * stays the backstop (PRD §6.1: "nothing fires at pressure").
 *
 * Like the turn gate it presents and settles, but answers live only for the
 * visit: each pass asks all live content again, because a revisit is a full
 * sweep, not an incremental window.
 */
export class RevisitGate {
  readonly #share: number;
  readonly #core: GateCore;
  /** One shot per visit cycle: the mark is a moment, not a level to re-fire on. */
  #fired = false;

  constructor(options: RevisitGateOptions) {
    if (typeof options.revisitShare !== "number" || !Number.isFinite(options.revisitShare)
      || options.revisitShare <= 0 || options.revisitShare > 1) {
      throw new Error("revisitShare must be a number greater than 0 and at most 1.");
    }
    this.#share = options.revisitShare;
    this.#core = new GateCore({
      sessionId: options.sessionId,
      kind: "revisit",
      budget: options.budget,
      clock: options.clock,
      onTelemetry: options.onTelemetry ?? null,
      answersPersist: false,
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    });
  }

  /**
   * Whether a full revisit is due now. `estimated` and `window` are in the same
   * unit: the meter's estimate of live context and the healthy window's size.
   * Due means the usage share is above zero and at or below the configured
   * mark, and this visit cycle has not fired yet.
   *
   * Reading above the mark is the pressure side and is never due: a full pass
   * cannot be paid for there. An unusable reading (non-finite, zero window) is
   * never due either. The call latches on true; `reset` re-arms the cycle.
   */
  due(estimated: number, window: number): boolean {
    if (!Number.isFinite(estimated) || estimated <= 0) return false;
    if (!Number.isFinite(window) || window <= 0) return false;
    if (this.#fired) return false;
    if (estimated > window * this.#share) return false;
    this.#fired = true;
    return true;
  }

  /** Presents the live units; `null` presents nothing. */
  present(units: readonly ProcessingUnit[] | null): GatePresentation | null {
    return this.#core.present(units);
  }

  /** Settles the outstanding revisit; see `GateCore.settle`. */
  settle(batch: VerdictBatch): GateOutcome {
    return this.#core.settle(batch);
  }

  /**
   * Re-arms the one-shot. The design gives no recurrence rule, so the
   * integration step decides when a new visit cycle begins — a manual revisit
   * command, or a new window. After `reset`, `due` fires again at the mark.
   */
  reset(): void {
    this.#fired = false;
  }
}
