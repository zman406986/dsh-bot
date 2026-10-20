import type {
  ByteRange,
  Bytes,
  LineRange,
  NodeId,
  RecallId,
  Revision,
  SearchTarget,
  SessionId,
  Sha256,
  SourceRange,
  SourceRef,
  ToolCallId,
} from "./identity.js";

export interface ToolEvidence {
  readonly kind: "read" | "search" | "glob" | "other";
  readonly target: SearchTarget | null;
  readonly paths: readonly PathEvidence[];
  readonly source: SourceRef;
  readonly sourceRecallId: RecallId | null;
}

export interface PathEvidence {
  readonly pathKey: string;
  readonly displayPath: string;
  readonly title: string | null;
  readonly lineCount: number | null;
  readonly byteLength: number | null;
  readonly outcome: "hit" | "miss" | "unknown";
}

export interface TranscriptNodeBase {
  readonly id: NodeId;
  readonly turnOrdinal: number;
  readonly stepOrdinal: number;
  readonly bytes: Bytes;
  readonly sha256: Sha256;
  readonly byteLength: number;
}

export interface MessageNode extends TranscriptNodeBase {
  readonly kind: "message";
  readonly role: "system" | "developer" | "user" | "assistant";
  readonly toolCallIds: readonly ToolCallId[];
}

export interface ToolResultNode extends TranscriptNodeBase {
  readonly kind: "tool-result";
  readonly callId: ToolCallId;
  readonly evidence: ToolEvidence;
  readonly embeddedRecords: readonly ByteRange[];
}

export interface RacoonsRecordNode extends TranscriptNodeBase {
  readonly kind: "racoons-record";
  readonly recordId: string;
}

export type TranscriptNode =
  | MessageNode
  | ToolResultNode
  | RacoonsRecordNode;

export interface ColdBoundary {
  readonly kind: "resume" | "idle-past-ttl" | "model-switch";
  readonly observedAtMs: number;
}

export type CacheState =
  | {
      readonly kind: "warm";
      readonly watermarkNodeIndex: number;
    }
  | {
      readonly kind: "cold";
      readonly boundary: ColdBoundary;
    }
  | {
      readonly kind: "unknown";
    };

export interface FreshZone {
  readonly startNodeIndex: number;
  readonly endNodeIndexExclusive: number;
}

export interface ProtectionState {
  readonly inFlightTurnOrdinal: number | null;
  readonly newestTailNodeIds: readonly NodeId[];
  readonly openApprovalNodeIds: readonly NodeId[];
  readonly policySpans: readonly SourceRange[];
  readonly quotedThisTurn: readonly SourceRange[];
}

export interface RetentionEvidence {
  readonly kind: "cross-reference" | "access";
  readonly source: SourceRef;
  readonly keepLines: readonly LineRange[];
  readonly witnessNodeIds: readonly NodeId[];
}

export interface SessionSnapshot {
  readonly sessionId: SessionId;
  readonly revision: Revision;
  readonly currentTurnOrdinal: number;
  readonly completedThroughTurnOrdinal: number;
  readonly currentStepOrdinal: number;
  readonly nodes: readonly TranscriptNode[];
  readonly cache: CacheState;
  readonly protection: ProtectionState;
  readonly retentionEvidence: readonly RetentionEvidence[];
}

export interface CapabilityFlags {
  readonly mutateResult: boolean;
  readonly rewriteHistory: boolean;
  readonly atRest: boolean;
  readonly liveTokens: boolean;
  readonly log: boolean;
  readonly appendRecords: boolean;
  readonly rehydrateOnResume: boolean;
}

export interface Clock {
  nowMs(): number;
}
