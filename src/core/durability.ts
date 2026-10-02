import type { WorkerRecord, WorkerStatus } from "./types.js";
import type { TodoExternalOrigin } from "./todo-reconciler.js";

/**
 * Minimum-to-reconstruct durable marker (ADR-0006).
 * Written at spawn through the host's session/storage facility; never a
 * second transcript DB. Carries only what a post-restart roster rebuild
 * needs — the worker report itself stays in dsh's transcript.
 */
export interface DurableWorkerMarker {
  readonly workerId: string;
  readonly parentSessionId: string;
  readonly streamKey: string;
  readonly title: string;
  /** Status snapshot at write time. Live statuses become unknown-state on rebuild. */
  readonly status: WorkerStatus;
  /** Transcript pointer (child session id), when the host has one. */
  readonly transcriptRef: string | null;
  readonly todoId: string | null;
  /**
   * Delivery redrive attempts spent before the restart (ticket 58, D-5).
   * Optional because markers written before that ticket exist in live stores;
   * a missing value reads as 0. Persisting it is what makes the bound a
   * lifetime budget rather than a per-boot one.
   */
  readonly redriveAttempts?: number;
  /**
   * External intake provenance (ticket 113). Optional because markers
   * written before the inbox exist; a restored marker re-creates the ledger
   * item with this origin so delivery routing and re-presentation dedupe
   * still recognize the job.
   */
  readonly external?: TodoExternalOrigin;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
}

/**
 * Host-backed durable store for worker markers.
 * The dsh adapter implements this over `ctx.storageDomain` (ticket 09);
 * tests use {@link createInMemoryDurability} and discard the core between
 * simulated restarts. Core must not invent its own transcript database.
 */
export interface DurabilityPort {
  /** Write (upsert) one marker. Resolve only once the write is durable. */
  writeWorkerMarker(marker: DurableWorkerMarker): void | Promise<void>;
  /** Markers for one parent session, in any order. */
  readWorkerMarkers(
    parentSessionId: string,
  ): readonly DurableWorkerMarker[] | Promise<readonly DurableWorkerMarker[]>;
  /** Drop a marker once its obligation is closed (delivered or aborted). */
  deleteWorkerMarker(workerId: string): void | Promise<void>;
}

/**
 * A live marker that cannot be reconstructed after a restart.
 * Reported honestly: never replayed, never resumed, never invented.
 * Ticket 59 (register B-1): it keeps its stream key occupied until the
 * dispatcher resolves it (`releaseUnknownStateHold` / `stop_worker`).
 * `transcriptRef` falls back to the worker id (child session id) so the
 * dispatcher can still point the user at the transcript.
 */
export interface UnknownStateWorker {
  readonly workerId: string;
  readonly parentSessionId: string;
  readonly streamKey: string;
  readonly title: string;
  /** Status the marker last snapshotted — always a live status. */
  readonly lastKnownStatus: WorkerStatus;
  readonly transcriptRef: string | null;
  readonly todoId: string | null;
}

/** What a rebuild-from-markers pass restored or refused to invent. */
export interface RebuildReport {
  /** Terminal workers restored onto the roster (delivery may still be owed). */
  readonly restored: readonly WorkerRecord[];
  /**
   * Live markers left as unknown-state. Ticket 59 (register B-1): each still
   * **holds its stream key** until the dispatcher resolves it — the key is not
   * free, because the worker may still be alive and we hold no interrupt
   * handle for it.
   */
  readonly unknownState: readonly UnknownStateWorker[];
}

/**
 * Project a roster record onto its durable marker.
 * `external` stamps the linked todo's intake provenance when the caller
 * knows it (ticket 113) — the core passes the ledger item's origin so a
 * rebuild can re-create the inbox link.
 */
export function toDurableMarker(
  record: WorkerRecord,
  external?: TodoExternalOrigin | null,
): DurableWorkerMarker {
  return {
    workerId: record.workerId,
    parentSessionId: record.parentSessionId,
    streamKey: record.streamKey,
    title: record.title,
    status: record.status,
    transcriptRef: record.transcriptRef,
    todoId: record.todoId,
    redriveAttempts: record.redriveAttempts,
    ...(external ? { external } : {}),
    startedAtMs: record.startedAtMs,
    updatedAtMs: Date.now(),
  };
}

/**
 * In-memory marker store that outlives a Multitask instance.
 * Tests hold this across a simulated restart and pass only this store
 * into the rebuilt core (ADR-0006: rebuild from persisted state only).
 */
export interface InMemoryDurability extends DurabilityPort {
  /** Direct map for assertions. Keyed by workerId. */
  readonly markers: Map<string, DurableWorkerMarker>;
}

export function createInMemoryDurability(): InMemoryDurability {
  const markers = new Map<string, DurableWorkerMarker>();
  return {
    markers,
    writeWorkerMarker(marker: DurableWorkerMarker): void {
      markers.set(marker.workerId, { ...marker });
    },
    readWorkerMarkers(
      parentSessionId: string,
    ): readonly DurableWorkerMarker[] {
      return [...markers.values()].filter(
        (marker) => marker.parentSessionId === parentSessionId,
      );
    },
    deleteWorkerMarker(workerId: string): void {
      markers.delete(workerId);
    },
  };
}
