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
  SourceRef,
  ToolCallId,
} from "./identity.js";

export interface ToolEvidence {
  /**
   * What the call did. `write` proves a path changed — never that a search
   * space was empty (PRD §6.6, §6.7; ISSUE-045 chunk E0 derives it, C6 uses it).
   */
  readonly kind: "read" | "search" | "glob" | "write" | "other";
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

/**
 * Per-path byte coverage across every result-producing call, tool-name
 * agnostic (PRD §6.6; ISSUE-045 chunk C5 measures it). The shape is the meter's
 * `PathCoverage` row, so a meter's `bytesByPath()` is assignable here without
 * either side importing the other. Bytes are facts: no threshold, bar or score
 * rides on them (ADR-0006).
 */
export interface PathCoverageFact {
  readonly pathKey: string;
  /** Every byte recorded for this path: hit + miss + unknown. */
  readonly bytes: number;
  readonly hitBytes: number;
  readonly missBytes: number;
  /** Bytes whose outcome is unknown: counted, but proof of nothing. */
  readonly unknownBytes: number;
  readonly observations: number;
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
  readonly retentionEvidence: readonly RetentionEvidence[];
  /**
   * Per-path byte coverage the harness (or the meter) already observed, one row
   * per path, in the meter's order (PRD §6.6; ISSUE-045 chunk C5). Absent means
   * "not measured here"; nothing sums this field, and no rule reads it.
   */
  readonly pathCoverage?: readonly PathCoverageFact[];
}

export interface CapabilityFlags {
  readonly mutateResult: boolean;
  readonly rewriteHistory: boolean;
  /**
   * The programmatic revert seam (ADR-0007): the host can restore a cached
   * prefix and append replacements. Optional because a host that has not
   * declared it cannot apply a verdict removal; absence is refused, never
   * assumed. Slice 4's dsh factory supplies it.
   */
  readonly revertHistory?: boolean;
  readonly atRest: boolean;
  readonly liveTokens: boolean;
  readonly log: boolean;
  readonly appendRecords: boolean;
  readonly rehydrateOnResume: boolean;
}

export interface Clock {
  nowMs(): number;
}
