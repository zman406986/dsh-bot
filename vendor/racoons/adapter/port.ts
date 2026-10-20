import type {
  ApplicationPort, ApplyReceipt, ApplyRequest, ApplyResult, Clock, ColdBoundary, EngineResult,
  IntentId, ReceiptLookup, SessionSnapshot, ToolResultNode,
} from '@racoons/core';
import { toCoreEnvelope, toCoreTranscript } from './envelope.js';
import type { DshToolResultItem, DshTranscriptItem } from './envelope.js';
import { stageApplication } from './port-application.js';

export type DshSessionState = Pick<SessionSnapshot, 'currentTurnOrdinal'
  | 'completedThroughTurnOrdinal' | 'currentStepOrdinal' | 'cache' | 'protection' | 'retentionEvidence'>;

export interface DshPortOptions {
  readonly sessionId: string;
  readonly clock: Clock;
  readonly transcript?: readonly DshTranscriptItem[];
  readonly revision?: string;
  readonly state?: Partial<DshSessionState>;
  readonly failApply?: 'not-applied' | 'unknown';
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
  private readonly uncertain = new Set<IntentId>();

  constructor(options: DshPortOptions) {
    this.sessionId = options.sessionId;
    this.clock = options.clock;
    this.revisionPrefix = options.revision ?? '0';
    this.failApply = options.failApply;
    this.publish = options.publish;
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
    const receipt = this.receipts.get(intentId);
    return receipt !== undefined ? { status: 'applied', receipt }
      : this.uncertain.has(intentId) ? { status: 'unknown' } : { status: 'not-applied' };
  }
}

export function createDshPort(options: DshPortOptions): DshApplicationPort {
  return new DshApplicationPort(options);
}
