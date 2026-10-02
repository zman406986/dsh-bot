import type {
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
 * Ticket 113: the domain gained the `inbox_jobs` table, so the spec bumps
 * from 1 to 2. Existing `worker_markers` rows keep their shape (the new
 * `external` field is optional); the version bump only declares the wider
 * table set.
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
export interface StorageDomainDurability extends DurabilityPort {
  /** Ticket 113: the shared domain's inbox checkpoint table. */
  readonly inbox: InboxCheckpointStore;
  /** Close the opened domain. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Durable marker + inbox checkpoint store over `ctx.storageDomain`
 * (ADR-0006, ticket 113). Open is lazy: the first read/write opens the
 * domain ONCE (both tables share it — a second open of one namespace is
 * not assumed to be safe); later calls reuse it. Marker key = workerId;
 * checkpoint key = jobId. Reads filter by parentSessionId at roster scale.
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
