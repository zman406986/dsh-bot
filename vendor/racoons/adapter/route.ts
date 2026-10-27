/**
 * The host's resolved route for the mount's asks (ADR-0028: two ask moments —
 * the entry checkpoint and the bulk prune).
 *
 * Both surviving asks go to the same place: the provider/model pair the live
 * session's own request header states. The entry ask and the prune table ask
 * read it before they compose their request; a mount with no route refuses with
 * `not-configured` instead of guessing a model.
 *
 * This module has no runtime import of the mount: it reads the host session
 * structurally (`requestHeader`), so the type cycle stays type-only and erased.
 */
import type { DshMountSession } from './plugin.js';

/** The route an ask goes to: the host's resolved provider/model pair. */
export interface JudgeRoute {
  readonly provider: string;
  readonly model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The host's resolved route, read from the live session's own request header,
 * or the caller's fallback pair. `null` means no ask can be made: the caller
 * refuses with `not-configured` instead of guessing a model.
 */
export function judgeRouteOf(host: DshMountSession | null | undefined,
  fallback?: JudgeRoute): JudgeRoute | null {
  if (fallback !== undefined) return fallback;
  const header = typeof host?.requestHeader === 'function' ? host.requestHeader() : undefined;
  const config = isRecord(header) && isRecord(header['config']) ? header['config'] : null;
  if (config === null) return null;
  const provider = typeof config['provider'] === 'string' ? config['provider'] : null;
  const model = typeof config['model'] === 'string' ? config['model'] : null;
  return provider === null || model === null || provider === '' || model === ''
    ? null : { provider, model };
}
