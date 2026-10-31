import { ENTRY_SHAPE_RULE_ID, PROOF_RULE_IDS } from "../rules/types.js";
import type { Note, Operation, RulePlan } from "../rules/types.js";
import type { CheckContext } from "./context.js";
import { reporter } from "./context.js";
import { checkEpisode } from "./checks-episodes.js";
import { checkShape } from "./checks-entry-shape.js";
import { FORGET_RULE_ID } from "./checks-forget.js";

/**
 * A verdict or proof removal is applied by checkpoint-revert (ADR-0007), never
 * by an in-place rewrite. The flag is absent on hosts that do not declare the
 * seam; absence is a refusal, not an assumption (ADR-0018 §3).
 */
function declaresRevert(c: CheckContext): boolean {
  return c.value.capabilities.revertHistory === true;
}

/**
 * The refusal names the missing seam, never "no application path" (ADR-0018 §5):
 * a supervisor who wants the refused op must first declare a truthful seam.
 */
function namesSeam(what: string): string {
  return `${what} requires the programmatic revert seam`;
}

/**
 * A `proof` op is the one op whose rule id is not its own kind: a proof plan
 * carries the byte fact's own rule id (`stale-read`, `superseded-read`), and the
 * op is admitted only under the rule that names the same fact (ADR-0018 §7).
 * The exemption is this narrow on purpose — every other kind keeps `wrong-rule`
 * exactly as before.
 */
function proofUnderItsRule(plan: RulePlan, op: Operation): boolean {
  return op.kind === "proof"
    && (PROOF_RULE_IDS as readonly string[]).includes(plan.ruleId)
    && plan.ruleId === op.proofKind;
}

/**
 * A manual forget plans under its own rule id but travels the verdict lane's
 * `verdict` operation (PRD §6.2; ISSUE-045 chunk C1): the operation is the one
 * that applies by checkpoint-revert and renders a receipt, and a manual forget
 * is exactly that removal with the human as its source. The pairing is admitted
 * only on a forget event, where `checks-forget` re-derives the request and
 * refuses any plan naming another unit; on every other event the forget rule id
 * is still `wrong-rule` here and `invalid-plan` there.
 */
function forgetUnderItsRule(c: CheckContext, plan: RulePlan, op: Operation): boolean {
  return op.kind === "verdict" && plan.ruleId === FORGET_RULE_ID && c.value.input.kind === "forget";
}

/**
 * A shaped entry plans under `entry-shape` and travels a `shape` operation: the
 * rule id is not the op's kind because the lane is the decision's source, not
 * its mechanism (`cap` said "a size rule chose"; this says "an answer did";
 * ISSUE-056 C5; ADR-0022 §Consequences). The exemption is exactly as narrow as
 * `proofUnderItsRule`: the rule id must be the entry-shape id, and a `shape` op
 * under any other rule — or any other op under this one — stays `wrong-rule`.
 *
 * Under the corrected protocol the op addresses the LANDED result (its unit came
 * in on the mount's stamp) and lands a new turn; the exemption is unchanged
 * because the lane, not the mechanism, is what it admits.
 */
function shapeUnderItsRule(plan: RulePlan, op: Operation): boolean {
  return op.kind === "shape" && plan.ruleId === ENTRY_SHAPE_RULE_ID;
}

// The entry-time cap has no validation branch: ADR-0014 (2026-10-23) scrapped it.
// A `cap` operation is declaration-only in the type vocabulary; no rule the
// product registers emits one, and the candidate builder refuses it.
function noteMatches(note: Note, op: Operation): boolean {
  switch (op.kind) {
    case "cap": return note.kind === "cap-marker" && note.removalId === op.removalId;
    case "seal": return note.kind === "negative-fact" && note.episodeId === op.episodeId;
    // A verdict removal is paired with the receipt that replaces its unit.
    case "verdict": return note.kind === "receipt" && note.removalId === op.removalId
      && note.unitId === op.unitId;
    // A shaped entry is paired with its marker note: the marker is the receipt
    // and names the recall id its archive was minted under (ISSUE-056 chunk C4).
    // The rule-id exemption, the exactness checks and the `op.unitId` binding
    // are chunk C5's, in `guard/checks-entry-shape.ts`.
    case "shape": return note.kind === "shape-marker" && note.removalId === op.removalId;
    // A proof removal is paired with its proof receipt, and the receipt's own
    // byte fact must be the op's (ADR-0018). C4 re-derives the burn itself.
    case "proof": return note.kind === "proof-receipt" && note.removalId === op.removalId
      && note.unitId === op.unitId && note.proofKind === op.proofKind;
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
      if (plan.ruleId !== op.kind && !proofUnderItsRule(plan, op)
        && !forgetUnderItsRule(c, plan, op) && !shapeUnderItsRule(plan, op)) {
        report("wrong-rule", `Rule ${plan.ruleId} cannot issue a ${op.kind} operation`);
      }
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
      // The entry-shape lane (ISSUE-056 chunk C5, reworked to the landed-node
      // contract by ISSUE-058 chunk P3b): every claim a shape makes — the
      // whole-line kept spans of the landed body, the complement removal and the
      // unit binding — is re-derived from that body's own bytes there.
      if (op.kind === "shape") checkShape(c, op, removal, report);
      if (op.kind === "seal") {
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
      if (op.kind === "seal" && op.mode === "replace") {
        // ADR-0018 §4: replace-mode seal stays refused and the refusal names the
        // seam, so a supervisor knows what to declare first.
        report("unsupported-capability", namesSeam("A replace-mode seal"));
      }
      if (op.kind === "verdict" && !declaresRevert(c)) {
        report("unsupported-capability", namesSeam("A verdict removal"));
      }
      // ADR-0018 §1–3: a proof burn travels the same revert lane and reads the
      // same one flag. Without the seam nothing applies; the bytes stay put.
      if (op.kind === "proof" && !declaresRevert(c)) {
        report("unsupported-capability", namesSeam("A proof removal"));
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
