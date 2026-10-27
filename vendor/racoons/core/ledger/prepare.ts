import type { Bytes, Sha256 } from "../types/identity.js";
import { sha256 } from "../util/hash.js";
import type { BlobStore } from "./blob-store.js";
import { snapshotApplicationHash } from "./application-integrity.js";
import {
  buildRecallManifest, encodeRecallManifest, manifestSha256, recallIdFor,
} from "./manifest.js";
import { isOperationKind } from "./schema.js";
import type { ArchiveRecord, PreparableApplication, PreparedIntent } from "./types.js";
import { LedgerError } from "./types.js";
import { assertHash, stableJson, verifyBytes } from "./integrity.js";

export interface Preparation {
  readonly intent: PreparedIntent;
  readonly phase: "entry" | "at-rest";
  readonly metadataJson: string;
  readonly archives: readonly ArchiveRecord[];
  readonly blobs: ReadonlyMap<Sha256, Bytes>;
}

/** Verify and privately copy all content before the first blob publication. */
export async function verifyApplication(application: PreparableApplication): Promise<Preparation> {
  const { sessionId, eventId, baseRevision, phase, applicationSha256 } = application;
  assertHash(applicationSha256);
  if (typeof sessionId !== "string" || typeof eventId !== "string" ||
      typeof baseRevision !== "string" || (phase !== "entry" && phase !== "at-rest")) {
    throw new LedgerError("hash-mismatch", "Invalid application identity");
  }
  // Snapshot synchronously before the first await; callers retain mutable arrays.
  const fullHash = snapshotApplicationHash(application);
  const archives: ArchiveRecord[] = application.archives.map(archive => {
    if (archive.recall.manifest.version !== 1) mismatch("Unsupported manifest version");
    // The CHECK's list is the one owner of the admitted kinds; a kind this
    // schema does not carry is refused here, never by the INSERT's CHECK.
    if (!isOperationKind(archive.operationKind)) {
      mismatch(`Unsupported operation kind ${String(archive.operationKind)}`);
    }
    return {
      ruleId: archive.ruleId, removalId: archive.removalId,
      operationKind: archive.operationKind, episodeId: archive.episodeId, title: archive.title,
      recall: {
        id: archive.recall.id, manifestSha256: archive.recall.manifestSha256,
        manifest: buildRecallManifest(archive.recall.manifest),
        parts: archive.recall.parts.map(part => ({
          source: { ...part.source }, bytes: new Uint8Array(part.bytes),
          removedRanges: part.removedRanges.map(span => ({
            range: { ...span.range }, sha256: span.sha256,
          })),
        })),
      },
    };
  });
  const records = application.appendRecords.map(record => ({
    recordId: record.recordId, sha256: record.sha256, bytes: new Uint8Array(record.bytes),
  }));
  const sealedEpisodeIds = [...application.sealedEpisodeIds];
  if (fullHash !== null) {
    await verifyBytes(fullHash.bytes, applicationSha256);
    for (const replacement of fullHash.replacements) {
      await verifyBytes(replacement.bytes, replacement.sha256);
    }
  }
  const blobs = new Map<Sha256, Bytes>();
  for (const archive of archives) {
    const { recall } = archive;
    if (recall.manifest.sessionId !== sessionId) mismatch("Recall belongs to another session");
    const manifestHash = await manifestSha256(recall.manifest);
    if (manifestHash !== recall.manifestSha256 || recall.id !== recallIdFor(manifestHash)) {
      mismatch("Recall identity does not match its manifest");
    }
    const fromBodies = buildRecallManifest(sessionId, recall.parts.map(part => ({
      source: part.source, blobSha256: part.source.sha256, removedRanges: part.removedRanges,
    })));
    if (stableJson(fromBodies) !== stableJson(recall.manifest)) mismatch("Recall parts differ from manifest");
    for (const part of recall.parts) {
      await verifyBytes(part.bytes, part.source.sha256, part.source.byteLength);
      for (const span of part.removedRanges) {
        await verifyBytes(part.bytes.slice(span.range.startByte, span.range.endByteExclusive), span.sha256);
      }
      blobs.set(part.source.sha256, part.bytes);
    }
    blobs.set(manifestHash, encodeRecallManifest(recall.manifest));
  }
  for (const record of records) await verifyBytes(record.bytes, record.sha256);
  const mappings = archives.map(archive => ({
    ruleId: archive.ruleId, removalId: archive.removalId, recallId: archive.recall.id,
    operationKind: archive.operationKind, episodeId: archive.episodeId, title: archive.title,
    sources: archive.recall.manifest.parts,
  })).sort((a, b) => compare(a.ruleId, b.ruleId) || compare(a.removalId, b.removalId));
  const removalKeys = new Map<string, string>();
  for (const mapping of mappings) {
    const key = stableJson([mapping.ruleId, mapping.removalId]);
    const previous = removalKeys.get(key);
    const current = stableJson(mapping);
    if (previous !== undefined && previous !== current) {
      throw new LedgerError("idempotency-conflict", "Conflicting removal identity");
    }
    removalKeys.set(key, current);
  }
  const metadataJson = stableJson({
    archives: [...removalKeys.values()].map((json: string): unknown => JSON.parse(json)),
    appendRecords: records.map(({ recordId, sha256: hash }) => ({ recordId, sha256: hash })),
    sealedEpisodeIds: [...new Set(sealedEpisodeIds)].sort(),
    // A revert application records the approved plan it carried, so the stored
    // intent is auditable against what the host received (ADR-0004). It is
    // hashed only through `applicationSha256`, never a second digest of its own.
    ...(application.mode === "revert" && application.revert !== undefined
      ? { revert: privateCopyJson(application.revert) } : {}),
  });
  const intentHash = await sha256(new TextEncoder().encode(stableJson([
    sessionId, eventId, applicationSha256,
  ])));
  return {
    intent: { intentId: `intent:sha256:${intentHash}`, sessionId, eventId,
      baseRevision, applicationSha256 }, phase, metadataJson, archives, blobs,
  };
}

export async function publishPreparation(preparation: Preparation, store: BlobStore): Promise<void> {
  for (const [hash, bytes] of preparation.blobs) {
    const published = await store.put(new Uint8Array(bytes));
    if (published !== hash) mismatch("Blob store returned an incorrect hash");
    await verifyBytes(new Uint8Array(await store.get(hash)), hash, bytes.byteLength);
  }
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function mismatch(message: string): never { throw new LedgerError("hash-mismatch", message); }

/**
 * A JSON-private copy of the approved revert payload, taken synchronously
 * before the first await: callers retain their objects, and the stored metadata
 * must not change if they mutate one. `stableJson` rejects anything that cannot
 * be encoded, so this only detaches; it never rewrites a value.
 */
function privateCopyJson(value: unknown): unknown {
  return JSON.parse(stableJson(value));
}
