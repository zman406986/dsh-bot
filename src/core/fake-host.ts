import type { DshHost } from "./dsh-host.js";
import type { AccessRequestEvent } from "./access-types.js";
import type { SettledEvent, SpawnOptions } from "./types.js";

export interface SpawnCall {
  prompt: string;
  opts: SpawnOptions;
  workerId: string;
}

export interface SendMessageCall {
  workerId: string;
  message: string;
}

/**
 * Hand-written stand-in for `DshHost`.
 * Records spawn / interrupt / send / wake calls and lets a test fire
 * settled and step-boundary events. No mocking framework — tests assert
 * against the recorded lists.
 */
export class FakeDshHost implements DshHost {
  readonly spawnCalls: SpawnCall[] = [];
  readonly interruptCalls: string[] = [];
  readonly sendMessageCalls: SendMessageCall[] = [];
  readonly wakeCalls: string[] = [];

  #settledCallbacks: Array<(event: SettledEvent) => void> = [];
  #stepBoundaryCallbacks: Array<(workerId: string) => void | Promise<void>> = [];
  #accessRequestCallbacks: Array<(event: AccessRequestEvent) => void> = [];
  #nextId = 1;

  async spawnWorker(prompt: string, opts: SpawnOptions): Promise<string> {
    const workerId = `fake-worker-${this.#nextId++}`;
    this.spawnCalls.push({ prompt, opts, workerId });
    return workerId;
  }

  async interruptWorker(workerId: string): Promise<void> {
    this.interruptCalls.push(workerId);
  }

  async sendMessage(workerId: string, message: string): Promise<void> {
    this.sendMessageCalls.push({ workerId, message });
  }

  onWorkerSettled(cb: (event: SettledEvent) => void): void {
    this.#settledCallbacks.push(cb);
  }

  onStepBoundary(cb: (workerId: string) => void | Promise<void>): void {
    this.#stepBoundaryCallbacks.push(cb);
  }

  onAccessRequest(cb: (event: AccessRequestEvent) => void): void {
    this.#accessRequestCallbacks.push(cb);
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

  /** Test helper: fire a step-boundary event and await any delivery it triggers. */
  async fireStepBoundary(workerId: string): Promise<void> {
    for (const cb of [...this.#stepBoundaryCallbacks]) {
      await cb(workerId);
    }
  }

  /** Test helper: deliver an access request to every subscriber. */
  fireAccessRequest(event: AccessRequestEvent): void {
    for (const cb of [...this.#accessRequestCallbacks]) {
      cb(event);
    }
  }
}

