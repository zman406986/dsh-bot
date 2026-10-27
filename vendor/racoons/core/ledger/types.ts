import type {
  ByteRange, Bytes, EpisodeId, EventId, IntentId, RecallId, RemovalId, Revision,
  RuleId, SessionId, Sha256, SourceRef,
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
  /**
   * `proof` and `forget` are admitted by the type before the storage schema
   * admits them (ISSUE-045 chunks L1/C4/C1); a row the schema refuses surfaces
   * as a `LedgerError`, never as a silently restamped kind (ADR-0018).
   */
  readonly operationKind: "cap" | "seal" | "evict" | "span" | "verdict" | "proof" | "forget";
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
  /**
   * Exact bytes for one recall id. When the row is missing and `options.reader`
   * is supplied, the ledger may answer from the unchanged source file instead
   * (PRD §6.7, the two-device safety rule; ISSUE-045 chunk C7). Either lane
   * returns the same `RecallRecord`, so a caller cannot tell them apart; every
   * error other than `not-found` still throws.
   */
  recall(id: RecallId, options?: RecallOptions): Promise<RecallRecord>;
  close(): Promise<void>;
  /**
   * Export one session as a self-contained archive: rows, blobs and a manifest
   * in deterministic order, with a sha256 over the archive (PRD §6.7; ISSUE-045
   * chunk C9, ADR-0019). Optional because a ledger implementation may not ship
   * it yet; absence is declared, never faked. The durable per-session file stays
   * the record of record (ADR-0015).
   */
  export?(sessionId: SessionId): Promise<LedgerArchive>;
  /**
   * Rebuild a session's ledger from an archive, refusing any archive whose
   * digest, canonical encoding, per-blob hashes or foreign references disagree
   * (chunk C9). Additive: it never deletes the archive's source rows, and it
   * preserves the archived event order. A target that already holds another row
   * at an archived sequence number refuses the archive as a conflict rather than
   * renumbering one copy of the session (ADR-0015, ADR-0019).
   */
  hydrate?(archive: LedgerArchive): Promise<HydratedLedger>;
}

/**
 * One session's exported ledger archive (chunk C9). `bytes` is the archive
 * itself; `archiveSha256` is its digest, recomputed on hydrate.
 */
export interface LedgerArchive {
  readonly sessionId: SessionId;
  readonly archiveSha256: Sha256;
  readonly bytes: Bytes;
}

/** What a hydrate imported, so a caller can tell an empty archive from a no-op. */
export interface HydratedLedger {
  readonly sessionId: SessionId;
  readonly events: number;
  readonly recalls: number;
}

/**
 * The fallback lane a recall takes when its ledger row is missing (PRD §6.7;
 * ISSUE-045 chunk C7, the two-device safety rule). The record names a path, the
 * ranges it archived and the content hash it expects; a re-read returns bytes
 * only when the hash still matches. A changed file is a refusal, never a
 * substitute, and every error other than `not-found` still throws.
 */
export interface SourceFallbackRequest {
  readonly source: SourceRef;
  /** The file path the archived content came from, spelled as stored. */
  readonly path: string;
  readonly ranges: readonly ByteRange[];
}

/** The seam that re-reads an unchanged source; injected, never a global. */
export interface LedgerSourceReader {
  read(request: SourceFallbackRequest): Promise<Bytes>;
}

/**
 * What a recall may consult beyond the ledger. Absent, a miss is
 * `LedgerError('not-found')` exactly as before; present, the miss may fall back
 * to the unchanged source. It is a parameter, not ledger state, so one ledger
 * serves several hosts (ISSUE-045 chunk C7).
 */
export interface RecallOptions {
  readonly reader?: LedgerSourceReader;
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
