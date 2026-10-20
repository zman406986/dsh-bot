import { createHash } from 'node:crypto';
import type { ApplyRequest, SessionSnapshot, ToolResultNode } from '@racoons/core';
import { createDshRecord, fromCoreEnvelope, toCoreEnvelope } from './envelope.js';
import type { DshToolResultItem, DshTranscriptItem } from './envelope.js';

function hashBody(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Builds a complete private candidate. It has no access to the live port state. */
export function stageApplication(
  request: ApplyRequest, items: readonly DshTranscriptItem[],
  pending: DshToolResultItem | undefined, context: Omit<SessionSnapshot, 'nodes' | 'revision'>,
): DshTranscriptItem[] {
  const application = request.application;
  const candidate = structuredClone([...items]);
  const entry = application.mode === 'entry';
  if ((entry && pending === undefined) || (!entry && application.replacements.length > 0)) {
    throw new Error('Application does not match an available M1 seam');
  }
  if (entry && pending !== undefined) {
    const existingIndex = candidate.findIndex(item => item.id === pending.id);
    const existing = candidate[existingIndex];
    if (existing !== undefined && (existing.role !== 'tool' || existing.callId !== pending.callId
      || hashBody(existing.bytes) !== hashBody(pending.bytes))) {
      throw new Error('Visible entry changed after staging');
    }
    const envelope = toCoreEnvelope(pending, existingIndex < 0 ? candidate.length : existingIndex);
    if (application.replacements.length > 1) throw new Error('Entry replaces one result only');
    const replacement = application.replacements[0];
    let node: ToolResultNode = envelope.node;
    if (replacement !== undefined) {
      if (replacement.source.nodeId !== node.id || replacement.source.sha256 !== node.sha256
        || replacement.source.byteLength !== node.byteLength
        || hashBody(replacement.bytes) !== replacement.sha256) {
        throw new Error('Replacement source or output changed');
      }
      node = { ...node, bytes: new Uint8Array(replacement.bytes), sha256: replacement.sha256,
        byteLength: replacement.bytes.byteLength,
        embeddedRecords: structuredClone(replacement.generatedRanges),
        evidence: { ...node.evidence, sourceRecallId: replacement.evidenceRecallId } };
    }
    const published = fromCoreEnvelope({ ...envelope, node });
    if (existingIndex < 0) candidate.push(published);
    else candidate[existingIndex] = published;
  }
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
