import type { ApplyReceipt, LedgerEntry } from '../ledger/types.js';
import type { ApplicationPort } from './types.js';
import { metadata, receiptMatches } from './journal.js';

export async function committedState(entries: readonly LedgerEntry[], port: ApplicationPort) {
  const sealed = new Set<string>();
  const events = new Map<string, ApplyReceipt | null>();
  const notices = new Set<string>();
  let blocked = false;
  const applied = new Map(entries.flatMap(({ event }) => event.kind === 'applied'
    ? [[event.receipt.intentId, event.receipt] as const] : []));
  const abandoned = new Set(entries.flatMap(({ event }) => event.kind === 'abandoned'
    ? [event.intentId] : []));
  for (const { event } of entries) {
    if (event.kind !== 'prepared') continue;
    const details = metadata(event);
    const receipt = applied.get(event.intentId);
    if (receipt === undefined) {
      if (details !== null && abandoned.has(event.intentId) && !events.has(details.intent.eventId)) {
        events.set(details.intent.eventId, null);
      }
      continue;
    }
    try {
      const lookup = await port.lookupReceipt(event.intentId);
      if (lookup.status !== 'applied' || !receiptMatches(event, lookup.receipt)
        || lookup.receipt.resultRevision !== receipt.resultRevision
        || lookup.receipt.appliedAtMs !== receipt.appliedAtMs) {
        blocked = true;
        continue;
      }
      if (details === null) {
        // An applied intent without event/seal metadata cannot safely permit new seals.
        blocked = true;
        continue;
      }
      events.set(details.intent.eventId, lookup.receipt);
      for (const id of details.sealedEpisodeIds) sealed.add(id);
      if (details.noticeRecordId !== null) notices.add(details.noticeRecordId);
    } catch { blocked = true; }
  }
  return { sealedEpisodeIds: [...sealed], events, notices, blocked };
}
