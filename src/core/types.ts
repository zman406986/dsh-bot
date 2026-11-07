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

/**
 * Ticket 285: an explicit provider/model route for an opt-in spawn model
 * choice. Exactly the two fields the catalog resolves; reasoning effort and
 * maxTokens are deliberately not part of the option.
 */
export interface ModelRoute {
  readonly provider: string;
  readonly model: string;
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
  /**
   * Ticket 285: model route for this worker. Omitted means the host keeps
   * today's inheritance behavior (the team leader's worker default, then the
   * team leader's own live route).
   */
  model?: ModelRoute;
}

/**
 * Ticket 285: which spawn argument a model value came from. Drives the
 * fallback warning's wording and the tool-result notice.
 */
export type ModelOptionPurpose = "leader" | "worker" | "worker-default";

/** Ticket 285: why a non-empty model option fell back to the inherited route. */
export type ModelResolutionFailure =
  | "unknown-model"
  | "ambiguous-model"
  | "catalog-unavailable"
  | "catalog-error";

/**
 * Ticket 285: result of validating one model option against the live model
 * catalog. A fallback is not a refusal — the spawn still succeeds on the
 * normal route and only carries a notice.
 */
export type ModelOptionResolution =
  | { kind: "absent" }
  | { kind: "resolved"; route: ModelRoute }
  | {
      kind: "fallback";
      requested: string;
      reason: ModelResolutionFailure;
      /** Optional display detail (for example a partial catalog read). */
      detail?: string;
    };

/**
 * Ticket 285: structured tool-result note that a requested model was not
 * used. Absent on both success results when the option resolved or was
 * omitted.
 */
export interface ModelFallbackNotice {
  readonly option: "model" | "worker_model";
  readonly requested: string;
  readonly reason: ModelResolutionFailure;
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
  /**
   * Activation label; the adapter now writes it through the host title service
   * as the child's stored session title at spawn (durable, ticket 286), so
   * the sidebar shows it instead of "Untitled". Workers are unaffected.
   */
  title: string;
  /** Problem and outcome handoff; the child's first user turn. */
  prompt: string;
  /**
   * Ticket 285: model route for the summoned team leader. Omitted means the
   * leader inherits the summoner's current live route, exactly as before.
   */
  model?: ModelRoute;
  /**
   * Ticket 285: default model route for every worker this team leader later
   * spawns. Omitted means workers inherit the leader's own live route; an
   * explicit model on a worker spawn still wins over this default.
   */
  workerModel?: ModelRoute;
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
  /**
   * Ticket 285: explicit model route for this worker, already validated by
   * the host's resolver. Omitted means "use today's inheritance behavior".
   */
  model?: ModelRoute;
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
  | {
      readonly ok: true;
      /**
       * Ticket 142: present when the worker had NO roster record and the
       * correction was accepted through its durable wake row — the host was
       * asked to cold-resume the session, so the text becomes that session's
       * next message instead of folding in at a step boundary that does not
       * exist yet. Absent on the normal live path, so existing exact-shape
       * assertions (`deepEqual(result, { ok: true })`) stay valid.
       */
      readonly dormant?: true;
    }
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
