import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createStorageDomainDurability,
  markerDomainSpec,
  MARKER_DOMAIN_NAME,
  MARKER_TABLE_NAME,
  INBOX_TABLE_NAME,
  type DomainLike,
  type KvTableLike,
  type StorageDomainLike,
  type InboxJobCheckpoint,
} from "../src/adapter/durable-marker.js";
import type { DurableWorkerMarker } from "../src/core/durability.js";

function createStubStorageDomain(): StorageDomainLike & {
  opens: unknown[];
  table: Map<string, DurableWorkerMarker>;
  inbox: Map<string, InboxJobCheckpoint>;
  closed: boolean;
} {
  const table = new Map<string, DurableWorkerMarker>();
  const inbox = new Map<string, InboxJobCheckpoint>();
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

  return {
    opens,
    table,
    inbox,
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
      return {
        table(name: string) {
          if (name === MARKER_TABLE_NAME) return kv;
          if (name === INBOX_TABLE_NAME) return inboxKv;
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

  it("dispose closes the domain and rejects further writes", async () => {
    const sd = createStubStorageDomain();
    const durability = createStorageDomainDurability(sd);
    await durability.writeWorkerMarker(marker());
    await durability.dispose();
    assert.equal(sd.closed, true);
    await assert.rejects(() => durability.writeWorkerMarker(marker()));
    await assert.rejects(() => durability.inbox.record(checkpoint()));
  });
});
