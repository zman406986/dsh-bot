import type { LedgerEntry } from '../ledger/types.js';
import type { MeterReading } from '../meter/token-meter.js';
import type { SessionSnapshot } from '../types/transcript.js';
import type { ForcedLossObservation, TelemetryEvent, TelemetrySink } from '../types/telemetry.js';
import { materializeEntries, metadata, receiptMatches } from './journal.js';

export type TranscriptReading = MeterReading | ForcedLossObservation;

/**
 * Salvage share for one revisit (PRD §6.9, §13): the kept suffix over every
 * suffix byte the cut measured, `keptBytes / (keptBytes + freedBytes)`.
 *
 * `null` when the cut measured no suffix bytes at all, the same convention
 * `MeterReading.cachedInputShare` uses for an undefined ratio: a measured zero
 * keeps is `0`, an empty measurement is `null`, and neither is `NaN`.
 */
export function salvageShare(keptBytes: number, freedBytes: number): number | null {
  const suffixBytes = keptBytes + freedBytes;
  return suffixBytes === 0 ? null : keptBytes / suffixBytes;
}

export function summarize(
  snapshot: SessionSnapshot, entries: readonly LedgerEntry[], readings: readonly TranscriptReading[],
) {
  const committed = new Map(entries.flatMap(({ event }) => event.sessionId === snapshot.sessionId
    && event.kind === 'applied' ? [[event.receipt.intentId, event.receipt] as const] : []));
  const measured = new Set<string>();
  const recallIds = new Set<string>();
  let removedBytes = 0;
  let generatedBytes = 0;
  for (const { event } of materializeEntries(entries)) {
    if (event.sessionId !== snapshot.sessionId || event.kind !== 'prepared'
      || measured.has(event.intentId)) continue;
    const receipt = committed.get(event.intentId);
    const details = metadata(event);
    if (details === null || receipt === undefined || !receiptMatches(event, receipt)) continue;
    measured.add(event.intentId);
    removedBytes += details.removedBytes;
    generatedBytes += details.generatedBytes;
    for (const id of details.recallIds) recallIds.add(id);
  }
  const losses = new Set<string>();
  let latestUsage: MeterReading | null = null;
  let tokensAtFirstForcedLoss: number | null = null;
  for (const reading of readings) {
    if (!('kind' in reading)) {
      latestUsage = reading;
    } else if (!losses.has(reading.nativeEventId)) {
      if (losses.size === 0 && latestUsage !== null) {
        tokensAtFirstForcedLoss = reading.inputTokensBefore ?? latestUsage.inputTokens;
      }
      losses.add(reading.nativeEventId);
    }
  }
  return {
    sessionId: snapshot.sessionId,
    transcriptBytes: snapshot.nodes.reduce((sum, node) => sum + node.bytes.length, 0),
    removedBytes, generatedBytes, recallIdsIssued: [...recallIds],
    recallIdCount: recallIds.size, forcedLossCount: losses.size, tokensAtFirstForcedLoss,
  };
}

export class TranscriptTelemetry {
  private readonly readings: TranscriptReading[] = [];
  private readonly losses = new Set<string>();
  private readonly requests = new Set<string>();
  private readonly sink: TelemetrySink | undefined;

  constructor(sink?: TelemetrySink) {
    this.sink = sink;
  }

  usage(reading: MeterReading): boolean {
    if (this.requests.has(reading.requestId)) return false;
    this.requests.add(reading.requestId);
    this.readings.push(structuredClone(reading));
    return true;
  }

  forcedLoss(observation: ForcedLossObservation): boolean {
    if (this.losses.has(observation.nativeEventId)) return false;
    this.losses.add(observation.nativeEventId);
    this.readings.push(structuredClone(observation));
    return true;
  }

  emit(event: TelemetryEvent): void {
    try {
      const returned: unknown = this.sink?.(structuredClone(event));
      // Also contain an async callback passed to the void-returning sink interface.
      if (returned instanceof Promise) void returned.catch(() => undefined);
    } catch { /* Observers cannot affect the transcript. */ }
  }

  summarize(snapshot: SessionSnapshot, entries: readonly LedgerEntry[]) {
    return summarize(snapshot, entries, this.readings);
  }
}
