export { Config, apply, inject, name } from "./plugin.js";
export type { PluginConfig } from "./plugin.js";
export type { DshHost } from "./core/dsh-host.js";
export { FakeDshHost } from "./core/fake-host.js";
export type { SendMessageCall, SpawnCall } from "./core/fake-host.js";
export { createMultitask } from "./core/multitask.js";
export type { Multitask } from "./core/multitask.js";
export { createSteerQueue, wrapParentCorrection } from "./core/steer-queue.js";
export type { SteerQueue } from "./core/steer-queue.js";
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
