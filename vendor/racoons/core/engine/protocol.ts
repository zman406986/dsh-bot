import type { RacoonsConfig } from '../config.js';
import { overlaps } from '../guard/bytes.js';
import { computeProtectedRanges } from '../guard/protection.js';
import { RevisitGate } from '../gates/revisit.js';
import { TurnGate } from '../gates/turn-gate.js';
import type { GateBudget } from '../gates/types.js';
import type { Meter } from '../meter/meter.js';
import type { SessionId, UnitId } from '../types/identity.js';
import type { Clock, SessionSnapshot } from '../types/transcript.js';
import type { TelemetrySink } from '../types/telemetry.js';
import type { ProcessingUnit } from '../units/types.js';
import { UnitTracker } from '../units/tracker.js';
import { canonicalManifestBytes } from '../util/bytes.js';
import { VerdictTracker } from '../verdicts/tracker.js';
import type { VerdictBatch, VerdictState } from '../verdicts/types.js';

/** The two gates the engine drives, one instance each for the session. */
export interface ProtocolGates {
  readonly turn: TurnGate;
  readonly revisit: RevisitGate;
}

export interface ProtocolGateOptions {
  readonly sessionId: SessionId;
  readonly config: RacoonsConfig;
  readonly clock: Clock;
  readonly onTelemetry: TelemetrySink;
  /** The circuit-breaker probe the gates read at the top of `present`. */
  readonly enabled: () => boolean;
}

/**
 * Builds the session's gates once. Gate state is per session by design: a turn
 * gate remembers answers (incremental completion), and a revisit gate keeps its
 * one-shot mark, so constructing fresh gates per event would re-ask judged
 * units. The breaker probe is a closure: the engine updates what it reads.
 */
export function protocolGates(options: ProtocolGateOptions): ProtocolGates {
  const budget: GateBudget = {
    advertisedLabelLimit: options.config.protocol.advertisedLabelLimit,
    retryLimit: options.config.protocol.retryLimit,
  };
  const common = {
    sessionId: options.sessionId,
    budget,
    clock: options.clock,
    onTelemetry: options.onTelemetry,
    enabled: options.enabled,
  };
  return {
    turn: new TurnGate(common),
    revisit: new RevisitGate({ ...common, revisitShare: options.config.protocol.revisitShare }),
  };
}

/** Every unit above the bar in the snapshot, in transcript order. */
export function liveUnits(
  snapshot: SessionSnapshot, sessionId: SessionId, barBytes: number,
): readonly ProcessingUnit[] {
  return new UnitTracker({ sessionId, barBytes }).units(snapshot);
}

/**
 * The units a gate may put to the agent: above the bar, and not intersecting
 * live-protected bytes. A verdict on a protected unit could never be applied
 * (the guard refuses `protected-content`), so offering it would spend an ask on
 * an answer that is guaranteed to be rejected — two such refusals disable the
 * session. The guard still recomputes protection independently; this only
 * avoids asking a question that has no legal answer.
 */
export function askableUnits(
  snapshot: SessionSnapshot, sessionId: SessionId, barBytes: number,
): readonly ProcessingUnit[] {
  const protection = computeProtectedRanges(snapshot);
  return liveUnits(snapshot, sessionId, barBytes).filter(unit => {
    const ranges = protection.ranges.get(unit.nodeId) ?? [];
    return !ranges.some(range => overlaps(range, unit.span.byteRange));
  });
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

/** Deduplicates by unit id, keeping the first occurrence; window order is listing order. */
export function mergeUnits(
  existing: readonly ProcessingUnit[], listed: readonly ProcessingUnit[],
): readonly ProcessingUnit[] {
  const seen = new Set<UnitId>();
  const merged: ProcessingUnit[] = [];
  for (const unit of [...existing, ...listed]) {
    if (seen.has(unit.id)) continue;
    seen.add(unit.id);
    merged.push(unit);
  }
  return merged;
}

/**
 * The units a hand-built verdict event names, in snapshot order. Absent ids are
 * dropped: a unit whose bytes changed since presentation no longer exists, and
 * the guard reports a verdict for it as `unknown-unit` rather than this helper
 * inventing one.
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
 * leaves the guard the same view the gate had.
 */
export function judgeWindow(units: readonly ProcessingUnit[], batch: VerdictBatch): VerdictState {
  const round = Number.isSafeInteger(batch.round) && batch.round >= 0 ? batch.round : 0;
  const tracker = new VerdictTracker({ units, round });
  for (const verdict of batch.verdicts) tracker.judge(verdict);
  return tracker.state();
}
