import type { Ledger } from '../ledger/types.js';
import type { IntentId, SessionId } from '../types/identity.js';
import type { ApplicationPort, ReceiptConflict } from './types.js';
import { metadata, readEntries, receiptMatches, recordApplied } from './journal.js';

export interface RecoveryOutcome {
  readonly status: 'clear' | 'reconciled' | 'blocked';
  readonly intentIds: readonly IntentId[];
  readonly conflicts: readonly ReceiptConflict[];
}

/**
 * Reconciles every prepared intent the ledger has not finished (ADR-0004,
 * amended by ADR-0015). A confirmed `not-applied` is the only route to an
 * `abandoned` record; an unknown outcome blocks and writes nothing, so a crash
 * between host apply and receipt append is never recorded as a refusal.
 */
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
  const applied = new Map(entries.flatMap(({ event }) => event.kind === 'applied'
    ? [[event.receipt.intentId, event.receipt] as const] : []));
  const finished = new Set<IntentId>();
  for (const { event } of entries) {
    if (event.kind === 'abandoned') finished.add(event.intentId);
    if (event.kind === 'applied') {
      const source = prepared.get(event.receipt.intentId);
      if (source !== undefined && receiptMatches(source, event.receipt)) finished.add(source.intentId);
    }
  }
  const intentIds: IntentId[] = [];
  const conflicts: ReceiptConflict[] = [];
  let blocked = false;
  for (const [intentId, event] of prepared) {
    if (finished.has(intentId)) continue;
    intentIds.push(intentId);
    const recorded = applied.get(intentId);
    try {
      const lookup = await port.lookupReceipt(intentId);
      if (lookup.status === 'unknown') {
        // R3/R6: absence is never read as not-applied, and a recorded receipt
        // the host cannot confirm is an inconsistency, not a licence to trust.
        blocked = true;
      } else if (lookup.status === 'not-applied') {
        if (recorded !== undefined) {
          // R4: the durable applied record stands; the refusal is journaled.
          blocked = true;
          conflicts.push({ intentId, host: 'not-applied' });
        } else {
          await ledger.append({
            kind: 'abandoned', sessionId, intentId,
            eventKey: `engine-abandoned:${intentId}`, atMs: event.atMs,
            reason: 'Host confirmed non-application; removal will not be replayed',
          });
        }
      } else if (receiptMatches(event, lookup.receipt)) {
        if (recorded !== undefined && (recorded.resultRevision !== lookup.receipt.resultRevision
          || recorded.appliedAtMs !== lookup.receipt.appliedAtMs)) {
          // The host and the ledger both hold a receipt and they disagree.
          blocked = true;
          conflicts.push({ intentId, host: 'applied' });
        } else {
          await recordApplied(ledger, lookup.receipt);
        }
      } else {
        blocked = true;
      }
    } catch {
      // A failed lookup or failed reconciliation write cannot prove an outcome.
      blocked = true;
    }
  }
  return {
    status: blocked ? 'blocked' : intentIds.length > 0 ? 'reconciled' : 'clear',
    intentIds, conflicts,
  };
}
