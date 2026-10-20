import type { Bytes } from "../types/identity.js";

export type { ApiUsage, UsageObservation, MeterReading } from "../types/telemetry.js";

export interface TokenMeter {
  estimate(bytes: Bytes): number;
}

/** A deterministic byte-count estimate; callers can inject a provider tokenizer. */
export class CharHeuristicTokenMeter implements TokenMeter {
  estimate(bytes: Bytes): number {
    return Math.ceil(bytes.byteLength / 4);
  }
}
