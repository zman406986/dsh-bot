import { makeApplication } from '../guard/application.js';
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

/**
 * The one record that tells the model (and the operator) the judge was stopped.
 * It is owed once per disable: the pass that trips the breaker writes the
 * `breaker-disabled` marker, and the next boundary appends the notice. The
 * notice never waits for a turn to advance — a single-turn record is exactly
 * where it is needed (ISSUE-057 defect 3), so no ordinal is consulted.
 */
export async function announceBreaker(
  options: EngineOptions, telemetry: TranscriptTelemetry, snapshot: SessionSnapshot,
  entries: readonly LedgerEntry[], confirmedNotices: ReadonlySet<string>,
): Promise<'done' | 'appended' | 'blocked'> {
  const disabled = entries.find(({ event }) => event.kind === 'breaker-disabled');
  if (disabled?.event.kind !== 'breaker-disabled') return 'done';
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
  // The disabled Guard cannot issue a notice, so the engine states this
  // application itself. It contains no source replacements, archive removals or
  // rule-provided bytes; the application body is built by the guard's own
  // builder, which is the only place the validated-application brand is
  // installed (no cast here).
  const application = makeApplication({
    input: { kind: 'at-rest', eventId: recordId, reason: 'step' },
    snapshot, capabilities: options.capabilities, config: options.config,
    plans: [], sealedEpisodeIds: [], nowMs: disabled.event.atMs,
  }, {
    replacements: [], appendRecords: [record], archives: [], sealedEpisodeIds: [],
    expectedGenerated: new Map(), expectedRecords: new Map([[recordId, record.bytes]]),
    revert: null,
  });
  const outcome = await applyApplication(options, telemetry, application, recordId);
  if (outcome.status === 'applied') await markAnnounced(options, recordId);
  if (outcome.status === 'recovery-pending') return 'blocked';
  return outcome.status === 'applied' ? 'appended' : 'done';
}

async function markAnnounced(options: EngineOptions, recordId: string): Promise<void> {
  await options.ledger.append({
    kind: 'breaker-announced', sessionId: options.sessionId,
    eventKey: `engine-breaker-announced:${options.sessionId}`,
    atMs: options.clock.nowMs(), recordId,
  });
}
