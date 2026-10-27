import type { BreakerState } from "./types.js";

/**
 * The circuit breaker's whole accounting rule (ISSUE-057): a refusal is the
 * only thing that increments, and every completed validation — empty or not —
 * resets. The disable is therefore per-ask: it quiets the gate until the next
 * validation completes, never latches onto the rest of the run.
 */
export class Breaker {
  #failures: 0 | 1 | 2;
  #disabled: boolean;
  constructor(initial: BreakerState = { consecutiveValidationFailures: 0, disabled: false }) {
    if (![0, 1, 2].includes(initial.consecutiveValidationFailures)
      || initial.disabled !== (initial.consecutiveValidationFailures === 2)) {
      throw new Error("Inconsistent persisted circuit breaker state");
    }
    this.#failures = initial.consecutiveValidationFailures;
    this.#disabled = initial.disabled;
  }
  state(): BreakerState {
    return { consecutiveValidationFailures: this.#failures, disabled: this.#disabled };
  }
  /**
   * Any completed validation. A no-plan pass is a validation of an empty plan
   * set, so it counts exactly like an applied one: the streak ends and a
   * disabled breaker re-arms (ISSUE-057 defect 1 and 2).
   */
  recordSuccess(): void {
    this.#failures = 0;
    this.#disabled = false;
  }
  /** A refusal while disabled is the breaker's own answer, not a new failure. */
  recordFailure(): void {
    if (this.#disabled) return;
    this.#failures = this.#failures === 0 ? 1 : 2;
    this.#disabled = this.#failures === 2;
  }
}
