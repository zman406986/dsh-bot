import type { RacoonsConfig } from "../config.js";
import type { EngineInput } from "../engine/types.js";
import type { Episode } from "../episodes/types.js";
import type { MeterReading } from "../meter/token-meter.js";
import type {
  ByteRange,
  EpisodeId,
  LineRange,
  NodeId,
  NoteId,
  RemovalId,
  Revision,
  RuleId,
  SourceRef,
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

export type Note =
  | {
      readonly id: NoteId;
      readonly kind: "cap-marker";
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
    };

export interface CapOp {
  readonly kind: "cap";
  readonly removalId: RemovalId;
  readonly keepHeadEndByte: number;
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

export type Operation = CapOp | SealOp | EvictOp | SpanOp;

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
