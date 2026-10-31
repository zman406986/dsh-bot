import { Guard } from '../guard/guard.js';
import type { BreakerState, ValidationResult } from '../guard/types.js';
import type { LedgerEntry, RecallOptions } from '../ledger/types.js';
import type { EpisodeId, RecallId } from '../types/identity.js';
import type { HarnessObservation, TelemetryEvent } from '../types/telemetry.js';
import type { SessionSnapshot } from '../types/transcript.js';
import type { RulePlan } from '../rules/types.js';
import { sha256 } from '../util/hash.js';
import { computeInvalidation, withoutStaleCoverage } from '../units/invalidation.js';
import type { Invalidation } from '../units/invalidation.js';
import { UnitTracker } from '../units/tracker.js';
import { applyApplication } from './application.js';
import { committedState } from './committed.js';
import { breakerState, metadata, readEntries } from './journal.js';
import { announceBreaker, persistBreaker } from './notice.js';
import { detectEpisodes, planApplication } from './planning.js';
import { recoverPending } from './recovery.js';
import { salvageShare, TranscriptTelemetry } from './telemetry.js';
import type {
  EngineInput, EngineOptions, EngineResult, PassInvalidation, ReceiptConflict,
} from './types.js';

type EventPayload<T = TelemetryEvent> = T extends TelemetryEvent
  ? Omit<T, 'sessionId' | 'atMs'> : never;
const result = (status: EngineResult['status'], validation: ValidationResult | null = null,
  invalidation: PassInvalidation | null = null): EngineResult =>
  ({ status, validation, intentId: null, receipt: null, invalidation });

/** The pass-wide invalidation fact a result reports, or `null` when nothing was written. */
const passInvalidation = (invalidation: Invalidation): PassInvalidation | null =>
  invalidation.units.length === 0 && invalidation.staleMaps.length === 0 ? null : {
    unitIds: invalidation.units.map(row => row.unit.id),
    stalePathKeys: invalidation.staleMaps.map(row => row.pathKey),
  };

export class RacoonsEngine {
  private readonly telemetry: TranscriptTelemetry;
  private readonly options: EngineOptions;
  private queue: Promise<void> = Promise.resolve();
  private readonly unchangedEvents = new Set<string>();
  private readonly seenRefetches = new Set<string>();
  /** One `receipt-conflict` per intent and host; `committedState` runs every pass (R4). */
  private readonly reportedConflicts = new Set<string>();
  private faulted = false;
  /** The session's guard, created on first use; see `guardFor`. */
  private guard: Guard | null = null;

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

  /**
   * Exact bytes for one recall id, through the ledger. `options.reader` is the
   * source lane a mount may supply (PRD §6.7; ISSUE-053): absent, a ledger miss
   * stays `not-found` exactly as before. It is a parameter of the call, never
   * engine state, so one engine serves a mount with a reader and one without.
   */
  async recall(id: RecallId, options?: RecallOptions) {
    const record = await this.options.ledger.recall(id, options);
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

  /**
   * Emits one `receipt-conflict` per contradiction (ISSUE-030 R4). State is
   * rebuilt on every pass, so an unreconciled conflict would otherwise repeat;
   * the dedup key is the intent and the host answer (design §7 risk 4).
   */
  private reportConflicts(conflicts: readonly ReceiptConflict[]): void {
    for (const conflict of conflicts) {
      const key = `${conflict.intentId}\u0000${conflict.host}`;
      if (this.reportedConflicts.has(key)) continue;
      this.reportedConflicts.add(key);
      this.emit({ kind: 'receipt-conflict', intentId: conflict.intentId, host: conflict.host });
    }
  }

  private async run(input: EngineInput): Promise<EngineResult> {
    const o = this.options;
    // 1. Copy the live snapshot and reconcile before any new planning.
    let snapshot = structuredClone(await o.port.snapshot());
    if (snapshot.sessionId !== o.sessionId) throw new Error('Snapshot belongs to another session');
    const recovery = await recoverPending(o.ledger, o.port, o.sessionId);
    this.reportConflicts(recovery.conflicts);
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
    this.reportConflicts(committed.conflicts);
    if (committed.blocked) return result('recovery-pending');
    const state = breakerState(entries);
    // A disable read from the ledger is history: it asks for its one notice and
    // never ends the pass, because ending it would leave no validation able to
    // clear it.
    if (state.disabled) {
      await persistBreaker(o, snapshot.currentTurnOrdinal, entries);
      const notice = await announceBreaker(o, this.telemetry, snapshot,
        await readEntries(o.ledger, o.sessionId), committed.notices);
      if (notice === 'blocked') return result('recovery-pending');
      // The notice is a host application: plan against the surface it produced.
      if (notice === 'appended') snapshot = structuredClone(await o.port.snapshot());
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
    const nowMs = o.clock.nowMs();
    // The write invalidation this pass plans against (PRD §6.7; ISSUE-045 chunk
    // C6). It is derived once per pass from the snapshot's own bytes, and the
    // snapshot the planners and the guard see drops the per-path coverage views
    // a write made stale. Transcript nodes are untouched: the invalidation is a
    // fact about them, not a change to them, so revisions and bases still hold.
    const invalidation = this.invalidationFor(snapshot);
    const planning = withoutStaleCoverage(snapshot, invalidation);
    const fact = passInvalidation(invalidation);
    // A prune event carries a pass already asked and merged; it never runs the
    // rules.
    if (input.kind === 'prune') {
      return { ...await this.settlePrune(input, planning, state,
        committed.sealedEpisodeIds, nowMs), invalidation: fact };
    }
    // A forget event is the human's own request; it never runs the rules either
    // (ISSUE-045 chunk C1). A refused request still reaches the guard, so the
    // refusal is recorded and counts on the breaker.
    if (input.kind === 'forget') {
      return { ...await this.settleForget(input, planning, state,
        committed.sealedEpisodeIds, nowMs), invalidation: fact };
    }
    // 3–4. Fresh zone and isolated rules share one base revision.
    //
    // An entry event under the land-first protocol (ISSUE-058 chunk P3a;
    // ADR-0022 §2): the host wrote the result BEFORE RACOONS saw it, so an
    // OBSERVATION plans nothing in place. The result is already a snapshot node,
    // so any unit over it is the tracker's ordinary mint from the snapshot's own
    // bytes, and the result stays landed whole. The rules never see this event,
    // and nothing is asked, marked or rewritten here; the entry checkpoint's ask
    // is the mount's, at its next legal append point. A DECISION exists only
    // when the mount collected an answer and hands it in on the same kind of
    // event; even then it is one shape over the LANDED unit, never an in-place
    // rewrite of a node on its way in (ADR-0022 §11–§12).
    const plans = input.kind === 'entry' && input.answer === undefined ? []
      : planApplication(o, input, planning, episodes, committed.sealedEpisodeIds, nowMs);
    if (plans.length === 0) {
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'no-plan' });
      this.unchangedEvents.add(input.eventId);
      return { ...result('unchanged'), invalidation: fact };
    }
    // 5–9. Guard, apply.
    const outcome = await this.guardAndApply(input, planning, plans, state,
      committed.sealedEpisodeIds, nowMs);
    return { ...outcome, invalidation: fact };
  }

  /**
   * Every unit and per-path view a write invalidated in this snapshot (PRD
   * §6.7; ISSUE-045 chunk C6). The tracker's own bar decides which units exist;
   * a below-bar result has no unit, so nothing about it can be refused.
   */
  private invalidationFor(snapshot: SessionSnapshot): Invalidation {
    const units = new UnitTracker({ sessionId: this.options.sessionId,
      barBytes: this.options.config.protocol.barBytes }).units(snapshot);
    return computeInvalidation({ snapshot, units });
  }

  /**
   * Applies one prune pass (ISSUE-022 chunk 4; ADR-0009). The pass has already
   * asked the model and merged its answers; this branch never asks. The whole
   * document becomes one verdict plan, so `guardAndApply` runs ONCE: one
   * `applyApplication`, one `port.apply`, one checkpoint-revert — exactly one
   * epoch break however many units the pass removes (the single approved revert
   * is the break; ADR-0009 defines it that way, so no second record exists).
   *
   * `input.round` is the pass's own ordinal, carried by the caller. The engine
   * keeps no pass state across events, so nothing here can be resumed from; a
   * host that persists pass rounds must write them to its entry store and
   * replay them. That entry store is where `round` must plug in — this branch
   * only consumes it.
   */
  private async settlePrune(
    input: Extract<EngineInput, { kind: 'prune' }>, snapshot: SessionSnapshot,
    state: BreakerState, sealedEpisodeIds: readonly EpisodeId[], nowMs: number,
  ): Promise<EngineResult> {
    const o = this.options;
    if (o.config.protocol.enforcement === 'record-only') {
      // Explicit opt-out: the pass's record belongs to the pass; nothing applies.
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    if (o.capabilities.revertHistory !== true) {
      // The seam a checkpoint-revert needs is not declared: report, never apply.
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'unsupported-capability' });
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    const plans = planApplication(o, input, snapshot, [], sealedEpisodeIds, nowMs);
    if (plans.length === 0) {
      // Nothing left to remove (a replayed document over changed bytes).
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'no-plan' });
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    return this.guardAndApply(input, snapshot, plans, state, sealedEpisodeIds, nowMs);
  }

  /**
   * Applies one manual forget request (PRD §6.2; ISSUE-045 chunk C1). The
   * human's request is planned by `engine/forget.ts` and applied through the
   * same `guardAndApply` every other removal uses, so a forget is one
   * checkpoint-revert with one receipt — and any refusal removes nothing and
   * counts on the breaker like every validation failure.
   *
   * A request that resolves to no unit still reaches the guard: its
   * `checks-forget` re-derives the resolution independently and records
   * `unresolved-request`, and the breaker sees the refusal. Planning nothing
   * and skipping the guard would let a bad request pass silently.
   *
   * `record-only` is the session's explicit opt-out of enforcement, so it takes
   * a forget exactly as it takes a prune pass: recorded, applied nothing.
   */
  private async settleForget(
    input: Extract<EngineInput, { kind: 'forget' }>, snapshot: SessionSnapshot,
    state: BreakerState, sealedEpisodeIds: readonly EpisodeId[], nowMs: number,
  ): Promise<EngineResult> {
    const o = this.options;
    if (o.config.protocol.enforcement === 'record-only') {
      // The session's explicit opt-out of enforcement takes a forget exactly as
      // it takes a prune pass: nothing applies, and no replay applies it.
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    const plans = planApplication(o, input, snapshot, [], sealedEpisodeIds, nowMs);
    return this.guardAndApply(input, snapshot, plans, state, sealedEpisodeIds, nowMs);
  }

  /**
   * The session's one guard. The breaker is session state, so rebuilding the
   * guard per pass would throw its accounting away; the injected guard wins when
   * a host supplies one. The ledger seeds it once, at the first pass.
   */
  private guardFor(state: BreakerState): Guard {
    const injected = this.options.guard;
    if (injected !== undefined) return injected;
    this.guard ??= new Guard({ ledger: this.options.ledger, initialState: state });
    return this.guard;
  }

  /**
   * The guard and apply block shared by rule events and the prune/forget
   * applications. It persists the validation event before deciding, applies
   * nothing on a rejection, and reports the approved revert when the host
   * accepted it.
   */
  private async guardAndApply(
    input: EngineInput, snapshot: SessionSnapshot, plans: readonly RulePlan[],
    state: BreakerState, sealedEpisodeIds: readonly EpisodeId[], nowMs: number,
  ): Promise<EngineResult> {
    const o = this.options;
    const guard = this.guardFor(state);
    const validation = await guard.validate({ input, snapshot,
      capabilities: o.capabilities, config: o.config, plans,
      sealedEpisodeIds, nowMs });
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
    try {
      const applied = await applyApplication(o, this.telemetry, validation.application);
      const revert = validation.application.revert;
      if (applied.status === 'applied' && revert !== undefined) {
        this.emit({ kind: 'revert-applied', cutIndex: revert.cutIndex,
          freedBytes: revert.cost.freedBytes, keptBytes: revert.cost.keptBytes,
          receiptBytes: revert.cost.receiptBytes, netFreedBytes: revert.cost.netFreedBytes,
          salvageShare: salvageShare(revert.cost.keptBytes, revert.cost.freedBytes),
          survivorCount: revert.survivors.length });
      }
      return { ...applied, validation };
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
