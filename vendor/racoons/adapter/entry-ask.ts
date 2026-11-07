/**
 * The entry checkpoint's ask on the corrected protocol (ISSUE-058 chunk P3c-1;
 * ADR-0022 §3–§6, §14; anchor design §4 and §7).
 *
 * The result has ALREADY LANDED when this module runs, so the fork it grows is
 * the conversation exactly as it stands after that landing:
 *
 *   seedFork(main's wire after the landing)  system + tools + every turn so far
 *   + one `user` ask turn                    the contract, the line count, anchors
 *
 * The seed is chosen by what the caller can supply (ISSUE-058 chunk P3d). The
 * mount's LIVE-SURFACE projection wins when it is given: it is the only seed
 * that holds the assistant turn which made this result's tool call, because that
 * turn is a provider RESPONSE and no capture of a dispatched request carries it.
 * Without a surface the module uses main's captured request and appends the
 * landed result turn itself; that is correct until the session's second tool
 * call, where the capture already ends with the prior `tool` turn and the missed
 * assistant turn makes a second tool turn illegal. That case is refused as
 * `no-seed` with its own message: a call id and a tool name are not the bytes
 * main sent, and a fabricated turn in the prefix is worse than an ask not made.
 *
 * The ask never carries the body: `entryAskMessage` takes facts only (`N` and
 * the rendered anchors), so there is no parameter through which the body could
 * enter the question (ADR-0022 §3). `N` is byte arithmetic over the landed
 * bytes — `lineCount`, i.e. `splitLineOffsets(...).length` from
 * `util/lines.ts` (the same function `rules/head-cut.ts` re-exports as
 * `lineOffsets`) — so it is correct even when the bytes will not decode; a body
 * that does not decode still ships `N` and ships no anchors (anchor design §1).
 *
 * One correction turn, never a loop (ADR-0022 §6, anchor design §7). An answer
 * that cannot be applied arithmetically — an `invalid-span` parse refusal, a
 * `keeplines` range past `N`, or a `keeplines` that covers every line — earns
 * exactly one retry: the first answer is appended as an assistant turn and a
 * correction turn restates the SAME facts (the range sentence naming `N` and
 * the quotes, rendered from the same `EntryAskFacts` through the core's one
 * `entryAskFactsBlock`, never recomputed). The retry does not reopen
 * keep-or-forget. A second invalid answer lands the result whole. Every parse
 * refusal that is not arithmetic (malformed JSON, unknown action, a long note)
 * fails open at once, with no retry.
 *
 * Pure: no host state, no ledger, no engine, no journal. Every failure — no
 * seed, a refused fork append, a drifted prefix, a dead stream, a timeout,
 * empty text, an unreadable answer — is a typed `refused` value naming its
 * code; nothing here touches the guard or the breaker, and the landed result is
 * never modified (ADR-0022 §14: fail-open is the mount's apply-side duty).
 */
import {
  ENTRY_ASK_CLOSING_LINE, EntryAnswerError, ForkError, appendAsk, appendMessage, anchorsFor,
  entryAskFactsBlock, entryAskMessage, fromBytes, lineCount, parseEntryAnswer, seedFork,
} from '@racoons/core';
import type {
  ApiUsage, Bytes, EntryAnswer, EntryAnswerErrorCode, WireFork, WireRequest,
} from '@racoons/core';
import { askWire } from './llm-ask.js';
import type {
  StreamAnswer, StreamAskOptions, StreamFailureReason, StreamOutcome,
} from './llm-ask.js';
import type { DshLlmService } from './plugin.js';

/**
 * The prompt variants a bench may select (ISSUE-061 T-8; ADR-0027 §4).
 * `default` is the shipped `keeplines` contract; `forgetlines` is lane F's. The
 * list is closed so a typo is a refusal by name, never a silent default.
 */
export const ENTRY_ASK_VARIANTS = ['default', 'forgetlines'] as const;

/** One entry-ask prompt variant; the contract the ask states. */
export type EntryAskVariant = (typeof ENTRY_ASK_VARIANTS)[number];

/**
 * Why an entry ask produced no answer. The parser's own codes come first — an
 * unreadable answer names its defect exactly as the gate lane would — then the
 * ask-level causes, then the two arithmetic refusals under the planner's own
 * names (`spans-outside-result`, `keeps-every-line`), so a journal line and a
 * later `planEntryShape` refusal read the same word:
 *
 * - `no-seed` — main's sent request was never captured, or a fork could not be
 *   seeded or grown from it. No request leaves.
 * - `stream-error` — the stream threw, finished `error`/`aborted`, or was
 *   truncated by the token cap.
 * - `timeout` — the one deadline expired.
 * - `empty-text` — the reply carried no text at all (the parser's own code for
 *   an empty answer, reused rather than restated).
 * - `unknown-variant` — the caller named a prompt variant this seam does not
 *   have; no request leaves and no shipped default is silently assumed.
 */
export type EntryAskRefusalCode =
  | EntryAnswerErrorCode
  | 'no-seed' | 'stream-error' | 'timeout'
  | 'spans-outside-result' | 'keeps-every-line'
  | 'unknown-variant';

/**
 * The refusals the one correction turn answers (anchor design §7): an answer
 * that cannot be applied ARITHMETICALLY. Every other refusal fails open at
 * once, with no retry.
 */
export type EntryAskRetryCode = 'invalid-span' | 'spans-outside-result' | 'keeps-every-line';

/** The facts one ask states: the landed result's line count and its anchors. */
export interface EntryAskFacts {
  /** `N`, from the landed bytes by `lineCount` (byte arithmetic). */
  readonly lineCount: number;
  /** The rendered anchor lines; empty when `N` produced none or the body is not text. */
  readonly anchorLines: readonly string[];
}

/** One turn of the ask exchange, in wire order and never re-rendered downstream. */
export interface EntryAskTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** One answered entry ask: the core's decoded answer, the raw text and the cost. */
export interface EntryAskAnswered {
  readonly status: 'answered';
  readonly answer: EntryAnswer;
  /** The reply text the answer was read from, verbatim — what the journal records. */
  readonly raw: string;
  /**
   * The exchange's observed cost, when the host reported `usage` chunks. With
   * the one correction turn this is BOTH sends summed; absent means the host
   * said nothing on either send, never a zero claim (ISSUE-056 C6a ruling).
   */
  readonly usage?: ApiUsage;
  /** True when the returned answer came from the one correction turn. */
  readonly retried: boolean;
  /**
   * The whole exchange as it stands on the fork, in order: the ask turn, and —
   * when retried — the first answer and the correction ask — last, the reply
   * the answer was read from (`raw`). The mount appends exactly these.
   */
  readonly turns: readonly EntryAskTurn[];
}

/**
 * One refused entry ask: a stable code, the raw text when there was one, data
 * only. `turns` is the exchange as far as the fork accepted it (empty before a
 * fork existed); a fail-open caller appends nothing, because the result is
 * already landed whole (ADR-0022 §14).
 */
export interface EntryAskRefused {
  readonly status: 'refused';
  readonly code: EntryAskRefusalCode;
  /** The last reply text the stream produced; absent when it produced none. */
  readonly raw?: string;
  /** The stream's own reason, when the refusal came from the stream seam. */
  readonly reason?: StreamFailureReason;
  /** A fixed, human-readable statement of the defect; never parsed by a caller. */
  readonly message: string;
  /** The exchange's observed cost, when the host reported one before the refusal. */
  readonly usage?: ApiUsage;
  /** True when the refusal came after the one correction turn was sent. */
  readonly retried: boolean;
  /** The turns the fork accepted before this refusal; empty when it took none. */
  readonly turns: readonly EntryAskTurn[];
}

/** The ask is not armed: no provider/model route, so no request leaves. */
export interface EntryAskOff {
  readonly status: 'off';
}

export type EntryAskOutcome = EntryAskAnswered | EntryAskRefused | EntryAskOff;

/** The route one ask goes to; `null` (or a blank pair) means the seam is off. */
export interface EntryAskRoute {
  readonly provider: string;
  readonly model: string;
}

export interface EntryAskOptions {
  /**
   * The landed result's bytes: the body the host already wrote, exactly as the
   * port holds it. `N` and the anchors are derived from these bytes, and the
   * fork's result turn carries their decoded text.
   */
  readonly resultBytes: Bytes;
  /**
   * Main's last captured request BEFORE the result landed (`mainWire.last(id)`
   * at the pre-step that follows the landing). The fork appends the landed
   * result turn to this capture itself; a capture that already ends with that
   * turn is recognised and not repeated, so either capture order is safe.
   *
   * This is a capture of a REQUEST, never of the host's surface. After a step
   * that carried tool calls, the next request's own last turn is the prior
   * `tool` result, so this capture is one assistant turn short of the state
   * main will actually send next: the assistant turn that made THIS result's
   * tool call is a response, and a request capture never holds it. Appending a
   * second `tool` turn to such a capture is the fork's `role-conflict`, which
   * this module reports as `no-seed` rather than inventing a turn.
   */
  readonly seed: WireRequest | null;
  /**
   * The mount's own view of main's wire as it stands AFTER this result landed —
   * the surface projection, not a request capture (ISSUE-058 chunk P3d; the
   * live blocker P3c-2 recorded). When supplied it IS the seed: every turn of
   * the conversation is already in it, including the assistant tool-call turn a
   * request capture cannot hold, so the fork appends the ask and nothing else.
   *
   * Absent (`null` or omitted) keeps the capture-only behaviour above. A mount
   * that can project its live surface should always pass one: it is the only
   * seed that stays correct past the first tool call of a session.
   */
  readonly surface?: WireRequest | null;
  /**
   * Which contract the ask states (ISSUE-061 T-8; ADR-0027 §4). Absent is the
   * shipped `keeplines` contract, byte for byte — the default path is unchanged,
   * so every mount that says nothing sends what it sent before. `'forgetlines'`
   * is lane F's one-partial-class variant, selected by a bench; a value outside
   * `ENTRY_ASK_VARIANTS` is refused as `unknown-variant` and nothing is sent.
   */
  readonly variant?: EntryAskVariant;
  readonly llm: DshLlmService;
  readonly route: EntryAskRoute | null;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

function refused(code: EntryAskRefusalCode, message: string,
  extra: Omit<EntryAskRefused, 'status' | 'code' | 'message'>): EntryAskRefused {
  return { status: 'refused', code, message, ...extra };
}

/**
 * The variant the caller asked for, or a refusal naming the value. `undefined`
 * is the shipped contract; anything else must be in the closed list, so a
 * typo'd bench knob fails loud instead of quietly running lane K.
 */
function variantOf(raw: string | undefined): EntryAskVariant | EntryAskRefused {
  if (raw === undefined) return 'default';
  if ((ENTRY_ASK_VARIANTS as readonly string[]).includes(raw)) return raw as EntryAskVariant;
  return refused('unknown-variant',
    `the entry ask has no prompt variant "${raw}"; use one of ${ENTRY_ASK_VARIANTS.join(', ')}`,
    { retried: false, turns: [] });
}

/**
 * The stream refusal's entry-lane code. The mapping is total and stated here so
 * a journal reader never sees a prune-lane reason in an entry line:
 *
 * - `no-text` becomes `empty-text`, the parser's own code for the same defect;
 * - `stream-truncated`, `aborted` and `not-configured` become `stream-error`
 *   (a configuration with no route is `off`, decided before sending);
 * - `tool-call` becomes `stream-error` too: a tool-bearing reply is not an
 *   entry answer, and the journal keeps the helper's own reason;
 * - `stream-error` and `timeout` keep their names.
 */
const STREAM_CODE: Readonly<Record<StreamFailureReason, EntryAskRefusalCode>> = Object.freeze({
  'not-configured': 'stream-error',
  'stream-error': 'stream-error',
  'stream-truncated': 'stream-error',
  timeout: 'timeout',
  aborted: 'stream-error',
  'tool-call': 'stream-error',
  'no-text': 'empty-text',
});

/** True when the route names a provider and a model; a blank pair is not armed. */
function armed(route: EntryAskRoute | null): route is EntryAskRoute {
  return route !== null && route.provider.trim() !== '' && route.model.trim() !== '';
}

/**
 * The landed body as one message's text. The host's item bytes are the UTF-8 of
 * the text it landed, so this round-trips exactly. A body that is not UTF-8 (a
 * rig can build one; a host cannot, because it encodes a string) is decoded
 * lossily for the PREFIX only — `N` and the anchors still come from the bytes.
 */
function landedTextOf(bytes: Bytes): string {
  try {
    return fromBytes(bytes);
  } catch {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  }
}

/** The decoded body split on LF, with the terminator's empty slot dropped. */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * Main's wire state AFTER the result landed, from the capture alone.
 *
 * In the host's normal order the capture's last turn is the assistant turn that
 * made the tool call, so appending the result is exactly the turn the host then
 * wrote — the prefix is main's own bytes with the result in its real place. A
 * capture that already ends with this result's `tool` turn (a request dispatched
 * after the landing) is recognised and reused rather than doubled.
 *
 * Three limits, stated rather than papered over:
 *
 * - the fork's prefix is main's captured request, which `main-wire.ts` renders
 *   from text and tool-call blocks; it is not the provider's HTTP bytes and no
 *   code in this package sees those. "Byte-exact" in the tests means against the
 *   captured request — the whole wire state this seam is given.
 * - parallel tool calls land several results from ONE assistant turn, so the
 *   second ask's capture still ends at that assistant turn and cannot carry the
 *   first result. That ask's prefix is legal and its question is about the turn
 *   above it, but it is shorter than the host surface: a cache hit is lost for
 *   it, never correctness. A mount that can hand a fuller seed avoids that.
 * - a capture whose last turn is a PRIOR result (the request that followed an
 *   earlier tool call in the same session) ends one assistant turn short of the
 *   state main will send next, and appending this result makes two `tool` turns
 *   in a row. The fork refuses that by name, and `askEntry` reports `no-seed`:
 *   the missing assistant turn is a provider RESPONSE that no request capture
 *   holds, and inventing its tool-call bytes would put a fabricated turn in the
 *   prefix. The mount's `surface` seed is what closes this case.
 */
function landedWire(seed: WireRequest, bodyText: string): WireFork {
  const fork = seedFork(seed);
  const last = fork.messages[fork.messages.length - 1];
  if (last !== undefined && last.role === 'tool' && last.text === bodyText) return fork;
  return appendMessage(fork, { role: 'tool', text: bodyText });
}

/**
 * The ask's one variable part: `N` by byte arithmetic over the landed bytes and
 * the anchors off the decoded lines. An undecodable body states `N` and no
 * anchors (anchor design §1); that is not an ask failure, so the ask still goes
 * out. Pure: the same bytes give the same facts.
 */
export function entryAskFacts(resultBytes: Bytes): EntryAskFacts {
  const total = lineCount(resultBytes);
  let text: string;
  try {
    text = fromBytes(resultBytes);
  } catch {
    return { lineCount: total, anchorLines: [] };
  }
  const lines = linesOf(text);
  return { lineCount: total, anchorLines: lines.length === total ? anchorsFor(lines) : [] };
}

/**
 * The facts block the first ask carried, rebuilt through the core's own
 * renderer so the two cannot drift: the range sentence naming `N`, then the
 * shortened quotes.
 */
function factsText(facts: EntryAskFacts): string {
  return entryAskFactsBlock(facts);
}

/**
 * The ONE bounded correction turn (ADR-0022 §6; anchor design §7).
 *
 * It states the refusal code, says plainly that it does not put the keep-or-
 * forget question again, and restates the same facts block the first ask
 * carried (`factsText` over the caller's own `EntryAskFacts`, rendered by the
 * core, so the two cannot drift). It ends with the shipped closing line, so the
 * rig's end-anchor matcher still names this as an entry ask and serves it from
 * the entry lane. It never carries the body and never changes the grammar, the
 * option count or the floor.
 */
export function entryRetryAskMessage(facts: EntryAskFacts, code: EntryAskRetryCode): string {
  const correction = `Your previous answer could not be applied: ${code}. This turn corrects `
    + 'an answer that could not be applied; it does not put the keep-or-forget question again.';
  const answer = 'Answer again, once, with exactly one JSON object: {"keepall":true}, '
    + '{"forgetall":"one-line summary of the whole result"}, or '
    + '{"keeplines":[[X,Y],[A,B],"<summary of what you dropped>"]}. '
    + 'A keeplines answer always carries its summary: last in the array, or as a sibling '
    + '"summary" key. '
    + `Ranges are 1-based and inclusive, inside [1,${String(facts.lineCount)}].`;
  return `${correction}\n${factsText(facts)}\n${answer}\n${ENTRY_ASK_CLOSING_LINE}`;
}

/** Why a `keeplines` answer cannot be applied to the landed body, or null. */
function arithmeticRefusal(answer: EntryAnswer, total: number): EntryAskRetryCode | null {
  if (answer.action !== 'keeplines') return null;
  for (const range of answer.ranges) {
    if (range.to > total) return 'spans-outside-result';
  }
  const only = answer.ranges[0];
  if (answer.ranges.length === 1 && only !== undefined && only.from === 1 && only.to === total) {
    return 'keeps-every-line';
  }
  return null;
}

/** A fixed statement per arithmetic refusal, for the journal on a failed retry. */
function arithmeticMessage(code: EntryAskRetryCode, total: number): string {
  if (code === 'keeps-every-line') return 'the answer keeps every line, so it gives up nothing';
  if (code === 'spans-outside-result') {
    return `the answer names a line the landed result does not hold (${String(total)} lines)`;
  }
  return 'the answer names a span that is not an ascending integer range';
}

/**
 * Two sends' costs as one reading, when both exist. A field either the host did
 * not report stays unknown (`cachedInputTokens: null`), because a partial sum
 * would read as a cache share the provider never claimed.
 */
function sumUsage(first: ApiUsage | undefined, second: ApiUsage | undefined): ApiUsage | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cachedInputTokens: first.cachedInputTokens === null || second.cachedInputTokens === null
      ? null : first.cachedInputTokens + second.cachedInputTokens,
  };
}

/** The parser's reading of one reply text: an answer, or its own refusal. */
type EntryAckRead =
  | { readonly kind: 'answer'; readonly answer: EntryAnswer }
  | { readonly kind: 'refused'; readonly code: EntryAnswerErrorCode; readonly message: string };

function readAnswer(text: string): EntryAckRead {
  try {
    return { kind: 'answer', answer: parseEntryAnswer(text) };
  } catch (error) {
    if (error instanceof EntryAnswerError) {
      return { kind: 'refused', code: error.code, message: error.message };
    }
    // `parseEntryAnswer` refuses every readable input with its own error class,
    // so this arm covers a defect in the parser itself: it still fails open as
    // data, and the code says the answer could not be read.
    return { kind: 'refused', code: 'malformed-json', message: messageOf(error) };
  }
}

/**
 * One send over a fork, already marked as racoons' by the stream loop. The
 * fork's recorded hashes are re-asserted by `askWire`, so a drifted prefix
 * throws the fork's typed error instead of sending; that throw is `no-seed`
 * (a fork that cannot be used), never a stream claim.
 */
async function sendOnce(fork: WireFork, llm: DshLlmService, stream: StreamAskOptions,
  turns: readonly EntryAskTurn[], retried: boolean): Promise<StreamAnswer | EntryAskRefused> {
  let streamed: StreamOutcome;
  try {
    streamed = await askWire(llm, {
      system: fork.system,
      tools: fork.tools,
      messages: fork.messages,
      expected: { systemHash: fork.systemHash, toolsHash: fork.toolsHash },
    }, stream);
  } catch (error) {
    return refused('no-seed', messageOf(error), { retried, turns });
  }
  if (streamed.status === 'refused') {
    return refused(STREAM_CODE[streamed.reason], streamed.message,
      { retried, turns, reason: streamed.reason });
  }
  return streamed;
}

/**
 * The wire the fork is seeded from, chosen by which seed the caller could supply
 * (ISSUE-058 chunk P3d).
 *
 * The mount's live-surface projection wins whenever it is supplied: it already
 * holds every turn of the conversation as it stands after the landing, so the
 * fork appends the ask and nothing else. It is trusted only after one check —
 * its last turn must be THIS result's own `tool` turn, byte for byte — because a
 * surface that ends anywhere else would put the ask above the wrong content, and
 * the whole point of the ask is that it is about the turn immediately above it
 * (ADR-0022 §4).
 *
 * With no surface the capture is used as before, and the honest refusal is made
 * explicit: a capture whose last turn is a `tool` turn is the request that
 * followed an earlier result in the same turn, so the assistant turn that made
 * THIS result's tool call is a response no request capture holds. Reconstructing
 * it from a call id and a tool name would be a guess at bytes main will send, so
 * this module refuses instead — the result stays landed and whole, one journal
 * line names `no-seed`, and no fabricated turn ever reaches a prefix.
 */
function seedWire(options: EntryAskOptions, bodyText: string): WireFork {
  const surface = options.surface ?? null;
  if (surface !== null) {
    const last = surface.messages[surface.messages.length - 1];
    if (last === undefined || last.role !== 'tool' || last.text !== bodyText) {
      throw new ForkError('invalid-message',
        'the mount surface does not end with this result\'s own landed turn; the ask would sit above the wrong content');
    }
    return seedFork(surface);
  }
  const seed = options.seed;
  if (seed === null) {
    throw new ForkError('invalid-message',
      'main\'s sent request was never captured; no fork can be seeded');
  }
  const last = seed.messages[seed.messages.length - 1];
  if (last !== undefined && last.role === 'tool' && last.text !== bodyText) {
    // The live blocker P3c-2 recorded, named at its cause rather than reported
    // as a generic fork conflict: appending this result here would be two tool
    // turns in a row, and the turn in between is a response no capture holds.
    throw new ForkError('role-conflict',
      'main\'s last captured request ends with a prior tool result, so the assistant turn '
      + 'that made this result\'s tool call is not in it; a surface seed is needed to ask here');
  }
  return landedWire(seed, bodyText);
}

/**
 * Ask the agent once about one landed result, with at most one correction turn.
 *
 * One fork, one ask turn, one send; if the answer cannot be applied
 * arithmetically, one appended assistant turn and one correction turn, one more
 * send. Never more: the retry's answer is validated once and a second refusal
 * is returned as data. The caller decides what an answer or a refusal means;
 * this module never journals and never touches application state.
 */
export async function askEntry(options: EntryAskOptions): Promise<EntryAskOutcome> {
  if (!armed(options.route)) return { status: 'off' };
  const variant = variantOf(options.variant);
  if (typeof variant !== 'string') return variant;
  if ((options.surface ?? null) === null && options.seed === null) {
    return refused('no-seed',
      "main's sent request was never captured; no fork can be seeded",
      { retried: false, turns: [] });
  }
  const facts = entryAskFacts(options.resultBytes);
  const ask: EntryAskTurn = { role: 'user', text: entryAskMessage({ ...facts, variant }) };
  const bodyText = landedTextOf(options.resultBytes);
  let fork: WireFork;
  try {
    // The prefix is main's wire state after the landing — the mount's own
    // surface projection when it has one, the capture plus the landed result
    // turn otherwise — and never the pre-landing state.
    fork = appendAsk(seedWire(options, bodyText), ask.text);
  } catch (error) {
    return refused('no-seed', messageOf(error), { retried: false, turns: [] });
  }
  const stream: StreamAskOptions = {
    provider: options.route.provider,
    model: options.route.model,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const turns: readonly EntryAskTurn[] = [ask];
  const first = await sendOnce(fork, options.llm, stream, turns, false);
  if (first.status === 'refused') return first;
  const firstUsage = first.usage === undefined ? {} : { usage: first.usage };
  const read = readAnswer(first.text);
  const retryCode = read.kind === 'refused'
    ? (read.code === 'invalid-span' ? 'invalid-span' : null)
    : arithmeticRefusal(read.answer, facts.lineCount);
  if (retryCode === null) {
    if (read.kind === 'refused') {
      return refused(read.code, read.message,
        { raw: first.text, retried: false, turns, ...firstUsage });
    }
    return { status: 'answered', answer: read.answer, raw: first.text, retried: false,
      turns: [...turns, { role: 'assistant', text: first.text }], ...firstUsage };
  }
  const correction: EntryAskTurn = { role: 'user', text: entryRetryAskMessage(facts, retryCode) };
  const firstAnswer: EntryAskTurn = { role: 'assistant', text: first.text };
  const retryTurns: readonly EntryAskTurn[] = [...turns, firstAnswer, correction];
  let grown: WireFork;
  try {
    grown = appendAsk(appendMessage(fork, firstAnswer), correction.text);
  } catch (error) {
    // The correction turn never reached a fork, so the exchange the mount
    // appends is the first ask alone: the answer text is kept for the journal,
    // and the landed result stays whole (ADR-0022 §14).
    return refused('no-seed', messageOf(error),
      { raw: first.text, retried: false, turns, ...firstUsage });
  }
  const second = await sendOnce(grown, options.llm, stream, retryTurns, true);
  if (second.status === 'refused') {
    // Both sends were paid for; a reading that names only the second would
    // under-report the exchange's cost.
    const merged = sumUsage(first.usage, second.usage);
    return merged === undefined ? second : { ...second, usage: merged };
  }
  const usage = sumUsage(first.usage, second.usage);
  const usageField = usage === undefined ? {} : { usage };
  const secondRead = readAnswer(second.text);
  if (secondRead.kind === 'refused') {
    return refused(secondRead.code, secondRead.message,
      { raw: second.text, retried: true, turns: retryTurns, ...usageField });
  }
  const again = arithmeticRefusal(secondRead.answer, facts.lineCount);
  if (again !== null) {
    return refused(again, arithmeticMessage(again, facts.lineCount),
      { raw: second.text, retried: true, turns: retryTurns, ...usageField });
  }
  return { status: 'answered', answer: secondRead.answer, raw: second.text, retried: true,
    turns: [...retryTurns, { role: 'assistant', text: second.text }], ...usageField };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
