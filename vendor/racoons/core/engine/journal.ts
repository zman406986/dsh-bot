import type { BreakerState, ValidatedApplication } from '../guard/types.js';
import type { ApplyReceipt, Ledger, LedgerEntry, LedgerEvent, PreparedIntent } from '../ledger/types.js';
import type { RecallId, SourceRef } from '../types/identity.js';

type PreparedEvent = Extract<LedgerEvent, { readonly kind: 'prepared' }>;
export interface EnginePreparedEvent extends PreparedEvent {
  readonly engine: {
    readonly intent: PreparedIntent;
    readonly sealedEpisodeIds: readonly string[];
    readonly removedBytes: number;
    readonly generatedBytes: number;
    readonly recallIds: readonly RecallId[];
    readonly sources: readonly { readonly source: SourceRef; readonly recallId: RecallId }[];
    readonly noticeRecordId: string | null;
  };
}

type Candidate = Omit<EnginePreparedEvent['engine'], 'intent'> & {
  readonly identity: Omit<PreparedIntent, 'intentId'>;
};
type CandidateEvent = Extract<LedgerEvent, { readonly kind: 'validation' }> & {
  readonly engineCandidate: Candidate;
};

// Persist metadata before prepare(), so a crash between prepare and host apply
// can still associate the pending intent with its original event. No bodies stored.
export async function recordCandidate(
  ledger: Ledger, application: ValidatedApplication, noticeRecordId: string | null,
): Promise<void> {
  const state = breakerState(await readEntries(ledger, application.sessionId));
  const event: CandidateEvent = {
    kind: 'validation', sessionId: application.sessionId,
    eventKey: `engine-candidate:${JSON.stringify([application.sessionId, application.eventId,
      application.applicationSha256])}`, atMs: application.createdAtMs,
    eventId: application.eventId, ok: true, issues: [], breaker: state,
    engineCandidate: {
      identity: { sessionId: application.sessionId, eventId: application.eventId,
        baseRevision: application.baseRevision, applicationSha256: application.applicationSha256 },
      sealedEpisodeIds: application.sealedEpisodeIds, ...applicationMeasurements(application),
      noticeRecordId,
      sources: application.archives.flatMap(archive => archive.recall.parts.map(part => ({
        source: part.source, recallId: archive.recall.id,
      }))),
    },
  };
  await ledger.append(event);
}

export async function readEntries(ledger: Ledger, sessionId: string): Promise<LedgerEntry[]> {
  const entries: LedgerEntry[] = [];
  for await (const entry of ledger.events(sessionId)) {
    if (entry.event.sessionId !== sessionId) throw new Error('Ledger returned another session');
    entries.push(structuredClone(entry));
  }
  return materializeEntries(entries);
}

export function materializeEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const candidates = new Map<string, Candidate>();
  for (const { event } of entries) {
    if (event.kind === 'validation' && 'engineCandidate' in event) {
      const candidate = event.engineCandidate as Candidate;
      candidates.set(candidate.identity.applicationSha256, candidate);
    }
  }
  return entries.map(entry => {
    const { event } = entry;
    if (event.kind !== 'prepared' || metadata(event) !== null) return entry;
    const candidate = candidates.get(event.applicationSha256);
    if (candidate === undefined || candidate.identity.sessionId !== event.sessionId) return entry;
    const { identity, ...details } = candidate;
    const enriched: EnginePreparedEvent = { ...event, engine: {
      ...details, intent: { ...identity, intentId: event.intentId },
    } };
    return { ...entry, event: enriched };
  });
}

export function metadata(event: LedgerEvent): EnginePreparedEvent['engine'] | null {
  if (event.kind !== 'prepared' || !('engine' in event)) return null;
  const value: unknown = event.engine;
  if (typeof value !== 'object' || value === null || !('intent' in value)) return null;
  return value as EnginePreparedEvent['engine'];
}

export function receiptMatches(prepared: PreparedEvent, receipt: ApplyReceipt): boolean {
  const details = metadata(prepared);
  return receipt.intentId === prepared.intentId
    && receipt.sessionId === prepared.sessionId
    && receipt.applicationSha256 === prepared.applicationSha256
    && typeof receipt.baseRevision === 'string' && receipt.baseRevision.length > 0
    && typeof receipt.resultRevision === 'string' && receipt.resultRevision.length > 0
    && receipt.resultRevision !== receipt.baseRevision
    && Number.isSafeInteger(receipt.appliedAtMs) && receipt.appliedAtMs >= 0
    && (details === null || receipt.baseRevision === details.intent.baseRevision);
}

/**
 * The breaker's state as the durable record states it: the last validation's
 * own reading. The `breaker-disabled` event is a notice marker, not a latch — a
 * later completed validation writes `disabled: false`, and re-deriving from the
 * marker would resurrect a disable the session already cleared (ISSUE-057).
 */
export function breakerState(entries: readonly LedgerEntry[]): BreakerState {
  let state: BreakerState = { consecutiveValidationFailures: 0, disabled: false };
  for (const { event } of entries) {
    if (event.kind === 'validation') state = event.breaker;
  }
  return state;
}

export function applicationMeasurements(application: ValidatedApplication) {
  const removedBytes = application.archives.reduce((total, archive) => total
    + archive.recall.parts.reduce((sum, part) => sum + part.removedRanges.reduce(
      (count, item) => count + item.range.endByteExclusive - item.range.startByte, 0), 0), 0);
  const generatedBytes = application.appendRecords.reduce((sum, record) => sum + record.bytes.length, 0)
    + application.replacements.reduce((sum, replacement) => sum + replacement.generatedRanges.reduce(
      (count, range) => count + range.endByteExclusive - range.startByte, 0), 0);
  return {
    removedBytes, generatedBytes,
    recallIds: [...new Set(application.archives.map(archive => archive.recall.id))],
  };
}

export async function recordPrepared(
  ledger: Ledger, intent: PreparedIntent, application: ValidatedApplication,
  noticeRecordId: string | null = null,
): Promise<EnginePreparedEvent> {
  const event: EnginePreparedEvent = {
    kind: 'prepared', sessionId: intent.sessionId,
    eventKey: `engine-prepared:${intent.intentId}`, atMs: application.createdAtMs,
    intentId: intent.intentId, applicationSha256: intent.applicationSha256,
    engine: {
      intent, sealedEpisodeIds: application.sealedEpisodeIds,
      ...applicationMeasurements(application), noticeRecordId,
      sources: application.archives.flatMap(archive => archive.recall.parts.map(part => ({
        source: part.source, recallId: archive.recall.id,
      }))),
    },
  };
  await ledger.append(event);
  return event;
}

export async function recordApplied(ledger: Ledger, receipt: ApplyReceipt): Promise<void> {
  await ledger.append({
    kind: 'applied', sessionId: receipt.sessionId, eventKey: `engine-applied:${receipt.intentId}`,
    atMs: receipt.appliedAtMs, receipt,
  });
}
