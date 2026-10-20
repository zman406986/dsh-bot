import type { RacoonsConfig } from '../config.js';
import type { Guard } from '../guard/guard.js';
import type { ValidationResult, ValidatedApplication } from '../guard/types.js';
import type { ApplyReceipt, Ledger, PreparedIntent } from '../ledger/types.js';
import type { Meter } from '../meter/meter.js';
import type { Rule } from '../rules/types.js';
import type { EventId, IntentId, SessionId } from '../types/identity.js';
import type { CapabilityFlags, Clock, SessionSnapshot, ToolResultNode } from '../types/transcript.js';
import type { TelemetrySink } from '../types/telemetry.js';

export type {
  ForcedLossObservation, HarnessObservation, TelemetryBase, TelemetryEvent, TelemetrySink,
} from '../types/telemetry.js';

export type EngineInput =
  | { readonly kind: 'entry'; readonly eventId: EventId; readonly result: ToolResultNode }
  | {
      readonly kind: 'at-rest';
      readonly eventId: EventId;
      readonly reason: 'step' | 'turn-end' | 'resume' | 'idle-past-ttl' | 'model-switch';
    };

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
  | { readonly status: 'applied'; readonly receipt: ApplyReceipt }
  | { readonly status: 'not-applied' }
  | { readonly status: 'unknown' };

export interface ApplicationPort {
  snapshot(): Promise<SessionSnapshot>;
  apply(request: ApplyRequest): Promise<ApplyResult>;
  lookupReceipt(intentId: IntentId): Promise<ReceiptLookup>;
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
}
