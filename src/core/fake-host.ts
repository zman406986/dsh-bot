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

/**
 * One interrupt attempt with the authority answer the live adapter would
 * compute. The real host resolves the worker's spawning dispatcher and
 * REJECTS when none is bound (`cordis-dsh-host.ts` `interruptWorker`:
 * "no parent agent bound for worker ...; the interrupt was not issued"), so
 * `authorityAvailable: false` is the honest record of an attempt that
 * recorded the call but never reached `ctx.subagents.interrupt`.
 */
export interface InterruptCall {
  workerId: string;
  authorityAvailable: boolean;
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
  /**
   * One row per interrupt attempt, with the answer the live adapter's
   * authority guard would give. `interruptCalls` stays the string list the
   * existing core tests assert; this is the fidelity surface beside it.
   */
  readonly interruptAuthorityCalls: InterruptCall[] = [];
  /**
   * Opt-in: worker ids the host has no live spawning dispatcher for — the
   * restart case. `interruptWorker` still records the attempt, then rejects
   * with the live adapter's missing-parent error instead of claiming a stop
   * that was never issued.
   */
  readonly noInterruptAuthority = new Set<string>();
  readonly sendMessageCalls: SendMessageCall[] = [];
  /** Attempts that rejected, with the error the caller saw. */
  readonly sendMessageFailures: Array<SendMessageCall & { error: unknown }> = [];
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
  /** Opt-in one-shot `sendMessage` failure, consumed by the next call. */
  #nextSendMessageFailure: { error: unknown } | null = null;
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
    // The core type makes the parent mandatory: a dispatcher exists only as a
    // peer summoned FROM a dispatcher session. A missing/empty parent is not a
    // spawn the live host could serve — its bound-parent lookup throws — so
    // the fake refuses it by name instead of minting an orphan id.
    if (
      typeof opts?.parentSessionId !== "string" ||
      opts.parentSessionId.trim() === ""
    ) {
      throw new Error(
        "FakeDshHost: spawnDispatcher requires a non-empty parentSessionId " +
          "(the core type forbids a missing parent)",
      );
    }
    const dispatcherId = `fake-dispatcher-${this.#nextDispatcherId++}`;
    this.dispatcherSpawnCalls.push({ opts, dispatcherId });
    return { dispatcherId };
  }

  async interruptWorker(workerId: string): Promise<void> {
    this.interruptCalls.push(workerId);
    const authorityAvailable = !this.noInterruptAuthority.has(workerId);
    this.interruptAuthorityCalls.push({ workerId, authorityAvailable });
    // Live adapter: no bound spawning dispatcher => the interrupt is not
    // issued, and the call REJECTS instead of claiming success. The core has
    // already marked the worker terminal and catches this (the committed
    // abort still returns `{ok:true}`), so the refusal is observable without
    // reviving the worker.
    if (!authorityAvailable) {
      throw new Error(
        `CordisDshHost: no parent agent bound for worker ${workerId}; the interrupt was not issued`,
      );
    }
  }

  async sendMessage(workerId: string, message: string): Promise<void> {
    const call: SendMessageCall = { workerId, message };
    this.sendMessageCalls.push(call);
    const failure = this.#nextSendMessageFailure;
    if (failure !== null) {
      this.#nextSendMessageFailure = null;
      this.sendMessageFailures.push({ ...call, error: failure.error });
      throw failure.error;
    }
  }

  /**
   * Opt-in: reject the NEXT `sendMessage`, modelling the live adapter's
   * "no parent agent bound; cannot send" throw. Consumed once, so a later
   * send succeeds unless the test asks again — the default path stays the
   * pre-existing success behaviour every core test relies on.
   */
  failNextSendMessage(
    error: unknown = new Error(
      "CordisDshHost: no parent agent bound; cannot send",
    ),
  ): void {
    this.#nextSendMessageFailure = { error };
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

