import {
  buildRecallManifest, encodeRecallManifest, manifestSha256, recallIdFor,
} from "../ledger/manifest.js";
import type { Ledger, RecallRecord } from "../ledger/types.js";
import type { Removal } from "../rules/types.js";
import type { CheckContext, Report } from "./context.js";
import { canonicalApplicationBytes, digest, equal } from "./bytes.js";
import { privateCopy } from "./checks-shape.js";

export async function makeRecall(c: CheckContext, removal: Removal): Promise<RecallRecord> {
  const order = [...c.nodes.keys()];
  const sources = [...removal.sources].sort((a, b) =>
    order.indexOf(a.source.nodeId) - order.indexOf(b.source.nodeId));
  const parts = sources.map(s => {
    const node = c.nodes.get(s.source.nodeId);
    if (node === undefined) throw new Error("Unknown archive source");
    return { source: { ...s.source }, bytes: node.bytes.slice(), removedRanges: s.ranges.map(range => ({
      range: { ...range }, sha256: digest(node.bytes.slice(range.startByte, range.endByteExclusive)),
    })) };
  });
  const manifest = buildRecallManifest(c.value.snapshot.sessionId, parts.map(p => ({
    source: p.source, blobSha256: digest(p.bytes), removedRanges: p.removedRanges,
  })));
  const hash = await manifestSha256(manifest);
  return { id: recallIdFor(hash), manifestSha256: hash, manifest, parts };
}
export function checkRecall(record: RecallRecord, sessionId: string, report: Report): void {
  try {
    if (record.manifest.sessionId !== sessionId) {
      report("wrong-session", "Recall manifest belongs to another session");
    }
    const hash = digest(encodeRecallManifest(record.manifest));
    if (hash !== record.manifestSha256 || record.id !== recallIdFor(hash)) throw new Error("Manifest identity differs");
    const fromParts = buildRecallManifest(sessionId, record.parts.map(part => ({
      source: part.source, blobSha256: digest(part.bytes), removedRanges: part.removedRanges,
    })));
    if (!equal(canonicalApplicationBytes(fromParts), canonicalApplicationBytes(record.manifest))) {
      throw new Error("Parts differ from manifest");
    }
    for (const part of record.parts) {
      if (part.bytes.length !== part.source.byteLength || digest(part.bytes) !== part.source.sha256) {
        throw new Error("Full archived body differs from source");
      }
      for (const span of part.removedRanges) {
        if (digest(part.bytes.slice(span.range.startByte, span.range.endByteExclusive)) !== span.sha256) {
          throw new Error("Archived removed range hash differs");
        }
      }
    }
  } catch (error) {
    report("recall-manifest-mismatch", error instanceof Error ? error.message : "Invalid recall manifest");
  }
}
export async function checkEvidenceRecalls(c: CheckContext, ledger: Ledger, report: Report): Promise<void> {
  const relevant = new Set(c.value.plans.flatMap(plan => plan.operations.flatMap(op =>
    op.kind === "seal" ? c.episodes.find(e => e.id === op.episodeId)?.memberNodeIds ?? [] : [])));
  for (const id of relevant) {
    const node = c.nodes.get(id);
    if (node === undefined || node.kind !== "tool-result") continue;
    const evidence = node.evidence;
    if (evidence.sourceRecallId === null) {
      if (evidence.source.nodeId !== node.id || evidence.source.sha256 !== node.sha256
        || evidence.source.byteLength !== node.bytes.length) {
        report("episode-evidence-missing", "Evidence does not identify the observed result bytes", node.id);
      }
      continue;
    }
    try {
      const recall = privateCopy(await ledger.recall(evidence.sourceRecallId));
      checkRecall(recall, c.value.snapshot.sessionId, report);
      const part = recall.parts.find(p => p.source.nodeId === node.id);
      if (recall.id !== evidence.sourceRecallId || part === undefined
        || !equal(canonicalApplicationBytes(part.source), canonicalApplicationBytes(evidence.source))) {
        report("recall-manifest-mismatch", "Evidence provenance is absent from its recall", node.id);
      }
    } catch {
      report("recall-manifest-mismatch", "Evidence recall is unavailable or invalid", node.id);
    }
  }
}
