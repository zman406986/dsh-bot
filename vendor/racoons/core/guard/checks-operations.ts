import type { Note, Operation, Removal, RulePlan } from "../rules/types.js";
import type { ByteRange } from "../types/identity.js";
import { complement, lineRanges, sameRanges } from "./bytes.js";
import type { CheckContext, Report } from "./context.js";
import { reporter } from "./context.js";
import { checkEpisode } from "./checks-episodes.js";

function checkCap(c: CheckContext, op: Extract<Operation, { kind: "cap" }>, removal: Removal | undefined, report: Report): void {
  if (c.value.input.kind !== "entry" || !c.value.capabilities.mutateResult) {
    report("unsupported-capability", "Cap requires the entry result mutation seam");
  }
  if (removal === undefined || removal.sources.length !== 1) {
    report("invalid-plan", "Cap requires exactly one source"); return;
  }
  const source = removal.sources[0];
  if (source === undefined) return;
  const node = c.nodes.get(source.source.nodeId);
  if (node === undefined) return;
  if (node.kind !== "tool-result") report("invalid-plan", "Cap source must be a tool-result body", node.id);
  const head = op.keepHeadEndByte;
  if (!Number.isSafeInteger(head) || head < 0 || head >= node.bytes.length) {
    report("invalid-range", "Cap head must be an integral offset before the source end", node.id); return;
  }
  const configured = c.value.config.thresholds.capHeadBytes;
  const boundary = configured === null ? undefined
    : lineRanges(node.bytes).find(line => line.endByteExclusive >= configured);
  if (node.bytes.length <= c.value.config.thresholds.capBytes
    || boundary === undefined || head !== boundary.endByteExclusive) {
    report("invalid-plan", "Cap threshold or configured whole-line head policy is not satisfied", node.id);
  }
  if (!sameRanges(source.ranges, [{ startByte: head, endByteExclusive: node.bytes.length }])) {
    report("unaccounted-removal", "Declared cap removal differs from the complement of its retained head", node.id);
  }
}
function checkSpan(c: CheckContext, op: Extract<Operation, { kind: "span" }>, removal: Removal | undefined, report: Report): void {
  const source = removal?.sources[0], node = source === undefined ? undefined : c.nodes.get(source.source.nodeId);
  if (removal?.sources.length !== 1 || node === undefined || node.kind !== "tool-result") {
    report("invalid-line-range", "Span requires exactly one line-addressable tool result"); return;
  }
  const lines = lineRanges(node.bytes);
  let last = 0;
  const keep: ByteRange[] = [];
  for (const range of op.keepLines) {
    if (!Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLineInclusive)
      || range.startLine <= last || range.endLineInclusive < range.startLine
      || range.endLineInclusive > lines.length) {
      report("invalid-line-range", "Retained line ranges must be ordered, bounded and nonoverlapping", node.id); return;
    }
    const start = lines[range.startLine - 1], end = lines[range.endLineInclusive - 1];
    if (start !== undefined && end !== undefined) keep.push({ startByte: start.startByte, endByteExclusive: end.endByteExclusive });
    last = range.endLineInclusive;
  }
  const certified = c.value.snapshot.retentionEvidence.some(e => e.source.nodeId === node.id
    && e.source.sha256 === node.sha256 && e.source.byteLength === node.bytes.length
    && e.witnessNodeIds.length > 0 && e.witnessNodeIds.every(id => c.nodes.has(id))
    && e.keepLines.length === op.keepLines.length && e.keepLines.every((r, i) =>
      r.startLine === op.keepLines[i]?.startLine && r.endLineInclusive === op.keepLines[i]?.endLineInclusive));
  if (!certified) report("invalid-line-range", "Retained lines lack authoritative retention evidence", node.id);
  if (source !== undefined && !sameRanges(source.ranges, complement(keep, node.bytes.length))) {
    report("unaccounted-removal", "Span removals differ from the complement of certified lines", node.id);
  }
}
function noteMatches(note: Note, op: Operation): boolean {
  switch (op.kind) {
    case "cap": return note.kind === "cap-marker" && note.removalId === op.removalId;
    case "seal": return note.kind === "negative-fact" && note.episodeId === op.episodeId;
    case "evict": return note.kind === "evict-marker" && note.removalId === op.removalId && note.episodeId === op.episodeId;
    case "span": return note.kind === "span-marker" && note.removalId === op.removalId
      && note.keepLines.length === op.keepLines.length && note.keepLines.every((r, i) =>
        r.startLine === op.keepLines[i]?.startLine && r.endLineInclusive === op.keepLines[i]?.endLineInclusive);
  }
}
export function checkOperations(c: CheckContext, plans: readonly RulePlan[]): void {
  const ruleIds = new Set<string>(), episodeIds = new Set<string>();
  for (const plan of plans) {
    const planReport = reporter(c, plan.ruleId, null);
    if (ruleIds.has(plan.ruleId)) planReport("conflicting-operations", "Rule returned more than one plan");
    ruleIds.add(plan.ruleId);
    const usedRemovals = new Set<string>(), usedNotes = new Set<string>();
    if (new Set(plan.notes.map(n => n.id)).size !== plan.notes.length) planReport("invalid-note", "Duplicate note IDs");
    plan.operations.forEach((op, index) => {
      const report = reporter(c, plan.ruleId, index);
      if (plan.ruleId !== op.kind) report("wrong-rule", `Rule ${plan.ruleId} cannot issue a ${op.kind} operation`);
      const note = plan.notes.find(n => n.id === op.noteId);
      if (note === undefined || !noteMatches(note, op) || usedNotes.has(op.noteId)) {
        report("invalid-note", "Operation requires one matching, uniquely consumed structured note");
      }
      usedNotes.add(op.noteId);
      const removal = op.removalId === null ? undefined : plan.removals.find(r => r.id === op.removalId);
      if (op.removalId !== null) {
        if (removal === undefined) report("unaccounted-removal", "Operation references an undeclared removal");
        if (usedRemovals.has(op.removalId)) report("conflicting-operations", "Removal is consumed by multiple operations");
        usedRemovals.add(op.removalId);
      }
      if (op.kind === "cap") checkCap(c, op, removal, report);
      if (op.kind === "span") checkSpan(c, op, removal, report);
      if (op.kind === "seal" || op.kind === "evict") {
        if (episodeIds.has(op.episodeId)) report("conflicting-operations", "Episode has multiple operations in one application");
        episodeIds.add(op.episodeId);
        checkEpisode(c, op, removal, report);
      }
      if (op.kind === "seal" && op.mode === "append") {
        if (op.removalId !== null) report("unaccounted-removal", "Append seal must contribute no removal");
        if (c.value.input.kind !== "at-rest" || !c.value.capabilities.atRest || !c.value.capabilities.appendRecords
          || c.value.config.sealMode !== "append") {
          report("unsupported-capability", "Append seal requires configured append mode and an at-rest append-record seam");
        }
      }
      if (op.kind === "span" || op.kind === "evict" || (op.kind === "seal" && op.mode === "replace")) {
        report("unsupported-capability", "M1 rejects span, evict, replace, rewrite and rehydrate operations");
      }
    });
    for (const removal of plan.removals) if (!usedRemovals.has(removal.id)) {
      planReport("unused-removal", `Declared removal ${removal.id} is not used by an operation`);
    }
    for (const note of plan.notes) if (!usedNotes.has(note.id)) {
      planReport("invalid-note", `Note ${note.id} is not consumed by an operation`);
    }
  }
}
