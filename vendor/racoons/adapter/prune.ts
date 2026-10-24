/**
 * The big prune's mount wiring, record-only (ISSUE-022 chunk 5; ADR-0009), and
 * its ask shape: a fork of main's sent wire state, grown append-only
 * (ISSUE-027; ADR-0010).
 *
 * One pass over the mount's own state: units and nodes from the authoritative
 * snapshot, episodes from the tracker the engine already uses, protection from
 * the guard's own rule. `planPrunePass` runs L1, numbers every remaining unit,
 * and splits the display; this module seeds ONE fork from main's last captured
 * request (`seedFork`, byte-copied, hash-asserted) and grows it through
 * `./judge-tables.ts` — the judge's own table loop — appending each prune table
 * as a new user turn and reading each reply through the core's
 * `parsePruneAnswer`. The contract, the table and the final line ride INSIDE the
 * ask text: the fork's system slot is main's, untouched, because replacing it
 * would change byte 0 of the prefix the fork exists to have served from cache.
 *
 * The tables are the judge's: at most `PRUNE_ASK_MAX_TABLE_UNITS` (12) units,
 * carried-over rows re-asked at the front of the next table. `plan.tables`
 * stays ACCOUNTING ONLY: its token estimate is the record's `estTokens`, not
 * the send split.
 *
 * Record-only is structural, not a flag: nothing here calls the engine, the
 * port or the host. There is no append, no receipt, no recall id and no ledger
 * kind. The result is counts (`pruneRecordOf`) plus the judged removals, which
 * the caller may journal and a rig may assert on.
 *
 * Fail-open: no model seam, no route, no captured seed, a dead stream, bad JSON
 * — every one is a named journal record and the units stay. The pass grants one
 * re-ask, and only inside itself: the next table of the same pass is that one
 * re-ask (ADR-0009's second amendment), never a retry across passes.
 */
import { computeProtectedRanges, EpisodeTracker, UnitTracker } from '@racoons/core';
import {
  applyPruneAnswers, ForkError, planPrunePass, seedFork,
} from '@racoons/core';
import type {
  ByteRange, Episode, NextTableOptions, ProcessingUnit, PruneCallFacts,
  PrunePassApplication, PrunePassPlan, SessionSnapshot, ToolResultNode, UnitId,
  WireAnswer, WireFork,
} from '@racoons/core';
import type { DshTranscriptItem } from './envelope.js';
import { runTables } from './judge-tables.js';
import type { TableLoopOutcome } from './judge-tables.js';
import type { MountJournal } from './judge-seam.js';
import { messageOf } from './llm-ask.js';
import type { CapturedMainRequest } from './main-wire.js';
import type { DshLlmService } from './plugin.js';
import { journalPruneRecord, recordOnlyOutcome } from './prune-record.js';
import type { PruneRefusalReason, RecordOnlyPruneOutcome } from './prune-record.js';

export type { PruneRefusalReason, PruneSummaryTrace, RecordOnlyPruneOutcome } from './prune-record.js';
export { PRUNE_COMMAND } from './prune-record.js';

export interface RecordOnlyPruneOptions {
  readonly sessionId: string;
  /** The authoritative snapshot the units, nodes and protection all come from. */
  readonly snapshot: SessionSnapshot;
  /** The port's items: the history the ask renders and the whole calls it names. */
  readonly transcript: readonly DshTranscriptItem[];
  /** The pass ordinal; the caller owns it so two passes never share a stamp. */
  readonly round: number;
  /** Same bar the engine's own `UnitTracker` uses (`config.barBytes`). */
  readonly barBytes: number;
  /** Same threshold the engine's episode detection uses. */
  readonly episodeNoNewPathSteps: number | null;
  /** The host's model seam; absent means the pass records its L1 layer only. */
  readonly llm?: DshLlmService;
  /** The route the judge uses, resolved at call time. */
  readonly route: () => { readonly provider: string; readonly model: string } | null;
  /**
   * Main's last captured sent request; null means no fork can be seeded, so the
   * pass asks nothing and fails open. Required: a prune ask has no other shape
   * on the live path (ISSUE-027).
   */
  readonly seed: () => CapturedMainRequest | null;
  readonly journal: MountJournal;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Table-builder options; production passes none. ACCOUNTING ONLY (the record's estimate). */
  readonly tableOptions?: NextTableOptions;
}

/** Which of a node's protected byte ranges a unit's span touches; see below. */
function overlaps(ranges: readonly ByteRange[] | undefined,
  span: ByteRange): boolean {
  if (ranges === undefined) return false;
  return ranges.some(range => range.startByte < span.endByteExclusive
    && span.startByte < range.endByteExclusive);
}

/**
 * The units protection covers, derived from the guard's own rule rather than a
 * second copy of it. A unit is protected when its span touches any protected
 * range on its node — the guard would refuse a removal there, so the pass must
 * not ask either (`protected-content` is an impossible answer).
 */
export function protectedUnitIdsOf(snapshot: SessionSnapshot,
  units: readonly ProcessingUnit[]): readonly UnitId[] {
  const protection = computeProtectedRanges(snapshot);
  return units.filter(unit => overlaps(protection.ranges.get(unit.nodeId),
    unit.span.byteRange)).map(unit => unit.id);
}

/**
 * What the mount knows about each whole call, keyed by node id. The transcript
 * item is the only source: `toolName` and the target it named, never inferred
 * from the unit's text. A result with no item keeps its node's own evidence, so
 * the row still renders a call.
 */
export function callFactsOf(transcript: readonly DshTranscriptItem[],
): ReadonlyMap<string, PruneCallFacts> {
  const facts = new Map<string, PruneCallFacts>();
  for (const item of transcript) {
    if (item.role !== 'tool' || facts.has(item.id)) continue;
    const key = item.target?.key;
    facts.set(item.id, {
      ...(item.toolName.length > 0 ? { toolName: item.toolName } : {}),
      ...(key === undefined || key.length === 0 ? {} : { targetPath: key }),
    });
  }
  return facts;
}

/** Every tool-result node of a snapshot, in transcript order. */
function nodesOf(snapshot: SessionSnapshot): readonly ToolResultNode[] {
  return snapshot.nodes.filter((node): node is ToolResultNode => node.kind === 'tool-result');
}

/**
 * Runs one record-only pass. The only throw is a caller bug from core's own
 * planners (an invalid round, a foreign stamp); every host or model failure is
 * a journaled record and an empty judged layer.
 */
export async function runRecordOnlyPrune(
  options: RecordOnlyPruneOptions,
): Promise<RecordOnlyPruneOutcome> {
  const { sessionId, snapshot, journal } = options;
  const units = new UnitTracker({ sessionId, barBytes: options.barBytes }).units(snapshot);
  const nodes = nodesOf(snapshot);
  const episodes: readonly Episode[] = new EpisodeTracker({
    noNewPathSteps: options.episodeNoNewPathSteps,
  }).detect({ sessionId, results: nodes,
    currentStepOrdinal: snapshot.currentStepOrdinal,
    completedThroughTurnOrdinal: snapshot.completedThroughTurnOrdinal });
  const protectedUnitIds = protectedUnitIdsOf(snapshot, units);
  const plan = planPrunePass({
    units, nodes, episodes, protectedUnitIds,
    callFacts: callFactsOf(options.transcript),
    round: options.round,
    ...(options.tableOptions === undefined ? {} : { tableOptions: options.tableOptions }),
  });
  journal('prune-plan', { sessionId, round: plan.round, units: units.length,
    askRows: plan.askRows.length, tables: plan.tables.length,
    l1Removals: plan.l1.removals.length, protectedUnitIds });

  const refusedFor = refusalOf(options);
  if (refusedFor !== null || options.llm === undefined) {
    const outcome = recordOnlyOutcome(plan, null, refusedFor ?? 'no-llm-service', 0);
    journal('prune-off', { sessionId, round: plan.round,
      reason: refusedFor ?? 'no-llm-service', askRows: plan.askRows.length });
    journalPruneRecord(sessionId, outcome, journal);
    return outcome;
  }

  // No row to ask: no fork is needed and no model call is made. The merge still
  // reports L1's removals, which is the pass's whole provable layer.
  if (plan.askRows.length === 0) {
    const application = applyPruneAnswers(plan, [], { indices: [], stamps: plan.stamps });
    const outcome = recordOnlyOutcome(plan, application, null, 0);
    journalPruneRecord(sessionId, outcome, journal);
    return outcome;
  }

  const seeded = seedOnce(options, journal);
  if (seeded === null) {
    // No fork can exist without main's sent bytes; the pass asks nothing and
    // says so once, by name, instead of inventing a seed.
    journal('prune-unseeded', { sessionId, round: plan.round,
      askRows: plan.askRows.length, reason: 'no-seed',
      message: "main's sent request was never captured; no fork can be seeded" });
    const outcome = recordOnlyOutcome(plan, null, 'no-seed', 0);
    journalPruneRecord(sessionId, outcome, journal);
    return outcome;
  }
  const fork = forkOf(seeded, options, journal);
  if (fork === null) {
    const outcome = recordOnlyOutcome(plan, null, 'seed-refused', 0);
    journalPruneRecord(sessionId, outcome, journal);
    return outcome;
  }

  const loop = await runTables({ sessionId, stage: 'prune', round: plan.round, fork,
    rows: plan.askRows, stamps: plan.stamps, llm: options.llm,
    route: options.route(), journal,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const application = mergeSettled(plan, loop);
  const outcome = recordOnlyOutcome(plan, application, null, loop.answeredTables,
    { tables: loop.attempts, pass: loop.attemptTotals });
  journalPruneRecord(sessionId, outcome, journal);
  for (const removal of application.removals) {
    journal('prune-verdict', { sessionId, round: plan.round, unitId: removal.unitId,
      origin: removal.origin, action: removal.action,
      ...(removal.origin === 'l1' ? { rule: removal.rule } : {}) });
  }
  return outcome;
}

/**
 * Core's merge, fed the SETTLED verdicts: the table loop already read every
 * reply and carried every unanswered index to its one re-ask, so each answered
 * row is handed to `applyPruneAnswers` exactly once. The refused rows and the
 * stray keys come from the loop's own reading — a re-rendered answer text could
 * not carry their codes — and are spliced into the document core returned.
 */
function mergeSettled(plan: PrunePassPlan, loop: TableLoopOutcome): PrunePassApplication {
  const answered = [...loop.kept.entries()].sort(([left], [right]) => left - right);
  const text = answered.length === 0 ? [] : [JSON.stringify(Object.fromEntries(
    answered.map(([index, row]) => [String(index), wireAnswerOf(row.answer)])))];
  const base = applyPruneAnswers(plan, text, {
    indices: answered.map(([index]) => index), stamps: plan.stamps });
  const rows = new Map(plan.askRows.map(row => [row.index, row] as const));
  const position = new Map(plan.units.map((unit, at) => [unit.id, at] as const));
  const refused = [...base.refused];
  for (const [index, refusal] of loop.refused) {
    const row = rows.get(index);
    if (row === undefined) continue;
    refused.push({ unitId: row.unit.id, index, code: refusal.code,
      message: refusal.message, wireCode: refusal.wireCode, answerIndex: refusal.table });
  }
  refused.sort((left, right) => (position.get(left.unitId) ?? 0) - (position.get(right.unitId) ?? 0));
  const rejected = loop.rejected.map(entry => ({ key: entry.key, index: entry.index,
    code: entry.code, message: entry.message, answerIndex: entry.table }));
  return { ...base, refused, rejected };
}

/**
 * One settled answer back in the wire notation `applyPruneAnswers` reads. This
 * is the verdict's transport into core's merge, not a re-render of the ask: the
 * spans are the parser's normalized ones, so the second read is idempotent.
 */
function wireAnswerOf(answer: WireAnswer): Readonly<Record<string, unknown>> {
  const verdict = answer.verdict;
  if (verdict.action === 'keepall') return { keepall: true };
  if (verdict.action === 'forgetall') return { forgetall: verdict.summary ?? '' };
  return { keeplines: [...verdict.ranges.map(range => [range.from, range.to]),
    answer.keeplinesSummary ?? ''] };
}

/** Read main's last captured request, journaling a throwing reader as a refusal. */
function seedOnce(options: RecordOnlyPruneOptions, journal: MountJournal): CapturedMainRequest | null {
  try { return options.seed(); }
  catch (error) {
    journal('prune-seed-refused', { sessionId: options.sessionId, round: options.round,
      code: null, message: messageOf(error) });
    return null;
  }
}

/** Seed the fork from the capture, or journal why it could not be seeded. */
function forkOf(seeded: CapturedMainRequest, options: RecordOnlyPruneOptions,
  journal: MountJournal): WireFork | null {
  try {
    const fork = seedFork(seeded.wire);
    journal('prune-seed', { sessionId: options.sessionId, round: options.round,
      seedHash: seeded.seedHash, systemFromMessage: seeded.systemFromMessage,
      droppedMessages: seeded.droppedMessages, droppedBlocks: seeded.droppedBlocks,
      messages: seeded.wire.messages.length, tools: seeded.wire.tools.length });
    return fork;
  } catch (error) {
    journal('prune-seed-refused', { sessionId: options.sessionId, round: options.round,
      code: error instanceof ForkError ? error.code : null, message: messageOf(error) });
    return null;
  }
}

/** The route's own refusal, checked before any ask is composed. */
function refusalOf(options: RecordOnlyPruneOptions): PruneRefusalReason | null {
  if (options.llm === undefined) return 'no-llm-service';
  const route = options.route();
  if (route === null || route.provider.trim() === '' || route.model.trim() === '') {
    return 'not-configured';
  }
  return null;
}
