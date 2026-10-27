import {
  buildRecallManifest, encodeRecallManifest, recallIdFor,
} from "../ledger/manifest.js";
import type { RecallManifest, RecallManifestPart, RecallRecord } from "../ledger/manifest.js";
import type { Ledger } from "../ledger/types.js";
import type { Removal } from "../rules/types.js";
import type { RecallId, SessionId, Sha256 } from "../types/identity.js";
import type { CheckContext, Report } from "./context.js";
import { canonicalApplicationBytes, digest, equal } from "./bytes.js";
import { privateCopy } from "./checks-shape.js";

/**
 * One removal's recall identity, computed synchronously.
 *
 * `makeRecall` and the entry-shape planner must agree on the id byte for byte:
 * the planner renders the marker that carries it, and the guard mints the
 * archive under it. One implementation is the only way that agreement cannot
 * drift, so both call here — `digest` is `sha256Sync`, the same digest
 * `manifestSha256` computes asynchronously, so the identity is identical either
 * way and the caller needs no await.
 */
export function recallManifestFor(
  sessionId: SessionId, parts: readonly RecallManifestPart[],
): { readonly manifest: RecallManifest; readonly manifestSha256: Sha256; readonly id: RecallId } {
  const manifest = buildRecallManifest(sessionId, [...parts]);
  const manifestSha256 = digest(encodeRecallManifest(manifest));
  return { manifest, manifestSha256, id: recallIdFor(manifestSha256) };
}

/** The manifest parts one removal's archived bodies and ranges hash to. */
export function recallManifestParts(parts: RecallRecord["parts"]): readonly RecallManifestPart[] {
  return parts.map(part => ({
    source: { ...part.source }, blobSha256: digest(part.bytes),
    removedRanges: part.removedRanges.map(span => ({ range: { ...span.range }, sha256: span.sha256 })),
  }));
}

export async function makeRecall(c: CheckContext, removal: Removal): Promise<RecallRecord> {
  return makeRecallOver(c, removal, null);
}

/**
 * The same archive, banked over an EXPLICIT body instead of the node's current
 * bytes.
 *
 * The entry lane needs this: a shaped turn replaces the landed result, and the
 * plan carries the ORIGINAL body the port held before that. Banking the node's
 * current bytes would store the shaped body and the recall id in its marker
 * would restore the wrong content. Every other lane passes `null` and reads the
 * node, exactly as before.
 */
export async function makeRecallOver(
  c: CheckContext, removal: Removal, override: Uint8Array | null,
): Promise<RecallRecord> {
  const order = [...c.nodes.keys()];
  const sources = [...removal.sources].sort((a, b) =>
    order.indexOf(a.source.nodeId) - order.indexOf(b.source.nodeId));
  const parts = sources.map(s => {
    const node = c.nodes.get(s.source.nodeId);
    if (node === undefined) throw new Error("Unknown archive source");
    const body = override ?? node.bytes;
    return { source: { ...s.source }, bytes: body.slice(), removedRanges: s.ranges.map(range => ({
      range: { ...range }, sha256: digest(body.slice(range.startByte, range.endByteExclusive)),
    })) };
  });
  const { manifest, manifestSha256, id } = recallManifestFor(
    c.value.snapshot.sessionId, recallManifestParts(parts));
  return { id, manifestSha256, manifest, parts };
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
      // No `RecallOptions` here on purpose: this check proves that the *ledger*
      // still holds the evidence's provenance. The source lane (chunk C7) re-reads
      // a mutable file, so letting it answer would turn an edited file into a
      // provenance refusal instead of the banked record it is.
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
