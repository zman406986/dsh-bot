import { Guard } from '../guard/guard.js';
import type { ValidationResult } from '../guard/types.js';
import type { LedgerEntry } from '../ledger/types.js';
import type { RecallId } from '../types/identity.js';
import type { HarnessObservation, TelemetryEvent } from '../types/telemetry.js';
import { sha256 } from '../util/hash.js';
import { applyApplication } from './application.js';
import { committedState } from './committed.js';
import { breakerState, metadata, readEntries } from './journal.js';
import { announceBreaker, persistBreaker } from './notice.js';
import { detectEpisodes, planApplication } from './planning.js';
import { recoverPending } from './recovery.js';
import { TranscriptTelemetry } from './telemetry.js';
import type { EngineInput, EngineOptions, EngineResult } from './types.js';

type EventPayload<T = TelemetryEvent> = T extends TelemetryEvent
  ? Omit<T, 'sessionId' | 'atMs'> : never;
const result = (status: EngineResult['status'], validation: ValidationResult | null = null): EngineResult =>
  ({ status, validation, intentId: null, receipt: null });

export class RacoonsEngine {
  private readonly telemetry: TranscriptTelemetry;
  private readonly options: EngineOptions;
  private queue: Promise<void> = Promise.resolve();
  private readonly unchangedEvents = new Set<string>();
  private readonly seenRefetches = new Set<string>();
  private faulted = false;

  private constructor(options: EngineOptions) {
    this.options = options;
    this.telemetry = new TranscriptTelemetry(options.onTelemetry);
  }

  static async open(options: EngineOptions): Promise<RacoonsEngine> {
    return new RacoonsEngine({ ...options, capabilities: structuredClone(options.capabilities),
      config: structuredClone(options.config), rules: [...options.rules] });
  }

  process(input: EngineInput): Promise<EngineResult> {
    const owned = structuredClone(input);
    const pending = this.queue.then(() => this.run(owned)).catch((error: unknown) => {
      this.faulted = true;
      this.emit({ kind: 'error', eventId: owned.eventId, stage: 'recovery',
        message: error instanceof Error ? error.message : 'Engine could not establish safe state' });
      return result('recovery-pending');
    });
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  observe(observation: HarnessObservation): void {
    if (observation.kind === 'usage') {
      const reading = this.options.meter.reconcile(structuredClone(observation));
      if (this.telemetry.usage(reading)) this.emit({ kind: 'usage-reconciled', reading });
    } else if (this.telemetry.forcedLoss(observation)) {
      this.emit({ kind: 'forced-loss', observation: structuredClone(observation) });
    }
  }

  async recall(id: RecallId) {
    const record = await this.options.ledger.recall(id);
    this.emit({ kind: 'recall', recallId: id,
      restoredBytes: record.parts.reduce((sum, part) => sum + part.bytes.length, 0) });
    return record;
  }

  private emit(event: EventPayload): void {
    try {
      this.telemetry.emit({ ...event, sessionId: this.options.sessionId,
        atMs: this.options.clock.nowMs() } as TelemetryEvent);
    } catch { /* Telemetry failures cannot alter engine outcomes. */ }
  }

  private async run(input: EngineInput): Promise<EngineResult> {
    const o = this.options;
    // 1. Copy the live snapshot and reconcile before any new planning.
    let snapshot = structuredClone(await o.port.snapshot());
    if (snapshot.sessionId !== o.sessionId) throw new Error('Snapshot belongs to another session');
    const recovery = await recoverPending(o.ledger, o.port, o.sessionId);
    if (recovery.status === 'blocked' || this.faulted) {
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'recovery-pending' });
      return { ...result('recovery-pending'), intentId: recovery.intentIds[0] ?? null };
    }
    if (recovery.status === 'reconciled') snapshot = structuredClone(await o.port.snapshot());
    if (snapshot.sessionId !== o.sessionId) throw new Error('Snapshot belongs to another session');
    const entries = await readEntries(o.ledger, o.sessionId);
    // 2. Rebuild episodes, then confirm committed seal state against host receipts.
    const episodes = detectEpisodes(o, snapshot);
    const committed = await committedState(entries, o.port);
    if (committed.blocked) return result('recovery-pending');
    const state = breakerState(entries);
    if (state.disabled) {
      await persistBreaker(o, snapshot.currentTurnOrdinal, entries);
      const notice = await announceBreaker(o, this.telemetry, snapshot,
        await readEntries(o.ledger, o.sessionId), committed.notices);
      return result(notice === 'blocked' ? 'recovery-pending' : 'disabled');
    }
    const prior = committed.events.get(input.eventId);
    if (committed.events.has(input.eventId)) {
      return { ...result(prior === null || prior === undefined ? 'unchanged' : 'applied'),
        intentId: prior?.intentId ?? null, receipt: prior ?? null };
    }
    if (this.unchangedEvents.has(input.eventId)) return result('unchanged');
    const priorValidation = entries.find(({ event }) => event.kind === 'validation'
      && event.eventId === input.eventId)?.event;
    if (priorValidation?.kind === 'validation') {
      // Validation persisted but no applied intent: never replay this event automatically.
      return priorValidation.ok ? result('unchanged') : result('rejected', {
        ok: false, issues: priorValidation.issues, breaker: priorValidation.breaker,
      });
    }
    await this.refetch(input, entries);
    if (input.kind === 'at-rest' && !o.capabilities.atRest) return result('unchanged');
    // 3–4. Fresh zone, protection, and isolated rules share one base revision.
    const nowMs = o.clock.nowMs();
    const plans = planApplication(o, input, snapshot, episodes, committed.sealedEpisodeIds, nowMs);
    if (plans.length === 0) {
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'no-plan' });
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    // 5–6. Guard validates all plans, builds recall identities, renders, and
    // validates final retained bytes before returning a branded application.
    const guard = o.guard ?? new Guard({ ledger: o.ledger, initialState: state });
    const validation = await guard.validate({ input, snapshot,
      capabilities: o.capabilities, config: o.config, plans,
      sealedEpisodeIds: committed.sealedEpisodeIds, nowMs });
    const validationEvent = { kind: 'validation' as const, sessionId: o.sessionId,
      eventKey: `engine-validation:${JSON.stringify([o.sessionId, input.eventId])}`,
      atMs: nowMs, eventId: input.eventId, ok: validation.ok,
      issues: validation.ok ? [] : validation.issues, breaker: validation.breaker,
      engineTurnOrdinal: snapshot.currentTurnOrdinal };
    await o.ledger.append(validationEvent);
    this.emit({ kind: 'validation', eventId: input.eventId, ok: validation.ok,
      issues: validationEvent.issues, breaker: validation.breaker });
    if (!validation.ok) {
      if (validation.breaker.disabled) {
        await persistBreaker(o, snapshot.currentTurnOrdinal, await readEntries(o.ledger, o.sessionId));
        this.emit({ kind: 'breaker-disabled', consecutiveValidationFailures: 2 });
      }
      return result(validation.breaker.disabled ? 'disabled' : 'rejected', validation);
    }
    if (validation.application.replacements.length + validation.application.appendRecords.length === 0) {
      return result('unchanged', validation);
    }
    // 7–9. Archive, prepare, apply atomically, append the receipt, then telemetry.
    try {
      return { ...await applyApplication(o, this.telemetry, validation.application), validation };
    } catch (error: unknown) {
      this.faulted = true;
      this.emit({ kind: 'error', eventId: input.eventId, stage: 'ledger',
        message: error instanceof Error ? error.message : 'Ledger preparation failed' });
      return result('recovery-pending', validation);
    }
  }

  private async refetch(input: EngineInput, entries: readonly LedgerEntry[]): Promise<void> {
    if (input.kind !== 'entry' || this.seenRefetches.has(input.eventId)) return;
    this.seenRefetches.add(input.eventId);
    const hash = await sha256(input.result.bytes);
    const applied = new Set(entries.flatMap(({ event }) => event.kind === 'applied'
      ? [event.receipt.intentId] : []));
    const emitted = new Set<string>();
    for (const { event } of entries) {
      const details = metadata(event);
      if (event.kind !== 'prepared' || details === null || !applied.has(event.intentId)) continue;
      for (const item of details.sources) {
        if (item.source.sha256 !== hash
          || item.source.byteLength !== input.result.bytes.length || emitted.has(item.recallId)) continue;
        emitted.add(item.recallId);
        this.emit({ kind: 'refetch', sourceSha256: item.source.sha256,
          recallId: item.recallId, fetchedBytes: input.result.bytes.length });
      }
    }
  }
}
