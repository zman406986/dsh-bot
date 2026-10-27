import type { RevertAppend, RevertPlan } from "../revert/types.js";
import { revertCost } from "../revert/cost.js";
import type { TranscriptNode } from "../types/transcript.js";
import type { UnitId } from "../types/identity.js";
import type { Candidate } from "./candidate.js";
import type { CheckContext, Report } from "./context.js";
import { reporter } from "./context.js";
import { renderedNoteId } from "./render.js";
import type { RenderedRecord } from "./types.js";

/**
 * What the guard approved for one verdict application: the host-facing plan,
 * the units it settles and the rendered receipts its appends name.
 */
export interface RevertApplication {
  readonly plan: RevertPlan;
  readonly unitIds: readonly UnitId[];
  readonly receipts: readonly RenderedRecord[];
}

interface ForgottenUnit {
  readonly index: number;
  readonly unitId: UnitId;
  readonly receipt: RenderedRecord;
}

/**
 * The final audit of a checkpoint-revert (design-protocol §2, §4, §5 Slice 3).
 *
 * A revert plan is a claim about the transcript, so the guard re-derives every
 * claim from the snapshot and the plans rather than trusting the planner:
 *
 * - the cut falls on a forgotten node, no declared verdict removal lies before
 *   it, and the forgotten indices at or after it are contiguous with the
 *   rebuilt suffix (`invalid-plan`, `unaccounted-removal`);
 * - survivors are exactly the nodes after the cut minus the forgotten ones, in
 *   transcript order (`invalid-plan`);
 * - one receipt anchors per forgotten node, at the nearest survivor before it
 *   or the prefix tail for the first one (`invalid-note`, `adjacency-changed`);
 * - the cost is the §2 arithmetic for that cut, present, integral and
 *   non-negative (`invalid-plan`);
 * - `unitIds` names the forgotten units in transcript order (`invalid-plan`).
 *
 * The watermark fence is `checkSources`': a removal below the fresh zone is
 * refused there as `cut-below-watermark` before any candidate is built, because
 * on a verdict event a removal's node index **is** the cut. Keeping one owner
 * for that fact prevents two codes describing the same violation.
 *
 * Nothing here renders, archives or applies; `candidate.ts` built the receipts
 * and `application.ts` seals the plan digest after this check passes.
 */
export function checkRevertApplication(c: CheckContext, candidate: Candidate): void {
  const report = reporter(c, null, null);
  const revert = candidate.revert;
  if (revert === null) {
    report("invalid-plan", "A verdict application carries no revert plan");
    return;
  }
  const nodes = c.value.snapshot.nodes;
  const plan = revert.plan;
  if (!Number.isSafeInteger(plan.cutIndex) || plan.cutIndex < 0 || plan.cutIndex > nodes.length) {
    report("invalid-plan", "A revert cut must name a node boundary inside the transcript");
    return;
  }
  if (plan.baseRevision !== c.value.snapshot.revision) {
    report("stale-revision",
      `Revert plan revision ${plan.baseRevision} differs from snapshot ${c.value.snapshot.revision}`);
  }
  const forgotten = forgottenUnits(c, candidate, report);
  if (forgotten === null) return;

  // A cut that does not land on a forgotten node frees nothing it claims to.
  if (!forgotten.has(plan.cutIndex)) {
    report("invalid-plan", "A revert cut must fall on a forgotten node");
  }
  for (const index of forgotten.keys()) {
    if (index >= plan.cutIndex) continue;
    report("unaccounted-removal",
      "A declared verdict removal lies before the cut and would not be applied", nodeIdAt(nodes, index));
  }

  const expectedSurvivors = nodes.slice(plan.cutIndex)
    .filter((_, offset) => !forgotten.has(plan.cutIndex + offset))
    .map(node => node.id);
  if (!sameIds(plan.survivors, expectedSurvivors)) {
    report("invalid-plan", "Survivors differ from the nodes after the cut minus the forgotten ones");
  }
  checkAppends(nodes, plan, forgotten, candidate, report);
  checkCost(plan, forgotten, nodes, report);
  const expectedUnits = [...forgotten.entries()].sort((a, b) => a[0] - b[0]).map(([, unit]) => unit.unitId);
  if (!sameIds(revert.unitIds, expectedUnits)) {
    report("invalid-plan", "Approved unit ids differ from the forgotten units in transcript order");
  }
}

/**
 * Maps each reverted node index to its unit and rendered receipt. The verdict
 * and proof plans are the only sources of removals on such an event;
 * `checkVerdicts` and `checkProofs` have already proven each removal is exactly
 * one unit's span.
 *
 * The candidate renames a note id to its rendered record id, so the lookup key
 * is that derived id, never the plan's own note id.
 */
function forgottenUnits(
  c: CheckContext, candidate: Candidate, report: Report,
): ReadonlyMap<number, ForgottenUnit> | null {
  const receipts = new Map(candidate.revert?.receipts.map(record => [record.recordId, record]) ?? []);
  const nodes = c.value.snapshot.nodes;
  const result = new Map<number, ForgottenUnit>();
  for (const plan of c.value.plans) for (const op of plan.operations) {
    if (op.kind !== "verdict" && op.kind !== "proof") continue;
    const removal = plan.removals.find(candidate => candidate.id === op.removalId);
    const source = removal?.sources[0];
    const index = source === undefined ? -1 : nodes.findIndex(node => node.id === source.source.nodeId);
    const receipt = receipts.get(renderedNoteId(c.value, plan.ruleId, op.noteId));
    if (source === undefined || index < 0 || receipt === undefined) {
      report("invalid-note", `A ${op.kind} removal lacks its node or its rendered receipt`, source?.source.nodeId ?? null);
      return null;
    }
    if (result.has(index)) {
      report("invalid-plan", "Two reverted units share one node; a revert anchors one receipt per node",
        nodes[index]?.id ?? null);
      return null;
    }
    result.set(index, { index, unitId: op.unitId, receipt });
  }
  return result;
}

/**
 * One append per forgotten node at or after the cut, anchored to the nearest
 * survivor before it; the first anchor is the prefix tail `nodes[cutIndex-1]`,
 * and only a head cut anchors at `null` (design-protocol §4, PM seam ruling).
 * The expected anchors are re-derived here, not read back from the plan.
 */
function checkAppends(
  nodes: readonly TranscriptNode[], plan: RevertPlan, forgotten: ReadonlyMap<number, ForgottenUnit>,
  candidate: Candidate, report: Report,
): void {
  const expected: RevertAppend[] = [];
  let anchor: string | null = plan.cutIndex > 0 ? (nodes[plan.cutIndex - 1]?.id ?? null) : null;
  for (let index = plan.cutIndex; index < nodes.length; index++) {
    const node = nodes[index], unit = forgotten.get(index);
    if (node === undefined) break; // unreachable: index < nodes.length
    if (unit === undefined) { anchor = node.id; continue; }
    expected.push({ afterNodeId: anchor, noteId: unit.receipt.recordId });
  }
  const rendered = new Set(candidate.appendRecords.map(record => record.recordId));
  for (const append of plan.appends) {
    if (!rendered.has(append.noteId)) {
      report("invalid-note", "A revert append names no rendered receipt record", append.afterNodeId);
    }
  }
  if (!sameIds(plan.appends.map(append => append.noteId), expected.map(append => append.noteId))) {
    report("invalid-note", "A revert plan must anchor exactly one receipt per forgotten node after the cut");
    return;
  }
  if (!sameIds(plan.appends.map(append => append.afterNodeId ?? ""),
    expected.map(append => append.afterNodeId ?? ""))) {
    report("adjacency-changed",
      "Receipt anchors differ from the survivors and prefix tail the cut leaves in place");
  }
}

/**
 * The §2 arithmetic, recomputed from the snapshot and the rendered receipts.
 * The plan's own numbers must match it field for field; a hand-edited cost
 * would otherwise let a host apply a cut the planner never chose.
 *
 * The chooser's `freed >= minCutFreedBytes` and `net > 0` filters are **not**
 * re-applied: they select a cut for the full revisit, while a per-unit verdict
 * reverts to just before the read and may legitimately free a small span
 * (ledger `application-integrity.ts` states the same rule). Only the identity
 * `net = freed − kept − receipt` is enforced.
 */
function checkCost(
  plan: RevertPlan, forgotten: ReadonlyMap<number, ForgottenUnit>,
  nodes: readonly TranscriptNode[], report: Report,
): void {
  const cost: unknown = plan.cost;
  if (typeof cost !== "object" || cost === null) {
    report("invalid-plan", "A revert plan must carry a cost");
    return;
  }
  const fields = cost as Readonly<Record<string, unknown>>;
  for (const key of ["cutIndex", "freedBytes", "keptBytes", "receiptBytes", "netFreedBytes"]) {
    if (typeof fields[key] !== "number" || !Number.isSafeInteger(fields[key])) {
      report("invalid-plan", `A revert cost must carry an integral ${key}`);
      return;
    }
  }
  for (const key of ["freedBytes", "keptBytes", "receiptBytes"]) {
    if ((fields[key] as number) < 0) {
      report("invalid-plan", `A revert cost must not carry a negative ${key}`);
      return;
    }
  }
  if (fields["cutIndex"] !== plan.cutIndex) {
    report("invalid-plan", "A revert cost must describe the plan's own cut");
  }
  const computed = revertCost({
    nodes: nodes.map(node => ({ id: node.id, nodeId: node.id, byteLength: node.bytes.length })),
    forgotten: new Set(forgotten.keys()),
    cutIndex: plan.cutIndex,
    receiptBytes: index => forgotten.get(index)?.receipt.bytes.length ?? 0,
  });
  if (computed.freedBytes !== fields["freedBytes"] || computed.keptBytes !== fields["keptBytes"]
    || computed.receiptBytes !== fields["receiptBytes"]
    || computed.netFreedBytes !== fields["netFreedBytes"]) {
    report("invalid-plan", "A revert cost differs from the byte arithmetic for its cut");
  }
}

function nodeIdAt(nodes: readonly TranscriptNode[], index: number): string | null {
  return nodes[index]?.id ?? null;
}
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
