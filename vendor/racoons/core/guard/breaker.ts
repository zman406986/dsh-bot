import type { BreakerState } from "./types.js";

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
  recordSuccess(nonEmpty: boolean): void {
    if (nonEmpty && !this.#disabled) this.#failures = 0;
  }
  recordFailure(): void {
    if (this.#disabled) return;
    this.#failures = this.#failures === 0 ? 1 : 2;
    this.#disabled = this.#failures === 2;
  }
}
