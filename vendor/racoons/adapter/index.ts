export const PACKAGE_NAME = 'racoons-dsh';

export {
  DSH_CAPABILITIES, DSH_FULL_SEAM_CAPABILITIES, createDshCapabilities,
} from './capabilities.js';
export { classifyDshTool, deriveToolEvidence } from './evidence.js';
export type { DshEvidenceInput, DshPathObservation, DshResultFacts } from './evidence.js';
export {
  toCoreEnvelope, fromCoreEnvelope, toCoreTranscript, fromCoreTranscript, createDshRecord,
} from './envelope.js';
export type {
  DshEnvelope, DshTranscriptItem, DshMessageItem, DshToolResultItem, DshRecordItem,
} from './envelope.js';
export { DshApplicationPort, createDshPort } from './port.js';
export type { DshPortOptions, DshSessionState } from './port.js';
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
export { createDshAdapter } from './adapter.js';
export type { DshAdapter, DshAdapterOptions, DshAdapterPort, DshEngine } from './adapter.js';
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
export { DEFAULT_JUDGE_TIMEOUT_MS, askJudge, buildJudgeAsk, renderHistoryItems } from './judge.js';
export type {
  AskJudgeOptions, JudgeAnswer, JudgeAskRefusal, JudgeAskResult, JudgeFailureReason,
  JudgeOutcome, JudgeRefusal, RenderedHistory,
} from './judge.js';
export { DEFAULT_ASK_TIMEOUT_MS, askText, askWire, isRacoonsAskRequest } from './llm-ask.js';
export type {
  AskFailure, StreamAnswer, StreamAskOptions, StreamFailureReason, StreamOutcome, StreamRefusal,
} from './llm-ask.js';
export {
  JUDGE_TABLE_UNITS, runJudgePass,
} from './judge-pass.js';
export type {
  JudgePassAsked, JudgePassOptions, JudgePassOutcome, JudgePassRefusal, JudgePassWindow,
} from './judge-pass.js';
export { appendPassReceipt, judgeReceiptText, passReceiptText } from './judge-receipt.js';
export type {
  AppendPassReceiptInput, JudgePassReceiptInput, JudgeReceiptInput,
} from './judge-receipt.js';
export { captureMainRequest, createMainWireCapture } from './main-wire.js';
export type { CapturedMainRequest, MainWireCapture } from './main-wire.js';
export { createJudgeSeam, judgeRouteOf } from './judge-seam.js';
export type {
  JudgeAsked, JudgeRoute, JudgeSeam, JudgeSeamOptions, JudgeSettleOutcome, MountJournal,
  PresentedWindow,
} from './judge-seam.js';
export { PRUNE_COMMAND, callFactsOf, protectedUnitIdsOf, runRecordOnlyPrune } from './prune.js';
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
