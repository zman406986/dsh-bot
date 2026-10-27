import type { DatabaseSync } from "node:sqlite";
import type { Sha256 } from "../types/identity.js";
import { sha256 } from "../util/hash.js";
import type { BlobStore } from "./blob-store.js";
import type { ArchiveBlob, LedgerArchiveDocument } from "./export-file.js";
import { ARCHIVE_TABLES, parseArchiveDocument } from "./export-file.js";
import { assertHash, verifyBytes } from "./integrity.js";
import { insertImmutable } from "./rows.js";
import type { SqlValue } from "./rows.js";
import type { LedgerArchive, HydratedLedger } from "./types.js";
import { LedgerError } from "./types.js";

/**
 * Hydrate (PRD §6.7; ISSUE-045 chunk C9, ADR-0019). An exported archive is
 * verified against itself — its digest, its canonical encoding, every blob's
 * own hash and length — and only then inserted, in the dependency order the
 * ledger's foreign keys require. Verification is complete before the first
 * byte is published, so a refused archive leaves the target ledger untouched.
 *
 * Additive by construction: hydrate inserts rows and never deletes one. The
 * durable per-session file stays the record of record (ADR-0015); an archive is
 * a second copy of the same facts, not a newer authority.
 */

export interface VerifiedArchive {
  readonly document: LedgerArchiveDocument;
  /** Bodies proven against their declared hash and length, in archive order. */
  readonly blobs: readonly ArchiveBlob[];
}

/**
 * The digest gate first, then the format gate: an archive whose own digest
 * disagrees with its bytes is refused before anything parses it. `sessionId`
 * must agree too — an archive is one session, and the caller names the one it
 * asked for.
 */
export async function verifyArchive(archive: LedgerArchive): Promise<VerifiedArchive> {
  assertHash(archive.archiveSha256);
  const digest = await sha256(new Uint8Array(archive.bytes));
  if (digest !== archive.archiveSha256) {
    throw new LedgerError("hash-mismatch", "Archive digest disagrees with its bytes");
  }
  const document = parseArchiveDocument(new Uint8Array(archive.bytes));
  if (document.sessionId !== archive.sessionId) {
    throw new LedgerError("hash-mismatch", "Archive names another session");
  }
  assertSessionRows(document);
  const blobs = await verifiedBlobs(document);
  return { document, blobs };
}

/** Publish every body first; rows are only inserted once their content exists. */
export async function publishArchiveBlobs(
  blobs: readonly ArchiveBlob[], store: BlobStore,
): Promise<void> {
  for (const blob of blobs) {
    const published = await store.put(new Uint8Array(blob.bytes));
    if (published !== blob.sha256) {
      throw new LedgerError("hash-mismatch", `Blob store returned an incorrect hash ${blob.sha256}`);
    }
    await verifyBytes(new Uint8Array(await store.get(published)), blob.sha256, blob.bytes.byteLength);
  }
}

/**
 * Insert one verified archive inside the caller's transaction. Identical rows
 * are a no-op and a row that disagrees with an existing key is
 * `idempotency-conflict`, exactly as every other writer in this ledger answers.
 *
 * The archive's own sequence numbers are preserved, so `events()` answers the
 * exported session identically — byte-equal rows in the same order. A target
 * that already holds a different row at one of those numbers is refused rather
 * than renumbered: the two copies disagree about a fact, and silently mixing
 * them would make both look authoritative (ADR-0015).
 */
export function commitArchive(db: DatabaseSync, document: LedgerArchiveDocument): HydratedLedger {
  for (const spec of ARCHIVE_TABLES) {
    for (const row of document.tables[spec.name]) {
      const key: Record<string, SqlValue> = {};
      for (const column of spec.key) {
        const found = row[column];
        if (found === undefined) {
          throw new LedgerError("hash-mismatch", `Archive ${spec.name} row names no ${column}`);
        }
        key[column] = found;
      }
      insertImmutable(db, spec.name, key, row);
    }
  }
  return {
    sessionId: document.sessionId,
    events: document.tables.ledger_events.length,
    recalls: document.tables.recalls.length,
  };
}

/** Every session-bearing row belongs to the archive's one session. */
function assertSessionRows(document: LedgerArchiveDocument): void {
  for (const table of ["applications", "ledger_events"] as const) {
    for (const row of document.tables[table]) {
      if (row["session_id"] !== document.sessionId) {
        throw new LedgerError("hash-mismatch", `Archive ${table} row belongs to another session`);
      }
    }
  }
}

/**
 * One body per metadata row, and one metadata row per body: the two lists are
 * the same set, or the archive contradicts itself. Each body is hashed here,
 * never trusted from the document, so an edited byte is refused even when the
 * archive digest was recomputed over the edit.
 */
async function verifiedBlobs(document: LedgerArchiveDocument): Promise<readonly ArchiveBlob[]> {
  const declared = new Map<Sha256, number>();
  for (const row of document.tables.blobs) {
    const hash = row["sha256"];
    const length = row["byte_length"];
    if (typeof hash !== "string" || typeof length !== "number") {
      throw new LedgerError("hash-mismatch", "Archive blob row names no hash or length");
    }
    assertHash(hash);
    declared.set(hash, length);
  }
  const blobs: ArchiveBlob[] = [];
  const seen = new Set<Sha256>();
  for (const blob of document.blobs) {
    if (seen.has(blob.sha256)) {
      throw new LedgerError("hash-mismatch", `Two archive bodies for ${blob.sha256}`);
    }
    seen.add(blob.sha256);
    const length = declared.get(blob.sha256);
    if (length === undefined) {
      throw new LedgerError("hash-mismatch", "Archive carries a body no blob row names");
    }
    const body = new Uint8Array(blob.bytes);
    if (body.byteLength !== length || await sha256(body) !== blob.sha256) {
      throw new LedgerError("hash-mismatch", `Archive blob ${blob.sha256} does not match its hash`);
    }
    blobs.push({ sha256: blob.sha256, bytes: body });
  }
  if (blobs.length !== declared.size) {
    throw new LedgerError("hash-mismatch", "Archive omits a body its blob rows name");
  }
  assertReferences(document, declared.keys());
  return blobs;
}

/**
 * Every hash and recall id a row points at is in the archive. The ledger's own
 * foreign keys would refuse these too, but only after a transaction opened;
 * this refuses before a single body is published.
 */
function assertReferences(document: LedgerArchiveDocument, hashes: Iterable<Sha256>): void {
  const known = new Set<Sha256>(hashes);
  const recalls = new Set<string>();
  for (const row of document.tables.recalls) {
    const manifest = row["manifest_sha256"];
    if (typeof manifest !== "string" || !known.has(manifest)) {
      throw new LedgerError("hash-mismatch", "Archive recall names a missing manifest blob");
    }
    recalls.add(String(row["recall_id"]));
  }
  for (const spec of ["recall_parts", "removed_spans"] as const) {
    for (const row of document.tables[spec]) {
      if (!recalls.has(String(row["recall_id"]))) {
        throw new LedgerError("hash-mismatch", `Archive ${spec} row names a missing recall`);
      }
    }
  }
  for (const row of document.tables.recall_parts) {
    if (!known.has(String(row["blob_sha256"]))) {
      throw new LedgerError("hash-mismatch", "Archive recall part names a missing body blob");
    }
  }
  const intents = new Set<string>(document.tables.applications.map(row => String(row["intent_id"])));
  for (const row of document.tables.application_removals) {
    const key = String(row["recall_id"]);
    if (!recalls.has(key)) {
      throw new LedgerError("hash-mismatch", "Archive removal names a missing recall");
    }
    if (!intents.has(String(row["intent_id"]))) {
      throw new LedgerError("hash-mismatch", "Archive removal names a missing intent");
    }
  }
  for (const row of document.tables.ledger_events) {
    const intent = row["intent_id"];
    if (intent !== null && !intents.has(String(intent))) {
      throw new LedgerError("hash-mismatch", "Archive event names a missing intent");
    }
  }
}
