import { Guard } from '../guard/guard.js';
import type { BreakerState, ValidationResult } from '../guard/types.js';
import type { LedgerEntry } from '../ledger/types.js';
import type { EpisodeId, RecallId, UnitId } from '../types/identity.js';
import type { HarnessObservation, TelemetryEvent } from '../types/telemetry.js';
import type { SessionSnapshot } from '../types/transcript.js';
import type { RulePlan } from '../rules/types.js';
import { sha256 } from '../util/hash.js';
import { UnitTracker } from '../units/tracker.js';
import type { ProcessingUnit } from '../units/types.js';
import { descriptorWordCount } from '../verdicts/labels.js';
import type { Verdict } from '../verdicts/types.js';
import { applyApplication } from './application.js';
import { committedState } from './committed.js';
import { breakerState, metadata, readEntries } from './journal.js';
import { announceBreaker, persistBreaker } from './notice.js';
import { detectEpisodes, planApplication } from './planning.js';
import { askableUnits, estimatedContentTokens, mergeUnits, protocolGates } from './protocol.js';
import type { ProtocolGates } from './protocol.js';
import { recoverPending } from './recovery.js';
import { TranscriptTelemetry } from './telemetry.js';
import type { EngineInput, EngineOptions, EngineResult, ReceiptConflict } from './types.js';

type EventPayload<T = TelemetryEvent> = T extends TelemetryEvent
  ? Omit<T, 'sessionId' | 'atMs'> : never;
const result = (status: EngineResult['status'], validation: ValidationResult | null = null): EngineResult =>
  ({ status, validation, intentId: null, receipt: null });

/**
 * The gate window the engine has open: which gate asked, and every unit it has
 * listed since the window opened. The window survives an incomplete settle (the
 * gate re-lists only the unanswered units, and the settled batch still names
 * the earlier answers); it closes on `settled`, on `failed-open`, and when the
 * other gate takes the seam.
 */
interface OpenWindow {
  readonly kind: 'turn' | 'revisit';
  readonly units: readonly ProcessingUnit[];
}

export class RacoonsEngine {
  private readonly telemetry: TranscriptTelemetry;
  private readonly options: EngineOptions;
  private readonly gates: ProtocolGates;
  private queue: Promise<void> = Promise.resolve();
  private readonly unchangedEvents = new Set<string>();
  private readonly seenRefetches = new Set<string>();
  /** One `receipt-conflict` per intent and host; `committedState` runs every pass (R4). */
  private readonly reportedConflicts = new Set<string>();
  private faulted = false;
  /** The ledger's breaker verdict, refreshed each run; gates consult it in `present`. */
  private gateEnabled = true;
  private window: OpenWindow | null = null;
  private outstanding = false;
  /**
   * Units that received a settled verdict in this session, from either gate.
   * The turn gate asks units that reached its seam *unjudged*, so a unit a
   * revisit already judged is not put again. A revisit ignores this set: a full
   * sweep asks all live content by definition.
   */
  private readonly judged = new Set<UnitId>();

  private constructor(options: EngineOptions) {
    this.options = options;
    this.telemetry = new TranscriptTelemetry(options.onTelemetry);
    this.gates = protocolGates({
      sessionId: options.sessionId, config: options.config, clock: options.clock,
      onTelemetry: event => this.telemetry.emit(event),
      enabled: () => this.gateEnabled && !this.faulted,
    });
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
    // The breaker is the live gate switch: a disabled session asks nothing.
    this.gateEnabled = !state.disabled;
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
    const nowMs = o.clock.nowMs();
    // A verdict event settles the open gate window; it never runs the rules.
    if (input.kind === 'verdict') {
      return this.settleVerdicts(input, snapshot, state, committed.sealedEpisodeIds, nowMs);
    }
    // A prune event carries a pass already asked and merged; it never runs the
    // rules and never opens or settles a gate window.
    if (input.kind === 'prune') {
      return this.settlePrune(input, snapshot, state, committed.sealedEpisodeIds, nowMs);
    }
    // 3–4. Fresh zone, protection, and isolated rules share one base revision.
    const plans = planApplication(o, input, snapshot, episodes, committed.sealedEpisodeIds, nowMs);
    if (plans.length === 0) {
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'no-plan' });
      this.unchangedEvents.add(input.eventId);
      this.presentGates(input, snapshot);
      return result('unchanged');
    }
    // 5–9. Guard, apply, then offer the seam's units to the gate.
    const outcome = await this.guardAndApply(input, snapshot, plans, state,
      committed.sealedEpisodeIds, nowMs);
    this.presentGates(input, outcome.status === 'applied' ? await o.port.snapshot() : snapshot);
    return outcome;
  }

  /**
   * Settles the outstanding gate presentation and, unless enforcement is the
   * explicit `record-only`, plans and applies the revert. An absent value is
   * `apply` (ADR-0008; owner ruling 2026-10-23): only the exact opt-out records
   * the answers as telemetry and plans nothing.
   */
  private async settleVerdicts(
    input: Extract<EngineInput, { kind: 'verdict' }>, snapshot: SessionSnapshot,
    state: BreakerState, sealedEpisodeIds: readonly EpisodeId[], nowMs: number,
  ): Promise<EngineResult> {
    const o = this.options;
    const open = this.window;
    // A verdict without a presentation this engine made answers nothing: a
    // fresh gate re-asks live units rather than trusting an unpaired batch.
    if (open === null || !this.outstanding) return this.unpaired(input);
    const gate = open.kind === 'revisit' ? this.gates.revisit : this.gates.turn;
    let settled;
    try {
      settled = gate.settle(input.verdicts);
    } catch {
      return this.unpaired(input);
    }
    this.outstanding = false;
    if (settled.status === 'failed-open') {
      // Bounded enforcement reached its cap: nothing applies, the window is
      // silent for its units, and the session keeps running (PRD §6.2).
      this.window = null;
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    if (settled.status === 'incomplete') {
      // Keep the window: the re-ask lists the unanswered units and the final
      // settle still reports the answers already given in this window.
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    this.window = null;
    this.recordVerdicts(settled.batch, open.units);
    for (const verdict of settled.batch.verdicts) this.judged.add(verdict.unitId);
    if (o.config.protocol.enforcement === 'record-only') {
      // Explicit opt-out: the answers are recorded, no plan, no guard call.
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    if (o.capabilities.revertHistory !== true) {
      // The seam is not declared: record the answers, apply nothing.
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'unsupported-capability' });
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    const event: EngineInput = { kind: 'verdict', eventId: input.eventId,
      verdicts: settled.batch, window: open.units.map(unit => unit.id) };
    const plans = planApplication(o, event, snapshot, [], sealedEpisodeIds, nowMs);
    if (plans.length === 0) {
      // A keep-only window strips the decision tail and reverts nothing (§7 Q2).
      this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'no-plan' });
      this.unchangedEvents.add(input.eventId);
      return result('unchanged');
    }
    return this.guardAndApply(event, snapshot, plans, state, sealedEpisodeIds, nowMs);
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

  /** A batch no presentation asked for: reported, never applied, never replayed. */
  private unpaired(input: EngineInput): EngineResult {
    this.outstanding = false;
    this.window = null;
    this.emit({ kind: 'skip', eventId: input.eventId, ruleId: null, reason: 'no-plan' });
    this.unchangedEvents.add(input.eventId);
    return result('unchanged');
  }

  /** One `verdict-recorded` per answer, in listing order: the protocol's trace. */
  private recordVerdicts(
    batch: { readonly round: number; readonly verdicts: readonly Verdict[] },
    units: readonly ProcessingUnit[],
  ): void {
    const byId = new Map(units.map(unit => [unit.id, unit]));
    for (const verdict of batch.verdicts) {
      const unit = byId.get(verdict.unitId);
      if (unit === undefined) continue;
      this.emit({ kind: 'verdict-recorded', round: batch.round, unitId: verdict.unitId,
        nodeId: unit.nodeId, action: verdict.action,
        descriptorWords: verdict.action === 'forgetall'
          ? (verdict.summary === null ? null : descriptorWordCount(verdict.summary))
          : null,
        keptSpans: verdict.action === 'keeplines' ? verdict.ranges.length : null });
    }
  }

  /**
   * The guard and apply block shared by rule events and verdict events. It
   * persists the validation event before deciding, applies nothing on a
   * rejection, and reports the approved revert when the host accepted it.
   */
  private async guardAndApply(
    input: EngineInput, snapshot: SessionSnapshot, plans: readonly RulePlan[],
    state: BreakerState, sealedEpisodeIds: readonly EpisodeId[], nowMs: number,
  ): Promise<EngineResult> {
    const o = this.options;
    const guard = o.guard ?? new Guard({ ledger: o.ledger, initialState: state });
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
        this.gateEnabled = false;
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

  /**
   * The units the gates judge: every live unit in transcript order, plus the
   * incoming result at an entry seam when the host has not added it yet.
   */
  private presentationUnits(snapshot: SessionSnapshot, input: EngineInput): readonly ProcessingUnit[] {
    const { sessionId } = this.options;
    const barBytes = this.options.config.protocol.barBytes;
    // Protected bytes are never askable: a verdict on them cannot be applied.
    const units = askableUnits(snapshot, sessionId, barBytes);
    if (input.kind !== 'entry') return units;
    // An incoming result is never protected (it is not in the snapshot yet), so
    // its units are askable as they stand; skip it once the host has added it.
    if (snapshot.nodes.some(node => node.id === input.result.id)) return units;
    return mergeUnits(units,
      new UnitTracker({ sessionId, barBytes }).unitsFor(input.result));
  }

  /**
   * Which gate owns this seam. An explicit revisit event is the manual command;
   * a due mark wins next (`revisitShare` against the host's window); the turn
   * gate takes every other seam.
   */
  private gateFor(input: EngineInput, snapshot: SessionSnapshot): 'turn' | 'revisit' {
    if (input.kind !== 'at-rest') return 'turn';
    if (input.reason === 'revisit') return 'revisit';
    // A disabled protocol consumes no due mark: the revisit stays armed for the
    // next seam a live gate reaches.
    if (!this.gateEnabled || this.faulted) return 'turn';
    const windowTokens = this.options.windowTokens;
    if (typeof windowTokens !== 'number') return 'turn';
    // Core holds no wire capture, so the engine's own revisit reading is
    // transcript content only; the mount's half-window trigger adds the
    // captured system+tools prefix (ADR-0009 §Amendment 2026-10-24).
    const estimated = estimatedContentTokens(this.options.meter, snapshot, null, null);
    return this.gates.revisit.due(estimated, windowTokens) ? 'revisit' : 'turn';
  }

  /**
   * Offers the seam's units to its gate. One presentation is outstanding at a
   * time, so a verdict event can always be paired with the gate that asked. A
   * disabled gate presents nothing: the `enabled` probe runs inside `present`.
   */
  private presentGates(input: EngineInput, snapshot: SessionSnapshot): void {
    if (this.outstanding || input.kind === 'verdict') return;
    const all = this.presentationUnits(snapshot, input);
    if (all.length === 0) return;
    const kind = this.gateFor(input, snapshot);
    // A manual revisit opens a new visit cycle, so the one-shot mark re-arms
    // (design: the integration step decides when a cycle begins; `reset` names
    // the manual command). An automatic `due` mark stays latched until then.
    if (input.kind === 'at-rest' && input.reason === 'revisit') this.gates.revisit.reset();
    // The turn gate asks only units that reached this seam unjudged; a revisit
    // asks everything (a full sweep), and `GateCore` re-lists only the units its
    // own open window has not answered.
    const units = kind === 'turn' ? all.filter(unit => !this.judged.has(unit.id)) : all;
    if (units.length === 0) return;
    const presentation = kind === 'revisit'
      ? this.gates.revisit.present(units) : this.gates.turn.present(units);
    if (presentation === null) return;
    // The same gate's open window gains units; the other gate starts a new one.
    const prior = this.window?.kind === kind ? this.window.units : [];
    this.window = { kind, units: mergeUnits(prior, presentation.units) };
    this.outstanding = true;
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
