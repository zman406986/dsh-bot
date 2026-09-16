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

/** Domain spec handed to `storageDomain.open`. */
export function markerDomainSpec(): unknown {
  return {
    name: MARKER_DOMAIN_NAME,
    version: 1,
    tables: {
      [MARKER_TABLE_NAME]: {
        valueSchema: markerValueSchema,
      },
    },
  };
}

/** DurabilityPort plus domain teardown. */
export interface StorageDomainDurability extends DurabilityPort {
  /** Close the opened domain. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Durable marker store over `ctx.storageDomain` (ADR-0006).
 * Open is lazy: the first read/write opens the domain; later calls reuse it.
 * Key = workerId. Read filters by parentSessionId at roster scale.
 */
export function createStorageDomainDurability(
  storageDomain: StorageDomainLike,
): StorageDomainDurability {
  let domainPromise: Promise<DomainLike> | null = null;
  let disposed = false;

  function ensureTable(): Promise<KvTableLike<DurableWorkerMarker>> {
    if (disposed) {
      return Promise.reject(new Error("marker store disposed"));
    }
    if (domainPromise === null) {
      domainPromise = storageDomain.open(markerDomainSpec());
    }
    return domainPromise.then((domain) => domain.table(MARKER_TABLE_NAME));
  }

  return {
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
