import type { DshHost } from "./dsh-host.js";
import {
  isTerminalStatus,
  type SpawnRequest,
  type WorkerRecord,
  type WorkerStatus,
} from "./types.js";

/**
 * Public multitask-core surface.
 * Later tickets fill FSM / steer / todo; this scaffold wires the host seam only.
 */
export interface Multitask {
  /** Spawn a worker through the host and put it on the live roster. */
  spawnWorker(request: SpawnRequest): Promise<string>;
  /** Interrupt a worker through the host and mark it aborted. Late settles are dropped. */
  abortWorker(workerId: string): Promise<void>;
  listWorkers(parentSessionId: string): WorkerRecord[];
  getWorker(workerId: string): WorkerRecord | undefined;
}

export function createMultitask(host: DshHost): Multitask {
  const workers = new Map<string, WorkerRecord>();

  host.onWorkerSettled((event) => {
    const record = workers.get(event.workerId);
    if (record === undefined) return;
    // Double settle and post-abort settles are ignored — never revive, never re-wake.
    if (isTerminalStatus(record.status)) return;
    record.status = event.status;
    void host.requestDispatcherWakeup(record.parentSessionId);
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
      if (isTerminalStatus(record.status)) {
        return;
      }
      await host.interruptWorker(workerId);
      record.status = "aborted";
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

export type { SpawnRequest, WorkerRecord, WorkerStatus };
