import type { BreakerState, ValidationIssue } from "../guard/types.js";
import type { PruneRecordedFields } from "../prune/record.js";
import type {
  EpisodeId,
  EventId,
  IntentId,
  NodeId,
  RecallId,
  Revision,
  RuleId,
  SessionId,
  Sha256,
  UnitId,
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
      /**
       * A host answer contradicts the ledger's `applied` receipt (ADR-0015,
       * ISSUE-030 R4). One event per intent and host per engine instance.
       */
      readonly kind: "receipt-conflict";
      readonly intentId: IntentId;
      readonly host: "applied" | "not-applied";
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
      readonly kind: "gate-presented";
      readonly gate: "turn" | "revisit";
      readonly round: number;
      readonly unitIds: readonly UnitId[];
      readonly advertisedLabelLimit: number;
    }
  | {
      readonly kind: "gate-settled";
      readonly gate: "turn" | "revisit";
      readonly round: number;
      /** `failed-open` is bounded enforcement reaching its cap; nothing applied. */
      readonly outcome: "settled" | "incomplete" | "failed-open";
      readonly answered: number;
      readonly unanswered: number;
    }
  | {
      readonly kind: "verdict-recorded";
      readonly round: number;
      readonly unitId: UnitId;
      readonly nodeId: NodeId;
      /** The three-action format of ISSUE-017: what answer the judge gave. */
      readonly action: "keepall" | "keeplines" | "forgetall";
      /**
       * Measured descriptor length in words after normalisation, for a
       * `forgetall`; null when the answer carried no descriptor or is not a
       * `forgetall` (a `keeplines` receipt names ranges, not a description).
       */
      readonly descriptorWords: number | null;
      /** Kept spans the answer named; null unless the action is `keeplines`. */
      readonly keptSpans: number | null;
    }
  | {
      readonly kind: "revert-applied";
      readonly cutIndex: number;
      readonly freedBytes: number;
      readonly keptBytes: number;
      readonly receiptBytes: number;
      readonly netFreedBytes: number;
      readonly survivorCount: number;
    }
  | ({
      /**
       * One record-only big-prune pass (ISSUE-022 chunk 5; ADR-0009). The pass
       * is telemetry only until the apply rollout: nothing moved, so the record
       * is counts, never a receipt, recall id or ledger kind (ADR-0008). The
       * fields and their counting rules are `../prune/record.ts`.
       */
      readonly kind: "prune-recorded";
    } & PruneRecordedFields)
  | {
      readonly kind: "error";
      readonly eventId: EventId | null;
      readonly stage: "rule" | "ledger" | "apply" | "recovery";
      readonly message: string;
    }
);

export type TelemetrySink = (event: TelemetryEvent) => void;
