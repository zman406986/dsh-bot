import type { DatabaseSync } from "node:sqlite";
import { LedgerError } from "./types.js";
import { storageError } from "./integrity.js";
import { asRow } from "./rows.js";

/**
 * Schema 3 exists for the same reason schema 2 did: SQLite cannot alter a CHECK
 * constraint in place, and `application_removals.operation_kind` must admit
 * `'proof'` (a proof burn) and `'forget'` (a manual forget) beside the five
 * kinds schema 2 carried. A version-1 or version-2 file therefore cannot be
 * upgraded on itself; `migration.ts` rebuilds it into a fresh v3 file.
 */
export const SCHEMA_VERSION = 3;
/** The pre-revert schema. Only `migration.ts` may read a file carrying it. */
export const LEGACY_SCHEMA_VERSION = 1;
/** The revert-only schema (no `'proof'`/`'forget'`). Only `migration.ts` reads it. */
export const PREVIOUS_SCHEMA_VERSION = 2;
/**
 * Header marker (`PRAGMA application_id`, ASCII "RAC2") naming the file as a
 * RACOONS ledger. `user_version` alone cannot distinguish "not ours" from
 * "ours"; the pair is the explicit file version. The marker names the product,
 * not the schema, so it does not move with `SCHEMA_VERSION`.
 */
export const LEDGER_APPLICATION_ID = 0x52414332;

export const LEDGER_TABLES = [
  "blobs", "recalls", "recall_parts", "removed_spans", "applications",
  "application_removals", "ledger_events",
] as const;

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS blobs (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS recalls (
    recall_id TEXT PRIMARY KEY,
    manifest_sha256 TEXT NOT NULL UNIQUE REFERENCES blobs(sha256),
    created_at_ms INTEGER NOT NULL,
    CHECK (recall_id = 'recall:sha256:' || manifest_sha256)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS recall_parts (
    recall_id TEXT NOT NULL REFERENCES recalls(recall_id),
    part_index INTEGER NOT NULL CHECK (part_index >= 0),
    source_node_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
    source_byte_length INTEGER NOT NULL CHECK (source_byte_length >= 0),
    blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
    PRIMARY KEY (recall_id, part_index),
    CHECK (source_sha256 = blob_sha256)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS removed_spans (
    recall_id TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    span_index INTEGER NOT NULL CHECK (span_index >= 0),
    start_byte INTEGER NOT NULL CHECK (start_byte >= 0),
    end_byte_exclusive INTEGER NOT NULL,
    slice_sha256 TEXT NOT NULL CHECK (length(slice_sha256) = 64),
    PRIMARY KEY (recall_id, part_index, span_index),
    FOREIGN KEY (recall_id, part_index) REFERENCES recall_parts(recall_id, part_index),
    CHECK (end_byte_exclusive > start_byte)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS applications (
    intent_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    base_revision TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('entry', 'at-rest')),
    application_sha256 TEXT NOT NULL CHECK (length(application_sha256) = 64),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    created_at_ms INTEGER NOT NULL,
    UNIQUE (session_id, event_id, application_sha256)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS application_removals (
    intent_id TEXT NOT NULL REFERENCES applications(intent_id),
    rule_id TEXT NOT NULL,
    removal_id TEXT NOT NULL,
    recall_id TEXT NOT NULL REFERENCES recalls(recall_id),
    operation_kind TEXT NOT NULL CHECK (operation_kind IN (
      'cap', 'seal', 'evict', 'span', 'verdict', 'proof', 'forget')),
    episode_id TEXT,
    title TEXT NOT NULL,
    PRIMARY KEY (intent_id, rule_id, removal_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS ledger_events (
    sequence INTEGER PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    intent_id TEXT REFERENCES applications(intent_id),
    kind TEXT NOT NULL CHECK (kind IN (
      'prepared', 'applied', 'abandoned', 'validation',
      'breaker-disabled', 'breaker-announced'
    )),
    at_ms INTEGER NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS ledger_events_session_sequence
    ON ledger_events(session_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS applications_session_event
    ON applications(session_id, event_id)`,
  `CREATE INDEX IF NOT EXISTS application_removals_recall
    ON application_removals(recall_id)`,
  `CREATE INDEX IF NOT EXISTS application_removals_episode
    ON application_removals(episode_id, intent_id)`,
  `CREATE INDEX IF NOT EXISTS recall_parts_source_sha256
    ON recall_parts(source_sha256)`,
  ...LEDGER_TABLES.flatMap(table => [
    `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'append-only trash ledger'); END`,
    `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'append-only trash ledger'); END`,
  ]),
];

function pragmaValue(db: DatabaseSync, pragma: string): number | null {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  const value = row === undefined ? undefined : asRow(row, pragma)[pragma];
  return typeof value === "number" ? value : null;
}

/**
 * Creates or verifies the schema on an open handle. An older handle (schema 1
 * or 2) is refused here: only `prepareLedgerFile` may read one, and only to
 * rebuild a fresh file. `SqliteLedger.open` migrates before this runs.
 */
export function initializeSchema(db: DatabaseSync): void {
  const version = pragmaValue(db, "user_version");
  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new LedgerError("unsupported-schema", version === LEGACY_SCHEMA_VERSION
      ? "Legacy trash ledger schema 1 can only be rebuilt through SqliteLedger.open"
      : version === PREVIOUS_SCHEMA_VERSION
        ? "Trash ledger schema 2 can only be rebuilt through SqliteLedger.open"
        : `Unsupported trash ledger schema ${String(version)}`);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    // v1 wrote user_version 1 and no application id; anything else claiming a
    // version is not this ledger. Checked inside the transaction so a refusal
    // leaves the file exactly as it was found.
    const applicationId = pragmaValue(db, "application_id");
    if (applicationId !== 0 && applicationId !== LEDGER_APPLICATION_ID) {
      throw new LedgerError("unsupported-schema",
        `Database is not a RACOONS trash ledger (application id ${String(applicationId)})`);
    }
    assertCheckAdmitsOperations(db);
    db.exec(`PRAGMA application_id = ${LEDGER_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw storageError(error, "Cannot initialize trash ledger schema");
  }
}

/**
 * `CREATE TABLE IF NOT EXISTS` leaves a pre-existing table untouched, so a file
 * whose `user_version` is 0 but whose `application_removals` carries an older
 * CHECK would otherwise be stamped with the current version over that CHECK.
 * Refuse instead; the rollback removes anything this call created.
 *
 * @internal Exported for the migration test that plants an old-shaped table.
 */
export function assertCheckAdmitsOperations(db: DatabaseSync): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'application_removals'").get();
  const sql = row === undefined ? undefined : asRow(row, "sqlite_master")["sql"];
  const complete = typeof sql === "string" &&
    OPERATION_KINDS.every(kind => sql.includes(`'${kind}'`));
  if (!complete) {
    throw new LedgerError("unsupported-schema",
      `application_removals predates schema ${SCHEMA_VERSION}; rebuild the file through SqliteLedger.open`);
  }
}

/** The archive kinds schema 3 admits, the CHECK's own list. */
export const OPERATION_KINDS = [
  "cap", "seal", "evict", "span", "verdict", "proof", "forget",
] as const;

/** One owner for "is this kind admitted": the writer and the verifier both ask it. */
export function isOperationKind(value: string): boolean {
  return OPERATION_KINDS.some(kind => kind === value);
}
