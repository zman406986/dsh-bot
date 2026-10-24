/**
 * The judge call path (ISSUE-024 chunk 2): the production conversation in, one
 * wire answer out.
 *
 * Two steps, each independently testable. `buildJudgeAsk` maps the mount's
 * production transcript (the items `surfaceTranscript` projects) onto core's
 * `ConversationTurn` list and composes with the shipped contract; the unit is
 * the last turn because the history is truncated at the unit's own node —
 * judging happens right after that result lands (ISSUE-021 point 7).
 * `askJudge` drives the host's `ctx.llm.stream` seam (`./llm-ask.ts`, shared
 * with the prune ask), joins its text deltas, and decodes with
 * `parseWireVerdict`. Neither function appends, plans or reads the engine: a
 * refusal is a typed record the mount journals and skips.
 *
 * The transcript bytes are the host's rendered text blocks (`surfaceTranscript`
 * puts them in `item.bytes`): that is the "production bytes" the v4.1 contract
 * means — no tags, no duplicate unit, no reformatting. The host's `system` and
 * `developer` messages are the harness's own instructions and never enter the
 * history: the judge's system slot carries the shipped contract instead.
 */
import {
  VERDICT_JUDGE_SYSTEM_PROMPT, WireVerdictError, composeJudgeMessages, parseWireVerdict,
} from '@racoons/core';
import type {
  AnchorMode, ConversationRole, ConversationTurn, JudgeMessages, ProcessingUnit, UnitId,
  WireAnswer,
} from '@racoons/core';
import type { DshTranscriptItem } from './envelope.js';
import { askText, refuse } from './llm-ask.js';
import type { AskFailure, StreamAskOptions, StreamFailureReason } from './llm-ask.js';
import type { DshLlmService } from './plugin.js';

/** The judge call is bounded: a stalled stream must never hold the host's step. */
export { DEFAULT_ASK_TIMEOUT_MS as DEFAULT_JUDGE_TIMEOUT_MS } from './llm-ask.js';

const decoder = new TextDecoder('utf-8', { fatal: false });

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The roles a judge history keeps; see the module note on system/developer. */
const TURN_ROLES: Readonly<Record<string, ConversationRole | undefined>> = Object.freeze({
  user: 'user', assistant: 'assistant', tool: 'tool',
});

/** The production history one ask renders, and where each surface item landed. */
export interface RenderedHistory {
  readonly turns: readonly ConversationTurn[];
  /** Surface index → turn index, or -1 for an item that rendered no turn. */
  readonly turnAt: ReadonlyMap<number, number>;
}

/**
 * Render the production turns of a surface run, up to and including `endIndex`.
 *
 * System and developer messages are the harness's own instructions, and an item
 * that renders no text contributes no turn (an assistant message holding only a
 * tool call has no bytes to judge). `turnAt` keeps the mapping from surface
 * position to rendered turn, so a caller that needs "is the unit the last turn"
 * reads it instead of re-deriving the filter. The prune ask renders the same
 * history without a unit bound, which is why this lives here rather than inside
 * `buildJudgeAsk`.
 */
export function renderHistoryItems(items: readonly DshTranscriptItem[],
  endIndex: number = items.length - 1): RenderedHistory {
  const turns: ConversationTurn[] = [];
  const turnAt = new Map<number, number>();
  for (let index = 0; index <= endIndex && index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    const role = TURN_ROLES[item.role];
    if (role === undefined) continue;
    const text = decoder.decode(item.bytes);
    if (text.length === 0) continue;
    turnAt.set(index, turns.length);
    turns.push({ role, text });
  }
  return { turns, turnAt };
}

export type JudgeAskRefusal = 'unit-absent' | 'unit-not-last';

export type JudgeAskResult =
  | {
    readonly status: 'built';
    readonly messages: JudgeMessages;
    readonly turns: readonly ConversationTurn[];
  }
  | { readonly status: 'refused'; readonly reason: JudgeAskRefusal; readonly message: string };

/**
 * Build the two messages of one judge call for one presented unit.
 *
 * Only surface items up to and including the unit's node are rendered, so the
 * unit is the last tool result even when later turns already exist on the
 * surface. Items that render no text contribute no turn (an assistant message
 * holding only a tool call has no bytes to judge), and a unit's own item must
 * stay the last turn after that filtering; anything else is refused rather
 * than composed with a misplaced unit.
 */
export function buildJudgeAsk(input: {
  readonly items: readonly DshTranscriptItem[];
  readonly unit: ProcessingUnit;
  readonly anchors?: AnchorMode;
}): JudgeAskResult {
  const unitIndex = input.items.findIndex(item => item.id === input.unit.nodeId);
  if (unitIndex < 0) {
    return { status: 'refused', reason: 'unit-absent',
      message: `the unit's node ${input.unit.nodeId} is not on the production surface` };
  }
  const rendered = renderHistoryItems(input.items, unitIndex);
  const unitTurn = rendered.turnAt.get(unitIndex) ?? -1;
  const last = rendered.turns[rendered.turns.length - 1];
  if (unitTurn < 0 || unitTurn !== rendered.turns.length - 1 || last?.role !== 'tool') {
    return { status: 'refused', reason: 'unit-not-last',
      message: 'the unit must be the last tool result of the judge history' };
  }
  try {
    const messages = composeJudgeMessages(VERDICT_JUDGE_SYSTEM_PROMPT, rendered.turns,
      input.anchors === undefined ? {} : { anchors: input.anchors });
    return { status: 'built', messages, turns: rendered.turns };
  } catch (error) {
    return { status: 'refused', reason: 'unit-not-last', message: messageOf(error) };
  }
}

/**
 * Why a judge ask produced no answer; every one is journaled by name. The
 * stream's own failures come from `./llm-ask.ts`; the wire's two are added here.
 */
export type JudgeFailureReason = StreamFailureReason | 'malformed-json' | 'wire-refusal';

/** A judge refusal: a stream failure or a refused wire shape. */
export type JudgeRefusal = AskFailure<JudgeFailureReason>;

export interface JudgeAnswer {
  readonly status: 'answered';
  readonly answer: WireAnswer;
  /** The raw answer text, kept for the journal; never fed back as content. */
  readonly text: string;
  /** The host's finish kind, or null when the stream ended without one. */
  readonly finish: string | null;
}

export type JudgeOutcome = JudgeAnswer | JudgeRefusal;

export interface AskJudgeOptions extends StreamAskOptions {
  /** Stamped onto the answer; never read off the wire (ISSUE-021 ruling 6). */
  readonly unitId: UnitId;
  readonly answeredInRound: number;
}

/**
 * Ask the host's model one question and decode its answer.
 *
 * One system slot (the shipped contract) and one user message (the composed
 * history plus the decision line); no tools are offered, so the answer is text
 * or nothing. `askText` joins the deltas and owns the deadline; every outcome
 * that is not a parseable wire answer — a thrown stream, an aborted or errored
 * finish, a truncated reply, empty text, bad JSON, a refused shape — is a typed
 * refusal, never an exception.
 */
export async function askJudge(llm: DshLlmService, messages: JudgeMessages,
  options: AskJudgeOptions): Promise<JudgeOutcome> {
  const streamed = await askText(llm, messages.system, messages.user, options);
  if (streamed.status === 'refused') return streamed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(streamed.text);
  } catch (error) {
    return refuse('malformed-json', messageOf(error));
  }
  try {
    const answer = parseWireVerdict(parsed,
      { unitId: options.unitId, answeredInRound: options.answeredInRound });
    return { status: 'answered', answer, text: streamed.text, finish: streamed.finish };
  } catch (error) {
    return error instanceof WireVerdictError
      ? refuse('wire-refusal', error.message, error.code)
      : refuse('wire-refusal', messageOf(error));
  }
}
