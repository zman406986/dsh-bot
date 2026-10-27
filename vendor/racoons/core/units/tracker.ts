import type { Removal } from "../rules/types.js";
import type { SessionId, UnitId } from "../types/identity.js";
import type { SessionSnapshot, ToolResultNode, TranscriptNode } from "../types/transcript.js";
import { canonicalManifestBytes } from "../util/bytes.js";
import { sha256Sync } from "../util/hash.js";
import { WholeResultSegmenter } from "./segmenter.js";
import type { ProcessingUnit, UnitSegmenter, UnitSpan } from "./types.js";

/**
 * ADR-0020 scope as selection: a candidate is a tool-result node or a
 * processing unit cut from one.
 *
 * A `message` node (system, developer, user or assistant — the human's input and
 * the agent's own output) and a `racoons-record` node are **not candidates**.
 * They are not a protected class; they are simply never units, so no unit id
 * exists for them and no rule, verdict, prune ask, manual forget or entry
 * decision can name one. This predicate is the one selection rule: the tracker
 * below mints from it, and every other lane resolves through the tracker
 * (`engine/protocol.ts`'s askable set, `units/lookup.ts`'s forget resolution,
 * the guard's verdict, proof and invalidation checks).
 *
 * It is a type predicate because a unit addresses bytes through a
 * `ToolResultNode`; the type and the runtime check say the same thing.
 */
export function isCandidateNode(node: TranscriptNode): node is ToolResultNode {
  return node.kind === "tool-result";
}

/**
 * Stable identity for one span of one node in one session. The hash covers the
 * session, the node, the node's exact bytes and the span, so the same content
 * keeps its id across snapshots and any content change yields a new one.
 */
export function unitIdFor(
  sessionId: SessionId,
  node: ToolResultNode,
  span: UnitSpan,
): UnitId {
  const material = canonicalManifestBytes([
    sessionId,
    node.id,
    node.sha256,
    span.byteRange.startByte,
    span.byteRange.endByteExclusive,
  ]);
  return `unit:sha256:${sha256Sync(material)}`;
}

/**
 * Maps a unit to the `Removal` the guard already accepts: same identity, same
 * source, one range. The title is never empty (`guard/checks-shape.ts` requires
 * one); the path is the only descriptive field the unit carries.
 */
export function unitRemoval(unit: ProcessingUnit): Removal {
  return {
    id: unit.id,
    title: unit.path === null ? "not retained" : `not retained ${unit.path}`,
    sources: [{
      source: { ...unit.source },
      ranges: [{ ...unit.span.byteRange }],
    }],
  };
}

export interface UnitTrackerOptions {
  readonly sessionId: SessionId;
  readonly barBytes: number;
  /** Defaults to `WholeResultSegmenter`; the only segmenter this milestone ships. */
  readonly segmenter?: UnitSegmenter;
}

/**
 * Builds processing units. It does not judge, plan, render or persist: those
 * belong to the verdict tracker, the guard and the ledger.
 */
export class UnitTracker {
  readonly #sessionId: SessionId;
  readonly #barBytes: number;
  readonly #segmenter: UnitSegmenter;

  constructor(options: UnitTrackerOptions) {
    this.#sessionId = options.sessionId;
    this.#barBytes = options.barBytes;
    this.#segmenter = options.segmenter ?? new WholeResultSegmenter();
  }

  /**
   * Every unit of one node, in byte order. Below the bar: none.
   *
   * The scope rule lands here, at the one place units are minted (ADR-0020): a
   * node that is not a toolcall result yields no unit whatever its size, so a
   * caller cannot hand a message or a RACOONS record to a rule, a verdict, a
   * prune ask, a manual forget or an entry decision. The check is runtime, not
   * only typographic: the parameter is the whole node union, and a host that
   * mislabels a message as a result still gets nothing.
   */
  unitsFor(node: TranscriptNode): readonly ProcessingUnit[] {
    if (!isCandidateNode(node)) return [];
    return this.#segmenter.split(node, this.#barBytes).map(span => this.#unit(node, span));
  }

  /**
   * Every unit of every tool-result node in transcript order, deduplicated by
   * id. This is the product's one candidate set (ADR-0020 decision 1): a
   * message — system, developer, user or assistant — and a RACOONS record are
   * never units, so nothing downstream can name them. A second snapshot of the
   * same content returns the same ids.
   */
  units(snapshot: SessionSnapshot): readonly ProcessingUnit[] {
    const seen = new Set<UnitId>();
    const result: ProcessingUnit[] = [];
    for (const node of snapshot.nodes) {
      if (!isCandidateNode(node)) continue;
      for (const unit of this.unitsFor(node)) {
        if (seen.has(unit.id)) continue;
        seen.add(unit.id);
        result.push(unit);
      }
    }
    return result;
  }

  #unit(node: ToolResultNode, span: UnitSpan): ProcessingUnit {
    return {
      id: unitIdFor(this.#sessionId, node, span),
      nodeId: node.id,
      source: { nodeId: node.id, sha256: node.sha256, byteLength: node.bytes.length },
      path: firstHitPath(node),
      span,
      byteLength: span.byteRange.endByteExclusive - span.byteRange.startByte,
    };
  }
}

/** First hit path evidence, null when the harness named no path. */
function firstHitPath(node: ToolResultNode): string | null {
  const hit = node.evidence.paths.find(entry => entry.outcome === "hit");
  return hit === undefined ? null : hit.displayPath;
}
