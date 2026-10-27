import {
  closeSync, existsSync, openSync, readSync, renameSync, rmSync, statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fsyncFile, syncDirectoryChain } from "./fs-durability.js";
import { storageError } from "./integrity.js";
import { asRow, asRows } from "./rows.js";
import type { Row, SqlValue } from "./rows.js";
import {
  LEGACY_SCHEMA_VERSION, LEDGER_APPLICATION_ID, LEDGER_TABLES, PREVIOUS_SCHEMA_VERSION,
  SCHEMA_VERSION, initializeSchema,
} from "./schema.js";
import { LedgerError } from "./types.js";

/**
 * The retired version-1 file. Its presence is the never-re-read marker for that
 * version. Each source version keeps its own suffix, so the v1 backup taken by
 * an earlier migration survives a later v2 rebuild untouched.
 */
export const LEGACY_BACKUP_SUFFIX = `.v${LEGACY_SCHEMA_VERSION}.bak`;
/** The retired version-2 file (the verdict-only CHECK). */
export const VERDICT_BACKUP_SUFFIX = `.v${PREVIOUS_SCHEMA_VERSION}.bak`;
/** The staged current-version file; renamed over the main path once durable. */
export const MIGRATION_STAGING_SUFFIX = `.v${SCHEMA_VERSION}.tmp`;
/** Staging suffixes earlier schema versions wrote; a crash may leave one complete. */
const RETIRED_STAGING_SUFFIXES = [".v2.tmp"] as const;

/** Every version `migration.ts` rebuilds, with the suffix its backup takes. */
const BACKUP_SUFFIXES: readonly (readonly [number, string])[] = [
  [LEGACY_SCHEMA_VERSION, LEGACY_BACKUP_SUFFIX],
  [PREVIOUS_SCHEMA_VERSION, VERDICT_BACKUP_SUFFIX],
];

const SQLITE_MAGIC = "SQLite format 3\u0000";
const HEADER_BYTES = 100;
const JOURNAL_SIDECARS = ["-wal", "-shm", "-journal"] as const;

/**
 * One column list per table, in dependency order. Copied explicitly, never by
 * `SELECT *`, so an older file with an extra legacy column still migrates and
 * the insert order stays deterministic.
 */
const COLUMNS: readonly (readonly [string, readonly string[]])[] = [
  ["blobs", ["sha256", "byte_length", "created_at_ms"]],
  ["recalls", ["recall_id", "manifest_sha256", "created_at_ms"]],
  ["recall_parts", ["recall_id", "part_index", "source_node_id", "source_sha256",
    "source_byte_length", "blob_sha256"]],
  ["removed_spans", ["recall_id", "part_index", "span_index", "start_byte",
    "end_byte_exclusive", "slice_sha256"]],
  ["applications", ["intent_id", "session_id", "event_id", "base_revision", "phase",
    "application_sha256", "metadata_json", "created_at_ms"]],
  ["application_removals", ["intent_id", "rule_id", "removal_id", "recall_id",
    "operation_kind", "episode_id", "title"]],
  ["ledger_events", ["sequence", "event_key", "session_id", "intent_id", "kind",
    "at_ms", "payload_json"]],
];

export type MigrationStatus = "fresh" | "current" | "migrated" | "resumed";

/** Named points a test may stop at. Each name means "and then crash here". */
export type MigrationStep = "staged" | "durable" | "retired";

export interface LedgerFileOptions {
  readonly databasePath: string;
  /** Test seam: throwing here simulates a crash at that boundary. */
  readonly onStep?: (step: MigrationStep) => void;
}

export interface LedgerFileOutcome {
  readonly status: MigrationStatus;
  /** Absolute path of the most recent retired older-version file, when any exists. */
  readonly backupPath: string | null;
  /** Rows carried into the staged file; 0 when nothing was rebuilt. */
  readonly rowsCopied: number;
}

interface Facts {
  readonly exists: boolean;
  readonly isDatabase: boolean;
  readonly version: number;
  readonly applicationId: number;
}

const ABSENT: Facts = { exists: false, isDatabase: false, version: 0, applicationId: 0 };

/**
 * Brings the file at `databasePath` to the current schema: a version-1 or
 * version-2 file is rebuilt into a fresh current-version file in one hop, and
 * the old file is then renamed `*.v<old>.bak` — never mutated in place, never
 * re-read once its own `.bak` sibling exists.
 *
 * The file at the main path is, at every instant, either the untouched old
 * file, absent, or a complete current-version file. Nothing in between is ever
 * observable.
 *
 * Synchronous on purpose: this is a short, sequential file protocol, and an
 * `await` between the retire and the promote would widen the window in which
 * the main path is absent for no gain.
 */
export function prepareLedgerFile(options: LedgerFileOptions): LedgerFileOutcome {
  if (options.databasePath === ":memory:") {
    return { status: "fresh", backupPath: null, rowsCopied: 0 };
  }
  const main = resolve(options.databasePath);
  const staging = `${main}${MIGRATION_STAGING_SUFFIX}`;
  try {
    const facts = inspect(main);
    if (!facts.exists) {
      // A crash between "retire" and "promote" leaves exactly this shape: no
      // main, an old-version backup, and a complete staged file. Promote it.
      const backup = existingBackup(main);
      if (backup !== null) {
        const staged = promotableStaging(main);
        if (staged === null) {
          // Never re-read the backup (ruling), and never silently start an
          // empty ledger over one: that would lose the recorded history.
          throw new LedgerError("storage",
            `Trash ledger is missing; ${backup} exists but no complete rebuild is staged`);
        }
        deleteStaleSidecars(main);
        promote(staged, main);
        if (staged !== staging) {
          // A crash under an earlier schema left a complete staging file of
          // that version. It is main now and still needs its own rebuild.
          return { ...prepareLedgerFile(options), status: "resumed" };
        }
        return { status: "resumed", backupPath: backup, rowsCopied: 0 };
      }
      discardStaging(main);
      return { status: "fresh", backupPath: null, rowsCopied: 0 };
    }
    if (!facts.isDatabase) {
      throw new LedgerError("unsupported-schema", `Not a SQLite database: ${main}`);
    }
    if (facts.applicationId !== 0 && facts.applicationId !== LEDGER_APPLICATION_ID) {
      throw new LedgerError("unsupported-schema",
        `Database is not a RACOONS trash ledger (application id ${String(facts.applicationId)})`);
    }
    if (facts.version === SCHEMA_VERSION || facts.version === 0) {
      // 0 is an uninitialized SQLite file: `initializeSchema` stamps it, or
      // refuses when it already holds an older-shaped `application_removals`.
      discardStaging(main);
      const current = existingBackup(main);
      return { status: "current", backupPath: current, rowsCopied: 0 };
    }
    const backupSuffix = BACKUP_SUFFIXES.find(([version]) => version === facts.version)?.[1];
    if (backupSuffix === undefined) {
      throw new LedgerError("unsupported-schema", `Unsupported trash ledger schema ${String(facts.version)}`);
    }
    const backup = `${main}${backupSuffix}`;
    if (existsSync(backup)) {
      // Ruling: an old-version file with its `.bak` sibling is never re-read.
      // Rebuilding again would overwrite the evidence of the first migration.
      throw new LedgerError("unsupported-schema",
        `Refusing to re-read a version-${String(facts.version)} trash ledger beside ${backup}`);
    }
    // A stale staging file is a crashed earlier attempt; it is untrusted.
    discardStaging(main);
    return rebuild(main, backup, staging, options.onStep);
  } catch (error) {
    throw storageError(error, "Cannot prepare trash ledger file");
  }
}

/** The most recent retired version's `.bak` sibling, or null when none exists. */
function existingBackup(main: string): string | null {
  for (const [, suffix] of [...BACKUP_SUFFIXES].reverse()) {
    const path = `${main}${suffix}`;
    if (existsSync(path)) return path;
  }
  return null;
}

/** The complete staged file a crashed migration left, current version first. */
function promotableStaging(main: string): string | null {
  for (const path of stagingPaths(main)) {
    if (stagingVersion(path) !== null) return path;
  }
  return null;
}

/** A post-retire staging file of the current version, then of retired versions. */
function stagingPaths(main: string): readonly string[] {
  return [`${main}${MIGRATION_STAGING_SUFFIX}`,
    ...RETIRED_STAGING_SUFFIXES.map(suffix => `${main}${suffix}`)];
}

/**
 * Rebuild order (the crash-safety contract, one filesystem step per line):
 *
 * 1. read the old file once through a read-only handle — main is never written;
 * 2. write the whole current-version file at `*.v3.tmp` (DELETE journal, one file);
 * 3. fsync the staged file, then its directory — its bytes survive a power cut;
 * 4. rename old → `*.v<old>.bak`, its journal sidecars with it;
 * 5. rename `*.v3.tmp` → main, then fsync the directory.
 *
 * A crash before 3 leaves the old file untouched plus a deletable staging file.
 * A crash between 4 and 5 leaves no main, a complete backup and a complete
 * staged file — the next open promotes it (`resumed`). A crash after 5 leaves a
 * complete current-version file. No ordering leaves a half-migrated file at the
 * main path, and the old file is never written: it is only renamed.
 */
function rebuild(
  main: string, backup: string, staging: string, onStep?: (step: MigrationStep) => void,
): LedgerFileOutcome {
  const legacy = new DatabaseSync(main, { readOnly: true });
  let rows: ReadonlyMap<string, readonly Row[]>;
  try { rows = readLegacy(legacy); } finally { legacy.close(); }

  const staged = new DatabaseSync(staging);
  try {
    staged.exec("PRAGMA journal_mode = DELETE");
    staged.exec("PRAGMA synchronous = FULL");
    staged.exec("PRAGMA foreign_keys = ON");
    initializeSchema(staged);
    staged.exec("BEGIN IMMEDIATE");
    try {
      copyRows(staged, rows);
      verifyCounts(staged, rows);
      staged.exec("COMMIT");
    } catch (error) {
      staged.exec("ROLLBACK");
      throw error;
    }
    assertQuickCheck(staged, "Staged trash ledger failed its integrity check");
  } finally { staged.close(); }
  onStep?.("staged");

  fsyncFile(staging);
  syncDirectoryChain(dirname(staging));
  onStep?.("durable");

  renameSync(main, backup);
  for (const suffix of JOURNAL_SIDECARS) {
    if (existsSync(`${main}${suffix}`)) renameSync(`${main}${suffix}`, `${backup}${suffix}`);
  }
  deleteStaleSidecars(main);
  syncDirectoryChain(dirname(main));
  onStep?.("retired");

  promote(staging, main);
  return { status: "migrated", backupPath: backup, rowsCopied: countRows(rows) };
}

function readLegacy(db: DatabaseSync): ReadonlyMap<string, readonly Row[]> {
  const tables = new Map<string, readonly Row[]>();
  for (const [table, columns] of COLUMNS) {
    tables.set(table, asRows(db.prepare(
      `SELECT ${columns.join(", ")} FROM ${table} ORDER BY rowid`).all(), table));
  }
  return tables;
}

function copyRows(db: DatabaseSync, rows: ReadonlyMap<string, readonly Row[]>): void {
  for (const [table, columns] of COLUMNS) {
    const values = rows.get(table) ?? [];
    if (values.length === 0) continue;
    const insert = db.prepare(`INSERT INTO ${table} (${columns.join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of values) insert.run(...columns.map(column => row[column] as SqlValue));
  }
}

/** The copy is only a migration if every row arrived; counts come from both sides. */
function verifyCounts(db: DatabaseSync, rows: ReadonlyMap<string, readonly Row[]>): void {
  for (const [table] of COLUMNS) {
    const expected = rows.get(table)?.length ?? 0;
    const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
    const actual = row === undefined ? -1 : asRow(row, table)["n"];
    if (actual !== expected) {
      throw new LedgerError("storage", `Staged ${table} holds ${String(actual)} of ${expected} rows`);
    }
  }
}

function countRows(rows: ReadonlyMap<string, readonly Row[]>): number {
  let total = 0;
  for (const values of rows.values()) total += values.length;
  return total;
}

function promote(staging: string, main: string): void {
  renameSync(staging, main);
  syncDirectoryChain(dirname(main));
}

function assertQuickCheck(db: DatabaseSync, message: string): void {
  const check = db.prepare("PRAGMA quick_check").get();
  if (check === undefined || asRow(check, "quick_check")["quick_check"] !== "ok") {
    throw new LedgerError("storage", message);
  }
}

/**
 * The schema version a staged file carries, or null when it is missing,
 * foreign, or not self-consistent. The current version and the version just
 * before it are both promotable: a crash that ran under the older schema left
 * a complete staging file of that version, which is promoted and then rebuilt
 * again by the caller.
 */
function stagingVersion(staging: string): number | null {
  if (!existsSync(staging)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(staging, { readOnly: true });
    const version = pragma(db, "user_version");
    if (version === null || (version !== SCHEMA_VERSION && version !== PREVIOUS_SCHEMA_VERSION)) {
      return null;
    }
    if (pragma(db, "application_id") !== LEDGER_APPLICATION_ID) return null;
    const tables = asRows(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'").all(), "sqlite_master")
      .map(row => row["name"]);
    if (!LEDGER_TABLES.every(table => tables.includes(table))) return null;
    assertQuickCheck(db, "Incomplete staged ledger");
    return version;
  } catch {
    return null;
  } finally { db?.close(); }
}

/**
 * Delete journal files a crashed writer left beside the main path. Only called
 * where the main path is absent or already current — never beside an older file
 * whose uncheckpointed frames would be lost.
 */
function deleteStaleSidecars(main: string): void {
  for (const suffix of JOURNAL_SIDECARS) rmSync(`${main}${suffix}`, { force: true });
}

/** Deletes every staging file a crashed attempt could have left at `main`. */
function discardStaging(main: string): void {
  for (const path of stagingPaths(main)) {
    rmSync(path, { force: true });
    for (const suffix of JOURNAL_SIDECARS) rmSync(`${path}${suffix}`, { force: true });
  }
}

function pragma(db: DatabaseSync, name: string): number | null {
  const row = db.prepare(`PRAGMA ${name}`).get();
  const value = row === undefined ? undefined : asRow(row, name)[name];
  return typeof value === "number" ? value : null;
}

/**
 * Header first, so a foreign file is refused before SQLite touches it. Then
 * SQLite reads the version, because a crashed WAL writer may carry the latest
 * `user_version` only in its WAL.
 */
function inspect(path: string): Facts {
  if (!existsSync(path)) return ABSENT;
  if (statSync(path).size > 0 && readMagic(path) !== SQLITE_MAGIC) {
    return { exists: true, isDatabase: false, version: 0, applicationId: 0 };
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      exists: true, isDatabase: true,
      version: pragma(db, "user_version") ?? 0,
      applicationId: pragma(db, "application_id") ?? 0,
    };
  } finally { db.close(); }
}

function readMagic(path: string): string | null {
  const buffer = Buffer.alloc(HEADER_BYTES);
  const fd = openSync(path, "r");
  let read = 0;
  try { read = readSync(fd, buffer, 0, HEADER_BYTES, 0); } finally { closeSync(fd); }
  // A short file cannot be a database; SQLite rejects it, and so does this.
  return read < HEADER_BYTES ? "" : buffer.toString("latin1", 0, SQLITE_MAGIC.length);
}
