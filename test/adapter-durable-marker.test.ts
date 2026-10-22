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
  type StorageDomainLike,
  type InboxJobCheckpoint,
} from "../src/adapter/durable-marker.js";
import type {
  CompactionBoundary,
  DurableDispatcherMark,
  DurableWorkerMarker,
  DurableWorkerSession,
} from "../src/core/durability.js";

function createStubStorageDomain(): StorageDomainLike & {
  opens: unknown[];
  table: Map<string, DurableWorkerMarker>;
  inbox: Map<string, InboxJobCheckpoint>;
  boundaries: Map<string, CompactionBoundary>;
  dispatchers: Map<string, DurableDispatcherMark>;
  workerSessions: Map<string, DurableWorkerSession>;
  closed: boolean;
} {
  const table = new Map<string, DurableWorkerMarker>();
  const inbox = new Map<string, InboxJobCheckpoint>();
  const boundaries = new Map<string, CompactionBoundary>();
  const dispatchers = new Map<string, DurableDispatcherMark>();
  const workerSessionRows = new Map<string, DurableWorkerSession>();
  const opens: unknown[] = [];
  let closed = false;

  const kv: KvTableLike<DurableWorkerMarker> = {
    get(key: string) {
      return table.get(key);
    },
    entries() {
      return table.entries();
    },
    async put(key: string, value: DurableWorkerMarker) {
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
    table,
    inbox,
    boundaries,
    dispatchers,
    workerSessions: workerSessionRows,
    get closed() {
      return closed;
    },
    async open(spec: unknown): Promise<DomainLike> {
      opens.push(spec);
      // Validate schema shape the way storage-domain does (parse on load).
      const s = spec as {
        name: string;
        version: number;
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
      return {
        table(name: string) {
          if (name === MARKER_TABLE_NAME) return kv;
          if (name === INBOX_TABLE_NAME) return inboxKv;
          if (name === COMPACTION_BOUNDARY_TABLE_NAME) return boundaryKv;
          if (name === DISPATCHER_SESSION_TABLE_NAME) return dispatcherKv;
          if (name === WORKER_SESSION_TABLE_NAME) return workerSessionKv;
          throw new Error(`unexpected table ${name}`);
        },
        async close() {
          closed = true;
        },
      };
    },
  };
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
  it("opens the multitask_dispatcher domain with a worker_markers table", () => {
    const sd = createStubStorageDomain();
    const durability = createStorageDomainDurability(sd);
    // Lazy open — no open until first write.
    assert.equal(sd.opens.length, 0);
    return durability.writeWorkerMarker(marker()).then(() => {
      assert.equal(sd.opens.length, 1);
      assert.equal(sd.table.size, 1);
    });
  });

  it("writes, reads by parent, and deletes markers", async () => {
    const sd = createStubStorageDomain();
    const durability = createStorageDomainDurability(sd);

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

  it("schema parse rejects malformed markers", () => {
    const spec = markerDomainSpec() as {
      tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }>;
    };
    const parse = spec.tables[MARKER_TABLE_NAME]?.valueSchema.parse;
    assert.ok(parse);
    assert.throws(() => parse({}));
    assert.throws(() => parse(null));
    assert.doesNotThrow(() => parse(marker()));
  });

  it("opens ONE domain for both tables (lazy, shared)", async () => {
    const sd = createStubStorageDomain();
    const durability = createStorageDomainDurability(sd);
    await durability.writeWorkerMarker(marker());
    await durability.inbox.record(checkpoint());
    assert.equal(sd.opens.length, 1, "second table must reuse the open domain");
    const listed = await durability.inbox.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.jobId, "job-1");
    const got = await durability.inbox.get("job-1");
    assert.equal(got?.state, "claimed");
  });

  it("records, updates, and lists inbox checkpoints", async () => {
    const sd = createStubStorageDomain();
    const durability = createStorageDomainDurability(sd);
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

  it("schema parse rejects malformed inbox checkpoints", () => {
    const spec = markerDomainSpec() as {
      tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }>;
    };
    const parse = spec.tables[INBOX_TABLE_NAME]?.valueSchema.parse;
    assert.ok(parse);
    assert.throws(() => parse({}));
    assert.throws(() => parse(checkpoint({ jobDir: "" })));
    assert.throws(() => parse(checkpoint({ state: "meh" })));
    assert.doesNotThrow(() => parse(checkpoint()));
  });

  it("writes and reads a compaction boundary in the SAME domain (ticket 124)", async () => {
    const sd = createStubStorageDomain();
    const durability = createStorageDomainDurability(sd);

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

  it("schema parse rejects a malformed boundary row (ticket 124)", () => {
    const spec = markerDomainSpec() as {
      tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }>;
    };
    const parse =
      spec.tables[COMPACTION_BOUNDARY_TABLE_NAME]?.valueSchema.parse;
    assert.ok(parse);
    assert.throws(() => parse({}));
    assert.throws(() => parse(null));
    assert.throws(() => parse(boundary({ status: "planned" as never })));
    assert.throws(() => parse(boundary({ passSeq: -1 })));
    assert.throws(() => parse(boundary({ layer: "native" as never })));
    assert.throws(() => parse(boundary({ clearedSeqs: ["x" as never] })));
    assert.doesNotThrow(() => parse(boundary()));
  });

  it("dispose closes the domain and rejects further writes", async () => {
    const sd = createStubStorageDomain();
    const durability = createStorageDomainDurability(sd);
    await durability.writeWorkerMarker(marker());
    await durability.dispose();
    assert.equal(sd.closed, true);
    await assert.rejects(() => durability.writeWorkerMarker(marker()));
    await assert.rejects(() => durability.inbox.record(checkpoint()));
  });

  it("declares the dispatcher_sessions table without a version bump (ticket 130)", () => {
    const spec = markerDomainSpec() as {
      version: number;
      tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }>;
    };
    // Same rule as ticket 124: a new optional table must not bump the
    // version, or every existing store refuses to open on upgrade.
    assert.equal(spec.version, 2);
    assert.ok(spec.tables[DISPATCHER_SESSION_TABLE_NAME]);
  });

  it("writes and reads a dispatcher mark in the SAME domain (ticket 130)", async () => {
    const sd = createStubStorageDomain();
    const durability = createStorageDomainDurability(sd);

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

  it("schema parse rejects a malformed dispatcher mark (ticket 130)", () => {
    const spec = markerDomainSpec() as {
      tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }>;
    };
    const parse =
      spec.tables[DISPATCHER_SESSION_TABLE_NAME]?.valueSchema.parse;
    assert.ok(parse);
    assert.throws(() => parse({}));
    assert.throws(() => parse(null));
    assert.throws(() => parse({ sessionId: "" }));
    assert.doesNotThrow(() => parse({ sessionId: "child-1" }));
    // Ticket 138: the optional spawner is validated when present — a
    // non-string parent would otherwise read as "no parent" and silently
    // disable wake-on-send for that row.
    assert.doesNotThrow(() => parse({ sessionId: "child-1", parentSessionId: "p-1" }));
    assert.throws(() => parse({ sessionId: "child-1", parentSessionId: 7 }));
  });

  it("lists every dispatcher mark so the adapter can warm its mirror (ticket 138)", async () => {
    const sd = createStubStorageDomain();
    const durability = createStorageDomainDurability(sd);

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

  /**
   * Ticket 142 (owner ruling 2026-10-22 — the children half): the wake
   * identity of a WORKER session. It lives in the same domain, follows the
   * `dispatcher_sessions` shape, and differs on ONE point that is the whole
   * reason it is a separate table: its rows are DELETED when the worker is
   * terminal or abandoned.
   */
  it("declares worker_sessions in the same domain without a version bump (ticket 142)", () => {
    const spec = markerDomainSpec() as {
      version: number;
      tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }>;
    };
    // Same rule as tickets 124/130: a new optional table must not bump the
    // version, or every existing store refuses to open on upgrade.
    assert.equal(spec.version, 2);
    assert.ok(spec.tables[WORKER_SESSION_TABLE_NAME]);
  });

  it("writes, reads, lists, and deletes a worker session row in the SAME domain (ticket 142)", async () => {
    const sd = createStubStorageDomain();
    const durability = createStorageDomainDurability(sd);

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

  it("schema parse rejects a malformed worker session row (ticket 142)", () => {
    const spec = markerDomainSpec() as {
      tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }>;
    };
    const parse = spec.tables[WORKER_SESSION_TABLE_NAME]?.valueSchema.parse;
    assert.ok(parse);
    assert.throws(() => parse({}));
    assert.throws(() => parse(null));
    assert.throws(() => parse({ sessionId: "" , parentSessionId: "p-1" }));
    assert.throws(() => parse({ sessionId: "w-1" }));
    // A non-string (or empty) spawner is rejected rather than read as "no
    // parent" — a row that cannot be resumed is malformed, not a quiet
    // downgrade to pre-142 behaviour.
    assert.throws(() => parse({ sessionId: "w-1", parentSessionId: 7 }));
    assert.throws(() => parse({ sessionId: "w-1", parentSessionId: "" }));
    assert.doesNotThrow(() =>
      parse({ sessionId: "w-1", parentSessionId: "chat-1" }),
    );
  });
});
