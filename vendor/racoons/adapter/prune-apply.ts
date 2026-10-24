/**
 * The mount's prune apply leg (ISSUE-022 chunk 6; ADR-0009, ADR-0012, ADR-0008).
 *
 * The pass itself is mount state read by mount code (`./prune.ts`), and it ends
 * with a merged decision document. This module is the ONE bridge from that
 * document to the engine's `{kind:'prune'}` input: the engine owns guard
 * validation, the single checkpoint-revert and the epoch break, so the mount
 * grows no second copy of any of them (ISSUE-022 §Comments 2026-10-23).
 *
 * Nothing here invents a verdict: a pass that produced no removal is not sent,
 * because an event with an empty document would only journal a `no-plan` skip.
 *
 * The event id is derived from the pass's own CONTENT, not from its round alone
 * (CRITIC-022 P2 #6). The engine dedupes a prune event by `eventId` against its
 * committed state, so an id that only carries the round makes two different
 * passes collide the moment the round repeats — and the round does repeat: a
 * corrupt `prune-round.json` reads as 0, and a failed write leaves the old
 * ordinal on disk, so a restarted process re-uses one. The engine would then
 * report the new pass as `applied` with the PRIOR pass's intent id and apply
 * nothing. Hashing the document splits those events while keeping the same
 * guarantee for a genuine replay: the same round with the same removals is the
 * same event, and it is still deduped rather than applied twice.
 *
 * Apply is gated by the configuration, never by this module: no window means
 * the auto trigger is off and the mount stays record-only (ADR-0008's rollout
 * order); `record-only` enforcement is the engine's own opt-out and it answers
 * `unchanged` without planning. Both cases reach here and are refused upstream,
 * so the check in `shouldApply` is about the pass having something to apply,
 * not about policy.
 */
import { canonicalBytesWithByteArrays, sha256Sync } from '@racoons/core';
import type { EngineResult, PrunePassApplication } from '@racoons/core';
import type { MountJournal } from './judge-seam.js';

/**
 * The engine event id for one pass: the session, the round for legibility, and
 * the document's own digest so a reused round over new content is a new event
 * (CRITIC-022 P2 #6). See the module comment for the replay it prevents.
 */
export function pruneEventId(sessionId: string, round: number,
  application: PrunePassApplication): string {
  const digest = sha256Sync(canonicalBytesWithByteArrays({
    round, removals: application.removals, kept: application.kept,
    refused: application.refused, rejected: application.rejected,
  }));
  return `dsh:${sessionId}:prune:${String(round)}:${digest}`;
}

/** The engine surface the bridge needs; the real engine satisfies it. */
export interface PruneApplyEngine {
  process(input: {
    readonly kind: 'prune';
    readonly eventId: string;
    readonly round: number;
    readonly verdicts: PrunePassApplication;
    readonly window: number;
  }): Promise<EngineResult>;
}

export interface PruneApplyOptions {
  readonly sessionId: string;
  readonly engine: PruneApplyEngine;
  /** The pass's merged document; `null` when no ask was sent. */
  readonly application: PrunePassApplication | null;
  /** The pass's round ordinal, the same one stamped on every index. */
  readonly round: number;
  /** The context window the trigger measured against; must be positive. */
  readonly windowTokens: number | null;
  /**
   * The mount's enforcement mode and the capability it can actually honour.
   * Both are READ for the journal line, never to decide anything here: the
   * engine is the only authority on whether a pass applies, and its answer is
   * what this bridge reports (CRITIC-022 P2 #8).
   */
  readonly enforcement?: string;
  readonly revertHistory?: boolean | undefined;
  readonly journal: MountJournal;
}

/**
 * Hands one pass to the engine. Answers the engine's result, or null when the
 * pass had nothing to apply or no window was configured (record-only rollout).
 *
 * Every skip names WHICH condition skipped it (CRITIC-022 P3 #9): a pass whose
 * ask never produced a document is `no-application`, one whose document holds
 * no removal is `no-removals`, and a mount with no window is `no-window`.
 * Before this split the first two shared `no-removals`, so a run could not tell
 * "the judge kept everything" from "the pass never asked".
 */
export async function applyPrunePass(options: PruneApplyOptions): Promise<EngineResult | null> {
  const { sessionId, application, round, windowTokens, journal } = options;
  if (application === null) {
    journal('prune-apply-skipped', { sessionId, round, reason: 'no-application' });
    return null;
  }
  if (application.removals.length === 0) {
    journal('prune-apply-skipped', { sessionId, round, reason: 'no-removals' });
    return null;
  }
  if (windowTokens === null) {
    // The apply leg is the second rollout stage; the first one records. A mount
    // with no window has not been told how big the context is, so the trigger
    // that would have fired this pass does not exist.
    journal('prune-apply-skipped', { sessionId, round, reason: 'no-window' });
    return null;
  }
  const eventId = pruneEventId(sessionId, round, application);
  let result: EngineResult;
  try {
    result = await options.engine.process({ kind: 'prune', eventId, round,
      verdicts: application, window: windowTokens });
  } catch (error) {
    // A host must always see its step finish; the engine's own failures land as
    // telemetry, so this is a caller bug and it is named, not thrown.
    journal('prune-apply-error', { sessionId, eventId, round,
      message: error instanceof Error ? error.message : String(error) });
    return null;
  }
  // The line states the terms the engine decided under, so an `unchanged` is
  // readable: `record-only` and a missing revert seam both answer `unchanged`
  // without ever planning, and without these two fields the run could not tell
  // them from a no-plan pass (CRITIC-022 P2 #8).
  journal('prune-apply', { sessionId, eventId, round, window: windowTokens,
    removals: application.removals.length, status: result.status,
    intentId: result.intentId,
    ...(options.enforcement === undefined ? {} : { enforcement: options.enforcement }),
    ...(options.revertHistory === undefined ? {} : { revertHistory: options.revertHistory }),
    issues: result.validation?.ok === false ? result.validation.issues : [] });
  return result;
}
