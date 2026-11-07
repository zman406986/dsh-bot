import type { ModelRoute, WorkerRecord, WorkerStatus } from "./types.js";
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
 * Ticket 130: the durable dispatcher identity — one row per session this
 * plugin spawned as a dispatcher peer. The row carries nothing but the
 * session id (which is also the table key): its PRESENCE is the whole fact.
 *
 * It exists because a spawned dispatcher's only other signal is the in-memory
 * lifecycle registry, which dies with the process. With this row, a
 * cold-resumed child is re-activated as a dispatcher instead of degrading to
 * a plain subagent.
 *
 * Rows are never deleted: deactivation also runs on plugin unload, so a
 * delete there would wipe every mark at each restart. The table grows, and
 * that is accepted.
 */
export interface DurableDispatcherMark {
  readonly sessionId: string;
  /**
   * Ticket 138: the session that spawned this dispatcher. Present on rows
   * written from 138 on; absent on rows written before it (accepted window —
   * such a row still answers "this is not a phantom", it just cannot be
   * cold-resumed from a send, because the host's `sendMessage` needs the
   * exact live parent Agent as sender).
   *
   * Nothing else is derived from it: it is the sender for the resume call,
   * never a permission.
   */
  readonly parentSessionId?: string;
  /**
   * Ticket 141: which generation of dispatcher this session is — a
   * user-started dispatcher is generation 1, and each spawn adds one. Present
   * on rows written from 141 on; absent on earlier rows, which activate as
   * generation 2 (every mark row we ever wrote came from a spawn).
   *
   * It rides this row rather than a new table for the ticket-130 reason: the
   * identity is already durable here, so a cold-resumed child keeps the number
   * it was spawned with. Optional, so no DOMAIN_VERSION bump — pre-141 rows
   * stay readable.
   */
  readonly generation?: number;
  /**
   * Ticket 285 (plan §1.6, Task 10): the default model route this team leader
   * was given for every worker it later spawns
   * (`spawn_dispatcher.worker_model`). Present on rows written from 285 on;
   * absent on earlier rows, which restore
   * no default and let workers inherit the leader's own route — safe
   * degradation. Carried on the same row for the ticket-130 reason: identity is
   * already durable here, so a cold-resumed leader keeps the default it was
   * summoned with. Optional, so no DOMAIN_VERSION bump.
   */
  readonly workerModel?: ModelRoute;
}

/**
 * Ticket 140 review fix: the three answers a SYNCHRONOUS mark peek can give.
 * See {@link DurabilityPort.peekDispatcherMark}.
 */
export type DurableDispatcherMarkAnswer =
  | { readonly kind: "dispatcher"; readonly mark: DurableDispatcherMark }
  | { readonly kind: "not-dispatcher" }
  | { readonly kind: "unknown" };

/**
 * Ticket 142 (owner ruling 2026-10-22 — the CHILDREN half of "bots should be
 * wake-able"): the durable wake identity of a WORKER session — one row per
 * child this plugin spawned as a worker, keyed by the worker id (which IS the
 * child session id).
 *
 * The row is deliberately separate from {@link DurableWorkerMarker}: the
 * marker is an OBLIGATION record (it exists while delivery may still be owed,
 * and is deleted on abort or hold release), while this row answers "is this
 * id a worker we spawned, and who spawned it?" — the two facts a send needs
 * to wake a dormant worker. Rows are deleted when the worker becomes terminal
 * or is abandoned: a finished worker must never be resurrected (ticket 04).
 */
export interface DurableWorkerSession {
  readonly sessionId: string;
  /**
   * The dispatcher session that spawned this worker — the sender a cold
   * resume needs. Unlike the dispatcher mark's optional field, this is
   * REQUIRED: a row without a spawner could not be resumed, so the schema
   * rejects it rather than reading it as "no parent".
   */
  readonly parentSessionId: string;
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
  /**
   * Ticket 198: every marker in the store, any order. The first restart
   * rebuild reads this ONCE to seed the process-local todo id sequence past
   * ids a sibling dispatcher's not-yet-rebuilt marker still owns — recovery
   * is lazy and parent-scoped, so nothing else carries that knowledge before
   * the sibling activates. Optional like the other list seams: a store that
   * omits it keeps the pre-198 behaviour, where the restore-time relink is
   * the safety net instead.
   */
  listWorkerMarkers?():
    | readonly DurableWorkerMarker[]
    | Promise<readonly DurableWorkerMarker[]>;
  /** Drop a marker once its obligation is closed (delivered or aborted). */
  deleteWorkerMarker(workerId: string): void | Promise<void>;
  /**
   * Ticket 130: record that this session was spawned as a dispatcher peer.
   * Written once, after the spawn resolved; never deleted (deactivation also
   * runs on plugin unload, so a delete would wipe the mark at every restart).
   *
   * Optional so stores and test doubles written before this ticket keep
   * compiling; a store that omits it simply has no durable dispatcher
   * identity, which is the pre-130 behaviour.
   */
  writeDispatcherMark?(mark: DurableDispatcherMark): void | Promise<void>;
  /**
   * Ticket 130: the mark for one session, or undefined when it was never
   * spawned as a dispatcher. Optional for the same reason as the write.
   */
  readDispatcherMark?(
    sessionId: string,
  ):
    | DurableDispatcherMark
    | undefined
    | Promise<DurableDispatcherMark | undefined>;
  /**
   * Ticket 138: every mark in the table, any order. The adapter reads this
   * ONCE per activation to warm its synchronous "is this target durably
   * known?" set — the peer fence is synchronous and cannot await a store
   * read, so the mark table is mirrored in memory. Optional for the same
   * reason as the two seams above.
   */
  listDispatcherMarks?():
    | readonly DurableDispatcherMark[]
    | Promise<readonly DurableDispatcherMark[]>;
  /**
   * Ticket 140 review fix: a SYNCHRONOUS, single-row read of the mark table
   * that never opens the store. Three answers, because two are not enough:
   *
   * - `"dispatcher"` — the row is right there;
   * - `"not-dispatcher"` — the table is open and holds no row for this id, so
   *   the absence is a real answer;
   * - `"unknown"` — the store has not been opened yet (its open is async), so
   *   absence proves nothing.
   *
   * The projection unit's `init` is synchronous and must not cache a
   * definitive "not a dispatcher" it cannot support, so it needs exactly this
   * distinction. Optional like the other mark seams: a store that omits it
   * answers `"unknown"` from the caller's point of view until it reports
   * `"not-dispatcher"` some other way.
   */
  peekDispatcherMark?(sessionId: string): DurableDispatcherMarkAnswer;
  /**
   * Ticket 142 (owner ruling 2026-10-22 — children half): record that this
   * worker id is a live worker session this plugin spawned, and which
   * dispatcher spawned it. Written once at spawn; dropped on settle, abort,
   * or hold release.
   *
   * Optional so stores and test doubles written before this ticket keep
   * compiling; a store that omits it simply has no durable worker wake
   * identity, which is the pre-142 behaviour.
   */
  writeWorkerSession?(session: DurableWorkerSession): void | Promise<void>;
  /** Ticket 142: the row for one worker id, or undefined. */
  readWorkerSession?(
    workerId: string,
  ): DurableWorkerSession | undefined | Promise<DurableWorkerSession | undefined>;
  /** Ticket 142: drop the row once the worker is terminal or abandoned. */
  deleteWorkerSession?(workerId: string): void | Promise<void>;
  /**
   * Ticket 142: every row, any order. Read ONCE per dispatcher activation to
   * warm the adapter's synchronous mirror — the steer/message fence is
   * synchronous and cannot await a store read.
   */
  listWorkerSessions?():
    | readonly DurableWorkerSession[]
    | Promise<readonly DurableWorkerSession[]>;
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
  /**
   * Delivery redrive attempts spent before the restart (ticket 58, D-5),
   * carried off the marker so reclaiming the worker continues the same
   * lifetime budget instead of restarting it. Optional — a marker written
   * before this field exists reads as 0.
   */
  readonly redriveAttempts?: number;
  /**
   * External intake provenance carried off the marker (ticket 113). The hold
   * is the only copy of the marker between rebuild and reclaim, so dropping
   * it here would make a reclaimed inbox job lose its delivery routing and
   * become re-presentable as a duplicate. Optional because markers written
   * before the inbox exist.
   */
  readonly external?: TodoExternalOrigin;
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
  /** Ticket 130: dispatcher identity marks, keyed by session id. */
  readonly dispatcherMarks: Map<string, DurableDispatcherMark>;
  /** Ticket 142: worker wake identity rows, keyed by worker id. */
  readonly workerSessions: Map<string, DurableWorkerSession>;
}

export function createInMemoryDurability(): InMemoryDurability {
  const markers = new Map<string, DurableWorkerMarker>();
  // Ticket 124: the boundary lives beside the markers in the SAME store — one
  // domain, two tables, exactly like the adapter's storage domain.
  const boundaries = new Map<string, CompactionBoundary>();
  // Ticket 130: same store again; the mark's presence is the whole fact.
  const dispatcherMarks = new Map<string, DurableDispatcherMark>();
  // Ticket 142: worker wake identity, same store, its own table.
  const workerSessions = new Map<string, DurableWorkerSession>();
  return {
    markers,
    boundaries,
    dispatcherMarks,
    workerSessions,
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
    listWorkerMarkers(): readonly DurableWorkerMarker[] {
      return [...markers.values()];
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
    writeDispatcherMark(mark: DurableDispatcherMark): void {
      dispatcherMarks.set(mark.sessionId, { ...mark });
    },
    readDispatcherMark(sessionId: string): DurableDispatcherMark | undefined {
      return dispatcherMarks.get(sessionId);
    },
    listDispatcherMarks(): readonly DurableDispatcherMark[] {
      return [...dispatcherMarks.values()];
    },
    // Ticket 140 polish: same synchronous three-answer peek as the storage
    // domain store (durable-marker.ts). This map is always "open", so the
    // answer is never `"unknown"` — absence here is a real "no".
    peekDispatcherMark(sessionId: string): DurableDispatcherMarkAnswer {
      const mark = dispatcherMarks.get(sessionId);
      return mark === undefined
        ? { kind: "not-dispatcher" }
        : { kind: "dispatcher", mark };
    },
    writeWorkerSession(session: DurableWorkerSession): void {
      workerSessions.set(session.sessionId, { ...session });
    },
    readWorkerSession(workerId: string): DurableWorkerSession | undefined {
      return workerSessions.get(workerId);
    },
    deleteWorkerSession(workerId: string): void {
      workerSessions.delete(workerId);
    },
    listWorkerSessions(): readonly DurableWorkerSession[] {
      return [...workerSessions.values()];
    },
  };
}
