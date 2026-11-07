import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createStorageDomainDurability,
  markerDomainSpec,
  MARKER_DOMAIN_NAME,
  MARKER_TABLE_NAME,
  INBOX_TABLE_NAME,
  COMPACTION_BOUNDARY_TABLE_NAME,
  DISPATCHER_SESSION_TABLE_NAME,
  WORKER_SESSION_TABLE_NAME,
  type DomainLike,
  type KvTableLike,
  type StorageDomainDurability,
  type StorageDomainLike,
  type InboxJobCheckpoint,
} from "../src/adapter/durable-marker.js";
import type {
  CompactionBoundary,
  DurableDispatcherMark,
  DurableWorkerMarker,
  DurableWorkerSession,
} from "../src/core/durability.js";

/**
 * The adapter implements every optional `DurabilityPort` seam (tickets
 * 130/138/140/142); the port keeps them optional so stores written before
 * those tickets still compile. These tests exercise the adapter itself, so
 * pin the implemented surface locally rather than asserting non-null at every
 * call site.
 */
type AdapterDurability = StorageDomainDurability &
  Required<
    Pick<
      StorageDomainDurability,
      | "writeDispatcherMark"
      | "readDispatcherMark"
      | "listDispatcherMarks"
      | "peekDispatcherMark"
      | "writeWorkerSession"
      | "readWorkerSession"
      | "deleteWorkerSession"
      | "listWorkerSessions"
    >
  >;

function createDurability(storageDomain: StorageDomainLike): AdapterDurability {
  return createStorageDomainDurability(storageDomain) as AdapterDurability;
}

/**
 * `DomainLike` erases the per-table value type (one domain, one row shape per
 * table); the stub serves each table by name, so cast back to the marker view
 * the port declares.
 */
function asMarkerTable<V>(
  table: KvTableLike<V>,
): KvTableLike<DurableWorkerMarker> {
  return table as unknown as KvTableLike<DurableWorkerMarker>;
}

function createStubStorageDomain(
  options: { readonly putGate?: Promise<void> } = {},
): StorageDomainLike & {
  opens: unknown[];
  backups: Array<{ table: string; key: string }>;
  table: Map<string, DurableWorkerMarker>;
  inbox: Map<string, InboxJobCheckpoint>;
  boundaries: Map<string, CompactionBoundary>;
  dispatchers: Map<string, DurableDispatcherMark>;
  workerSessions: Map<string, DurableWorkerSession>;
  readonly closed: boolean;
  readonly putCalls: number;
} {
  const table = new Map<string, DurableWorkerMarker>();
  const inbox = new Map<string, InboxJobCheckpoint>();
  const boundaries = new Map<string, CompactionBoundary>();
  const dispatchers = new Map<string, DurableDispatcherMark>();
  const workerSessionRows = new Map<string, DurableWorkerSession>();
  const backups: Array<{ table: string; key: string }> = [];
  const opens: unknown[] = [];
  let closed = false;
  let putCalls = 0;

  const kv: KvTableLike<DurableWorkerMarker> = {
    get(key: string) {
      return table.get(key);
    },
    entries() {
      return table.entries();
    },
    async put(key: string, value: DurableWorkerMarker) {
      putCalls += 1;
      if (options.putGate !== undefined) await options.putGate;
      table.set(key, { ...value });
    },
    async delete(key: string) {
      return table.delete(key);
    },
  };

  const inboxKv: KvTableLike<InboxJobCheckpoint> = {
    get(key: string) {
      return inbox.get(key);
    },
    entries() {
      return inbox.entries();
    },
    async put(key: string, value: InboxJobCheckpoint) {
      inbox.set(key, { ...value });
    },
    async delete(key: string) {
      return inbox.delete(key);
    },
  };

  const boundaryKv: KvTableLike<CompactionBoundary> = {
    get(key: string) {
      return boundaries.get(key);
    },
    entries() {
      return boundaries.entries();
    },
    async put(key: string, value: CompactionBoundary) {
      boundaries.set(key, { ...value });
    },
    async delete(key: string) {
      return boundaries.delete(key);
    },
  };

  const dispatcherKv: KvTableLike<DurableDispatcherMark> = {
    get(key: string) {
      return dispatchers.get(key);
    },
    entries() {
      return dispatchers.entries();
    },
    async put(key: string, value: DurableDispatcherMark) {
      dispatchers.set(key, { ...value });
    },
    async delete(key: string) {
      return dispatchers.delete(key);
    },
  };

  const workerSessionKv: KvTableLike<DurableWorkerSession> = {
    get(key: string) {
      return workerSessionRows.get(key);
    },
    entries() {
      return workerSessionRows.entries();
    },
    async put(key: string, value: DurableWorkerSession) {
      workerSessionRows.set(key, { ...value });
    },
    async delete(key: string) {
      return workerSessionRows.delete(key);
    },
  };

  return {
    opens,
    backups,
    table,
    inbox,
    boundaries,
    dispatchers,
    workerSessions: workerSessionRows,
    get closed() {
      return closed;
    },
    get putCalls() {
      return putCalls;
    },
    async open(spec: unknown): Promise<DomainLike> {
      opens.push(spec);
      // Validate schema shape the way storage-domain does (parse on load).
      const s = spec as {
        name: string;
        version: number;
        layout?: string;
        compatibleVersions?: readonly number[];
        invalidRecords?: string;
        tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }>;
      };
      assert.equal(s.name, MARKER_DOMAIN_NAME);
      assert.equal(s.version, 2);
      assert.ok(s.tables[MARKER_TABLE_NAME]);
      assert.ok(s.tables[INBOX_TABLE_NAME]);
      assert.ok(s.tables[COMPACTION_BOUNDARY_TABLE_NAME]);
      assert.ok(s.tables[DISPATCHER_SESSION_TABLE_NAME]);
      // Ticket 142: the worker wake table rides the same domain.
      assert.ok(s.tables[WORKER_SESSION_TABLE_NAME]);
      // Transcribe the installed storage-domain's open-time validation
      // (`@deepseek-ai/dsh-storage-domain` `lib/index.js`): EVERY loaded
      // record is parsed against its table's valueSchema, and a failure rejects
      // the WHOLE open with `invalid-record` — unless the spec declares
      // `invalidRecords: "backup-and-skip"` AND the unit can move documents
      // aside, in which case the record is backed up, logged, and skipped.
      const persisted: Array<[string, Map<string, unknown>]> = [
        [MARKER_TABLE_NAME, table as unknown as Map<string, unknown>],
        [INBOX_TABLE_NAME, inbox as unknown as Map<string, unknown>],
        [COMPACTION_BOUNDARY_TABLE_NAME, boundaries as unknown as Map<string, unknown>],
        [DISPATCHER_SESSION_TABLE_NAME, dispatchers as unknown as Map<string, unknown>],
        [WORKER_SESSION_TABLE_NAME, workerSessionRows as unknown as Map<string, unknown>],
      ];
      for (const [name, rows] of persisted) {
        const parse = s.tables[name]?.valueSchema.parse;
        assert.ok(parse, `no valueSchema for ${name}`);
        for (const [key, value] of [...rows]) {
          try {
            rows.set(key, parse(value));
          } catch (error) {
            if (s.invalidRecords !== "backup-and-skip") {
              const failure = new Error(
                `domain '${s.name}' table '${name}' record '${key}': ${String(error)}`,
              ) as Error & { code: string };
              failure.code = "invalid-record";
              throw failure;
            }
            // `backupRecord` exists only on the per-record backend; a backend
            // without it falls back to the rejecting default (spec doc).
            assert.equal(s.layout, "per-record");
            rows.delete(key);
            backups.push({ table: name, key });
          }
        }
      }
      return {
        table(name: string): KvTableLike<DurableWorkerMarker> {
          if (name === MARKER_TABLE_NAME) return kv;
          if (name === INBOX_TABLE_NAME) return asMarkerTable(inboxKv);
          if (name === COMPACTION_BOUNDARY_TABLE_NAME) return asMarkerTable(boundaryKv);
          if (name === DISPATCHER_SESSION_TABLE_NAME) return asMarkerTable(dispatcherKv);
          if (name === WORKER_SESSION_TABLE_NAME) return asMarkerTable(workerSessionKv);
          throw new Error(`unexpected table ${name}`);
        },
        async close() {
          closed = true;
        },
      };
    },
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds; fails the test on timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(5);
  }
}

/** Retry an operation until it resolves; the open backoff may reject first. */
async function retryUntil<T>(
  operation: () => Promise<T>,
  attempts = 40,
  delayMs = 25,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/** A marker carrying a deliberately malformed `external`, for schema tests. */
function markerWithExternal(external: unknown): DurableWorkerMarker {
  return marker({ external } as unknown as Partial<DurableWorkerMarker>);
}

function marker(overrides: Partial<DurableWorkerMarker> = {}): DurableWorkerMarker {
  return {
    workerId: "w-1",
    parentSessionId: "session-1",
    streamKey: "todo-1",
    title: "Task",
    status: "spawned",
    transcriptRef: null,
    todoId: null,
    startedAtMs: 1000,
    updatedAtMs: 2000,
    ...overrides,
  };
}

function checkpoint(
  overrides: Partial<InboxJobCheckpoint> = {},
): InboxJobCheckpoint {
  return {
    jobId: "job-1",
    state: "claimed",
    jobDir: "/tmp/inbox/job-1",
    sessionId: null,
    todoId: null,
    claimedAtMs: 1000,
    presentedAtMs: null,
    endedAtMs: null,
    presentAttempts: 0,
    ...overrides,
  };
}

/** One compaction boundary row (ticket 124). */
function boundary(
  overrides: Partial<CompactionBoundary> = {},
): CompactionBoundary {
  return {
    sessionId: "s-1",
    passSeq: 1,
    status: "applied",
    layer: "microcompact",
    trigger: "ratio",
    ratio: 0.55,
    keepNewest: 5,
    usedTokens: 600_000,
    windowTokens: 1_000_000,
    thresholdTokens: 550_000,
    clearedSeqs: [2, 3],
    replacementSeqs: [8, 9],
    boundarySeq: 9,
    clearedCount: 2,
    clearedChars: 12_000,
    clearedBytes: 12_000,
    freedTokens: 9_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("durable marker store over storageDomain", () => {
  it("writes, reads by parent, and deletes markers", async () => {
    const sd = createStubStorageDomain();
    const durability = createDurability(sd);

    await durability.writeWorkerMarker(marker());
    await durability.writeWorkerMarker(
      marker({ workerId: "w-2", streamKey: "todo-2", parentSessionId: "session-2" }),
    );

    const s1 = await durability.readWorkerMarkers("session-1");
    assert.equal(s1.length, 1);
    assert.equal(s1[0]?.workerId, "w-1");

    const s2 = await durability.readWorkerMarkers("session-2");
    assert.equal(s2.length, 1);
    assert.equal(s2[0]?.workerId, "w-2");

    await durability.deleteWorkerMarker("w-1");
    const after = await durability.readWorkerMarkers("session-1");
    assert.equal(after.length, 0);
  });

  it("records, updates, and lists inbox checkpoints", async () => {
    const sd = createStubStorageDomain();
    const durability = createDurability(sd);
    await durability.inbox.record(checkpoint());
    await durability.inbox.record(
      checkpoint({ jobId: "job-2", state: "presented", sessionId: "s-9", presentAttempts: 1 }),
    );
    await durability.inbox.record(
      checkpoint({ state: "replied", endedAtMs: 5000, presentAttempts: 1 }),
    );
    const listed = await durability.inbox.list();
    assert.equal(listed.length, 2);
    const job1 = listed.find((c) => c.jobId === "job-1");
    assert.equal(job1?.state, "replied");
    assert.equal(job1?.endedAtMs, 5000);
  });

  it("writes and reads a compaction boundary in the SAME domain (ticket 124)", async () => {
    const sd = createStubStorageDomain();
    const durability = createDurability(sd);

    assert.equal(await durability.readCompactionBoundary("s-1"), undefined);

    await durability.writeCompactionBoundary(boundary());
    assert.equal(sd.opens.length, 1, "the boundary shares the one open domain");
    assert.equal(sd.boundaries.size, 1);

    const read = await durability.readCompactionBoundary("s-1");
    assert.ok(read);
    assert.equal(read.status, "applied");
    assert.deepEqual(read.clearedSeqs, [2, 3]);
    assert.equal(read.boundarySeq, 9);

    // A later pass overwrites the row — one row per session, newest wins.
    await durability.writeCompactionBoundary(
      boundary({ passSeq: 2, boundarySeq: 15, clearedSeqs: [12] }),
    );
    assert.equal(sd.boundaries.size, 1);
    assert.equal((await durability.readCompactionBoundary("s-1"))?.passSeq, 2);
  });

  it("dispose closes the domain and rejects further writes", async () => {
    const sd = createStubStorageDomain();
    const durability = createDurability(sd);
    await durability.writeWorkerMarker(marker());
    await durability.dispose();
    assert.equal(sd.closed, true);
    await assert.rejects(async () => {
      await durability.writeWorkerMarker(marker());
    });
    await assert.rejects(() => durability.inbox.record(checkpoint()));
  });

  it("writes and reads a dispatcher mark in the SAME domain (ticket 130)", async () => {
    const sd = createStubStorageDomain();
    const durability = createDurability(sd);

    // Absent table entry reads as no mark — a session that was never spawned
    // as a dispatcher.
    assert.equal(await durability.readDispatcherMark("child-1"), undefined);

    await durability.writeDispatcherMark({ sessionId: "child-1" });
    assert.equal(sd.opens.length, 1, "the mark shares the one open domain");
    assert.equal(sd.dispatchers.size, 1);

    const read = await durability.readDispatcherMark("child-1");
    assert.ok(read);
    assert.equal(read.sessionId, "child-1");
    // Other sessions stay unmarked.
    assert.equal(await durability.readDispatcherMark("child-2"), undefined);
  });

  it("round-trips the optional generation on a dispatcher mark (ticket 141)", async () => {
    const sd = createStubStorageDomain();
    const durability = createDurability(sd);

    await durability.writeDispatcherMark({
      sessionId: "child-3",
      parentSessionId: "child-2",
      generation: 3,
    });
    const read = await durability.readDispatcherMark("child-3");
    assert.ok(read);
    assert.equal(read.generation, 3);
    assert.equal(read.parentSessionId, "child-2");

    // A pre-141 row is still readable and simply carries no generation.
    await durability.writeDispatcherMark({ sessionId: "child-1" });
    const legacy = await durability.readDispatcherMark("child-1");
    assert.ok(legacy);
    assert.equal(legacy.generation, undefined);
    // No version bump for the new optional field.
    const spec = markerDomainSpec() as { version: number };
    assert.equal(spec.version, 2);
  });

  it("round-trips the optional worker model on a dispatcher mark (ticket 285)", async () => {
    const sd = createStubStorageDomain();
    const durability = createDurability(sd);

    await durability.writeDispatcherMark({
      sessionId: "leader-1",
      parentSessionId: "chat-1",
      generation: 2,
      workerModel: { provider: "pC", model: "mC" },
    });
    const read = await durability.readDispatcherMark("leader-1");
    assert.ok(read);
    assert.deepEqual(read.workerModel, { provider: "pC", model: "mC" });
    assert.equal(read.parentSessionId, "chat-1");

    // A pre-285 row is still readable and simply carries no worker default:
    // its workers inherit the leader's own route (safe degradation).
    await durability.writeDispatcherMark({ sessionId: "leader-legacy" });
    const legacy = await durability.readDispatcherMark("leader-legacy");
    assert.ok(legacy);
    assert.equal(legacy.workerModel, undefined);

    // The whole-table read is what a restart restores from
    // (`refreshDispatcherMarks`), so it must carry the route too.
    const listed = await durability.listDispatcherMarks();
    assert.deepEqual(
      listed.find((mark) => mark.sessionId === "leader-1")?.workerModel,
      { provider: "pC", model: "mC" },
    );
    assert.equal(
      listed.find((mark) => mark.sessionId === "leader-legacy")?.workerModel,
      undefined,
    );
    // No version bump for the new optional field (ticket-141 precedent).
    const spec = markerDomainSpec() as { version: number };
    assert.equal(spec.version, 2);
  });

  it("lists every dispatcher mark so the adapter can warm its mirror (ticket 138)", async () => {
    const sd = createStubStorageDomain();
    const durability = createDurability(sd);

    assert.deepEqual(await durability.listDispatcherMarks(), []);

    await durability.writeDispatcherMark({ sessionId: "child-1", parentSessionId: "p-1" });
    await durability.writeDispatcherMark({ sessionId: "child-2" });

    const listed = await durability.listDispatcherMarks();
    assert.deepEqual(
      listed.map((mark) => mark.sessionId).sort(),
      ["child-1", "child-2"],
    );
    assert.equal(
      listed.find((mark) => mark.sessionId === "child-1")?.parentSessionId,
      "p-1",
    );
    assert.equal(sd.opens.length, 1, "the list shares the one open domain");
  });

  it("peeks one mark synchronously without opening the store (ticket 140 review fix)", async () => {
    const sd = createStubStorageDomain();
    const durability = createDurability(sd);

    // Cold: the domain has never been opened, so absence proves nothing.
    assert.deepEqual(durability.peekDispatcherMark("child-1"), {
      kind: "unknown",
    });
    assert.equal(sd.opens.length, 0, "a peek never opens the domain");

    await durability.writeDispatcherMark({
      sessionId: "child-1",
      parentSessionId: "p-1",
    });
    // Open now: the row is answered synchronously from the same in-memory
    // table every write mutated.
    const hit = durability.peekDispatcherMark("child-1");
    assert.equal(hit.kind, "dispatcher");
    if (hit.kind === "dispatcher") {
      assert.equal(hit.mark.parentSessionId, "p-1");
    }
    // Open and absent: a definitive "no".
    assert.deepEqual(durability.peekDispatcherMark("chat-1"), {
      kind: "not-dispatcher",
    });
    assert.equal(sd.opens.length, 1, "the peek reused the one open domain");
  });

  /**
   * Ticket 142 (owner ruling 2026-10-22 — the children half): the wake
   * identity of a WORKER session. It lives in the same domain, follows the
   * `dispatcher_sessions` shape, and differs on ONE point that is the whole
   * reason it is a separate table: its rows are DELETED when the worker is
   * terminal or abandoned.
   */
  it("writes, reads, lists, and deletes a worker session row in the SAME domain (ticket 142)", async () => {
    const sd = createStubStorageDomain();
    const durability = createDurability(sd);

    // Absent row reads as no mark — a worker session we never spawned.
    assert.equal(await durability.readWorkerSession("w-1"), undefined);

    await durability.writeWorkerSession({
      sessionId: "w-1",
      parentSessionId: "chat-1",
    });
    assert.equal(sd.opens.length, 1, "the row shares the one open domain");
    assert.equal(sd.workerSessions.size, 1);

    const read = await durability.readWorkerSession("w-1");
    assert.ok(read);
    assert.equal(read.parentSessionId, "chat-1");
    // Another id stays unmarked.
    assert.equal(await durability.readWorkerSession("w-2"), undefined);

    await durability.writeWorkerSession({
      sessionId: "w-2",
      parentSessionId: "chat-2",
    });
    const listed = await durability.listWorkerSessions();
    assert.deepEqual(
      listed.map((row) => row.sessionId).sort(),
      ["w-1", "w-2"],
    );
    assert.equal(sd.opens.length, 1, "the list shares the one open domain");

    // Deleted, not tombstoned: a terminal worker must not be wake-able, and a
    // re-read after the delete is the pre-spawn answer.
    await durability.deleteWorkerSession("w-1");
    assert.equal(await durability.readWorkerSession("w-1"), undefined);
    assert.deepEqual(
      (await durability.listWorkerSessions()).map((row) => row.sessionId),
      ["w-2"],
    );
  });

  /**
   * Every table in the domain rejects a row it cannot trust. One table-driven
   * case replaces four near-identical ones; a corrupt persisted row must never
   * read back as a half-valid mark (ADR-0006: unknown state, never invented).
   */
  it("every table's schema rejects a malformed row and accepts its valid shape", () => {
    const spec = markerDomainSpec() as {
      tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }>;
    };
    const cases: ReadonlyArray<{
      table: string;
      rejected: readonly unknown[];
      accepted: unknown;
    }> = [
      {
        table: MARKER_TABLE_NAME,
        rejected: [
          {},
          null,
          // A torn/unknown status must not read back as a live marker that
          // holds its stream key forever.
          marker({ status: "ghost" as unknown as DurableWorkerMarker["status"] }),
          marker({ redriveAttempts: Number.NaN }),
          marker({ redriveAttempts: Number.POSITIVE_INFINITY }),
          marker({ redriveAttempts: "2" as unknown as number }),
          markerWithExternal(null),
          // Half-filled provenance would lose the re-presentation dedupe key.
          markerWithExternal({ kind: "inbox" }),
          markerWithExternal({ kind: "other", jobId: "job-1", jobDir: "/tmp/job-1" }),
          markerWithExternal({ kind: "inbox", jobId: "", jobDir: "/tmp/job-1" }),
          markerWithExternal({ kind: "inbox", jobId: "job-1" }),
        ],
        accepted: marker(),
      },
      { table: INBOX_TABLE_NAME, rejected: [{}, null], accepted: checkpoint() },
      {
        table: COMPACTION_BOUNDARY_TABLE_NAME,
        rejected: [
          {},
          null,
          // The lists are index-aligned in the interface contract.
          boundary({ replacementSeqs: [8] }),
          boundary({ clearedSeqs: [2] }),
          // `boundarySeq` IS the last replacement seq (the resume cut).
          boundary({ boundarySeq: 8 }),
          // A row without replacements is not a completed pass.
          boundary({ clearedSeqs: [], replacementSeqs: [], boundarySeq: 9 }),
        ],
        accepted: boundary(),
      },
      {
        table: DISPATCHER_SESSION_TABLE_NAME,
        rejected: [
          {},
          null,
          { sessionId: "" },
          { sessionId: "child-1", parentSessionId: 7 },
          { sessionId: "child-1", generation: 1 },
        ],
        accepted: { sessionId: "child-1" },
      },
      {
        // Ticket 285: the optional worker default follows the generation
        // precedent — absent parses fine (the case above), but a PRESENT
        // value must be a complete route. A half-filled one would restore a
        // default the host cannot apply.
        table: DISPATCHER_SESSION_TABLE_NAME,
        rejected: [
          { sessionId: "child-1", workerModel: null },
          { sessionId: "child-1", workerModel: "pC/mC" },
          { sessionId: "child-1", workerModel: {} },
          { sessionId: "child-1", workerModel: { provider: "", model: "mC" } },
          { sessionId: "child-1", workerModel: { provider: "pC", model: "" } },
          { sessionId: "child-1", workerModel: { provider: "pC", model: 7 } },
          { sessionId: "child-1", workerModel: { provider: 7, model: "mC" } },
        ],
        accepted: {
          sessionId: "child-1",
          workerModel: { provider: "pC", model: "mC" },
        },
      },
      {
        table: WORKER_SESSION_TABLE_NAME,
        rejected: [{}, null, { sessionId: "" }],
        accepted: { sessionId: "w-1", parentSessionId: "chat-1" },
      },
    ];
    for (const { table, rejected, accepted } of cases) {
      const parse = spec.tables[table]?.valueSchema.parse;
      assert.ok(parse, `no valueSchema for ${table}`);
      for (const row of rejected) {
        assert.throws(() => parse(row), `accepted a malformed ${table} row`);
      }
      assert.doesNotThrow(() => parse(accepted), `rejected a valid ${table} row`);
    }
  });

  /**
   * The stricter marker schema must stay compatible with what the current
   * writer produces and with rows written before the optional fields existed.
   */
  it("accepts legacy and current marker rows", () => {
    const spec = markerDomainSpec() as {
      tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }>;
    };
    const parse = spec.tables[MARKER_TABLE_NAME]?.valueSchema.parse;
    assert.ok(parse);

    // Pre-ticket-58/113 row: neither optional field present.
    assert.doesNotThrow(() => parse(marker()));
    // Current row: the redrive budget and inbox provenance are persisted.
    assert.doesNotThrow(() =>
      parse(
        marker({
          redriveAttempts: 2,
          external: { kind: "inbox", jobId: "job-1", jobDir: "/tmp/inbox/job-1" },
        }),
      ),
    );
    // Every status the core can write is accepted.
    for (const status of [
      "spawned",
      "running",
      "steering",
      "completed",
      "error",
      "aborted",
    ] as const) {
      assert.doesNotThrow(() => parse(marker({ status })));
    }
  });

  /**
   * Defect fix — one bad row bricked the whole store.
   *
   * The installed storage-domain rejects the ENTIRE `open()` with
   * `invalid-record` when any persisted row fails its table schema (see the
   * stub's transcription above). With the strict marker parsers, one torn or
   * foreign row would therefore make every marker/wake/inbox/compaction table
   * unusable, forever: the retry re-reads the same row. The spec now declares
   * `invalidRecords: "backup-and-skip"`, and the per-record backend this spec
   * selects implements `backupRecord`.
   */
  it("opens past one invalid persisted row: backup-and-skip, valid rows readable, later writes work", async () => {
    const sd = createStubStorageDomain();
    // Persisted state: one torn marker row the strict schema rejects, plus
    // valid rows for the same parent. Seeding through the map models rows an
    // older/foreign writer left on disk (not a write through this API).
    sd.table.set("w-bad", { workerId: "w-bad" } as unknown as DurableWorkerMarker);
    sd.table.set("w-good", marker({ workerId: "w-good" }));

    const spec = markerDomainSpec() as {
      layout?: string;
      invalidRecords?: string;
    };
    // The policy's escape hatch (`KvUnit.backupRecord`) exists only on the
    // per-record backend, which is the layout this spec already declares.
    assert.equal(spec.layout, "per-record");
    assert.equal(spec.invalidRecords, "backup-and-skip");

    const durability = createDurability(sd);
    const read = await durability.readWorkerMarkers("session-1");
    assert.deepEqual(
      read.map((row) => row.workerId),
      ["w-good"],
      "the valid row is readable and the bad one is absent",
    );
    assert.deepEqual(
      sd.backups,
      [{ table: MARKER_TABLE_NAME, key: "w-bad" }],
      "the bad row's document was moved aside, not silently dropped",
    );
    assert.equal(sd.table.has("w-bad"), false);
    assert.equal(sd.opens.length, 1, "one successful open, no retry loop");

    // The skipped row does not poison the store: a later write lands and is
    // readable in the same domain.
    await durability.writeWorkerMarker(marker({ workerId: "w-new" }));
    const after = await durability.readWorkerMarkers("session-1");
    assert.deepEqual(
      after.map((row) => row.workerId).sort(),
      ["w-good", "w-new"],
    );
    assert.equal(sd.opens.length, 1, "the write reused the open domain");
  });

  it("control: without the policy the same bad row rejects the whole open (invalid-record)", async () => {
    const sd = createStubStorageDomain();
    sd.table.set("w-bad", { workerId: "w-bad" } as unknown as DurableWorkerMarker);
    const spec = markerDomainSpec() as Record<string, unknown>;
    // The pre-fix declaration: same schemas, no policy.
    await assert.rejects(
      () => sd.open({ ...spec, invalidRecords: undefined }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "invalid-record");
        return true;
      },
    );
  });

  it("a domain that cannot be opened at all still fails loudly (permission error)", async () => {
    const sd = createStubStorageDomain();
    const denial = Object.assign(new Error("EACCES: permission denied"), {
      code: "permission-denied",
    });
    let attempts = 0;
    sd.open = async () => {
      attempts += 1;
      throw denial;
    };
    const durability = createDurability(sd);

    // `invalidRecords` only covers per-record schema validation; an unopenable
    // medium keeps its existing reject-and-retry behavior.
    await assert.rejects(
      async () => {
        await durability.writeWorkerMarker(marker());
      },
      (error: unknown) => error === denial,
    );
    assert.equal(attempts, 1);
    assert.deepEqual(durability.peekDispatcherMark("child-1"), {
      kind: "unknown",
    });
  });

  /**
   * A single transient `storageDomain.open` failure used to poison the cached
   * `domainPromise` for the life of the process: every later marker/row call
   * rejected, the peek answered "unknown" forever, and a hold release threw.
   * The open must retry after a bounded backoff, fail-closed until it does.
   */
  it("retries a transient domain-open failure instead of caching the rejection", async () => {
    const sd = createStubStorageDomain();
    const open = sd.open.bind(sd);
    let attempts = 0;
    sd.open = async (spec: unknown) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient storage failure");
      return open(spec);
    };
    const durability = createDurability(sd);

    await assert.rejects(async () => {
      await durability.writeWorkerMarker(marker());
    });
    assert.equal(attempts, 1);
    // The domain never opened, so the synchronous peek keeps abstaining.
    assert.deepEqual(durability.peekDispatcherMark("child-1"), {
      kind: "unknown",
    });

    // A later call retries (after the short backoff) and works.
    await retryUntil(async () => {
      await durability.writeWorkerMarker(marker());
    });
    assert.equal(attempts, 2, "the second call opened the domain again");
    assert.equal(sd.table.size, 1);
    assert.equal((await durability.readWorkerMarkers("session-1")).length, 1);
    assert.deepEqual(durability.peekDispatcherMark("child-1"), {
      kind: "not-dispatcher",
    });
  });

  it("dispose resolves even when the domain open rejects (callers `void` it)", async () => {
    const sd = createStubStorageDomain();
    let rejectOpen: (error: unknown) => void = () => {};
    let openCalls = 0;
    sd.open = () => {
      openCalls += 1;
      return new Promise<DomainLike>((_resolve, reject) => {
        rejectOpen = reject;
      });
    };
    const durability = createDurability(sd);

    const writing = Promise.resolve(durability.writeWorkerMarker(marker()));
    writing.catch(() => undefined);
    await waitFor(() => openCalls === 1);
    const disposing = durability.dispose();
    rejectOpen(new Error("open failed"));
    await assert.rejects(() => writing);
    await assert.doesNotReject(() => disposing);
    assert.deepEqual(durability.peekDispatcherMark("child-1"), {
      kind: "unknown",
    });
  });

  it("dispose waits for an in-flight write before closing the domain", async () => {
    let releasePut: () => void = () => {};
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const sd = createStubStorageDomain({ putGate });
    const durability = createDurability(sd);

    const writing = Promise.resolve(durability.writeWorkerMarker(marker()));
    await waitFor(() => sd.putCalls === 1);

    const disposing = durability.dispose();
    await sleep(10);
    assert.equal(
      sd.closed,
      false,
      "dispose must not close the domain under an in-flight write",
    );

    releasePut();
    await writing;
    await disposing;
    assert.equal(sd.closed, true);
    assert.equal(sd.table.size, 1, "the write completed before the close");
  });

  it("dispose logs instead of rejecting when close fails", async () => {
    const sd = createStubStorageDomain();
    const open = sd.open.bind(sd);
    sd.open = async (spec: unknown) => {
      const domain = await open(spec);
      return {
        table: (name: string) => domain.table(name),
        async close() {
          throw new Error("close failed");
        },
      };
    };
    const durability = createDurability(sd);
    await durability.writeWorkerMarker(marker());

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      await assert.doesNotReject(() => durability.dispose());
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1, "the failure is logged, not thrown");
  });
});
