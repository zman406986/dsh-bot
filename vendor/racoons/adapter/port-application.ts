import { createHash } from 'node:crypto';
import type {
  ApplyRequest, RenderedRecord, SessionSnapshot, ValidatedRevert,
} from '@racoons/core';
import { createDshRecord } from './envelope.js';
import type { DshTranscriptItem } from './envelope.js';

function hashBody(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Builds a complete private candidate. It has no access to the live port state. */
export function stageApplication(
  request: ApplyRequest, items: readonly DshTranscriptItem[],
  context: Omit<SessionSnapshot, 'nodes' | 'revision'>,
): DshTranscriptItem[] {
  const application = request.application;
  if (application.mode === 'revert') throw new Error('A revert stages through the host append, not this path');
  // The entry mode has no staging path any more: an answered checkpoint is
  // applied by the port's own rewind-and-append host write (ISSUE-058 chunk
  // P3a; ADR-0022 §12), never by a pre-landing replacement of a node. Only the
  // append mode reaches this builder.
  if (application.mode !== 'append' || application.replacements.length > 0) {
    throw new Error('Application does not match an available M1 seam');
  }
  const candidate = structuredClone([...items]);
  for (const record of application.appendRecords) {
    if (hashBody(record.bytes) !== record.sha256) throw new Error('Record hash changed');
    candidate.push(createDshRecord({ kind: 'racoons-record', id: record.recordId,
      recordId: record.recordId, bytes: record.bytes, sha256: record.sha256,
      byteLength: record.bytes.byteLength, turnOrdinal: context.currentTurnOrdinal,
      stepOrdinal: context.currentStepOrdinal }));
  }
  const ids = candidate.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate transcript node');
  return candidate;
}

/**
 * The host's independent re-derivation of the approved plan's claims
 * (ADR-0004: the host applies what the ledger prepared, so a plan substituted
 * between prepare and apply must refuse). It re-checks only the facts
 * `staging` cannot see: the cost identity, that every anchor is the prefix tail
 * or a survivor before the receipt's position, and that no forgotten node
 * survives. Returns the failing claim, or null.
 */
export function checkRevertPlan(
  revert: ValidatedRevert, records: readonly RenderedRecord[], items: readonly DshTranscriptItem[],
): string | null {
  const { cost } = revert;
  if (cost.cutIndex !== revert.cutIndex
    || cost.netFreedBytes !== cost.freedBytes - cost.keptBytes - cost.receiptBytes) {
    return 'The revert cost does not describe its own cut';
  }
  const byId = new Map(records.map(record => [record.recordId, record]));
  const survivors = new Set(revert.survivors);
  const tail = revert.cutIndex > 0 ? items[revert.cutIndex - 1]?.id ?? null : null;
  let anchor = tail;
  let cursor = 0;
  for (let index = revert.cutIndex; index < items.length; index++) {
    const item = items[index];
    if (item === undefined) return 'The cut lies past the transcript';
    if (survivors.has(item.id)) { anchor = item.id; continue; }
    const entry = revert.appends[cursor];
    if (entry === undefined || entry.afterNodeId !== anchor) {
      return 'A revert append is missing or anchors at the wrong survivor';
    }
    const record = byId.get(entry.noteId);
    if (record === undefined || hashBody(record.bytes) !== record.sha256) {
      return 'A revert append names no intact shipped receipt';
    }
    cursor += 1;
  }
  if (cursor !== revert.appends.length) return 'A revert append names a node that never leaves';
  return null;
}

/**
 * The transcript a completed revert leaves, built only from the approved plan
 * and the receipts the application ships (the same shape the core's own test
 * port applies): nodes [0, cutIndex) verbatim, then each survivor in order,
 * each followed by the receipts anchored to it. The prefix tail's receipts
 * land directly after `nodes[cutIndex - 1]`; a head cut lands them first.
 *
 * The host append and this rebuild are two statements of one plan: `revert.ts`
 * proves the append covers exactly the surface the plan names, and the caller
 * checks the surface order equals the transcript order before either runs.
 */
export function stageRevert(
  revert: ValidatedRevert, records: readonly RenderedRecord[],
  items: readonly DshTranscriptItem[], context: Omit<SessionSnapshot, 'nodes' | 'revision'>,
): DshTranscriptItem[] {
  const byId = new Map(records.map(record => [record.recordId, record]));
  const appendRecords = (anchor: string | null): DshTranscriptItem[] => revert.appends
    .filter(entry => (entry.afterNodeId ?? null) === anchor)
    .map(entry => {
      const record = byId.get(entry.noteId);
      if (record === undefined) throw new Error(`Revert append ${entry.noteId} names no shipped receipt`);
      if (hashBody(record.bytes) !== record.sha256) throw new Error('Receipt hash changed');
      return createDshRecord({ kind: 'racoons-record', id: record.recordId,
        recordId: record.recordId, bytes: record.bytes, sha256: record.sha256,
        byteLength: record.bytes.byteLength, turnOrdinal: context.currentTurnOrdinal,
        stepOrdinal: context.currentStepOrdinal });
    });
  const survivors = new Set(revert.survivors);
  const candidate: DshTranscriptItem[] = [];
  appendRecords(null).forEach(item => candidate.push(item));
  items.forEach((item, index) => {
    if (index >= revert.cutIndex && !survivors.has(item.id)) return;
    candidate.push(item);
    appendRecords(item.id).forEach(record => candidate.push(record));
  });
  const ids = candidate.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate transcript node');
  return candidate;
}
