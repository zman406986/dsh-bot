import type { NodeId, UnitId } from "../types/identity.js";
import type { ToolResultNode } from "../types/transcript.js";
import type { ProcessingUnit } from "../units/types.js";
import { buildPruneAnchors } from "./anchor-positions.js";
import type { PruneAnchorShareOptions } from "./anchor-positions.js";

/**
 * One row of the big prune's batched ask and its anchors (ISSUE-022 §Unit
 * addressing; ADR-0009, re-based on ADR-0022 §7). The judge never locates
 * bytes: the row's assigned index is the address and the anchor only directs
 * attention, built by us from the unit's own bytes:
 *
 *     kind: "Read", path: "config.ts", callOrdinal: 2,
 *     anchors: [
 *       'line 60 of 201 ends with "retries: 3, timeoutMs: 30000"',
 *       'line 140 of 201 ends with "(/srv/app/test/deploy.test.js:41:9)"',
 *     ]
 *
 * The anchor has three parts, in this order:
 *
 * 1. **The whole call** — `kind` is the host tool name when the mount supplied
 *    it (`callFacts.toolName`), else the node's evidence kind. `path` is the
 *    target the mount supplied, else the node's evidence target key, and is
 *    absent when neither exists — never an empty string, never invented.
 * 2. **The occurrence ordinal** — `callOrdinal` numbers identical calls (same
 *    kind and path) 1, 2, 3… in the order they are asked; `assignCallOrdinals`
 *    computes it over the rows together. This is what tells cross-rule L1
 *    survivors of byte-identical calls apart after stale copies are gone. A
 *    lone anchor is occurrence 1.
 * 3. **The anchors** — `anchorsAt`'s one-anchor-per-line renderings at the
 *    lines holding the unit's 30th and 70th byte shares. The quoting routine,
 *    the format and every fallback are `../rules/anchors.js`'s, shared with the
 *    entry ask; only the placement arithmetic is this seam's
 *    (`./anchor-positions.ts`). The format is
 *    `line L of N ends with "..."`, and a blank band reads
 *    `lines A–B are blank`.
 *
 * Every share is a parameter, defaulted and exported by
 * `./anchor-positions.ts`. A later sweep varies them there, and the anchor
 * carries whatever it is given.
 *
 * Bytes safety: a `ProcessingUnit` carries a span, never content, so the bytes
 * are read from the node only after the same proof `planLevel1Prune` applies —
 * source hash and length must match the node, and the span must sit inside it.
 * A failed proof returns a refused anchor carrying `kind`, `path`,
 * `callOrdinal` and a `refusal` code, with no `anchors` field: wrong bytes are
 * never quoted, and a renderer must show the refusal rather than an empty
 * array that reads as "no anchor needed". Nothing throws on bad transcript
 * data.
 *
 * Pure and deterministic: same unit, node and options yield the same anchor and
 * no input is mutated. An invalid share throws `RangeError`, because that is a
 * caller bug, not transcript data.
 */

/** Every refusal `buildPruneAnchor` can file, as data for tests and callers. */
export const PRUNE_ANCHOR_REFUSALS = [
  "missing-node",
  "source-hash-mismatch",
  "source-length-mismatch",
  "span-out-of-bounds",
  "undecodable-unit",
] as const;

/**
 * The swept shares, re-exported here because the anchor is where callers meet
 * them. Their rule lives in `./anchor-positions.ts`; changing a default is a
 * change to that file, so the two can never disagree.
 */
export {
  PRUNE_ANCHOR_POSITION_A, PRUNE_ANCHOR_POSITION_B,
} from "./anchor-positions.js";

/** Why a row carries no anchors: the unit's bytes were not proven or not readable. */
export type PruneAnchorRefusal = (typeof PRUNE_ANCHOR_REFUSALS)[number];

/** What the mount knows about the whole call and the transcript cannot. */
export interface PruneCallFacts {
  /** The host's tool name, e.g. `Read` or `Grep`. */
  readonly toolName?: string;
  /** The command or path the call named, e.g. `config.ts`. */
  readonly targetPath?: string;
}

/** The swept shares, the caller-known call facts, and this row's ordinal. */
export interface PruneAnchorOptions extends PruneAnchorShareOptions {
  readonly callFacts?: PruneCallFacts;
  /** Which occurrence of this whole call the row is, 1-based (`assignCallOrdinals`). */
  readonly callOrdinal?: number;
}

/** One row's anchor. `path` is absent when no target is known, never empty. */
export interface PruneAnchor {
  readonly kind: string;
  readonly path?: string;
  readonly callOrdinal: number;
  readonly anchors: readonly string[];
}

/** The degenerate anchor: the call facts plus the reason no bytes were read. */
export interface RefusedPruneAnchor {
  readonly kind: string;
  readonly path?: string;
  readonly callOrdinal: number;
  readonly refusal: PruneAnchorRefusal;
}

export type PruneAnchorResult = PruneAnchor | RefusedPruneAnchor;

/** Narrows a result to the refusal shape, which carries no anchors. */
export function isRefusedPruneAnchor(
  anchor: PruneAnchorResult,
): anchor is RefusedPruneAnchor {
  return "refusal" in anchor;
}

/**
 * Builds one row's anchor from the unit and the node holding its bytes. `node`
 * may be `undefined`, so a failed lookup lands in the refusal path.
 */
export function buildPruneAnchor(
  unit: ProcessingUnit,
  node: ToolResultNode | undefined,
  options: PruneAnchorOptions = {},
): PruneAnchorResult {
  const ordinal = options.callOrdinal ?? 1;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new RangeError("callOrdinal must be a positive safe integer.");
  }
  const call = describeCall(node, options.callFacts);
  const head = call.path === null
    ? { kind: call.kind, callOrdinal: ordinal }
    : { kind: call.kind, path: call.path, callOrdinal: ordinal };

  const located = locateContent(unit, node);
  if ("refusal" in located) return { ...head, refusal: located.refusal };
  const built = buildPruneAnchors(located.content, options);
  if ("refusal" in built) return { ...head, refusal: built.refusal };
  return { ...head, anchors: built.anchors };
}

/**
 * Numbers rows by whole call: identical calls (same kind and path) get 1, 2,
 * 3… in the order given; a different call starts again at 1. A repeated unit id
 * keeps its first ordinal, so it never shifts the count.
 */
export function assignCallOrdinals(
  units: readonly ProcessingUnit[],
  nodes: readonly ToolResultNode[],
  options: { readonly callFacts?: ReadonlyMap<NodeId, PruneCallFacts> } = {},
): ReadonlyMap<UnitId, number> {
  const byId = new Map<NodeId, ToolResultNode>();
  for (const node of nodes) {
    if (node.kind === "tool-result" && !byId.has(node.id)) byId.set(node.id, node);
  }
  const counts = new Map<string, number>();
  const ordinals = new Map<UnitId, number>();
  for (const unit of units) {
    if (ordinals.has(unit.id)) continue;
    const call = describeCall(byId.get(unit.nodeId), options.callFacts?.get(unit.nodeId));
    const key = `${call.kind}\u0000${call.path ?? ""}`;
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    ordinals.set(unit.id, ordinal);
  }
  return ordinals;
}

/** The whole call: the mount's facts first, the node's own evidence second. */
function describeCall(
  node: ToolResultNode | undefined,
  facts: PruneCallFacts | undefined,
): { readonly kind: string; readonly path: string | null } {
  return {
    kind: textOrNull(facts?.toolName) ?? node?.evidence.kind ?? "other",
    path: textOrNull(facts?.targetPath) ?? textOrNull(node?.evidence.target?.key),
  };
}

/** A non-blank string keeps its exact value; a blank or absent one is no fact. */
function textOrNull(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value : null;
}

/** The unit's exact bytes, or the refusal saying why they were not read. */
type LocatedContent =
  | { readonly content: Uint8Array }
  | { readonly refusal: PruneAnchorRefusal };

/**
 * The same proof `planLevel1Prune` locates units with: source hash and length
 * must name this node, and the span must sit inside it. An empty span is legal
 * here (nothing to quote); a reversed or out-of-bounds one is not.
 */
function locateContent(
  unit: ProcessingUnit,
  node: ToolResultNode | undefined,
): LocatedContent {
  if (node === undefined) return { refusal: "missing-node" };
  if (unit.source.sha256 !== node.sha256) return { refusal: "source-hash-mismatch" };
  if (unit.source.byteLength !== node.bytes.byteLength) {
    return { refusal: "source-length-mismatch" };
  }
  const { startByte, endByteExclusive } = unit.span.byteRange;
  if (
    !Number.isSafeInteger(startByte) ||
    !Number.isSafeInteger(endByteExclusive) ||
    startByte < 0 ||
    endByteExclusive < startByte ||
    endByteExclusive > node.bytes.byteLength
  ) {
    return { refusal: "span-out-of-bounds" };
  }
  return { content: node.bytes.subarray(startByte, endByteExclusive) };
}
