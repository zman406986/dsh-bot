import type { Removal } from "../rules/types.js";
import type { LineRange } from "../types/identity.js";
import { resolveForget } from "../units/lookup.js";
import type { ProcessingUnit } from "../units/types.js";
import { labelIssue } from "../verdicts/labels.js";
import type { CheckContext } from "./context.js";
import { reporter } from "./context.js";

/**
 * The rule id a manual forget plans under (PRD §6.2; ISSUE-045 chunk C1). It
 * names who asked — the human — and lives here, beside the check that
 * re-derives the request; `engine/forget.ts` plans under it.
 */
export const FORGET_RULE_ID = "forget";

/**
 * The manual-forget request check (PRD §6.2; ISSUE-045 chunk C1).
 *
 * A forget event names a source path and line ranges. The guard resolves them
 * again from the snapshot, exactly as it re-derives every other plan's claims:
 *
 * - an absent, ambiguous or malformed request is `unresolved-request`, never a
 *   nearest guess — a manual removal is the human's claim about their own
 *   context, and a wrong unit is unrecoverable in the direction that matters;
 * - a plan that claims the resolution must name exactly the one resolved unit:
 *   its own span as the removal, a receipt for that unit, and one `verdict`
 *   operation — the lane that applies by checkpoint-revert and renders a
 *   receipt. A plan naming any other unit or span is `invalid-plan`;
 * - the receipt names the path the request named and the forgotten span's
 *   lines; anything else is `invalid-note`;
 * - the receipt label is the human's own phrase, kept to the advertised length
 *   or refused as `label-too-long`, never silently cut;
 * - a forget plan on any other event is `invalid-plan`, and any other plan on a
 *   forget event is `wrong-rule` — a forget is planned by this event only.
 *
 * Every refusal leaves the transcript untouched and counts on the breaker, as
 * every validation failure does.
 */
export function checkForget(c: CheckContext): void {
  const input = c.value.input;
  const plans = c.value.plans;
  if (input.kind !== "forget") {
    for (const plan of plans) if (plan.ruleId === FORGET_RULE_ID) {
      reporter(c, plan.ruleId, null)("invalid-plan",
        "A forget plan applies only on a forget event");
    }
    return;
  }
  for (const plan of plans) if (plan.ruleId !== FORGET_RULE_ID) {
    reporter(c, plan.ruleId, null)("wrong-rule", "A forget event carries forget plans only");
  }
  const resolution = resolveForget({
    snapshot: c.value.snapshot, sessionId: c.value.snapshot.sessionId, request: input.request,
  });
  if (resolution.status === "refused") {
    reporter(c, FORGET_RULE_ID, null)("unresolved-request", resolution.detail);
    return;
  }
  const forgetPlans = plans.filter(plan => plan.ruleId === FORGET_RULE_ID);
  if (forgetPlans.length === 0) {
    reporter(c, FORGET_RULE_ID, null)("invalid-plan",
      "A forget request that resolves to a unit reached no forget plan");
    return;
  }
  for (const plan of forgetPlans) {
    plan.operations.forEach((op, index) => {
      // A non-verdict op is `checkOperations`' business, already reported there.
      if (op.kind !== "verdict") return;
      const report = reporter(c, plan.ruleId, index);
      if (op.unitId !== resolution.unit.id) {
        report("invalid-plan", "A forget plan must name the one unit its request resolves to",
          resolution.unit.nodeId);
        return;
      }
      const removal = plan.removals.find(candidate => candidate.id === op.removalId);
      if (removal === undefined || !isOwnSpan(removal, resolution.unit)) {
        report("invalid-plan", "A forget removal must archive exactly the unit's own span",
          resolution.unit.nodeId);
        return;
      }
      const note = plan.notes.find(candidate => candidate.id === op.noteId);
      if (note === undefined || note.kind !== "receipt") return; // `checkOperations` speaks.
      if (note.removalId !== removal.id || note.unitId !== resolution.unit.id
        || note.path !== resolution.path || !sameLineRanges(note.ranges, resolution.receiptRanges)) {
        report("invalid-note",
          "A forget receipt must name the request's path and the forgotten unit's lines",
          resolution.unit.nodeId);
      }
      if (note.label !== null && labelIssue(note.label) !== null) {
        report("label-too-long",
          "A forget receipt label must stay within the advertised label limit",
          resolution.unit.nodeId);
      }
    });
  }
}

/** One source naming the unit's node and exactly the unit's own byte range. */
function isOwnSpan(removal: Removal, unit: ProcessingUnit): boolean {
  if (removal.sources.length !== 1) return false;
  const only = removal.sources[0];
  if (only === undefined || only.ranges.length !== 1) return false;
  const range = only.ranges[0];
  return only.source.nodeId === unit.nodeId
    && only.source.sha256 === unit.source.sha256
    && only.source.byteLength === unit.source.byteLength
    && range !== undefined
    && range.startByte === unit.span.byteRange.startByte
    && range.endByteExclusive === unit.span.byteRange.endByteExclusive;
}

function sameLineRanges(a: readonly LineRange[], b: readonly LineRange[]): boolean {
  return a.length === b.length && a.every((range, index) => {
    const other = b[index];
    return other !== undefined && range.startLine === other.startLine
      && range.endLineInclusive === other.endLineInclusive;
  });
}
