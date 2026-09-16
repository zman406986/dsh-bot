/** Worker lifecycle status. Terminal states never transition out. */
export type WorkerStatus =
  | "spawned"
  | "running"
  | "steering"
  | "completed"
  | "error"
  | "aborted";

export type TerminalWorkerStatus = Extract<
  WorkerStatus,
  "completed" | "error" | "aborted"
>;

export function isTerminalStatus(status: WorkerStatus): status is TerminalWorkerStatus {
  return status === "completed" || status === "error" || status === "aborted";
}

/** Live worker roster entry held by the multitask core. */
export interface WorkerRecord {
  workerId: string;
  parentSessionId: string;
  streamKey: string;
  title: string;
  status: WorkerStatus;
  startedAtMs: number;
  toolCallCount: number;
  transcriptRef: string | null;
  todoId: string | null;
}

/**
 * Listing view of a roster entry: the record fields plus elapsed time
 * computed at list time. Terminal entries stay listed but are not running.
 */
export interface WorkerSummary {
  workerId: string;
  parentSessionId: string;
  streamKey: string;
  title: string;
  status: WorkerStatus;
  startedAtMs: number;
  elapsedMs: number;
  toolCallCount: number;
  transcriptRef: string | null;
  todoId: string | null;
}

/** Options the core passes to the host when spawning a worker. */
export interface SpawnOptions {
  parentSessionId: string;
  streamKey: string;
  title: string;
}

/** Host → core notification that a worker reached a terminal state. */
export interface SettledEvent {
  workerId: string;
  status: TerminalWorkerStatus;
  report: string;
  /** Transcript pointer the host knows at settle time, when available. */
  transcriptRef?: string;
}

/** Public spawn request on the multitask core surface. */
export interface SpawnRequest {
  parentSessionId: string;
  streamKey: string;
  title: string;
  prompt: string;
  /** Linked todo id, when the spawn is driven by a todo. */
  todoId?: string;
}

/**
 * Result of a spawn request.
 * A refusal never creates a worker and never talks to the host.
 */
export type SpawnResult =
  | { readonly ok: true; readonly workerId: string }
  | {
      readonly ok: false;
      readonly reason: "duplicate-stream-key";
      readonly detail: string;
    };

/**
 * Result of a steer request.
 * A refusal never creates a replacement worker.
 */
export type SteerResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "unknown-worker" | "not-running";
      readonly detail: string;
    };

/**
 * Result of a stop request.
 * A refusal never interrupts and never undoes an already-delivered completion.
 */
export type StopResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "already-settled";
      readonly detail: string;
    };
