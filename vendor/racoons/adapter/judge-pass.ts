/**
 * The judge pass on a fork of main's wire state (ISSUE-026 chunk 3, ADR-0010).
 *
 * One pass: resolve the units the gate presented, seed a fork from main's last
 * captured request (`seedFork`, byte-copied, hash-asserted), grow it through
 * the tables of `./judge-tables.ts`, post the answered verdicts to the engine
 * as one batch, and append exactly ONE user-role receipt to main through the
 * caller's append seam. None of the fork's dialogue enters main's history.
 *
 * The fork's `system` bytes are main's, untouched: the judge contract rides
 * INSIDE the ask text, because replacing the system slot would change byte 0 of
 * the prefix the fork exists to have served from cache (ADR-0010). The table
 * contract is the core's own shipped asset, carried verbatim.
 *
 * Fail-open is the rule for every non-answer. A pass that could not seed asks
 * nothing (no fork can exist without main's sent bytes), settles its round
 * empty, and appends no receipt: it changed nothing in main. Every other
 * refusal is journaled by name and omitted from the batch, as before.
 */
import {
  ForkError, buildPruneAskRows, seedFork,
} from '@racoons/core';
import type {
  EngineResult, NodeId, ProcessingUnit, ToolResultNode, UnitId, Verdict, WireFork,
} from '@racoons/core';
import { appendPassReceipt } from './judge-receipt.js';
import type { MountJournal } from './judge-seam.js';
import type { CapturedMainRequest } from './main-wire.js';
import type { DshLlmService } from './plugin.js';
import { runTables } from './judge-tables.js';

export { JUDGE_TABLE_UNITS } from './judge-tables.js';

/** The gate window a pass answers: which gate asked, and its round ordinal. */
export interface JudgePassWindow {
  readonly gate: 'turn' | 'revisit';
  readonly round: number;
  readonly unitIds: readonly UnitId[];
}

/** Why a pass produced no verdict for one unit, as data. */
export type JudgePassRefusal =
  | import('./judge.js').JudgeFailureReason
  | 'unit-absent' | 'no-seed' | 'seed-refused' | 'no-verdict';

export interface JudgePassAsked {
  readonly unitId: UnitId;
  readonly status: 'answered' | 'refused' | 'skipped';
  readonly reason: JudgePassRefusal | null;
  readonly code: string | null;
  readonly action: Verdict['action'] | null;
  readonly keeplinesSummary: string | null;
}

export interface JudgePassOptions {
  readonly sessionId: string;
  readonly window: JudgePassWindow;
  /** Every unit of the authoritative snapshot; the window's ids resolve here. */
  readonly units: readonly ProcessingUnit[];
  /** Snapshot nodes by id, so each table row can quote its unit's bytes. */
  readonly nodes: ReadonlyMap<NodeId, ToolResultNode>;
  readonly llm: DshLlmService;
  readonly route: { readonly provider: string; readonly model: string } | null;
  /** Main's last captured sent request; null means this pass cannot seed. */
  readonly seed: () => CapturedMainRequest | null;
  readonly journal: MountJournal;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Post the answered batch; the engine settles the presented window. */
  readonly post: (verdicts: readonly Verdict[], window: readonly UnitId[]) => Promise<EngineResult>;
  /** Recall ids the post's application minted, cleared by the read. */
  readonly recallIds?: () => readonly string[];
  /** The one append seam: exactly one user-role receipt per pass that asked. */
  readonly appendReceipt?: (text: string) => void;
}

export interface JudgePassOutcome {
  readonly asked: readonly JudgePassAsked[];
  readonly verdicts: number;
  readonly result: EngineResult | null;
  readonly receipt: string;
  readonly seeded: boolean;
  readonly seedHash: string | null;
  readonly tables: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One unit resolved against the snapshot: the unit, and its node when it has one. */
interface Resolved {
  readonly unit: ProcessingUnit;
  readonly node?: ToolResultNode;
}

/**
 * Run one judge pass and return its outcome. The only side effects are the fork
 * appends, the model calls, the engine post and the one receipt.
 */
export async function runJudgePass(options: JudgePassOptions): Promise<JudgePassOutcome> {
  const { sessionId, window, journal } = options;
  const byId = new Map(options.units.map(unit => [unit.id, unit]));
  const asked = new Map<UnitId, JudgePassAsked>();
  const seen = new Set<UnitId>();
  // The window's own order, its duplicates dropped: the batch answers exactly
  // the order the gate presented. Identity is never this module's invention: an
  // id the snapshot cannot reproduce is skipped, and the gate keeps offering it.
  const resolved: Resolved[] = [...window.unitIds].flatMap(unitId => {
    if (seen.has(unitId)) return [];
    seen.add(unitId);
    const unit = byId.get(unitId);
    if (unit === undefined) {
      journal('judge-skip', { sessionId, unitId, gate: window.gate, round: window.round,
        reason: 'unit-absent',
        message: `the presented unit is not in the authoritative snapshot (${String(options.units.length)} units)` });
      asked.set(unitId, { unitId, status: 'skipped', reason: 'unit-absent', code: null,
        action: null, keeplinesSummary: null });
      return [];
    }
    const node = options.nodes.get(unit.nodeId);
    return [node === undefined ? { unit } : { unit, node }];
  });

  const seeded = seedOnce(options, journal);
  if (seeded === null) {
    // No fork can exist without main's sent bytes; the pass asks nothing and
    // says so once, by name, instead of guessing a seed.
    journal('judge-unseeded', { sessionId, gate: window.gate, round: window.round,
      unitIds: window.unitIds, reason: 'no-seed',
      message: "main's sent request was never captured; no fork can be seeded" });
  }
  const fork = seeded === null ? null : forkOf(seeded, options, journal);
  const rows = fork === null ? [] : buildPruneAskRows(resolved.map(item =>
    item.node === undefined ? { unit: item.unit } : { unit: item.unit, node: item.node }));
  const stamps = new Map(rows.map(row => [row.index,
    { unitId: row.unit.id, answeredInRound: window.round }]));
  const loop = fork === null ? null : await runTables({ sessionId, stage: 'judge',
    gate: window.gate, round: window.round, fork, rows, stamps, llm: options.llm,
    route: options.route, journal,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }) });

  // One verdict per resolved unit, in window order: the gate presented them in
  // that order and the batch answers exactly that window.
  const rowByUnit = new Map(rows.map(row => [row.unit.id, row]));
  const verdicts: Verdict[] = [];
  // The `keeplines` trailer is the answer's own description of what it dropped;
  // the verdict type has no slot for it, so it rides beside the batch.
  const summaries: { unitId: UnitId; summary: string }[] = [];
  for (const item of resolved) {
    const row = rowByUnit.get(item.unit.id);
    const answer = row === undefined ? undefined : loop?.kept.get(row.index);
    if (row !== undefined && answer !== undefined) {
      const summary = answer.answer.keeplinesSummary ?? null;
      if (summary !== null) summaries.push({ unitId: item.unit.id, summary });
      journal('judge-ask', { sessionId, unitId: item.unit.id, gate: window.gate,
        round: window.round, status: 'answered', action: answer.answer.verdict.action,
        keeplinesSummary: summary, index: row.index, tables: loop?.tables ?? 0 });
      asked.set(item.unit.id, { unitId: item.unit.id, status: 'answered', reason: null,
        code: null, action: answer.answer.verdict.action, keeplinesSummary: summary });
      verdicts.push(answer.answer.verdict);
      continue;
    }
    const refusal = row === undefined ? undefined : loop?.refused.get(row.index);
    const reason: JudgePassRefusal = loop === null
      ? (seeded === null ? 'no-seed' : 'seed-refused') : 'no-verdict';
    journal('judge-skip', { sessionId, unitId: item.unit.id, gate: window.gate,
      round: window.round, reason, code: refusal?.code ?? null,
      message: refusal?.message ?? 'the pass produced no verdict for this unit',
      index: row?.index ?? null, tables: loop?.tables ?? 0 });
    asked.set(item.unit.id, { unitId: item.unit.id, status: 'refused', reason,
      code: refusal?.code ?? null, action: null, keeplinesSummary: null });
  }

  const result = await postBatch(options, verdicts, summaries, journal);
  const receipt = appendReceipt(options, verdicts, result, seen.size, loop !== null);
  return { asked: [...seen].flatMap(unitId => asked.get(unitId) ?? []),
    verdicts: verdicts.length, result, receipt, seeded: seeded !== null,
    seedHash: seeded?.seedHash ?? null, tables: loop?.tables ?? 0 };
}

/** Read main's last captured request, journaling a throwing reader as a refusal. */
function seedOnce(options: JudgePassOptions, journal: MountJournal): CapturedMainRequest | null {
  try { return options.seed(); }
  catch (error) {
    journal('judge-seed-refused', { sessionId: options.sessionId, gate: options.window.gate,
      round: options.window.round, code: null, message: messageOf(error) });
    return null;
  }
}

/** Seed the fork from the capture, or journal why it could not be seeded. */
function forkOf(seeded: CapturedMainRequest, options: JudgePassOptions,
  journal: MountJournal): WireFork | null {
  const { sessionId, window } = options;
  try {
    const fork = seedFork(seeded.wire);
    journal('judge-seed', { sessionId, gate: window.gate, round: window.round,
      seedHash: seeded.seedHash, systemFromMessage: seeded.systemFromMessage,
      droppedMessages: seeded.droppedMessages, droppedBlocks: seeded.droppedBlocks,
      messages: seeded.wire.messages.length, tools: seeded.wire.tools.length });
    return fork;
  } catch (error) {
    journal('judge-seed-refused', { sessionId, gate: window.gate, round: window.round,
      code: error instanceof ForkError ? error.code : null, message: messageOf(error) });
    return null;
  }
}

/** Post the answered batch. The empty batch still settles the round. */
async function postBatch(options: JudgePassOptions, verdicts: readonly Verdict[],
  summaries: readonly { unitId: UnitId; summary: string }[],
  journal: MountJournal): Promise<EngineResult> {
  const { sessionId, window } = options;
  const eventId = `dsh:${sessionId}:verdict:${window.gate}:${String(window.round)}`;
  if (verdicts.length === 0) {
    journal('verdict-empty', { sessionId, gate: window.gate, round: window.round,
      unitIds: window.unitIds, reason: 'no-answers' });
  }
  journal('verdict-posted', { sessionId, eventId, gate: window.gate, round: window.round,
    window: window.unitIds,
    verdicts: verdicts.map(verdict => verdict.unitId),
    actions: verdicts.map(verdict => verdict.action),
    keeplinesSummaries: summaries });
  const result = await options.post(verdicts, window.unitIds);
  const issues = result.validation?.ok === false ? result.validation.issues : [];
  journal('verdict-settled', { sessionId, eventId, gate: window.gate, round: window.round,
    status: result.status, intentId: result.intentId, receipt: result.receipt,
    issueCodes: [...new Set(issues.map(issue => issue.code))], issues });
  return result;
}

/**
 * Build and append the pass's one receipt; a pass that asked nothing appends
 * none. The recall-id reader is a drain, so it is called on every pass even
 * when nothing was applied, and its value is dropped.
 */
function appendReceipt(options: JudgePassOptions, verdicts: readonly Verdict[],
  result: EngineResult, units: number, asking: boolean): string {
  return appendPassReceipt({ round: options.window.round, gate: options.window.gate,
    units, asking, verdicts, result, mintedRecallIds: options.recallIds?.() ?? [],
    ...(options.appendReceipt === undefined ? {} : { append: options.appendReceipt }),
    onAppendError: (error: unknown) => {
      options.journal('judge-receipt-error', { sessionId: options.sessionId,
        gate: options.window.gate, round: options.window.round, message: messageOf(error) });
    } });
}
