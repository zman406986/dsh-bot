import type { RacoonsConfig } from '../config.js';
import type { Guard } from '../guard/guard.js';
import type { ValidationResult, ValidatedApplication } from '../guard/types.js';
import type { ApplyReceipt, Ledger, PreparedIntent } from '../ledger/types.js';
import type { Meter } from '../meter/meter.js';
import type { PrunePassApplication } from '../prune/pass-merge.js';
import type { RevertPlan } from '../revert/types.js';
import type { Rule } from '../rules/types.js';
import type { EventId, IntentId, LineRange, SessionId, UnitId } from '../types/identity.js';
import type { CapabilityFlags, Clock, SessionSnapshot, ToolResultNode } from '../types/transcript.js';
import type { TelemetrySink } from '../types/telemetry.js';
import type { EntryAnswer } from '../verdicts/entry-wire.js';

export type {
  ForcedLossObservation, HarnessObservation, TelemetryBase, TelemetryEvent, TelemetrySink,
} from '../types/telemetry.js';

/**
 * The mount's stamp on an answered entry event (ISSUE-056 design §1 "Stamp
 * (N20)"). `answeredInRound` is literally 0: the entry round is never minted by
 * a gate, so an entry answer cannot collide with a gate round. `unitId` is
 * `unitIdFor` of the incoming whole-result unit, and the guard re-derives it
 * from the snapshot's own bytes — a stamp naming another unit is a refusal, not
 * a hint (C5).
 */
export interface EntryStamp {
  readonly unitId: UnitId;
  readonly answeredInRound: 0;
}

/**
 * An at-rest decision point. `revisit` is the full pass: all live content goes
 * to the agent in one structured sweep (PRD §6.5), well before pressure.
 */
export type EngineInput =
  | {
      readonly kind: 'entry';
      readonly eventId: EventId;
      readonly result: ToolResultNode;
      /**
       * The agent's answer to the entry ask (ISSUE-056; ADR-0022 §3). Absent on
       * a below-bar result and on every refusal, where the result lands whole
       * and nothing is planned: core never invents a decision (ADR-0020/0022).
       * When present, `planApplication` plans through `planEntryShape` and
       * `options.rules` does not see the event.
       */
      readonly answer?: EntryAnswer;
      /**
       * The raw answer text the mount received, carried beside the answer so
       * the journal can record what the agent actually wrote (design §1
       * "Stamp (N20)"; C10 joins on it). Never parsed here: `answer` is the
       * parsed form, and a text with no answer is a refusal that lands whole.
       */
      readonly answerText?: string;
      /** The mount's stamp; required in practice whenever `answer` is present. */
      readonly stamp?: EntryStamp;
    }
  | {
      readonly kind: 'at-rest';
      readonly eventId: EventId;
      readonly reason: 'step' | 'turn-end' | 'resume' | 'idle-past-ttl' | 'model-switch' | 'revisit';
    }
  // The big prune's apply leg (ISSUE-022 chunk 4; ADR-0009): the merged pass is
  // one event, planned as one checkpoint-revert, so a pass costs exactly one
  // epoch break whatever its removal count. It arrives as its own event and
  // never as a rule.
  | {
      readonly kind: 'prune';
      readonly eventId: EventId;
      /** The pass's round ordinal, the one stamped on every assigned index. */
      readonly round: number;
      /**
       * The merged per-unit answers `applyPruneAnswers` produced: what to
       * remove with its judged claim, and what the pass keeps. Typed by
       * `PrunePassApplication`, so the engine reads the decision document the
       * pass already made rather than re-deriving one.
       */
      readonly verdicts: PrunePassApplication;
      /**
       * The context-window bound the pass was planned against, in tokens: the
       * denominator the one-half trigger is measured against (ADR-0009). The
       * removals are already decided, so nothing is re-planned from it; it is
       * carried so the event says what window the pass reviewed.
       */
      readonly window: number;
    }
  // Manual forget (PRD §6.2; ISSUE-045 chunk C1): the human names a path and
  // line ranges, core resolves them to the one unit that holds them. It is its
  // own event, never a rule: a forget request is not a byte proof, and the guard
  // refuses an unresolved request rather than guessing a unit.
  | {
      readonly kind: 'forget';
      readonly eventId: EventId;
      readonly request: ForgetRequest;
    };

/**
 * A manual forget request as it arrives from a tool call: what the human wants
 * gone. `ranges` is empty for "the whole unit at this path". Resolution to a
 * unit is `units/lookup.ts`' work in chunk C1, and an ambiguous or absent unit
 * is a refusal, never a nearest guess.
 */
export interface ForgetRequest {
  /**
   * The source path the request names, spelled as the transcript's path
   * evidence spells it. A path string, never a `SourceRef`: the guard resolves
   * the bytes from the snapshot's own node.
   */
  readonly source: string;
  readonly ranges: readonly LineRange[];
  /** An optional short topic label for the receipt; null ships the floor line. */
  readonly label: string | null;
}

/** A registered host listener; the adapter owns what disposal actually does. */
export interface Disposable {
  dispose(): void;
}

/**
 * One additively registered tool. Parameters are a JSON Schema object; no
 * native read is ever replaced (ADR-0007).
 */
export interface ToolSpec {
  readonly name: 'forget' | 'recall';
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * The adapter contract from PRD §9. Every optional seam is optional exactly
 * where the matching capability flag can be false; `applyRevert` receives the
 * whole plan because ADR-0004 requires the host to apply what the ledger
 * prepared, not a bare cut.
 *
 * Optional members are declared `prop?: T` and are absent, never `undefined`
 * (`exactOptionalPropertyTypes`).
 */
export interface HarnessAdapter {
  readonly capabilities: CapabilityFlags;
  onResult?(cb: (r: ToolResultNode) => Promise<ToolResultNode | void>): Disposable;
  applyRevert?(plan: RevertPlan): Promise<ApplyResult>;
  onAtRest(cb: (s: SessionSnapshot) => Promise<void>): Disposable;
  registerTools?(tools: readonly ToolSpec[]): Disposable;
  estimateTokens(text: string): number;
}

export interface ApplyRequest {
  readonly intent: PreparedIntent;
  readonly application: ValidatedApplication;
}

export type ApplyResult =
  | { readonly status: 'applied'; readonly receipt: ApplyReceipt }
  | {
      readonly status: 'not-applied';
      readonly reason: 'stale-revision' | 'unsupported' | 'host-error';
    }
  // A host may report uncertainty explicitly; thrown apply calls have the same meaning.
  | { readonly status: 'unknown' };

export type ReceiptLookup =
  /** The host holds this intent's receipt. */
  | { readonly status: 'applied'; readonly receipt: ApplyReceipt }
  /** The host holds a positive record that this intent did NOT apply. Absence is never this arm. */
  | { readonly status: 'not-applied' }
  /** Neither confirmed nor denied: absent from an in-process map, or the host cannot say. */
  | { readonly status: 'unknown' };

/**
 * A host answer that contradicts the ledger's `applied` receipt (ADR-0015). The
 * engine journals it and emits one `receipt-conflict` telemetry event; the
 * durable record is never downgraded (ISSUE-030 R4).
 */
export interface ReceiptConflict {
  readonly intentId: IntentId;
  /** The host answer that contradicts the ledger's `applied` receipt (R4). */
  readonly host: 'applied' | 'not-applied';
}

export interface ApplicationPort {
  snapshot(): Promise<SessionSnapshot>;
  apply(request: ApplyRequest): Promise<ApplyResult>;
  lookupReceipt(intentId: IntentId): Promise<ReceiptLookup>;
}

/** The committed seal state rebuilt from the durable ledger (ADR-0015). */
export interface CommittedState {
  readonly sealedEpisodeIds: readonly string[];
  readonly events: Map<string, ApplyReceipt | null>;
  readonly notices: Set<string>;
  readonly blocked: boolean;
  readonly conflicts: readonly ReceiptConflict[]; // R4 journal input
}

/**
 * What one pass found a write had invalidated (PRD §6.7; ISSUE-045 chunk C6).
 * The engine computes it from the snapshot before planning and reports it on
 * the result, so a caller never has to re-derive the same byte facts:
 *
 * - `unitIds` are the units whose bytes a later write replaced, in transcript
 *   order. Their lines are not current file state, so a partial (`keeplines`)
 *   removal anchored on them is refused (`edit-outside-coverage`);
 * - `stalePathKeys` are the path spellings whose per-path view the write
 *   replaced — the stale maps the pass dropped. A coverage row for such a
 *   spelling measured the pre-write file.
 */
export interface PassInvalidation {
  readonly unitIds: readonly UnitId[];
  readonly stalePathKeys: readonly string[];
}

export interface EngineResult {
  readonly status: 'unchanged' | 'applied' | 'rejected' | 'disabled' | 'recovery-pending';
  readonly intentId: IntentId | null;
  readonly receipt: ApplyReceipt | null;
  readonly validation: ValidationResult | null;
  /**
   * The write invalidation the pass planned against; `null` when the pass
   * planned nothing or the snapshot held no write, and absent on a result that
   * a caller built itself (the engine always reports it). Never a judgement: an
   * empty list is "no write invalidated anything", not "nothing is stale".
   */
  readonly invalidation?: PassInvalidation | null;
}

export interface EngineOptions {
  readonly sessionId: SessionId;
  readonly capabilities: CapabilityFlags;
  readonly config: RacoonsConfig;
  readonly clock: Clock;
  readonly meter: Meter;
  readonly ledger: Ledger;
  readonly guard?: Guard;
  readonly rules: readonly Rule[];
  readonly port: ApplicationPort;
  readonly onTelemetry?: TelemetrySink;
}
