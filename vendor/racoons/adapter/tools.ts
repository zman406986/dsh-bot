import type {
  Disposable, NodeId, RecallId, RecallRecord, ToolSpec,
} from '@racoons/core';
import {
  RECALL_TOOL_DESCRIPTION, canonicalManifestBytes, sha256Sync,
} from '@racoons/core';

/**
 * The core copy names what the tool does; the adapter appends how to read an
 * answer with one part and with several. The core literal stays first so the
 * model-facing inventory owns the sentence it pins.
 */
const RECALL_TOOL_DESCRIPTION_DSH = RECALL_TOOL_DESCRIPTION
  + ' One part returns its exact bytes in `text`; several parts return one entry each in'
  + ' `parts`, and `text` is null.';

/**
 * The three additive tools the contract names (`ToolSpec`). Nothing here
 * replaces a native read (ADR-0007): `forget`/`expand`/`recall` sit beside the
 * host's own tools.
 *
 * Only `recall` has an execution path in this milestone. `forget` needs the
 * verdict seam and `expand` belongs to the Pull/skeleton protocol, which
 * design-protocol §1 explicitly leaves to its own plan; both ship as declared
 * specs and are never registered until a handler exists, so the model is never
 * offered a tool that would fail.
 */
export const DSH_TOOL_SPECS: readonly ToolSpec[] = Object.freeze([
  { name: 'forget',
    description: 'marks listed content as not retained; give the path and line ranges. '
      + 'A recall id restores the exact original bytes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'the path the content came from' },
        ranges: { type: 'array', items: {
          type: 'object',
          properties: { startLine: { type: 'integer' }, endLine: { type: 'integer' } },
          required: ['startLine', 'endLine'], additionalProperties: false,
        } },
      },
      required: ['path'], additionalProperties: false,
    } },
  { name: 'expand',
    description: 'shows more of a result that was capped; give the recall id and a line range.',
    parameters: {
      type: 'object',
      properties: {
        recallId: { type: 'string' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' },
      },
      required: ['recallId'], additionalProperties: false,
    } },
  { name: 'recall',
    description: RECALL_TOOL_DESCRIPTION_DSH,
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'the recall id a marker or receipt names' } },
      required: ['id'], additionalProperties: false,
    } },
]);

/** One tool as the host receives it: the spec plus the function behind it. */
export interface DshToolRegistration {
  readonly spec: ToolSpec;
  execute(args: unknown): Promise<DshRecallOutput>;
}

/** The host's additive registration seam: `ctx.tools.register` returns an unregister. */
export interface DshToolHost {
  register(tool: DshToolRegistration): () => void;
}

/** What the adapter can already answer. Absent handlers mean an unregistered tool. */
export interface DshToolSources {
  readonly recall: (id: RecallId) => Promise<RecallRecord>;
}

export interface DshRecallPart {
  readonly nodeId: NodeId;
  readonly byteLength: number;
  readonly sha256: string;
  readonly text: string;
}

/**
 * The restored record, one part at a time. `parts` is the restore: each entry
 * carries that part's `nodeId`, `sha256`, `byteLength` and its exact bytes
 * decoded as UTF-8, and no entry spans two parts. `text` repeats the body when
 * the record has exactly one part and is `null` when it has several, so nothing
 * returned ever claims bytes no single part held (ADR-0003).
 */
export interface DshRecallOutput {
  readonly recallId: RecallId;
  readonly text: string | null;
  readonly byteLength: number;
  readonly parts: readonly DshRecallPart[];
}

/**
 * Delegates verification to the core recall API (`ledger.recall` proves the
 * manifest hash, every body and every removed range) and only checks that the
 * record it received is the one asked for. Decoding is lossless: invalid UTF-8
 * throws rather than substituting replacement characters, so a model never
 * reads bytes that are not the original.
 */
export function recallText(record: RecallRecord, expected: RecallId): DshRecallOutput {
  const manifestSha = sha256Sync(canonicalManifestBytes(record.manifest));
  if (record.id !== expected || record.id !== `recall:sha256:${manifestSha}`
    || record.manifestSha256 !== manifestSha) {
    throw new Error('recall returned a record that is not the requested archive');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const parts = record.parts.map(part => ({ nodeId: part.source.nodeId,
    byteLength: part.bytes.length, sha256: part.source.sha256, text: decoder.decode(part.bytes) }));
  // Restore per part: each entry's text is one part's archived bytes. A join
  // would hand back bytes that belong to no single part, so `text` is only
  // populated when there is exactly one body to name.
  const only = parts.length === 1 ? parts[0]?.text : undefined;
  return { recallId: record.id, text: only ?? null,
    byteLength: parts.reduce((sum, part) => sum + part.byteLength, 0), parts };
}

function recallIdArg(args: unknown): RecallId {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('recall expects an object with an id');
  }
  const id = (args as Record<string, unknown>)['id'];
  if (typeof id !== 'string' || id.length === 0) throw new Error('recall expects a non-empty id');
  return id;
}

/** The registrations the supplied sources can honour, in spec order. */
export function createDshTools(sources: DshToolSources): readonly DshToolRegistration[] {
  const recallSpec = DSH_TOOL_SPECS.find(spec => spec.name === 'recall');
  if (recallSpec === undefined) throw new Error('The recall spec left the inventory');
  return [{ spec: recallSpec,
    execute: async args => {
      const id = recallIdArg(args);
      return recallText(await sources.recall(id), id);
    } }];
}

/**
 * Register additively and return one disposable for the whole set. Registration
 * order follows `createDshTools`; disposal unregisters in reverse.
 */
export function registerDshTools(
  host: DshToolHost, tools: readonly DshToolRegistration[],
): Disposable {
  const undo: (() => void)[] = [];
  try {
    for (const tool of tools) undo.push(host.register(tool));
  } catch (error) {
    for (const unregister of undo.reverse()) unregister();
    throw error;
  }
  let disposed = false;
  return { dispose: () => {
    if (disposed) return;
    disposed = true;
    for (const unregister of undo.reverse()) unregister();
  } };
}

/** The specs the contract declares, in a stable order, for adapters to advertise. */
export function dshToolSpecs(): readonly ToolSpec[] {
  return DSH_TOOL_SPECS.map(spec => ({ ...spec, parameters: structuredClone(spec.parameters) }));
}
