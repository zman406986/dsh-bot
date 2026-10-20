import { capMarker, negativeFact } from "../rules/assets.js";
import type { Note } from "../rules/types.js";
import { digest, lineRanges } from "./bytes.js";
import type { CheckContext } from "./context.js";
import { makeRecall } from "./recall.js";
import { renderRecords, renderReplacement } from "./render.js";
import type { RecordAssets } from "./render.js";
import type { ArchiveRecord, RenderedRecord, Replacement } from "./types.js";

type CapAssets = RecordAssets["cap"] extends ReadonlyMap<string, infer V> ? V : never;
type NegativeAssets = RecordAssets["negative"] extends ReadonlyMap<string, infer V> ? V : never;
export interface Candidate {
  readonly replacements: Replacement[];
  readonly appendRecords: RenderedRecord[];
  readonly archives: ArchiveRecord[];
  readonly sealedEpisodeIds: string[];
  readonly expectedGenerated: ReadonlyMap<string, Uint8Array>;
  readonly expectedRecords: ReadonlyMap<string, Uint8Array>;
}
export async function buildCandidate(c: CheckContext): Promise<Candidate> {
  const replacements: Replacement[] = [], appendRecords: RenderedRecord[] = [], archives: ArchiveRecord[] = [];
  const sealedEpisodeIds: string[] = [];
  const expectedGenerated = new Map<string, Uint8Array>(), expectedRecords = new Map<string, Uint8Array>();
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  for (const plan of c.value.plans) for (const op of plan.operations) {
    const originalNote = plan.notes.find(n => n.id === op.noteId);
    if (originalNote === undefined) throw new Error("Missing checked note");
    const note: Note = { ...originalNote, id: `racoons:${digest(encode(JSON.stringify([
      c.value.snapshot.sessionId, c.value.input.eventId, plan.ruleId, originalNote.id,
    ])))}` };
    const cap = new Map<string, CapAssets>(), negative = new Map<string, NegativeAssets>();
    if (op.kind === "cap") {
      const removal = plan.removals.find(r => r.id === op.removalId), source = removal?.sources[0];
      const node = source === undefined ? undefined : c.nodes.get(source.source.nodeId);
      if (removal === undefined || source === undefined || node === undefined || node.kind !== "tool-result") {
        throw new Error("Missing checked cap source");
      }
      const recall = await makeRecall(c, removal);
      archives.push({ ruleId: plan.ruleId, removalId: removal.id, operationKind: "cap",
        episodeId: null, title: removal.title, recall });
      const data = {
        shownLines: { startLine: 1, endLineInclusive: lineRanges(node.bytes.slice(0, op.keepHeadEndByte)).length },
        totalLines: lineRanges(node.bytes).length,
        omittedKb: (node.bytes.length - op.keepHeadEndByte) / 1024,
        recallId: recall.id,
      };
      cap.set(note.id, data);
      const rendered = renderRecords([note], { cap, negative })[0];
      if (rendered === undefined) throw new Error("Missing cap record");
      expectedGenerated.set(node.id, encode(capMarker(data)));
      const replacement = renderReplacement({ nodeId: node.id, sha256: node.sha256,
        byteLength: node.bytes.length, bytes: node.bytes },
      op.keepHeadEndByte === 0 ? [] : [{ startByte: 0, endByteExclusive: op.keepHeadEndByte }], rendered.bytes);
      replacements.push({ ...replacement, evidenceRecallId: recall.id });
    } else if (op.kind === "seal" && op.mode === "append") {
      const episode = c.episodes.find(e => e.id === op.episodeId);
      if (episode === undefined) throw new Error("Missing checked episode");
      const data = { target: episode.target.label, entries: episode.paths.filter(p => p.outcome === "miss") };
      negative.set(note.id, data);
      const rendered = renderRecords([note], { cap, negative })[0];
      if (rendered === undefined) throw new Error("Missing negative fact");
      appendRecords.push(rendered);
      expectedRecords.set(note.id, encode(negativeFact(data)));
      sealedEpisodeIds.push(episode.id);
    } else throw new Error("Deferred operation reached M1 renderer");
  }
  return { replacements, appendRecords, archives, sealedEpisodeIds, expectedGenerated, expectedRecords };
}
