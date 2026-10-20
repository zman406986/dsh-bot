import type { Bytes } from "../types/identity.js";
import { MeterError } from "./errors.js";
import type {
  MeterReading,
  TokenMeter,
  UsageObservation,
} from "./token-meter.js";

function assertCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MeterError(
      "invalid-count",
      `${field} must be a non-negative safe integer; received ${String(value)}`,
    );
  }
}

export class Meter {
  private readonly tokenMeter: TokenMeter;
  private reading: MeterReading | null = null;

  constructor(tokenMeter: TokenMeter) {
    this.tokenMeter = tokenMeter;
  }

  estimate(bytes: Bytes): number {
    const estimate = this.tokenMeter.estimate(bytes);
    assertCount(estimate, "estimatedInputTokens");
    return estimate;
  }

  reconcile(observation: UsageObservation): MeterReading {
    const { inputTokens, outputTokens } = observation.usage;
    // Some adapters omit this field at runtime; absence is still unknown.
    const cachedInputTokens = observation.usage.cachedInputTokens ?? null;
    assertCount(observation.estimatedInputTokens, "estimatedInputTokens");
    assertCount(inputTokens, "inputTokens");
    assertCount(outputTokens, "outputTokens");
    if (cachedInputTokens !== null) {
      assertCount(cachedInputTokens, "cachedInputTokens");
      if (cachedInputTokens > inputTokens) {
        throw new MeterError(
          "inconsistent-usage",
          "cachedInputTokens must not exceed inputTokens",
        );
      }
    }

    const reading: MeterReading = Object.freeze({
      requestId: observation.requestId,
      revision: observation.revision,
      estimatedInputTokens: observation.estimatedInputTokens,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      estimateErrorTokens: inputTokens - observation.estimatedInputTokens,
      cachedInputShare:
        cachedInputTokens === null || cachedInputTokens === 0 || inputTokens === 0
          ? null
          : cachedInputTokens / inputTokens,
    });
    this.reading = reading;
    return reading;
  }

  latest(): MeterReading | null {
    return this.reading;
  }
}
