/**
 * The bytes and the slicing of one L2 table ask: its rows, its display table,
 * the unit-sized table builder and its two renderers (ISSUE-022 chunk 1;
 * ADR-0009).
 *
 * One ask addresses every unit still in memory, by an index we assign. Here are
 * the row and table renderers and the builder that hands a pass its next
 * contiguous slice of rows. The ask's own composition lives in the adapter
 * (ISSUE-027): a prune ask is a fork of main's sent wire state, so the contract
 * rides inside an appended user turn and the system slot is never replaced.
 * `PRUNE_ASK_SYSTEM_PROMPT`, `PRUNE_ASK_FINAL_LINE` and `renderPruneAskTable`
 * are the bytes that turn carries. The pass's indexing — assigning those indices
 * and building each row's anchor — is `./ask.ts`, which re-exports every name
 * here, so `prune/ask.js` remains the one import site. Reading the answer is
 * `./ask-answer.ts`.
 *
 * A table is sized in UNITS, never bytes or tokens: at most
 * `PRUNE_ASK_MAX_TABLE_UNITS` (12, owned by the carry scheduler) rows, carried
 * re-asks included. `nextTable` returns one contiguous slice and never cuts or
 * omits a row, so a huge row rides in its slice.
 *
 * Pure and deterministic: same input, same bytes, no I/O, nothing mutated. Only
 * invalid options throw, because those are caller bugs, not transcript data.
 */

import { oneLine } from "../rules/assets.js";
import type { ProcessingUnit } from "../units/types.js";
import { PRUNE_ASK_MAX_TABLE_UNITS } from "./ask-carry.js";
import type { PruneCarryEntry } from "./ask-carry.js";
import { isRefusedPruneAnchor } from "./anchor.js";
import type { PruneAnchorResult } from "./anchor.js";

/** The line that opens the table inside the user message. */
export const PRUNE_ASK_TABLE_HEADING =
  "Units still in memory, by assigned index. Each row begins with the index you answer with and "
  + "quotes two verbatim samples of that unit's content.";

/**
 * The instruction that ends every ask's user message, as one line. It states the
 * exact expected JSON shape verbatim, in the same bytes the system prompt uses,
 * so a test can pin one string for the whole batch contract.
 */
export const PRUNE_ASK_FINAL_LINE =
  "Answer with one JSON object that maps every index above to its verdict, one entry per index: "
  + '{"1":{"keepall":true},"2":{"forgetall":"…"}}';

/** One indexed row of a pass: the address, the unit and its anchor. */
export interface PruneAskRow {
  /** 1-based, assigned over the pass's L1-kept list in transcript order. */
  readonly index: number;
  readonly unit: ProcessingUnit;
  readonly anchor: PruneAnchorResult;
}

/** Options for `nextTable`; production passes none. */
export interface NextTableOptions {
  /** Units this table may address, carried rows included. Default 12. */
  readonly maxUnits?: number;
  /** Rows the carry scheduler settled: they lead the table and take its slots. */
  readonly carried?: readonly PruneCarryEntry[];
}

/** One ask table: the rows it addresses, carried re-asks first. */
export interface PruneAskTable {
  readonly rows: readonly PruneAskRow[];
  /** Leading rows that are carried re-asks; `rows.length - carried` are fresh. */
  readonly carried: number;
}

/**
 * The next table of a pass: carried rows first, then the queue's front, until
 * the unit limit is reached. Carried rows each cost one slot of the limit; a
 * carried set that alone exceeds it is a caller bug and throws. Nothing here
 * measures bytes or tokens — the limit is a unit count, so an oversized row
 * rides in its slice instead of being cut or singled out.
 *
 * The queue is left untouched; the caller drops exactly the fresh rows it took
 * (`rows.length - carried`) and asks again. Same input, same table, always.
 */
export function nextTable(
  queue: readonly PruneAskRow[],
  options: NextTableOptions = {},
): PruneAskTable {
  const maxUnits = options.maxUnits ?? PRUNE_ASK_MAX_TABLE_UNITS;
  if (!Number.isSafeInteger(maxUnits) || maxUnits < 1) {
    throw new RangeError("maxUnits must be a positive safe integer.");
  }
  const carried = options.carried ?? [];
  if (carried.length > maxUnits) {
    throw new RangeError(
      `carried rows alone exceed the table's ${String(maxUnits)}-unit limit.`,
    );
  }
  const rows = [
    ...carried.map(entry => entry.row),
    ...queue.slice(0, maxUnits - carried.length),
  ];
  // One address per row: a carried row still in the queue would give its unit
  // two places in one table, and an answer could then move the wrong bytes.
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.index)) {
      throw new RangeError(`A prune ask table names index ${String(row.index)} twice.`);
    }
    seen.add(row.index);
  }
  return { rows, carried: carried.length };
}

/** The table block as it ships: the heading, a blank line, then one row per unit. */
export function renderPruneAskTable(
  rows: readonly PruneAskRow[],
  heading: string = PRUNE_ASK_TABLE_HEADING,
): string {
  return `${heading}\n\n${rows.map(renderPruneAskRow).join("\n")}`;
}

/**
 * One row: the assigned index, the whole call, the occurrence ordinal and the
 * two quoted samples. A refused anchor names its refusal instead — never an
 * empty quote, which would read as content that exists but is blank.
 *
 * The samples are inserted verbatim, newlines included: they are bytes of the
 * unit, and the anchor rule says verbatim. Only kind and path are collapsed to
 * one line: they are harness metadata, and a break in one would forge a row
 * starting with an index we never wrote.
 */
function renderPruneAskRow(row: PruneAskRow): string {
  const anchor = row.anchor;
  const path = anchor.path === undefined ? "" : ` ${oneLine(anchor.path)}`;
  const head = `${String(row.index)}. [${oneLine(anchor.kind)}]${path} `
    + `(call #${String(anchor.callOrdinal)})`;
  if (isRefusedPruneAnchor(anchor)) return `${head} — anchor unavailable: ${anchor.refusal}`;
  return `${head} — "${anchor.excerptA}" … "${anchor.excerptB}"`;
}
