import type { NodeId } from "../types/identity.js";
import type { PathEvidence, ToolResultNode } from "../types/transcript.js";

/**
 * Per-source-path byte coverage (PRD §6.6, gap G3): "Coverage is metered in
 * bytes per source path across **all** result-producing calls (tool-name
 * agnostic — a shell `cat` counts like a read)."
 *
 * `record` reads one tool-result node and never looks at `evidence.kind`, so a
 * result the adapter classifies as `other` (a shell `cat`, an `ls`) counts
 * exactly like a file read. Only observed bytes are recorded:
 *
 *   - a path's own `byteLength` when the harness reported one;
 *   - otherwise the result's bytes, but only when the result names exactly one
 *     path, because then no share is a guess;
 *   - otherwise nothing: a multi-path result proves no per-path share, so its
 *     bytes are summed as unattributed instead of being smeared across paths or
 *     counted twice.
 *
 * There is no threshold, bar or score here (ADR-0006): these are byte facts,
 * and the caller decides what they mean. Recording the same node id twice is a
 * no-op, so a re-delivered result cannot inflate the meter.
 */

export interface PathCoverage {
  readonly pathKey: string;
  /** Every byte recorded for this path: hit + miss + unknown. */
  readonly bytes: number;
  readonly hitBytes: number;
  readonly missBytes: number;
  /** Bytes whose outcome is unknown: counted, but proof of nothing. */
  readonly unknownBytes: number;
  /** How many result-producing calls reported this path. */
  readonly observations: number;
}

interface Tally {
  bytes: number;
  hitBytes: number;
  missBytes: number;
  unknownBytes: number;
  observations: number;
}

interface Claim {
  readonly outcome: PathEvidence["outcome"];
  readonly reported: number | null;
}

function emptyTally(): Tally {
  return { bytes: 0, hitBytes: 0, missBytes: 0, unknownBytes: 0, observations: 0 };
}

/** `null` unless the harness reported a usable byte count. */
function observedBytes(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class CoverageMeter {
  readonly #recorded = new Set<NodeId>();
  readonly #paths = new Map<string, Tally>();
  #unattributedBytes = 0;

  /**
   * Account one tool-result node of any evidence kind. Returns `false` when
   * this node id was already recorded.
   */
  record(node: ToolResultNode): boolean {
    if (this.#recorded.has(node.id)) return false;
    this.#recorded.add(node.id);

    const resultBytes = node.bytes.length;
    // One claim per path key: a key repeated inside one result is one
    // observation, and the first reported length wins.
    const claims = new Map<string, Claim>();
    for (const path of node.evidence.paths) {
      if (path.pathKey.trim() === "") continue;
      const reported = observedBytes(path.byteLength);
      const previous = claims.get(path.pathKey);
      claims.set(path.pathKey, previous === undefined
        ? { outcome: path.outcome, reported }
        : { outcome: previous.outcome, reported: previous.reported ?? reported });
    }

    const singlePathShare = claims.size === 1 ? resultBytes : 0;
    let attributed = 0;
    for (const [pathKey, claim] of claims) {
      const bytes = claim.reported ?? singlePathShare;
      attributed += bytes;
      const tally = this.#paths.get(pathKey) ?? emptyTally();
      tally.bytes += bytes;
      tally.observations += 1;
      if (claim.outcome === "hit") tally.hitBytes += bytes;
      else if (claim.outcome === "miss") tally.missBytes += bytes;
      else tally.unknownBytes += bytes;
      this.#paths.set(pathKey, tally);
    }
    this.#unattributedBytes += Math.max(0, resultBytes - attributed);
    return true;
  }

  /** One entry per path, ordered by key so two runs agree byte for byte. */
  bytesByPath(): readonly PathCoverage[] {
    return Object.freeze([...this.#paths.entries()]
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([pathKey, tally]) => Object.freeze({
        pathKey, bytes: tally.bytes, hitBytes: tally.hitBytes,
        missBytes: tally.missBytes, unknownBytes: tally.unknownBytes,
        observations: tally.observations,
      })));
  }

  /** Every byte recorded against a path: hit + miss + unknown. */
  total(): number {
    let bytes = 0;
    for (const tally of this.#paths.values()) bytes += tally.bytes;
    return bytes;
  }

  /**
   * Result bytes no path evidence could claim (a multi-path result, or a path
   * key that is blank). Named so the gap stays visible instead of shrinking the
   * per-path numbers silently.
   */
  unattributedBytes(): number {
    return this.#unattributedBytes;
  }
}
