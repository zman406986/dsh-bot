import { capMarker, negativeFact } from "../rules/assets.js";
import type { Note } from "../rules/types.js";
import type { ByteRange, Bytes, LineRange, SourceRef } from "../types/identity.js";
import type { PathEvidence } from "../types/transcript.js";
import { complement, digest, join } from "./bytes.js";
import type { RenderedRecord, Replacement, RetainedCopy } from "./types.js";

export interface RenderSource extends SourceRef { readonly bytes: Bytes }
export interface RecordAssets {
  readonly cap: ReadonlyMap<string, {
    readonly shownLines: LineRange;
    readonly totalLines: number;
    readonly omittedKb: number;
    readonly recallId: string;
  }>;
  readonly negative: ReadonlyMap<string, {
    readonly target: string;
    readonly entries: readonly PathEvidence[];
  }>;
}
export function renderReplacement(
  source: RenderSource, keepRanges: readonly ByteRange[], generatedBytes: Bytes,
): Replacement {
  // A marker occupies each omitted gap. Retained byte arrays are never decoded.
  const omitted = complement(keepRanges, source.bytes.length);
  if (omitted.length > 0 && generatedBytes.length === 0) throw new Error("Omitted gaps require a generated marker");
  const chunks: Bytes[] = [], retainedCopies: RetainedCopy[] = [], generatedRanges: ByteRange[] = [];
  let offset = 0, sourceOffset = 0;
  const generated = (): void => {
    if (generatedBytes.length === 0) return;
    generatedRanges.push({ startByte: offset, endByteExclusive: offset + generatedBytes.length });
    chunks.push(generatedBytes.slice()); offset += generatedBytes.length;
  };
  for (const range of keepRanges) {
    if (range.startByte > sourceOffset) generated();
    const copied = source.bytes.slice(range.startByte, range.endByteExclusive);
    chunks.push(copied);
    retainedCopies.push({ sourceRange: { ...range }, outputRange: {
      startByte: offset, endByteExclusive: offset + copied.length,
    } });
    offset += copied.length; sourceOffset = range.endByteExclusive;
  }
  if (sourceOffset < source.bytes.length || omitted.length === 0) generated();
  const bytes = join(chunks);
  return {
    source: { nodeId: source.nodeId, sha256: source.sha256, byteLength: source.byteLength },
    bytes, sha256: digest(bytes), retainedCopies, generatedRanges, evidenceRecallId: null,
  };
}
export function renderRecords(notes: readonly Note[], assets: RecordAssets): RenderedRecord[] {
  return notes.map(note => {
    let text: string;
    if (note.kind === "cap-marker") {
      const data = assets.cap.get(note.id);
      if (data === undefined) throw new Error(`Missing cap assets for ${note.id}`);
      text = capMarker(data);
    } else if (note.kind === "negative-fact") {
      const data = assets.negative.get(note.id);
      if (data === undefined) throw new Error(`Missing episode assets for ${note.id}`);
      text = negativeFact(data);
    } else throw new Error(`Unsupported M1 record kind: ${note.kind}`);
    const bytes = new TextEncoder().encode(text);
    return { recordId: note.id, bytes, sha256: digest(bytes) };
  });
}
