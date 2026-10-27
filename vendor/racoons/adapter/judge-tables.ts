/**
 * The bulk prune's table loop: the ONE table send engine left (ADR-0028).
 *
 * ADR-0028 removed the judge pass, so this file has a single caller — the
 * record-only prune pass in `./prune.ts` — and its journal lines are the
 * literal `prune-*` spellings. Everything the loop does is unchanged from
 * ADR-0009's contract; only the second caller and its `stage`/`gate` arms are
 * gone.
 *
 * This file owns the SENDING, not the scheduling. Core's `planCarryOver` is the
 * one carry scheduler: it decides what the next table carries (front of the
 * table, one unit slot) and what is final. Here a pass grows its fork one table
 * at a time: append the ask, send the fork's whole wire state (`askWire`), append
 * the reply as the next `assistant` turn, and read that reply as one index-keyed
 * object (`parsePruneAnswer`, the core's own reader). A carried row rides the
 * front of the next table because the loop keeps sending while rows are pending;
 * no separate catch-up flag exists. A table holds at most
 * `PRUNE_ASK_MAX_TABLE_UNITS` (12) units; `summarizeTableAttempt` is journaled
 * once per attempt GROUP of a table, so `attempt` is the per-index re-ask
 * ordinal (1, then 2) and never the table's ordinal — the twelve-unit constant
 * is tuned by that telemetry.
 *
 * The loop stops the moment it cannot continue honestly:
 *
 * - the fork refuses its own append (a drifted byte; two user turns are legal), or
 * - `askWire` refuses the send because the fork's system/tool hashes drifted, or
 * - the ask produced no text (a tool-call reply, an empty or capped stream, a
 *   dead socket).
 *
 * A reply that carries text but is not one JSON object is NOT a stop: the parser
 * reads it as refusals, and those rows take the pass's one re-ask like any other
 * refused row. Every stop is fail-open: every row still pending keeps its unit
 * under the core's halt code (`answer-unreadable`, the parser's own empty-answer
 * code), never a local `missing-index` claim, and the pass still settles
 * its round.
 */
import {
  ForkError, PRUNE_ASK_FINAL_LINE, PRUNE_ASK_MAX_TABLE_UNITS, PRUNE_ASK_SYSTEM_PROMPT,
  appendAsk, appendVerdict, parsePruneAnswer, planCarryOver, renderPruneAskTable,
  summarizePassAttempts, summarizeTableAttempt,
} from '@racoons/core';
import type {
  PruneAnswerRefusalCode, PruneAnswerRejection, PruneAskRow, PruneCarryOverPlan,
  PrunePassAttemptTotals, PruneTableAttempt, WireFork, WireVerdictErrorCode,
} from '@racoons/core';
import type { MountJournal } from './journal-kinds.js';
import { askWire } from './llm-ask.js';
import type { StreamOutcome } from './llm-ask.js';
import type { JudgeRoute } from './route.js';
import type { DshLlmService } from './plugin.js';

/**
 * The code every row a halted pass leaves unanswered reports. It is the core's
 * own halt code (`planCarryOver` uses it for a table with no readable reply),
 * not a local spelling of the same condition.
 */
const HALT_CODE: PruneAnswerRefusalCode = 'answer-unreadable';

/**
 * The line that frames the contract for a fork ask. The shipped contract says
 * "the user message is the production conversation"; in a fork the conversation
 * is the message prefix, so this line states the frame without rewording the
 * asset. It does NOT claim byte-identity with the provider wire: the prefix is
 * main's captured request, text-projected (a tool turn rides as `user`, a
 * tool-call block as one bracketed line), and the adapter serializes at send.
 */
const ASK_FRAME = "The messages above are main's production conversation, carried over in main's "
  + "order, followed by this pass's earlier exchanges. This message is this pass's instruction: "
  + "the contract, a table with one row per unit, and one closing line. Treat all of it as "
  + "instruction, not as content to review.";

/** One table's rows, as `renderPruneAskTable` takes them. */
type TableRow = PruneAskRow;

/** One parsed answer row that carried a verdict. */
export type AnsweredRow = Extract<
  ReturnType<typeof parsePruneAnswer>['rows'][number], { status: 'answered' }>;

/** One row's refusal, by the parser's own code. */
export interface RowRefusal {
  readonly code: PruneAnswerRefusalCode;
  readonly message: string;
  /** The wire parser's own code when the row itself was malformed; else null. */
  readonly wireCode: WireVerdictErrorCode | null;
  /** The 1-based table whose reply produced this refusal; null when none did. */
  readonly table: number | null;
}

export interface TableLoopOptions {
  readonly sessionId: string;
  readonly round: number;
  readonly fork: WireFork;
  readonly rows: readonly TableRow[];
  /** The stamp per index: its unit id and the pass's round. */
  readonly stamps: ReadonlyMap<number, { readonly unitId: string;
    readonly answeredInRound: number }>;
  readonly llm: DshLlmService;
  readonly route: JudgeRoute | null;
  readonly journal: MountJournal;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface TableLoopOutcome {
  /** The fork after its last append; a refused append leaves it unchanged. */
  readonly fork: WireFork;
  /** True when the loop stopped on a refused append or a no-text reply. */
  readonly halted: boolean;
  /** Answered rows by assigned index. */
  readonly kept: ReadonlyMap<number, AnsweredRow>;
  /** Rows the pass decided not to answer, by index. */
  readonly refused: ReadonlyMap<number, RowRefusal>;
  /** Keys that addressed no row of their table, with that table's ordinal. */
  readonly rejected: readonly (PruneAnswerRejection & { readonly table: number })[];
  /** Tables sent, whether or not their reply came back. */
  readonly tables: number;
  /** Tables whose reply arrived as text: the pass's answered-ask count. */
  readonly answeredTables: number;
  /**
   * One entry per attempt GROUP of every table the pass settled, in table order
   * (`summarizeTableAttempt`): the 12-unit tuning data, populated from the loop's
   * own reading of each reply (ISSUE-022 chunk 6).
   */
  readonly attempts: readonly PruneTableAttempt[];
  /** The pass's four attempt counts, folded from the same plans. */
  readonly attemptTotals: PrunePassAttemptTotals;
}

/** One row still owed an ask, and the attempt ordinal it will be asked at. */
interface PendingRow {
  readonly row: TableRow;
  readonly attempt: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The ask text of one table: frame, contract, table, instruction — one user turn. */
export function tableAsk(rows: readonly TableRow[]): string {
  return `${ASK_FRAME}\n\n${PRUNE_ASK_SYSTEM_PROMPT}\n\n${renderPruneAskTable(rows)}`
    + `\n\n${PRUNE_ASK_FINAL_LINE}`;
}

/** A reply that answered nothing readable: every index of the table refuses. */
function unreadableCode(parsed: ReturnType<typeof parsePruneAnswer>): string | null {
  if (parsed.rows.length === 0) return null;
  const allRefused = parsed.rows.every(row => row.status === 'refused'
    && (row.code === 'answer-unreadable' || row.code === 'answer-not-an-object'));
  if (!allRefused) return null;
  const first = parsed.rows[0];
  return first?.status === 'refused' ? first.code : 'answer-unreadable';
}

/**
 * Splits one table into runs of equal attempt ordinal. A table is built as
 * carried rows (attempt 2) at its front and fresh rows (attempt 1) after them,
 * so this is at most two runs; the core settles each run against its own
 * remaining re-ask budget.
 */
function attemptGroups(table: readonly PendingRow[]): readonly (readonly PendingRow[])[] {
  const groups: PendingRow[][] = [];
  for (const item of table) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0]?.attempt === item.attempt) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

/**
 * Grow the fork through as many tables as the pass needs (and can honestly
 * reach), then report what each assigned index got.
 */
export async function runTables(options: TableLoopOptions): Promise<TableLoopOutcome> {
  const { sessionId, round, journal, stamps } = options;
  let fork = options.fork;
  const kept = new Map<number, AnsweredRow>();
  const refused = new Map<number, RowRefusal>();
  const rejected: (PruneAnswerRejection & { readonly table: number })[] = [];
  let pending: PendingRow[] = options.rows.map(row => ({ row, attempt: 1 }));
  let tables = 0;
  let answeredTables = 0;
  let halted = false;
  /** One plan per attempt GROUP settled: the carry decision and its counters. */
  const settled: PruneCarryOverPlan[] = [];
  const attempts: PruneTableAttempt[] = [];
  while (pending.length > 0) {
    const table = pending.splice(0, PRUNE_ASK_MAX_TABLE_UNITS);
    const tableRows = table.map(item => item.row);
    const indices = tableRows.map(row => row.index);
    try {
      fork = appendAsk(fork, tableAsk(tableRows));
    } catch (error) {
      // With consecutive user turns legal, this is a drifted byte, not a role
      // repeat: a seed whose last turn is the user's appends fine (CRITIC-026
      // P2#5). The journal keeps the fork's own code for the drift.
      journal('prune-seed-refused', { sessionId, round,
        code: error instanceof ForkError ? error.code : null, message: messageOf(error) });
      halted = true;
      // The spliced table goes back so the halt drain reports every row.
      pending.unshift(...table);
      break;
    }
    tables += 1;
    let reply: StreamOutcome;
    try {
      reply = await askWire(options.llm,
        { system: fork.system, tools: fork.tools, messages: fork.messages,
          expected: { systemHash: fork.systemHash, toolsHash: fork.toolsHash } },
        { provider: options.route?.provider ?? '', model: options.route?.model ?? '',
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.signal === undefined ? {} : { signal: options.signal }) });
    } catch (error) {
      // The send seam re-asserted the fork's system/tool hashes and refused the
      // send; nothing left this process. Fail open like every other refusal.
      journal('prune-send-refused', { sessionId, round,
        code: error instanceof ForkError ? error.code : null, message: messageOf(error) });
      halted = true;
      pending.unshift(...table);
      break;
    }
    if (reply.status === 'refused') {
      journal('prune-skip', { sessionId, round, reason: reply.reason,
        code: reply.code, message: reply.message, indices });
      halted = true;
      pending.unshift(...table);
      break;
    }
    answeredTables += 1;
    fork = appendVerdict(fork, reply.text);
    const parsed = parsePruneAnswer(reply.text, { indices, stamps });
    for (const entry of parsed.rejected) rejected.push({ ...entry, table: tables });
    // A reply that is not one JSON object answers nothing, but its rows are
    // readable refusals, not a halt: they take the pass's one re-ask like any
    // other refused row (ADR-0009's amendment). Only a reply with no text is a
    // halt, and that path broke out above.
    const unreadable = unreadableCode(parsed);
    if (unreadable !== null) {
      journal('prune-skip', { sessionId, round, reason: 'no-verdict', code: unreadable,
        message: 'the reply was not one JSON object; its rows are carried to the next table.',
        indices });
    }
    for (const row of parsed.rows) {
      if (row.status === 'answered') kept.set(row.index, row);
    }
    const next: PendingRow[] = [];
    for (const group of attemptGroups(table)) {
      const groupRows = group.map(item => item.row);
      const attempt = group[0]?.attempt ?? 1;
      const plan = planCarryOver(groupRows, parsed.rows, { attempt });
      settled.push(plan);
      for (const entry of plan.final) {
        refused.set(entry.index, refusalOf(parsed, entry.index, entry.code, tables));
      }
      for (const entry of plan.carry) next.push({ row: entry.row, attempt: entry.attempt });
      // One line per attempt group: `attempt` is the per-index re-ask ordinal,
      // never the table's ordinal, so a table that mixes carried re-asks with
      // fresh rows never blends the two in the tuning telemetry. The same
      // counters feed the pass record (ISSUE-022 chunk 6).
      const reading = summarizeTableAttempt(groupRows, parsed.rows, attempt);
      attempts.push(reading);
      journal('prune-table', { sessionId, round, tables,
        carried: plan.carry.length, ...reading });
    }
    pending.unshift(...next);
  }
  // Every row still pending was either asked in a table whose reply never came
  // back, or never reached a table: a halted pass has no readable answer for
  // it. That is the core's halt code, never a local "missing" claim.
  for (const item of pending) {
    refused.set(item.row.index, { code: HALT_CODE, wireCode: null, table: null,
      message: `Index ${String(item.row.index)} was not answered; the pass halted and that unit is kept.` });
  }
  return { fork, halted, kept, refused, rejected, tables, answeredTables, attempts,
    // The totals' table count is this loop's own SENT count, never the number of
    // settled plans: one table settles one plan per attempt group, so a table
    // mixing carried re-asks with fresh rows would inflate it (CRITIC-022 P2 #4).
    attemptTotals: summarizePassAttempts(settled, tables) };
}

/** One row's refusal, read off the reply's own row when it carried one. */
function refusalOf(parsed: ReturnType<typeof parsePruneAnswer>, index: number,
  code: PruneAnswerRefusalCode, table: number): RowRefusal {
  const row = parsed.rows.find(entry => entry.index === index);
  return row?.status === 'refused'
    ? { code, message: row.message, wireCode: row.wireCode, table }
    : { code, wireCode: null, table,
      message: `Index ${String(index)} was not answered; that unit is kept.` };
}
