import type { DatabaseSync } from "node:sqlite";
import type { Preparation } from "./prepare.js";
import { insertImmutable } from "./rows.js";

/** Runs only inside the caller's synchronous SQLite transaction. */
export function commitPreparation(db: DatabaseSync, data: Preparation, atMs: number): void {
  for (const [hash, bytes] of data.blobs) {
    insertImmutable(db, "blobs", { sha256: hash }, {
      sha256: hash, byte_length: bytes.byteLength,
    }, atMs);
  }
  for (const { recall } of data.archives) {
    insertImmutable(db, "recalls", { recall_id: recall.id }, {
      recall_id: recall.id, manifest_sha256: recall.manifestSha256,
    }, atMs);
    recall.manifest.parts.forEach((part, index) => {
      insertImmutable(db, "recall_parts", { recall_id: recall.id, part_index: index }, {
        recall_id: recall.id, part_index: index, source_node_id: part.source.nodeId,
        source_sha256: part.source.sha256, source_byte_length: part.source.byteLength,
        blob_sha256: part.blobSha256,
      });
      part.removedRanges.forEach((span, spanIndex) => {
        insertImmutable(db, "removed_spans", {
          recall_id: recall.id, part_index: index, span_index: spanIndex,
        }, {
          recall_id: recall.id, part_index: index, span_index: spanIndex,
          start_byte: span.range.startByte, end_byte_exclusive: span.range.endByteExclusive,
          slice_sha256: span.sha256,
        });
      });
    });
  }
  const intent = data.intent;
  insertImmutable(db, "applications", { intent_id: intent.intentId }, {
    intent_id: intent.intentId, session_id: intent.sessionId, event_id: intent.eventId,
    base_revision: intent.baseRevision, phase: data.phase,
    application_sha256: intent.applicationSha256, metadata_json: data.metadataJson,
  }, atMs);
  for (const archive of data.archives) {
    insertImmutable(db, "application_removals", {
      intent_id: intent.intentId, rule_id: archive.ruleId, removal_id: archive.removalId,
    }, {
      intent_id: intent.intentId, rule_id: archive.ruleId, removal_id: archive.removalId,
      recall_id: archive.recall.id, operation_kind: archive.operationKind,
      episode_id: archive.episodeId, title: archive.title,
    });
  }
}
