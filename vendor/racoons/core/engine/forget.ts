import { FORGET_RULE_ID } from "../guard/checks-forget.js";
import type { Note, Removal, RulePlan, VerdictOp } from "../rules/types.js";
import type { SessionSnapshot } from "../types/transcript.js";
import { resolveForget } from "../units/lookup.js";
import { unitRemoval } from "../units/tracker.js";
import { normalizeLabel } from "../verdicts/labels.js";
import type { EngineOptions, ForgetRequest } from "./types.js";

/**
 * A manual forget request to one plan (PRD §6.2: "Mistakes are recoverable:
 * manual forget, or recall by id").
 *
 * The plan reuses the verdict lane's shapes exactly: one `Removal` over the
 * unit's own span, one `receipt` note naming what left, and one `verdict`
 * operation — the operation that applies by checkpoint-revert and renders a
 * receipt (`guard/candidate.ts`, `guard/checks-revert.ts`). Nothing new is
 * invented: a manual forget *is* a verdict removal, except that the human asked
 * for it. It carries the forget rule id so the guard can tell the two apart: no
 * batch was asked and no unit was presented.
 *
 * An unresolved request plans nothing. The engine still sends the empty plan
 * list to `guardAndApply`, whose `checks-forget` re-derives the resolution and
 * records the refusal under `unresolved-request`; this planner never repairs a
 * request into a removal the human did not name.
 *
 * The label is normalised (one line, trimmed, blank becoming null) and never
 * clamped: it is the human's own phrase, so an over-long one is refused by the
 * guard (`label-too-long`) rather than silently cut.
 */
export function planForget(
  options: EngineOptions, snapshot: SessionSnapshot, request: ForgetRequest,
): RulePlan[] {
  const resolution = resolveForget({ snapshot, sessionId: options.sessionId, request });
  if (resolution.status === "refused") return [];
  const unit = resolution.unit;
  const removal: Removal = unitRemoval(unit);
  const noteId = `receipt:${unit.id}`;
  const normalized = request.label === null ? "" : normalizeLabel(request.label);
  const note: Note = {
    id: noteId,
    kind: "receipt",
    removalId: removal.id,
    unitId: unit.id,
    path: resolution.path,
    ranges: resolution.receiptRanges.map(range => ({ ...range })),
    label: normalized.length === 0 ? null : normalized,
  };
  const op: VerdictOp = { kind: "verdict", removalId: removal.id, unitId: unit.id, noteId };
  return [{
    ruleId: FORGET_RULE_ID,
    baseRevision: snapshot.revision,
    removals: [removal],
    notes: [note],
    operations: [op],
  }];
}
