/**
 * One wire answer from the host's model seam (ISSUE-022 chunk 5; ADR-0028).
 *
 * Both surviving ask shapes in this package end the same way: one system slot,
 * one user message, no tools, and a joined `text-delta` stream read against one
 * deadline — the entry checkpoint's anchored ask and the bulk prune's table
 * ask. They decode the text differently; the stream loop is one function here,
 * because a second copy of it would be the thing that drifts.
 *
 * Fail-open is structural. Every failure that is not a joined text answer — no
 * route, a thrown stream, an aborted or errored finish, a truncated `max-tokens`
 * reply, empty text — is a typed record, never an exception into the host's
 * step. The caller decides what a refusal means; here it only names itself.
 */
import {
  ForkError, forkErrorMessage, hashSystem, hashTools,
} from '@racoons/core';
import type { ApiUsage, Sha256 } from '@racoons/core';
import type { DshLlmChunk, DshLlmService, DshLlmStreamOptions } from './plugin.js';
import { readAssistantUsage } from './usage.js';

/** The one default deadline shared by the entry ask and the prune ask. */
export const DEFAULT_ASK_TIMEOUT_MS = 30_000;

/**
 * The process-local mark every ask from this package carries. The mount's
 * `llm/stream` observer uses it to tell a racoons ask (entry, prune) from
 * main's requests: an ask must never become the next fork seed. A symbol, so
 * nothing reaches a provider body.
 */
const RACOONS_ASK_MARK = Symbol.for('racoons.ask');

/** True for a request this package sent as its own ask. */
export function isRacoonsAskRequest(options: unknown): boolean {
  return options !== null && typeof options === 'object'
    && (options as Record<symbol, unknown>)[RACOONS_ASK_MARK] === true;
}

/** Why a stream ask produced no text. */
export type StreamFailureReason =
  | 'not-configured' | 'stream-error' | 'stream-truncated' | 'timeout' | 'aborted' | 'no-text';

export interface AskFailure<Reason extends string> {
  readonly status: 'refused';
  readonly reason: Reason;
  /** The wire parser's stable code on a `wire-refusal`; null otherwise. */
  readonly code: string | null;
  readonly message: string;
}

export type StreamRefusal = AskFailure<StreamFailureReason>;

/** The route and limits of one stream ask. */
export interface StreamAskOptions {
  readonly provider: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/** One answered stream: the joined text and the host's finish kind. */
export interface StreamAnswer {
  readonly status: 'answered';
  /** The joined `text-delta` text, verbatim. */
  readonly text: string;
  /** The host's finish kind, or null when the stream ended without one. */
  readonly finish: string | null;
  /**
   * The ask's cost, when the host reported one (ISSUE-056 C6a — leader ruling
   * on the Phase R plan): the `{type:'usage'}` chunk the host emits before
   * `finish`, mapped to the core's `ApiUsage` by the one shipped arithmetic.
   * Absent means the host said nothing — never a zero claim. It is data on the
   * answer only; the engine's meter does not see an ask (the token watchdog
   * meters main traffic by design, so an ask's spend is reconciled post-run).
   */
  readonly usage?: ApiUsage;
}

export type StreamOutcome = StreamAnswer | StreamRefusal;

/** The fork's recorded hashes; when present they are re-asserted before send. */
export interface WireAskHashes {
  readonly systemHash: Sha256;
  readonly toolsHash: Sha256;
}

/** One wire-shaped ask: the fork's fields plus the hashes it recorded. */
export interface WireAskRequest {
  readonly system: string;
  readonly tools: readonly unknown[];
  readonly messages: readonly { readonly role: string; readonly text: string }[];
  /** Present for a fork ask: a drifted system or tool list throws, never sends. */
  readonly expected?: WireAskHashes;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function refuse<Reason extends string>(reason: Reason, message: string,
  code: string | null = null): AskFailure<Reason> {
  return { status: 'refused', reason, code, message };
}

/** The finish kind, from either host spelling (`"stop"` or `{kind: "stop"}`). */
function finishKind(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  if (isRecord(reason) && typeof reason['kind'] === 'string') return reason['kind'];
  return 'unknown';
}

/**
 * The ask's cost, read off one `{type:'usage'}` chunk by the ONE arithmetic the
 * package already ships for host usage (`readAssistantUsage`, `./usage.ts`).
 *
 * That reader takes the `assistant/message` event shape, and the stream chunk is
 * the same row one level in: `{type:'usage', usage: TokenUsage}`. This function
 * is the projection — the row is re-wrapped in the event shape the reader
 * declares and nothing else is supplied (`seq` is required by the type and read
 * by nothing). The alternative, reading the counters here, would be a second
 * copy of the disjoint-bucket rule, which is exactly what must not drift.
 *
 * `undefined` means the host made no claim: an absent, null or unusable row.
 */
function usageOfChunk(chunk: Record<string, unknown>): ApiUsage | undefined {
  const read = readAssistantUsage({ type: 'assistant/message', seq: 0,
    data: { usage: chunk['usage'] } });
  return read !== null && read.kind === 'usage' ? read.usage : undefined;
}

/** One iterator step, abandoned when the deadline's controller aborts. */
function nextWithin(iterator: AsyncIterator<DshLlmChunk>,
  signal: AbortSignal): Promise<IteratorResult<DshLlmChunk>> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { reject(new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/**
 * One wire-shaped ask (ISSUE-026 chunk 3): the full request a fork carries —
 * `system`, `tools` and every message — sent as it stands.
 *
 * The fork's messages are turned into the host's request shape with the one
 * mapping this seam has: each `{role, text}` becomes a text content block.
 * Nothing is joined, reordered or truncated, and `system` is sent only when it
 * is non-empty.
 *
 * A `tool` turn goes out as `user`: a text-projected seed carries no
 * `tool_use` block, and a provider rejects a `tool_result` whose id names no
 * call. The fork keeps its own role for hashing; only this projection is the
 * host's, and the module note says why the projection exists at all.
 *
 * An `assistant` turn carries a `source`. The host requires one on every
 * assistant message: its replay filter reads `message.source.replayState` and
 * throws on an assistant message with no source (probe:
 * `scratchpad/probe-llm/outcomes.jsonl`, every assistant-bearing shape without
 * one failed with `Cannot read properties of undefined (reading
 * 'replayState')`). The seed keeps only `{role, text}` — the capture drops the
 * host's original source — so this projection supplies the source the host
 * writes for a routed answer: this ask's own provider and model, and no
 * `replayState`, which is the field that would make the host try to replay a
 * response this ask never received.
 *
 * That is the honest limit of this seam: the host hands the adapter the request
 * OBJECT, and the adapter maps it to the provider's HTTP body; no code here sees
 * those HTTP bytes.
 *
 * A reply is text or nothing: a tool call, an empty stream, a cap and a dead
 * socket are all typed refusals.
 *
 * The last act before the host seam is touched is the fork's own invariant:
 * when `expected` carries the fork's recorded hashes, the system bytes and the
 * tool list are hashed again and a mismatch throws the fork's typed
 * `ForkError` (`system-hash-drift` / `tools-hash-drift`) instead of sending a
 * drifted prefix (CRITIC-026 P3#7). That throw is a caller-contract failure,
 * not a stream refusal; the caller decides how to fail open.
 */
export async function askWire(llm: DshLlmService,
  request: WireAskRequest,
  options: StreamAskOptions): Promise<StreamOutcome> {
  assertWireAskIntact(request);
  return askRequest(llm, {
    ...(request.system === '' ? {} : { system: request.system }),
    ...(request.tools.length === 0 ? {} : { tools: request.tools }),
    messages: request.messages.map(message => {
      const role = message.role === 'tool' ? 'user' : message.role;
      return {
        role,
        ...(role === 'assistant'
          ? { source: { kind: 'model', provider: options.provider.trim(),
            model: options.model.trim() } }
          : {}),
        content: [{ type: 'text', text: message.text }],
      };
    }),
  }, options);
}

/** Re-assert the fork's recorded system and tool hashes immediately before send. */
function assertWireAskIntact(request: WireAskRequest): void {
  const expected = request.expected;
  if (expected === undefined) return;
  if (hashSystem(request.system) !== expected.systemHash) {
    throw new ForkError('system-hash-drift', forkErrorMessage('system-hash-drift'));
  }
  if (hashTools(request.tools) !== expected.toolsHash) {
    throw new ForkError('tools-hash-drift', forkErrorMessage('tools-hash-drift'));
  }
}

/** The one stream loop both ask shapes share. Every ask is marked as racoons'. */
async function askRequest(llm: DshLlmService, fields: {
  readonly system?: string;
  readonly tools?: readonly unknown[];
  readonly messages: readonly Readonly<Record<string, unknown>>[];
}, options: StreamAskOptions): Promise<StreamOutcome> {
  const provider = options.provider.trim();
  const model = options.model.trim();
  if (provider === '' || model === '') {
    return refuse('not-configured', 'no provider/model route for the ask');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  const outer = options.signal;
  const forward = (): void => { controller.abort(); };
  if (outer !== undefined) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', forward, { once: true });
  }
  let text = '';
  let finish: string | null = null;
  // The host's own accounting for this call, when it reports one. The chunk is
  // `{type:'usage', usage: TokenUsage}` and arrives before `finish`; it used to
  // be discarded here (ISSUE-056 C6a), which left every ask's cost estimated.
  let usage: ApiUsage | undefined;
  try {
    const request: DshLlmStreamOptions = {
      provider, model,
      ...fields.system === undefined ? {} : { system: fields.system },
      ...fields.tools === undefined ? {} : { tools: fields.tools },
      messages: fields.messages,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      signal: controller.signal,
    };
    (request as unknown as Record<symbol, unknown>)[RACOONS_ASK_MARK] = true;
    const iterator = llm.stream(request)[Symbol.asyncIterator]();
    for (;;) {
      const step = await nextWithin(iterator, controller.signal);
      if (step.done === true) break;
      const chunk = step.value;
      if (isRecord(chunk) && chunk['type'] === 'text-delta'
        && typeof chunk['text'] === 'string') {
        text += chunk['text'];
        continue;
      }
      if (isRecord(chunk) && chunk['type'] === 'usage') {
        // The one shipped arithmetic (`./usage.ts`) maps the host's disjoint
        // buckets to the core's `ApiUsage`. A row it cannot use is no claim,
        // never a zero one: the field stays absent and the ask is still answered.
        usage = usageOfChunk(chunk) ?? usage;
        continue;
      }
      if (isRecord(chunk) && chunk['type'] === 'finish') {
        finish = finishKind(chunk['reason']);
        break;
      }
    }
  } catch (error) {
    if (timedOut) {
      return refuse('timeout', `the ask stream produced no answer within ${String(timeoutMs)} ms`);
    }
    if (controller.signal.aborted) return refuse('aborted', 'the ask stream was aborted');
    return refuse('stream-error', messageOf(error));
  } finally {
    if (timer !== null) clearTimeout(timer);
    outer?.removeEventListener('abort', forward);
  }
  if (finish === 'error' || finish === 'aborted') {
    return refuse('stream-error', `the ask stream finished with ${finish}`);
  }
  if (finish === 'max-tokens') {
    return refuse('stream-truncated', 'the answer hit the token cap and may be incomplete');
  }
  if (text.trim() === '') return refuse('no-text', 'the ask stream carried no text');
  return { status: 'answered', text, finish,
    ...(usage === undefined ? {} : { usage }) };
}
