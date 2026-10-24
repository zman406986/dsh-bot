import type { NodeId, NoteId, Revision } from "../types/identity.js";
import { chooseRevertCut } from "./cost.js";
import type { RevertAppend, RevertChoice, RevertInput, RevertPlan } from "./types.js";

/** A chooser input plus the two plan-level facts the cost model cannot know. */
export interface RevertPlanInput extends RevertInput {
  /** The snapshot revision the plan is built against. */
  readonly baseRevision: Revision;
  /** Receipt identity for one forgotten index; the guard supplies recall-based ids. */
  readonly noteId: (index: number) => NoteId;
}

/**
 * Chooses the one cut a revert applies (design-protocol §1–§2). Thin by design:
 * the arithmetic and the selection rule live in `chooseRevertCut`, and this is
 * the name the rest of the slice imports.
 *
 * Ordering rule, stated once: candidates are the forgotten indices at or after
 * `freshStart`, visited in ascending index order; a candidate replaces the
 * incumbent only on a strictly larger `netFreedBytes`. So a tie keeps the
 * smallest cut index — maximum salvage, and the same answer for the same input
 * on every run. No candidate passing both filters yields `null`.
 */
export function chooseRevert(input: RevertInput): RevertChoice | null {
  return chooseRevertCut(input);
}

/**
 * Builds the plan the host receives from a chosen cut, or `null` when no cut
 * passes (design-protocol §2, §4).
 *
 * Nodes [0, cutIndex) stay verbatim — that prefix is the salvage a checkpoint
 * revert exists to keep. Survivors are nodes [cutIndex, n) minus the forgotten
 * ones, in transcript order. One receipt appends per forgotten index at or
 * after the cut, each anchored to the nearest survivor before it; when no
 * survivor precedes it (the first forgotten index always lacks one, because
 * the cut node itself is forgotten) the anchor is the last prefix node
 * `nodes[cutIndex - 1]`, so no receipt is ever placed before the salvage. A cut
 * at index 0 has no prefix and anchors at the transcript head (`null`).
 *
 * That first-anchor rule is the one place this file reads §2's "anchors to the
 * survivor before it" slightly wider than written: the strict reading has no
 * survivor to name there and would put the receipt at the transcript head,
 * before the prefix §4 promises to leave untouched. Reported, not hidden.
 *
 * This function renders no bytes and touches no ledger: `noteId` names a
 * receipt the guard will create.
 */
export function planRevertApplication(input: RevertPlanInput): RevertPlan | null {
  const choice = chooseRevert(input);
  if (choice === null) return null;
  const cutIndex = choice.cutIndex;
  const survivors: NodeId[] = [];
  const appends: RevertAppend[] = [];
  // The prefix tail is the anchor of the first receipt when no survivor
  // precedes it; `null` only when the cut is the transcript head itself.
  let anchor: NodeId | null = cutIndex > 0 ? (input.nodes[cutIndex - 1]?.nodeId ?? null) : null;
  for (let index = cutIndex; index < input.nodes.length; index++) {
    const item = input.nodes[index];
    if (item === undefined) break; // unreachable: index < nodes.length
    if (!input.forgotten.has(index)) {
      survivors.push(item.nodeId);
      anchor = item.nodeId;
      continue;
    }
    const noteId = input.noteId(index);
    if (typeof noteId !== "string" || noteId.length === 0) {
      throw new Error(`Receipt note id for index ${index} must be a non-empty string`);
    }
    appends.push({ afterNodeId: anchor, noteId });
  }
  return {
    cutIndex,
    survivors,
    appends,
    // The cost is the chooser's own value, not a recomputation: a second
    // computation could drift from the rule the selection was made under.
    cost: choice.cost,
    baseRevision: input.baseRevision,
  };
}
