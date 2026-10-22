import type { AccessRequestEvent } from "./access-types.js";
import type { AgentMessageWakeOrigin } from "./peer-types.js";
import type {
  DispatcherSpawnOptions,
  DispatcherSpawnResult,
  SettledEvent,
  SpawnOptions,
} from "./types.js";

/**
 * The single host boundary the multitask core depends on.
 * The dsh adapter implements this against live Cordis services;
 * tests use a hand-written fake. Core code must not touch `ctx` directly.
 */
export interface DshHost {
  /**
   * Non-blocking spawn; resolves with a host-assigned worker id.
   *
   * Ticket 120: while this promise is pending the child is already live and
   * emits `agent/created` and its first `agent/status: running`. A host that
   * knows the id up front must call `opts.onWorkerId` with it before those
   * events can fire, and resolve with that same id — the core cannot
   * register a worker it has not been told about, and the worker FSM ignores
   * notices for unknown ids.
   */
  spawnWorker(prompt: string, opts: SpawnOptions): Promise<string>;
  /**
   * Ticket 118 / ADR-0025 mitosis: spawn another DISPATCHER from a bound
   * dispatcher session; resolves with the child's session id.
   *
   * Distinct from `spawnWorker` on purpose: the child is a PEER — it gets no
   * worker composition, enters no worker roster, carries no stream key, and
   * is bounded only by the host's `maxDepth` ceiling (`parentDepth + 2`, see
   * `dispatcherSpawnMaxDepth`) and the 8-active root pool. Host refusals
   * (e.g. `ACTIVATION_LIMIT_REACHED`) surface as-is; the host adds no cap of
   * its own (ADR-0025 §Starting bounds).
   */
  spawnDispatcher(opts: DispatcherSpawnOptions): Promise<DispatcherSpawnResult>;
  /** Interrupt a running worker. Fire-and-return once the host accepted the stop. */
  interruptWorker(workerId: string): Promise<void>;
  /**
   * Deliver a message into a live worker session.
   * Context preserved; never spawns or restarts the worker.
   */
  sendMessage(workerId: string, message: string): Promise<void>;
  /** Subscribe to worker-settled events. Host invokes callbacks on settle. */
  onWorkerSettled(cb: (event: SettledEvent) => void): void;
  /**
   * Subscribe to step-boundary events. Fired when a worker's current step
   * has unwound and the worker is ready for the next step (steer delivery point).
   */
  onStepBoundary(cb: (workerId: string) => void | Promise<void>): void;
  /**
   * Ask the host to open a dispatcher turn (wake), typically after a settle.
   *
   * Ticket 116 / ADR-0025: `origin` is an OPTIONAL structured source
   * override. A peer wake passes `{kind:"agent-message", form:"relay",
   * senderSessionId}` and the host stamps it as the follow-up message's
   * `source` instead of the producer-owned plugin kind, so the durable
   * record says "another agent" — nothing downstream can mistake the turn
   * for user input, and the text body's "not from the user" heading stays
   * presentation only. Absent → the shipped plugin source, unchanged.
   */
  requestDispatcherWakeup(
    sessionId: string,
    origin?: AgentMessageWakeOrigin,
  ): Promise<void>;
  /**
   * Optional: abandon the current non-user dispatcher turn so a priority
   * peer can take the next one. No-op when the current turn is user-owned
   * or none is live. Soft-fallback hosts may omit this — priority then
   * waits for turn end and still jumps ahead of everything non-user.
   */
  requestDispatcherInterrupt?(sessionId: string): Promise<void>;
  /**
   * Subscribe to structured access requests from workers.
   * Host invokes callbacks when a worker's request_access tool is used.
   */
  onAccessRequest(cb: (event: AccessRequestEvent) => void): void;
  /**
   * Optional: resolve a credential *name* to a value for scoped injection.
   * Adapter-only; core never sees the string. Tests never call this.
   *
   * Ticket 102b: the member stays for contract compatibility, but the live
   * Cordis adapter does NOT implement it — its old `(ctx as {credentials?})`
   * read was an undeclared-service read (a latent inject-by-exact-string
   * throw) and was removed; see `cordis-dsh-host.ts`. Credentials reach
   * workers via `SpawnOptions.credentialNames` (ADR-0008), not this seam.
   */
  resolveCredential?(
    credentialName: string,
  ): Promise<{ value: string; source: string } | undefined>;
}

