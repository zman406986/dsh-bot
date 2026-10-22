import type {
  CompactionBoundary,
  CompactionBoundaryStore,
  DurableDispatcherMark,
  DurableWorkerMarker,
  DurabilityPort,
} from "../core/durability.js";

/**
 * Structural view of `ctx.storageDomain` (dsh-storage-domain).
 * Only the open/table surface the marker store uses; no host package import.
 */
export interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface DomainLike {
  table(name: string): KvTableLike<DurableWorkerMarker>;
  close(): Promise<void>;
}

export interface StorageDomainLike {
  open(spec: unknown): Promise<DomainLike>;
}

/** Domain name — must match UNIT_NAME_RE (`^[a-z][a-z0-9_]*$`). */
export const MARKER_DOMAIN_NAME = "multitask_dispatcher";
export const MARKER_TABLE_NAME = "worker_markers";
/** Ticket 113: per-job checkpoint of what WE did (A5 — never a second store). */
export const INBOX_TABLE_NAME = "inbox_jobs";
/**
 * Ticket 124 / ADR-0029: the compaction boundary, one row per dispatcher
 * session. Same domain, new table — the boundary rides dsh's own store
 * (ADR-0006) instead of a second database.
 */
export const COMPACTION_BOUNDARY_TABLE_NAME = "compaction_boundaries";
/**
 * Ticket 130: the durable dispatcher identity — one row per session this
 * plugin spawned as a dispatcher peer, keyed by session id. Read on
 * `agent/created`, so a cold-resumed child is re-activated as a dispatcher
 * instead of degrading to a plain subagent.
 *
 * Rows are NEVER deleted. A dispatcher's deactivation also runs on plugin
 * unload, so deleting there would wipe every mark at each restart — the
 * opposite of what this table is for. The table grows; that is accepted.
 */
export const DISPATCHER_SESSION_TABLE_NAME = "dispatcher_sessions";
/**
 * Ticket 113: the domain gained the `inbox_jobs` table, so the spec bumps
 * from 1 to 2. Existing `worker_markers` rows keep their shape (the new
 * `external` field is optional); the version bump only declares the wider
 * table set.
 *
 * Ticket 124: the `compaction_boundaries` table is added WITHOUT a version
 * bump. `dsh-storage-json`'s single layout rejects any stored unit version
 * that differs from the declared one (`lib/index.js:100-102`), so bumping to
 * 3 would refuse to open every existing marker store on upgrade — the opposite
 * of what a new optional table needs. A store written before this ticket opens
 * with the new table empty. Downgrades are not supported and are not a case
 * this repo claims.
 *
 * Ticket 130: `dispatcher_sessions` is added the same way, same reason.
 */
export const DOMAIN_VERSION = 2;

/**
 * Ticket 113: what we did to one inbox job, in OUR store (A5: the watched
 * dir is the external system's store — this table only records our own
 * progress so a boot rescan knows which claimed jobs still owe work and
 * which reached a terminal outcome).
 */
export type InboxJobState =
  | "claimed"
  | "presented"
  | "replied"
  | "failed"
  | "cancelled";

export interface InboxJobCheckpoint {
  readonly jobId: string;
  readonly state: InboxJobState;
  /**
   * The directory we claimed (entry.dir when it existed, else
   * `<root>/<jobId>`). Recorded because the boot rescan must find the job's
   * prompt and status files without re-trusting the (mutable) queue line's
   * `dir` field.
   */
  readonly jobDir: string;
  /** Dispatcher session the job was presented to; null while only claimed. */
  readonly sessionId: string | null;
  /** Ledger item created for the presentation, when one was created. */
  readonly todoId: string | null;
  readonly claimedAtMs: number;
  readonly presentedAtMs: null | number;
  /** Terminal-time timestamp; null while claimed/presented. */
  readonly endedAtMs: null | number;
  /** Presentation attempts spent (re-presentation on activation counts). */
  readonly presentAttempts: number;
}

/**
 * Minimal zod-compatible record schema for storageDomain open-time validation.
 * storage-domain calls `.parse` on each loaded record; writes are not re-validated.
 * Structural stand-in keeps the adapter free of a `zod` dependency.
 */
function parseWorkerMarker(value: unknown): DurableWorkerMarker {
  if (typeof value !== "object" || value === null) {
    throw new Error("worker marker must be an object");
  }
  const m = value as Record<string, unknown>;
  if (typeof m.workerId !== "string" || m.workerId.length === 0) {
    throw new Error("worker marker.workerId must be a non-empty string");
  }
  if (typeof m.parentSessionId !== "string") {
    throw new Error("worker marker.parentSessionId must be a string");
  }
  if (typeof m.streamKey !== "string") {
    throw new Error("worker marker.streamKey must be a string");
  }
  if (typeof m.title !== "string") {
    throw new Error("worker marker.title must be a string");
  }
  if (typeof m.status !== "string") {
    throw new Error("worker marker.status must be a string");
  }
  if (m.transcriptRef !== null && typeof m.transcriptRef !== "string") {
    throw new Error("worker marker.transcriptRef must be string or null");
  }
  if (m.todoId !== null && typeof m.todoId !== "string") {
    throw new Error("worker marker.todoId must be string or null");
  }
  if (typeof m.startedAtMs !== "number") {
    throw new Error("worker marker.startedAtMs must be a number");
  }
  if (typeof m.updatedAtMs !== "number") {
    throw new Error("worker marker.updatedAtMs must be a number");
  }
  return value as DurableWorkerMarker;
}

const markerValueSchema = {
  parse: parseWorkerMarker,
};

const INBOX_STATES: readonly string[] = [
  "claimed",
  "presented",
  "replied",
  "failed",
  "cancelled",
];

/** Minimal open-time validation for checkpoint records. */
function parseInboxCheckpoint(value: unknown): InboxJobCheckpoint {
  if (typeof value !== "object" || value === null) {
    throw new Error("inbox checkpoint must be an object");
  }
  const c = value as Record<string, unknown>;
  if (typeof c.jobId !== "string" || c.jobId.length === 0) {
    throw new Error("inbox checkpoint.jobId must be a non-empty string");
  }
  if (
    typeof c.state !== "string" ||
    !INBOX_STATES.includes(c.state)
  ) {
    throw new Error("inbox checkpoint.state must be a known state");
  }
  if (typeof c.jobDir !== "string" || c.jobDir.length === 0) {
    throw new Error("inbox checkpoint.jobDir must be a non-empty string");
  }
  if (c.sessionId !== null && typeof c.sessionId !== "string") {
    throw new Error("inbox checkpoint.sessionId must be string or null");
  }
  if (c.todoId !== null && typeof c.todoId !== "string") {
    throw new Error("inbox checkpoint.todoId must be string or null");
  }
  if (typeof c.claimedAtMs !== "number") {
    throw new Error("inbox checkpoint.claimedAtMs must be a number");
  }
  if (
    c.presentedAtMs !== null &&
    typeof c.presentedAtMs !== "number"
  ) {
    throw new Error("inbox checkpoint.presentedAtMs must be number or null");
  }
  if (c.endedAtMs !== null && typeof c.endedAtMs !== "number") {
    throw new Error("inbox checkpoint.endedAtMs must be number or null");
  }
  if (typeof c.presentAttempts !== "number") {
    throw new Error("inbox checkpoint.presentAttempts must be a number");
  }
  return value as InboxJobCheckpoint;
}

const inboxValueSchema = {
  parse: parseInboxCheckpoint,
};

/**
 * Minimal open-time validation for compaction boundary rows (ticket 124).
 * Strict on the fields resume depends on; a malformed row must fail at open
 * rather than silently weaken the success marker.
 */
function parseCompactionBoundary(value: unknown): CompactionBoundary {
  if (typeof value !== "object" || value === null) {
    throw new Error("compaction boundary must be an object");
  }
  const b = value as Record<string, unknown>;
  if (typeof b.sessionId !== "string" || b.sessionId.length === 0) {
    throw new Error("compaction boundary.sessionId must be a non-empty string");
  }
  if (typeof b.passSeq !== "number" || !Number.isInteger(b.passSeq) || b.passSeq < 0) {
    throw new Error("compaction boundary.passSeq must be a non-negative integer");
  }
  if (b.status !== "applied") {
    throw new Error("compaction boundary.status must be 'applied'");
  }
  if (b.layer !== "microcompact") {
    throw new Error("compaction boundary.layer must be 'microcompact'");
  }
  if (b.trigger !== "ratio") {
    throw new Error("compaction boundary.trigger must be 'ratio'");
  }
  for (const field of ["ratio", "keepNewest", "usedTokens", "windowTokens"]) {
    if (typeof b[field] !== "number") {
      throw new Error(`compaction boundary.${field} must be a number`);
    }
  }
  for (const field of [
    "thresholdTokens",
    "boundarySeq",
    "clearedCount",
    "clearedChars",
    "clearedBytes",
    "freedTokens",
    "updatedAtMs",
  ]) {
    if (typeof b[field] !== "number") {
      throw new Error(`compaction boundary.${field} must be a number`);
    }
  }
  for (const field of ["clearedSeqs", "replacementSeqs"]) {
    const list = b[field];
    if (!Array.isArray(list) || !list.every((seq) => typeof seq === "number")) {
      throw new Error(`compaction boundary.${field} must be a number array`);
    }
  }
  return value as CompactionBoundary;
}

const compactionBoundaryValueSchema = {
  parse: parseCompactionBoundary,
};

/**
 * Minimal open-time validation for a dispatcher identity row (ticket 130).
 * The session id is the key AND the only field; a row missing it is malformed.
 */
function parseDispatcherMark(value: unknown): DurableDispatcherMark {
  if (typeof value !== "object" || value === null) {
    throw new Error("dispatcher mark must be an object");
  }
  const m = value as Record<string, unknown>;
  if (typeof m.sessionId !== "string" || m.sessionId.length === 0) {
    throw new Error("dispatcher mark.sessionId must be a non-empty string");
  }
  return value as DurableDispatcherMark;
}

const dispatcherMarkValueSchema = {
  parse: parseDispatcherMark,
};

/** Domain spec handed to `storageDomain.open`. */
export function markerDomainSpec(): unknown {
  return {
    name: MARKER_DOMAIN_NAME,
    version: DOMAIN_VERSION,
    tables: {
      [MARKER_TABLE_NAME]: {
        valueSchema: markerValueSchema,
      },
      [INBOX_TABLE_NAME]: {
        valueSchema: inboxValueSchema,
      },
      [COMPACTION_BOUNDARY_TABLE_NAME]: {
        valueSchema: compactionBoundaryValueSchema,
      },
      [DISPATCHER_SESSION_TABLE_NAME]: {
        valueSchema: dispatcherMarkValueSchema,
      },
    },
  };
}

/** Checkpoint read/write over the shared multitask domain. */
export interface InboxCheckpointStore {
  /** Upsert one checkpoint (keyed by jobId). */
  record(entry: InboxJobCheckpoint): Promise<void>;
  get(jobId: string): Promise<InboxJobCheckpoint | undefined>;
  /** Every checkpoint, any order. */
  list(): Promise<readonly InboxJobCheckpoint[]>;
}

/** DurabilityPort plus the inbox checkpoint table plus domain teardown. */
export interface StorageDomainDurability
  extends DurabilityPort,
    CompactionBoundaryStore {
  /** Ticket 113: the shared domain's inbox checkpoint table. */
  readonly inbox: InboxCheckpointStore;
  /** Close the opened domain. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Durable marker + inbox checkpoint + compaction boundary + dispatcher
 * identity store over `ctx.storageDomain` (ADR-0006, ticket 113, ticket 124,
 * ticket 130). Open is lazy: the first read/write opens the domain ONCE (all
 * tables share it — a second open of one namespace is not assumed to be
 * safe); later calls reuse it. Marker key = workerId; checkpoint key = jobId;
 * boundary key = sessionId; dispatcher mark key = sessionId. Reads filter by
 * parentSessionId at roster scale.
 */
export function createStorageDomainDurability(
  storageDomain: StorageDomainLike,
): StorageDomainDurability {
  let domainPromise: Promise<DomainLike> | null = null;
  let disposed = false;

  function ensureDomain(): Promise<DomainLike> {
    if (disposed) {
      return Promise.reject(new Error("marker store disposed"));
    }
    if (domainPromise === null) {
      domainPromise = storageDomain.open(markerDomainSpec());
    }
    return domainPromise;
  }

  function ensureTable(): Promise<KvTableLike<DurableWorkerMarker>> {
    return ensureDomain().then((domain) => domain.table(MARKER_TABLE_NAME));
  }

  function ensureInboxTable(): Promise<KvTableLike<InboxJobCheckpoint>> {
    // The structural view types `table` by the marker rows it was born with;
    // the runtime table is valueSchema-validated at domain open, so the
    // inbox-table view is a single localized cast (no per-name overloads —
    // test fakes keep implementing one `table(name)`).
    return ensureDomain().then(
      (domain) =>
        domain.table(INBOX_TABLE_NAME) as unknown as KvTableLike<InboxJobCheckpoint>,
    );
  }

  function ensureBoundaryTable(): Promise<KvTableLike<CompactionBoundary>> {
    // Same localized cast as the inbox table (ticket 124).
    return ensureDomain().then(
      (domain) =>
        domain.table(
          COMPACTION_BOUNDARY_TABLE_NAME,
        ) as unknown as KvTableLike<CompactionBoundary>,
    );
  }

  function ensureDispatcherTable(): Promise<KvTableLike<DurableDispatcherMark>> {
    // Same localized cast as the inbox table (ticket 130).
    return ensureDomain().then(
      (domain) =>
        domain.table(
          DISPATCHER_SESSION_TABLE_NAME,
        ) as unknown as KvTableLike<DurableDispatcherMark>,
    );
  }

  const inbox: InboxCheckpointStore = {
    async record(entry: InboxJobCheckpoint): Promise<void> {
      const table = await ensureInboxTable();
      await table.put(entry.jobId, entry);
    },

    async get(jobId: string): Promise<InboxJobCheckpoint | undefined> {
      const table = await ensureInboxTable();
      return table.get(jobId);
    },

    async list(): Promise<readonly InboxJobCheckpoint[]> {
      const table = await ensureInboxTable();
      const out: InboxJobCheckpoint[] = [];
      for (const [, entry] of table.entries()) {
        out.push(entry);
      }
      return out;
    },
  };

  return {
    inbox,

    async writeWorkerMarker(marker: DurableWorkerMarker): Promise<void> {
      const table = await ensureTable();
      await table.put(marker.workerId, marker);
    },

    async readWorkerMarkers(
      parentSessionId: string,
    ): Promise<readonly DurableWorkerMarker[]> {
      const table = await ensureTable();
      const out: DurableWorkerMarker[] = [];
      for (const [, marker] of table.entries()) {
        if (marker.parentSessionId === parentSessionId) {
          out.push(marker);
        }
      }
      return out;
    },

    async deleteWorkerMarker(workerId: string): Promise<void> {
      const table = await ensureTable();
      await table.delete(workerId);
    },

    // Ticket 124 / ADR-0029: the compaction boundary in the SAME domain.
    // Keyed by session id, so a newer pass overwrites the previous row and the
    // newest row IS the session's boundary state.
    async writeCompactionBoundary(
      boundary: CompactionBoundary,
    ): Promise<void> {
      const table = await ensureBoundaryTable();
      await table.put(boundary.sessionId, boundary);
    },

    async readCompactionBoundary(
      sessionId: string,
    ): Promise<CompactionBoundary | undefined> {
      const table = await ensureBoundaryTable();
      return table.get(sessionId);
    },

    // Ticket 130: durable dispatcher identity, in the SAME domain. Keyed by
    // session id and never deleted — see `DISPATCHER_SESSION_TABLE_NAME`.
    async writeDispatcherMark(mark: DurableDispatcherMark): Promise<void> {
      const table = await ensureDispatcherTable();
      await table.put(mark.sessionId, mark);
    },

    async readDispatcherMark(
      sessionId: string,
    ): Promise<DurableDispatcherMark | undefined> {
      const table = await ensureDispatcherTable();
      return table.get(sessionId);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (domainPromise !== null) {
        const domain = await domainPromise;
        await domain.close();
      }
    },
  };
}
