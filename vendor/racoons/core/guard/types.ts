import type { RacoonsConfig } from "../config.js";
import type { EngineInput } from "../engine/types.js";
import type { ArchiveRecord, Ledger } from "../ledger/types.js";
import type { RevertAppend, RevertCost } from "../revert/types.js";
import type { RulePlan } from "../rules/types.js";
import type {
  ByteRange, Bytes, EpisodeId, EventId, NodeId, RecallId,
  Revision, RuleId, SessionId, Sha256, SourceRef, UnitId,
} from "../types/identity.js";
import type { CapabilityFlags, SessionSnapshot } from "../types/transcript.js";

export type { ArchiveRecord } from "../ledger/types.js";
export type ValidationCode =
  | "invalid-plan" | "stale-revision" | "wrong-session" | "wrong-rule"
  | "unknown-source" | "source-hash-mismatch" | "source-length-mismatch"
  | "invalid-range" | "overlapping-removals" | "conflicting-operations"
  | "unaccounted-removal" | "unused-removal" | "invalid-note"
  | "outside-fresh-zone" | "pairing-changed"
  | "adjacency-changed" | "retained-bytes-changed" | "invalid-line-range"
  | "unsupported-capability" | "episode-open" | "episode-not-sealed"
  | "episode-evidence-missing" | "hit-removal" | "late-seal"
  | "cold-boundary-required" | "recall-manifest-mismatch"
  | "invalid-generated-record" | "breaker-disabled"
  | "unknown-unit" | "incomplete-verdicts" | "label-too-long"
  | "descriptor-too-long" | "invalid-line-span" | "cut-below-watermark"
  // A proof removal the snapshot's own bytes do not prove (PRD §6.6; chunk C4):
  // the plan claims stale or superseded, the snapshot disagrees.
  | "proof-unproven"
  // An edit landing outside the ranges the agent actually holds as kept
  // (PRD §6.7; chunk C6). The detail names the write that invalidated them.
  | "edit-outside-coverage"
  // A manual forget request that names no single held unit (PRD §6.2; chunk C1).
  // An ambiguous or absent unit is refused, never guessed.
  | "unresolved-request";

export interface ValidationIssue {
  readonly code: ValidationCode;
  readonly ruleId: RuleId | null;
  readonly operationIndex: number | null;
  readonly nodeId: NodeId | null;
  readonly detail: string;
}
export interface BreakerState {
  readonly consecutiveValidationFailures: 0 | 1 | 2;
  readonly disabled: boolean;
}
export interface RetainedCopy {
  readonly sourceRange: ByteRange;
  readonly outputRange: ByteRange;
}
export interface Replacement {
  readonly source: SourceRef;
  readonly bytes: Bytes;
  readonly sha256: Sha256;
  readonly retainedCopies: readonly RetainedCopy[];
  readonly generatedRanges: readonly ByteRange[];
  readonly evidenceRecallId: RecallId | null;
}
export interface RenderedRecord {
  readonly recordId: string;
  readonly bytes: Bytes;
  readonly sha256: Sha256;
}

declare const guardValidated: unique symbol;
/**
 * A revert plan the guard has approved. `planSha256` is the digest of the
 * approved plan, so the host applies exactly what the ledger prepared
 * (ADR-0004) and a host-side substitution is detectable.
 */
export interface ValidatedRevert {
  readonly unitIds: readonly UnitId[];
  readonly cutIndex: number;
  readonly survivors: readonly NodeId[];
  readonly appends: readonly RevertAppend[];
  readonly cost: RevertCost;
  readonly baseRevision: Revision;
  readonly planSha256: Sha256;
}
export interface ValidatedApplication {
  readonly [guardValidated]: true;
  readonly sessionId: SessionId;
  readonly eventId: EventId;
  readonly baseRevision: Revision;
  readonly phase: "entry" | "at-rest";
  readonly mode: "entry" | "append" | "rewrite" | "rehydrate" | "revert";
  readonly applicationSha256: Sha256;
  readonly replacements: readonly Replacement[];
  readonly appendRecords: readonly RenderedRecord[];
  readonly archives: readonly ArchiveRecord[];
  readonly sealedEpisodeIds: readonly EpisodeId[];
  readonly createdAtMs: number;
  /** Present exactly when `mode` is "revert"; absent otherwise. */
  readonly revert?: ValidatedRevert;
}
export interface ValidationInput {
  readonly input: EngineInput;
  readonly snapshot: SessionSnapshot;
  readonly capabilities: CapabilityFlags;
  readonly config: RacoonsConfig;
  readonly plans: readonly RulePlan[];
  readonly sealedEpisodeIds: readonly EpisodeId[];
  readonly nowMs: number;
}
export type ValidationResult =
  | { readonly ok: true; readonly application: ValidatedApplication; readonly breaker: BreakerState }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[]; readonly breaker: BreakerState };
export interface GuardOptions {
  readonly ledger: Ledger;
  readonly initialState: BreakerState;
}
export type { Guard } from "./guard.js";
