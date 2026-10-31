export const PACKAGE_NAME = '@racoons/core';

export type {
  Bytes, Sha256, SessionId, Revision, NodeId, ToolCallId, EpisodeId, RuleId,
  RemovalId, NoteId, RecallId, IntentId, EventId, UnitId, ByteRange, LineRange,
  SourceRef, SourceRange, SearchTarget,
} from './types/identity.js';
export type {
  ToolEvidence, PathEvidence, TranscriptNodeBase, MessageNode, ToolResultNode,
  RacoonsRecordNode, TranscriptNode, ColdBoundary, CacheState, FreshZone,
  RetentionEvidence, SessionSnapshot, CapabilityFlags, Clock,
  PathCoverageFact,
} from './types/transcript.js';
export type {
  ApiUsage, UsageObservation, MeterReading, ForcedLossObservation,
  HarnessObservation, TelemetryBase, TelemetryEvent, TelemetrySink,
} from './types/telemetry.js';
export type {
  Thresholds, FreshZoneConfig, ProtocolConfig, RacoonsConfig, AnchorMode,
} from './config.js';
export {
  DEFAULT_CONFIG, DEFAULT_FLOOR_BYTES, FLOOR_BYTES_BY_MODEL, floorForModel, validateConfig,
} from './config.js';

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
// Per-source-path byte coverage (PRD §6.6, gap G3; ISSUE-045 chunk C5). The
// meter is the measurement, never a bar (ADR-0006); `PathCoverageFact` is the
// row shape `SessionSnapshot.pathCoverage` carries, so a caller can build the
// snapshot's own rows from `bytesByPath()`.
export type { PathCoverage } from './meter/coverage.js';
export { CoverageMeter } from './meter/coverage.js';
export type { FakeTokenMeterOptions } from './meter/fake-token-meter.js';
export { FakeTokenMeter } from './meter/fake-token-meter.js';
export type { Episode, EpisodeCloseReason, EpisodeTrackerOptions, EpisodeDetectionInput } from './episodes/types.js';
export { EpisodeTracker } from './episodes/tracker.js';
export type {
  RemovedSource, Removal, Note, CapOp, SealOp, VerdictOp,
  Operation, RulePlan, RuleContext, Rule,
} from './rules/types.js';
// C12 integration surface (ISSUE-045): the proof vocabulary chunk V0 added and
// chunk C3 registered. A proof is public the way a verdict is — a caller reads
// a plan's `proof` op, its `proofKind` and the rule id that names the byte fact
// the burn rests on (ADR-0018). `ProofOp` is a member of the `Operation` union
// exported above, so leaving it unexported would describe the union by a name a
// consumer cannot import.
export type { ProofKind, ProofOp, ProofRuleId } from './rules/types.js';
export { PROOF_RULE_IDS } from './rules/types.js';
export { SealRule } from './rules/seal.js';
// The two proof rules are default registrations, exported beside `SealRule` so
// a caller composing its own rule list names them instead of re-implementing a
// byte fact (ISSUE-045 chunk C3).
export { StaleReadRule } from './rules/stale.js';
export { SupersededReadRule } from './rules/superseded.js';
export { createDefaultRules } from './rules/defaults.js';
// The anchor subsystem (ISSUE-058 chunk AN-2; ADR-0022 §5–§8; the binding
// design at `docs/plans/2026-10-26-anchor/design.md`). `quoteLineTail` is the
// ONE quoting routine both seams share; `anchorsAt` is the ONE fallback-and-
// render core a seam feeds its own line numbers; `anchorsFor` is the entry
// seam's placement derived from `N` alone. The five caps are exported as data,
// so a caller or a test names a rule from its one home instead of re-typing a
// literal beside it.
export {
  ANCHOR_LINES_PER_ANCHOR, ANCHOR_NO_SPACE_TAIL_CODE_POINTS, ANCHOR_QUOTE_MAX_CODE_POINTS,
  ANCHOR_QUOTE_MAX_WORDS, ANCHOR_QUOTE_MIN_CODE_POINTS, anchorsAt, anchorsFor,
  blankBandNotice, entryPositions, quoteLineTail, tailCodePoints,
} from './rules/anchors.js';
// `withTotal: false` is the entry seam's rendering (the ask states `N` once);
// the prune lane keeps the total on every row, so it leaves the option unset.
export type { AnchorRenderOptions } from './rules/anchors.js';
export {
  RECALL_TOOL_DESCRIPTION, MODEL_FACING_STRINGS, receiptLine,
  PRUNE_ASK_SYSTEM_PROMPT,
  // The entry checkpoint's copy (ISSUE-056 C2, exported by C6a; the ask became
  // body-free in ISSUE-058 P2): the contract, the end anchor the rig's matcher
  // keys on, the two legacy fence literals, the two renderers, and the
  // per-result block the one correction turn restates.
  ENTRY_ASK_CLOSING_LINE, ENTRY_ASK_END_ANCHOR, ENTRY_ASK_FRAME, ENTRY_ASK_RESULT_CLOSE,
  ENTRY_ASK_RESULT_OPEN, ENTRY_ASK_SYSTEM_PROMPT,
  SHAPE_MARKER_EMPTY_TEMPLATE, SHAPE_MARKER_TEMPLATE,
  entryAskFactsBlock, entryAskMessage, shapeMarker,
} from './rules/assets.js';
export type {
  ValidationCode, ValidationIssue, BreakerState, RetainedCopy, Replacement,
  RenderedRecord, ValidatedApplication, ValidatedRevert, ValidationInput,
  ValidationResult, GuardOptions,
} from './guard/types.js';
export { Guard } from './guard/guard.js';
export { Breaker } from './guard/breaker.js';
export type { BlobStore } from './ledger/blob-store.js';
export { MemoryBlobStore } from './ledger/memory-blob-store.js';
export { FileBlobStore } from './ledger/file-blob-store.js';
export type {
  HashedRange, RecallManifestPart, RecallManifest, RecallPart, RecallRecord,
  ArchiveRecord, PreparedIntent, ApplyReceipt, LedgerEventBase, LedgerEvent,
  LedgerEntry, Ledger, PreparableApplication, PreparedApplication, SqliteLedgerOptions, LedgerErrorCode,
  // C12 integration surface (ISSUE-045): the ledger seams chunks C7 and C9 added.
  // `Ledger.recall` takes `RecallOptions` and `Ledger.export`/`hydrate` trade in
  // `LedgerArchive`/`HydratedLedger`; a caller that implements the interface or
  // wires the source lane names them from here.
  RecallOptions, LedgerSourceReader, SourceFallbackRequest, LedgerArchive, HydratedLedger,
} from './ledger/types.js';
export { LedgerError } from './ledger/types.js';
export { SqliteLedger } from './ledger/sqlite-ledger.js';
// The injected source lane (PRD §6.7, the two-device safety rule; chunk C7): a
// host that holds the files hands the ledger this reader, and a miss falls back
// to re-reading the unchanged source under the manifest's own hash.
export type { IndexedRecall, IndexedSourceReader } from './ledger/source-reader.js';
export { FileSourceReader, asIndexedSourceReader } from './ledger/source-reader.js';
// The archive format itself (PRD §6.7, gap G7; ISSUE-045 chunk C9, ADR-0019). An
// archive is a file a user carries between devices, so the kind, the version,
// the seven table specs and the reader that refuses a foreign or edited
// document are public: a tool can verify an archive without opening a ledger.
// `exportSession`/`commitArchive` take a live `DatabaseSync` and stay behind
// `SqliteLedger.export`/`hydrate`, which are the seam (ADR-0015).
export type {
  ArchiveTableName, ArchiveTableSpec, ArchiveRow, ArchiveBlob, LedgerArchiveDocument,
} from './ledger/export-file.js';
export { ARCHIVE_KIND, ARCHIVE_VERSION, ARCHIVE_TABLES, parseArchiveDocument } from './ledger/export-file.js';

// slice-1 exports: prelude types and the units that later slices build on.
export type { UnitSpan, UnitSegmenter, ProcessingUnit } from './units/types.js';
export { WholeResultSegmenter } from './units/segmenter.js';
export type { UnitTrackerOptions } from './units/tracker.js';
export { UnitTracker, unitIdFor, unitRemoval } from './units/tracker.js';
// C1 export block (ISSUE-045 chunk C1; the two lines added by D2, 2026-10-25 —
// additive only, reviewed in the C12 sweep). The dsh adapter's manual forget
// tool answers the agent BEFORE queueing a request, so the refusal it returns
// must be the one `units/lookup.ts` makes. Exporting the lookup keeps that rule
// in one place instead of letting an adapter grow a second copy.
export type { ForgetResolution, ForgetLookupInput } from './units/lookup.js';
export { resolveForget, receiptRangesFor } from './units/lookup.js';
// Write invalidation (PRD §6.7; ISSUE-045 chunk C6), exported for the mount's
// settled-set read (ISSUE-073): a settled entry keep stops being settled when a
// later write invalidates its unit, and the mount must apply that same rule
// rather than a second copy of it.
export type { Invalidation, InvalidationInput } from './units/invalidation.js';
export { computeInvalidation, withoutStaleCoverage } from './units/invalidation.js';
export type {
  Verdict, VerdictAction, VerdictBatch, VerdictState, KeptLineSpan,
  KeepAllVerdict, KeepLinesVerdict, ForgetAllVerdict, ForgetLinesVerdict,
} from './verdicts/types.js';
export {
  RECEIPT_LABEL_CHAR_LIMIT, enforcedLabelLimit, normalizeLabel, labelIssue,
  descriptorWordCount, descriptorIssue, clampDescriptor, RECEIPT_DESCRIPTOR_WORD_LIMIT,
  DESCRIPTOR_CUT_MARK,
} from './verdicts/labels.js';
export type {
  RevertItem, RevertAppend, RevertCost, RevertChoice, RevertPlan, RevertInput,
} from './revert/types.js';

export type { JudgeOutcome, VerdictTrackerOptions } from './verdicts/tracker.js';
export { VerdictTracker } from './verdicts/tracker.js';
export type { VerdictPlanInput, VerdictRemoval } from './verdicts/plan.js';
export {
  planVerdictApplication, VERDICT_RULE_ID, deriveVerdictRemoval, normalizeKeptSpans,
  complementLineSpans, receiptLabelFor,
} from './verdicts/plan.js';
export type { WireAnswer, WireStamp, WireVerdictErrorCode } from './verdicts/wire.js';
export { parseWireVerdict, WireVerdictError } from './verdicts/wire.js';
// The entry checkpoint's answer grammar (ISSUE-056 C1; ADR-0022 §9; the fourth
// action added by ISSUE-061 chunk F-1a, ADR-0026). A separate reader from
// `parseWireVerdict` on purpose — it reads TEXT, so it owns the two refusals
// only text can cause — but the vocabulary is now the same four actions on both
// lanes: `keephead` is gone, a first-N prefix is not an answer class, and
// `keeplines`/`forgetlines` are the two partial classes naming the kept and the
// dropped lines. Exported here for the mount that asks (C6a) so no adapter keeps
// a second copy of the four forms or of the refusal codes.
export type {
  EntryAnswer, EntryAnswerAction, EntryAnswerErrorCode,
} from './verdicts/entry-wire.js';
export {
  ENTRY_ANSWER_ACTIONS, EntryAnswerError, parseEntryAnswer, isKeepEverythingAnswer,
} from './verdicts/entry-wire.js';

// The conversation renderer the ask lanes share (ADR-0028 removed the judge's
// per-unit assembly with the judge pass; `renderHistory` stays because a fork's
// append needs one definition of how production renders a turn sequence).
export type { ConversationRole, ConversationTurn } from './judge/assembly.js';
export { renderHistory, TURN_SEPARATOR } from './judge/assembly.js';

// The fork lane (ISSUE-026, ADR-0010): the entry ask and the bulk prune run on
// a byte copy of main's last sent wire request — system, tools and messages —
// never on a re-render. `seedFork` asserts the copy hashes to the input;
// `appendAsk`, `appendVerdict` and `appendMessage` grow it append-only,
// re-asserting the system, tools and per-index message hashes before each
// append and refusing a second assistant turn in a row (two user asks in a row
// are provider-legal). The hash helpers are public because a send seam
// re-asserts the same hashes before it sends.
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

// big-prune row anchors (ISSUE-022 chunk 2, ADR-0009, re-based on ADR-0022 §7):
// the whole call, the occurrence ordinal among identical calls, and the same
// line anchors the entry ask carries — `line L of N ends with "..."`, placed at
// the lines holding the unit's 30th and 70th byte shares instead of the entry
// seam's even spacing. The entry ask states its `N` once and drops the ` of N`
// (`line 67 ends with "..."`); the prune keeps it on every row, one unit per
// row. The quoting routine and every fallback are `rules/anchors.js`'s;
// `prune/anchor-positions.ts` owns only the placement and its two shares. The
// bytes are read only after the L1 proof passes; a failed proof yields a
// refused anchor, never a quote of the wrong bytes.
export type {
  PruneAnchor, PruneAnchorOptions, PruneAnchorRefusal, PruneAnchorResult,
  PruneCallFacts, RefusedPruneAnchor,
} from './prune/anchor.js';
export {
  PRUNE_ANCHOR_REFUSALS, assignCallOrdinals, buildPruneAnchor, isRefusedPruneAnchor,
  PRUNE_ANCHOR_POSITION_A, PRUNE_ANCHOR_POSITION_B,
} from './prune/anchor.js';
export type {
  PruneAnchorSet, PruneAnchorShareOptions,
} from './prune/anchor-positions.js';
export {
  buildPruneAnchors, pruneAnchorPositions,
} from './prune/anchor-positions.js';

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
// unit as an ask row, in transcript order, so the ask covers everything still
// in memory (Ruling 8); there is no exclusion layer (ADR-0020).
// `applyPruneAnswers` merges the answer texts into one
// decision document: L1 removals keep their proofs verbatim, L2 removals carry
// the judged action, its ranges and its summary, and every unreadable index is
// kept and reported. Record-only by construction: no receipt, no recall id, no
// engine event — an id would only be true after archival.
export type { PrunePassInput, PrunePassPlan } from './prune/pass.js';
export { estimatePassTokens, planPrunePass } from './prune/pass.js';
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
  EngineInput, ForgetRequest, ApplyRequest, ApplyResult, ReceiptLookup, ApplicationPort,
  Disposable, ToolSpec, HarnessAdapter, EngineResult, EngineOptions, PassInvalidation,
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

// The entry checkpoint's landed-node planner (ISSUE-058 chunk P3b; ADR-0022
// §11–§13). A mount that collected the agent's answer over a result that has
// already landed hands the planner the landed unit's id, the original body the
// port holds and the answer; it gets back one of three outcomes — `keepall`
// (plans nothing), `shape` (the new turn's bytes plus the original to bank), or
// `refuse` (fail-open, with the reason). `planEntryDecision` is the same call
// shaped for the engine's own entry path (ISSUE-058 chunk P3a): it reads an
// `EngineInput` and returns `null` when the event carries no answer, so the
// land-first observation plans nothing and a mount never re-derives a decision.
export type {
  EntryShapePlan, EntryShapeRefusal, LandedEntryShapeInput,
} from './engine/planning.js';
export { planEntryDecision, planEntryShape } from './engine/planning.js';
// The one composition of that new turn (ADR-0022 §12): the kept partials with
// one marker in each dropped gap. The planner writes it, the candidate builder
// lands it, and the guard re-renders it to prove the plan's own claim, so the
// byte-level agreement is one implementation rather than three copies.
export type { ShapeTurn, ShapeTurnInput } from './guard/shape-turn.js';
export { renderShapeTurn } from './guard/shape-turn.js';
