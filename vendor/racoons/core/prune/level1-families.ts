/**
 * The three provable L1 families (ISSUE-022 Layer 1; ADR-0009).
 *
 * Each family walks the units bound to their bytes and records the removals it
 * proves, in this order over what the previous family left: `closed-episode`,
 * `stale-exact-reread`, `byte-identical-duplicates`. Every decision is byte
 * evidence and is carried on the removal's proof. The pass itself — the locating
 * of bytes and the shape of the plan — is `./level1.ts`; this module holds only
 * the families and the `LocatedUnit` binding they share.
 */

import type { Episode } from "../episodes/types.js";
import type { Sha256, UnitId } from "../types/identity.js";
import type { ToolResultNode } from "../types/transcript.js";
import { equalBytes } from "../util/bytes.js";
import type { ProcessingUnit } from "../units/types.js";
import type {
  ByteIdenticalDuplicatesProof,
  ClosedEpisodeProof,
  Level1Removal,
  StaleExactRereadProof,
} from "./types.js";

/** A unit bound to its bytes, or `null` when the unit and its node disagree. */
export interface LocatedUnit {
  readonly unit: ProcessingUnit;
  readonly node: ToolResultNode;
  readonly content: Uint8Array;
  readonly contentSha256: Sha256;
}

/** An episode whose closure fields are present, so a proof never claims nulls. */
interface ClosedMissEpisode {
  readonly episode: Episode;
  readonly closeReason: NonNullable<Episode["closeReason"]>;
  readonly closedAtStep: number;
}

/** `null` unless this episode proved the target absent: closed, no hit, one miss. */
function closedMissEpisode(episode: Episode): ClosedMissEpisode | null {
  if (
    episode.status !== "closed" ||
    episode.hitNodeIds.length > 0 ||
    episode.paths.some(path => path.outcome === "hit") ||
    episode.missNodeIds.length === 0 ||
    episode.closedAtStep === null ||
    episode.closeReason === null
  ) {
    return null;
  }
  return { episode, closeReason: episode.closeReason, closedAtStep: episode.closedAtStep };
}

/**
 * Family 1. A closed episode that hit nothing proved the target absent, so its
 * miss bodies are dead; unknown bodies stay, because an unknown observation is
 * not evidence either way. Eligibility mirrors `SealRule`: closed, no hit node,
 * no hit path, at least one miss. The first qualifying episode naming a node
 * wins, so episode input order is the tie-break.
 */
export function planClosedEpisodes(
  located: readonly LocatedUnit[],
  episodes: readonly Episode[],
  removed: Map<UnitId, Level1Removal>,
): void {
  const byNode = new Map<string, ClosedMissEpisode>();
  for (const episode of episodes) {
    const closed = closedMissEpisode(episode);
    if (closed === null) continue;
    for (const nodeId of episode.missNodeIds) {
      if (!byNode.has(nodeId)) byNode.set(nodeId, closed);
    }
  }
  if (byNode.size === 0) return;

  for (const entry of located) {
    if (removed.has(entry.unit.id)) continue;
    const closed = byNode.get(entry.node.id);
    if (closed === undefined) continue;
    const { episode } = closed;
    const proof: ClosedEpisodeProof = {
      rule: "closed-episode",
      episodeId: episode.id,
      targetKey: episode.target.key,
      closeReason: closed.closeReason,
      closedAtStep: closed.closedAtStep,
      missNodeIds: [...episode.missNodeIds],
      nodeId: entry.node.id,
    };
    removed.set(entry.unit.id, { unitId: entry.unit.id, rule: "closed-episode", proof });
  }
}

/**
 * Family 2. Inside one non-empty read target, walk the survivors from the newest
 * backwards and keep the newest copy of each distinct content. Every earlier
 * copy of that content is superseded; its proof names the newest one, which is
 * the copy that survives. Comparison is exact bytes, never a hash alone.
 */
export function planStaleRereads(
  located: readonly LocatedUnit[],
  removed: Map<UnitId, Level1Removal>,
): void {
  const groups = new Map<string, LocatedUnit[]>();
  for (const entry of located) {
    if (removed.has(entry.unit.id)) continue;
    const target = entry.node.evidence.target;
    if (entry.node.evidence.kind !== "read") continue;
    if (target === null || target.key.length === 0) continue;
    const group = groups.get(target.key);
    if (group === undefined) groups.set(target.key, [entry]);
    else group.push(entry);
  }

  for (const [targetKey, group] of groups) {
    if (group.length < 2) continue;
    const survivors: LocatedUnit[] = [];
    for (let index = group.length - 1; index >= 0; index -= 1) {
      const candidate = group[index];
      if (candidate === undefined) continue;
      const newest = survivors.find(kept => kept.contentSha256 === candidate.contentSha256
        && equalBytes(kept.content, candidate.content));
      if (newest === undefined) {
        survivors.push(candidate);
        continue;
      }
      const proof: StaleExactRereadProof = {
        rule: "stale-exact-reread",
        targetKey,
        contentSha256: candidate.contentSha256,
        byteLength: candidate.content.length,
        survivorUnitId: newest.unit.id,
        survivorNodeId: newest.node.id,
      };
      removed.set(candidate.unit.id, { unitId: candidate.unit.id, rule: "stale-exact-reread", proof });
    }
  }
}

/**
 * Family 3. Group the survivors by content hash and length, confirm equality by
 * bytes, and keep the earliest member of each class. The earliest is chosen so
 * the kept copy is the one already earliest in the transcript; the rest carry a
 * proof naming it and the whole class.
 */
export function planDuplicates(
  located: readonly LocatedUnit[],
  removed: Map<UnitId, Level1Removal>,
): void {
  const classes: LocatedUnit[][] = [];
  for (const entry of located) {
    if (removed.has(entry.unit.id)) continue;
    const match = classes.find(members => {
      const head = members[0];
      return head !== undefined &&
        head.content.length === entry.content.length &&
        head.contentSha256 === entry.contentSha256 &&
        equalBytes(head.content, entry.content);
    });
    if (match === undefined) classes.push([entry]);
    else match.push(entry);
  }

  for (const members of classes) {
    const head = members[0];
    if (head === undefined || members.length < 2) continue;
    const classProof = {
      contentSha256: head.contentSha256,
      byteLength: head.content.length,
      keptUnitId: head.unit.id,
      removedUnitIds: members.slice(1).map(member => member.unit.id),
    };
    for (const member of members.slice(1)) {
      const proof: ByteIdenticalDuplicatesProof = {
        rule: "byte-identical-duplicates",
        ...classProof,
      };
      removed.set(member.unit.id, { unitId: member.unit.id, rule: "byte-identical-duplicates", proof });
    }
  }
}
