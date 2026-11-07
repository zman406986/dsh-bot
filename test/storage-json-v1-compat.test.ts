/**
 * Ticket 149 — a version-1 marker store must OPEN again.
 *
 * The owner's live store (`~/.dsh/storages/multitask_dispatcher.json`) is
 * stamped `unit.version: 1` and `DOMAIN_VERSION` became 2 with ticket 113.
 * Since then every `storageDomain.open` threw `version-mismatch`, so
 * `rebuildFromDurability` rejected, activation showed
 * `RESTART_DEGRADED_NOTICE`, and no mark was written for about a month.
 *
 * ## Why this test carries its own backend
 *
 * The repo deliberately imports no host packages
 * (`src/adapter/durable-marker.ts:11-29` is a structural view of
 * `ctx.storageDomain`), and `@deepseek-ai/dsh-storage-json` is not a
 * dependency, so this file cannot import the real backend. The fake below is a
 * TRANSCRIPTION of the installed library's version handling, not a guess:
 *
 * - `single` layout, `parse()`: the stored `unit.version` is compared to the
 *   descriptor EXACTLY and a difference throws `version-mismatch`
 *   (`@deepseek-ai/dsh-storage-json` 0.2.1-rc.2 `lib/index.js:100-102`).
 *   `compatibleVersions` is never read on this path; the contract states
 *   "`single`-layout reads stay exact-version"
 *   (`dsh-storage/lib/types/backend.d.ts:63-67`).
 * - `per-record` layout: `acceptedStamps` = current version plus
 *   `compatibleVersions` (`lib/index.js:353-355`); a legacy whole-unit file
 *   stamped with an accepted version seeds the tree when no document exists
 *   yet, each record is written as a current-version document, and the legacy
 *   file is left untouched (`bootstrapLegacyUnit`, `lib/index.js:370-397`).
 * - Every write stamps `descriptor.version` (`serializeRecord`,
 *   `lib/index.js` `:437-445`).
 *
 * The control case at the bottom runs the SAME fixture against the pre-149
 * spec shape and asserts `version-mismatch`, so a declaration that stops
 * working cannot pass silently.
 */
import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createStorageDomainDurability,
  DOMAIN_LEGACY_VERSIONS,
  DOMAIN_VERSION,
  MARKER_DOMAIN_NAME,
  MARKER_TABLE_NAME,
  DISPATCHER_SESSION_TABLE_NAME,
  markerDomainSpec,
  type DomainLike,
  type KvTableLike,
  type StorageDomainLike,
} from "../src/adapter/durable-marker.js";
import type { DurableDispatcherMark, DurableWorkerMarker } from "../src/core/durability.js";

/** Structural domain spec as the backend sees it (post-`descriptorOf`). */
interface SpecTable {
  valueSchema: { parse(value: unknown): unknown };
}

interface SpecLike {
  name: string;
  version: number;
  tables: Record<string, SpecTable>;
  layout?: string;
  compatibleVersions?: readonly number[];
}

/** An error shaped like the library's `StorageError`, so callers can switch on `code`. */
function storageError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  error.name = "StorageError";
  return error;
}

/** One v1 worker row, the shape the live store holds (pre-113 fields only). */
function v1WorkerRow(overrides: Partial<DurableWorkerMarker> = {}): DurableWorkerMarker {
  return {
    workerId: "w-1",
    parentSessionId: "session-1",
    streamKey: "todo-1",
    title: "Old task",
    status: "completed",
    transcriptRef: null,
    todoId: null,
    startedAtMs: 1_000,
    updatedAtMs: 2_000,
    ...overrides,
  };
}

/** Write a store exactly the way the `single` layout serializes it (`:52-75`). */
async function writeSingleUnit(
  root: string,
  name: string,
  version: number,
  tables: Record<string, Record<string, unknown>>,
): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = join(root, `${name}.json`);
  const document = { unit: { name, version }, global: null, tables };
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return path;
}

/** Read one per-record document (`<root>/<name>/<table>/<key>.json`). */
async function readRecordDocument(
  root: string,
  name: string,
  table: string,
  key: string,
): Promise<{ version: number; record: unknown }> {
  const text = await readFile(join(root, name, table, `${key}.json`), "utf8");
  return JSON.parse(text) as { version: number; record: unknown };
}

/**
 * A backend that mirrors the installed library's version semantics (see the
 * file header for the cited lines). Values stay opaque JSON, records are
 * validated by the caller's schema exactly as `dsh-storage-domain` does, and
 * writes are plain file writes — durability machinery is not what this test
 * pins.
 */
function createJsonLikeBackend(root: string): StorageDomainLike & {
  openedSpecs: SpecLike[];
  lastOpened: () => SpecLike | undefined;
} {
  const openedSpecs: SpecLike[] = [];

  async function openPerRecord(
    spec: SpecLike,
  ): Promise<DomainLike & { stamps: Map<string, number> }> {
    const dir = join(root, spec.name);
    const accepted = [spec.version, ...(spec.compatibleVersions ?? [])];
    const tables = new Map<string, Map<string, unknown>>();
    for (const table of Object.keys(spec.tables)) tables.set(table, new Map());

    let entries: Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    let sawDocument = false;
    for (const entry of entries) {
      const records = tables.get(entry.name);
      if (!entry.isDirectory() || records === undefined) continue;
      for (const file of await readdir(join(dir, entry.name), { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        sawDocument = true;
        const key = file.name.slice(0, -5);
        const raw = JSON.parse(
          await readFile(join(dir, entry.name, file.name), "utf8"),
        ) as { version?: unknown; record?: unknown };
        // A foreign (unaccepted-version or malformed) document reads as absent.
        if (typeof raw.version !== "number" || !accepted.includes(raw.version)) continue;
        records.set(key, raw.record);
      }
    }

    if (!sawDocument) {
      // Legacy whole-unit bootstrap (`:370-397`): accepted stamp only.
      let legacyText: string | null = null;
      try {
        legacyText = await readFile(join(root, `${spec.name}.json`), "utf8");
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
      if (legacyText !== null) {
        const legacy = JSON.parse(legacyText) as {
          unit?: { name?: unknown; version?: unknown };
          tables?: Record<string, Record<string, unknown>>;
        };
        if (legacy.unit?.name === spec.name) {
          const stamped = legacy.unit.version;
          if (typeof stamped === "number" && accepted.includes(stamped)) {
            for (const [table, rows] of Object.entries(legacy.tables ?? {})) {
              const target = tables.get(table);
              if (target === undefined) continue;
              for (const [key, value] of Object.entries(rows)) {
                await mkdir(join(dir, table), { recursive: true });
                await writeFile(
                  join(dir, table, `${key}.json`),
                  `${JSON.stringify({ version: spec.version, record: value }, null, 2)}\n`,
                  "utf8",
                );
                target.set(key, value);
              }
            }
          }
        }
      }
    }

    // `dsh-storage-domain` validates every loaded record at open time.
    for (const [table, records] of tables) {
      for (const [key, value] of records) {
        try {
          records.set(key, spec.tables[table]?.valueSchema.parse(value));
        } catch (error) {
          throw storageError(
            "invalid-record",
            `domain '${spec.name}' table '${table}' record '${key}': ${String(error)}`,
          );
        }
      }
    }

    const stamps = new Map<string, number>();
    const handles = new Map<string, KvTableLike<DurableWorkerMarker>>();
    return {
      stamps,
      table(name: string): KvTableLike<DurableWorkerMarker> {
        const records = tables.get(name);
        if (records === undefined) throw new Error(`domain '${spec.name}' declares no table '${name}'`);
        const existing = handles.get(name);
        if (existing !== undefined) return existing;
        const handle: KvTableLike<DurableWorkerMarker> = {
          get: (key) => records.get(key) as DurableWorkerMarker | undefined,
          entries: () => records.entries() as IterableIterator<[string, DurableWorkerMarker]>,
          put: async (key, value) => {
            await mkdir(join(dir, name), { recursive: true });
            const stamp = spec.version;
            await writeFile(
              join(dir, name, `${key}.json`),
              `${JSON.stringify({ version: stamp, record: value }, null, 2)}\n`,
              "utf8",
            );
            records.set(key, value);
            stamps.set(`${name}/${key}`, stamp);
          },
          delete: async (key) => records.delete(key),
        };
        handles.set(name, handle);
        return handle;
      },
      async close() {},
    };
  }

  async function openSingle(spec: SpecLike): Promise<DomainLike> {
    const path = join(root, `${spec.name}.json`);
    let text: string | null = null;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    const tables = new Map<string, Map<string, unknown>>();
    for (const table of Object.keys(spec.tables)) tables.set(table, new Map());
    if (text !== null) {
      const document = JSON.parse(text) as {
        unit?: { name?: unknown; version?: unknown };
        tables?: Record<string, Record<string, unknown>>;
      };
      if (document.unit?.name !== spec.name || typeof document.unit.version !== "number") {
        throw storageError("malformed-medium", `unit '${spec.name}': missing or foreign unit header`);
      }
      // `:100-102`: EXACT compare. `compatibleVersions` is not consulted.
      if (document.unit.version !== spec.version) {
        throw storageError(
          "version-mismatch",
          `unit '${spec.name}': stored version ${document.unit.version} != expected ${spec.version}`,
        );
      }
      for (const [table, rows] of Object.entries(document.tables ?? {})) {
        const target = tables.get(table);
        if (target === undefined) continue;
        for (const [key, value] of Object.entries(rows)) {
          target.set(key, spec.tables[table]?.valueSchema.parse(value));
        }
      }
    }
    const handles = new Map<string, KvTableLike<DurableWorkerMarker>>();
    return {
      table(name: string): KvTableLike<DurableWorkerMarker> {
        const records = tables.get(name);
        if (records === undefined) throw new Error(`domain '${spec.name}' declares no table '${name}'`);
        const existing = handles.get(name);
        if (existing !== undefined) return existing;
        const handle: KvTableLike<DurableWorkerMarker> = {
          get: (key) => records.get(key) as DurableWorkerMarker | undefined,
          entries: () => records.entries() as IterableIterator<[string, DurableWorkerMarker]>,
          put: async (key, value) => {
            records.set(key, value);
          },
          delete: async (key) => records.delete(key),
        };
        handles.set(name, handle);
        return handle;
      },
      async close() {},
    };
  }

  return {
    openedSpecs,
    lastOpened: () => openedSpecs.at(-1),
    async open(rawSpec: unknown): Promise<DomainLike> {
      const spec = rawSpec as SpecLike;
      openedSpecs.push(spec);
      return spec.layout === "per-record" ? openPerRecord(spec) : openSingle(spec);
    },
  };
}

describe("ticket 149 — a version-1 marker store opens again", () => {
  it("declares the per-record layout and version 1 as a compatible read stamp", () => {
    const spec = markerDomainSpec() as SpecLike;
    // The current version stays 2 — v1 is legacy-compat only.
    assert.equal(spec.version, DOMAIN_VERSION);
    assert.equal(spec.version, 2);
    // `compatibleVersions` only means anything on the per-record path, so the
    // layout declaration is part of the fix, not decoration.
    assert.equal(spec.layout, "per-record");
    assert.deepEqual(spec.compatibleVersions, [1]);
    assert.deepEqual(DOMAIN_LEGACY_VERSIONS, [1]);
  });

  it("opens a v1-stamped store, round-trips marks, and restamps writes at 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-marker-v1-"));
    const rows = {
      "w-1": v1WorkerRow(),
      "w-2": v1WorkerRow({
        workerId: "w-2",
        parentSessionId: "session-2",
        streamKey: "todo-2",
        title: "Other task",
      }),
    };
    const legacyPath = await writeSingleUnit(root, MARKER_DOMAIN_NAME, 1, {
      [MARKER_TABLE_NAME]: rows,
    });
    const legacyBytes = await readFile(legacyPath, "utf8");

    const backend = createJsonLikeBackend(root);
    const durability = createStorageDomainDurability(backend);
    // The port types these optional so thinner stubs can omit them; the
    // storage-backed store always implements them.
    assert.ok(durability.writeDispatcherMark);
    assert.ok(durability.readDispatcherMark);

    // The v1 rows are readable — this is the open that has been throwing.
    const sessionOne = await durability.readWorkerMarkers("session-1");
    assert.equal(sessionOne.length, 1);
    assert.equal(sessionOne[0]?.workerId, "w-1");
    assert.equal(sessionOne[0]?.status, "completed");
    assert.equal((await durability.readWorkerMarkers("session-2")).length, 1);

    // The bootstrap wrote current-version documents; the legacy file is
    // untouched byte-for-byte ("the legacy file is never changed").
    assert.equal(await readFile(legacyPath, "utf8"), legacyBytes);
    const bootstrapped = await readRecordDocument(root, MARKER_DOMAIN_NAME, MARKER_TABLE_NAME, "w-1");
    assert.equal(bootstrapped.version, DOMAIN_VERSION);

    // A write from the current process round-trips at version 2.
    const mark: DurableDispatcherMark = { sessionId: "chat-1" };
    await durability.writeDispatcherMark(mark);
    assert.deepEqual(await durability.readDispatcherMark("chat-1"), mark);
    const written = await readRecordDocument(
      root,
      MARKER_DOMAIN_NAME,
      DISPATCHER_SESSION_TABLE_NAME,
      "chat-1",
    );
    assert.equal(written.version, DOMAIN_VERSION);
    assert.deepEqual(written.record, mark);

    // The worker rows survived the migration and are still served.
    assert.equal((await durability.readWorkerMarkers("session-1"))[0]?.workerId, "w-1");

    await durability.dispose();

    // A SECOND process (fresh backend over the same root) sees documents and
    // therefore never bootstraps again; opens stay clean.
    const reopened = createStorageDomainDurability(createJsonLikeBackend(root));
    assert.ok(reopened.readDispatcherMark);
    assert.equal((await reopened.readWorkerMarkers("session-1")).length, 1);
    assert.deepEqual(await reopened.readDispatcherMark("chat-1"), mark);
    await reopened.dispose();
  });

  it("the pre-149 spec shape still refuses the same v1 fixture (control)", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-marker-v1-control-"));
    await writeSingleUnit(root, MARKER_DOMAIN_NAME, 1, {
      [MARKER_TABLE_NAME]: { "w-1": v1WorkerRow() },
    });
    const backend = createJsonLikeBackend(root);
    const current = markerDomainSpec() as SpecLike;
    // The old declaration: single layout, no compatible stamps.
    const legacySpec: SpecLike = {
      name: current.name,
      version: current.version,
      tables: current.tables,
    };
    await assert.rejects(
      () => backend.open(legacySpec),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "version-mismatch");
        return true;
      },
    );
  });

  it("a v1 fixture with a row the current schema rejects fails as invalid-record", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-marker-v1-badrow-"));
    // `compatibleVersions` is the OWNER's vouch that old rows are readable
    // under the current schemas — a row that is not must fail loudly, never
    // be silently dropped.
    await writeSingleUnit(root, MARKER_DOMAIN_NAME, 1, {
      [MARKER_TABLE_NAME]: { "w-bad": { workerId: "w-bad" } },
    });
    const backend = createJsonLikeBackend(root);
    await assert.rejects(
      () => backend.open(markerDomainSpec()),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "invalid-record");
        return true;
      },
    );
  });
});
