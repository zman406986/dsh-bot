export { Config, apply, inject, name } from "./plugin.js";
export type { PluginConfig } from "./plugin.js";
export type { DshHost } from "./core/dsh-host.js";
export { FakeDshHost } from "./core/fake-host.js";
export type { SpawnCall } from "./core/fake-host.js";
export { createMultitask } from "./core/multitask.js";
export type { Multitask } from "./core/multitask.js";
export { isTerminalStatus } from "./core/types.js";
export type {
  SettledEvent,
  SpawnOptions,
  SpawnRequest,
  TerminalWorkerStatus,
  WorkerRecord,
  WorkerStatus,
} from "./core/types.js";
