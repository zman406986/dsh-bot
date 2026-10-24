import type { UnitId } from "../types/identity.js";
import type { ToolResultNode } from "../types/transcript.js";
import { sliceBytes } from "../util/bytes.js";
import { sha256Sync } from "../util/hash.js";
import type { ProcessingUnit } from "../units/types.js";
import { planClosedEpisodes, planDuplicates, planStaleRereads } from "./level1-families.js";
import type { LocatedUnit } from "./level1-families.js";
import type { Level1PruneInput, Level1PrunePlan, Level1Removal } from "./types.js";

/**
 * The L1 rule names, as data. The list is closed on purpose: a rule that is not
 * here cannot be added to L1 without a ruling, because L1 removes only what
 * bytes prove (ISSUE-022 §What we want, Layer 1). Adding "no observable use"
 * would need a byte-observable signal that does not exist (Ruling 8).
 */
export const LEVEL1_RULES = [
  "stale-exact-reread",
  "closed-episode",
  "byte-identical-duplicates",
] as const;

/**
 * Plans the provable layer of a big-prune pass (ISSUE-022 Layer 1; ADR-0009).
 *
 * Three families, in this order, each running over what the previous left:
 *
 * 1. `closed-episode` — the unit's node is one of a closed episode's miss bodies
 *    and the episode hit nothing. Misses only: an unknown observation proves
 *    nothing, and the guard already refuses removing one (`checkEpisode`).
 * 2. `stale-exact-reread` — a later read of the same target carries exactly the
 *    same bytes, so this copy is superseded by construction. Reads only, and the
 *    target key must be non-empty: two searches that happen to print the same
 *    text are not a changed world.
 * 3. `byte-identical-duplicates` — another unit holds exactly these bytes. The
 *    earliest unit of the class survives, so a unit that arrives later can never
 *    displace one already kept.
 *
 * Every decision is byte evidence and is carried on the removal's proof. The
 * pass never consults references, citations or mentions: absent use is not
 * proof of disuse, so such a unit is kept here and judged at L2 (Ruling 8).
 *
 * Determinism: the same input always yields the same plan, and the plan's lists
 * follow the input's unit order. Neither the input units nor the input nodes are
 * mutated. A unit whose node is absent, whose span falls outside the node, or
 * whose source hash names different bytes is unprovable and is kept.
 */
export function planLevel1Prune(input: Level1PruneInput): Level1PrunePlan {
  const nodes = new Map<string, ToolResultNode>();
  for (const node of input.nodes) {
    if (node.kind === "tool-result" && !nodes.has(node.id)) nodes.set(node.id, node);
  }

  const located: LocatedUnit[] = [];
  const ordered: ProcessingUnit[] = [];
  const seen = new Set<UnitId>();
  for (const unit of input.units) {
    // A repeated id names the same unit; the first occurrence is its position.
    if (seen.has(unit.id)) continue;
    seen.add(unit.id);
    ordered.push(unit);
    const found = locate(unit, nodes.get(unit.nodeId));
    if (found !== null) located.push(found);
  }

  const removed = new Map<UnitId, Level1Removal>();

  planClosedEpisodes(located, input.episodes, removed);
  planStaleRereads(located, removed);
  planDuplicates(located, removed);

  const removals: Level1Removal[] = [];
  const kept: UnitId[] = [];
  for (const unit of ordered) {
    const removal = removed.get(unit.id);
    // A unit whose bytes cannot be located was never provable: it is kept, never
    // dropped from both lists.
    if (removal === undefined) kept.push(unit.id);
    else removals.push(removal);
  }
  return { removals, kept };
}

/** The unit's exact content bytes, or `null` when it cannot be proven they are these. */
function locate(unit: ProcessingUnit, node: ToolResultNode | undefined): LocatedUnit | null {
  if (node === undefined) return null;
  if (unit.source.sha256 !== node.sha256) return null;
  if (unit.source.byteLength !== node.bytes.length) return null;
  const { startByte, endByteExclusive } = unit.span.byteRange;
  if (
    !Number.isSafeInteger(startByte) ||
    !Number.isSafeInteger(endByteExclusive) ||
    startByte < 0 ||
    endByteExclusive <= startByte ||
    endByteExclusive > node.bytes.length
  ) {
    return null;
  }
  const content = sliceBytes(node.bytes, startByte, endByteExclusive);
  return { unit, node, content, contentSha256: sha256Sync(content) };
}
