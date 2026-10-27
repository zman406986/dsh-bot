import type { Episode, EpisodeCloseReason } from "../episodes/types.js";
import type { EpisodeId, NodeId, Sha256, UnitId } from "../types/identity.js";
import type { ToolResultNode } from "../types/transcript.js";
import type { ProcessingUnit } from "../units/types.js";

/**
 * The three L1 rule families, and only these three (ISSUE-022 §What we want,
 * Layer 1). Each name is a byte-observable fact: a later read that byte-equals
 * an earlier one, an episode that closed with no hit and at least one miss, or
 * two units holding the same bytes.
 *
 * A fourth family is impossible by ruling, not by omission: "unreferenced since
 * N turns" is unobservable, because use happens in the agent's memory and every
 * outside signal is a lower bound on it (Ruling 8,
 * `archive/2026-10-21-protocol/rulings.md`). Such a unit is judged at L2 and
 * is never removed here.
 */
export type Level1Rule =
  | "stale-exact-reread"
  | "closed-episode"
  | "byte-identical-duplicates";

/**
 * Why one earlier read is redundant: a later read of the same target returned
 * the same bytes. `contentSha256` is the digest of the unit's own bytes (the
 * span, not the whole node), so a proof can be checked without the transcript.
 */
export interface StaleExactRereadProof {
  readonly rule: "stale-exact-reread";
  /** The call's target key; equal keys are what makes the two reads comparable. */
  readonly targetKey: string;
  readonly contentSha256: Sha256;
  readonly byteLength: number;
  /** The later copy that survives; this removal is stale by construction. */
  readonly survivorUnitId: UnitId;
  readonly survivorNodeId: NodeId;
}

/**
 * Why a unit is dead on arrival: its node is one of a closed episode's miss
 * bodies, and the episode hit nothing. The episode names every miss node, so
 * the proof carries the episode's own observed outcome rather than a claim.
 */
export interface ClosedEpisodeProof {
  readonly rule: "closed-episode";
  readonly episodeId: EpisodeId;
  readonly targetKey: string;
  readonly closeReason: EpisodeCloseReason;
  readonly closedAtStep: number;
  /** The episode's miss bodies, in detection order; `nodeId` is one of them. */
  readonly missNodeIds: readonly NodeId[];
  readonly nodeId: NodeId;
}

/**
 * Why a unit is a surplus copy: another unit holds exactly the same bytes. The
 * earliest unit of the class survives, so arriving later never displaces a copy
 * already kept — the plan is append-stable.
 */
export interface ByteIdenticalDuplicatesProof {
  readonly rule: "byte-identical-duplicates";
  readonly contentSha256: Sha256;
  readonly byteLength: number;
  /** The earliest unit of the class; the one left in memory. */
  readonly keptUnitId: UnitId;
  /** Every other unit of the class, one entry per removal. */
  readonly removedUnitIds: readonly UnitId[];
}

export type Level1Proof =
  | StaleExactRereadProof
  | ClosedEpisodeProof
  | ByteIdenticalDuplicatesProof;

/**
 * One planned removal. The rule and the proof's own `rule` are the same literal
 * by construction: the union is discriminated, so a proof can never be filed
 * under a different rule than the one it proves.
 */
export type Level1Removal =
  | {
      readonly unitId: UnitId;
      readonly rule: "stale-exact-reread";
      readonly proof: StaleExactRereadProof;
    }
  | {
      readonly unitId: UnitId;
      readonly rule: "closed-episode";
      readonly proof: ClosedEpisodeProof;
    }
  | {
      readonly unitId: UnitId;
      readonly rule: "byte-identical-duplicates";
      readonly proof: ByteIdenticalDuplicatesProof;
    };

/**
 * What one L1 pass decides: the removals it can prove, each with its evidence,
 * and every unit left standing. A unit is in exactly one of the two lists.
 * Nothing is applied here — the caller turns removals into `Removal`s and the
 * pass applies as one checkpoint-revert (ADR-0009).
 */
export interface Level1PrunePlan {
  /** Transcript order, one entry per removed unit, never duplicated. */
  readonly removals: readonly Level1Removal[];
  /** Transcript order, the units L1 could prove nothing about. */
  readonly kept: readonly UnitId[];
}

/**
 * The pass's input. Units come from a `UnitTracker`; nodes are the only source
 * of bytes, because a unit carries identity and location, never content. A
 * unit whose node is absent or whose span is out of bounds is unprovable and is
 * kept.
 */
export interface Level1PruneInput {
  /** Every unit still in memory, in transcript order. Duplicate ids are ignored. */
  readonly units: readonly ProcessingUnit[];
  /** The tool-result nodes those units came from. */
  readonly nodes: readonly ToolResultNode[];
  /** Independently detected episodes (`EpisodeTracker`); never re-derived here. */
  readonly episodes: readonly Episode[];
}
