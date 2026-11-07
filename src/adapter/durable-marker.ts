import type {
  CompactionBoundary,
  CompactionBoundaryStore,
  DurableDispatcherMark,
  DurableDispatcherMarkAnswer,
  DurableWorkerMarker,
  DurableWorkerSession,
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
 * Ticket 142 (owner ruling 2026-10-22 — the children half): the durable wake
 * identity of a WORKER session — one row per child this plugin spawned as a
 * worker, keyed by the worker id (which is the child session id).
 *
 * `parentSessionId` is REQUIRED here (unlike the dispatcher mark's optional
 * one): a row without a spawner could not be cold-resumed, so the schema
 * rejects it rather than silently reading "this id carries no spawner".
 *
 * Rows ARE deleted — on terminal settle, on abort, and when an unknown-state
 * hold is released. The dispatcher rows are never deleted because a
 * dispatcher keeps its identity across restarts; a finished worker must not
 * be resurrected (ticket 04: stop is for good).
 */
export const WORKER_SESSION_TABLE_NAME = "worker_sessions";
/**
 * Ticket 113: the domain gained the `inbox_jobs` table, so the spec bumps
 * from 1 to 2. Existing `worker_markers` rows keep their shape (the new
 * `external` field is optional); the version bump only declares the wider
 * table set.
 *
 * Ticket 124: the `compaction_boundaries` table is added WITHOUT a version
 * bump. A stored unit version that differs from the declared one refuses to
 * open (see {@link DOMAIN_LEGACY_VERSIONS} for how older stores are still
 * admitted), so bumping to 3 would refuse to open every existing marker store
 * on upgrade — the opposite of what a new optional table needs. A store
 * written before this ticket opens with the new table empty. Downgrades are
 * not supported and are not a case this repo claims.
 *
 * Ticket 130: `dispatcher_sessions` is added the same way, same reason.
 *
 * Ticket 142: `worker_sessions` is added the same way again — no bump, so an
 * existing store opens with the new table empty.
 */
export const DOMAIN_VERSION = 2;

/**
 * Ticket 149: stored unit versions a read still accepts. The owner's live
 * store was stamped version 1 (written before ticket 113 bumped the spec) and
 * every `storageDomain.open` had thrown `version-mismatch` since, so no mark
 * was read or written for about a month.
 *
 * Mechanism chosen from the installed library, not guessed
 * (`@deepseek-ai/dsh-storage-json` 0.2.1-rc.2):
 *
 * - The `single` layout parses the one document and compares the stored
 *   `unit.version` against the descriptor EXACTLY
 *   (`lib/index.js:100-102`); `compatibleVersions` is never consulted there.
 *   The backend contract says so outright: "`single`-layout reads stay
 *   exact-version" (`dsh-storage/lib/types/backend.d.ts:65-66`). So declaring
 *   `compatibleVersions: [1]` while staying `single` would change nothing.
 * - The `per-record` layout builds `acceptedStamps` = current version plus
 *   `compatibleVersions` (`lib/index.js:353-355`) and, when the unit tree
 *   holds no document yet, BOOTSTRAPS it from a legacy whole-unit file
 *   stamped with an accepted version (`bootstrapLegacyUnit`,
 *   `lib/index.js:370-397`): each record is copied into a document stamped
 *   with the CURRENT version, and the legacy file is never changed.
 *
 * That bootstrap is the library's own migration step. Declaring
 * `layout: "per-record"` plus `compatibleVersions: [DOMAIN_LEGACY_VERSIONS]`
 * therefore opens the v1 store once, rewrites its rows as version-2
 * documents, and keeps the old file untouched on disk for inspection.
 * Writes always stamp {@link DOMAIN_VERSION}.
 *
 * Recorded limit of that layout: a record key becomes a path segment and must
 * match `[a-zA-Z0-9_-]+` (`lib/index.js:301-302`, `:581-584`). Host session
 * ids and worker ids already match. Inbox `jobId`s come from an external
 * queue file, where an exotic id (a dot, a space) would now reject at write
 * instead of being stored; the inbox paths that write checkpoints already log
 * and retry, so such a job is re-presented rather than lost.
 */
export const DOMAIN_LEGACY_VERSIONS: readonly number[] = [1];

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
const WORKER_STATUSES: readonly string[] = [
  "spawned",
  "running",
  "steering",
  "completed",
  "error",
  "aborted",
];

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
  // A torn/legacy row must not open as a LIVE marker: an unknown status would
  // otherwise hold its stream key as unknown-state forever. Reject instead of
  // guessing a status.
  if (typeof m.status !== "string" || !WORKER_STATUSES.includes(m.status)) {
    throw new Error("worker marker.status must be a known worker status");
  }
  if (m.transcriptRef !== null && typeof m.transcriptRef !== "string") {
    throw new Error("worker marker.transcriptRef must be string or null");
  }
  if (m.todoId !== null && typeof m.todoId !== "string") {
    throw new Error("worker marker.todoId must be string or null");
  }
  // Optional for rows written before ticket 58; when present it must be a
  // real count, not NaN/Infinity from a torn write.
  if (
    m.redriveAttempts !== undefined &&
    (typeof m.redriveAttempts !== "number" ||
      !Number.isFinite(m.redriveAttempts))
  ) {
    throw new Error("worker marker.redriveAttempts must be a finite number");
  }
  // Optional for rows written before the inbox existed (ticket 113). A
  // present value must be a complete origin: a half-filled one would silently
  // lose the re-presentation dedupe key.
  if (m.external !== undefined) {
    const external = m.external;
    if (typeof external !== "object" || external === null) {
      throw new Error("worker marker.external must be an object");
    }
    const e = external as Record<string, unknown>;
    if (e.kind !== "inbox") {
      throw new Error("worker marker.external.kind must be 'inbox'");
    }
    if (typeof e.jobId !== "string" || e.jobId.length === 0) {
      throw new Error(
        "worker marker.external.jobId must be a non-empty string",
      );
    }
    if (typeof e.jobDir !== "string" || e.jobDir.length === 0) {
      throw new Error(
        "worker marker.external.jobDir must be a non-empty string",
      );
    }
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
  // The interface contract (src/core/durability.ts) is stricter than the
  // field types: the two lists are index-aligned, never empty, and
  // `boundarySeq` is the LAST replacement's log seq (the resume cut). A row
  // that disagrees with itself must fail at open, not guide a resume.
  const clearedSeqs = b.clearedSeqs as readonly number[];
  const replacementSeqs = b.replacementSeqs as readonly number[];
  if (clearedSeqs.length !== replacementSeqs.length) {
    throw new Error(
      "compaction boundary.clearedSeqs and replacementSeqs must have equal length",
    );
  }
  if (replacementSeqs.length === 0) {
    throw new Error("compaction boundary.replacementSeqs must not be empty");
  }
  if (b.boundarySeq !== replacementSeqs[replacementSeqs.length - 1]) {
    throw new Error(
      "compaction boundary.boundarySeq must be the last replacement seq",
    );
  }
  return value as CompactionBoundary;
}

const compactionBoundaryValueSchema = {
  parse: parseCompactionBoundary,
};

/**
 * Minimal open-time validation for a dispatcher identity row (ticket 130).
 * The session id is the key AND the only required field; a row missing it is
 * malformed. Ticket 138 adds the optional spawner, so a malformed parent is
 * rejected instead of being read as "no parent" (which would silently disable
 * wake-on-send).
 *
 * Ticket 141 adds the optional generation (no DOMAIN_VERSION bump): a missing
 * field is a pre-141 row and parses fine; a present one must be an integer of
 * at least 2, because every marked session was spawned — generation 1 is
 * reserved for user-started dispatchers, which never carry a mark.
 *
 * Ticket 285 adds the optional worker default, following the same precedent:
 * a missing field is a pre-285 row and restores no default; a present one
 * should be a complete route (a plain object with non-empty string provider
 * and model). Critic finding 5: a malformed value is dropped FROM THAT ONE
 * FIELD, not from the row. The required session id and the optional parent /
 * generation are the leader's durable identity; rejecting the whole row would
 * let a bad optional default erase them (backup-and-skip moves the document
 * aside). The drop is logged once, and the host simply restores no default.
 */
function parseDispatcherMark(value: unknown): DurableDispatcherMark {
  if (typeof value !== "object" || value === null) {
    throw new Error("dispatcher mark must be an object");
  }
  const m = value as Record<string, unknown>;
  if (typeof m.sessionId !== "string" || m.sessionId.length === 0) {
    throw new Error("dispatcher mark.sessionId must be a non-empty string");
  }
  if (
    m.parentSessionId !== undefined &&
    typeof m.parentSessionId !== "string"
  ) {
    throw new Error("dispatcher mark.parentSessionId must be a string");
  }
  if (m.generation !== undefined) {
    if (
      typeof m.generation !== "number" ||
      !Number.isInteger(m.generation) ||
      m.generation < 2
    ) {
      throw new Error(
        "dispatcher mark.generation must be an integer >= 2 when present",
      );
    }
  }
  if (m.workerModel !== undefined) {
    const route = m.workerModel;
    // Plain object only: an array or a primitive here is a foreign/torn row,
    // never a route the host could apply.
    const plainObject =
      typeof route === "object" && route !== null && !Array.isArray(route);
    const w = (plainObject ? route : {}) as Record<string, unknown>;
    const malformed =
      !plainObject ||
      typeof w.provider !== "string" ||
      w.provider.length === 0 ||
      typeof w.model !== "string" ||
      w.model.length === 0;
    if (malformed) {
      // Critic finding 5: one bad OPTIONAL field must not cost the leader its
      // durable identity. Drop only the default and say so once; the rest of
      // the row is returned as-is.
      try {
        console.warn(
          `[multitask-dispatcher] dispatcher mark for ${m.sessionId} carried a malformed workerModel; the default was dropped.`,
        );
      } catch {
        // A broken console must not break the store open either.
      }
      const { workerModel: _dropped, ...rest } = m;
      return rest as unknown as DurableDispatcherMark;
    }
  }
  return value as DurableDispatcherMark;
}

const dispatcherMarkValueSchema = {
  parse: parseDispatcherMark,
};

/**
 * Minimal open-time validation for a worker wake row (ticket 142). BOTH
 * fields are required: the id is the key a send resolves, and the spawner is
 * the sender a cold resume needs. A row missing either is malformed — reading
 * it as "no parent" would silently disable wake-on-send for that worker.
 */
function parseWorkerSession(value: unknown): DurableWorkerSession {
  if (typeof value !== "object" || value === null) {
    throw new Error("worker session must be an object");
  }
  const s = value as Record<string, unknown>;
  if (typeof s.sessionId !== "string" || s.sessionId.length === 0) {
    throw new Error("worker session.sessionId must be a non-empty string");
  }
  if (typeof s.parentSessionId !== "string" || s.parentSessionId.length === 0) {
    throw new Error("worker session.parentSessionId must be a non-empty string");
  }
  return value as DurableWorkerSession;
}

const workerSessionValueSchema = {
  parse: parseWorkerSession,
};

/** Domain spec handed to `storageDomain.open`. */
export function markerDomainSpec(): unknown {
  return {
    name: MARKER_DOMAIN_NAME,
    version: DOMAIN_VERSION,
    // Ticket 149: the library's own v1 migration route. `per-record` is what
    // makes `compatibleVersions` mean anything (the `single` layout compares
    // the stored stamp exactly); a legacy whole-unit file stamped with an
    // accepted version is bootstrapped into current-version documents on the
    // first open, unchanged on disk. See {@link DOMAIN_LEGACY_VERSIONS}.
    layout: "per-record",
    compatibleVersions: DOMAIN_LEGACY_VERSIONS,
    // One torn or foreign row must not brick the WHOLE domain. The installed
    // `@deepseek-ai/dsh-storage-domain` default rejects the entire `open()`
    // with `invalid-record` when any stored row fails its table schema, and
    // the failed open is retried against the SAME row forever — so one bad
    // row would disable every marker/wake/inbox/compaction table until the
    // process restarts, permanently.
    //
    // `backup-and-skip` is the library policy for exactly this: the
    // `per-record` backend (which this spec selects) implements
    // `KvUnit.backupRecord`, so the failing document is moved aside as
    // `<key>.json.bak.<stamp>`, the cause is logged, and the record is
    // treated as absent. Absence is the fail-closed answer for every table
    // here (no live marker, no dispatcher mark, no checkpoint), and the
    // bytes stay on disk for inspection. A domain that cannot be opened at
    // all (permission error, version mismatch, backend missing) still
    // rejects: this policy only covers per-record schema validation.
    // See `DomainSpec.invalidRecords` in the installed
    // `dsh-storage-domain/lib/types/spec.d.ts`.
    invalidRecords: "backup-and-skip",
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
      [WORKER_SESSION_TABLE_NAME]: {
        valueSchema: workerSessionValueSchema,
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
 * Backoff between `storageDomain.open` attempts after a failure. The first
 * retry is immediate-ish and the delay doubles to {@link DOMAIN_OPEN_RETRY_MAX_MS},
 * so one transient failure recovers on the next call while a permanently
 * broken store is probed at most once per window instead of on every marker
 * operation.
 */
const DOMAIN_OPEN_RETRY_BASE_MS = 100;
const DOMAIN_OPEN_RETRY_MAX_MS = 30_000;

/**
 * Durable marker + inbox checkpoint + compaction boundary + dispatcher
 * identity + worker wake identity store over `ctx.storageDomain` (ADR-0006,
 * ticket 113, ticket 124, ticket 130, ticket 142). Open is lazy: the first
 * read/write opens the domain ONCE (all tables share it — a second open of
 * one namespace is not assumed to be safe); later calls reuse it. Marker key
 * = workerId; checkpoint key = jobId; boundary key = sessionId; dispatcher
 * mark key = sessionId; worker session key = workerId. Reads filter by
 * parentSessionId at roster scale.
 */
export function createStorageDomainDurability(
  storageDomain: StorageDomainLike,
): StorageDomainDurability {
  let domainPromise: Promise<DomainLike> | null = null;
  /**
   * Ticket 140 review fix: the SAME domain, once open, kept in a plain
   * variable so a synchronous peek can read a table without awaiting. The
   * assignment rides the open promise itself, so any caller that awaited a
   * read/write observes it, and no peek ever opens the store (that is the
   * `"unknown"` answer).
   */
  let openedDomain: DomainLike | null = null;
  let disposed = false;
  /**
   * A failed open is NOT cached forever. The cached rejection is dropped and
   * the next call (after a bounded backoff) opens again, so one transient
   * store failure does not disable every marker/row operation for the rest of
   * the process. Until an attempt succeeds, answers stay fail-closed: reads
   * reject and the synchronous peek still says `"unknown"`.
   */
  let openFailures = 0;
  let retryOpenAtMs = 0;
  let lastOpenError: unknown = null;
  /** In-flight operations `dispose` waits for before closing the domain. */
  let inFlight = 0;
  let idleWaiters: Array<() => void> = [];
  let disposePromise: Promise<void> | null = null;

  function finishOperation(): void {
    inFlight -= 1;
    if (inFlight > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async function trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    inFlight += 1;
    try {
      return await operation();
    } finally {
      finishOperation();
    }
  }

  function whenIdle(): Promise<void> {
    if (inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  function openDomain(): Promise<DomainLike> {
    // `Promise.resolve().then` also turns a synchronous `open` throw into a
    // rejection, so every caller sees the same failure mode.
    const attempt = Promise.resolve()
      .then(() => storageDomain.open(markerDomainSpec()))
      .then(
        (domain) => {
          openedDomain = domain;
          openFailures = 0;
          retryOpenAtMs = 0;
          lastOpenError = null;
          return domain;
        },
        (error: unknown) => {
          openFailures += 1;
          const backoffMs = Math.min(
            DOMAIN_OPEN_RETRY_BASE_MS * 2 ** Math.min(openFailures - 1, 20),
            DOMAIN_OPEN_RETRY_MAX_MS,
          );
          retryOpenAtMs = Date.now() + backoffMs;
          lastOpenError = error;
          // Drop the cached rejection: a later call retries instead of
          // inheriting this failure for the life of the process.
          domainPromise = null;
          throw error;
        },
      );
    domainPromise = attempt;
    return attempt;
  }

  function ensureDomain(): Promise<DomainLike> {
    if (disposed) {
      return Promise.reject(new Error("marker store disposed"));
    }
    if (domainPromise !== null) return domainPromise;
    if (openFailures > 0 && Date.now() < retryOpenAtMs) {
      // Backing off after a failure: fail closed rather than hammering the
      // store or pretending there is no data.
      return Promise.reject(
        lastOpenError instanceof Error
          ? lastOpenError
          : new Error("marker store open failed; retry is backing off"),
      );
    }
    return openDomain();
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

  function ensureWorkerSessionTable(): Promise<KvTableLike<DurableWorkerSession>> {
    // Same localized cast as the inbox table (ticket 142).
    return ensureDomain().then(
      (domain) =>
        domain.table(
          WORKER_SESSION_TABLE_NAME,
        ) as unknown as KvTableLike<DurableWorkerSession>,
    );
  }

  const inbox: InboxCheckpointStore = {
    async record(entry: InboxJobCheckpoint): Promise<void> {
      return trackOperation(async () => {
        const table = await ensureInboxTable();
        await table.put(entry.jobId, entry);
      });
    },

    async get(jobId: string): Promise<InboxJobCheckpoint | undefined> {
      return trackOperation(async () => {
        const table = await ensureInboxTable();
        return table.get(jobId);
      });
    },

    async list(): Promise<readonly InboxJobCheckpoint[]> {
      return trackOperation(async () => {
        const table = await ensureInboxTable();
        const out: InboxJobCheckpoint[] = [];
        for (const [, entry] of table.entries()) {
          out.push(entry);
        }
        return out;
      });
    },
  };

  return {
    inbox,

    async writeWorkerMarker(marker: DurableWorkerMarker): Promise<void> {
      return trackOperation(async () => {
        const table = await ensureTable();
        await table.put(marker.workerId, marker);
      });
    },

    async readWorkerMarkers(
      parentSessionId: string,
    ): Promise<readonly DurableWorkerMarker[]> {
      return trackOperation(async () => {
        const table = await ensureTable();
        const out: DurableWorkerMarker[] = [];
        for (const [, marker] of table.entries()) {
          if (marker.parentSessionId === parentSessionId) {
            out.push(marker);
          }
        }
        return out;
      });
    },

    // Ticket 198: the whole marker table, so the core's first rebuild can
    // reserve todo ids owned by sibling dispatchers that have not been
    // rebuilt yet (recovery is lazy and parent-scoped). Same one-domain read
    // as readWorkerMarkers, without the parent filter.
    async listWorkerMarkers(): Promise<readonly DurableWorkerMarker[]> {
      return trackOperation(async () => {
        const table = await ensureTable();
        const out: DurableWorkerMarker[] = [];
        for (const [, marker] of table.entries()) {
          out.push(marker);
        }
        return out;
      });
    },

    async deleteWorkerMarker(workerId: string): Promise<void> {
      return trackOperation(async () => {
        const table = await ensureTable();
        await table.delete(workerId);
      });
    },

    // Ticket 124 / ADR-0029: the compaction boundary in the SAME domain.
    // Keyed by session id, so a newer pass overwrites the previous row and the
    // newest row IS the session's boundary state.
    async writeCompactionBoundary(
      boundary: CompactionBoundary,
    ): Promise<void> {
      return trackOperation(async () => {
        const table = await ensureBoundaryTable();
        await table.put(boundary.sessionId, boundary);
      });
    },

    async readCompactionBoundary(
      sessionId: string,
    ): Promise<CompactionBoundary | undefined> {
      return trackOperation(async () => {
        const table = await ensureBoundaryTable();
        return table.get(sessionId);
      });
    },

    // Ticket 130: durable dispatcher identity, in the SAME domain. Keyed by
    // session id and never deleted — see `DISPATCHER_SESSION_TABLE_NAME`.
    async writeDispatcherMark(mark: DurableDispatcherMark): Promise<void> {
      return trackOperation(async () => {
        const table = await ensureDispatcherTable();
        await table.put(mark.sessionId, mark);
      });
    },

    async readDispatcherMark(
      sessionId: string,
    ): Promise<DurableDispatcherMark | undefined> {
      return trackOperation(async () => {
        const table = await ensureDispatcherTable();
        return table.get(sessionId);
      });
    },

    // Ticket 138: the whole mark table, so the adapter can warm its
    // synchronous "durably known target" set once per activation (the peer
    // fence is synchronous and cannot await a store read).
    async listDispatcherMarks(): Promise<readonly DurableDispatcherMark[]> {
      return trackOperation(async () => {
        const table = await ensureDispatcherTable();
        const out: DurableDispatcherMark[] = [];
        for (const [, mark] of table.entries()) {
          out.push(mark);
        }
        return out;
      });
    },

    // Ticket 140 review fix: the SYNCHRONOUS single-row peek the projection
    // unit's `init` needs. It never opens the store (that open is async): an
    // unopened domain answers "unknown", which the unit treats as "abstain,
    // re-ask later" instead of "not a dispatcher". An open domain answers
    // from the table's in-memory state — the same state every write mutated,
    // so the answer can never be older than the last resolved write.
    peekDispatcherMark(sessionId: string): DurableDispatcherMarkAnswer {
      const domain = openedDomain;
      if (domain === null) {
        return { kind: "unknown" };
      }
      let mark: DurableDispatcherMark | undefined;
      try {
        // Same localized cast the async table helpers use: the stub domain's
        // `table` is typed by the worker markers it was born with.
        const table = domain.table(
          DISPATCHER_SESSION_TABLE_NAME,
        ) as unknown as KvTableLike<DurableDispatcherMark>;
        mark = table.get(sessionId);
      } catch (error) {
        // A table read must never break a session's create path; an
        // unreadable table is exactly the "cannot answer" case.
        void error;
        return { kind: "unknown" };
      }
      return mark === undefined
        ? { kind: "not-dispatcher" }
        : { kind: "dispatcher", mark };
    },

    // Ticket 142: the worker wake identity, in the SAME domain. Keyed by
    // worker id and DELETED once the worker is terminal or abandoned — see
    // `WORKER_SESSION_TABLE_NAME`.
    async writeWorkerSession(session: DurableWorkerSession): Promise<void> {
      return trackOperation(async () => {
        const table = await ensureWorkerSessionTable();
        await table.put(session.sessionId, session);
      });
    },

    async readWorkerSession(
      workerId: string,
    ): Promise<DurableWorkerSession | undefined> {
      return trackOperation(async () => {
        const table = await ensureWorkerSessionTable();
        return table.get(workerId);
      });
    },

    async deleteWorkerSession(workerId: string): Promise<void> {
      return trackOperation(async () => {
        const table = await ensureWorkerSessionTable();
        await table.delete(workerId);
      });
    },

    // Ticket 142: the whole table, read once per activation to warm the
    // adapter's synchronous mirror — same reason as `listDispatcherMarks`.
    async listWorkerSessions(): Promise<readonly DurableWorkerSession[]> {
      return trackOperation(async () => {
        const table = await ensureWorkerSessionTable();
        const out: DurableWorkerSession[] = [];
        for (const [, session] of table.entries()) {
          out.push(session);
        }
        return out;
      });
    },

    dispose(): Promise<void> {
      // Idempotent and shared: a second call while teardown is running waits
      // for the same close, not for a second one.
      if (disposePromise === null) {
        disposePromise = closeDomain();
      }
      return disposePromise;
    },
  };

  async function closeDomain(): Promise<void> {
    disposed = true;
    // Fail closed from this point: a synchronous peek during teardown answers
    // `"unknown"` instead of reading a domain that is about to close.
    openedDomain = null;
    try {
      // Let operations that already acquired the domain finish. Closing under
      // an in-flight write would turn a durable write into a store error that
      // the caller may have `void`ed.
      await whenIdle();
      if (domainPromise !== null) {
        const domain = await domainPromise;
        await domain.close();
      }
    } catch (error) {
      // The plugin unloads with `void markers.dispose()`, so a teardown
      // failure must not surface as an unhandled rejection. The store is being
      // dropped anyway; log and continue.
      try {
        console.warn(
          "[multitask-dispatcher] marker store dispose failed:",
          error,
        );
      } catch {
        // A broken console must not break unload either.
      }
    } finally {
      domainPromise = null;
    }
  }
}
