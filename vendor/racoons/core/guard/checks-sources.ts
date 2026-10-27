import type { RulePlan } from "../rules/types.js";
import { digest, overlaps, validRange } from "./bytes.js";
import { reporter } from "./context.js";
import type { CheckContext, DeclaredRange } from "./context.js";

export function checkSources(c: CheckContext, plans: readonly RulePlan[]): void {
  const all: DeclaredRange[] = [];
  const ownership = new Map<string, string>();
  // On a verdict event a removal's node index *is* the revert cut: the card
  // `candidate.ts` applies reverts to just before the read. A removal below the
  // watermark is therefore a cut below it, and it is refused here before any
  // candidate is built (design-protocol §3; the fence is the cut rule). A proof
  // removal travels the same lane and cuts at its own node index (ADR-0018 §6),
  // so it is fenced identically and speaks the cut's name.
  const cuts = new Map<string, string>(plans.flatMap(plan => plan.operations.flatMap(op =>
    op.kind === "verdict" || op.kind === "proof" ? [[op.removalId, op.kind] as const] : [])));
  for (const plan of plans) {
    const report = reporter(c, plan.ruleId, null);
    if (plan.baseRevision !== c.value.snapshot.revision) {
      report("stale-revision", `Plan revision ${plan.baseRevision} differs from snapshot ${c.value.snapshot.revision}`);
    }
    const removalIds = new Set<string>();
    for (const removal of plan.removals) {
      if (removalIds.has(removal.id) || removal.sources.length === 0) {
        report("invalid-plan", `Removal ${removal.id} is duplicated or has no sources`);
      }
      removalIds.add(removal.id);
      const sourceIds = new Set<string>();
      for (const removed of removal.sources) {
        const ref = removed.source, node = c.nodes.get(ref.nodeId);
        if (sourceIds.has(ref.nodeId)) report("invalid-plan", `Duplicate source in removal ${removal.id}`, ref.nodeId);
        sourceIds.add(ref.nodeId);
        if (node === undefined) { report("unknown-source", "Removal names no authoritative node", ref.nodeId); continue; }
        if (ref.sha256 !== node.sha256 || ref.sha256 !== digest(node.bytes)) {
          report("source-hash-mismatch", "Declared source hash differs from authoritative bytes", node.id);
        }
        if (ref.byteLength !== node.bytes.length || node.byteLength !== node.bytes.length) {
          report("source-length-mismatch", "Declared source length differs from authoritative byte length", node.id);
        }
        if (removed.ranges.length === 0) report("invalid-range", "Removal contains no byte ranges", node.id);
        let lastStart = -1;
        for (const range of removed.ranges) {
          if (!validRange(range, node.bytes.length) || range.startByte < lastStart) {
            report("invalid-range", "Removal ranges must be positive, bounded, integral and ordered", node.id);
            continue;
          }
          lastStart = range.startByte;
          if (all.some(prev => prev.nodeId === node.id && overlaps(prev.range, range))) {
            report("overlapping-removals", "Two declared removal ranges overlap", node.id);
          }
          all.push({ nodeId: node.id, range });
          if (c.value.input.kind === "entry") {
            if (node.id !== c.value.input.result.id) {
              report("outside-fresh-zone", "Entry application may replace only the incoming result", node.id);
            }
          } else {
            const index = c.value.snapshot.nodes.findIndex(n => n.id === node.id);
            const cutKind = cuts.get(removal.id);
            const revertedRemoval = cutKind !== undefined;
            // ADR-0012: the fence is a watermark fence, so a verdict cut is
            // refused only against a real warm watermark. An unknown cache has
            // none, so there is nothing for the cut to violate and it applies.
            // The warm path itself is unchanged; at-rest removals keep the
            // ordinary fresh-zone rule.
            const fenced = revertedRemoval
              ? c.value.snapshot.cache.kind === "warm" && index < c.freshStart
              : index < c.freshStart || index < 0;
            if (fenced) {
              // One fact, one code: a reverted removal's index is its cut, so the
              // same fence speaks the cut's name for it.
              report(revertedRemoval ? "cut-below-watermark" : "outside-fresh-zone",
                revertedRemoval
                  ? `A ${cutKind} removal below the cache watermark would cut below it`
                  : "At-rest removal is below the live fresh-zone fence", node.id);
            }
          }
        }
        const owner = JSON.stringify([plan.ruleId, removal.id]);
        const previous = ownership.get(node.id);
        if (previous !== undefined && previous !== owner) {
          report("conflicting-operations", "Different removals attempt to replace the same node", node.id);
        }
        ownership.set(node.id, owner);
      }
    }
  }
}

export function checkTranscript(c: CheckContext): void {
  const report = reporter(c, null, null);
  const seen = new Set<string>(), calls = new Set<string>(), results = new Set<string>();
  const nodes = [...c.value.snapshot.nodes];
  // The land-first protocol (ISSUE-058 chunk P3a; ADR-0022 §2) means the
  // snapshot normally ALREADY holds the entry event's result: the host wrote it
  // before RACOONS saw the event. Appending it again would report a duplicate
  // id and a doubly-consumed call id — `adjacency-changed` on the honest path —
  // so the event's node joins the walk only when the snapshot lacks that id. A
  // host that has not landed it yet is equally legal and takes the same path.
  if (c.value.input.kind === "entry") {
    const result = c.value.input.result;
    if (!nodes.some(node => node.id === result.id)) nodes.push(result);
  }
  let previousTurn = -1, previousStep = -1;
  for (const node of nodes) {
    if (seen.has(node.id)) report("adjacency-changed", "Duplicate node ID makes transcript order ambiguous", node.id);
    seen.add(node.id);
    if (!node.id.trim() || !Number.isSafeInteger(node.turnOrdinal) || !Number.isSafeInteger(node.stepOrdinal)
      || node.turnOrdinal < previousTurn || node.stepOrdinal < previousStep || node.turnOrdinal < 0 || node.stepOrdinal < 0
      || node.turnOrdinal > c.value.snapshot.currentTurnOrdinal || node.stepOrdinal > c.value.snapshot.currentStepOrdinal) {
      report("adjacency-changed", "Node ordinals are invalid or disagree with transcript order", node.id);
    }
    previousTurn = node.turnOrdinal; previousStep = node.stepOrdinal;
    if (digest(node.bytes) !== node.sha256) report("source-hash-mismatch", "Snapshot hash differs from its bytes", node.id);
    if (node.byteLength !== node.bytes.length) report("source-length-mismatch", "Snapshot length differs from its bytes", node.id);
    if (node.kind === "message") for (const id of node.toolCallIds) {
      if (!id.trim() || calls.has(id)) report("pairing-changed", "Tool call ID is empty or occurs more than once", node.id);
      calls.add(id);
    }
    if (node.kind === "tool-result") {
      if (!calls.has(node.callId) || results.has(node.callId)) {
        report("pairing-changed", "Result lacks a unique preceding call", node.id);
      }
      results.add(node.callId);
      for (const range of node.embeddedRecords) if (!validRange(range, node.bytes.length)) {
        report("invalid-generated-record", "Embedded record range is invalid", node.id);
      }
    }
  }
}
