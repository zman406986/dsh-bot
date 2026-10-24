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
  LEGACY_SCHEMA_VERSION, LEDGER_APPLICATION_ID, LEDGER_TABLES, SCHEMA_VERSION,
  initializeSchema,
} from "./schema.js";
import { LedgerError } from "./types.js";

/** The retired version-1 file. Its presence is the never-re-read marker. */
export const LEGACY_BACKUP_SUFFIX = ".v1.bak";
/** The staged version-2 file; renamed over the main path only once it is durable. */
export const MIGRATION_STAGING_SUFFIX = ".v2.tmp";

const SQLITE_MAGIC = "SQLite format 3\u0000";
const HEADER_BYTES = 100;
const JOURNAL_SIDECARS = ["-wal", "-shm", "-journal"] as const;

/**
 * One column list per table, in dependency order. Copied explicitly, never by
 * `SELECT *`, so a v1 file with an extra legacy column still migrates and the
 * insert order stays deterministic.
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
  /** Absolute path of the retired v1 file, when one exists. */
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
 * Brings the file at `databasePath` to schema 2 (design-protocol §7 Q3 ruling):
 * a version-1 file is rebuilt into a fresh v2 file, and the v1 file is then
 * renamed `*.v1.bak` — never mutated in place, never re-read once a `.bak`
 * sibling exists.
 *
 * The file at the main path is, at every instant, either the untouched v1 file,
 * absent, or a complete v2 file. Nothing in between is ever observable.
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
  const backup = `${main}${LEGACY_BACKUP_SUFFIX}`;
  const staging = `${main}${MIGRATION_STAGING_SUFFIX}`;
  try {
    const facts = inspect(main);
    if (!facts.exists) {
      // A crash between "retire" and "promote" leaves exactly this shape: no
      // main, a v1 backup, and a fully staged v2 file. Promote it back.
      if (existsSync(backup)) {
        if (!stagingIsComplete(staging)) {
          // Never re-read the backup (ruling), and never silently start an
          // empty ledger over one: that would lose the recorded history.
          throw new LedgerError("storage",
            `Trash ledger is missing; ${backup} exists but no complete rebuild is staged`);
        }
        deleteStaleSidecars(main);
        promote(staging, main);
        return { status: "resumed", backupPath: backup, rowsCopied: 0 };
      }
      discardStaging(staging);
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
      // refuses when it already holds a v1-shaped `application_removals`.
      discardStaging(staging);
      return { status: "current", backupPath: existsSync(backup) ? backup : null, rowsCopied: 0 };
    }
    if (facts.version !== LEGACY_SCHEMA_VERSION) {
      throw new LedgerError("unsupported-schema", `Unsupported trash ledger schema ${String(facts.version)}`);
    }
    if (existsSync(backup)) {
      // Ruling: a v1 file with a `.bak` sibling is never re-read. Rebuilding
      // again would overwrite the evidence of the first migration.
      throw new LedgerError("unsupported-schema",
        `Refusing to re-read a version-1 trash ledger beside ${backup}`);
    }
    // A stale staging file is a crashed earlier attempt; it is untrusted.
    discardStaging(staging);
    return rebuild(main, backup, staging, options.onStep);
  } catch (error) {
    throw storageError(error, "Cannot prepare trash ledger file");
  }
}

/**
 * Rebuild order (the crash-safety contract, one filesystem step per line):
 *
 * 1. read v1 once through a read-only handle — the main file is never written;
 * 2. write the whole v2 file at `*.v2.tmp` (DELETE journal, so one file);
 * 3. fsync the staged file, then its directory — its bytes survive a power cut;
 * 4. rename v1 → `*.v1.bak`, its journal sidecars with it;
 * 5. rename `*.v2.tmp` → main, then fsync the directory.
 *
 * A crash before 3 leaves v1 untouched plus a deletable staging file. A crash
 * between 4 and 5 leaves no main, a complete backup and a complete staged file
 * — the next open promotes it (`resumed`). A crash after 5 leaves a complete v2
 * file. No ordering leaves a half-migrated file at the main path, and the v1
 * file is never written: it is only renamed.
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

/** A staged v2 file is only promotable if it is complete and self-consistent. */
function stagingIsComplete(staging: string): boolean {
  if (!existsSync(staging)) return false;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(staging, { readOnly: true });
    if (pragma(db, "user_version") !== SCHEMA_VERSION ||
        pragma(db, "application_id") !== LEDGER_APPLICATION_ID) return false;
    const tables = asRows(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'").all(), "sqlite_master")
      .map(row => row["name"]);
    if (!LEDGER_TABLES.every(table => tables.includes(table))) return false;
    assertQuickCheck(db, "Incomplete staged ledger");
    return true;
  } catch {
    return false;
  } finally { db?.close(); }
}

/**
 * Delete journal files a crashed writer left beside the main path. Only called
 * where the main path is absent or already v2 — never beside a v1 file whose
 * uncheckpointed frames would be lost.
 */
function deleteStaleSidecars(main: string): void {
  for (const suffix of JOURNAL_SIDECARS) rmSync(`${main}${suffix}`, { force: true });
}

function discardStaging(staging: string): void {
  rmSync(staging, { force: true });
  for (const suffix of JOURNAL_SIDECARS) rmSync(`${staging}${suffix}`, { force: true });
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
