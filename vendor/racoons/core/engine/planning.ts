import { EpisodeTracker } from '../episodes/tracker.js';
import type { Episode } from '../episodes/types.js';
import { pruneVerdicts, pruneWindow } from '../guard/checks-verdicts.js';
import { computeFreshZone } from '../guard/fresh-zone.js';
import { renderShapeTurn } from '../guard/shape-turn.js';
import { ENTRY_SHAPE_RULE_ID } from '../rules/types.js';
import type { Note, Removal, RulePlan, ShapeOp } from '../rules/types.js';
import type { ByteRange, Bytes, LineRange, NodeId, RecallId, UnitId } from '../types/identity.js';
import type { SessionSnapshot } from '../types/transcript.js';
import type { ProcessingUnit } from '../units/types.js';
import { sha256Sync } from '../util/hash.js';
import { splitLineOffsets } from '../util/lines.js';
import type { EntryAnswer } from '../verdicts/entry-wire.js';
import { isKeepEverythingAnswer } from '../verdicts/entry-wire.js';
import { planVerdictApplication, complementLineSpans, normalizeKeptSpans } from '../verdicts/plan.js';
import type { VerdictBatch } from '../verdicts/types.js';
import { estimatedContentTokens, judgeWindow, unitsFromWindow } from './protocol.js';
import { planForget } from './forget.js';
import type { EngineInput, EngineOptions } from './types.js';

export function detectEpisodes(options: EngineOptions, snapshot: SessionSnapshot): readonly Episode[] {
  return new EpisodeTracker({ noNewPathSteps: options.config.thresholds.episodeNoNewPathSteps }).detect({
    sessionId: snapshot.sessionId,
    results: snapshot.nodes.filter(node => node.kind === 'tool-result'),
    currentStepOrdinal: snapshot.currentStepOrdinal,
    completedThroughTurnOrdinal: snapshot.completedThroughTurnOrdinal,
  });
}

/**
 * Verdict state to operations. There is no rule pass: a prune event is the
 * application of one merged pass document, so `options.rules` never see it and
 * `RuleContext` carries no protocol state (design-protocol §3).
 */
export function planVerdicts(
  snapshot: SessionSnapshot, units: readonly ProcessingUnit[], batch: VerdictBatch,
): RulePlan[] {
  // `nodes` is what makes a `keeplines` verdict plannable: the planner resolves
  // line spans to byte ranges from the authoritative node bytes, never from the
  // answer's own arithmetic.
  const plan = planVerdictApplication({
    state: judgeWindow(units, batch), baseRevision: snapshot.revision, nodes: snapshot.nodes,
  });
  return plan === null ? [] : [plan];
}

/**
 * A prune pass's merged document to operations (ISSUE-022 chunk 4; ADR-0009).
 * The pass has already asked the model; the engine never does. Its removals are
 * read as one verdict batch over exactly the units the document names, so every
 * removal in the pass lands in one plan and therefore in one checkpoint-revert.
 * A stale document (a unit whose bytes changed) plans the units still present;
 * the guard refuses the event rather than this helper inventing one.
 */
export function planPrune(
  options: EngineOptions, snapshot: SessionSnapshot,
  event: Extract<EngineInput, { readonly kind: 'prune' }>,
): RulePlan[] {
  const units = unitsFromWindow(
    snapshot, options.sessionId, options.config.protocol.barBytes, pruneWindow(event),
  );
  return planVerdicts(snapshot, units, pruneVerdicts(event));
}

/**
 * One landed result the entry checkpoint asked about: the LANDED unit's own id,
 * the turn it landed in, the ORIGINAL bytes the port still holds, and the
 * agent's four-arm answer (ISSUE-058 chunk P3b; ISSUE-061 chunk F-1a;
 * ADR-0022 §11–§13, ADR-0026).
 *
 * Nothing here is derived: the unit id comes IN from the mount's stamp over the
 * landed node, and the bytes are the ones the port holds — not the shaped bytes
 * any later turn carries. The pre-landing shape of this planner (an "incoming
 * result" that was also the unit) is gone with the protocol that assumed it.
 */
export interface LandedEntryShapeInput {
  readonly unitId: UnitId;
  /** The landed result's node id: the turn an apply rewinds past. */
  readonly nodeId: NodeId;
  /** The port/ledger-held original body, whole. */
  readonly originalBytes: Bytes;
  readonly answer: EntryAnswer;
}

/** Why a landed answer cannot be shaped into a replacement turn. */
export type EntryShapeRefusal =
  /** A named line range does not exist in the landed body (the one-retry case). */
  | "spans-outside-result"
  /** `keeplines` names every line: nothing is dropped, so no gap carries a marker. */
  | "keeps-every-line"
  /** `forgetlines` names every line: that is a whole-unit forget, which carries a descriptor. */
  | "drops-every-line"
  /** The event's action is not one of the grammar's four; fail-open, plan nothing. */
  | "unknown-answer";

/**
 * What one answered checkpoint plans, against the landed unit.
 *
 * - `keepall` — no operation at all: the mount rewinds the ask exchange away and
 *   the conversation continues from the result-landed state (ADR-0022 §11).
 *   Core plans nothing; the answer is final and nothing is banked.
 * - `shape` — one new turn: the kept partial lines with one shape-marker
 *   standing in each dropped gap. `bankOver` is the ORIGINAL body the archive
 *   covers, so recall is byte-exact, and `recallId` is the id the marker names.
 *   `plan` is that shape as the guard's `RulePlan`.
 * - `refuse` — the answer names bytes this body cannot hold, or names every line
 *   so nothing could be marked. Fail-open: the caller journals the code and the
 *   landed result stays whole (ADR-0022 §14).
 *
 * `replacementBytes` is the SHAPED PART of the appended turn — the kept lines
 * with their markers, which is exactly what `renderShapeTurn` renders and what
 * the guard re-renders. The answer's `summary` rides beside it on this object,
 * never inside it: ADR-0022 §12 says the new turn carries the summary and the
 * kept partials, and where in the turn the summary sits is copy a mount owns
 * (ISSUE-058 chunk P3c composes it), not arithmetic this planner may invent.
 * Core validates the shaped bytes; the summary is the agent's own text, already
 * bounded to one line of at most 25 words by the entry parser.
 */
export type EntryShapePlan =
  | { readonly action: "keepall" }
  | {
      readonly action: "shape";
      readonly unitId: UnitId;
      /** The lines the answer keeps, in source order: empty for `forgetall`. */
      readonly keptLineRanges: readonly LineRange[];
      /** The same selection as whole-line byte ranges of `bankOver`. */
      readonly keptRanges: readonly ByteRange[];
      /** The kept partials with one rendered marker in each dropped gap. */
      readonly replacementBytes: Bytes;
      /** The ORIGINAL landed body the archive covers. */
      readonly bankOver: Bytes;
      readonly recallId: RecallId;
      /** The answer's own note, which the appended turn carries beside the partials. */
      readonly summary: string;
      /** The same shape as the guard sees it. */
      readonly plan: RulePlan;
    }
  | {
      readonly action: "refuse";
      readonly code: EntryShapeRefusal;
      readonly detail: string;
    };

/**
 * One landed answer to one shape plan (ISSUE-058 chunk P3b; ADR-0022 §12).
 *
 * The plan is derived from the LANDED body's own lines and the answer alone: the
 * answer names lines, the line offsets turn them into byte ranges, the removal is
 * exactly the other side of the named set, and the replacement turn is the kept
 * bytes with one marker per dropped gap. Nothing here decides HOW MUCH is kept —
 * no threshold, no budget, no re-entry test (ADR-0022 §1) — and nothing is
 * edited in place: the shaped bytes are a NEW turn's body, applied by the mount's
 * rewind-and-append.
 *
 * The two partial classes are one arithmetic with two polarities (ADR-0026 §3–§4):
 * `keeplines` names the kept spans, `forgetlines` names the DROPPED ones and the
 * kept set is its complement inside the landed body. `complementLineSpans` is the
 * one function that computes a complement; this planner never hand-computes one,
 * and the answer never supplies one.
 *
 * Every claim the guard re-derives (`checkShape`) is computed here from one
 * source of truth: `bankOver` is the archived body, and the marker's recall id is
 * the id that archive is minted under, computed by the same `recallManifestFor`
 * the guard's `makeRecall` uses.
 */
export function planEntryShape(
  input: LandedEntryShapeInput,
  snapshot: SessionSnapshot,
): EntryShapePlan {
  const { answer, originalBytes } = input;
  if (answer.action === "keepall") return { action: "keepall" };
  // A hand-built event may carry an arm the grammar does not have (`keephead`,
  // or a fifth form a future build adds). Nothing is read off it: no `.lines`,
  // no `.ranges`. An unreadable answer is the fail-open case, so the landed
  // result stays whole (ADR-0022 §14) rather than the planner throwing.
  if (answer.action !== "forgetall" && answer.action !== "keeplines"
    && answer.action !== "forgetlines") {
    const named: string = (answer as { readonly action: unknown }).action as string;
    return { action: "refuse", code: "unknown-answer",
      detail: `the answer action ${named} is not one of the four` };
  }
  const offsets = splitLineOffsets(originalBytes);
  const totalLines = offsets.length;
  // The NAMED spans, validated against the landed body's own line count. For
  // `keeplines` they are what stays; for `forgetlines` they are what leaves.
  // Both are checked directly, never a derived complement (ADR-0026 §4).
  const namedLineRanges: readonly LineRange[] = answer.action === "forgetall"
    ? [] : answer.ranges.map(span => ({ startLine: span.from, endLineInclusive: span.to }));
  for (const lines of namedLineRanges) {
    if (lines.startLine < 1 || lines.endLineInclusive > totalLines) {
      // The landed body is authoritative: a line number it does not hold is the
      // one-retry case, never a clamp and never a silent keep (ADR-0022 §6).
      return { action: "refuse", code: "spans-outside-result",
        detail: `lines ${String(lines.startLine)}–${String(lines.endLineInclusive)} exceed the ${String(totalLines)} line(s) the landed result holds` };
    }
  }
  // The two-form ask lets a model say "nothing was dropped" as `keepall` or as a
  // full-range `keeplines` noted `None`. The second form is keep-all, not a
  // refusal: no op, no marker, no removal.
  if (answer.action === "keeplines" && isKeepEverythingAnswer(answer, totalLines)) {
    return { action: "keepall" };
  }
  // The kept selection, in this lane's one derivation: `forgetall` keeps
  // nothing, `keeplines` keeps the named spans, `forgetlines` keeps their
  // complement inside the landed body. The complement is computed by the shared
  // line arithmetic (`complementLineSpans`, the same function the gate lane's
  // `deriveVerdictRemoval` uses), never by this caller and never by the answer.
  const keptLineRanges: readonly LineRange[] = answer.action === "forgetall"
    ? [] : answer.action === "keeplines"
      ? namedLineRanges : complementLineRanges(namedLineRanges, totalLines);
  if (answer.action === "forgetlines" && keptLineRanges.length === 0) {
    // Naming every line is a `forgetall` without a descriptor: refused by name
    // rather than planned as a whole-unit removal the answer never described
    // (ADR-0026 §5).
    return { action: "refuse", code: "drops-every-line",
      detail: `the answer names all ${String(totalLines)} line(s); forgetting the whole unit needs forgetall and its descriptor` };
  }
  const keptRanges = mergeRanges(keptLineRanges.map(lines => ({
    startByte: offsets[lines.startLine - 1]?.startByte ?? 0,
    endByteExclusive: offsets[lines.endLineInclusive - 1]?.endByteExclusive ?? 0,
  })));
  // The real sha256 of the ORIGINAL body, never the node's declared hash: a
  // caller that hands shaped bytes as `originalBytes` gets a source the landed
  // node does not match, and the guard refuses it by name.
  const source = { nodeId: input.nodeId, sha256: sha256Sync(originalBytes),
    byteLength: originalBytes.length };
  // One renderer for the turn: the planner writes what the guard re-renders, so
  // "re-renders byte-exact" is a check of one implementation against itself with
  // the plan's own copy of the claim in between.
  const turn = renderShapeTurn({ source, original: originalBytes,
    keptRanges, sessionId: snapshot.sessionId });
  if (turn === null) {
    // No dropped gap means no marker and no new turn: the append would restate
    // the landed body as a message and orphan its tool call. Refused by name
    // (the answer gives up nothing; `keepall` is how that is said).
    return { action: "refuse", code: "keeps-every-line",
      detail: "a shape that keeps every line gives up nothing and carries no marker" };
  }
  const removal: Removal = {
    id: `shape:${input.nodeId}`,
    title: `Shaped tool result ${input.nodeId}`,
    sources: [{ source, ranges: [...turn.gaps] }],
  };
  const note: Note = { id: `shape-marker:${input.nodeId}`, kind: "shape-marker",
    removalId: removal.id };
  const operation: ShapeOp = {
    kind: "shape", removalId: removal.id, unitId: input.unitId, keptRanges,
    replacementBytes: turn.bytes, originalBytes: originalBytes.slice(), noteId: note.id,
  };
  return { action: "shape", unitId: input.unitId, keptLineRanges, keptRanges,
    replacementBytes: turn.bytes, bankOver: originalBytes, recallId: turn.recallId,
    summary: answer.summary,
    plan: { ruleId: ENTRY_SHAPE_RULE_ID, baseRevision: snapshot.revision,
      removals: [removal], notes: [note], operations: [operation] } };
}

/**
 * The lines a `forgetlines` answer KEEPS: the complement of its named spans
 * inside the landed body. This is a thin adapter over `complementLineSpans` —
 * the one complement function the gate lane's `deriveVerdictRemoval` also uses —
 * so the entry lane and the gate lane tile by the same arithmetic and neither
 * hand-computes a gap. The named spans are normalised first, because a
 * hand-built event need not carry the parser's ordering and `complementLineSpans`
 * reads its input in source order.
 */
function complementLineRanges(
  named: readonly LineRange[], totalLines: number,
): readonly LineRange[] {
  const normalized = normalizeKeptSpans(
    named.map(range => ({ from: range.startLine, to: range.endLineInclusive })),
  ) ?? [];
  return complementLineSpans(normalized, totalLines)
    .map(span => ({ startLine: span.from, endLineInclusive: span.to }));
}

/**
 * The kept ranges in source order, adjacent or overlapping ones merged. The
 * entry parser normalises line spans, but a hand-built event need not have, and
 * `complement` refuses unordered input: merging here means a malformed answer
 * can only plan a shape the guard refuses on its own terms, never throw out of
 * the planner.
 */
function mergeRanges(ranges: readonly ByteRange[]): readonly ByteRange[] {
  const ordered = [...ranges].sort((a, b) => a.startByte - b.startByte);
  const merged: ByteRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.startByte <= previous.endByteExclusive) {
      merged[merged.length - 1] = {
        startByte: previous.startByte,
        endByteExclusive: Math.max(previous.endByteExclusive, range.endByteExclusive),
      };
    } else merged.push({ ...range });
  }
  return merged;
}

/**
 * The one decision an answered entry event makes, or `null` when the event
 * carries no answer or no landed-unit stamp (ISSUE-058 chunk P3a; ADR-0022
 * §11–§14).
 *
 * `engine.ts` calls this for an answered entry so the refusal itself reaches the
 * caller (`EntryShapePlan` names the reason), and `planApplication` calls the
 * same function for an entry event it is handed directly, so the two routes can
 * never plan differently. An unanswered entry has no decision at all: the rules
 * see it exactly as before.
 */
export function planEntryDecision(
  input: EngineInput, snapshot: SessionSnapshot,
): EntryShapePlan | null {
  if (input.kind !== 'entry' || input.answer === undefined) return null;
  const unitId = input.stamp?.unitId;
  if (unitId === undefined) return null;
  return planEntryShape({ unitId, nodeId: input.result.id,
    originalBytes: input.result.bytes, answer: input.answer }, snapshot);
}

export function planApplication(
  options: EngineOptions, input: EngineInput, snapshot: SessionSnapshot,
  episodes: readonly Episode[], sealedEpisodeIds: readonly string[], nowMs: number,
): RulePlan[] {
  // Prune and forget inputs route to their own planners, never to
  // `options.rules`: a pass document and a human request are applications, not
  // byte proofs (design-protocol §3; ISSUE-045 chunk C1).
  if (input.kind === 'prune') return planPrune(options, snapshot, input);
  if (input.kind === 'forget') return planForget(options, snapshot, input.request);
  // An ANSWERED entry event plans its shape and nothing else (ISSUE-056;
  // ADR-0022). The rules never see it: a shape is an application of a settled
  // answer, not a byte proof, and `RuleContext` carries no protocol state.
  //
  // An UNANSWERED entry plans nothing here either (ISSUE-058 chunk P3a): under
  // the land-first protocol the host already wrote the result, so there is no
  // node on its way in for a rule to act on. `engine.ts` never hands one to this
  // function; a direct caller that does still gets a rule pass, because planning
  // stays a pure function of its input, but the engine's entry path is silent.
  //
  // The event's `result` IS the landed node: under the corrected protocol the
  // host wrote it before RACOONS saw it (ADR-0022 §2), so its bytes are the
  // original the archive covers. The unit id comes IN on the mount's stamp — the
  // landed unit it asked about, never one re-derived here. No stamp means no
  // addressable landed unit, and then nothing is planned: the result stays
  // landed whole, which is the fail-open outcome (ADR-0022 §14).
  if (input.kind === 'entry' && input.answer !== undefined) {
    const shape = planEntryDecision(input, snapshot);
    return shape !== null && shape.action === 'shape' ? [shape.plan] : [];
  }
  const freshZone = computeFreshZone(snapshot, options.config);
  // The same arithmetic `estimatedContentTokens` exports, which the mount's
  // half-window trigger also uses: one definition (CRITIC-022 P3 #15). Core
  // holds no wire capture, so this reading is transcript content only; the
  // mount's trigger adds the captured system+tools prefix (ADR-0009 §Amendment
  // 2026-10-24).
  const estimated = estimatedContentTokens(options.meter, snapshot,
    input.kind === 'entry' ? input.result.bytes : null, null);
  const reserved = new Set<string>();
  const plans: RulePlan[] = [];
  for (const rule of options.rules) {
    try {
      const plan = rule.plan(structuredClone({
        input, snapshot, capabilities: options.capabilities, config: options.config,
        freshZone, episodes, sealedEpisodeIds, reservedNodeIds: [...reserved],
        estimatedContentTokens: estimated, latestUsage: options.meter.latest(), nowMs,
      }));
      if (plan === null) continue;
      const copy = structuredClone(plan);
      for (const removal of copy.removals) {
        for (const source of removal.sources) reserved.add(source.source.nodeId);
      }
      // Guard qualifies removal/note IDs by ruleId while building the candidate.
      plans.push(copy.ruleId === rule.id ? copy
        : { ...copy, baseRevision: `${snapshot.revision}:invalid-rule` });
    } catch {
      // A throwing/malformed rule rejects every plan through the ordinary guard path.
      plans.push({ ruleId: rule.id, baseRevision: `${snapshot.revision}:invalid`,
        removals: [], notes: [], operations: [] });
    }
  }
  return plans;
}
