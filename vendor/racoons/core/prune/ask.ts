/**
 * The L2 batch ask of the big prune (ISSUE-022 chunk 3; ADR-0009).
 *
 * One ask addresses every unit still in memory, by an index we assign: the judge
 * never locates bytes, so the index is the address and the anchor only directs
 * attention (ISSUE-022 §Unit addressing).
 *
 * The ask itself is no longer composed here (ISSUE-027): a prune ask is a fork
 * of main's sent wire state (ADR-0010), so the contract (`PRUNE_ASK_SYSTEM_PROMPT`),
 * the index table and the final instruction line ride inside one APPENDED user
 * turn, and the fork's system slot is main's, never replaced. The history is the
 * fork's message prefix: nothing in it is tagged, reordered, re-rendered or
 * repeated. That prefix need not end with a tool result: this ask reviews every
 * unit, not "the last result" (the judge's own per-unit assembly is gone,
 * ADR-0028).
 *
 * Each row comes from `./anchor.ts`, never from here:
 *
 *     2. [Read] config.ts (call #2) — line 60 of 201 ends with "retries: 3" · line 140 of 201 ends with "exit 1"
 *
 * `buildPruneAskRows` numbers rows 1, 2, 3… in transcript order and computes the
 * occurrence ordinal over the whole list with `assignCallOrdinals`, so two
 * display asks of one pass never disagree about which identical call a row is.
 * A row whose anchor was refused is still asked, stating the refusal instead of
 * quoting bytes: its unit is still in memory.
 *
 * The table is handed out one unit-sized slice at a time. `nextTable` returns
 * the next contiguous table of at most `PRUNE_ASK_MAX_TABLE_UNITS` (12) rows,
 * carried re-asks at its front, and never cuts a row: the limit is a unit
 * count, so a huge row rides in its slice. On the live path the tables ARE the
 * send split: the ask's tables are the judge's 12-unit tables (ISSUE-027).
 * Reading the answer is `./ask-answer.ts`.
 *
 * The messages, the rows and the table builder are `./ask-message.ts`; every
 * name there is re-exported here, so `prune/ask.js` stays the one import site.
 *
 * Pure and deterministic: same input, same bytes, no I/O, nothing mutated. Only
 * invalid options throw, because those are caller bugs, not transcript data.
 */

import type { NodeId, UnitId } from "../types/identity.js";
import type { ToolResultNode } from "../types/transcript.js";
import type { ProcessingUnit } from "../units/types.js";
import { assignCallOrdinals, buildPruneAnchor } from "./anchor.js";
import type { PruneAnchorOptions, PruneCallFacts } from "./anchor.js";
import type { PruneAskRow } from "./ask-message.js";

export {
  nextTable,
  PRUNE_ASK_FINAL_LINE, PRUNE_ASK_TABLE_HEADING, renderPruneAskTable,
} from "./ask-message.js";
export type {
  NextTableOptions, PruneAskRow, PruneAskTable,
} from "./ask-message.js";

/** One unit offered to the ask, with the node that holds its bytes. */
export interface PruneAskItem {
  readonly unit: ProcessingUnit;
  /** The node holding the unit's bytes; absent means the anchor refuses. */
  readonly node?: ToolResultNode;
  /** What the mount knows about the whole call; see `./anchor.ts`. */
  readonly callFacts?: PruneCallFacts;
}

/** The swept anchor numbers, passed through to `buildPruneAnchor`. */
export type PruneAskAnchorOptions = Omit<PruneAnchorOptions, "callFacts" | "callOrdinal">;

/**
 * Assigns the pass's indices and builds every row's anchor. Ordinals are
 * computed over the whole list, so a later display split keeps them. A repeated
 * unit id throws: two rows for one unit would give it two addresses, and an
 * answer could then move the wrong bytes.
 */
export function buildPruneAskRows(
  items: readonly PruneAskItem[],
  options: PruneAskAnchorOptions = {},
): readonly PruneAskRow[] {
  const facts = new Map<NodeId, PruneCallFacts>();
  const nodes: ToolResultNode[] = [];
  for (const item of items) {
    if (item.callFacts !== undefined && !facts.has(item.unit.nodeId)) {
      facts.set(item.unit.nodeId, item.callFacts);
    }
    if (item.node !== undefined) nodes.push(item.node);
  }
  const ordinals = assignCallOrdinals(items.map(item => item.unit), nodes, { callFacts: facts });

  const seen = new Set<UnitId>();
  const rows: PruneAskRow[] = [];
  for (const [position, item] of items.entries()) {
    if (seen.has(item.unit.id)) {
      throw new RangeError(`A prune ask names unit ${item.unit.id} twice.`);
    }
    seen.add(item.unit.id);
    const anchor = buildPruneAnchor(item.unit, item.node, {
      ...options,
      callOrdinal: ordinals.get(item.unit.id) ?? 1,
      ...(item.callFacts === undefined ? {} : { callFacts: item.callFacts }),
    });
    rows.push({ index: position + 1, unit: item.unit, anchor });
  }
  return rows;
}
