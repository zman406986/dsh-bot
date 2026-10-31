import { negativeFact } from "../rules/assets.js";
import type { Note } from "../rules/types.js";
import { revertCost } from "../revert/cost.js";
import type { RevertAppend, RevertPlan } from "../revert/types.js";
import type { NodeId, NoteId, UnitId } from "../types/identity.js";
import type { CheckContext } from "./context.js";
import type { RevertApplication } from "./checks-revert.js";
import { join } from "./bytes.js";
import { makeRecall, makeRecallOver } from "./recall.js";
import { renderRecords, renderedNoteId } from "./render.js";
import { renderShapeTurn, shapeTurnMatches } from "./shape-turn.js";
import type { ProofReceiptAssets, ReceiptAssets, RecordAssets } from "./render.js";
import type { ArchiveRecord, RenderedRecord, Replacement } from "./types.js";
import type { RecallRecord } from "../ledger/manifest.js";

type NegativeAssets = RecordAssets["negative"] extends ReadonlyMap<string, infer V> ? V : never;

/** One forgotten unit as the receipt branch renders it: the unit, its node and its receipt. */
interface ForgottenReceipt {
  readonly unitId: UnitId;
  readonly nodeId: NodeId;
  readonly record: RenderedRecord;
}

export interface Candidate {
  readonly replacements: Replacement[];
  readonly appendRecords: RenderedRecord[];
  readonly archives: ArchiveRecord[];
  readonly sealedEpisodeIds: string[];
  readonly expectedGenerated: ReadonlyMap<string, Uint8Array>;
  readonly expectedRecords: ReadonlyMap<string, Uint8Array>;
  /**
   * The checkpoint-revert this candidate applies, or `null` when no verdict
   * removal is in the plan. The guard only approves what it can name here.
   */
  readonly revert: RevertApplication | null;
}
export async function buildCandidate(c: CheckContext): Promise<Candidate> {
  const replacements: Replacement[] = [], appendRecords: RenderedRecord[] = [], archives: ArchiveRecord[] = [];
  const sealedEpisodeIds: string[] = [];
  const expectedGenerated = new Map<string, Uint8Array>(), expectedRecords = new Map<string, Uint8Array>();
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  const forgotten = new Map<NoteId, ForgottenReceipt>();
  for (const plan of c.value.plans) for (const op of plan.operations) {
    const originalNote = plan.notes.find(n => n.id === op.noteId);
    if (originalNote === undefined) throw new Error("Missing checked note");
    const note: Note = { ...originalNote, id: renderedNoteId(c.value, plan.ruleId, originalNote.id) };
    const negative = new Map<string, NegativeAssets>();
    // The entry-time cap has no materialization arm: ADR-0014 (2026-10-23)
    // scrapped it. A `cap` operation falls through to the unsupported-operation
    // refusal below, so no rule can put an in-place rewrite on the path.
    if (op.kind === "shape") {
      // A shaped entry, landed-node contract (ISSUE-056 chunk C4, reworked by
      // ISSUE-058 chunk P3b; ADR-0022 §12–§13). The answer judged a result that
      // already landed; applying it rewinds past that result's turn and appends
      // ONE new turn. So this arm carries the new turn's bytes as the
      // replacement of the landed node and banks the ORIGINAL body the port
      // holds — never the shaped one — so recall is byte-exact.
      //
      // The op states everything: `unitId`, `keptRanges` over `originalBytes`,
      // and the exact `replacementBytes`. This arm turns those claims into the
      // candidate and decides nothing: no range, no marker byte, no recall id.
      const removal = plan.removals.find(r => r.id === op.removalId), source = removal?.sources[0];
      const node = source === undefined ? undefined : c.nodes.get(source.source.nodeId);
      if (removal === undefined || source === undefined || node === undefined || node.kind !== "tool-result") {
        throw new Error("Missing checked shape source");
      }
      // The landed result is the entry event's own node. A shape never addresses
      // another node: the answer was about the result immediately above the ask.
      if (c.value.input.kind !== "entry" || c.value.input.result.id !== node.id) {
        throw new Error("A shape operation applies only to the landed entry result");
      }
      const original = op.originalBytes;
      const turn = renderShapeTurn({ source: source.source, original,
        keptRanges: op.keptRanges, sessionId: c.value.snapshot.sessionId });
      if (turn === null || !shapeTurnMatches(turn, op.replacementBytes)) {
        throw new Error("A shape's replacement bytes differ from its plan");
      }
      const recall = await makeRecallOver(c, removal, original);
      // The archive kind vocabulary is the durable schema's (ledger/schema.ts
      // admits seven kinds and this chunk may not widen it): a shaped entry is
      // recorded as the agent decision it is, and the row's own `ruleId`
      // (`entry-shape`) names the lane precisely.
      archives.push({ ruleId: plan.ruleId, removalId: removal.id, operationKind: "verdict",
        episodeId: null, title: removal.title, recall });
      // The guard compares the JOINED generated ranges against this value, so
      // the expectation is the marker once per dropped gap — one slice of the
      // turn per gap, which is exactly what the renderer placed.
      const markerBytes = join(turn.generatedRanges.map(range =>
        turn.bytes.slice(range.startByte, range.endByteExclusive)));
      expectedGenerated.set(node.id, markerBytes);
      replacements.push({ source: { ...source.source }, bytes: turn.bytes.slice(),
        sha256: turn.sha256, retainedCopies: turn.retainedCopies.map(copy => ({ ...copy })),
        generatedRanges: turn.generatedRanges.map(range => ({ ...range })),
        evidenceRecallId: recall.id });
    } else if (op.kind === "seal" && op.mode === "append") {
      const episode = c.episodes.find(e => e.id === op.episodeId);
      if (episode === undefined) throw new Error("Missing checked episode");
      const data = { target: episode.target.label, entries: episode.paths.filter(p => p.outcome === "miss") };
      negative.set(note.id, data);
      const rendered = renderRecords([note], { negative, receipt: new Map() })[0];
      if (rendered === undefined) throw new Error("Missing negative fact");
      appendRecords.push(rendered);
      expectedRecords.set(note.id, encode(negativeFact(data)));
      sealedEpisodeIds.push(episode.id);
    } else if (op.kind === "verdict" || op.kind === "proof") {
      // A verdict or proof removal is never rewritten in place: the unit's bytes
      // leave the transcript and one receipt takes their place (design-protocol
      // §2; ADR-0018 §2). A proof burn differs only in what its receipt says —
      // path, ranges and recall id, no descriptor — and in the archive kind.
      const removal = plan.removals.find(r => r.id === op.removalId), source = removal?.sources[0];
      const node = source === undefined ? undefined : c.nodes.get(source.source.nodeId);
      if (removal === undefined || source === undefined || node === undefined || node.kind !== "tool-result") {
        throw new Error("Missing checked verdict source");
      }
      if (forgotten.has(node.id)) throw new Error("Two reverted removals share one node");
      const recall = await makeRecall(c, removal);
      archives.push({ ruleId: plan.ruleId, removalId: removal.id, operationKind: op.kind,
        episodeId: null, title: removal.title, recall });
      const rendered = op.kind === "verdict"
        ? renderVerdictReceipt(note, recall)
        : renderProofReceipt(note, recall);
      appendRecords.push(rendered);
      expectedRecords.set(rendered.recordId, rendered.bytes);
      forgotten.set(node.id, { unitId: op.unitId, nodeId: node.id, record: rendered });
    } else throw new Error("Unsupported operation reached the renderer");
  }
  return { replacements, appendRecords, archives, sealedEpisodeIds, expectedGenerated, expectedRecords,
    revert: planRevert(c, forgotten) };
}

/** The receipt line a forgotten unit leaves: path, ranges, optional label, recall id. */
function renderVerdictReceipt(note: Note, recall: RecallRecord): RenderedRecord {
  if (note.kind !== "receipt") throw new Error("A verdict operation requires a receipt note");
  const receipt: ReceiptAssets = { path: note.path, ranges: note.ranges, label: note.label,
    recallId: recall.id };
  const rendered = renderRecords([note], {
    negative: new Map(), receipt: new Map<string, ReceiptAssets>([[note.id, receipt]]),
  })[0];
  if (rendered === undefined) throw new Error("Missing verdict receipt");
  return rendered;
}

/**
 * A proof burn's receipt: the same line shape with no descriptor at all. The
 * note has no label slot, so nothing can be described into the line (ADR-0018).
 */
function renderProofReceipt(note: Note, recall: RecallRecord): RenderedRecord {
  if (note.kind !== "proof-receipt") throw new Error("A proof operation requires a proof receipt note");
  const receipt: ProofReceiptAssets = { path: note.path, ranges: note.ranges, recallId: recall.id };
  const rendered = renderRecords([note], {
    negative: new Map(), receipt: new Map(),
    proof: new Map<string, ProofReceiptAssets>([[note.id, receipt]]),
  })[0];
  if (rendered === undefined) throw new Error("Missing proof receipt");
  return rendered;
}

/**
 * The revert a verdict batch applies (design-protocol §2, §4; PRD §6.4).
 *
 * Per-unit application skips the cut chooser: the cut is the earliest forgotten
 * unit's own node index ("revert to just before the read"), so every forgotten
 * node lies in one contiguous rebuilt suffix and one revert covers the batch.
 * The cost is the §2 arithmetic for that cut; the chooser's freed-byte floor and
 * positive-net filters belong to the full-revisit cut, where the cut is chosen
 * rather than dictated by a verdict. `netFreedBytes` prices ONE request — freed
 * minus the kept suffix re-sent minus the receipt — while the standing delta is
 * freed − receipt, so a verdict's dictated cut may price negative for one request
 * and still shrink every later one (ISSUE-083).
 *
 * Each receipt anchors to the survivor before it, and the first one anchors to
 * the prefix tail `nodes[cutIndex - 1]` so no receipt lands before the salvage;
 * only a cut at the transcript head anchors at `null`.
 */
function planRevert(c: CheckContext, forgotten: ReadonlyMap<NoteId, ForgottenReceipt>): RevertApplication | null {
  if (forgotten.size === 0) return null;
  const nodes = c.value.snapshot.nodes;
  const ordered: { readonly index: number; readonly entry: ForgottenReceipt }[] = [];
  for (const [nodeId, entry] of forgotten) {
    const index = nodes.findIndex(node => node.id === nodeId);
    if (index < 0) throw new Error("A reverted removal's source left the snapshot");
    ordered.push({ index, entry });
  }
  ordered.sort((a, b) => a.index - b.index);
  const forgottenIndices = new Set(ordered.map(item => item.index));
  const cutIndex = ordered[0]?.index ?? 0;
  const byNode = new Map(ordered.map(item => [nodes[item.index]?.id ?? "", item.entry]));
  const survivors: NodeId[] = [], appends: RevertAppend[] = [];
  let anchor: NodeId | null = cutIndex > 0 ? (nodes[cutIndex - 1]?.id ?? null) : null;
  for (let index = cutIndex; index < nodes.length; index++) {
    const node = nodes[index];
    if (node === undefined) break; // unreachable: index < nodes.length
    const receipt = byNode.get(node.id);
    if (receipt === undefined) { survivors.push(node.id); anchor = node.id; continue; }
    appends.push({ afterNodeId: anchor, noteId: receipt.record.recordId });
  }
  const cost = revertCost({
    nodes: nodes.map(node => ({ id: node.id, nodeId: node.id, byteLength: node.bytes.length })),
    forgotten: forgottenIndices,
    cutIndex,
    receiptBytes: index => {
      const node = nodes[index];
      return node === undefined ? 0 : (byNode.get(node.id)?.record.bytes.length ?? 0);
    },
  });
  return {
    plan: { cutIndex, survivors, appends, cost, baseRevision: c.value.snapshot.revision },
    unitIds: ordered.map(item => item.entry.unitId),
    receipts: ordered.map(item => item.entry.record),
  };
}
