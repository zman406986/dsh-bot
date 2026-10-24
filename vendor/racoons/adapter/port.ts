import type {
  ApplicationPort, ApplyReceipt, ApplyRequest, ApplyResult, Clock, ColdBoundary,
  EngineResult, IntentId, ReceiptLookup, SessionSnapshot, ToolResultNode,
} from '@racoons/core';
import { toCoreEnvelope, toCoreTranscript } from './envelope.js';
import type { DshToolResultItem, DshTranscriptItem } from './envelope.js';
import { stageApplication, stageRevert, checkRevertPlan } from './port-application.js';
import { applyValidatedRevert, partialKeepsFromArchives, revertPlanSha256,
  NO_PARTIAL_KEEPS } from './revert.js';
import type { DshPartialKeepSet, DshRevertSession } from './revert.js';

export type DshSessionState = Pick<SessionSnapshot, 'currentTurnOrdinal'
  | 'completedThroughTurnOrdinal' | 'currentStepOrdinal' | 'cache' | 'protection' | 'retentionEvidence'>;

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
}

export class DshApplicationPort implements ApplicationPort {
  private items: DshTranscriptItem[];
  private state: DshSessionState;
  private generation = 0;
  private pending: { eventId: string; item: DshToolResultItem } | undefined;
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
  private readonly uncertain = new Set<IntentId>();

  constructor(options: DshPortOptions) {
    this.sessionId = options.sessionId;
    this.clock = options.clock;
    this.revisionPrefix = options.revision ?? '0';
    this.failApply = options.failApply;
    this.publish = options.publish;
    this.revert = options.revert;
    this.items = structuredClone([...(options.transcript ?? [])]);
    this.state = structuredClone({ currentTurnOrdinal: 0, completedThroughTurnOrdinal: -1,
      currentStepOrdinal: 0, cache: { kind: 'unknown' }, retentionEvidence: [],
      protection: { inFlightTurnOrdinal: null, newestTailNodeIds: [], openApprovalNodeIds: [],
        policySpans: [], quotedThisTurn: [] }, ...options.state } satisfies DshSessionState);
  }

  private revision(): string { return `${this.revisionPrefix}:${this.generation}`; }

  transcript(): readonly DshTranscriptItem[] { return structuredClone(this.items); }

  /** Every authoritative host update advances revision, even a protection/cache-only update. */
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
    return structuredClone({ ...this.state, sessionId: this.sessionId, revision: this.revision(),
      nodes: toCoreTranscript(this.items).map(envelope => envelope.node) });
  }

  /** Stage a result already visible in the authoritative pre-step snapshot. No insertion. */
  stageEntry(eventId: string, item: DshToolResultItem): ToolResultNode {
    if (this.pending !== undefined && this.pending.eventId !== eventId) {
      throw new Error('An entry outcome is unresolved');
    }
    const index = this.items.findIndex(value => value.id === item.id);
    const live = this.items[index];
    if (live?.role !== 'tool' || live.callId !== item.callId) {
      throw new Error('Staged entry is not visible');
    }
    const node = toCoreEnvelope(live, index).node;
    const expected = toCoreEnvelope(item, index).node;
    if (node.sha256 !== expected.sha256) throw new Error('Staged entry bytes changed');
    this.pending = { eventId, item: structuredClone(live) };
    return node;
  }

  /** A definite refusal ends staging; an unknown outcome must keep it. */
  finishEntry(eventId: string): void {
    if (this.pending?.eventId === eventId) this.pending = undefined;
  }

  /** The callback only receives the normalized result; all body handling stays in this port. */
  deliverToolResult(
    eventId: string, item: DshToolResultItem,
    process: (node: ToolResultNode) => Promise<EngineResult>,
  ): Promise<EngineResult> {
    const owned = structuredClone(item);
    const delivery = this.deliveryQueue.then(async () => {
      const priorId = this.delivered.get(eventId);
      if (priorId !== undefined) {
        const prior = this.items.find(value => value.id === priorId);
        if (prior?.role !== 'tool' || priorId !== owned.id || prior.callId !== owned.callId) {
          throw new Error('Repeated entry identity changed');
        }
        return process(toCoreEnvelope(prior, this.items.indexOf(prior)).node);
      }
      if (this.pending !== undefined && this.pending.eventId !== eventId) {
        throw new Error('An entry outcome is unresolved');
      }
      if (this.pending === undefined) {
        if (this.items.some(value => value.id === owned.id)) throw new Error('Entry is already inserted');
        this.pending = { eventId, item: owned };
        this.generation += 1;
      }
      const incoming = this.pending.item;
      const node = toCoreEnvelope(incoming, this.items.length).node;
      const result = await process(node);
      if (result.status === 'recovery-pending') return result;
      if (this.pending !== undefined) {
        if (result.status === 'applied') throw new Error('Applied entry has no host receipt');
        this.items = [...this.items, structuredClone(incoming)];
        this.pending = undefined;
        this.generation += 1;
      }
      this.delivered.set(eventId, incoming.id);
      return result;
    });
    this.deliveryQueue = delivery.then(() => undefined, () => undefined);
    return delivery;
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
      || intent.applicationSha256 !== application.applicationSha256
      || (application.mode === 'entry' && this.pending?.eventId !== application.eventId)) {
      return { status: 'not-applied', reason: 'host-error' };
    }
    if (application.mode === 'revert') {
      if (application.phase !== 'at-rest') return { status: 'not-applied', reason: 'unsupported' };
      if (this.failApply === 'not-applied') return { status: 'not-applied', reason: 'host-error' };
      if (this.failApply === 'unknown') return { status: 'unknown' };
      return this.applyRevert(request);
    }
    if ((application.mode !== 'entry' && application.mode !== 'append')
      || (application.mode === 'entry' && application.phase !== 'entry')
      || (application.mode === 'append' && application.phase !== 'at-rest')) {
      return { status: 'not-applied', reason: 'unsupported' };
    }
    if (this.failApply === 'not-applied') return { status: 'not-applied', reason: 'host-error' };
    if (this.failApply === 'unknown') return { status: 'unknown' };
    try {
      const candidate = stageApplication(request, this.items, this.pending?.item,
        { ...this.state, sessionId: this.sessionId });
      const entryId = application.mode === 'entry' ? this.pending?.item.id : undefined;
      // An injected clock may itself invoke a host update; recheck after calling it.
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
      if (entryId !== undefined) {
        this.delivered.set(application.eventId, entryId);
        this.pending = undefined;
      }
      this.generation += 1;
      this.receipts.set(intent.intentId, receipt);
      return { status: 'applied', receipt };
    } catch {
      return { status: 'not-applied', reason: 'host-error' };
    }
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
    this.items = [...candidate];
    this.generation += 1;
    this.receipts.set(intent.intentId, receipt);
    return { status: 'applied', receipt };
  }
}

export function createDshPort(options: DshPortOptions): DshApplicationPort {
  return new DshApplicationPort(options);
}
