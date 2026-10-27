import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ApplicationPort, ApplyReceipt, ApplyRequest, ApplyResult, ArchiveRecord, ByteRange, Bytes, Clock,
  ColdBoundary, EngineResult, EventId, IndexedRecall, IntentId, LedgerSourceReader, NodeId, RecallId,
  ReceiptLookup, SessionSnapshot, ToolResultNode, UnitId,
} from '@racoons/core';
import {
  concatBytes, CoverageMeter, FileSourceReader, sha256Sync, UnitTracker,
} from '@racoons/core';
import { toCoreEnvelope, toCoreTranscript } from './envelope.js';
import type { DshToolResultItem, DshTranscriptItem } from './envelope.js';
import { stageApplication, stageRevert, checkRevertPlan } from './port-application.js';
import { applyValidatedRevert, partialKeepsFromArchives, revertPlanSha256,
  NO_PARTIAL_KEEPS } from './revert.js';
import type { DshAppendableType, DshPartialKeepSet, DshRevertSession,
  DshSurfaceNode } from './revert.js';

export type DshSessionState = Pick<SessionSnapshot, 'currentTurnOrdinal'
  | 'completedThroughTurnOrdinal' | 'currentStepOrdinal' | 'cache' | 'retentionEvidence'>;

export interface DshPortOptions {
  readonly sessionId: string;
  readonly clock: Clock;
  readonly transcript?: readonly DshTranscriptItem[];
  readonly revision?: string;
  readonly state?: Partial<DshSessionState>;
  readonly failApply?: 'not-applied' | 'unknown';
  /**
   * The host's shadow-replace seam (design-protocol §4). Supplying it is what
   * makes `revertHistory` true; absent, revert mode keeps answering
   * `not-applied`/`unsupported`, because no code path could honour it. The
   * plugin derives it from the live session (`mount-revert.ts`), never from a
   * config flag.
   */
  readonly revert?: DshRevertSession;
  /** Synchronous host publication, after validation and before the receipt is committed. */
  readonly publish?: (request: ApplyRequest, candidate: readonly DshTranscriptItem[]) => void;
  /**
   * The host workspace root a recall's source lane may read inside (ISSUE-053;
   * PRD §6.7). Absent, or not absolute, means this mount cannot name the
   * boundary: it supplies no reader and a ledger miss stays `not-found`.
   */
  readonly workspaceRoot?: string;
}

/**
 * The turns one answered checkpoint moves (ISSUE-058 chunk P3a; ADR-0022
 * §11–§13). Every id is the port transcript's own: the result by its call id,
 * each turn by its host seq. `answerNodeId` is the LAST turn of the exchange —
 * with the one bounded retry (ADR-0022 §6) that is the correction turn's
 * answer, not the first one.
 *
 * The four ids name one range each branch rewinds:
 *
 * - keep-all — `[ask … answer]`, the instruction turn and every answer turn
 *   after it. `resultNodeId` is not moved; the landed result keeps its bytes
 *   and its id (§11).
 * - any forget — `[result … answer]`: the result turn and the whole exchange.
 *   One new turn carrying `summary` plus the shaped partials takes the result
 *   turn's place (§12).
 *
 * `summary` is the answer's own note, one line of at most 25 words as the entry
 * parser bounds it. It is wrapped ABOVE the shaped bytes by
 * `composeEntryShapeTurn`; it is never carried by a keep-all, which writes no
 * turn at all.
 *
 * The event id an exchange is filed under belongs to the ANSWERED entry event,
 * which must be a different id from the observation event that landed the
 * result: the engine answers one event id once, so reusing the observation's id
 * would make the answer a no-op replay.
 */
export interface DshAskExchange {
  /** The landed result's node id: the turn an apply rewinds past. */
  readonly resultNodeId: NodeId;
  /** The ask instruction turn's node id. */
  readonly askNodeId: NodeId;
  /** The exchange's last answer turn: the answer, or the correction turn's answer. */
  readonly answerNodeId: NodeId;
  /** The answer's note, wrapped above the shaped partials. Ignored by keep-all. */
  readonly summary: string;
}

/**
 * Why an entry write refused. Every code is decided BEFORE the first host
 * append, and a refusal writes nothing: it is an ordinary rejection the mount
 * journals (ADR-0022 §14), never a crash, and it never reaches the breaker —
 * the breaker counts completed validation refusals, not host arithmetic.
 */
export type DshEntryRefusalCode =
  /** No shadow-replace seam was supplied, so no surface write is possible. */
  | 'no-host-seam'
  /** The ask turn or the exchange's last answer turn is not on the surface. */
  | 'ask-exchange-missing'
  /** The landed result is not on the surface under the id the answer judged. */
  | 'result-turn-missing'
  /** The surface's result body is not the body the port's transcript holds. */
  | 'result-turn-changed'
  /** The range is inverted, or holds a node the exchange cannot shadow. */
  | 'span-not-contiguous'
  /** The bytes to land are not UTF-8 text a host message can carry. */
  | 'unsupported-content'
  /** There is no shaped body to land (an empty turn would append nothing). */
  | 'empty-turn';

export type DshEntryRefusal = {
  readonly status: 'refused';
  readonly code: DshEntryRefusalCode;
  readonly detail: string;
};

/**
 * What one entry write did (ISSUE-058 chunk P3a; ADR-0022 §11–§13).
 *
 * - `applied` — the surface now holds exactly the new state: the exchange is
 *   gone (both branches) and, for a forget, the result turn carries the new
 *   turn instead of the original bytes. `seq` is the last host event written.
 * - `refused` — nothing was written; see `DshEntryRefusalCode`.
 * - `unknown` — a host append threw, so the log may or may not hold it. The
 *   prefix before the result is unchanged either way, and the fail-open state
 *   (the result landed whole) is what a partially written forget leaves behind.
 *   Never retried implicitly, never reported as a refusal.
 */
export type DshEntryApplyOutcome =
  | { readonly status: 'applied'; readonly seq: number }
  | DshEntryRefusal
  | { readonly status: 'unknown'; readonly detail: string };

/**
 * The summary prefix a forget's appended turn opens with: the answer's note
 * collapsed to one line, then one blank line. Empty when the note is blank, so
 * a shapeless summary never leaves a stray blank line on the wire. Exported
 * beside `composeEntryShapeTurn` because the port shifts the marker ranges the
 * guard approved by exactly this length.
 */
export function entryShapePrefix(summary: string): Bytes {
  const line = summary.replace(/[\r\n\u2028\u2029]+/gu, ' ').trim();
  return line.length === 0 ? new Uint8Array(0) : new TextEncoder().encode(`${line}\n\n`);
}

/**
 * The one turn a forget lands (ADR-0022 §12): the answer's summary, one blank
 * line, then the shaped partials with one marker in each dropped gap. The
 * summary is collapsed to a single line first, because a turn that is not
 * instruction-plus-body would put the agent's prose on the wire as content.
 *
 * Exported so the mount journals the exact bytes it handed the host, and so a
 * test can pin the composition without re-deriving it.
 */
export function composeEntryShapeTurn(summary: string, shaped: Bytes): Bytes {
  return concatBytes(entryShapePrefix(summary), shaped);
}

const refused = (code: DshEntryRefusalCode, detail: string): DshEntryRefusal =>
  ({ status: 'refused', code, detail });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// `ignoreBOM` keeps a leading U+FEFF as content instead of swallowing it: the
// round-trip check below compares the re-encoded text with the planned bytes, so
// a body that does not survive encode(decode(bytes)) is refused rather than
// silently shortened.
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The model-facing text of one surface node, exactly as the surface fold reads it. */
function surfaceText(node: DshSurfaceNode): Uint8Array {
  return new TextEncoder().encode(node.blocks.map(block => block.text ?? '').join(''));
}

/**
 * The absolute form of one source path, or `null` when it leaves `root`. The
 * workspace root is the boundary the recall source lane may read inside
 * (ISSUE-053; PRD §6.7): a path that escapes it is not this mount's file, so it
 * is a miss, never a read.
 */
function sourcePathInside(root: string, path: string): string | null {
  const absolute = resolve(root, path);
  const inside = relative(root, absolute);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return null;
  }
  return absolute;
}

export class DshApplicationPort implements ApplicationPort {
  private items: DshTranscriptItem[];
  private state: DshSessionState;
  private generation = 0;
  private readonly receipts = new Map<IntentId, ApplyReceipt>();
  // Event identity only: original removed bodies belong exclusively in the core ledger.
  private readonly delivered = new Map<string, string>();
  private deliveryQueue: Promise<void> = Promise.resolve();
  private readonly sessionId: string;
  private readonly clock: Clock;
  private readonly revisionPrefix: string;
  private readonly failApply: DshPortOptions['failApply'];
  private readonly publish: DshPortOptions['publish'];
  private readonly revert: DshRevertSession | undefined;
  private readonly workspaceRoot: string | undefined;
  /**
   * Per-path byte coverage over every tool-result node this port holds (PRD
   * §6.6, gap G3; ISSUE-053). One meter per session, recorded on every
   * `snapshot()`, so a host sees the rows the engine plans against; recording
   * the same node twice is a no-op, so a re-snapshot cannot inflate a row.
   */
  private readonly coverage = new CoverageMeter();
  private readonly uncertain = new Set<IntentId>();
  /**
   * The manifests of the archives this port applied, with the file each part
   * came from (ISSUE-053). A ledger miss may answer from those files while
   * they still hold the archived bytes; nothing here caches bytes.
   */
  private readonly sources = new Map<RecallId, IndexedRecall>();
  /**
   * The ask exchanges this mount appended, keyed by the entry event id the
   * answer arrives under. `apply` reads one back when the engine applies that
   * event's shape; the mount records it with `recordAskExchange` before the
   * answered event is processed.
   */
  private readonly exchanges = new Map<EventId, DshAskExchange>();
  /** The last entry host write, consumed by the mount's journal (mirrors `takePublication`). */
  private lastEntryWrite: DshEntryApplyOutcome | null = null;

  constructor(options: DshPortOptions) {
    this.sessionId = options.sessionId;
    this.clock = options.clock;
    this.revisionPrefix = options.revision ?? '0';
    this.failApply = options.failApply;
    this.publish = options.publish;
    this.revert = options.revert;
    this.workspaceRoot = options.workspaceRoot === undefined ? undefined
      : isAbsolute(options.workspaceRoot) ? options.workspaceRoot : undefined;
    this.items = structuredClone([...(options.transcript ?? [])]);
    this.state = structuredClone({ currentTurnOrdinal: 0, completedThroughTurnOrdinal: -1,
      currentStepOrdinal: 0, cache: { kind: 'unknown' }, retentionEvidence: [],
      ...options.state } satisfies DshSessionState);
  }

  private revision(): string { return `${this.revisionPrefix}:${this.generation}`; }

  transcript(): readonly DshTranscriptItem[] { return structuredClone(this.items); }

  /** Every authoritative host update advances revision, even an ordinal/cache-only update. */
  setTranscript(items: readonly DshTranscriptItem[]): void {
    this.items = structuredClone([...items]);
    this.generation += 1;
  }

  updateState(state: Partial<DshSessionState>): void {
    this.state = structuredClone({ ...this.state, ...state });
    this.generation += 1;
  }

  setColdBoundary(boundary: ColdBoundary): void {
    this.updateState({ cache: { kind: 'cold', boundary } });
  }

  async snapshot(): Promise<SessionSnapshot> {
    const nodes = toCoreTranscript(this.items).map(envelope => envelope.node);
    // Every tool result the transcript holds is metered HERE, where the snapshot
    // is built, so the rows name exactly the nodes the engine plans against
    // (PRD §6.6, gap G3; ISSUE-053). Recording is idempotent per node id, so a
    // step's repeated snapshots cannot inflate a row, and a write's own
    // invalidation drops the rows it made stale (units/invalidation.ts).
    for (const node of nodes) if (node.kind === 'tool-result') this.coverage.record(node);
    return structuredClone({ ...this.state, sessionId: this.sessionId, revision: this.revision(),
      nodes, pathCoverage: this.coverage.bytesByPath() });
  }

  /**
   * A result lands unconditionally (ISSUE-058 chunk P3a; ADR-0022 §2).
   *
   * The host writes every result before RACOONS sees it, so this method never
   * inserts, stages or rewrites one: it hands the engine the landed node and
   * reports what the engine decided. The old pending-staging machinery — the
   * "held back until applied" entry, its insertion and its
   * `Applied entry has no host receipt` gate — is gone with the pre-landing
   * protocol. A replayed delivery repeats its node identity and is answered
   * from the transcript, so a doubled capture cannot become two decisions.
   *
   * The callback only receives the normalized node; all body handling stays in
   * this port.
   */
  deliverToolResult(
    eventId: string, item: DshToolResultItem,
    process: (node: ToolResultNode) => Promise<EngineResult>,
  ): Promise<EngineResult> {
    const owned = structuredClone(item);
    const delivery = this.deliveryQueue.then(async () => {
      // One host event is one result identity. A retry under the same event id
      // must name the same node; answering it again is safe because the engine
      // dedups by event id, so a doubled capture cannot become two decisions.
      const priorId = this.delivered.get(eventId);
      if (priorId !== undefined && priorId !== owned.id) {
        throw new Error('Repeated entry identity changed');
      }
      const index = this.items.findIndex(value => value.id === owned.id);
      const landed = index < 0 ? owned : this.items[index] ?? owned;
      if (landed.role !== 'tool' || landed.callId !== owned.callId) {
        throw new Error('Landed entry changed');
      }
      // The node handed on is the one the host wrote: the snapshot's own item
      // when the transcript already holds it, the captured item otherwise.
      this.delivered.set(eventId, landed.id);
      return process(toCoreEnvelope(landed, index < 0 ? this.items.length : index).node);
    });
    this.deliveryQueue = delivery.then(() => undefined, () => undefined);
    return delivery;
  }

  /**
   * The whole-result unit id of one landed node, or `null` when the transcript
   * holds no tool result under that id (ISSUE-058 chunk P3a; ADR-0022 §2).
   *
   * The mount stamps an answered entry event with this id, and the guard
   * re-derives it from the landed node itself, so a stamp minted here and a
   * stamp minted by the guard can only agree. The bar is 0 on purpose: the
   * landed result is one unit whatever its size, because the answer already
   * decided it is the checkpoint's subject. The bytes never leave this module.
   */
  landedUnitId(nodeId: NodeId): UnitId | null {
    const item = this.items.find(value => value.id === nodeId);
    if (item === undefined || item.role !== 'tool') return null;
    const node = toCoreEnvelope(item, this.items.indexOf(item)).node;
    return new UnitTracker({ sessionId: this.sessionId, barBytes: 0 })
      .unitsFor(node)[0]?.id ?? null;
  }

  /**
   * Record the ask exchange the mount appended for one landed result, keyed by
   * the entry event id its answer will arrive under (ISSUE-058 chunk P3a). Pure
   * bookkeeping: no host write, no revision change. `apply` reads it back when
   * the engine applies that event's shape; a missing record refuses the write
   * rather than guessing which turns the answer judged.
   */
  recordAskExchange(eventId: EventId, exchange: DshAskExchange): void {
    this.exchanges.set(eventId, structuredClone(exchange));
  }

  /** The host write the last entry application performed, consumed once. */
  takeEntryWrite(): DshEntryApplyOutcome | null {
    const value = this.lastEntryWrite;
    this.lastEntryWrite = null;
    return value;
  }

  /**
   * The source index a ledger miss may answer from, or `null` when this mount
   * cannot name the boundary (ISSUE-053; PRD §6.7). A mount opened with no
   * workspace root supplies no reader, so a miss stays `not-found`; a mount
   * that has applied no archive yet has no path to name, and answers the same.
   * Rebuilt per call and caching no bytes, so a file edited after the archive
   * was minted is refused by the reader's own hash check, never substituted.
   */
  recallReader(): LedgerSourceReader | null {
    if (this.workspaceRoot === undefined || this.sources.size === 0) return null;
    return new FileSourceReader([...this.sources.values()]);
  }

  /**
   * Remember where each part of every archive just applied came from, so a
   * later ledger miss can re-read it (ISSUE-053). The path is the transcript's
   * own target for the archived node, resolved inside the workspace root; a
   * part whose path is unknown or outside the root drops the whole record,
   * because a source lane may name only files this mount could have read.
   */
  private indexSources(archives: readonly ArchiveRecord[]): void {
    const root = this.workspaceRoot;
    if (root === undefined) return;
    for (const archive of archives) {
      const paths: string[] = [];
      for (const part of archive.recall.manifest.parts) {
        const item = this.items.find(value => value.id === part.source.nodeId);
        const named = item?.role === 'tool' ? item.target?.key ?? null : null;
        const path = named === null ? null : sourcePathInside(root, named);
        if (path === null) { paths.length = 0; break; }
        paths.push(path);
      }
      if (paths.length === 0) continue;
      this.sources.set(archive.recall.id, { recallId: archive.recall.id,
        manifest: archive.recall.manifest, paths });
    }
  }

  /**
   * Keep-all: drop the ask exchange and leave everything else alone (ISSUE-058
   * chunk P3a; ADR-0022 §11).
   *
   * ONE host write: a replace over `[ask … answer]` whose replacement node
   * carries no content. dsh's surface has no delete op, so a contentless node
   * is how a range leaves the model wire — it projects to no message, and the
   * result turn's bytes and id are untouched, exactly as §11 requires. A
   * host that refuses the range writes nothing.
   */
  rewindAskExchange(exchange: DshAskExchange): DshEntryApplyOutcome {
    const session = this.revert;
    if (session === undefined) return refused('no-host-seam', 'No shadow-replace seam was supplied');
    const range = this.exchangeRange(session, exchange);
    if ('status' in range) return range;
    const outcome = this.writeEmptyRange(session, range);
    if (outcome.status === 'applied') {
      this.items = this.items.filter(item => !range.shadowedIds.has(item.id));
      this.generation += 1;
      this.forgetExchange(exchange);
    }
    this.lastEntryWrite = outcome;
    return outcome;
  }

  /**
   * Any forget: rewind past the result turn and land ONE new turn (ISSUE-058
   * chunk P3a; ADR-0022 §12).
   *
   * `shapedBytes` is core's `replacementBytes` — the kept partials with one
   * marker in each dropped gap — and this method wraps the answer's summary
   * above it (`composeEntryShapeTurn`). The original result bytes never reach
   * the model's wire after this write; the archive the ledger prepared still
   * holds them, so recall stays byte-exact.
   *
   * dsh cannot express the whole move as one surface op: a `tool/result`
   * replacement must rewrite exactly one node, and the result is a
   * `tool/result`. So the write is the exchange's rewind first, then a
   * content-only rewrite of the result turn. Order matters: an interruption
   * after the first append leaves the fail-open state — result whole, exchange
   * gone — never a shaped turn with the question still above it.
   *
   * `embeddedRecords` are the marker ranges of `shapedBytes` (core's
   * `generatedRanges`), so the port's transcript keeps the same record
   * boundaries the guard approved.
   */
  applyEntryShape(
    exchange: DshAskExchange, shapedBytes: Bytes,
    embeddedRecords: readonly ByteRange[] = [],
  ): DshEntryApplyOutcome {
    const session = this.revert;
    if (session === undefined) return refused('no-host-seam', 'No shadow-replace seam was supplied');
    if (shapedBytes.length === 0) return refused('empty-turn', 'There is no shaped body to land');
    const range = this.exchangeRange(session, exchange);
    if ('status' in range) return range;
    const resultIndex = range.surface.findIndex(node => node.id === exchange.resultNodeId);
    if (resultIndex < 0) {
      return refused('result-turn-missing',
        `The landed result ${exchange.resultNodeId} is not on the surface`);
    }
    const resultNode = range.surface[resultIndex];
    if (resultNode === undefined || resultNode.type !== 'tool/result') {
      return refused('result-turn-missing',
        `${exchange.resultNodeId} names no tool result on the surface`);
    }
    if (resultIndex > range.askIndex) {
      return refused('span-not-contiguous',
        'The landed result is not before the ask exchange it judged');
    }
    const mirrored = this.items.find(item => item.id === exchange.resultNodeId);
    if (mirrored?.role !== 'tool') {
      return refused('result-turn-missing',
        `The transcript holds no landed result ${exchange.resultNodeId}`);
    }
    if (sha256Sync(surfaceText(resultNode)) !== sha256Sync(mirrored.bytes)) {
      return refused('result-turn-changed',
        'The surface result body differs from the body the answer judged');
    }
    const turn = composeEntryShapeTurn(exchange.summary, shapedBytes);
    // The turn's own text, not the bare shaped bytes: the summary rides ABOVE
    // the partials in the one turn this write lands (ADR-0022 §12).
    let turnText: string;
    try { turnText = strictDecoder.decode(turn); }
    catch {
      return refused('unsupported-content',
        'The answer notes and shaped bytes do not compose into UTF-8 text');
    }
    const rewound = this.writeEmptyRange(session, range);
    if (rewound.status !== 'applied') return rewound;
    let shapedSeq: number;
    try {
      const data = resultNode.data;
      const message = isRecord(data['message']) ? data['message'] : {};
      shapedSeq = session.append('tool/result', {
        turn: data['turn'], step: data['step'],
        message: { ...message, content: [{ type: 'text', text: turnText }] },
        ...data['meta'] === undefined ? {} : { meta: data['meta'] },
        ...data['error'] === undefined ? {} : { error: data['error'] },
      }, { surfaceOp: { op: 'replace', startSeq: resultNode.seq, endSeq: resultNode.seq },
        sourceEventSeqs: [resultNode.seq] }).seq;
    } catch (error) {
      // The exchange's rewind committed and the new turn did not. The port's
      // transcript follows the surface it can actually observe — exchange gone,
      // result whole — which IS the fail-open state (ADR-0022 §14). Nothing is
      // retried and the ledger reconciles the receipt.
      this.items = this.items.filter(item => !range.shadowedIds.has(item.id));
      this.generation += 1;
      const detail = error instanceof Error ? error.message : 'The host append failed';
      const unknown: DshEntryApplyOutcome = { status: 'unknown', detail };
      this.lastEntryWrite = unknown;
      return unknown;
    }
    // The transcript's record boundaries are the marker ranges the guard
    // approved, shifted by the summary prefix this port wraps above them.
    const shift = entryShapePrefix(exchange.summary).length;
    const records = embeddedRecords.map(range => ({
      startByte: range.startByte + shift, endByteExclusive: range.endByteExclusive + shift,
    }));
    this.items = this.items
      .filter(item => !range.shadowedIds.has(item.id))
      .map(item => item.id !== exchange.resultNodeId ? item
        : { ...item, bytes: composeEntryShapeTurn(exchange.summary, shapedBytes),
            embeddedRecords: records });
    this.generation += 1;
    this.forgetExchange(exchange);
    const applied: DshEntryApplyOutcome = { status: 'applied', seq: shapedSeq };
    this.lastEntryWrite = applied;
    return applied;
  }

  /** Drop the record keyed by this exchange, whichever event id it was filed under. */
  private forgetExchange(exchange: DshAskExchange): void {
    for (const [eventId, recorded] of this.exchanges) {
      if (recorded.askNodeId === exchange.askNodeId
        && recorded.resultNodeId === exchange.resultNodeId) this.exchanges.delete(eventId);
    }
  }

  /**
   * The surface span one exchange names, or the refusal that stops the write.
   * The range never holds a `tool/result`: the exchange is instruction and
   * answer turns, and a result inside it means the ids do not name one
   * exchange.
   */
  private exchangeRange(
    session: DshRevertSession, exchange: DshAskExchange,
  ): { readonly surface: readonly DshSurfaceNode[]; readonly askIndex: number;
      readonly shadowedIds: ReadonlySet<NodeId>; readonly startSeq: number;
      readonly endSeq: number; readonly shadowedSeqs: readonly number[] } | DshEntryRefusal {
    const surface = session.surface();
    const askIndex = surface.findIndex(node => node.id === exchange.askNodeId);
    const answerIndex = surface.findIndex(node => node.id === exchange.answerNodeId);
    if (askIndex < 0 || answerIndex < 0) {
      return refused('ask-exchange-missing',
        `The exchange ${exchange.askNodeId}…${exchange.answerNodeId} is not on the surface`);
    }
    if (askIndex > answerIndex) {
      return refused('span-not-contiguous', 'The ask turn is after the answer turn it names');
    }
    const shadowed = surface.slice(askIndex, answerIndex + 1);
    if (shadowed.some(node => node.type === 'tool/result')) {
      return refused('span-not-contiguous',
        'The ask exchange range holds a tool result the exchange does not own');
    }
    const start = shadowed[0], end = shadowed[shadowed.length - 1];
    if (start === undefined || end === undefined) {
      return refused('span-not-contiguous', 'The ask exchange range is empty');
    }
    if (start.type === 'assistant/message') {
      return refused('span-not-contiguous', 'A replacement may not start at an assistant turn');
    }
    return { surface, askIndex, shadowedIds: new Set(shadowed.map(node => node.id)),
      startSeq: start.seq, endSeq: end.seq, shadowedSeqs: shadowed.map(node => node.seq) };
  }

  /**
   * ONE host append that replaces the exchange with a node that projects to no
   * message. `system/message` with empty content is the host's own delete idiom
   * and carries the host ordinals of the turn it takes over; when the exchange
   * names no such ordinals, a contentless `user/message` is the only type the
   * host accepts anywhere in a step.
   */
  private writeEmptyRange(
    session: DshRevertSession,
    range: { readonly startSeq: number; readonly endSeq: number;
      readonly shadowedSeqs: readonly number[]; readonly surface: readonly DshSurfaceNode[]; },
  ): DshEntryApplyOutcome {
    let turn: number | null = null, step: number | null = null;
    for (const seq of range.shadowedSeqs) {
      const node = range.surface.find(candidate => candidate.seq === seq);
      if (node !== undefined && isCount(node.data['turn']) && isCount(node.data['step'])) {
        turn = node.data['turn']; step = node.data['step']; break;
      }
    }
    const replacement: { type: DshAppendableType; data: Readonly<Record<string, unknown>> } =
      turn !== null && step !== null
        ? { type: 'system/message', data: { turn, step,
            message: { id: randomUUID(), role: 'system', content: [],
              source: { kind: 'system-prompt' } } } }
        : { type: 'user/message', data: { id: randomUUID(), role: 'user', content: [],
            source: { kind: 'user' } } };
    try {
      const seq = session.append(replacement.type, replacement.data, {
        surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
        sourceEventSeqs: [...range.shadowedSeqs],
      }).seq;
      return { status: 'applied', seq };
    } catch (error) {
      return { status: 'unknown',
        detail: error instanceof Error ? error.message : 'The host append failed' };
    }
  }

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const prior = this.receipts.get(request.intent.intentId);
    if (prior !== undefined) {
      return prior.applicationSha256 === request.intent.applicationSha256
        && prior.applicationSha256 === request.application.applicationSha256
        && prior.sessionId === request.intent.sessionId
        && prior.sessionId === request.application.sessionId
        && prior.baseRevision === request.intent.baseRevision
        && prior.baseRevision === request.application.baseRevision
        && request.intent.eventId === request.application.eventId
        ? { status: 'applied', receipt: prior }
        : { status: 'not-applied', reason: 'host-error' };
    }
    if (this.uncertain.has(request.intent.intentId)) return { status: 'unknown' };
    // No await between observing live state and committing the complete candidate.
    const { application, intent } = request;
    if (application.baseRevision !== this.revision() || intent.baseRevision !== this.revision()) {
      return { status: 'not-applied', reason: 'stale-revision' };
    }
    if (intent.sessionId !== this.sessionId || application.sessionId !== this.sessionId
      || intent.eventId !== application.eventId
      || intent.applicationSha256 !== application.applicationSha256) {
      return { status: 'not-applied', reason: 'host-error' };
    }
    if (application.mode === 'revert') {
      if (application.phase !== 'at-rest') return { status: 'not-applied', reason: 'unsupported' };
      if (this.failApply === 'not-applied') return { status: 'not-applied', reason: 'host-error' };
      if (this.failApply === 'unknown') return { status: 'unknown' };
      return this.applyRevert(request);
    }
    // An entry application is the answered checkpoint's shaped turn (ADR-0022
    // §12): the port performs the rewind-and-append itself, so no candidate is
    // staged and `publish` is never called for it — the host write IS the port's.
    if (application.mode === 'entry') {
      if (application.phase !== 'entry') return { status: 'not-applied', reason: 'unsupported' };
      if (this.failApply === 'not-applied') return { status: 'not-applied', reason: 'host-error' };
      if (this.failApply === 'unknown') return { status: 'unknown' };
      return this.applyEntry(request);
    }
    if (application.mode !== 'append' || application.phase !== 'at-rest') {
      return { status: 'not-applied', reason: 'unsupported' };
    }
    if (this.failApply === 'not-applied') return { status: 'not-applied', reason: 'host-error' };
    if (this.failApply === 'unknown') return { status: 'unknown' };
    try {
      const candidate = stageApplication(request, this.items,
        { ...this.state, sessionId: this.sessionId });
      const appliedAtMs = this.clock.nowMs();
      if (application.baseRevision !== this.revision()) {
        return { status: 'not-applied', reason: 'stale-revision' };
      }
      const receipt: ApplyReceipt = Object.freeze({ intentId: intent.intentId,
        sessionId: this.sessionId, baseRevision: intent.baseRevision,
        resultRevision: `${this.revisionPrefix}:${this.generation + 1}`,
        applicationSha256: intent.applicationSha256, appliedAtMs });
      if (this.publish !== undefined) {
        try { this.publish(request, structuredClone(candidate)); }
        catch {
          this.uncertain.add(intent.intentId);
          return { status: 'unknown' };
        }
      }
      this.items = candidate;
      this.generation += 1;
      this.receipts.set(intent.intentId, receipt);
      return { status: 'applied', receipt };
    } catch {
      return { status: 'not-applied', reason: 'host-error' };
    }
  }

  /**
   * The answered checkpoint's host write, as one receipt (ADR-0022 §12). The
   * exchange was recorded before the engine planned the answer; a missing
   * record, a replacement naming another node, or a refused write are all
   * `not-applied` — an ordinary rejection the engine journals as abandoned, so
   * the breaker never sees a host's arithmetic.
   */
  private applyEntry(request: ApplyRequest): ApplyResult {
    const { application, intent } = request;
    const exchange = this.exchanges.get(application.eventId);
    const replacement = application.replacements[0];
    if (exchange === undefined || replacement === undefined) {
      return { status: 'not-applied', reason: 'host-error' };
    }
    if (replacement.source.nodeId !== exchange.resultNodeId) {
      return { status: 'not-applied', reason: 'host-error' };
    }
    // The proven marker ranges ride onto the landed transcript item, so the
    // port's own snapshot keeps the record boundaries the guard approved.
    const outcome = this.applyEntryShape(exchange, replacement.bytes,
      replacement.generatedRanges);
    if (outcome.status === 'unknown') {
      this.uncertain.add(intent.intentId);
      return { status: 'unknown' };
    }
    if (outcome.status === 'refused') {
      return { status: 'not-applied',
        reason: outcome.code === 'no-host-seam' ? 'unsupported'
          : outcome.code === 'result-turn-changed' ? 'stale-revision' : 'host-error' };
    }
    const receipt: ApplyReceipt = Object.freeze({ intentId: intent.intentId,
      sessionId: this.sessionId, baseRevision: intent.baseRevision,
      resultRevision: `${this.revisionPrefix}:${this.generation}`,
      applicationSha256: intent.applicationSha256, appliedAtMs: this.clock.nowMs() });
    this.receipts.set(intent.intentId, receipt);
    return { status: 'applied', receipt };
  }

  async lookupReceipt(intentId: IntentId): Promise<ReceiptLookup> {
    // Absence from this process's map is not a refusal: only a positive host
    // record can answer not-applied (ADR-0015, ISSUE-030 R1).
    const receipt = this.receipts.get(intentId);
    return receipt !== undefined ? { status: 'applied', receipt } : { status: 'unknown' };
  }

  /**
   * Applies one approved checkpoint-revert as exactly one host append
   * (design-protocol §4). Ordering: the engine's ledger `prepare` has already
   * written the archives and the receipt records before this method runs, so
   * the receipt precedes the host mutation and a crash between them leaves an
   * inert orphan, never a lost restoration source (ADR-0004).
   *
   * Refusals, all before the single append: an undeclared seam, a mismatched
   * plan digest, a transcript that no longer matches the host surface, a
   * receipt the application does not ship, and every §4 shape precondition
   * (`revert.ts`). A thrown append returns `unknown` and leaves the host log
   * unshortened; it is never reported as `not-applied` and never retried here.
   */
  private applyRevert(request: ApplyRequest): ApplyResult {
    const { application, intent } = request;
    const revert = application.revert;
    if (revert === undefined) return { status: 'not-applied', reason: 'host-error' };
    const session = this.revert;
    if (session === undefined) return { status: 'not-applied', reason: 'unsupported' };
    let candidate: readonly DshTranscriptItem[];
    let partialKeeps: DshPartialKeepSet = NO_PARTIAL_KEEPS;
    try {
      // ADR-0004: the host applies exactly what the ledger prepared. Recompute
      // the plan digest before anything moves, so a substituted cut, anchor or
      // cost refuses rather than silently rewriting a different prefix.
      if (revertPlanSha256(revert) !== revert.planSha256) {
        return { status: 'not-applied', reason: 'host-error' };
      }
      const surface = session.surface();
      if (surface.length !== this.items.length
        || surface.some((node, index) => node.id !== this.items[index]?.id)) {
        // The approved cut indexes the snapshot; a host surface that disagrees
        // with it would apply the plan to a different node.
        return { status: 'not-applied', reason: 'stale-revision' };
      }
      // The host's own re-derivation of the approved plan's claims: cost
      // identity, anchors, receipt integrity and count.
      if (checkRevertPlan(revert, application.appendRecords, this.items) !== null) {
        return { status: 'not-applied', reason: 'host-error' };
      }
      // ISSUE-017: a `keeplines` verdict's kept bytes reach the host only
      // through the archives the ledger prepared. Derive them here, from the
      // same archives, with the same core complement the guard re-derived, so
      // the rebuild carries what recall can restore; a malformed archive
      // refuses before the append instead of keeping a guessed remainder.
      partialKeeps = partialKeepsFromArchives(application.archives);
      if (partialKeeps.status === 'invalid') return { status: 'not-applied', reason: 'host-error' };
      candidate = stageRevert(revert, application.appendRecords, this.items,
        { ...this.state, sessionId: this.sessionId });
    } catch {
      // Nothing has been appended yet: a definite refusal is safe here.
      return { status: 'not-applied', reason: 'host-error' };
    }
    const outcome = applyValidatedRevert(session, revert, application.appendRecords, partialKeeps);
    if (outcome.status === 'refused') return { status: 'not-applied', reason: 'unsupported' };
    if (outcome.status === 'unknown') {
      this.uncertain.add(intent.intentId);
      return { status: 'unknown' };
    }
    const receipt: ApplyReceipt = Object.freeze({ intentId: intent.intentId,
      sessionId: this.sessionId, baseRevision: intent.baseRevision,
      resultRevision: `${this.revisionPrefix}:${this.generation + 1}`,
      applicationSha256: intent.applicationSha256, appliedAtMs: this.clock.nowMs() });
    // The archives are banked before this call (ADR-0004), and their parts'
    // paths come from the transcript the revert is about to replace, so the
    // index is built while the forgotten nodes are still addressable (ISSUE-053).
    this.indexSources(application.archives);
    this.items = [...candidate];
    this.generation += 1;
    this.receipts.set(intent.intentId, receipt);
    return { status: 'applied', receipt };
  }
}

export function createDshPort(options: DshPortOptions): DshApplicationPort {
  return new DshApplicationPort(options);
}
