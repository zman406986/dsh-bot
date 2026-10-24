import type { Bytes } from "../types/identity.js";
import { MeterError } from "./errors.js";
import type { ApiUsage, TokenMeter } from "./token-meter.js";

export interface FakeTokenMeterOptions {
  readonly estimates: readonly number[];
  readonly usages: readonly ApiUsage[];
}

export class FakeTokenMeter implements TokenMeter {
  private readonly estimates: readonly number[];
  private readonly usages: readonly ApiUsage[];
  private estimateIndex = 0;
  private usageIndex = 0;

  constructor(options: FakeTokenMeterOptions) {
    this.estimates = [...options.estimates];
    this.usages = options.usages.map((usage) => Object.freeze({ ...usage }));
  }

  estimate(_bytes: Bytes): number {
    const estimate = this.estimates[this.estimateIndex];
    if (estimate === undefined) {
      throw new MeterError(
        "script-exhausted",
        `Estimate script exhausted at index ${this.estimateIndex}`,
      );
    }
    this.estimateIndex += 1;
    return estimate;
  }

  nextUsage(): ApiUsage {
    const usage = this.usages[this.usageIndex];
    if (usage === undefined) {
      throw new MeterError(
        "script-exhausted",
        `Usage script exhausted at index ${this.usageIndex}`,
      );
    }
    this.usageIndex += 1;
    return usage;
  }
}
