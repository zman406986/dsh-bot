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
  /** Subscribe to worker-settled events. Host invokes callbacks on settle. */
  onWorkerSettled(cb: (event: SettledEvent) => void): void;
  /** Ask the host to open a dispatcher turn (wake), typically after a settle. */
  requestDispatcherWakeup(sessionId: string): Promise<void>;
}
