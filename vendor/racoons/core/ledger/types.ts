import type {
  Bytes, EpisodeId, EventId, IntentId, RecallId, RemovalId, Revision,
  RuleId, SessionId, Sha256,
} from "../types/identity.js";
import type { Clock } from "../types/transcript.js";
import type { BreakerState, ValidationIssue } from "../guard/types.js";
import type { RevertCost } from "../revert/types.js";
import type { BlobStore } from "./blob-store.js";
import type { RecallRecord } from "./manifest.js";

export type {
  HashedRange, RecallManifest, RecallManifestPart, RecallPart, RecallRecord,
} from "./manifest.js";

export interface ArchiveRecord {
  readonly ruleId: RuleId;
  readonly removalId: RemovalId;
  readonly operationKind: "cap" | "seal" | "evict" | "span" | "verdict";
  readonly episodeId: EpisodeId | null;
  readonly title: string;
  readonly recall: RecallRecord;
}

/** Structural subset of the guard's ValidatedApplication. */
export interface PreparableApplication {
  readonly sessionId: SessionId;
  readonly eventId: EventId;
  readonly baseRevision: Revision;
  readonly phase: "entry" | "at-rest";
  readonly applicationSha256: Sha256;
  readonly archives: readonly ArchiveRecord[];
  readonly appendRecords: readonly {
    readonly recordId: string;
    readonly bytes: Bytes;
    readonly sha256: Sha256;
  }[];
  readonly sealedEpisodeIds: readonly EpisodeId[];
  // Present together on a full application; absent together on a bare subset.
  // application-integrity.ts hashes these to reproduce the guard's digest.
  readonly mode?: "entry" | "append" | "rewrite" | "rehydrate" | "revert";
  readonly replacements?: readonly {
    readonly bytes: Bytes;
    readonly sha256: Sha256;
  }[];
  // Present exactly on a revert application; hashed with the same envelope.
  readonly revert?: {
    readonly cutIndex: number;
    readonly survivors: readonly string[];
    readonly cost: RevertCost;
  };
  readonly createdAtMs?: number;
}

export type PreparedApplication = PreparableApplication;

export interface PreparedIntent {
  readonly intentId: IntentId;
  readonly sessionId: SessionId;
  readonly eventId: EventId;
  readonly baseRevision: Revision;
  readonly applicationSha256: Sha256;
}

export interface ApplyReceipt {
  readonly intentId: IntentId;
  readonly sessionId: SessionId;
  readonly baseRevision: Revision;
  readonly resultRevision: Revision;
  readonly applicationSha256: Sha256;
  readonly appliedAtMs: number;
}

export interface LedgerEventBase {
  readonly sessionId: SessionId;
  readonly eventKey: string;
  readonly atMs: number;
}

export type LedgerEvent = LedgerEventBase & (
  | { readonly kind: "prepared"; readonly intentId: IntentId;
      readonly applicationSha256: Sha256 }
  | { readonly kind: "applied"; readonly receipt: ApplyReceipt }
  | { readonly kind: "abandoned"; readonly intentId: IntentId;
      readonly reason: string }
  | { readonly kind: "validation"; readonly eventId: EventId;
      readonly ok: boolean; readonly issues: readonly ValidationIssue[];
      readonly breaker: BreakerState }
  | { readonly kind: "breaker-disabled"; readonly turnOrdinal: number;
      readonly reason: "two-validation-failures" }
  | { readonly kind: "breaker-announced"; readonly recordId: string }
);

export interface LedgerEntry {
  readonly sequence: number;
  readonly event: LedgerEvent;
}

export interface Ledger {
  prepare(application: PreparableApplication): Promise<PreparedIntent>;
  append(event: LedgerEvent): Promise<LedgerEntry>;
  events(sessionId: SessionId): AsyncIterable<LedgerEntry>;
  recall(id: RecallId): Promise<RecallRecord>;
  close(): Promise<void>;
}

export interface SqliteLedgerOptions {
  readonly databasePath: string;
  readonly blobStore: BlobStore;
  readonly clock: Clock;
}

export type LedgerErrorCode =
  | "not-found"
  | "hash-mismatch"
  | "idempotency-conflict"
  | "storage"
  | "unsupported-schema";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LedgerError";
    this.code = code;
  }
}
