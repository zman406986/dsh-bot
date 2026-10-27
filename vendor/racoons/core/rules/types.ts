import type { RacoonsConfig } from "../config.js";
import type { EngineInput } from "../engine/types.js";
import type { Episode } from "../episodes/types.js";
import type { MeterReading } from "../meter/token-meter.js";
import type {
  ByteRange,
  Bytes,
  EpisodeId,
  LineRange,
  NodeId,
  NoteId,
  RemovalId,
  Revision,
  RuleId,
  SourceRef,
  UnitId,
} from "../types/identity.js";
import type {
  CapabilityFlags,
  FreshZone,
  SessionSnapshot,
} from "../types/transcript.js";

export interface RemovedSource {
  readonly source: SourceRef;
  readonly ranges: readonly ByteRange[];
}

export interface Removal {
  readonly id: RemovalId;
  readonly title: string;
  readonly sources: readonly RemovedSource[];
}

/**
 * The byte fact a proof removal rests on (PRD §6.6; ISSUE-045 chunk C3):
 * `stale-read` — the file was written after the read, so the read is wrong
 * bytes; `superseded-read` — an exact later re-read makes this copy redundant.
 * A proof is deterministic code's claim about witnessed bytes, never a judgment
 * (ADR-0006, ADR-0018).
 */
export type ProofKind = "stale-read" | "superseded-read";

/**
 * The rule id each proof kind registers under. The id is the proof kind's own
 * name, so a proof plan's rule says which byte fact it claims (chunk C3); the
 * guard's rule vocabulary admits both before C3 registers them.
 */
export const PROOF_RULE_IDS = ["stale-read", "superseded-read"] as const;
export type ProofRuleId = (typeof PROOF_RULE_IDS)[number];

/**
 * The rule id the entry checkpoint's shape plans carry (ISSUE-056 chunk C4;
 * ADR-0022 §Consequences). It is not `cap`: a `cap` operation said "a size rule
 * decided", and this one says "an answer did". The registry entry exists so the
 * guard's rule vocabulary is complete; the plan itself comes from
 * `engine/planning.ts` on an answered entry event, never from the rule pass,
 * because core holds no protocol state.
 */
export const ENTRY_SHAPE_RULE_ID = "entry-shape";

export type Note =
  | {
      readonly id: NoteId;
      readonly kind: "cap-marker";
      readonly removalId: RemovalId;
    }
  /**
   * The one line a shaped entry splices in where the dropped bytes were
   * (ISSUE-056 chunk C4; design §1 "Marker text"). The note declares the marker
   * the plan accounts for; the rendered bytes come from `shapeMarker`, so the
   * receipt a shaped result lands with is the marker itself and no appended
   * record is owed.
   *
   * The answer's own summary is not on this note: it is the appended turn's
   * other part (ADR-0022 §12) and `EntryShapePlan` carries it for the mount,
   * which composes the turn. The plan schema here stays the marker's own claim.
   */
  | {
      readonly id: NoteId;
      readonly kind: "shape-marker";
      readonly removalId: RemovalId;
    }
  | {
      readonly id: NoteId;
      readonly kind: "negative-fact";
      readonly episodeId: EpisodeId;
    }
  | {
      readonly id: NoteId;
      readonly kind: "evict-marker";
      readonly removalId: RemovalId;
      readonly episodeId: EpisodeId;
    }
  | {
      readonly id: NoteId;
      readonly kind: "span-marker";
      readonly removalId: RemovalId;
      readonly path: string;
      readonly keepLines: readonly LineRange[];
    }
  | {
      readonly id: NoteId;
      readonly kind: "receipt";
      readonly removalId: RemovalId;
      readonly unitId: UnitId;
      /** The first hit path the receipt names; never empty. */
      readonly path: string;
      /** Line ranges of the forgotten span; empty when the whole node went. */
      readonly ranges: readonly LineRange[];
      /** Null ships the floor line without a topic label. */
      readonly label: string | null;
    }
  /**
   * The receipt a proof burn leaves in place of the removed unit. It carries
   * `proofKind` — the byte fact that justified the burn — and no descriptor:
   * a proven removal has nothing to describe (ADR-0018; PRD §6.6). The renderer
   * still emits the ordinary receipt line (path, ranges, recall id).
   */
  | {
      readonly id: NoteId;
      readonly kind: "proof-receipt";
      readonly proofKind: ProofKind;
      readonly removalId: RemovalId;
      readonly unitId: UnitId;
      /** The first hit path the receipt names; never empty. */
      readonly path: string;
      /** Line ranges of the burned span; empty when the whole node went. */
      readonly ranges: readonly LineRange[];
    };

export interface CapOp {
  readonly kind: "cap";
  readonly removalId: RemovalId;
  readonly keepHeadEndByte: number;
  readonly noteId: NoteId;
}

/**
 * One shaped entry (ISSUE-056 chunk C4, reworked to the landed-node contract by
 * ISSUE-058 chunk P3b; ADR-0022 §12–§13).
 *
 * Under the corrected protocol the tool result LANDED first, in its own turn,
 * and the answer applied afterwards by rewinding past that turn and appending
 * ONE new turn. So this op is not an in-place rewrite of a node on its way in:
 * it names the LANDED unit the answer judged, and it carries the two byte
 * facts the append needs — the kept byte ranges of the unit's ORIGINAL body and
 * the bytes of the one turn that replaces the result turn (the kept partials
 * with one marker in each dropped gap).
 *
 * - `unitId` comes IN from the caller (the mount's own stamp over the landed
 *   node); it is never re-derived from an un-landed result.
 * - `keptRanges` are whole-line byte ranges of `originalBytes`; the removal it
 *   names is exactly their complement, so the bank holds precisely the bytes
 *   the marker says left.
 * - `replacementBytes` is the shaped turn's whole body. The guard re-derives it
 *   byte for byte from `originalBytes` + `keptRanges` + the archive's recall id
 *   (`renderShaped`), so a builder that miscounts is caught.
 * - `originalBytes` is the port/ledger-held original the archive is banked over
 *   and the render is proved against. It is the only copy the guard trusts:
 *   the landed node in the snapshot already holds the SHAPED bytes.
 */
export interface ShapeOp {
  readonly kind: "shape";
  readonly removalId: RemovalId;
  readonly unitId: UnitId;
  readonly keptRanges: readonly ByteRange[];
  readonly replacementBytes: Bytes;
  readonly originalBytes: Bytes;
  readonly noteId: NoteId;
}

export interface SealOp {
  readonly kind: "seal";
  readonly mode: "append" | "replace";
  readonly episodeId: EpisodeId;
  readonly removalId: RemovalId | null;
  readonly noteId: NoteId;
}

export interface EvictOp {
  readonly kind: "evict";
  readonly episodeId: EpisodeId;
  readonly removalId: RemovalId;
  readonly noteId: NoteId;
}

export interface SpanOp {
  readonly kind: "span";
  readonly removalId: RemovalId;
  readonly keepLines: readonly LineRange[];
  readonly noteId: NoteId;
}

/**
 * One forgotten unit: archive exactly the unit's span and append its receipt.
 * The cut is the unit's own node index ("revert to just before the read"), so
 * the operation names the unit rather than a placement.
 */
export interface VerdictOp {
  readonly kind: "verdict";
  readonly removalId: RemovalId;
  readonly unitId: UnitId;
  readonly noteId: NoteId;
}

/**
 * One proven removal (ADR-0018; PRD §6.6): archive exactly the removed ranges
 * and append one receipt. It applies by the same checkpoint-revert primitive as
 * a verdict removal — the node index *is* the cut — and reads exactly one gate,
 * `capabilities.revertHistory`. Unlike a verdict it answers no batch: the agent
 * never emits one and the guard re-derives it from bytes.
 */
export interface ProofOp {
  readonly kind: "proof";
  readonly proofKind: ProofKind;
  readonly removalId: RemovalId;
  readonly unitId: UnitId;
  readonly noteId: NoteId;
}

export type Operation = CapOp | SealOp | EvictOp | SpanOp | VerdictOp | ProofOp | ShapeOp;

export interface RulePlan {
  readonly ruleId: RuleId;
  readonly baseRevision: Revision;
  readonly removals: readonly Removal[];
  readonly notes: readonly Note[];
  readonly operations: readonly Operation[];
}

export interface RuleContext {
  readonly input: EngineInput;
  readonly snapshot: SessionSnapshot;
  readonly capabilities: CapabilityFlags;
  readonly config: RacoonsConfig;
  readonly freshZone: FreshZone;
  readonly episodes: readonly Episode[];
  readonly sealedEpisodeIds: readonly EpisodeId[];
  readonly reservedNodeIds: readonly NodeId[];
  readonly estimatedContentTokens: number;
  readonly latestUsage: MeterReading | null;
  readonly nowMs: number;
}

export interface Rule {
  readonly id: RuleId;
  plan(context: RuleContext): RulePlan | null;
}
