export { Config, apply, inject, name } from "./plugin.js";
export type { PluginConfig } from "./plugin.js";
export {
  bindDispatcherLifecycle,
  blocksToText,
  createCordisDshHost,
  createStorageDomainDurability,
  isTopLevel,
  listGlobalToolNames,
  mapStopReason,
  normalizeSettleReport,
  registerDispatcherTools,
  SPAWN_PROVIDER,
  textBlock,
  textBlocks,
  toRegisterableTool,
  wakeUserMessage,
  WAKE_CUE,
} from "./adapter/index.js";
export type {
  AdapterContext,
  AgentLike,
  ContentBlock,
  CordisDshHost,
  CordisDshHostOptions,
  DomainLike,
  JobSnapshotLike,
  KvTableLike,
  RegisterDispatcherToolsOptions,
  RegisterableTool,
  StorageDomainDurability,
  StorageDomainLike,
  TextBlock,
  ToolsLike,
  WakeUserMessage,
  WorkerAgentDef,
} from "./adapter/index.js";
export {
  assembleWorkerPrompt,
  buildWorkerSystemPrompt,
  buildWorkerToolFilter,
  createWorkerAgentDef,
  EMPTY_WORKER_ERROR_REPORT,
  EMPTY_WORKER_REPORT_PLACEHOLDER,
  normalizeWorkerErrorReport,
  normalizeWorkerReport,
  WORKER_DENIED_TOOL_CANDIDATES,
  WORKER_MAX_DEPTH,
} from "./worker/index.js";
export type { WorkerToolFilter } from "./worker/index.js";
export type { DshHost } from "./core/dsh-host.js";
export { FakeDshHost } from "./core/fake-host.js";
export type { SendMessageCall, SpawnCall } from "./core/fake-host.js";
export { createMultitask } from "./core/multitask.js";
export type {
  DrainedWake,
  Multitask,
  MultitaskOptions,
} from "./core/multitask.js";
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
  createTodoLedger,
  reconcileTodos,
} from "./core/todo-reconciler.js";
export type {
  CreateTodoInput,
  ReconcileInput,
  ReconcileReport,
  TodoItem,
  TodoLedger,
  TodoMutation,
  TodoStatus,
} from "./core/todo-reconciler.js";
export { createWakeBus, WAKE_SOURCES } from "./core/wake-bus.js";
export type {
  EnqueueSettledInput,
  SettledWorkerNotice,
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
  formatCheckRowLine,
  formatCheckSummary,
  formatElapsedMs,
  formatSpawnAck,
  formatSteerNote,
  formatStopNote,
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
  assembleSessionPolicy,
  assembleTurnReminder,
  assembleWakeTurn,
  noticeFromSettled,
} from "./core/policy/assembler.js";
export type { WakeNotice } from "./core/policy/assembler.js";
export {
  buildDispatcherPolicySection,
  CHECK_WORKERS_TOOL,
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
  TOOL_DESCRIPTIONS,
} from "./core/policy/prompts.js";
export {
  buildTurnReminderForSession,
  createDispatcherTools,
} from "./core/tools.js";
export type {
  DeliverToUserFn,
  DispatcherToolDef,
  DispatcherToolDeps,
  RecentActivityFn,
} from "./core/tools.js";

