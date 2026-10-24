/**
 * The live host session as the adapter's revert seam (design-protocol §4).
 *
 * `revert.ts` already owns the whole application contract: one atomic
 * `append(type, data, {surfaceOp: {op:'replace', startSeq, endSeq},
 * sourceEventSeqs})` that shadows a contiguous current-surface span. What it
 * needs is the host: `surface()`, `nextSeq()` and that one append. A dsh
 * `Session` exposes exactly those (`session.surface.nodes`, `session.seq`,
 * `session.eventAt(seq)`, `session.append(...)`), so this module derives the
 * seam from the live object and nothing else.
 *
 * Capability truth (ISSUE-010): the derivation is the check. A session that
 * cannot answer the three calls yields `null`, the mount wires no seam, the
 * adapter declares `revertHistory: false`, and the engine records verdicts
 * with `unsupported-capability` instead of planning a removal it could not
 * apply. A present session yields a real seam, so the same flag can be true.
 *
 * Node identity is the port's own: `surfaceTranscript` names a message
 * `dsh:<session>:message:<seq>` and a result `dsh:<session>:result:<callId>`,
 * and `port.applyRevert` refuses when the host surface disagrees with the
 * transcript it holds. The formulas are repeated here (a runtime import of
 * `plugin.ts` would be a cycle); `mount-revert.test.ts` pins them against
 * `surfaceTranscript` so the pair cannot drift.
 */
import type { DshContentBlock, DshRevertSession, DshSurfaceNode,
  DshSurfaceType } from './revert.js';
import type { DshMountEvent, DshMountSession } from './plugin.js';

const SURFACE_TYPES: ReadonlySet<string> = new Set([
  'system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The port's transcript identity for one surface event. */
function nodeIdOf(sessionId: string, seq: number, type: string, callId: string): string {
  return type === 'tool/result'
    ? `dsh:${sessionId}:result:${callId}`
    : `dsh:${sessionId}:message:${String(seq)}`;
}

/** The call id on a tool result, from either host spelling (`plugin.ts` `callIdOf`). */
function callIdOf(data: Readonly<Record<string, unknown>>): string | null {
  const message = isRecord(data['message']) ? data['message'] : {};
  const source = isRecord(message['source']) ? message['source'] : {};
  if (typeof source['callId'] === 'string') return source['callId'];
  return typeof message['toolCallId'] === 'string' ? message['toolCallId'] : null;
}

/** The message payload a surface type derives from, matching `surfaceTranscript`. */
function contentOf(type: string, data: Readonly<Record<string, unknown>>): unknown {
  if (type === 'user/message') return data['content'];
  const message = isRecord(data['message']) ? data['message'] : {};
  return message['content'];
}

/**
 * The model-facing blocks of one node. Only `type`, `text` and a tool call's
 * `id` are read: a rebuild re-emits text and refuses every other block, so an
 * unmodelled block must stay visible as its own type rather than be flattened
 * into text that was never there.
 */
function blocksOf(type: string, data: Readonly<Record<string, unknown>>): DshContentBlock[] {
  const content = contentOf(type, data);
  if (!Array.isArray(content)) return [];
  const blocks: DshContentBlock[] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block['type'] !== 'string') continue;
    blocks.push({ type: block['type'],
      ...(typeof block['text'] === 'string' ? { text: block['text'] } : {}),
      ...(typeof block['id'] === 'string' ? { id: block['id'] } : {}) });
  }
  return blocks;
}

/**
 * One surface node, or null for the events the port's transcript also skips:
 * a non-surface type, and a `tool/result` that names no call (the projection
 * cannot pair it, so it never becomes a transcript item either).
 */
function surfaceNodeOf(sessionId: string, event: DshMountEvent): DshSurfaceNode | null {
  if (!SURFACE_TYPES.has(event.type)) return null;
  const type = event.type as DshSurfaceType;
  const data = isRecord(event.data) ? event.data : {};
  if (type !== 'tool/result') {
    return { id: nodeIdOf(sessionId, event.seq, type, ''), seq: event.seq, type,
      blocks: blocksOf(type, data), data };
  }
  const callId = callIdOf(data);
  // A result with no call id cannot be paired with its call, so the port's
  // transcript projection skips it too; the surface must agree.
  if (callId === null) return null;
  return { id: nodeIdOf(sessionId, event.seq, type, callId), seq: event.seq, type,
    blocks: blocksOf(type, data), callId, data };
}

/**
 * The live surface, in model-visible order. A seq the log cannot answer is a
 * host/log disagreement: the port plans against this list, so a silently
 * shorter surface would apply a plan to the wrong nodes. It throws instead, and
 * `port.applyRevert` turns that into `not-applied`/`host-error` before any
 * append.
 */
function surfaceOf(session: DshMountSession, sessionId: string): readonly DshSurfaceNode[] {
  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
  const surface: DshSurfaceNode[] = [];
  for (const seq of nodes) {
    const event = session.eventAt?.(seq);
    if (event === undefined) throw new Error(`racoons: the host surface names no event at seq ${String(seq)}`);
    const node = surfaceNodeOf(sessionId, event);
    if (node !== null) surface.push(node);
  }
  return surface;
}

/**
 * The seam a live dsh session supplies, or `null` when the object cannot
 * honour it. `eventAt` and a numeric `seq` are load-bearing: `nextSeq` bounds
 * every span (dsh's `seq === log.length`), and a surface read without
 * `eventAt` could only guess the nodes the plan must name.
 */
export function revertSessionFromHost(session: DshMountSession | undefined): DshRevertSession | null {
  if (session === undefined) return null;
  if (typeof session.append !== 'function' || typeof session.eventAt !== 'function'
    || typeof session.seq !== 'number' || !Array.isArray(session.surface?.nodes)) return null;
  const sessionId = session.id;
  return {
    surface: () => surfaceOf(session, sessionId),
    nextSeq: () => session.seq ?? 0,
    append: (type, data, intent) => ({ seq: session.append(type, data, { ...intent }).seq }),
  };
}
