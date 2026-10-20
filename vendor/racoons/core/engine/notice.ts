import { applicationBytes } from '../guard/application.js';
import type { ApplicationBody } from '../guard/application.js';
import type { ValidatedApplication } from '../guard/types.js';
import type { LedgerEntry } from '../ledger/types.js';
import type { SessionSnapshot } from '../types/transcript.js';
import { sha256 } from '../util/hash.js';
import { applyApplication } from './application.js';
import { metadata } from './journal.js';
import type { TranscriptTelemetry } from './telemetry.js';
import type { EngineOptions } from './types.js';

export async function persistBreaker(
  options: EngineOptions, fallbackTurn: number, entries: readonly LedgerEntry[],
): Promise<void> {
  if (entries.some(({ event }) => event.kind === 'breaker-disabled')) return;
  const failure = entries.find(({ event }) => event.kind === 'validation' && event.breaker.disabled)?.event;
  const turn = failure !== undefined && 'engineTurnOrdinal' in failure
    && typeof failure.engineTurnOrdinal === 'number' ? failure.engineTurnOrdinal : fallbackTurn;
  await options.ledger.append({ kind: 'breaker-disabled', sessionId: options.sessionId,
    eventKey: `engine-breaker-disabled:${options.sessionId}`, atMs: failure?.atMs ?? options.clock.nowMs(),
    turnOrdinal: turn, reason: 'two-validation-failures' });
}

export async function announceBreaker(
  options: EngineOptions, telemetry: TranscriptTelemetry, snapshot: SessionSnapshot,
  entries: readonly LedgerEntry[], confirmedNotices: ReadonlySet<string>,
): Promise<'done' | 'blocked'> {
  const disabled = entries.find(({ event }) => event.kind === 'breaker-disabled');
  if (disabled?.event.kind !== 'breaker-disabled'
    || snapshot.currentTurnOrdinal <= disabled.event.turnOrdinal) return 'done';
  const recordId = `racoons:breaker-disabled:${options.sessionId}`;
  if (entries.some(({ event }) => event.kind === 'breaker-announced' && event.recordId === recordId)) return 'done';
  if (confirmedNotices.has(recordId)
    || snapshot.nodes.some(node => node.kind === 'racoons-record' && node.recordId === recordId)) {
    await markAnnounced(options, recordId);
    return 'done';
  }
  if (!options.capabilities.appendRecords) return 'done';
  const abandoned = new Set(entries.flatMap(({ event }) => event.kind === 'abandoned' ? [event.intentId] : []));
  if (entries.some(({ event }) => {
    const details = metadata(event);
    return event.kind === 'prepared' && abandoned.has(event.intentId)
      && details?.noticeRecordId === recordId && details.intent.baseRevision === snapshot.revision;
  })) return 'done';
  const bytes = new TextEncoder().encode('RACOONS disabled after two validation failures. Recall remains available.');
  const record = { recordId, bytes, sha256: await sha256(bytes) };
  const content: ApplicationBody = {
    sessionId: options.sessionId, eventId: recordId, baseRevision: snapshot.revision,
    phase: 'at-rest', mode: 'append',
    replacements: [], appendRecords: [record], archives: [], sealedEpisodeIds: [],
    createdAtMs: disabled.event.atMs,
  };
  // The disabled Guard cannot issue a notice. This narrowly scoped application
  // contains no source replacements, archive removals, or rule-provided bytes.
  const application = { ...content,
    applicationSha256: await sha256(applicationBytes(content)),
  } as ValidatedApplication;
  const outcome = await applyApplication(options, telemetry, application, recordId);
  if (outcome.status === 'applied') await markAnnounced(options, recordId);
  return outcome.status === 'recovery-pending' ? 'blocked' : 'done';
}

async function markAnnounced(options: EngineOptions, recordId: string): Promise<void> {
  await options.ledger.append({
    kind: 'breaker-announced', sessionId: options.sessionId,
    eventKey: `engine-breaker-announced:${options.sessionId}`,
    atMs: options.clock.nowMs(), recordId,
  });
}
