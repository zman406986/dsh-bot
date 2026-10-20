import type { BreakerState, ValidationIssue } from "../guard/types.js";
import type {
  EpisodeId,
  EventId,
  IntentId,
  RecallId,
  Revision,
  RuleId,
  SessionId,
  Sha256,
} from "./identity.js";

export interface ApiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
}

export interface UsageObservation {
  readonly kind: "usage";
  readonly requestId: string;
  readonly revision: Revision;
  readonly estimatedInputTokens: number;
  readonly usage: ApiUsage;
}

export interface MeterReading {
  readonly requestId: string;
  readonly revision: Revision;
  readonly estimatedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly estimateErrorTokens: number;
  readonly cachedInputShare: number | null;
}

export interface ForcedLossObservation {
  readonly kind: "forced-loss";
  readonly nativeEventId: string;
  readonly turnOrdinal: number;
  readonly inputTokensBefore: number | null;
  readonly inputTokensAfter: number | null;
}

export type HarnessObservation =
  | UsageObservation
  | ForcedLossObservation;

export interface TelemetryBase {
  readonly sessionId: SessionId;
  readonly atMs: number;
}

export type TelemetryEvent = TelemetryBase & (
  | {
      readonly kind: "usage-reconciled";
      readonly reading: MeterReading;
    }
  | {
      readonly kind: "validation";
      readonly eventId: EventId;
      readonly ok: boolean;
      readonly issues: readonly ValidationIssue[];
      readonly breaker: BreakerState;
    }
  | {
      readonly kind: "application";
      readonly intentId: IntentId;
      readonly outcome: "applied" | "not-applied" | "unknown";
      readonly removedBytes: number;
      readonly generatedBytes: number;
      readonly recallIds: readonly RecallId[];
      readonly sealedEpisodeIds: readonly EpisodeId[];
    }
  | {
      readonly kind: "recall";
      readonly recallId: RecallId;
      readonly restoredBytes: number;
    }
  | {
      readonly kind: "refetch";
      readonly sourceSha256: Sha256;
      readonly recallId: RecallId;
      readonly fetchedBytes: number;
    }
  | {
      readonly kind: "forced-loss";
      readonly observation: ForcedLossObservation;
    }
  | {
      readonly kind: "skip";
      readonly eventId: EventId;
      readonly ruleId: RuleId | null;
      readonly reason:
        | "no-plan"
        | "configuration-required"
        | "unsupported-capability"
        | "seal-latency"
        | "recovery-pending";
    }
  | {
      readonly kind: "breaker-disabled";
      readonly consecutiveValidationFailures: 2;
    }
  | {
      readonly kind: "error";
      readonly eventId: EventId | null;
      readonly stage: "rule" | "ledger" | "apply" | "recovery";
      readonly message: string;
    }
);

export type TelemetrySink = (event: TelemetryEvent) => void;
