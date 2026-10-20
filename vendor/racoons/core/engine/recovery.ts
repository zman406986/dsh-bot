import type { Ledger } from '../ledger/types.js';
import type { IntentId, SessionId } from '../types/identity.js';
import type { ApplicationPort } from './types.js';
import { metadata, readEntries, receiptMatches, recordApplied } from './journal.js';

export interface RecoveryOutcome {
  readonly status: 'clear' | 'reconciled' | 'blocked';
  readonly intentIds: readonly IntentId[];
}

export async function recoverPending(
  ledger: Ledger, port: ApplicationPort, sessionId: SessionId,
): Promise<RecoveryOutcome> {
  const entries = await readEntries(ledger, sessionId);
  const prepared = new Map(entries.flatMap(({ event }) =>
    event.kind === 'prepared' ? [[event.intentId, event] as const] : []));
  // Prefer the engine's enriched event when both it and prepare()'s event exist.
  for (const { event } of entries) {
    if (event.kind === 'prepared' && metadata(event) !== null) prepared.set(event.intentId, event);
  }
  const finished = new Set<IntentId>();
  for (const { event } of entries) {
    if (event.kind === 'abandoned') finished.add(event.intentId);
    if (event.kind === 'applied') {
      const source = prepared.get(event.receipt.intentId);
      if (source !== undefined && receiptMatches(source, event.receipt)) finished.add(source.intentId);
    }
  }
  const intentIds: IntentId[] = [];
  let blocked = false;
  for (const [intentId, event] of prepared) {
    if (finished.has(intentId)) continue;
    intentIds.push(intentId);
    try {
      const lookup = await port.lookupReceipt(intentId);
      if (lookup.status === 'unknown') {
        blocked = true;
      } else if (lookup.status === 'not-applied') {
        await ledger.append({
          kind: 'abandoned', sessionId, intentId,
          eventKey: `engine-abandoned:${intentId}`, atMs: event.atMs,
          reason: 'Host confirmed non-application; removal will not be replayed',
        });
      } else if (receiptMatches(event, lookup.receipt)) {
        await recordApplied(ledger, lookup.receipt);
      } else {
        blocked = true;
      }
    } catch {
      // A failed lookup or failed reconciliation write cannot prove an outcome.
      blocked = true;
    }
  }
  return { status: blocked ? 'blocked' : intentIds.length > 0 ? 'reconciled' : 'clear', intentIds };
}
