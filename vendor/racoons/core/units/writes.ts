import type { NodeId } from "../types/identity.js";
import type { SessionSnapshot, ToolResultNode } from "../types/transcript.js";

/**
 * The write facts a snapshot holds (PRD §6.7; ISSUE-045 chunk C6).
 *
 * A write result is a fact about a path, never about bytes: it says "this path
 * changed here". The adapter keeps every spelling the host recorded — the
 * evidence key, the display form, and the call's own declared target (E0) — and
 * this module expands each into one `PathWrite`. Nothing here judges;
 * `units/invalidation.ts` decides which earlier units the fact invalidates.
 *
 * A write's path outcome is always `unknown` (E0: a write proves a path changed,
 * never a hit or a miss), so no path-outcome filter applies to a write's own
 * paths. The one write-side filter is `writeOutcome`: a refusal the producer
 * proved happened before mutation is not a write fact. Only a read's *hit*
 * paths are a copy of the file, and that filter lives in
 * `units/invalidation.ts` where the read side is read.
 *
 * Transcript order is the clock, so a write names its node index as well as the
 * host's step ordinal: a step ordinal repeats across turns (dsh restarts it each
 * turn), an index cannot, and "before the write" must be a total order or the
 * comparison is a guess.
 */
export interface PathWrite {
  /** One spelling of the path the write named, exactly as the host recorded it. */
  readonly pathKey: string;
  /**
   * The write node's index in the snapshot: the ordering clock. Host step
   * ordinals restart per turn, so they order nothing across a transcript.
   */
  readonly atIndex: number;
  /** The step ordinal the host recorded for the write node, for a reader's eye. */
  readonly atStep: number;
  readonly nodeId: NodeId;
}

/** Every non-empty path spelling a write result carries, first-seen order. */
export function writePathSpellings(node: ToolResultNode): readonly string[] {
  if (node.evidence.kind !== "write") return [];
  const seen = new Set<string>();
  const spellings: string[] = [];
  const add = (value: string): void => {
    if (value.length === 0 || seen.has(value)) return;
    seen.add(value);
    spellings.push(value);
  };
  for (const path of node.evidence.paths) {
    add(path.pathKey);
    add(path.displayPath);
  }
  const target = node.evidence.target;
  if (target !== null) add(target.key);
  return spellings;
}

/**
 * The snapshot's writes, one row per path spelling, in transcript order.
 *
 * A write whose producer proved it was refused before any filesystem mutation
 * (`writeOutcome: "no-mutation"`) is not a write fact: the path did not
 * change, so it contributes no row. A `committed` write, an `unknown` failure,
 * and an older snapshot with no outcome all stay conservative.
 */
export function pathWrites(snapshot: SessionSnapshot): readonly PathWrite[] {
  const writes: PathWrite[] = [];
  for (const [atIndex, node] of snapshot.nodes.entries()) {
    if (node.kind !== "tool-result" || node.evidence.kind !== "write") continue;
    if (node.evidence.writeOutcome === "no-mutation") continue;
    for (const pathKey of writePathSpellings(node)) {
      writes.push({ pathKey, atIndex, atStep: node.stepOrdinal, nodeId: node.id });
    }
  }
  return writes;
}
