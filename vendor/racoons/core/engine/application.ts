import type { ValidatedApplication } from '../guard/types.js';
import type { EngineOptions, EngineResult } from './types.js';
import {
  applicationMeasurements, receiptMatches, recordApplied, recordCandidate, recordPrepared,
} from './journal.js';
import type { TranscriptTelemetry } from './telemetry.js';

type ApplicationOutcome = Pick<EngineResult, 'status' | 'intentId' | 'receipt'>;

export async function applyApplication(
  options: EngineOptions, telemetry: TranscriptTelemetry, application: ValidatedApplication,
  noticeRecordId: string | null = null,
): Promise<ApplicationOutcome> {
  // Metadata precedes prepare, which durably writes archive bytes before host mutation.
  await recordCandidate(options.ledger, application, noticeRecordId);
  const intent = await options.ledger.prepare(structuredClone(application));
  if (intent.sessionId !== application.sessionId || intent.eventId !== application.eventId
    || intent.baseRevision !== application.baseRevision
    || intent.applicationSha256 !== application.applicationSha256) {
    throw new Error('Prepared intent does not match the validated application');
  }
  const prepared = await recordPrepared(options.ledger, intent, application, noticeRecordId);
  let outcome: Awaited<ReturnType<EngineOptions['port']['apply']>>;
  try {
    outcome = await options.port.apply(structuredClone({ intent, application }));
  } catch {
    outcome = { status: 'unknown' };
  }
  let status: ApplicationOutcome['status'] = 'recovery-pending';
  let receipt: ApplicationOutcome['receipt'] = null;
  if (outcome.status === 'applied' && receiptMatches(prepared, outcome.receipt)) {
    receipt = structuredClone(outcome.receipt);
    try {
      await recordApplied(options.ledger, receipt);
      status = 'applied';
    } catch { /* Reconcile the host receipt before another application. */ }
  } else if (outcome.status === 'not-applied') {
    try {
      await options.ledger.append({
        kind: 'abandoned', sessionId: intent.sessionId, intentId: intent.intentId,
        eventKey: `engine-abandoned:${intent.intentId}`, atMs: options.clock.nowMs(),
        reason: outcome.reason,
      });
      status = 'unchanged';
    } catch { /* Confirm a missing abandonment through receipt lookup. */ }
  }
  const measurements = applicationMeasurements(application);
  telemetry.emit({
    kind: 'application', sessionId: intent.sessionId, atMs: options.clock.nowMs(),
    intentId: intent.intentId,
    outcome: status === 'applied' ? 'applied' : status === 'unchanged' ? 'not-applied' : 'unknown',
    removedBytes: status === 'applied' ? measurements.removedBytes : 0,
    generatedBytes: status === 'applied' ? measurements.generatedBytes : 0,
    recallIds: status === 'applied' ? measurements.recallIds : [],
    sealedEpisodeIds: status === 'applied' ? application.sealedEpisodeIds : [],
  });
  return { status, intentId: intent.intentId, receipt };
}
