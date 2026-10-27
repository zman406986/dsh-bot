import type { Meter } from '../meter/meter.js';
import type { SessionId, UnitId } from '../types/identity.js';
import type { SessionSnapshot } from '../types/transcript.js';
import type { ProcessingUnit } from '../units/types.js';
import { isCandidateNode, UnitTracker } from '../units/tracker.js';
import { canonicalManifestBytes } from '../util/bytes.js';
import { VerdictTracker } from '../verdicts/tracker.js';
import type { VerdictBatch, VerdictState } from '../verdicts/types.js';

/**
 * Every unit above the bar in the snapshot, in transcript order.
 *
 * This is the engine's single candidate set (ADR-0020 decision 1), and the only
 * lane the prune windows and `units/lookup.ts`'s forget resolution draw from.
 * `UnitTracker.units` is where scope is enforced: only tool-result nodes yield
 * units, so a message (system, developer, user or assistant) and a RACOONS
 * record are not candidates. The `isCandidateNode` filter here is a second lock
 * on the same rule, not a second rule: the tracker already excludes them, and a
 * unit that somehow arrived with a non-tool result's node id would still never
 * reach a prune.
 */
export function liveUnits(
  snapshot: SessionSnapshot, sessionId: SessionId, barBytes: number,
): readonly ProcessingUnit[] {
  const candidates = new Set(snapshot.nodes.filter(isCandidateNode).map(node => node.id));
  return new UnitTracker({ sessionId, barBytes }).units(snapshot)
    .filter(unit => candidates.has(unit.nodeId));
}

/**
 * The fixed, non-transcript part of a request: the system prompt and the tool
 * schemas. It is read from main's captured request object, never re-rendered
 * from config — the capture is the only record of the bytes the host actually
 * dispatched (ADR-0010; ADR-0009 §Amendment 2026-10-24).
 */
export interface RequestPrefix {
  readonly system: string;
  readonly tools: readonly unknown[];
}

/** One request's estimate, split so a journal can name the denominator it used. */
export interface ContentEstimate {
  /** Every live transcript node plus the incoming result, when there is one. */
  readonly contentTokens: number;
  /** The fixed system+tools prefix, measured on the captured request's bytes. */
  readonly prefixTokens: number;
  readonly totalTokens: number;
}

/**
 * The whole request's estimate: the fixed system+tools prefix plus every live
 * transcript node plus the incoming result. The context window prices the whole
 * request, so the half-window trigger's denominator includes the prefix
 * (ADR-0009 §Amendment 2026-10-24). `prefix: null` means no request has been
 * captured yet; the estimate is then transcript-only and a caller that reports
 * its denominator must say so.
 */
export function estimateContent(
  meter: Meter, snapshot: SessionSnapshot, incoming: Uint8Array | null,
  prefix: RequestPrefix | null,
): ContentEstimate {
  const contentTokens = snapshot.nodes.reduce(
    (sum, node) => sum + meter.estimate(node.bytes.slice()), 0,
  ) + (incoming === null ? 0 : meter.estimate(incoming.slice()));
  const prefixTokens = prefix === null ? 0 : meter.estimate(canonicalManifestBytes({
    system: prefix.system,
    tools: prefix.tools,
  }));
  return { contentTokens, prefixTokens, totalTokens: contentTokens + prefixTokens };
}

/** The same total estimate `planning.ts` uses, for callers that need no split. */
export function estimatedContentTokens(
  meter: Meter, snapshot: SessionSnapshot, incoming: Uint8Array | null,
  prefix: RequestPrefix | null,
): number {
  return estimateContent(meter, snapshot, incoming, prefix).totalTokens;
}

/**
 * The units a hand-built prune event names, in snapshot order. Absent ids are
 * dropped: a unit whose bytes changed since the pass planned no longer exists,
 * and the guard reports a removal for it as `unknown-unit` rather than this
 * helper inventing one.
 */
export function unitsFromWindow(
  snapshot: SessionSnapshot, sessionId: SessionId, barBytes: number, window: readonly UnitId[],
): readonly ProcessingUnit[] {
  const named = new Set(window);
  return liveUnits(snapshot, sessionId, barBytes).filter(unit => named.has(unit.id));
}

/**
 * Records the batch against the window. The tracker rejects duplicate and
 * out-of-window verdicts; those are not protocol answers and are dropped, which
 * leaves the guard the same view the pass had.
 */
export function judgeWindow(units: readonly ProcessingUnit[], batch: VerdictBatch): VerdictState {
  const round = Number.isSafeInteger(batch.round) && batch.round >= 0 ? batch.round : 0;
  const tracker = new VerdictTracker({ units, round });
  for (const verdict of batch.verdicts) tracker.judge(verdict);
  return tracker.state();
}
