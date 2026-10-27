import type { UnitId } from "../types/identity.js";
import type {
  PathCoverageFact, SessionSnapshot, ToolResultNode,
} from "../types/transcript.js";
import type { ProcessingUnit } from "./types.js";
import type { PathWrite } from "./writes.js";
import { pathWrites } from "./writes.js";

/**
 * What a write invalidates (PRD §6.7; ISSUE-045 chunk C6).
 *
 * "A write to a path invalidates that path's units and stale maps." Every fact
 * here is in the transcript; nothing is judged (ADR-0006):
 *
 *   - a unit is invalidated when a later write names the same path. Its bytes
 *     are then a copy of a file the write replaced, so they are provably not
 *     current file state. The first later write is the one blamed: it is the
 *     fact that made the copy wrong, and a second write proves nothing more;
 *   - a write at or before the unit's node proves nothing — bytes read after a
 *     write are the written file;
 *   - only a `read` whose path evidence says `hit` holds a copy of the file's
 *     bytes. A write's own bytes say the path changed, a search hit is output, a
 *     miss returned an error, and an `other` kind (a shell `cat`) carries no hit
 *     claim at all; a later write cannot make any of those a stale copy of the
 *     file;
 *   - path identity is spelling intersection, never normalization. A host may
 *     key one path one way and display it another (`src/a.ts`, `a.ts`, an
 *     absolute form), so two results name the same path when any spelling each
 *     recorded is equal. Guessing — prefixes, case folding, separators — would
 *     merge two different files, and a wrong invalidation is a wrong refusal;
 *   - a stale map is the per-path view a write invalidates. Coverage is
 *     cumulative per path, so once a write landed on a path no coverage row for
 *     that path can say whether its bytes predate the write: the row is stale as
 *     a whole, and `withoutStaleCoverage` drops it from the planning snapshot.
 */

/** One unit a write made stale, and the write that did it. */
export interface InvalidatedUnit {
  readonly unit: ProcessingUnit;
  /** The unit's node index in the snapshot. */
  readonly nodeIndex: number;
  /** The spellings the read recorded for the paths it returned (hit paths). */
  readonly readSpellings: readonly string[];
  /** The first later write naming one of those spellings. */
  readonly write: PathWrite;
}

/** One per-path view a write invalidates. */
export interface StaleMap {
  readonly pathKey: string;
  readonly write: PathWrite;
}

export interface Invalidation {
  /** Invalidated units in unit order; one entry per unit, never per spelling. */
  readonly units: readonly InvalidatedUnit[];
  /** The same rows keyed by unit id, for a check that sees unit ids. */
  readonly byUnit: ReadonlyMap<UnitId, InvalidatedUnit>;
  /** Every node holding an invalidated unit, for a caller that holds no units. */
  readonly invalidatedNodeIds: ReadonlySet<string>;
  /** One row per path spelling a write named, in first-seen order. */
  readonly staleMaps: readonly StaleMap[];
  /** The snapshot's coverage rows for a written path: no longer a current measurement. */
  readonly staleCoverage: readonly PathCoverageFact[];
}

export interface InvalidationInput {
  readonly snapshot: SessionSnapshot;
  /** The units to test, in transcript order. Units absent here are not considered. */
  readonly units: readonly ProcessingUnit[];
}

/** True when the two path spelling lists name one path: any recorded spelling is equal. */
export function samePath(left: readonly string[], right: readonly string[]): boolean {
  const names = new Set(left);
  return right.some(value => names.has(value));
}

/** True when this result's evidence claims the call returned the file itself. */
export function holdsFileBytes(node: ToolResultNode): boolean {
  return node.evidence.kind === "read"
    && node.evidence.paths.some(path => path.outcome === "hit");
}

/** Every spelling of the paths this result's evidence says it returned. */
export function hitSpellings(node: ToolResultNode): readonly string[] {
  const seen = new Set<string>();
  const spellings: string[] = [];
  for (const path of node.evidence.paths) {
    if (path.outcome !== "hit") continue;
    for (const value of [path.pathKey, path.displayPath]) {
      if (value.length === 0 || seen.has(value)) continue;
      seen.add(value);
      spellings.push(value);
    }
  }
  return spellings;
}

export function computeInvalidation(input: InvalidationInput): Invalidation {
  const writes = pathWrites(input.snapshot);
  const indexOf = new Map<string, number>();
  input.snapshot.nodes.forEach((node, index) => indexOf.set(node.id, index));
  const units: InvalidatedUnit[] = [];
  const byUnit = new Map<UnitId, InvalidatedUnit>();
  const invalidatedNodeIds = new Set<string>();
  for (const unit of input.units) {
    const nodeIndex = indexOf.get(unit.nodeId);
    const node = nodeIndex === undefined ? undefined : input.snapshot.nodes[nodeIndex];
    if (nodeIndex === undefined || node === undefined || node.kind !== "tool-result") continue;
    if (!holdsFileBytes(node)) continue;
    const readSpellings = hitSpellings(node);
    if (readSpellings.length === 0) continue;
    const write = writes.find(row => row.atIndex > nodeIndex && samePath([row.pathKey], readSpellings));
    if (write === undefined) continue;
    const row: InvalidatedUnit = { unit, nodeIndex, readSpellings, write };
    units.push(row);
    byUnit.set(unit.id, row);
    invalidatedNodeIds.add(unit.nodeId);
  }
  return {
    units, byUnit, invalidatedNodeIds,
    staleMaps: staleMapsOf(writes),
    staleCoverage: staleCoverageOf(input.snapshot, writes),
  };
}

/**
 * The snapshot a pass plans against, with the write-invalidated coverage views
 * removed (PRD §6.7 "and stale maps"; ISSUE-045 chunk C6). The transcript nodes
 * are untouched — they are the host's, and the guard still re-derives
 * invalidation from them. Only the per-path coverage facts leave, because a row
 * keyed by a written path cannot separate its pre-write bytes from its
 * post-write ones. Nothing else changes, so the revision and every plan's base
 * stay valid.
 */
export function withoutStaleCoverage(
  snapshot: SessionSnapshot, invalidation: Invalidation,
): SessionSnapshot {
  const stale = invalidation.staleCoverage;
  const rows = snapshot.pathCoverage;
  if (stale.length === 0 || rows === undefined || rows.length === 0) return snapshot;
  const drop = new Set(stale.map(row => row.pathKey));
  return { ...snapshot, pathCoverage: rows.filter(row => !drop.has(row.pathKey)) };
}

/** One stale map per path spelling a write named; the earliest write is blamed. */
function staleMapsOf(writes: readonly PathWrite[]): readonly StaleMap[] {
  const seen = new Set<string>();
  const maps: StaleMap[] = [];
  for (const write of writes) {
    if (seen.has(write.pathKey)) continue;
    seen.add(write.pathKey);
    maps.push({ pathKey: write.pathKey, write });
  }
  return maps;
}

/**
 * The snapshot's coverage rows for a written path: each mixed pre-write bytes
 * into its totals, so none of them is a measurement of what the transcript
 * holds now.
 */
function staleCoverageOf(
  snapshot: SessionSnapshot, writes: readonly PathWrite[],
): readonly PathCoverageFact[] {
  const rows = snapshot.pathCoverage ?? [];
  if (rows.length === 0 || writes.length === 0) return [];
  const written = new Set<string>();
  for (const write of writes) written.add(write.pathKey);
  return rows.filter(row => written.has(row.pathKey));
}
