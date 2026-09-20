import type { AccessRequestEvent } from "./access-types.js";
import type { SettledEvent, SpawnOptions } from "./types.js";

/**
 * The single host boundary the multitask core depends on.
 * The dsh adapter implements this against live Cordis services;
 * tests use a hand-written fake. Core code must not touch `ctx` directly.
 */
export interface DshHost {
  /** Non-blocking spawn; resolves with a host-assigned worker id. */
  spawnWorker(prompt: string, opts: SpawnOptions): Promise<string>;
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
  /** Ask the host to open a dispatcher turn (wake), typically after a settle. */
  requestDispatcherWakeup(sessionId: string): Promise<void>;
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

