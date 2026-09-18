export { Config, apply, inject, name } from "./plugin.js";
export type { PluginConfig } from "./plugin.js";
export {
  activationResultCopy,
  bindDispatcherLifecycle,
  blocksToText,
  createCordisDshHost,
  createDispatcherStartCommand,
  createRequestAccessHandler,
  createStorageDomainDurability,
  DISPATCHER_START_ALREADY_HERE,
  DISPATCHER_START_COMMAND,
  DISPATCHER_START_DESCRIPTION,
  DISPATCHER_START_NOT_TOP_LEVEL,
  DISPATCHER_START_SUCCESS,
  DISPATCHER_START_UNRESOLVED,
  installMultitaskSettingsSection,
  isTopLevel,
  listGlobalToolNames,
  mapStopReason,
  normalizeSettleReport,
  registerDispatcherStartCommand,
  registerDispatcherTools,
  registerWorkerAccessTool,
  REQUEST_ACCESS_TOOL,
  resolveExecSessionId,
  SETTINGS_NAMESPACE,
  SPAWN_PROVIDER,
  textBlock,
  textBlocks,
  toRegisterableTool,
  wakeUserMessage,
  PEER_WAKE_CUE,
  WAKE_CUE,
} from "./adapter/index.js";
export type {
  ActivationOutcome,
  AdapterContext,
  AgentLike,
  CommandDefinitionLike,
  CommandInvocationLike,
  CommandResultLike,
  CommandsLike,
  ContentBlock,
  CordisDshHost,
  CordisDshHostOptions,
  DomainLike,
  JobSnapshotLike,
  KvTableLike,
  RegisterDispatcherStartCommandOptions,
  RegisterDispatcherToolsOptions,
  RegisterableTool,
  SettingsAwareContext,
  SettingsInjectContext,
  SettingsProviderLike,
  SettingsSectionHooksLike,
  StorageDomainDurability,
  StorageDomainLike,
  TextBlock,
  ToolsLike,
  WakeUserMessage,
  WorkerAgentDef,
} from "./adapter/index.js";
export {
  buildWorkerSystemPrompt,
  buildWorkerToolFilter,
  createWorkerAgentDef,
  EMPTY_WORKER_ERROR_REPORT,
  EMPTY_WORKER_REPORT_PLACEHOLDER,
  normalizeWorkerErrorReport,
  normalizeWorkerReport,
  WORKER_DENIED_TOOL_CANDIDATES,
  WORKER_MAX_DEPTH,
  workerSpawnMaxDepth,
} from "./worker/index.js";
export type { WorkerToolFilter } from "./worker/index.js";
export type { DshHost } from "./core/dsh-host.js";
export { FakeDshHost } from "./core/fake-host.js";
export type { SendMessageCall, SpawnCall } from "./core/fake-host.js";
export { createMultitask } from "./core/multitask.js";
export type {
  DrainedWake,
  Multitask,
  MultitaskAccessOptions,
  MultitaskOptions,
  RedriveReport,
} from "./core/multitask.js";
export {
  createAccessPolicyTable,
  createAccessRelay,
  defaultProfileAskSeed,
  DEFAULT_ACCESS_TIMEOUT_MS,
  matchTargetPattern,
  wrapAccessDecision,
} from "./core/access-relay.js";
export type {
  AccessPolicyTable,
  AccessRelay,
  AccessRelayOptions,
} from "./core/access-relay.js";
export {
  ACCESS_CLASSES,
  isDenyDecision,
  toAccessClass,
} from "./core/access-types.js";
export type {
  AccessClass,
  AccessDecision,
  AccessNotice,
  AccessRequestBody,
  AccessRequestEvent,
  AccessRequestNotice,
  AccessTicket,
  PolicyEntry,
  PolicyLookupCtx,
} from "./core/access-types.js";
export {
  createInMemoryDurability,
  toDurableMarker,
} from "./core/durability.js";
export type {
  DurableWorkerMarker,
  DurabilityPort,
  InMemoryDurability,
  RebuildReport,
  UnknownStateWorker,
} from "./core/durability.js";
export { createSteerQueue, wrapParentCorrection } from "./core/steer-queue.js";
export type { SteerQueue } from "./core/steer-queue.js";
export {
  createPeerInbox,
  DEFAULT_PEER_INBOX_CAP,
} from "./core/peer-inbox.js";
export type {
  PeerInbox,
  PeerInboxOptions,
  PeerSendResult,
} from "./core/peer-inbox.js";
export {
  effectivePeerPriority,
  peerTargetLabel,
  samePeerPayload,
  toPeerNotice,
} from "./core/peer-types.js";
export type {
  PeerEnvelope,
  PeerNotice,
  PeerSendAck,
  PeerTarget,
} from "./core/peer-types.js";
export {
  MAX_DELIVERY_REDRIVES,
  createTodoLedger,
  reconcileTodos,
} from "./core/todo-reconciler.js";
export type {
  CreateTodoInput,
  DeliveryDisposition,
  DeliveryEvent,
  DeliveryReason,
  ReconcileInput,
  ReconcileReport,
  TodoItem,
  TodoLedger,
  TodoMutation,
  TodoStatus,
} from "./core/todo-reconciler.js";
export { createWakeBus, WAKE_SOURCES } from "./core/wake-bus.js";
export type {
  EnqueueAccessNoticeInput,
  EnqueueAccessRequestInput,
  EnqueuePeerInput,
  EnqueueSettledInput,
  SettledWorkerNotice,
  TurnOwner,
  WakeBus,
  WakeBusOptions,
  WakeEvent,
  WakeSource,
} from "./core/wake-bus.js";
export { applyEvent, canTransition } from "./core/worker-fsm.js";
export type { WorkerEvent } from "./core/worker-fsm.js";
export { isTerminalStatus } from "./core/types.js";
export type {
  SettledEvent,
  SpawnOptions,
  SpawnRequest,
  SpawnResult,
  SteerResult,
  StopResult,
  TerminalWorkerStatus,
  WorkerRecord,
  WorkerStatus,
  WorkerSummary,
} from "./core/types.js";
export {
  abortedReportBody,
  clampActivity,
  clampError,
  clampReport,
  CHECK_ACTIVITY_CHARS,
  emptyReportPlaceholder,
  ERROR_CLAMP_CHARS,
  formatWakeReportBody,
  REPORT_CLAMP_CHARS,
  TOOL_RESULT_SUMMARY_MAX_ROWS,
  truncationMarker,
} from "./core/report-clamp.js";
export {
  deriveWorkerLiveness,
  WORKER_ACTIVE_WINDOW_MS,
  WORKER_STALL_THRESHOLD_MS,
} from "./core/liveness.js";
export type {
  WorkerLiveness,
  WorkerLivenessInput,
} from "./core/liveness.js";
export {
  formatCheckRowLine,
  formatCheckSummary,
  formatElapsedMs,
  formatSpawnAck,
  formatSteerNote,
  formatStopNote,
  formatStopUnknownStateNote,
  toCheckRow,
} from "./core/tool-results.js";
export type {
  CheckWorkersToolResult,
  DeliverResultToolResult,
  SpawnWorkerToolResult,
  SteerWorkerToolResult,
  StopWorkerToolResult,
  WorkerCheckRow,
} from "./core/tool-results.js";
export {
  assembleAccessSection,
  assemblePeerWakeTurn,
  assembleSessionPolicy,
  assembleTurnReminder,
  assembleWakeTurn,
  noticeFromSettled,
} from "./core/policy/assembler.js";
export type { WakeNotice } from "./core/policy/assembler.js";
export {
  ACCESS_SECTION_HEADING,
  buildAccessPolicyBlock,
  buildDispatcherPolicySection,
  buildPeerWakeInstructionsBlock,
  CHECK_WORKERS_TOOL,
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
  PEER_WAKE_SECTION_HEADINGS,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
  TOOL_DESCRIPTIONS,
} from "./core/policy/prompts.js";
export {
  buildTurnReminderForSession,
  createDispatcherTools,
  toToolParametersSchema,
} from "./core/tools.js";
export type {
  DeliverToUserFn,
  DispatcherToolDef,
  DispatcherToolDeps,
  RecentActivityFn,
} from "./core/tools.js";

