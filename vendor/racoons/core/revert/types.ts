import type { NodeId, NoteId, Revision } from "../types/identity.js";

/** One transcript entry in order. `id` is the entry key, `nodeId` the node it names. */
export interface RevertItem {
  readonly id: NodeId;
  readonly nodeId: NodeId;
  readonly byteLength: number;
}

/** A receipt anchored to the survivor before it; null means the transcript head. */
export interface RevertAppend {
  readonly afterNodeId: NodeId | null;
  readonly noteId: NoteId;
}

/** Salvage arithmetic for one candidate cut (design-protocol §2). */
export interface RevertCost {
  readonly cutIndex: number;
  readonly freedBytes: number;
  readonly keptBytes: number;
  readonly receiptBytes: number;
  readonly netFreedBytes: number;
}

export interface RevertChoice {
  readonly cutIndex: number;
  readonly cost: RevertCost;
}

/**
 * What the host receives for a checkpoint-revert (ADR-0004, ADR-0007): the
 * prefix before `cutIndex` stays verbatim, survivors follow in order, and each
 * receipt appends at its anchor. Nothing inside the cached prefix is rewritten.
 */
export interface RevertPlan {
  /** Nodes [0, cutIndex) stay verbatim: the salvage. */
  readonly cutIndex: number;
  /** Nodes [cutIndex, n) minus the forgotten ones, in transcript order. */
  readonly survivors: readonly NodeId[];
  readonly appends: readonly RevertAppend[];
  readonly cost: RevertCost;
  readonly baseRevision: Revision;
}

/** Pure inputs to the cut chooser; indices are transcript positions. */
export interface RevertInput {
  readonly nodes: readonly RevertItem[];
  readonly forgotten: ReadonlySet<number>;
  /** `computeFreshZone(...).startNodeIndex`; a cut below it is forbidden. */
  readonly freshStart: number;
  readonly receiptBytes: (index: number) => number;
  readonly minCutFreedBytes: number;
}
