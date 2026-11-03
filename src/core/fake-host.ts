import type { DshHost } from "./dsh-host.js";
import type { AgentMessageWakeOrigin } from "./peer-types.js";
import type {
  DispatcherSpawnOptions,
  DispatcherSpawnResult,
  SettledEvent,
  SpawnOptions,
} from "./types.js";

export interface SpawnCall {
  prompt: string;
  opts: SpawnOptions;
  workerId: string;
}

/**
 * Ticket 118: one dispatcher spawn. Kept in its own list, never in
 * `spawnCalls` — a spawned dispatcher is a peer, not a work stream, and a
 * test must be able to see that the worker registry stayed untouched.
 */
export interface DispatcherSpawnCall {
  opts: DispatcherSpawnOptions;
  dispatcherId: string;
}

export interface SendMessageCall {
  workerId: string;
  message: string;
}

/** Ticket 116: one wake request with its optional structured origin. */
export interface WakeOriginCall {
  sessionId: string;
  origin: AgentMessageWakeOrigin | undefined;
}

/**
 * Hand-written stand-in for `DshHost`.
 * Records spawn / interrupt / send / wake calls and lets a test fire
 * settled and step-boundary events. No mocking framework — tests assert
 * against the recorded lists.
 */
export class FakeDshHost implements DshHost {
  readonly spawnCalls: SpawnCall[] = [];
  /**
   * Ticket 118: dispatcher spawns, recorded separately from `spawnCalls`.
   * `spawnCalls.length` staying 0 while this grows is the assertion that a
   * dispatcher spawn never enters the worker path.
   */
  readonly dispatcherSpawnCalls: DispatcherSpawnCall[] = [];
  readonly interruptCalls: string[] = [];
  readonly sendMessageCalls: SendMessageCall[] = [];
  readonly wakeCalls: string[] = [];
  /**
   * Ticket 116: every wake request with its optional structured origin.
   * `wakeCalls` still records the session ids (the pre-116 assertion
   * surface stays valid); this list lets a test prove a peer wake carried
   * `{kind:"agent-message", senderSessionId}` and a settle wake carried
   * none.
   */
  readonly wakeOrigins: WakeOriginCall[] = [];
  readonly interruptDispatcherCalls: string[] = [];
  /**
   * Ticket 142: dormant-worker wakes, in call order. The real adapter parks
   * the text and cold-resumes the session; the fake records the call and keeps
   * the mirror below in step, so a core test can assert acceptance and
   * exactly-once delivery without a host.
   */
  readonly dormantWakeCalls: SendMessageCall[] = [];
  /**
   * Ticket 142: the fake's copy of the host's synchronous worker mirror,
   * keyed by worker id → spawner. `rememberWorkerWake` / `forgetWorkerWake`
   * maintain it exactly as the adapter does.
   */
  readonly workerWakes = new Map<string, string>();

  #settledCallbacks: Array<(event: SettledEvent) => void> = [];
  #stepBoundaryCallbacks: Array<(workerId: string) => void | Promise<void>> = [];
  #nextId = 1;
  /**
   * Ticket 118: dispatcher ids use their OWN sequence so adding a dispatcher
   * spawn to a test can never shift the `fake-worker-N` ids the existing
   * suite asserts on.
   */
  #nextDispatcherId = 1;

  async spawnWorker(prompt: string, opts: SpawnOptions): Promise<string> {
    const workerId = `fake-worker-${this.#nextId++}`;
    // Ticket 120: the real host commits the child id before the child can
    // emit `agent/created`/`agent/status`; the fake does the same so a test
    // that fires an edge from inside `spawnWorker` reproduces that ordering.
    opts.onWorkerId?.(workerId);
    this.spawnCalls.push({ prompt, opts, workerId });
    return workerId;
  }

  /**
   * Ticket 118: a spawned dispatcher gets its own id sequence so a test can
   * tell the two spawn kinds apart by id alone.
   */
  async spawnDispatcher(
    opts: DispatcherSpawnOptions,
  ): Promise<DispatcherSpawnResult> {
    const dispatcherId = `fake-dispatcher-${this.#nextDispatcherId++}`;
    this.dispatcherSpawnCalls.push({ opts, dispatcherId });
    return { dispatcherId };
  }

  async interruptWorker(workerId: string): Promise<void> {
    this.interruptCalls.push(workerId);
  }

  async sendMessage(workerId: string, message: string): Promise<void> {
    this.sendMessageCalls.push({ workerId, message });
  }

  /** Ticket 142: the core's wake seam for a dormant, durably marked worker. */
  async wakeDormantWorker(workerId: string, message: string): Promise<void> {
    this.dormantWakeCalls.push({ workerId, message });
  }

  /** Ticket 142: the host mirror a send is fenced against. */
  rememberWorkerWake(workerId: string, parentSessionId: string): void {
    this.workerWakes.set(workerId, parentSessionId);
  }

  /** Ticket 142: a terminal or abandoned worker stops being wake-able. */
  forgetWorkerWake(workerId: string): void {
    this.workerWakes.delete(workerId);
  }

  onWorkerSettled(cb: (event: SettledEvent) => void): void {
    this.#settledCallbacks.push(cb);
  }

  onStepBoundary(cb: (workerId: string) => void | Promise<void>): void {
    this.#stepBoundaryCallbacks.push(cb);
  }

  /**
   * Ticket 116: `origin` is the optional structured source override. Both
   * lists record every call, so a test can assert the old surface
   * (`wakeCalls`) and the provenance (`wakeOrigins`) independently.
   */
  async requestDispatcherWakeup(
    sessionId: string,
    origin?: AgentMessageWakeOrigin,
  ): Promise<void> {
    this.wakeCalls.push(sessionId);
    this.wakeOrigins.push({ sessionId, origin });
  }

  async requestDispatcherInterrupt(sessionId: string): Promise<void> {
    this.interruptDispatcherCalls.push(sessionId);
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
}

