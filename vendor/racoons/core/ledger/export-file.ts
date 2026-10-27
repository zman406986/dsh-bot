import type { DatabaseSync } from "node:sqlite";
import type { Bytes, SessionId, Sha256 } from "../types/identity.js";
import { canonicalBytesWithByteArrays } from "../util/bytes.js";
import { sha256 } from "../util/hash.js";
import type { BlobStore } from "./blob-store.js";
import { assertHash, verifyBytes } from "./integrity.js";
import type { Row, SqlValue } from "./rows.js";
import { asRows, text } from "./rows.js";
import type { LedgerArchive } from "./types.js";
import { LedgerError } from "./types.js";

/**
 * Export (PRD §6.7; ISSUE-045 chunk C9, ADR-0019). One session becomes a
 * self-contained archive: its rows, every blob body those rows name, and a
 * manifest written by the same canonical encoder every ledger digest uses.
 * The archive is additive — the durable per-session file stays the record of
 * record (ADR-0015) — and it is never written automatically.
 *
 * This module owns the archive format: its kind, its version, its table order
 * and its encoding. `rehydrate.ts` reads through `parseArchiveDocument`, so the
 * writer and the reader cannot disagree about what an archive is.
 */

export const ARCHIVE_KIND = "racoons:ledger-archive";
export const ARCHIVE_VERSION = 1;

export type ArchiveTableName =
  | "blobs" | "recalls" | "recall_parts" | "removed_spans"
  | "applications" | "application_removals" | "ledger_events";

export interface ArchiveTableSpec {
  readonly name: ArchiveTableName;
  readonly columns: readonly string[];
  /** The row identity `rehydrate.ts` re-inserts under; identical rows are a no-op. */
  readonly key: readonly string[];
}

/**
 * One row of each table, in dependency order — the order a hydrate inserts and
 * the ledger's own foreign keys require. The column lists are copied from the
 * writer (`commit-preparation.ts`) and the migration (`migration.ts`) explicitly,
 * never `SELECT *`, so a legacy column can never leak into an archive.
 */
export const ARCHIVE_TABLES: readonly ArchiveTableSpec[] = [
  { name: "blobs", columns: ["sha256", "byte_length", "created_at_ms"], key: ["sha256"] },
  { name: "recalls", columns: ["recall_id", "manifest_sha256", "created_at_ms"], key: ["recall_id"] },
  { name: "recall_parts",
    columns: ["recall_id", "part_index", "source_node_id", "source_sha256",
      "source_byte_length", "blob_sha256"],
    key: ["recall_id", "part_index"] },
  { name: "removed_spans",
    columns: ["recall_id", "part_index", "span_index", "start_byte",
      "end_byte_exclusive", "slice_sha256"],
    key: ["recall_id", "part_index", "span_index"] },
  { name: "applications",
    columns: ["intent_id", "session_id", "event_id", "base_revision", "phase",
      "application_sha256", "metadata_json", "created_at_ms"],
    key: ["intent_id"] },
  { name: "application_removals",
    columns: ["intent_id", "rule_id", "removal_id", "recall_id", "operation_kind",
      "episode_id", "title"],
    key: ["intent_id", "rule_id", "removal_id"] },
  { name: "ledger_events",
    columns: ["sequence", "event_key", "session_id", "intent_id", "kind", "at_ms",
      "payload_json"],
    // `sequence` is the archived order itself, so a hydrate reproduces it. A
    // target that already holds a different row at that number refuses the
    // archive (`idempotency-conflict`) instead of renumbering one copy of a
    // session and calling the two identical (ADR-0015: the durable file is the
    // record of record, so a diverging copy is a conflict, never a merge).
    key: ["sequence"] },
];

export type ArchiveRow = Readonly<Record<string, SqlValue>>;

export interface ArchiveBlob {
  readonly sha256: Sha256;
  readonly bytes: Bytes;
}

/**
 * The archive document. `blobs` holds the bodies themselves; `tables.blobs`
 * holds the metadata rows that name them, exactly as the durable file does.
 */
export interface LedgerArchiveDocument {
  readonly kind: typeof ARCHIVE_KIND;
  readonly version: typeof ARCHIVE_VERSION;
  readonly sessionId: SessionId;
  readonly tables: Readonly<Record<ArchiveTableName, readonly ArchiveRow[]>>;
  readonly blobs: readonly ArchiveBlob[];
}

/**
 * One session's rows plus every blob they name, encoded as one canonical
 * document. Deterministic: two exports of an unchanged session are byte-equal,
 * because every query has a total order and the encoder sorts object keys.
 */
export async function exportSession(
  db: DatabaseSync, store: BlobStore, sessionId: SessionId,
): Promise<LedgerArchive> {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new LedgerError("storage", "An archive needs one non-empty session id");
  }
  const recalls = recallIdsFor(db, sessionId);
  const partRows = inClause(db, "recall_parts", recalls,
    "recall_id ASC, part_index ASC");
  const recallRows = inClause(db, "recalls", recalls, "recall_id ASC");
  const hashes = [...new Set([
    ...recallRows.map(row => text(row, "manifest_sha256")),
    ...partRows.map(row => text(row, "blob_sha256")),
  ])].sort();
  const blobRows = inClause(db, "blobs", hashes, "sha256 ASC");
  if (blobRows.length !== hashes.length) mismatch("Ledger omits a blob its recalls name");
  const recorded = tableRows(
    db, sessionId, recalls, { recalls: recallRows, "recall_parts": partRows, blobs: blobRows },
  );
  // Finish every synchronous metadata read before touching asynchronous blob
  // storage: one archive must describe one consistent instant (recall.ts's
  // discipline, for the same reason).
  const blobs: ArchiveBlob[] = [];
  for (const row of recorded.blobs) {
    const hash = row["sha256"];
    if (typeof hash !== "string") mismatch("Invalid sha256 in a ledger row");
    assertHash(hash);
    const length = row["byte_length"];
    if (typeof length !== "number" || !Number.isSafeInteger(length)) {
      throw new LedgerError("storage", "Invalid byte_length in a ledger row");
    }
    const body = new Uint8Array(await store.get(hash));
    await verifyBytes(body, hash, length);
    blobs.push({ sha256: hash, bytes: body });
  }
  const document: LedgerArchiveDocument = {
    kind: ARCHIVE_KIND, version: ARCHIVE_VERSION, sessionId, tables: recorded, blobs,
  };
  const bytes = canonicalBytesWithByteArrays(document);
  return { sessionId, archiveSha256: await sha256(bytes), bytes };
}

/**
 * Reads an archive back into the one shape the writer produced. Kind, version,
 * table set, column set, value types and the canonical encoding are all facts
 * of the archive's own bytes: each disagreement refuses, none is repaired.
 */
export function parseArchiveDocument(bytes: Bytes): LedgerArchiveDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new LedgerError("hash-mismatch", "Malformed ledger archive", { cause: error });
  }
  const root = record(raw, "archive");
  if (root["kind"] !== ARCHIVE_KIND) {
    throw new LedgerError("unsupported-schema", "Archive is not a RACOONS ledger archive");
  }
  if (root["version"] !== ARCHIVE_VERSION) {
    throw new LedgerError("unsupported-schema",
      `Unsupported ledger archive version ${String(root["version"])}`);
  }
  const sessionId = root["sessionId"];
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    mismatch("Archive names no session");
  }
  const rawTables = record(root["tables"], "archive tables");
  const known = new Set<string>(ARCHIVE_TABLES.map(spec => spec.name));
  for (const name of Object.keys(rawTables)) {
    if (!known.has(name)) {
      throw new LedgerError("unsupported-schema",
        `Archive names a table this version does not know: ${name}`);
    }
  }
  const tables = {} as Record<ArchiveTableName, readonly ArchiveRow[]>;
  for (const spec of ARCHIVE_TABLES) {
    const rows = rawTables[spec.name];
    if (!Array.isArray(rows)) mismatch(`Archive table ${spec.name} is missing`);
    tables[spec.name] = rows.map((row: unknown, index: number) => archiveRow(spec, row, index));
  }
  const rawBlobs = root["blobs"];
  if (!Array.isArray(rawBlobs)) mismatch("Archive has no blob list");
  const blobs = rawBlobs.map((rawBlob: unknown, index: number) => {
    const entry = record(rawBlob, `archive blob ${String(index)}`);
    const hash = entry["sha256"];
    if (typeof hash !== "string") mismatch("Archive blob names no hash");
    assertHash(hash);
    const values = entry["bytes"];
    if (!Array.isArray(values)) mismatch("Archive blob carries no bytes");
    const body = new Uint8Array(values.length);
    values.forEach((value: unknown, offset: number) => {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
        mismatch("Archive blob bytes must be integers 0..255");
      }
      body[offset] = value;
    });
    return { sha256: hash, bytes: body };
  });
  const document: LedgerArchiveDocument = {
    kind: ARCHIVE_KIND, version: ARCHIVE_VERSION, sessionId, tables, blobs,
  };
  // The canonical encoder is the archive's only encoding: a document re-spelled
  // with different bytes is refused, never read leniently.
  const canonical = canonicalBytesWithByteArrays(document);
  if (canonical.byteLength !== bytes.byteLength ||
      canonical.some((byte, index) => byte !== bytes[index])) {
    mismatch("Archive encoding is not canonical");
  }
  return document;
}

/** The table rows a session owns, in the archive's dependency order. */
function tableRows(
  db: DatabaseSync, sessionId: SessionId, recalls: readonly string[],
  supplied: Readonly<Record<"recalls" | "recall_parts" | "blobs", readonly Row[]>>,
): Readonly<Record<ArchiveTableName, readonly ArchiveRow[]>> {
  return {
    blobs: project("blobs", supplied.blobs),
    recalls: project("recalls", supplied.recalls),
    "recall_parts": project("recall_parts", supplied["recall_parts"]),
    removed_spans: project("removed_spans",
      inClause(db, "removed_spans", recalls, "recall_id ASC, part_index ASC, span_index ASC")),
    applications: project("applications",
      where(db, "applications", "session_id = ?", [sessionId], "intent_id ASC")),
    application_removals: project("application_removals",
      where(db, "application_removals",
        "intent_id IN (SELECT intent_id FROM applications WHERE session_id = ?)",
        [sessionId], "intent_id ASC, rule_id ASC, removal_id ASC")),
    ledger_events: project("ledger_events",
      where(db, "ledger_events", "session_id = ?", [sessionId], "sequence ASC")),
  };
}

/** The recall ids a session's own removals name. */
function recallIdsFor(db: DatabaseSync, sessionId: SessionId): readonly string[] {
  return asRows(db.prepare(`SELECT DISTINCT recall_id FROM application_removals
    WHERE intent_id IN (SELECT intent_id FROM applications WHERE session_id = ?)
    ORDER BY recall_id`).all(sessionId), "application_removals")
    .map(row => text(row, "recall_id"));
}

function where(
  db: DatabaseSync, name: ArchiveTableName, clause: string,
  parameters: readonly SqlValue[], order: string,
): readonly Row[] {
  const spec = ARCHIVE_TABLES.find(candidate => candidate.name === name);
  if (spec === undefined) throw new LedgerError("storage", `Unknown archive table ${name}`);
  return asRows(db.prepare(`SELECT ${spec.columns.join(", ")} FROM ${name}
    WHERE ${clause} ORDER BY ${order}`).all(...parameters), name);
}

/** A query with an `IN` list; an empty list matches no row, never every row. */
function inClause(
  db: DatabaseSync, name: "blobs" | "recalls" | "recall_parts" | "removed_spans",
  values: readonly string[], order: string,
): readonly Row[] {
  if (values.length === 0) return [];
  const key = name === "blobs" ? "sha256" : "recall_id";
  return where(db, name, `${key} IN (${values.map(() => "?").join(", ")})`, values, order);
}

function project(name: ArchiveTableName, rows: readonly Row[]): readonly ArchiveRow[] {
  const spec = ARCHIVE_TABLES.find(candidate => candidate.name === name);
  if (spec === undefined) throw new LedgerError("storage", `Unknown archive table ${name}`);
  return rows.map(row => {
    const output: Record<string, SqlValue> = {};
    for (const column of spec.columns) output[column] = value(row, column);
    return output;
  });
}

/** The one value narrowing: a column this ledger wrote is a JSON scalar. */
function value(row: Row, column: string): SqlValue {
  const found = row[column];
  if (found === null || typeof found === "string" || typeof found === "number") return found;
  throw new LedgerError("storage", `Invalid ${column} in a ledger row`);
}

function archiveRow(spec: ArchiveTableSpec, raw: unknown, index: number): ArchiveRow {
  const row = record(raw, `${spec.name} row ${String(index)}`);
  const keys = Object.keys(row).sort();
  if (keys.length !== spec.columns.length ||
      keys.some((key, position) => key !== [...spec.columns].sort()[position])) {
    mismatch(`Archive ${spec.name} row ${String(index)} carries the wrong columns`);
  }
  const output: Record<string, SqlValue> = {};
  for (const column of spec.columns) {
    const found = row[column];
    if (found === null || typeof found === "string") { output[column] = found; continue; }
    if (typeof found === "number" && Number.isSafeInteger(found)) { output[column] = found; continue; }
    mismatch(`Archive ${spec.name} row ${String(index)} has a non-scalar ${column}`);
  }
  return output;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    mismatch(`Expected ${what} to be an object`);
  }
  return value as Record<string, unknown>;
}

function mismatch(message: string): never { throw new LedgerError("hash-mismatch", message); }
