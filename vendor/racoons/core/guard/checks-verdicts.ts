import type { RulePlan } from "../rules/types.js";
import type { EngineInput } from "../engine/types.js";
import type { PruneRemoval } from "../prune/pass-merge.js";
import type { LineRange, RemovalId, UnitId } from "../types/identity.js";
import type { TranscriptNode } from "../types/transcript.js";
import { UnitTracker } from "../units/tracker.js";
import type { ProcessingUnit } from "../units/types.js";
import {
  descriptorIssue, RECEIPT_DESCRIPTOR_WORD_LIMIT,
} from "../verdicts/labels.js";
import {
  complementLineSpans, deriveVerdictRemoval, normalizeKeptSpans, receiptLabelFor, VERDICT_RULE_ID,
} from "../verdicts/plan.js";
import type { KeptLineSpan, Verdict, VerdictBatch } from "../verdicts/types.js";
import type { CheckContext } from "./context.js";
import { reporter } from "./context.js";

/**
 * The verdict protocol's guard checks (design-protocol §3, §5 Slice 2; the
 * three-action format is ISSUE-017's).
 *
 * The guard re-derives every claim in a verdict plan from the snapshot and the
 * batch. It never trusts the planner's arithmetic: a `keeplines` removal must be
 * the complement of the kept spans inside the unit, computed here from the
 * node's own line offsets. Perturbing one span therefore breaks the plan.
 *
 * Two validations exist only here. The tracker records what the agent said but
 * never asks when the gate asked: a verdict stamped with a round the gate never
 * presented answers nothing, so it is `unknown-unit` here. A descriptor past the
 * 25-word cap would put a paragraph into a receipt, so it is
 * `descriptor-too-long`. Neither is silently trimmed or rewritten;
 * all-or-nothing rejects the batch.
 *
 * A verdict plan applies on a verdict event and on a prune pass, and only
 * there; it is the application of one settled batch, not a rule pass. A prune
 * event's document is read as one batch by `pruneVerdicts`, and its membership
 * window is every unit the document names (`pruneWindow`), because the event's
 * own `window` is the token bound it was planned against. When `input.window`
 * is present on a verdict event it is the authoritative membership list, so a
 * verdict for a unit the gate did not present is `unknown-unit` even though the
 * snapshot can prove it.
 * An event without a window (a hand-built batch) falls back to the widest
 * window the snapshot can prove: every unit above the bar. A unit below the bar
 * or absent from the snapshot is `unknown-unit`, and a plan that does not answer
 * its own forgets is `incomplete-verdicts`.
 */
export function checkVerdicts(c: CheckContext, plans: readonly RulePlan[]): void {
  const verdictPlans = plans.filter(plan => plan.ruleId === VERDICT_RULE_ID);
  const input = c.value.input;
  if (input.kind !== "verdict" && input.kind !== "prune") {
    // A verdict plan outside a verdict or prune event is a rule trying to cast a vote.
    for (const plan of verdictPlans) {
      reporter(c, plan.ruleId, null)("invalid-plan",
        "A verdict plan applies only on a verdict event or a prune pass");
    }
    return;
  }
  const batch: unknown = input.kind === "verdict" ? input.verdicts : pruneVerdicts(input);
  if (!isBatch(batch)) {
    reporter(c, VERDICT_RULE_ID, null)("invalid-plan",
      "A verdict event must carry a round and a list of verdicts");
    return;
  }
  if (input.kind === "prune" && (!Number.isSafeInteger(input.window) || input.window <= 0)) {
    // The bound is what the pass was planned against; without it the event
    // cannot say whether its removals were inside any window at all.
    reporter(c, VERDICT_RULE_ID, null)("invalid-plan",
      "A prune event must name the positive context window its pass was planned against");
  }
  for (const plan of plans) {
    if (plan.ruleId !== VERDICT_RULE_ID) {
      reporter(c, plan.ruleId, null)("wrong-rule", "A verdict event carries verdict plans only");
    }
  }
  const units = windowUnits(c, input.kind === "verdict"
    ? presentedWindow(input) : pruneWindow(input));
  // Gate rounds are presented ordinals, so the first presentation is round 1.
  // A prune pass numbers its own indices the same way: its first pass is round 1.
  const pointed = batch.round >= 1;
  if (!pointed) {
    reporter(c, VERDICT_RULE_ID, null)("invalid-plan",
      "A verdict batch must name the gate round it settles");
  }

  const answered = new Map<UnitId, Verdict>();
  for (const raw of batch.verdicts) {
    const verdict = readVerdict(raw);
    if (verdict === null) {
      reporter(c, VERDICT_RULE_ID, null)("invalid-plan",
        "A verdict needs a unit id, one of keepall/keeplines/forgetall, its payload and an integral round");
      continue;
    }
    const unit = units.get(verdict.unitId);
    if (answered.has(verdict.unitId)) {
      reporter(c, VERDICT_RULE_ID, null)("conflicting-operations",
        "One unit carries more than one verdict", unit?.nodeId ?? null);
      continue;
    }
    answered.set(verdict.unitId, verdict);
    if (unit === undefined) {
      reporter(c, VERDICT_RULE_ID, null)("unknown-unit", "Verdict names a unit outside the window");
    }
    if (pointed && (verdict.answeredInRound < 1 || verdict.answeredInRound > batch.round)) {
      reporter(c, VERDICT_RULE_ID, null)("unknown-unit",
        `Verdict answers round ${String(verdict.answeredInRound)}, which this gate never presented`,
        unit?.nodeId ?? null);
    }
    checkAnswerShape(c, verdict, unit);
  }

  const forgotten = new Set<UnitId>();
  for (const plan of verdictPlans) {
    plan.operations.forEach((op, index) => {
      // A non-verdict operation under this rule id is `wrong-rule`, already
      // reported by `checkOperations`; this check speaks for verdict removals.
      if (op.kind !== "verdict") return;
      const report = reporter(c, plan.ruleId, index);
      const unit = units.get(op.unitId);
      if (unit === undefined) {
        report("unknown-unit", "A verdict removal names a unit outside the window");
        return;
      }
      if (forgotten.has(op.unitId)) {
        report("conflicting-operations", "A unit is forgotten more than once", unit.nodeId);
        return;
      }
      forgotten.add(op.unitId);
      const verdict = answered.get(op.unitId);
      if (verdict === undefined) {
        report("incomplete-verdicts", "A forgotten unit has no verdict in this batch", unit.nodeId);
        return;
      }
      if (verdict.action === "keepall") {
        report("invalid-plan", "A keepall verdict cannot produce a removal", unit.nodeId);
        return;
      }
      const expected = deriveVerdictRemoval(unit, verdict, nodeBytesOf(c, unit));
      if (expected === null || !declaresExactly(plan, op.removalId, unit, expected.byteRanges)) {
        report("invalid-plan",
          "A verdict removal must archive exactly the ranges its answer gives up", unit.nodeId);
        return;
      }
      // The receipt is the only model-facing artifact a verdict produces. Its
      // label is the clamped descriptor for forgetall and null for keeplines;
      // its ranges name what was removed, never what was kept.
      const receipt = plan.notes.find(note => note.id === op.noteId);
      if (receipt === undefined || receipt.kind !== "receipt") return; // `checkOperations` speaks.
      if (receipt.label !== receiptLabelFor(verdict)) {
        report("invalid-note", "A receipt label differs from its verdict's descriptor", unit.nodeId);
      }
      if (!sameLines(receipt.ranges, expected.receiptRanges)) {
        report("invalid-note", "A receipt names ranges other than the ones the answer gives up", unit.nodeId);
      }
    });
  }
  for (const [unitId, verdict] of answered) {
    if (verdict.action === "keepall" || forgotten.has(unitId)) continue;
    const unit = units.get(unitId);
    if (unit === undefined) continue; // Already reported as `unknown-unit`.
    reporter(c, VERDICT_RULE_ID, null)("incomplete-verdicts",
      "A forgetting verdict reached no verdict plan", unit.nodeId);
  }
}

/**
 * The answer's own shape, independent of any plan. A `keeplines` answer must
 * name legal spans that keep something and give up something (ISSUE-017 §3):
 * keeping every line is a `keepall`, keeping none is a `forgetall` without a
 * descriptor, and both are refused rather than reinterpreted. An out-of-bounds
 * span is refused, never clamped. A `forgetall` descriptor must fit the
 * 25-word cap.
 */
function checkAnswerShape(c: CheckContext, verdict: Verdict, unit: ProcessingUnit | undefined): void {
  if (verdict.action === "forgetall" && verdict.summary !== null
    && descriptorIssue(verdict.summary) === "descriptor-too-long") {
    reporter(c, VERDICT_RULE_ID, null)("descriptor-too-long",
      `A receipt descriptor must stay within ${String(RECEIPT_DESCRIPTOR_WORD_LIMIT)} words`,
      unit?.nodeId ?? null);
  }
  if (verdict.action !== "keeplines") return;
  const kept = normalizeKeptSpans(verdict.ranges);
  if (kept === null) {
    reporter(c, VERDICT_RULE_ID, null)("invalid-line-span",
      "A keeplines verdict needs spans of at least one line, each within its own bounds",
      unit?.nodeId ?? null);
    return;
  }
  if (kept.length === 0) {
    reporter(c, VERDICT_RULE_ID, null)("invalid-line-span",
      "A keeplines verdict that keeps no line is a forgetall without a descriptor; it must name spans",
      unit?.nodeId ?? null);
    return;
  }
  if (unit === undefined) return; // Already reported as `unknown-unit`.
  const lines = unit.span.lineRange;
  if (lines === null) {
    reporter(c, VERDICT_RULE_ID, null)("invalid-line-span",
      "A keeplines verdict needs a line-addressable unit", unit.nodeId);
    return;
  }
  const count = lines.endLineInclusive - lines.startLine + 1;
  const last = kept[kept.length - 1];
  if (last !== undefined && last.to > count) {
    reporter(c, VERDICT_RULE_ID, null)("invalid-line-span",
      `A keeplines span runs past the unit's ${String(count)} lines; spans are never clamped`,
      unit.nodeId);
    return;
  }
  if (complementLineSpans(kept, count).length === 0) {
    reporter(c, VERDICT_RULE_ID, null)("invalid-line-span",
      "A keeplines verdict that keeps every line gives up nothing; it is a keepall", unit.nodeId);
  }
}

/**
 * The removal a verdict must declare. The declared ranges must be exactly the
 * re-derived ones: same count, same start byte, same end. A span dropped,
 * duplicated, widened or shifted anywhere in the plan surfaces as a mismatch.
 */
function declaresExactly(
  plan: RulePlan, removalId: RemovalId, unit: ProcessingUnit,
  expected: readonly { readonly startByte: number; readonly endByteExclusive: number }[],
): boolean {
  const removal = plan.removals.find(candidate => candidate.id === removalId);
  if (removal === undefined || removal.sources.length !== 1) return false;
  const only = removal.sources[0];
  if (only === undefined) return false;
  if (only.source.nodeId !== unit.nodeId
    || only.source.sha256 !== unit.source.sha256
    || only.source.byteLength !== unit.source.byteLength) return false;
  const declared = only.ranges;
  return declared.length === expected.length && declared.every((range, index) => {
    const want = expected[index];
    return want !== undefined && range.startByte === want.startByte
      && range.endByteExclusive === want.endByteExclusive;
  });
}

/** The authoritative bytes of a unit's node; a `keeplines` derivation needs them. */
function nodeBytesOf(c: CheckContext, unit: ProcessingUnit): Uint8Array | null {
  const node: TranscriptNode | undefined = c.nodes.get(unit.nodeId);
  return node !== undefined && node.kind === "tool-result" ? node.bytes : null;
}

/** The presented window, when the event carries one; `null` means "not recorded". */
function presentedWindow(input: Extract<EngineInput, { readonly kind: "verdict" }>): readonly UnitId[] | null {
  const window: unknown = (input as { readonly window?: unknown }).window;
  if (window === undefined || window === null) return null;
  return Array.isArray(window) ? window.filter((id): id is UnitId => typeof id === "string" && id.length > 0) : null;
}

type PruneInput = Extract<EngineInput, { readonly kind: "prune" }>;

/**
 * A prune event's merged document read as one verdict batch (ADR-0009: one
 * decision set, one epoch break). A removal IS the unit's answer, so the batch
 * carries exactly the removals: L1 proved whole-unit forgets with no descriptor
 * and the pass's own round, L2 the judge's action with the round it answered in.
 * Units the pass kept claim nothing and are not in the batch; they are in the
 * window so a plan naming one is refused rather than silently applied.
 */
export function pruneVerdicts(input: PruneInput): VerdictBatch {
  const verdicts: Verdict[] = [];
  for (const removal of input.verdicts.removals) {
    verdicts.push(toVerdict(removal, input.round));
  }
  return { round: input.round, verdicts };
}

function toVerdict(removal: PruneRemoval, round: number): Verdict {
  if (removal.action === "keeplines") {
    return {
      unitId: removal.unitId, action: "keeplines",
      ranges: removal.ranges, answeredInRound: removal.answeredInRound,
    };
  }
  return removal.origin === "l2"
    ? { unitId: removal.unitId, action: "forgetall", summary: removal.summary,
        answeredInRound: removal.answeredInRound }
    : { unitId: removal.unitId, action: "forgetall", summary: null, answeredInRound: round };
}

/**
 * Every unit the merged document names — its removals and its keeps — in
 * first-seen order. A prune event's `window` is a token bound, not a unit list,
 * so membership comes from the document itself: a removal the pass never
 * decided is outside the window.
 */
export function pruneWindow(input: PruneInput): readonly UnitId[] {
  const seen = new Set<UnitId>();
  const window: UnitId[] = [];
  for (const removal of input.verdicts.removals) add(removal.unitId);
  for (const unitId of input.verdicts.kept) add(unitId);
  return window;

  function add(unitId: UnitId): void {
    if (seen.has(unitId)) return;
    seen.add(unitId);
    window.push(unitId);
  }
}

/**
 * The units the gate actually put to the agent, in snapshot order. A recorded
 * window narrows the widest set: a unit it omits was never asked, so a verdict
 * naming it answers nothing even though the snapshot still holds it. An absent
 * or unusable window falls back to every unit above the bar.
 */
function windowUnits(c: CheckContext, window: readonly UnitId[] | null): ReadonlyMap<UnitId, ProcessingUnit> {
  const tracker = new UnitTracker({
    sessionId: c.value.snapshot.sessionId,
    barBytes: c.value.config.protocol.barBytes,
  });
  const units = new Map<UnitId, ProcessingUnit>();
  const named = window === null ? null : new Set(window);
  for (const unit of tracker.units(c.value.snapshot)) {
    if (named !== null && !named.has(unit.id)) continue;
    units.set(unit.id, unit);
  }
  return units;
}

function sameLines(a: readonly LineRange[], b: readonly LineRange[]): boolean {
  return a.length === b.length && a.every((range, index) => {
    const other = b[index];
    return other !== undefined && range.startLine === other.startLine
      && range.endLineInclusive === other.endLineInclusive;
  });
}

/** The event shape is runtime data; the declared type is the contract it must meet. */
function isBatch(value: unknown): value is VerdictBatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const batch = value as { readonly round?: unknown; readonly verdicts?: unknown };
  return Number.isSafeInteger(batch.round) && Array.isArray(batch.verdicts);
}

/**
 * The exact field set each action may carry. A verdict is a closed shape: any
 * other field — notably the retired free-text `reason` of the old format — is
 * an unknown field and the whole answer is refused, never silently dropped.
 * `summary` is optional for `forgetall` (absent means the floor receipt line).
 */
const VERDICT_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["keepall", ["unitId", "action", "answeredInRound"]],
  ["keeplines", ["unitId", "action", "answeredInRound", "ranges"]],
  ["forgetall", ["unitId", "action", "answeredInRound", "summary"]],
]);

/** True when every own key of `value` is one the action may carry. */
function closedShape(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

/**
 * Reads one answer in the three-action format, or `null` when the shape is not
 * a verdict at all: a missing unit id, an unknown action, a field the action
 * does not carry, a fractional round, a `keeplines` whose range list is empty
 * or holds a non-integral span, or a `forgetall` whose summary slot is neither
 * a string nor null. The caller reports `invalid-plan`; this function never
 * repairs an answer. Ordering, overlap and bounds are `normalizeKeptSpans`' and
 * `checkAnswerShape`'s work.
 *
 * The field set is closed (owner ruling 2026-10-23). `keepall` and `keeplines`
 * carry no free text at all; `forgetall` carries `summary` and nothing else.
 */
export function readVerdict(value: unknown): Verdict | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const verdict = value as Record<string, unknown>;
  const unitId = verdict["unitId"];
  if (typeof unitId !== "string" || unitId.length === 0) return null;
  if (!Number.isSafeInteger(verdict["answeredInRound"])) return null;
  const answeredInRound = verdict["answeredInRound"] as number;
  const action = verdict["action"];
  if (typeof action !== "string") return null;
  const allowed = VERDICT_FIELDS.get(action);
  if (allowed === undefined || !closedShape(verdict, allowed)) return null;
  if (action === "keepall") return { unitId, action, answeredInRound };
  if (action === "keeplines") {
    const ranges = readSpans(verdict["ranges"]);
    if (ranges === null) return null;
    return { unitId, action, answeredInRound, ranges };
  }
  const summary = verdict["summary"];
  if (summary !== undefined && summary !== null && typeof summary !== "string") return null;
  return { unitId, action: "forgetall", answeredInRound, summary: summary ?? null };
}

/**
 * The kept spans as the answer wrote them, in whatever order and with whatever
 * overlap. `null` only when the slot is not a list of integral `from`/`to`
 * pairs — a shape failure. Whether a span is ordered, overlapping, in bounds or
 * even non-empty is `normalizeKeptSpans`' and `checkAnswerShape`'s judgement,
 * so an empty list gets the precise `invalid-line-span` name, not `invalid-plan`.
 */
function readSpans(value: unknown): readonly KeptLineSpan[] | null {
  if (!Array.isArray(value)) return null;
  const spans: KeptLineSpan[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const from: unknown = (item as { readonly from?: unknown }).from;
    const to: unknown = (item as { readonly to?: unknown }).to;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
    spans.push({ from: from as number, to: to as number });
  }
  return spans;
}
