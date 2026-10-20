import type { DatabaseSync } from "node:sqlite";
import { LedgerError } from "./types.js";
import { storageError } from "./integrity.js";
import { asRow } from "./rows.js";

export const SCHEMA_VERSION = 1;
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
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('cap', 'seal', 'evict', 'span')),
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

export function initializeSchema(db: DatabaseSync): void {
  const versionRow = db.prepare("PRAGMA user_version").get();
  const rawVersion = versionRow === undefined ? undefined : asRow(versionRow, "user_version")["user_version"];
  const version = typeof rawVersion === "number" ? rawVersion : null;
  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new LedgerError("unsupported-schema", `Unsupported trash ledger schema ${String(version)}`);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw storageError(error, "Cannot initialize trash ledger schema");
  }
}
