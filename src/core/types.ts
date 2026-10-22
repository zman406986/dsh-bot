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
  /**
   * Delivery redrive attempts spent on this worker's result (ticket 58).
   * Mirrored from the ledger item so the durable marker can persist it and a
   * restart continues the same budget instead of restarting it.
   */
  redriveAttempts: number;
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
  /**
   * Env/credential *names* this worker may later resolve (scoped injection).
   * Values never appear here, in the prompt, or in any core log.
   */
  credentialNames?: readonly string[];
  /**
   * Ticket 120: called by the host with this worker's id the moment the id is
   * fixed — SYNCHRONOUSLY, before the child can emit `agent/created` or
   * `agent/status` (both fire inside `startActivation`). The core registers
   * its worker record here so the child's first `agent/status: running` is
   * not ignored as an unknown id.
   *
   * Contract: called at most once per spawn, and the host must resolve
   * `spawnWorker` with the same id. A host that resolves a different id is
   * followed by the core (the record is re-keyed, status included), never
   * duplicated. Hosts that cannot commit to an id up front may omit the call;
   * the record is then created after the spawn resolves, exactly as before.
   */
  onWorkerId?: (workerId: string) => void;
}

/**
 * Ticket 118 (ADR-0025 mitosis): what the core/host passes to spawn ANOTHER
 * DISPATCHER. Deliberately not `SpawnOptions`: there is no stream key (a
 * dispatcher is not a work stream) and no credential list, and the spawned
 * child is a peer with its own state, not a worker.
 */
export interface DispatcherSpawnOptions {
  /** The spawning dispatcher's session — the authority agent resolves from it. */
  parentSessionId: string;
  /** Activation label; the host shows it as the child's title. */
  title: string;
  /** Problem and outcome handoff; the child's first user turn. */
  prompt: string;
  /**
   * Cancellation BEFORE publication only (same rule as a worker spawn: once
   * the activation is live, its signal does nothing). Optional — the host
   * mints its own controller when a caller supplies none.
   */
  signal?: AbortSignal;
}

/** Host answer for a dispatcher spawn: the child's session id, branded out. */
export interface DispatcherSpawnResult {
  /** Child session id — the identity the activation path binds and scopes. */
  readonly dispatcherId: string;
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
  /** Env/credential names this worker may resolve. Values never appear here. */
  credentialNames?: readonly string[];
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
    }
  | {
      /**
       * Ticket 59 (register B-1): a worker that was live at crash time still
       * holds this stream key. We cannot prove it is gone, so we refuse to put
       * a second live worker on the same stream. Distinct from
       * `duplicate-stream-key` on purpose — this one is resolvable, and the
       * remedy is a decision the dispatcher makes, not a blind retry.
       */
      readonly ok: false;
      readonly reason: "stream-key-held-by-unknown-state";
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
