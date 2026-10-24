/**
 * The judge's seam inside the mount (ISSUE-024 chunk 2; ISSUE-026 chunk 3): read
 * what the gate presented, run one fork pass, post one verdict batch.
 *
 * The engine is the source of the units. `presentGates` emits `gate-presented`
 * with the ids it listed and the round it asked; this module only remembers
 * that event (through the engine's own telemetry sink) and materialises the
 * matching `ProcessingUnit`s from the authoritative snapshot. Identity is never
 * this module's invention: a presented id the snapshot cannot reproduce is
 * `unit-absent`, and the gate keeps offering it.
 *
 * The pass itself is `./judge-pass.ts`: a fork seeded from main's last sent
 * request, grown append-only, one ask per table, one receipt to main. This file
 * owns only the mount's plumbing — the snapshot, the seed, the engine post and
 * the receipt append — and turns every refusal into a journal record, never an
 * exception into the host's step.
 *
 * The batch is posted whole, not one verdict event per answer: the gate settles
 * a window, so one incomplete event would spend a retry for no reason. Every
 * refusal is journaled by name and simply omitted from the batch; with zero
 * answers nothing is posted and the window stays open.
 */
import { UnitTracker } from '@racoons/core';
import type {
  AnchorMode, EngineInput, EngineResult, ProcessingUnit, SessionSnapshot, Verdict, UnitId,
} from '@racoons/core';
import type { DshTranscriptItem } from './envelope.js';
import { runJudgePass } from './judge-pass.js';
import type { JudgePassAsked, JudgePassRefusal } from './judge-pass.js';
import type { CapturedMainRequest } from './main-wire.js';
import type { DshLlmService, DshMountSession } from './plugin.js';

/** One presentation, as the engine's `gate-presented` telemetry names it. */
export interface PresentedWindow {
  readonly gate: 'turn' | 'revisit';
  readonly round: number;
  readonly unitIds: readonly UnitId[];
}

/** The route a judge call goes to: the host's resolved provider/model pair. */
export interface JudgeRoute {
  readonly provider: string;
  readonly model: string;
}

/** One unit's outcome, as the mount reports it. */
export type JudgeAsked = JudgePassAsked;

export interface JudgeSettleOutcome {
  readonly presented: PresentedWindow | null;
  readonly asked: readonly JudgeAsked[];
  readonly verdicts: number;
  readonly result: EngineResult | null;
  /** The one receipt this pass appended to main; null when no pass ran. */
  readonly receipt: string | null;
}

/**
 * The journal seam, re-exported from `./journal-kinds.ts` so every existing
 * import keeps working. The vocabulary is a closed const list there, so a
 * misspelled kind is a compile error rather than a line no reader greps for
 * (CRITIC-022 P3 #14).
 */
export type { MountJournal, RacoonsJournalKind } from './journal-kinds.js';
export { RACOONS_JOURNAL_KINDS } from './journal-kinds.js';
import type { MountJournal } from './journal-kinds.js';

export interface JudgeSeamOptions {
  readonly sessionId: string;
  readonly engine: { process(input: EngineInput): Promise<EngineResult> };
  readonly port: {
    snapshot(): Promise<SessionSnapshot>;
    transcript(): readonly DshTranscriptItem[];
  };
  /** The host's model seam; absent means the mount cannot answer a gate. */
  readonly llm?: DshLlmService;
  readonly barBytes: number;
  readonly route: () => JudgeRoute | null;
  readonly journal: MountJournal;
  /**
   * The anchored arm (ISSUE-021 point 6). A fork ask always carries the table's
   * own quoted samples, so the arm is inherent here; the option stays accepted
   * so a config row and the journal keep the same surface.
   */
  readonly anchors?: AnchorMode;
  readonly timeoutMs?: number;
  /** Main's last captured sent request, or null when none was seen yet. */
  readonly seed?: () => CapturedMainRequest | null;
  /** Recall ids the last applied application minted, cleared by the read. */
  readonly recallIds?: () => readonly string[];
  /**
   * The one append seam: one user-role receipt per pass, and none of the fork's
   * dialogue. A host that cannot append here is journaled, never thrown.
   */
  readonly appendReceipt?: (text: string) => void;
}

export interface JudgeSeam {
  /** Remember the engine's own presentation event; anything else is ignored. */
  capture(event: unknown): void;
  /** Ask every presented unit, then post the answered ones as one batch. */
  settle(signal?: AbortSignal): Promise<JudgeSettleOutcome>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function presentationOf(event: unknown): PresentedWindow | null {
  if (!isRecord(event) || event['kind'] !== 'gate-presented') return null;
  const gate = event['gate'];
  const round = event['round'];
  const unitIds = event['unitIds'];
  if ((gate !== 'turn' && gate !== 'revisit') || typeof round !== 'number'
    || !Number.isSafeInteger(round) || round < 1 || !Array.isArray(unitIds)) return null;
  const ids = unitIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length === unitIds.length ? { gate, round, unitIds: ids } : null;
}

/**
 * The host's resolved route, read from the live session's own request header,
 * or the caller's fallback pair. `null` means no judge call can be made: the
 * seam refuses with `not-configured` instead of guessing a model.
 */
export function judgeRouteOf(host: DshMountSession | null | undefined,
  fallback?: JudgeRoute): JudgeRoute | null {
  if (fallback !== undefined) return fallback;
  const header = typeof host?.requestHeader === 'function' ? host.requestHeader() : undefined;
  const config = isRecord(header) && isRecord(header['config']) ? header['config'] : null;
  if (config === null) return null;
  const provider = typeof config['provider'] === 'string' ? config['provider'] : null;
  const model = typeof config['model'] === 'string' ? config['model'] : null;
  return provider === null || model === null || provider === '' || model === ''
    ? null : { provider, model };
}

export function createJudgeSeam(options: JudgeSeamOptions): JudgeSeam {
  let pending: PresentedWindow | null = null;
  const { sessionId, journal } = options;

  async function settle(signal?: AbortSignal): Promise<JudgeSettleOutcome> {
    const presented = pending;
    pending = null;
    if (presented === null) {
      return { presented: null, asked: [], verdicts: 0, result: null, receipt: null };
    }
    const llm = options.llm;
    if (llm === undefined) {
      // A mount with no model seam cannot answer a gate. The window stays open
      // and the fact is named once per presentation; nothing is retried here.
      journal('judge-off', { sessionId, gate: presented.gate, round: presented.round,
        unitIds: presented.unitIds, reason: 'no-llm-service' });
      return { presented, asked: [], verdicts: 0, result: null, receipt: null };
    }
    const snapshot = await options.port.snapshot();
    // The snapshot is the authoritative unit source; the gate's own ids resolve
    // against it, never against the mount's queue.
    const units: readonly ProcessingUnit[] =
      new UnitTracker({ sessionId, barBytes: options.barBytes }).units(snapshot);
    const nodes = new Map(snapshot.nodes.flatMap(node =>
      node.kind === 'tool-result' ? [[node.id, node] as const] : []));
    const route = options.route();
    const eventId = `dsh:${sessionId}:verdict:${presented.gate}:${String(presented.round)}`;
    const passed = await runJudgePass({
      sessionId, window: presented, units, nodes, llm, route,
      seed: options.seed ?? (() => null),
      journal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
      post: async (verdicts: readonly Verdict[], window: readonly UnitId[]) =>
        options.engine.process({ kind: 'verdict', eventId,
          verdicts: { round: presented.round, verdicts: [...verdicts] }, window }),
      ...(options.recallIds === undefined ? {} : { recallIds: options.recallIds }),
      ...(options.appendReceipt === undefined ? {} : { appendReceipt: options.appendReceipt }),
    });
    return { presented, asked: passed.asked, verdicts: passed.verdicts,
      result: passed.result, receipt: passed.receipt };
  }

  return {
    capture(event) {
      const presentation = presentationOf(event);
      if (presentation !== null) pending = presentation;
    },
    settle,
  };
}

/** Re-exported for callers that only need the refusal vocabulary. */
export type { JudgePassRefusal };
