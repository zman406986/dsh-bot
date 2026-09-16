import type { DshHost } from "./dsh-host.js";
import type { SettledEvent, SpawnOptions } from "./types.js";

export interface SpawnCall {
  prompt: string;
  opts: SpawnOptions;
  workerId: string;
}

/**
 * Hand-written stand-in for `DshHost`.
 * Records spawn / interrupt / wake calls and lets a test fire a settled event.
 * No mocking framework — tests assert against the recorded lists.
 */
export class FakeDshHost implements DshHost {
  readonly spawnCalls: SpawnCall[] = [];
  readonly interruptCalls: string[] = [];
  readonly wakeCalls: string[] = [];

  #settledCallbacks: Array<(event: SettledEvent) => void> = [];
  #nextId = 1;

  async spawnWorker(prompt: string, opts: SpawnOptions): Promise<string> {
    const workerId = `fake-worker-${this.#nextId++}`;
    this.spawnCalls.push({ prompt, opts, workerId });
    return workerId;
  }

  async interruptWorker(workerId: string): Promise<void> {
    this.interruptCalls.push(workerId);
  }

  onWorkerSettled(cb: (event: SettledEvent) => void): void {
    this.#settledCallbacks.push(cb);
  }

  async requestDispatcherWakeup(sessionId: string): Promise<void> {
    this.wakeCalls.push(sessionId);
  }

  /** Test helper: deliver a settled event to every subscriber. */
  fireSettled(event: SettledEvent): void {
    for (const cb of [...this.#settledCallbacks]) {
      cb(event);
    }
  }
}
