import { createHash } from 'node:crypto';
import type {
  ByteRange, MessageNode, RacoonsRecordNode, ToolEvidence, ToolResultNode, TranscriptNode,
} from '@racoons/core';
import { deriveToolEvidence } from './evidence.js';
import type { DshEvidenceInput } from './evidence.js';

interface DshItemBase {
  readonly id: string;
  readonly turnOrdinal: number;
  readonly stepOrdinal: number;
  readonly bytes: Uint8Array;
  readonly toolCallIds?: readonly string[];
  readonly [field: string]: unknown;
}

export interface DshMessageItem extends DshItemBase {
  readonly role: MessageNode['role'];
  readonly recordId?: never;
}

export interface DshToolResultItem extends DshItemBase, DshEvidenceInput {
  readonly role: 'tool';
  readonly callId: string;
  readonly evidence?: ToolEvidence;
  readonly embeddedRecords?: readonly ByteRange[];
}

export interface DshRecordItem extends DshItemBase {
  readonly role: MessageNode['role'];
  readonly recordId: string;
}

/** A plain-object boundary, with no dependency on the dsh runtime. */
export type DshTranscriptItem = DshMessageItem | DshToolResultItem | DshRecordItem;

export interface DshEnvelope<N extends TranscriptNode = TranscriptNode> {
  readonly node: N;
  /** Original envelope plus all unmodeled fields; ordering is never sorted. */
  readonly passthrough: { readonly item: DshTranscriptItem; readonly index: number };
}

export function toCoreEnvelope(item: DshToolResultItem, index: number): DshEnvelope<ToolResultNode>;
export function toCoreEnvelope(item: DshTranscriptItem, index: number): DshEnvelope;
export function toCoreEnvelope(item: DshTranscriptItem, index: number): DshEnvelope {
  const bytes = new Uint8Array(item.bytes);
  const base = { id: item.id, turnOrdinal: item.turnOrdinal, stepOrdinal: item.stepOrdinal,
    bytes, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  const passthrough = { item: structuredClone(item), index };
  if (item.role === 'tool') {
    const source = { nodeId: item.id, sha256: base.sha256, byteLength: base.byteLength };
    return { passthrough, node: { ...base, kind: 'tool-result', callId: item.callId,
      evidence: structuredClone(item.evidence ?? deriveToolEvidence(item, source)),
      embeddedRecords: structuredClone(item.embeddedRecords ?? []) } };
  }
  if (typeof item.recordId === 'string') {
    return { passthrough, node: { ...base, kind: 'racoons-record', recordId: item.recordId } };
  }
  return { passthrough, node: { ...base, kind: 'message', role: item.role,
    toolCallIds: [...(item.toolCallIds ?? [])] } };
}

/** Only payload and modeled metadata may change; role/call identity/order must survive. */
export function fromCoreEnvelope(envelope: DshEnvelope): DshTranscriptItem {
  const { node, passthrough } = envelope;
  const original = passthrough.item;
  if (node.id !== original.id || node.turnOrdinal !== original.turnOrdinal
    || node.stepOrdinal !== original.stepOrdinal) throw new Error('Envelope identity changed');
  const owned = structuredClone(original);
  if (node.kind === 'tool-result') {
    if (owned.role !== 'tool' || owned.callId !== node.callId) throw new Error('Tool pairing changed');
    return { ...owned, bytes: new Uint8Array(node.bytes),
      ...(owned.evidence !== undefined || node.evidence.sourceRecallId !== null
        ? { evidence: structuredClone(node.evidence) } : {}),
      ...(owned.embeddedRecords !== undefined || node.embeddedRecords.length > 0
        ? { embeddedRecords: structuredClone(node.embeddedRecords) } : {}) };
  }
  if (node.kind === 'message') {
    if (owned.role === 'tool' || owned.role !== node.role || typeof owned.recordId === 'string'
      || JSON.stringify(owned.toolCallIds ?? []) !== JSON.stringify(node.toolCallIds)) {
      throw new Error('Message envelope changed');
    }
  } else if (owned.role === 'tool' || owned.recordId !== node.recordId) {
    throw new Error('Record identity changed');
  }
  return { ...owned, bytes: new Uint8Array(node.bytes) };
}

export function toCoreTranscript(items: readonly DshTranscriptItem[]): readonly DshEnvelope[] {
  return items.map((item, index) => toCoreEnvelope(item, index));
}

export function fromCoreTranscript(envelopes: readonly DshEnvelope[]): readonly DshTranscriptItem[] {
  return envelopes.map((envelope, index) => {
    if (envelope.passthrough.index !== index) throw new Error('Transcript ordering changed');
    return fromCoreEnvelope(envelope);
  });
}

export function createDshRecord(node: RacoonsRecordNode): DshRecordItem {
  return { id: node.id, role: 'system', recordId: node.recordId, bytes: new Uint8Array(node.bytes),
    turnOrdinal: node.turnOrdinal, stepOrdinal: node.stepOrdinal };
}
