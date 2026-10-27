import type { DatabaseSync } from "node:sqlite";
import type { Bytes, RecallId } from "../types/identity.js";
import type { BlobStore } from "./blob-store.js";
import type { RecallManifest, RecallPart, RecallRecord } from "./manifest.js";
import { buildRecallManifest, manifestSha256, parseRecallManifest, recallIdFor } from "./manifest.js";
import type { RecallOptions } from "./types.js";
import { LedgerError } from "./types.js";
import { assertHash, verifyBytes } from "./integrity.js";
import { asIndexedSourceReader } from "./source-reader.js";
import { asRow, asRows, integer, text } from "./rows.js";

export async function readRecall(
  db: DatabaseSync, store: BlobStore, id: RecallId, options?: RecallOptions,
): Promise<RecallRecord> {
  if (!/^recall:sha256:[0-9a-f]{64}$/.test(id)) {
    throw new LedgerError("not-found", `Invalid recall id ${id}`);
  }
  const row = db.prepare("SELECT * FROM recalls WHERE recall_id = ?").get(id);
  // One narrow gate: only an absent row is a miss. A row that exists but whose
  // manifest or body is gone is corruption, and the fallback never touches it.
  if (row === undefined) return recallFromSource(id, options);
  const hash = text(asRow(row, "recalls"), "manifest_sha256");
  assertHash(hash);
  if (id !== recallIdFor(hash)) mismatch("Recall id does not match manifest hash");
  // Finish all synchronous metadata reads before touching asynchronous blob storage.
  const metadataRow = db.prepare("SELECT * FROM blobs WHERE sha256 = ?").get(hash);
  if (metadataRow === undefined) mismatch("Missing manifest metadata");
  const metadata = asRow(metadataRow, "blobs");
  const partRows = asRows(db.prepare(`SELECT p.*, b.byte_length AS stored_byte_length
    FROM recall_parts p JOIN blobs b ON p.blob_sha256 = b.sha256
    WHERE p.recall_id = ? ORDER BY p.part_index`).all(id), "recall_parts");
  const spanRows = asRows(db.prepare(`SELECT * FROM removed_spans WHERE recall_id = ?
    ORDER BY part_index, span_index`).all(id), "removed_spans");
  const manifestBytes = new Uint8Array(await store.get(hash));
  await verifyBytes(manifestBytes, hash, integer(metadata, "byte_length"));
  const manifest = parseRecallManifest(manifestBytes);
  if (await manifestSha256(manifest) !== hash) mismatch("Manifest hash differs");
  if (partRows.length !== manifest.parts.length ||
      spanRows.length !== manifest.parts.reduce((sum, part) => sum + part.removedRanges.length, 0)) {
    mismatch("Recall metadata count differs from manifest");
  }
  const parts: RecallPart[] = [];
  for (const [index, part] of manifest.parts.entries()) {
    const stored = partRows[index];
    if (stored === undefined || integer(stored, "part_index") !== index ||
        text(stored, "source_node_id") !== part.source.nodeId ||
        text(stored, "source_sha256") !== part.source.sha256 ||
        integer(stored, "source_byte_length") !== part.source.byteLength ||
        integer(stored, "stored_byte_length") !== part.source.byteLength ||
        text(stored, "blob_sha256") !== part.blobSha256) mismatch("Part metadata differs");
    const storedSpans = spanRows.filter(span => integer(span, "part_index") === index);
    if (storedSpans.length !== part.removedRanges.length) mismatch("Span metadata count differs");
    const bytes = new Uint8Array(await store.get(part.blobSha256));
    await verifyBytes(bytes, part.blobSha256, part.source.byteLength);
    await verifyBytes(bytes, part.source.sha256, part.source.byteLength);
    for (const [spanIndex, span] of part.removedRanges.entries()) {
      const storedSpan = storedSpans[spanIndex];
      if (storedSpan === undefined || integer(storedSpan, "span_index") !== spanIndex ||
          integer(storedSpan, "start_byte") !== span.range.startByte ||
          integer(storedSpan, "end_byte_exclusive") !== span.range.endByteExclusive ||
          text(storedSpan, "slice_sha256") !== span.sha256) mismatch("Span metadata differs");
      await verifyBytes(bytes.slice(span.range.startByte, span.range.endByteExclusive), span.sha256);
    }
    parts.push({ source: { ...part.source }, bytes, removedRanges: part.removedRanges });
  }
  return { id, manifestSha256: hash, manifest, parts };
}

/**
 * The second lane a recall takes when the ledger holds no row for the id
 * (PRD §6.7, the two-device safety rule; ISSUE-045 chunk C7). The source index
 * names, per recall, the manifest that produced the id and the file each part
 * came from, so this lane answers with the same `RecallRecord` the ledger lane
 * would have returned.
 *
 * Every byte is re-proven here, not by the reader: the body must hash to the
 * manifest's own `source.sha256` and length, and every removed range must hash
 * to its manifest slice. A changed file therefore refuses (`hash-mismatch`) and
 * is never a substitute; an id the index does not know, or no index at all,
 * stays `not-found` exactly as before. `blobSha256` is not re-derived: the
 * manifest already requires it to equal `source.sha256` (`buildRecallManifest`).
 */
async function recallFromSource(id: RecallId, options: RecallOptions | undefined): Promise<RecallRecord> {
  const reader = options?.reader === undefined ? null : asIndexedSourceReader(options.reader);
  const indexed = reader?.locate(id) ?? null;
  if (reader === null || indexed === null) throw new LedgerError("not-found", `Missing recall ${id}`);
  // Rebuild from the index's own facts: this normalises and validates the
  // manifest, and the id proves it is the manifest the caller asked for.
  const manifest: RecallManifest = buildRecallManifest(indexed.manifest);
  const hash = await manifestSha256(manifest);
  if (recallIdFor(hash) !== id) {
    throw new LedgerError("hash-mismatch", "Source index record does not match its recall id");
  }
  if (indexed.paths.length !== manifest.parts.length) {
    throw new LedgerError("hash-mismatch", "Source index names a different number of files");
  }
  const parts: RecallPart[] = [];
  for (const [index, part] of manifest.parts.entries()) {
    const path = indexed.paths[index];
    if (path === undefined || path.trim() === "") {
      throw new LedgerError("hash-mismatch", "Source index names no file for a part");
    }
    const bytes: Bytes = new Uint8Array(await reader.read({
      source: { ...part.source }, path,
      ranges: part.removedRanges.map(span => ({ ...span.range })),
    }));
    await verifyBytes(bytes, part.source.sha256, part.source.byteLength);
    for (const span of part.removedRanges) {
      await verifyBytes(bytes.slice(span.range.startByte, span.range.endByteExclusive), span.sha256);
    }
    parts.push({ source: { ...part.source }, bytes, removedRanges: part.removedRanges });
  }
  return { id, manifestSha256: hash, manifest, parts };
}

function mismatch(message: string): never { throw new LedgerError("hash-mismatch", message); }
