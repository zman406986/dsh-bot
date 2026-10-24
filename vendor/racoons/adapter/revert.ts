import type {
  ArchiveRecord, ByteRange, NodeId, RenderedRecord, ValidatedRevert,
} from '@racoons/core';
import { complementByteRanges, revertBytes, sha256Sync } from '@racoons/core';

/**
 * The host's model-visible surface, as a revert needs it. dsh exposes exactly
 * this pair: `session.surface.nodes` (current surface seqs) and the message
 * each seq derives (`session.deriveEventMessage`). A fake supplies plain objects.
 */
export type DshSurfaceType =
  | 'system/message' | 'developer/message' | 'user/message' | 'assistant/message' | 'tool/result';
/** A replacement node type: dsh never accepts `assistant/message` here (§4). */
export type DshAppendableType = Exclude<DshSurfaceType, 'assistant/message'>;

/** The model-facing text of one current node; only text survives a rebuild. */
export interface DshContentBlock {
  readonly type: string;
  readonly text?: string;
  /** `tool-call` blocks only: the call id the matching result answers. */
  readonly id?: string;
}

/** One current surface node. `data` is the host payload, kept verbatim except content. */
export interface DshSurfaceNode {
  readonly id: string;
  readonly seq: number;
  readonly type: DshSurfaceType;
  readonly blocks: readonly DshContentBlock[];
  /** `tool/result` only: the call this result answers (`message.toolCallId`). */
  readonly callId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface DshSurfaceIntent {
  readonly surfaceOp: { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number };
  readonly sourceEventSeqs: readonly number[];
}

/**
 * The one host primitive a revert uses: one atomic `append` that shadows a
 * contiguous current-surface span. dsh has no transaction API, so a revert is
 * never split into several appends.
 */
export interface DshRevertSession {
  /** Current surface nodes in model-visible order. */
  surface(): readonly DshSurfaceNode[];
  /** The next event sequence number (`seq === log.length` on dsh). */
  nextSeq(): number;
  append(
    type: DshAppendableType, data: Readonly<Record<string, unknown>>, intent: DshSurfaceIntent,
  ): { readonly seq: number };
}

/** Every refusal is decided before the first (and only) append. */
export type DshRevertRefusalCode =
  | 'assistant-replacement'
  | 'multi-node-tool-result'
  | 'span-out-of-range'
  | 'system-head'
  | 'tool-pair-imbalance'
  | 'unsupported-content'
  | 'plan-shape';

export interface DshRevertAppend {
  readonly type: DshAppendableType;
  readonly data: Readonly<Record<string, unknown>>;
  readonly surfaceOp: { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number };
  readonly sourceEventSeqs: readonly number[];
}

export interface DshAppendRefusal {
  readonly status: 'refused';
  readonly code: DshRevertRefusalCode;
  readonly detail: string;
}

export interface DshAppendPlan {
  readonly status: 'planned';
  /** The one append; `surfaceOp` and `sourceEventSeqs` are its whole host contract. */
  readonly append: DshRevertAppend;
}

export type DshAppendDecision = DshAppendPlan | DshAppendRefusal;

/**
 * The kept remainder of one shadowed node (ISSUE-017). A `keeplines` verdict
 * names the lines it keeps, so the archive built for it holds the node's whole
 * body and the complement as `removedRanges`. `sourceBytes` and
 * `removedRanges` are the guard-approved pair; the kept bytes are re-derived
 * here with the core's own complement, never read back from model output.
 */
export interface DshPartialKeep {
  readonly nodeId: NodeId;
  readonly sourceBytes: Uint8Array;
  /** The gaps the removal leaves: the bytes the rebuild must carry verbatim. */
  readonly keptRanges: readonly ByteRange[];
  readonly removedRanges: readonly ByteRange[];
}

/** The derived partial keeps, or why the archives cannot supply them. */
export type DshPartialKeepSet =
  | { readonly status: 'derived'; readonly keeps: ReadonlyMap<NodeId, DshPartialKeep> }
  | { readonly status: 'invalid'; readonly detail: string };

/**
 * No archive carries a partial keep: the whole-unit path, unchanged. The map is
 * never written, and callers only read it.
 */
export const NO_PARTIAL_KEEPS: DshPartialKeepSet = { status: 'derived', keeps: new Map() };

/**
 * Reads the partial keeps a verdict application archives (ISSUE-017).
 *
 * A `forgetall` archive removes the node whole, so its complement is empty and
 * it contributes nothing here — that node keeps none of its bytes. A
 * `keeplines` archive removes only the complement of the kept lines, so the
 * node keeps the rest and its rebuilt form carries those bytes verbatim.
 *
 * Only `verdict` archives are read: a cap or seal archive is not a revert
 * removal. Every entry is verified before it is trusted — the body against its
 * source hash, each removed range against its own hash, the ranges ordered,
 * in-bounds and non-overlapping — because these bytes are about to be copied
 * into the model-visible surface, and the model never supplies them. The
 * adapter never repairs an archive: a malformed one is `invalid` and the
 * revert refuses.
 */
export function partialKeepsFromArchives(archives: readonly ArchiveRecord[]): DshPartialKeepSet {
  const keeps = new Map<NodeId, DshPartialKeep>();
  for (const archive of archives) {
    if (archive.operationKind !== 'verdict') continue;
    for (const part of archive.recall.parts) {
      const nodeId = part.source.nodeId;
      if (keeps.has(nodeId)) {
        return { status: 'invalid', detail: `Two verdict archives name ${nodeId}` };
      }
      if (part.bytes.length !== part.source.byteLength
        || sha256Sync(part.bytes) !== part.source.sha256) {
        return { status: 'invalid', detail: `The archived body of ${nodeId} differs from its source` };
      }
      const removedRanges: ByteRange[] = [];
      for (const span of part.removedRanges) {
        const { startByte, endByteExclusive } = span.range;
        if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByteExclusive)
          || startByte < 0 || endByteExclusive <= startByte
          || endByteExclusive > part.bytes.length) {
          return { status: 'invalid', detail: `An archived range of ${nodeId} is out of bounds` };
        }
        if (sha256Sync(part.bytes.slice(startByte, endByteExclusive)) !== span.sha256) {
          return { status: 'invalid', detail: `An archived removed range of ${nodeId} differs from its hash` };
        }
        removedRanges.push({ startByte, endByteExclusive });
      }
      let kept: readonly ByteRange[];
      try {
        kept = complementByteRanges(part.bytes.length, removedRanges);
      } catch {
        return { status: 'invalid',
          detail: `The archived ranges of ${nodeId} are unordered, overlapping or out of bounds` };
      }
      // No gap means the node was removed whole (or was empty): nothing to keep.
      if (kept.length === 0) continue;
      keeps.set(nodeId, {
        nodeId, sourceBytes: new Uint8Array(part.bytes), keptRanges: kept, removedRanges,
      });
    }
  }
  return { status: 'derived', keeps };
}

export type DshRevertOutcome =
  | { readonly status: 'applied'; readonly seq: number; readonly append: DshRevertAppend;
      /** The host's own surface after the append: the adapter never assumes the splice. */
      readonly surface: readonly DshSurfaceNode[] }
  | DshAppendRefusal
  | { readonly status: 'unknown'; readonly detail: string; readonly append: DshRevertAppend };

const refused = (code: DshRevertRefusalCode, detail: string): DshAppendRefusal =>
  ({ status: 'refused', code, detail });

const encoder = new TextEncoder();

/**
 * The guard's plan digest, recomputed at the host boundary (ADR-0004: the host
 * applies exactly what the ledger prepared). Delegates the encoding to core's
 * `revertBytes` and only strips the sealed digest, so there is one domain and
 * one canonical form for `racoons:revert:v1`: a plan substituted between
 * prepare and apply refuses instead of moving the transcript.
 */
export function revertPlanSha256(revert: ValidatedRevert): string {
  const { planSha256: _sealed, ...approved } = revert;
  void _sealed;
  return sha256Sync(revertBytes(approved));
}

/**
 * The single append one approved revert becomes (design-protocol §4).
 *
 * `revert.cutIndex` is a surface index: the port's transcript is the surface,
 * so the cut names the node after the prefix tail. The span runs from the cut
 * through the last forgotten node; survivors after it keep their surface nodes
 * untouched. Survivors inside the span are re-emitted in order, in place, each
 * followed by the receipts anchored to it, because one append carries one node.
 * The replacement keeps the first shadowed node's type and every non-content
 * field of its payload; only `content` is rebuilt.
 *
 * A `keeplines` verdict is a partial forget (ISSUE-017): the node leaves the
 * surface, but the lines its answer kept come back verbatim inside the
 * replacement, before that node's receipt. `partialKeeps` carries those bytes
 * from the ledger archive (`partialKeepsFromArchives`); an absent set means the
 * whole-unit path, where every shadowed node contributes only its receipt.
 *
 * dsh's own preconditions are checked here, before the caller appends anything:
 * no `assistant/message` replacement, a `tool/result` replacement is
 * single-node and content-only, the span names current surface nodes with
 * `startSeq <= endSeq < nextSeq`, `sourceEventSeqs` lists every shadowed node,
 * and no span starts at surface node 0.
 */
export function planRevertAppend(
  revert: ValidatedRevert, receipts: readonly RenderedRecord[],
  surface: readonly DshSurfaceNode[], nextSeq: number,
  partialKeeps: DshPartialKeepSet = NO_PARTIAL_KEEPS,
): DshAppendDecision {
  if (partialKeeps.status === 'invalid') {
    return refused('plan-shape', `The archived partial keeps are unusable: ${partialKeeps.detail}`);
  }
  const keptByNode = partialKeeps.keeps;
  const first = revert.appends[0];
  if (first === undefined) return refused('plan-shape', 'A revert carries at least one receipt append');
  const records = new Map(receipts.map(record => [record.recordId, record]));
  for (const entry of revert.appends) {
    if (!records.has(entry.noteId)) {
      return refused('plan-shape', `Receipt ${entry.noteId} is not part of the application`);
    }
  }

  const indexById = new Map<string, number>();
  surface.forEach((node, index) => { if (!indexById.has(node.id)) indexById.set(node.id, index); });
  const startIdx = revert.cutIndex;
  if (!Number.isSafeInteger(startIdx) || startIdx < 0 || startIdx >= surface.length) {
    return refused('span-out-of-range', `Cut ${startIdx} is outside the surface of ${surface.length} nodes`);
  }
  const start = surface[startIdx];
  if (start === undefined) return refused('span-out-of-range', 'The cut names no surface node');
  const tail = first.afterNodeId;
  if (tail !== null && indexById.get(tail) !== startIdx - 1) {
    return refused('plan-shape', `Receipt ${first.noteId} does not anchor on the prefix tail`);
  }

  const survivors = new Set(revert.survivors);
  if (survivors.has(start.id)) return refused('plan-shape', 'The cut names a survivor, not a forgotten node');
  let endIdx = -1;
  for (let index = startIdx; index < surface.length; index++) {
    const node = surface[index];
    if (node !== undefined && !survivors.has(node.id)) endIdx = index;
  }
  if (endIdx < startIdx) return refused('plan-shape', 'The plan names no forgotten node at or after its cut');
  const expected = surface.slice(startIdx).filter(node => survivors.has(node.id)).map(node => node.id);
  if (!sameOrder(revert.survivors, expected)) {
    return refused('plan-shape', 'Survivors differ from the surface nodes after the cut');
  }
  const shadowed = surface.slice(startIdx, endIdx + 1);
  const forgotten = shadowed.filter(node => !survivors.has(node.id));
  if (revert.appends.length !== forgotten.length) {
    return refused('plan-shape', 'A revert carries exactly one receipt per forgotten surface node');
  }
  // A partial keep names a forgotten node inside the span. A keep for a
  // survivor would re-emit bytes the plan says stay in place, and a keep for a
  // node outside the append's span has no replacement to land in.
  for (const [nodeId, keep] of keptByNode) {
    const node = forgotten.find(candidate => candidate.id === nodeId);
    if (node === undefined) {
      return refused('plan-shape', `Partial keep ${nodeId} names no forgotten node inside the span`);
    }
    // The kept bytes come from the archive; they must also be the bytes the
    // host is shadowing right now, or the rebuild would show other content.
    const current = textOnly(node);
    if ('code' in current) return current;
    if (!sameBytes(current.bytes, keep.sourceBytes)) {
      return refused('plan-shape', `Partial keep ${nodeId} does not match the surface node it shadows`);
    }
  }

  if (startIdx === 0) {
    return refused('system-head', 'A replacement span may never start at surface node 0');
  }
  if (start.type === 'assistant/message') {
    return refused('assistant-replacement', 'dsh never accepts an assistant/message replacement');
  }
  if (start.type === 'tool/result' && shadowed.length > 1) {
    return refused('multi-node-tool-result', 'A tool/result replacement is single-node and content-only');
  }
  const end = shadowed[shadowed.length - 1];
  if (end === undefined) return refused('plan-shape', 'The span is empty');
  const startSeq = start.seq, endSeq = end.seq;
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq) || startSeq < 0
    || startSeq > endSeq || endSeq >= nextSeq) {
    return refused('span-out-of-range',
      `Span ${startSeq}..${endSeq} is not two current surface nodes before ${nextSeq}`);
  }

  const rebuilt = placeReceipts(revert.appends, records, surface, survivors,
    startIdx, endIdx, indexById, keptByNode);
  if ('code' in rebuilt) return rebuilt;
  if (rebuilt.blocks.length === 0) {
    return refused('plan-shape', 'An empty replacement would delete the tail with zero tokens');
  }
  const unbalanced = pairingFailure([
    ...surface.slice(0, startIdx).map(pairView),
    { type: start.type, ...(start.callId === undefined ? {} : { callId: start.callId }),
      blocks: rebuilt.blocks },
    ...surface.slice(endIdx + 1).map(pairView),
  ]);
  if (unbalanced !== null) return refused('tool-pair-imbalance', unbalanced);
  const data = replacementData(start, rebuilt.blocks);
  if (data === null) return refused('plan-shape', `A ${start.type} node carries no message payload`);

  return { status: 'planned', append: { type: start.type, data,
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: shadowed.map(node => node.seq) } };
}

/**
 * The rebuilt content in surface order. Each receipt lands at the anchor the
 * plan gave it — the prefix tail first, otherwise directly after the survivor
 * it names — so the whole-unit path renders exactly what it did before this
 * change. A partially kept forgotten node contributes its kept lines
 * immediately before its own receipt (ISSUE-017), so the receipt still follows
 * the content it marks as removed and a reader sees "kept remainder, then what
 * was dropped".
 *
 * Appends are paired with forgotten nodes positionally: the core planner walks
 * the suffix in transcript order and pushes one append per forgotten node, and
 * `planRevertAppend` has already proven the counts equal.
 *
 * Kept bytes are copied from the archived source — never from the model — and
 * never repaired: a byte range that is not UTF-8 text cannot be re-emitted.
 */
function placeReceipts(
  appends: ValidatedRevert['appends'], records: ReadonlyMap<string, RenderedRecord>,
  surface: readonly DshSurfaceNode[], survivors: ReadonlySet<string>,
  startIdx: number, endIdx: number, indexById: ReadonlyMap<string, number>,
  keptByNode: ReadonlyMap<NodeId, DshPartialKeep>,
): { readonly blocks: readonly DshContentBlock[] } | DshAppendRefusal {
  const tailId = surface[startIdx - 1]?.id ?? null;
  const tailBlocks: DshContentBlock[] = [];
  const anchored = new Map<string, DshContentBlock[]>();
  const receiptOf = new Set<NodeId>();
  const decoder = new TextDecoder('utf-8');
  const keptDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const forgotten = surface.slice(startIdx, endIdx + 1).filter(node => !survivors.has(node.id));
  for (const [index, entry] of appends.entries()) {
    const node = forgotten[index];
    const record = records.get(entry.noteId);
    if (node === undefined) {
      return refused('plan-shape', 'A revert carries a receipt for no forgotten node');
    }
    if (record === undefined) return refused('plan-shape', `Receipt ${entry.noteId} is missing`);
    if (receiptOf.has(node.id)) return refused('plan-shape', `Two receipts name ${node.id}`);
    receiptOf.add(node.id);
    const anchor = entry.afterNodeId;
    let group: DshContentBlock[];
    if (anchor === null || anchor === tailId) {
      group = tailBlocks;
    } else {
      const anchorIndex = indexById.get(anchor);
      if (anchorIndex === undefined || anchorIndex < startIdx || anchorIndex > endIdx
        || !survivors.has(anchor)) {
        return refused('plan-shape', `Receipt ${entry.noteId} anchors outside the replaced span`);
      }
      const existing = anchored.get(anchor);
      if (existing === undefined) {
        group = [];
        anchored.set(anchor, group);
      } else {
        group = existing;
      }
    }
    const keep = keptByNode.get(node.id);
    if (keep !== undefined) {
      for (const range of keep.keptRanges) {
        const bytes = keep.sourceBytes.subarray(range.startByte, range.endByteExclusive);
        let text: string;
        try {
          text = keptDecoder.decode(bytes);
        } catch {
          return refused('unsupported-content',
            `The kept bytes of ${node.id} are not UTF-8 text a rebuilt message can hold`);
        }
        group.push({ type: 'text', text });
      }
    }
    group.push({ type: 'text', text: decoder.decode(record.bytes) });
  }
  const blocks: DshContentBlock[] = [...tailBlocks];
  for (let index = startIdx; index <= endIdx; index++) {
    const node = surface[index];
    if (node === undefined || !survivors.has(node.id)) continue;
    for (const block of node.blocks) {
      if (block.type !== 'text' || typeof block.text !== 'string') {
        return refused('unsupported-content',
          `Survivor ${node.id} carries a ${block.type} block a rebuilt message cannot hold`);
      }
      blocks.push({ type: 'text', text: block.text });
    }
    blocks.push(...(anchored.get(node.id) ?? []));
  }
  return { blocks };
}

/** A rebuilt `user/message` is the message itself; every other type wraps one. */
function replacementData(
  node: DshSurfaceNode, blocks: readonly DshContentBlock[],
): Readonly<Record<string, unknown>> | null {
  if (node.type === 'user/message') return { ...node.data, content: blocks };
  const message = node.data['message'];
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  return { ...node.data, message: { ...(message as Record<string, unknown>), content: blocks } };
}

interface DshPairView {
  readonly type: DshSurfaceType;
  readonly callId?: string;
  readonly blocks: readonly DshContentBlock[];
}

function pairView(node: DshSurfaceNode): DshPairView {
  return { type: node.type, ...(node.callId === undefined ? {} : { callId: node.callId }),
    blocks: node.blocks };
}

/**
 * The adapter's own balance check (dsh never re-checks history relations on
 * append): a call keeps its result before the next message starts, and no
 * result outlives its call. A content-only `tool/result` rewrite keeps the
 * `callId`, which is exactly why that shape is the only legal multi-forget
 * revert on a tool result.
 */
function pairingFailure(nodes: readonly DshPairView[]): string | null {
  let pending: Set<string> | null = null;
  const unsettled = (): string | null => pending !== null && pending.size > 0
    ? `Tool calls ${[...pending].join(', ')} have no result before the next message` : null;
  for (const node of nodes) {
    if (node.type === 'assistant/message') {
      const blocked = unsettled();
      if (blocked !== null) return blocked;
      const calls = new Set<string>();
      for (const block of node.blocks) {
        if (block.type !== 'tool-call') continue;
        if (typeof block.id !== 'string' || block.id.length === 0) return 'A tool call carries no id';
        if (calls.has(block.id)) return `Tool call ${block.id} is duplicated`;
        calls.add(block.id);
      }
      pending = calls;
      continue;
    }
    if (node.type === 'tool/result') {
      if (node.callId === undefined || node.callId.length === 0) return 'A tool result names no call';
      if (pending === null || !pending.delete(node.callId)) {
        return `Tool result ${node.callId} has no matching call`;
      }
      continue;
    }
    if (node.type === 'user/message') {
      const blocked = unsettled();
      if (blocked !== null) return blocked;
    }
  }
  return unsettled();
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The plain UTF-8 body of a node's text blocks, in order. A partial keep's
 * archived bytes were read from exactly this form when the node was harvested,
 * so the comparison in `planRevertAppend` is byte-for-byte. A non-text block
 * cannot be part of a partial keep: its bytes were never on the model surface
 * as text, and re-emitting it as text would invent content.
 */
function textOnly(
  node: DshSurfaceNode,
): { readonly bytes: Uint8Array } | DshAppendRefusal {
  const parts: string[] = [];
  for (const block of node.blocks) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      return refused('unsupported-content',
        `Node ${node.id} carries a ${block.type} block a partial keep cannot hold`);
    }
    parts.push(block.text);
  }
  const text = parts.join('');
  // The archived bytes are a UTF-8 encoding of this exact text; the strict
  // decoder round-trip refuses a body the encoder cannot represent identically.
  const encoded = encoder.encode(text);
  try {
    if (strictDecoder.decode(encoded) !== text) {
      return refused('unsupported-content', `Node ${node.id} is not plain UTF-8 text`);
    }
  } catch {
    return refused('unsupported-content', `Node ${node.id} is not plain UTF-8 text`);
  }
  return { bytes: encoded };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * The one append. Ordering is the caller's contract: the ledger has already
 * prepared the application (archives and receipt records) before this runs, so
 * a receipt exists before any host mutation (ADR-0004).
 *
 * A thrown append leaves the host log unshortened: the outcome is `unknown`,
 * never `not-applied`, and the receipt written first stays an inert orphan
 * that recovery must tolerate and no path retries implicitly.
 *
 * `partialKeeps` is the application's archived keeplines data (ISSUE-017). The
 * caller derives it from the same archives the ledger prepared, so the kept
 * bytes the rebuild emits are the bytes recall can restore.
 */
export function applyValidatedRevert(
  session: DshRevertSession, revert: ValidatedRevert, receipts: readonly RenderedRecord[],
  partialKeeps: DshPartialKeepSet = NO_PARTIAL_KEEPS,
): DshRevertOutcome {
  const surface = session.surface();
  const planned = planRevertAppend(revert, receipts, surface, session.nextSeq(), partialKeeps);
  if (planned.status === 'refused') return planned;
  const { append } = planned;
  let seq: number;
  try {
    seq = session.append(append.type, append.data,
      { surfaceOp: append.surfaceOp, sourceEventSeqs: append.sourceEventSeqs }).seq;
  } catch (error) {
    return { status: 'unknown', append,
      detail: error instanceof Error ? error.message : 'The host append failed' };
  }
  // Read the surface back from the host: the append is committed, and whatever
  // the host spliced is the outcome (the adapter never guesses the splice).
  return { status: 'applied', seq, append, surface: session.surface() };
}
