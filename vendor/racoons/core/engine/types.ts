import type { RacoonsConfig } from '../config.js';
import type { Guard } from '../guard/guard.js';
import type { ValidationResult, ValidatedApplication } from '../guard/types.js';
import type { ApplyReceipt, Ledger, PreparedIntent } from '../ledger/types.js';
import type { Meter } from '../meter/meter.js';
import type { PrunePassApplication } from '../prune/pass-merge.js';
import type { RevertPlan } from '../revert/types.js';
import type { Rule } from '../rules/types.js';
import type { EventId, IntentId, SessionId, UnitId } from '../types/identity.js';
import type { CapabilityFlags, Clock, SessionSnapshot, ToolResultNode } from '../types/transcript.js';
import type { TelemetrySink } from '../types/telemetry.js';
import type { VerdictBatch } from '../verdicts/types.js';

export type {
  ForcedLossObservation, HarnessObservation, TelemetryBase, TelemetryEvent, TelemetrySink,
} from '../types/telemetry.js';

/**
 * An at-rest decision point. `revisit` is the full pass: all live content goes
 * to the agent in one structured sweep (PRD §6.5), well before pressure.
 */
export type EngineInput =
  | { readonly kind: 'entry'; readonly eventId: EventId; readonly result: ToolResultNode }
  | {
      readonly kind: 'at-rest';
      readonly eventId: EventId;
      readonly reason: 'step' | 'turn-end' | 'resume' | 'idle-past-ttl' | 'model-switch' | 'revisit';
    }
  // Verdicts arrive as their own event, never as a rule: `RuleContext` must not
  // carry protocol state.
  | {
      readonly kind: 'verdict';
      readonly eventId: EventId;
      readonly verdicts: VerdictBatch;
      /**
       * The unit ids the gate actually presented for this batch, in listing
       * order. The guard validates membership against this window, not against
       * every unit the snapshot could prove. Absent only on a hand-built
       * event; the guard then falls back to the widest provable window.
       */
      readonly window?: readonly UnitId[];
    }
  // The big prune's apply leg (ISSUE-022 chunk 4; ADR-0009): the merged pass is
  // one event, planned as one checkpoint-revert, so a pass costs exactly one
  // epoch break whatever its removal count. It arrives as its own event and
  // never as a rule, exactly as a verdict does.
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
    };

/** A registered host listener; the adapter owns what disposal actually does. */
export interface Disposable {
  dispose(): void;
}

/**
 * One additively registered tool. Parameters are a JSON Schema object; no
 * native read is ever replaced (ADR-0007).
 */
export interface ToolSpec {
  readonly name: 'forget' | 'expand' | 'recall';
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

export interface EngineResult {
  readonly status: 'unchanged' | 'applied' | 'rejected' | 'disabled' | 'recovery-pending';
  readonly intentId: IntentId | null;
  readonly receipt: ApplyReceipt | null;
  readonly validation: ValidationResult | null;
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
  /**
   * The host's healthy window size in tokens, the denominator `revisitShare`
   * is measured against. Absent (the default) never marks an automatic revisit
   * due: the number is a measurement-set value (H-011), and a manual
   * `reason: 'revisit'` event still fires without it.
   */
  readonly windowTokens?: number;
}
