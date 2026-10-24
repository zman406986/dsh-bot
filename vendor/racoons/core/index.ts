export const PACKAGE_NAME = '@racoons/core';

export type {
  Bytes, Sha256, SessionId, Revision, NodeId, ToolCallId, EpisodeId, RuleId,
  RemovalId, NoteId, RecallId, IntentId, EventId, UnitId, ByteRange, LineRange,
  SourceRef, SourceRange, SearchTarget,
} from './types/identity.js';
export type {
  ToolEvidence, PathEvidence, TranscriptNodeBase, MessageNode, ToolResultNode,
  RacoonsRecordNode, TranscriptNode, ColdBoundary, CacheState, FreshZone,
  ProtectionState, RetentionEvidence, SessionSnapshot, CapabilityFlags, Clock,
} from './types/transcript.js';
export type {
  ApiUsage, UsageObservation, MeterReading, ForcedLossObservation,
  HarnessObservation, TelemetryBase, TelemetryEvent, TelemetrySink,
} from './types/telemetry.js';
export type { Thresholds, FreshZoneConfig, ProtocolConfig, RacoonsConfig } from './config.js';
export { DEFAULT_CONFIG, validateConfig } from './config.js';
export {
  toBytes, fromBytes, equalBytes, concatBytes, sliceBytes,
  byteLengthOf, canonicalManifestBytes, canonicalBytesWithByteArrays,
} from './util/bytes.js';
export { sha256, sha256Sync } from './util/hash.js';
export {
  splitLineOffsets, lineCount, byteRangeForLines, complementByteRanges,
} from './util/lines.js';

export type { TokenMeter } from './meter/token-meter.js';
export { CharHeuristicTokenMeter } from './meter/token-meter.js';
export { Meter } from './meter/meter.js';
export type { FakeTokenMeterOptions } from './meter/fake-token-meter.js';
export { FakeTokenMeter } from './meter/fake-token-meter.js';
export type { Episode, EpisodeCloseReason, EpisodeTrackerOptions, EpisodeDetectionInput } from './episodes/types.js';
export { EpisodeTracker } from './episodes/tracker.js';
export type {
  RemovedSource, Removal, Note, CapOp, SealOp, EvictOp, SpanOp, VerdictOp,
  Operation, RulePlan, RuleContext, Rule,
} from './rules/types.js';
export { SealRule } from './rules/seal.js';
export { createDefaultRules } from './rules/defaults.js';
export {
  RECALL_TOOL_DESCRIPTION, MODEL_FACING_STRINGS, receiptLine,
  PRUNE_ASK_SYSTEM_PROMPT, VERDICT_JUDGE_SYSTEM_PROMPT,
} from './rules/assets.js';
export type {
  ValidationCode, ValidationIssue, BreakerState, RetainedCopy, Replacement,
  RenderedRecord, ValidatedApplication, ValidatedRevert, ValidationInput,
  ValidationResult, GuardOptions,
} from './guard/types.js';
export { Guard } from './guard/guard.js';
export { Breaker } from './guard/breaker.js';
// The protection set is what a caller needs to know WHICH units protection
// covers; the prune pass asks for unit ids, and deriving them anywhere else
// would be a second copy of the guard's rule.
export type { ProtectedSet } from './guard/protection.js';
export { computeProtectedRanges } from './guard/protection.js';
export type { BlobStore } from './ledger/blob-store.js';
export { MemoryBlobStore } from './ledger/memory-blob-store.js';
export { FileBlobStore } from './ledger/file-blob-store.js';
export type {
  HashedRange, RecallManifestPart, RecallManifest, RecallPart, RecallRecord,
  ArchiveRecord, PreparedIntent, ApplyReceipt, LedgerEventBase, LedgerEvent,
  LedgerEntry, Ledger, PreparableApplication, PreparedApplication, SqliteLedgerOptions, LedgerErrorCode,
} from './ledger/types.js';
export { LedgerError } from './ledger/types.js';
export { SqliteLedger } from './ledger/sqlite-ledger.js';

// slice-1 exports: prelude types and the units that later slices build on.
export type { UnitSpan, UnitSegmenter, ProcessingUnit } from './units/types.js';
export { WholeResultSegmenter } from './units/segmenter.js';
export type { UnitTrackerOptions } from './units/tracker.js';
export { UnitTracker, unitIdFor, unitRemoval } from './units/tracker.js';
export type {
  Verdict, VerdictAction, VerdictBatch, VerdictState, KeptLineSpan,
  KeepAllVerdict, KeepLinesVerdict, ForgetAllVerdict,
} from './verdicts/types.js';
export {
  advertisedLabelLimit, enforcedLabelLimit, normalizeLabel, labelIssue,
  descriptorWordCount, descriptorIssue, clampDescriptor, RECEIPT_DESCRIPTOR_WORD_LIMIT,
  DESCRIPTOR_CUT_MARK,
} from './verdicts/labels.js';
export type {
  GateKind, GateBudget, GatePresentation, GateOutcome,
} from './gates/types.js';
export type {
  RevertItem, RevertAppend, RevertCost, RevertChoice, RevertPlan, RevertInput,
} from './revert/types.js';

// slice-2 exports: verdicts, gates and the guard's verdict checks.
export type { JudgeOutcome, VerdictTrackerOptions } from './verdicts/tracker.js';
export { VerdictTracker } from './verdicts/tracker.js';
export type { VerdictPlanInput, VerdictRemoval } from './verdicts/plan.js';
export {
  planVerdictApplication, VERDICT_RULE_ID, deriveVerdictRemoval, normalizeKeptSpans,
  complementLineSpans, receiptLabelFor,
} from './verdicts/plan.js';
export type { WireAnswer, WireStamp, WireVerdictErrorCode } from './verdicts/wire.js';
export { parseWireVerdict, WireVerdictError } from './verdicts/wire.js';
export type { TurnGateOptions } from './gates/turn-gate.js';
export { TurnGate } from './gates/turn-gate.js';
export type { RevisitGateOptions } from './gates/revisit.js';
export { RevisitGate } from './gates/revisit.js';

// slice-2 exports: the v4.1 judge prompt assembly (ISSUE-021). The system
// message is the static contract asset; the user message is the production
// conversation plus one decision line. The anchored arm adds one anchor line
// before the decision line; the tagless arm's bytes are unchanged. Pure: no
// epoch, removal or clock state lives here; the runner drives those.
// `extendForNextCall` and `stripSuffix` are deliberately absent: byte-extending
// one message shares no provider cache (ADR-0010), so a second judge turn
// appends to a fork instead (see the judge fork exports below).
export type {
  ComposeOptions, ConversationRole, ConversationTurn, JudgeMessages,
} from './judge/assembly.js';
export {
  VERDICT_JUDGE_DECISION_LINE, renderHistory, composeJudgeMessages,
} from './judge/assembly.js';
export type { AnchorDegenerateCase, AnchorMode } from './judge/anchors.js';
export {
  ANCHOR_CUT_MARK, ANCHOR_DEGENERATE_CASES, ANCHOR_EMPTY_UNIT, ANCHOR_MAX_CHARS,
  ANCHOR_MAX_WORDS, buildAnchorSuffix,
} from './judge/anchors.js';

// judge fork (ISSUE-026, ADR-0010): a judge pass runs on a byte copy of main's
// last sent wire request — system, tools and messages — never on a re-render.
// `seedFork` asserts the copy hashes to the input; `appendAsk`, `appendVerdict`
// and `appendMessage` grow it append-only, re-asserting the system, tools and
// per-index message hashes before each append and refusing a second assistant
// turn in a row (two user asks in a row are provider-legal). The hash helpers
// are public because a send seam re-asserts the same hashes before it sends.
export type {
  ForkErrorCode, WireFork, WireMessage, WireRequest, WireTool,
} from './judge/fork.js';
export {
  ForkError, appendAsk, appendMessage, appendVerdict, forkErrorMessage,
  hashMessage, hashMessages, hashSystem, hashTools, seedFork, wireRequestHash,
} from './judge/fork.js';

// slice-3 exports: the revert plan a host applies (design-protocol §1). The
// cost helpers stay internal to the guard and the planner, and the ledger's
// migration outcome is not exported: `SqliteLedger.open` returns the ledger,
// and nothing outside core reads the file status (`migrated`/`resumed`).
// `revertBytes` is public surface: the host adapter recomputes the plan digest
// at the boundary (ADR-0004), and it must hash exactly what the guard sealed.
export type { RevertPlanInput } from './revert/plan.js';
export { chooseRevert, planRevertApplication } from './revert/plan.js';
export { revertBytes } from './guard/application.js';

// slice-4 exports

// big-prune L1 (ISSUE-022, ADR-0009): the provable layer only. Three
// byte-observable families, each removal carrying its evidence as a structured
// proof. No "unreferenced" family exists and none may be added: absent use is
// never proof of disuse (Ruling 8), so such a unit is judged at L2 instead.
export type {
  Level1Rule, StaleExactRereadProof, ClosedEpisodeProof,
  ByteIdenticalDuplicatesProof, Level1Proof, Level1Removal, Level1PrunePlan,
  Level1PruneInput,
} from './prune/types.js';
export { LEVEL1_RULES, planLevel1Prune } from './prune/level1.js';

// big-prune row anchors (ISSUE-022 chunk 2, ADR-0009): the whole call, the
// occurrence ordinal among identical calls, and two verbatim excerpts at swept
// percentile positions. The four numbers are parameters, defaulted and exported,
// so a later sweep varies position and amount without touching this code. The
// bytes are read only after the L1 proof passes; a failed proof yields a refused
// anchor, never wrong excerpts.
export type {
  PruneAnchor, PruneAnchorOptions, PruneAnchorRefusal, PruneAnchorResult,
  PruneCallFacts, RefusedPruneAnchor,
} from './prune/anchor.js';
export {
  PRUNE_ANCHOR_REFUSALS, assignCallOrdinals, buildPruneAnchor, isRefusedPruneAnchor,
} from './prune/anchor.js';
export type { PruneExcerptOptions, PruneExcerptPair } from './prune/excerpt.js';
export {
  PRUNE_ANCHOR_MAX_SHARE, PRUNE_ANCHOR_MAX_WORDS, PRUNE_ANCHOR_POSITION_A,
  PRUNE_ANCHOR_POSITION_B, buildPruneExcerpts,
} from './prune/excerpt.js';
export { PRUNE_EXCERPT_CUT_MARK, PRUNE_EXCERPT_MIN_SHARE_BYTES } from './prune/excerpt-lines.js';
export { isPruneWrapperLine } from './prune/wrapper.js';

// big-prune L2 table ask (ISSUE-022 chunk 3, ADR-0009): one ask addresses every
// unit still in memory by an index we assign. The table renderer and the
// unit-sized table builder are here; the ask itself is composed by the
// adapter's fork loop (ISSUE-027, ADR-0010), which appends the contract, the
// table and the final line as one user turn over main's untouched system slot.
// `nextTable` hands out contiguous tables of at most
// `PRUNE_ASK_MAX_TABLE_UNITS` rows (carried re-asks first, each costing a slot)
// and never cuts a row. `parsePruneAnswer` reads one verdict per index, keeping
// every unit it could not read; the one re-ask lives in the carry scheduler.
export type {
  NextTableOptions, PruneAskAnchorOptions, PruneAskItem, PruneAskRow, PruneAskTable,
} from './prune/ask.js';
export {
  buildPruneAskRows, nextTable,
  PRUNE_ASK_FINAL_LINE, PRUNE_ASK_TABLE_HEADING, renderPruneAskTable,
} from './prune/ask.js';
export type {
  ParsePruneAnswerOptions, PruneAnswerParse, PruneAnswerRejection,
  PruneAnswerRejectionCode, PruneAnswerRefusalCode, PruneAnswerRow,
  PruneAnswerRowAnswered, PruneAnswerRowRefused,
} from './prune/ask-answer.js';
export { parsePruneAnswer, PRUNE_ANSWER_REFUSAL_CODES } from './prune/ask-answer.js';

// big-prune carry-over scheduler (ISSUE-022 chunk 2; CRITIC-026 chunk A): the
// ONE scheduler. `prune/ask-carry.ts` settles one table: which rows the next
// table carries at its front (each costing one unit slot) and which are final.
// The dsh judge tables consume it instead of keeping a copy. Its attempt counters live in `prune/attempts.ts` (the same
// reading of a reply feeds both), and the 12-unit tuning reads them.
export type {
  PlanCarryOverOptions, PruneCarryEntry, PruneCarryFinal, PruneCarryOverPlan,
} from './prune/ask-carry.js';
export {
  planCarryOver, PRUNE_ASK_MAX_TABLE_UNITS, PRUNE_ASK_REASK_ROUNDS,
} from './prune/ask-carry.js';
export type { PrunePassAttemptTotals, PruneTableAttempt } from './prune/attempts.js';
export { summarizePassAttempts, summarizeTableAttempt } from './prune/attempts.js';

// big-prune pass planner (ISSUE-022 chunk 4, ADR-0009): ONE record-only pass
// over both layers. `planPrunePass` runs L1 first, then numbers every L1-kept
// unit that is not protected as an ask row, in transcript order, so the ask
// covers everything still in memory (Ruling 8) and protection is `excluded`,
// never silently dropped. `applyPruneAnswers` merges the answer texts into one
// decision document: L1 removals keep their proofs verbatim, L2 removals carry
// the judged action, its ranges and its summary, and every unreadable index is
// kept and reported. Record-only by construction: no receipt, no recall id, no
// engine event — an id would only be true after archival.
export type {
  PrunePassExclusion, PrunePassExclusionReason, PrunePassInput, PrunePassPlan,
} from './prune/pass.js';
export {
  estimatePassTokens, planPrunePass, PRUNE_PASS_EXCLUSION_REASONS,
} from './prune/pass.js';
export type {
  PruneL1Removal, PruneL2Removal, PrunePassApplication,
  PrunePassRejection, PrunePassRefusal, PruneRemoval,
} from './prune/pass-merge.js';
export type { PrunePassAnswerInput } from './prune/pass-answers.js';
export { applyPruneAnswers } from './prune/pass-answers.js';

// big-prune record-only telemetry (ISSUE-022 chunk 5, ADR-0009): one pass is one
// `prune-recorded` event. Counts by rule, action and refusal code — never a
// receipt, recall id or ledger kind, because record-only moves nothing and such
// a claim would be false. A pass with no ask (`application: null`) has no judged
// counts, so "nothing was asked" never reads as "everything was refused".
// `PruneAttemptTelemetry` is the chunk-6 addition: the table loop's per-attempt
// counters, so the 12-unit tuning reads production telemetry, not a unit test's
// stand-in.
export type {
  PruneAttemptTelemetry, PruneRecordedFields, PruneRemovalAction,
} from './prune/record.js';
export { pruneRecordOf, PRUNE_REMOVAL_ACTIONS } from './prune/record.js';

// ISSUE-020 chunk 3, promoted from the spike-008 harness: deterministic prefix
// epochs. A removal decided at turn T is applied at the END of T; an epoch is a
// maximal run of calls sharing one applied-removal set, and each one requires a
// fresh base prefix rendered from pristine blocks. Pure: no clock, no mutation,
// frozen output, decision order free.
export type {
  AppliedRemoval, Epoch, EpochCall, EpochDecision, EpochSameTurnGroup,
} from './epochs/types.js';
export {
  appliedSetAt, canonicalRanges, canonicalRemovalSet, normalizeDecision,
  normalizeDecisions, removalPoint,
} from './epochs/removal.js';
export { epochsFor } from './epochs/epochs.js';

export type {
  EngineInput, ApplyRequest, ApplyResult, ReceiptLookup, ApplicationPort,
  Disposable, ToolSpec, HarnessAdapter, EngineResult, EngineOptions,
} from './engine/types.js';
export { RacoonsEngine } from './engine/engine.js';
// The one content-token estimate: the mount's half-window trigger (ISSUE-022
// chunk 6, ADR-0009) reads the SAME arithmetic the engine's own gate reads, and
// supplies the fixed system+tools prefix from main's captured request (ADR-0009
// §Amendment 2026-10-24). `estimateContent` is the split form, so the mount's
// journal can name the denominator it observed.
export { estimateContent, estimatedContentTokens } from './engine/protocol.js';
export type { ContentEstimate, RequestPrefix } from './engine/protocol.js';
export { recoverPending } from './engine/recovery.js';
export { summarize, TranscriptTelemetry } from './engine/telemetry.js';
export type { TranscriptReading } from './engine/telemetry.js';
