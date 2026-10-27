/**
 * The record-only pass's outcome document and its one journal line (ISSUE-022
 * chunk 5; ADR-0009).
 *
 * Split from `./prune.ts` by concern: that module derives the mount's state and
 * runs the asks; this one turns a plan plus its merged answers into the counts
 * and writes exactly one `prune-recorded` record. The fields are core's own
 * (`pruneRecordOf`), so the mount's journal and the eventual engine event cannot
 * drift; the mount adds only `reason` (why no ask was sent) and `asks` (how many
 * display asks went out), which are host facts core does not know.
 */
import { pruneRecordOf } from '@racoons/core';
import type {
  PruneAttemptTelemetry, PrunePassApplication, PrunePassPlan, PruneRecordedFields, UnitId,
} from '@racoons/core';
import type { MountJournal } from './journal-kinds.js';

/** Why a pass moved no judged answer; journaled by name, never thrown. */
export type PruneRefusalReason =
  | 'no-llm-service' | 'not-configured' | 'internal-error' | 'no-seed' | 'seed-refused';

/**
 * The command form's text (ISSUE-022 §What we want, entry point 2). The mount
 * treats one user message whose entire text is this as an invocation, so the
 * entry needs no model-facing tool and no engine event: the mount owns the
 * trigger, the way it owns every other host seam.
 */
export const PRUNE_COMMAND = '/prune';

/** One `keeplines` answer's trailer, carried verbatim beside the counts. */
export interface PruneSummaryTrace {
  readonly unitId: UnitId;
  readonly summary: string;
}

export interface RecordOnlyPruneOutcome {
  readonly plan: PrunePassPlan;
  /** `null` when no ask was sent: nothing was judged, so nothing is claimed. */
  readonly application: PrunePassApplication | null;
  readonly record: PruneRecordedFields;
  /** Why no ask was sent; null when every batch was asked. */
  readonly refusedFor: PruneRefusalReason | null;
  /** How many display asks were sent and answered. */
  readonly asks: number;
  /** The table loop's attempt counters; null when no table was sent. */
  readonly attempts: PruneAttemptTelemetry | null;
  /** The `keeplines` trailers, verbatim, in removal order. */
  readonly keeplinesSummaries: readonly PruneSummaryTrace[];
}

/**
 * The outcome shape for one pass, shared by the asked and unasked paths.
 * `attempts` is the table loop's own reading (one entry per attempt group plus
 * the four pass totals); every unasked path passes null, which records as an
 * empty table list and all-zero totals — never a fabricated table.
 */
export function recordOnlyOutcome(plan: PrunePassPlan,
  application: PrunePassApplication | null, refusedFor: PruneRefusalReason | null,
  asks: number, attempts: PruneAttemptTelemetry | null = null): RecordOnlyPruneOutcome {
  const summaries: PruneSummaryTrace[] = [];
  for (const removal of application?.removals ?? []) {
    if (removal.origin === 'l2' && removal.action === 'keeplines'
      && removal.keeplinesSummary !== undefined) {
      summaries.push({ unitId: removal.unitId, summary: removal.keeplinesSummary });
    }
  }
  return { plan, application, record: pruneRecordOf(plan, application, attempts),
    refusedFor, asks, attempts, keeplinesSummaries: summaries };
}

/**
 * The one `prune-recorded` journal record of a pass. `reason` is null when the
 * ask ran; it names the missing seam otherwise, so an unasked pass is never
 * mistaken for a pass that asked and was answered.
 */
export function journalPruneRecord(sessionId: string, outcome: RecordOnlyPruneOutcome,
  journal: MountJournal): void {
  journal('prune-recorded', { sessionId, reason: outcome.refusedFor,
    ...outcome.record, asks: outcome.asks,
    keeplinesSummaries: outcome.keeplinesSummaries });
}
