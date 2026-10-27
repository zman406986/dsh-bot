export const PACKAGE_NAME = 'racoons-dsh';

export {
  DSH_CAPABILITIES, DSH_FULL_SEAM_CAPABILITIES, createDshCapabilities,
} from './capabilities.js';
export { classifyDshTool, deriveToolEvidence } from './evidence.js';
export type { DshEvidenceInput, DshPathObservation, DshResultFacts } from './evidence.js';
// Host usage → core `ApiUsage` (PRD §6.9, gap G8; ISSUE-045 chunk D1). The
// disjoint-bucket arithmetic is the host's own contract restated once; a rig
// that feeds `engine.observe` itself reads it instead of re-deriving it.
export { readAssistantUsage, usageRequestId } from './usage.js';
export type { DshUsageRead, DshUsageSource } from './usage.js';
export {
  toCoreEnvelope, fromCoreEnvelope, toCoreTranscript, fromCoreTranscript, createDshRecord,
} from './envelope.js';
export type {
  DshEnvelope, DshTranscriptItem, DshMessageItem, DshToolResultItem, DshRecordItem,
} from './envelope.js';
// The answered checkpoint's host-write contract (ISSUE-058 chunk P3a; ADR-0022
// §11–§12): the turns one exchange occupies, the two writes that apply an
// answer, and the typed refusal codes. Exported because the mount composes the
// turn's summary and journals the write it performed.
export { DshApplicationPort, composeEntryShapeTurn, createDshPort, entryShapePrefix } from './port.js';
export type {
  DshAskExchange, DshEntryApplyOutcome, DshEntryRefusal, DshEntryRefusalCode, DshPortOptions,
  DshSessionState,
} from './port.js';
export {
  applyValidatedRevert, NO_PARTIAL_KEEPS, partialKeepsFromArchives, planRevertAppend,
  revertPlanSha256,
} from './revert.js';
export type {
  DshAppendDecision, DshAppendPlan, DshAppendRefusal, DshAppendableType, DshContentBlock,
  DshPartialKeep, DshPartialKeepSet, DshRevertAppend, DshRevertOutcome, DshRevertRefusalCode,
  DshRevertSession, DshSurfaceIntent, DshSurfaceNode, DshSurfaceType,
} from './revert.js';
export {
  DSH_TOOL_SPECS, createDshTools, dshToolSpecs, recallText, registerDshTools,
} from './tools.js';
export type {
  DshRecallOutput, DshRecallPart, DshToolHost, DshToolRegistration, DshToolSources,
} from './tools.js';
// The manual forget tool (ISSUE-045 chunk D2): argument mapping, the
// snapshot-side decision and the answer projection. Exported so a rig can drive
// each leg without a live mount.
export {
  decideForget, forgetAnswer, forgetAnswerText, forgetEventId, forgetUnavailable, readForgetArgs,
} from './forget-tool.js';
export type {
  DshForgetDecision, DshForgetRefusal, DshForgetScheduled, DshForgetValue,
} from './forget-tool.js';
export { createDshAdapter } from './adapter.js';
export type {
  DshAdapter, DshAdapterOptions, DshAdapterPort, DshEngine, DshEntryAnswerOutcome,
} from './adapter.js';
export {
  RACOONS_PLUGIN_INJECT, RACOONS_PLUGIN_NAME, createRacoonsMount, createRacoonsPlugin,
  defaultStorageRoot, engineConfig as pluginEngineConfig, resolvePluginConfig,
  resolveSessionStorage, resolveStorage as resolvePluginStorage,
} from './plugin.js';
export { RacoonsStorageError, RacoonsStorageRetryError, STORAGE_OPEN_ATTEMPTS } from './storage.js';
// The closed journal vocabulary (CRITIC-022 P3 #14): a host or a rig can check
// a line's kind against it instead of against a literal it half-remembers.
export { RACOONS_JOURNAL_KINDS } from './journal-kinds.js';
export type { RacoonsJournalKind } from './journal-kinds.js';
export { RefusingLedger, createRefusingLedger } from './refusing-ledger.js';
export type { RefusingLedgerOptions } from './refusing-ledger.js';
export type {
  DshLlmChunk, DshLlmService, DshLlmStreamOptions, DshMountContext, DshMountEvent,
  DshMountSession, RacoonsApplicationRequest, RacoonsJournalRecord, RacoonsJournalSink,
  RacoonsLedgerFactory, RacoonsMount, RacoonsPluginConfig, RacoonsPluginOptions,
  RacoonsSessionEntry, RacoonsStorageOptions, ResolvedRacoonsConfig, ResolvedRacoonsStorage,
} from './plugin.js';
export type { RacoonsStorageErrorCode } from './storage.js';
export { revertSessionFromHost } from './mount-revert.js';
export { DEFAULT_ASK_TIMEOUT_MS, askWire, isRacoonsAskRequest } from './llm-ask.js';
export type {
  AskFailure, StreamAnswer, StreamAskOptions, StreamFailureReason, StreamOutcome, StreamRefusal,
} from './llm-ask.js';
export { captureMainRequest, createMainWireCapture } from './main-wire.js';
export type { CapturedMainRequest, MainWireCapture } from './main-wire.js';
// The host route both surviving asks read (ADR-0028: the entry checkpoint and
// the bulk prune). The seam file it used to live in is gone with the judge.
export { judgeRouteOf } from './route.js';
export type { JudgeRoute } from './route.js';
export type { MountJournal } from './journal-kinds.js';
export { PRUNE_COMMAND, callFactsOf, runRecordOnlyPrune } from './prune.js';
export type {
  PruneRefusalReason, PruneSummaryTrace, RecordOnlyPruneOptions, RecordOnlyPruneOutcome,
} from './prune.js';
// The prune apply leg (ISSUE-022 chunk 6): one bridge from a settled pass to the
// engine's `{kind:'prune'}` input, the half-window crossing latch, and the
// persisted round. Exported so a rig or a host can drive each seam directly.
export { applyPrunePass } from './prune-apply.js';
export type { PruneApplyEngine, PruneApplyOptions } from './prune-apply.js';
export { PruneWindowTrigger } from './prune-trigger.js';
export { PRUNE_ROUND_FILE, readPruneRound, writePruneRound } from './prune-round-store.js';
export { DSH_PARITY_CHECKLIST } from './parity.js';
export type { DshParityRow } from './parity.js';
export { WireRequestParseError, canonicalWireRequest, parseWireRequest } from './wire-request.js';
export type { WireRequestParseErrorCode } from './wire-request.js';
// The landed-then-ask entry checkpoint's ask (ISSUE-058 chunk P3c-1; ADR-0022
// §3–§6, §14; anchor design §1, §4, §7): the body-free anchored ask, the one
// bounded correction turn, and the fail-open refusal codes. Exported so the
// mount (and a rig) drives the same seam without a second copy.
export { askEntry, entryAskFacts, entryRetryAskMessage } from './entry-ask.js';
export type {
  EntryAskAnswered, EntryAskFacts, EntryAskOff, EntryAskOptions, EntryAskOutcome,
  EntryAskRefused, EntryAskRefusalCode, EntryAskRetryCode, EntryAskRoute, EntryAskTurn,
} from './entry-ask.js';
