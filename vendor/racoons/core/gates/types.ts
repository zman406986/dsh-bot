import type { UnitId } from "../types/identity.js";
import type { VerdictBatch } from "../verdicts/types.js";
import type { ProcessingUnit } from "../units/types.js";

/** The two forced moments of the protocol (PRD §6.5). */
export type GateKind = "turn" | "revisit";

/** What the gate may show the agent; both numbers are configuration. */
export interface GateBudget {
  /** The advertised label length; enforcement carries hidden headroom. */
  readonly advertisedLabelLimit: number;
  /** Re-asks allowed before the gate fails open. */
  readonly retryLimit: number;
}

/**
 * One structured list put to the agent. A resumed gate lists only the units
 * still unanswered (incremental completion), never the whole window again.
 */
export interface GatePresentation {
  readonly kind: GateKind;
  readonly round: number;
  readonly units: readonly ProcessingUnit[];
  readonly budget: GateBudget;
}

/**
 * What settling a presentation produced. `failed-open` is bounded
 * enforcement reaching its retry cap: nothing is applied for the unanswered
 * units and the failure is reported, never hidden.
 */
export type GateOutcome =
  | { readonly status: "settled"; readonly batch: VerdictBatch }
  | {
      readonly status: "incomplete";
      readonly unanswered: readonly UnitId[];
      readonly retriesLeft: number;
    }
  | {
      readonly status: "failed-open";
      readonly unanswered: readonly UnitId[];
      readonly reason: "retry-cap";
    };
