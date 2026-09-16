import type { DshHost } from "./dsh-host.js";
import {
  type SpawnRequest,
  type SteerResult,
  type WorkerRecord,
  type WorkerStatus,
} from "./types.js";
import {
  createSteerQueue,
  type SteerQueue,
  wrapParentCorrection,
} from "./steer-queue.js";
import { applyEvent, type WorkerEvent } from "./worker-fsm.js";

/**
 * Public multitask-core surface.
 * Status changes flow through the pure worker FSM (see worker-fsm.ts);
 * illegal transitions are ignored rather than thrown.
 */
export interface Multitask {
  /** Spawn a worker through the host and put it on the live roster. */
  spawnWorker(request: SpawnRequest): Promise<string>;
  /** Interrupt a worker through the host and mark it aborted. Late settles are dropped. */
  abortWorker(workerId: string): Promise<void>;
  /**
   * Park a steer for a live worker and interrupt its current step.
   * Single-slot last-wins: a newer steer replaces any undelivered one.
   * Refused (and never recreates a worker) when the worker is not live mid-work.
   */
  steerWorker(workerId: string, message: string): Promise<SteerResult>;
  /** First turn started: spawned → running. No-op if illegal. */
  noteTurnStarted(workerId: string): void;
  /** Steer received for a running worker: running → steering. No-op if illegal. */
  noteSteerReceived(workerId: string): void;
  /** Steer injected and work continues: steering → running. No-op if illegal. */
  noteSteerInjected(workerId: string): void;
  listWorkers(parentSessionId: string): WorkerRecord[];
  getWorker(workerId: string): WorkerRecord | undefined;
}

export function createMultitask(host: DshHost): Multitask {
  const workers = new Map<string, WorkerRecord>();
  const steerQueue: SteerQueue = createSteerQueue();

  /** Apply a lifecycle event; returns the new status or undefined if ignored. */
  function transition(
    workerId: string,
    event: WorkerEvent,
  ): WorkerStatus | undefined {
    const record = workers.get(workerId);
    if (record === undefined) return undefined;
    const next = applyEvent(record.status, event);
    if (next === null) return undefined;
    record.status = next;
    return next;
  }

  host.onWorkerSettled((event) => {
    const next = transition(event.workerId, {
      type: "settled",
      status: event.status,
    });
    // Double settle and post-abort settles are ignored — never revive, never re-wake.
    if (next === undefined) return;
    const record = workers.get(event.workerId);
    if (record === undefined) return;
    void host.requestDispatcherWakeup(record.parentSessionId);
  });

  // Step boundary: pop the latest parked steer, wrap it as a parent correction,
  // and deliver it into the same worker. Last-wins — earlier steers were already
  // overwritten in the single slot and are never delivered.
  host.onStepBoundary((workerId) => {
    const record = workers.get(workerId);
    if (record === undefined || record.status !== "steering") return;
    const latest = steerQueue.pop(workerId);
    if (latest === undefined) return;
    return host.sendMessage(workerId, wrapParentCorrection(latest)).then(() => {
      transition(workerId, { type: "steer-injected" });
    });
  });

  return {
    async spawnWorker(request: SpawnRequest): Promise<string> {
      const workerId = await host.spawnWorker(request.prompt, {
        parentSessionId: request.parentSessionId,
        streamKey: request.streamKey,
        title: request.title,
      });
      const record: WorkerRecord = {
        workerId,
        parentSessionId: request.parentSessionId,
        streamKey: request.streamKey,
        title: request.title,
        status: "spawned",
        startedAtMs: Date.now(),
        transcriptRef: null,
        todoId: null,
      };
      workers.set(workerId, record);
      return workerId;
    },

    async abortWorker(workerId: string): Promise<void> {
      const record = workers.get(workerId);
      if (record === undefined) {
        throw new Error(`unknown worker: ${workerId}`);
      }
      const next = transition(workerId, { type: "aborted" });
      if (next === undefined) {
        // Already terminal — do not interrupt again.
        return;
      }
      // Mark first, then interrupt: a late host settle must not revive the worker.
      await host.interruptWorker(workerId);
    },

    async steerWorker(workerId: string, message: string): Promise<SteerResult> {
      const record = workers.get(workerId);
      if (record === undefined) {
        return {
          ok: false,
          reason: "unknown-worker",
          detail: `unknown worker: ${workerId}`,
        };
      }
      // Only a live mid-work worker can be steered. Spawned has not started;
      // terminal states may already be done. Never silently recreate.
      if (record.status !== "running" && record.status !== "steering") {
        return {
          ok: false,
          reason: "not-running",
          detail: `worker ${workerId} is not running; it may already be done`,
        };
      }

      // Single-slot last-wins: replaces any undelivered steer for this worker.
      steerQueue.park(workerId, message);

      if (record.status === "running") {
        transition(workerId, { type: "steer-received" });
        await host.interruptWorker(workerId);
        // A settle may have raced the interrupt — do not leave a steer parked
        // for a worker that is no longer steering.
        if (workers.get(workerId)?.status !== "steering") {
          steerQueue.clear(workerId);
        }
      }
      // Already steering: a delivery is pending; it will pick up this message.
      return { ok: true };
    },

    noteTurnStarted(workerId: string): void {
      transition(workerId, { type: "turn-started" });
    },

    noteSteerReceived(workerId: string): void {
      transition(workerId, { type: "steer-received" });
    },

    noteSteerInjected(workerId: string): void {
      transition(workerId, { type: "steer-injected" });
    },

    listWorkers(parentSessionId: string): WorkerRecord[] {
      return [...workers.values()].filter(
        (worker) => worker.parentSessionId === parentSessionId,
      );
    },

    getWorker(workerId: string): WorkerRecord | undefined {
      return workers.get(workerId);
    },
  };
}

export type { SpawnRequest, SteerResult, WorkerRecord, WorkerStatus };
