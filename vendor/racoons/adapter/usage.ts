/**
 * Per-call usage read from the host's `assistant/message` events (G8, PRD §6.9:
 * "authoritative counts reconcile from API `usage` (including cached tokens)
 * after each call").
 *
 * The host has exactly one place where an authoritative token count exists: the
 * `usage` row the model adapter attached to the step's `assistant/message`
 * event. There is no separate usage event (`dsh-session` `assistant/message`:
 * "the model output and its accounting travel together (there is no separate
 * usage record)"), so this module reads that event and nothing else. It maps
 * host bytes to the core's `ApiUsage`; when the mount hands the value to the
 * engine is the mount's decision, not this module's.
 *
 * **The count arithmetic is the host's own contract, restated in the core's
 * terms.** `TokenUsage` in `@deepseek-ai/dsh-llm` states that its counts are
 * DISJOINT: `inputTokens` is uncached input only, cached input arrives
 * separately as `cacheReadTokens`/`cacheWriteTokens`, and "billed input = sum of
 * the three. Adapters whose providers fold cache hits into a total prompt count
 * subtract them out." The core's `ApiUsage.inputTokens` is the whole prompt and
 * `cachedInputTokens` is the cached part OF it — `Meter.reconcile` refuses a
 * cached count above the input count (`MeterError('inconsistent-usage')`) and
 * divides the share as `cachedInputTokens / inputTokens`.
 *
 * So the host's buckets are summed into the core's input count, and the cached
 * counters ride `cachedInputTokens` as one value: the cached share survives as
 * a reader of the reading, never swallowed by the total. Reading the host row
 * verbatim would throw on every warm call — the live rows are of the shape
 * `{input: 240, output: 81, cacheRead: 7296}` — which is exactly the lie
 * `liveTokens: true` must stop being.
 *
 * A cache write is counted with a cache read: both are prompt bytes the
 * provider accounts to the prefix cache rather than to fresh input, and both
 * are inside the billed prompt the core's `inputTokens` names.
 *
 * Nothing here throws on host junk: a malformed row is a reading the meter
 * cannot use, and the caller journals that as missing rather than failing the
 * host's step.
 */
import type { ApiUsage } from '@racoons/core';

/**
 * The structural slice of a host event this module reads. `DshMountEvent` is
 * assignable to it and so is a bare `{type, seq, data}` a test builds, so this
 * module never imports the mount.
 */
export interface DshUsageSource {
  readonly type: string;
  readonly seq: number;
  readonly data?: unknown;
}

/**
 * What one event says about usage:
 * - `usage` — a row the meter can reconcile;
 * - `missing` — an `assistant/message` that carries no `usage` row at all;
 * - `invalid` — a `usage` row whose counts are not usable.
 */
export type DshUsageRead =
  | { readonly kind: 'usage'; readonly usage: ApiUsage }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A token count, or null when the value is present but not a count. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** One optional cache counter: absent is `null`; present-but-junk is `invalid`. */
function optionalCount(value: unknown): { readonly value: number | null; readonly invalid: boolean } {
  if (value === undefined || value === null) return { value: null, invalid: false };
  const count = countOf(value);
  return count === null ? { value: null, invalid: true } : { value: count, invalid: false };
}

/**
 * Read one host event. `null` means the event says nothing about usage (it is
 * not an `assistant/message`), which is not the same as a message that carries
 * no row: absence of a row is a fact the caller journals, silence is not.
 */
export function readAssistantUsage(event: DshUsageSource): DshUsageRead | null {
  if (event.type !== 'assistant/message') return null;
  const data = isRecord(event.data) ? event.data : {};
  const raw = data['usage'];
  if (raw === undefined || raw === null) return { kind: 'missing' };
  if (!isRecord(raw)) return { kind: 'invalid', reason: 'usage is not an object' };
  const input = countOf(raw['inputTokens']);
  const output = countOf(raw['outputTokens']);
  if (input === null || output === null) {
    return { kind: 'invalid',
      reason: 'inputTokens and outputTokens must be non-negative safe integers' };
  }
  const cacheRead = optionalCount(raw['cacheReadTokens']);
  const cacheWrite = optionalCount(raw['cacheWriteTokens']);
  if (cacheRead.invalid || cacheWrite.invalid) {
    return { kind: 'invalid',
      reason: 'cacheReadTokens and cacheWriteTokens must be non-negative safe integers when present' };
  }
  // Both cache counters absent is an unknown cache, never a cold one.
  const cacheTotal = (cacheRead.value ?? 0) + (cacheWrite.value ?? 0);
  return { kind: 'usage', usage: {
    // The host's uncached input plus its two cached buckets: the one prompt the
    // core's `inputTokens` names, with the cached part still readable below.
    inputTokens: input + cacheTotal,
    outputTokens: output,
    cachedInputTokens: cacheRead.value === null && cacheWrite.value === null
      ? null : cacheTotal,
  } };
}

/**
 * The request one `assistant/message` belongs to. The host gives a message no
 * request id, so the event's own seq is the identity: unique per log and stable
 * across a remount, which is what the engine's per-request dedup reads.
 */
export function usageRequestId(sessionId: string, seq: number): string {
  return `dsh:${sessionId}:usage:${String(seq)}`;
}
