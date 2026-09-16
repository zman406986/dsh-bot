export { Config, apply, inject, name } from "./plugin.js";
export type { PluginConfig } from "./plugin.js";
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
