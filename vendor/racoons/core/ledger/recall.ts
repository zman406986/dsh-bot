import type { DatabaseSync } from "node:sqlite";
import type { RecallId } from "../types/identity.js";
import type { BlobStore } from "./blob-store.js";
import type { RecallPart, RecallRecord } from "./manifest.js";
import { manifestSha256, parseRecallManifest, recallIdFor } from "./manifest.js";
import { LedgerError } from "./types.js";
import { assertHash, verifyBytes } from "./integrity.js";
import { asRow, asRows, integer, text } from "./rows.js";

export async function readRecall(
  db: DatabaseSync, store: BlobStore, id: RecallId,
): Promise<RecallRecord> {
  if (!/^recall:sha256:[0-9a-f]{64}$/.test(id)) {
    throw new LedgerError("not-found", `Invalid recall id ${id}`);
  }
  const row = db.prepare("SELECT * FROM recalls WHERE recall_id = ?").get(id);
  if (row === undefined) throw new LedgerError("not-found", `Missing recall ${id}`);
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

function mismatch(message: string): never { throw new LedgerError("hash-mismatch", message); }
