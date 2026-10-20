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
 * Ticket 124 / ADR-0029: the compaction boundary — the single marker resume
 * reads to know whether a microcompact pass landed.
 *
 * One row per dispatcher session (key = session id), so the newest row is that
 * session's whole boundary state. It lives in the SAME `multitask_dispatcher`
 * storage domain as the worker markers (ADR-0006: dsh's own store, no second
 * database, no local search index — ADR-0018 U-H).
 *
 * Semantics (ADR-0012: the marker replays, the work does not):
 * - The row is written ONCE, AFTER every listed replacement landed. That is
 *   the "one rollback unit" the ticket requires: either the complete boundary
 *   (and the record of what it describes) is present, or no boundary is
 *   recorded at all. There is deliberately no `planned`/`aborted` half-state
 *   and no second marker.
 * - A crash mid-pass therefore leaves no marker. The surface is still
 *   consistent — every landed `compaction/prune` + replacement pair is
 *   complete and self-priced — and the next pass re-evaluates from the
 *   current surface, skipping nodes already cleared. Nothing is replayed.
 * - Resume reads the newest row (keyed by session id) and knows the compaction
 *   boundary is at {@link boundarySeq}; it never infers a boundary from
 *   transcript shape.
 *
 * The marker carries no transcript text: the cleared content is still in the
 * session's append-only log, which is dsh's store, not ours.
 */
export interface CompactionBoundary {
  /** Dispatcher session this boundary belongs to (the table key). */
  readonly sessionId: string;
  /** Monotonic per-session pass counter; the newest row wins. */
  readonly passSeq: number;
  /**
   * Always `applied`: only a completed pass is ever recorded (one rollback
   * unit — no partial layout). Kept as a named field so a future layer can
   * extend the vocabulary explicitly instead of guessing from shape.
   */
  readonly status: "applied";
  /** Which layer wrote it. Only `microcompact` exists today. */
  readonly layer: "microcompact";
  /** What asked for the pass. Only `ratio` exists today. */
  readonly trigger: "ratio";
  /** `usedTokens / windowTokens` at decision time. */
  readonly ratio: number;
  /** Newest tool results that were protected. */
  readonly keepNewest: number;
  /** Measured request pressure at decision time. */
  readonly usedTokens: number;
  /** Advertised route capacity at decision time (`request/context`). */
  readonly windowTokens: number;
  /** Threshold that fired (`floor(windowTokens * ratio)`). */
  readonly thresholdTokens: number;
  /** Current-surface seqs that were replaced, oldest first. */
  readonly clearedSeqs: readonly number[];
  /**
   * Seqs of the replacement nodes, index-aligned with `clearedSeqs`. Never
   * empty: the row is only written after they all landed.
   */
  readonly replacementSeqs: readonly number[];
  /**
   * The session log seq of the LAST replacement — the resume cut. Everything
   * at or before it belongs to the logged compaction; resume continues after
   * it.
   */
  readonly boundarySeq: number;
  /** How many tool results the pass cleared. */
  readonly clearedCount: number;
  /** Characters removed across the pass (audit). */
  readonly clearedChars: number;
  /** UTF-8 bytes removed across the pass (audit). */
  readonly clearedBytes: number;
  /** Heuristic tokens the pass freed. */
  readonly freedTokens: number;
  /** Epoch ms the row was written. */
  readonly updatedAtMs: number;
}

/**
 * Where the boundary is read and written. Implemented by the adapter over the
 * same storage domain as {@link DurabilityPort}; tests use
 * {@link createInMemoryDurability}.
 */
export interface CompactionBoundaryStore {
  /** Upsert the row for `boundary.sessionId`. Resolve once durable. */
  writeCompactionBoundary(boundary: CompactionBoundary): void | Promise<void>;
  /**
   * The newest row for one session, or undefined when the session never
   * compacted. "Newest" is `passSeq`; the store keys by session id, so there is
   * at most one row per session and this is also the only row.
   */
  readCompactionBoundary(
    sessionId: string,
  ):
    | CompactionBoundary
    | undefined
    | Promise<CompactionBoundary | undefined>;
}

/**
 * Host-backed durable store for worker markers.
 * The dsh adapter implements this over `ctx.storageDomain` (ticket 09);
 * tests use {@link createInMemoryDurability} and discard the core between
 * simulated restarts. Core must not invent its own transcript database.
 *
 * Ticket 124 keeps {@link CompactionBoundaryStore} OUT of this interface: the
 * marker port is the core's narrowed contract for roster rebuild, and the
 * compaction boundary is the adapter's concern. A store that also carries
 * boundaries implements both (the adapter's `StorageDomainDurability` does).
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
export interface InMemoryDurability
  extends DurabilityPort,
    CompactionBoundaryStore {
  /** Direct map for assertions. Keyed by workerId. */
  readonly markers: Map<string, DurableWorkerMarker>;
  /** Ticket 124: compaction boundaries, keyed by session id. */
  readonly boundaries: Map<string, CompactionBoundary>;
}

export function createInMemoryDurability(): InMemoryDurability {
  const markers = new Map<string, DurableWorkerMarker>();
  // Ticket 124: the boundary lives beside the markers in the SAME store — one
  // domain, two tables, exactly like the adapter's storage domain.
  const boundaries = new Map<string, CompactionBoundary>();
  return {
    markers,
    boundaries,
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
    writeCompactionBoundary(boundary: CompactionBoundary): void {
      boundaries.set(boundary.sessionId, { ...boundary });
    },
    readCompactionBoundary(
      sessionId: string,
    ): CompactionBoundary | undefined {
      return boundaries.get(sessionId);
    },
  };
}
