/**
 * Host-side read of the product's ONE language switch (ticket 153 step 2).
 *
 * The client dictionary and the host settings namespace already agree on two
 * ids: `@deepseek-ai/dsh-client-locale` declares
 * `LOCALE_SETTINGS_NAMESPACE = "locale"`, `LOCALE_PREFERENCE_FIELD =
 * "preference"`, `LOCALE_IDS = ["zh", "en"]` (`lib/index.js:5-11`). That
 * namespace is a Loader-row config form, so the host reads its live value
 * through the `settings` service's `describe()` — no new store, no new
 * config option (ticket 153's seam decision, step 1 comment).
 *
 * The plugin does not inject `settings` (it is not in `inject`), so the read
 * goes through `ctx.get("settings")`, the same guarded route ticket 124 uses
 * for `tokenMeter`. Every failure — service absent, `describe()` throwing, a
 * malformed descriptor, a language we do not ship — fails CLOSED to EN.
 */

import { resolvePolicyLanguage, type PolicyLanguage } from "../core/policy/prompts.js";

/** The host's locale settings namespace (pinned by `dsh-client-locale`). */
export const LOCALE_SETTINGS_NAMESPACE = "locale";

/** The field carrying an explicit selection; absence delegates to the browser. */
export const LOCALE_PREFERENCE_FIELD = "preference";

/** Structural slice of the host `settings` service this read needs. */
interface SettingsDescribeLike {
  describe?: () => readonly {
    ns?: unknown;
    value?: unknown;
  }[];
}

/**
 * Read the persisted locale preference once. Returns `undefined` when it
 * cannot be read — callers pass the result through
 * {@link resolvePolicyLanguage}, which maps absent/unknown to EN.
 */
export function readLocalePreference(
  get: ((name: string) => unknown) | undefined,
): unknown {
  if (typeof get !== "function") return undefined;
  let service: unknown;
  try {
    service = get("settings");
  } catch {
    return undefined;
  }
  if (service === null || typeof service !== "object") return undefined;
  const describe = (service as SettingsDescribeLike).describe;
  if (typeof describe !== "function") return undefined;
  let rows: readonly { ns?: unknown; value?: unknown }[];
  try {
    const result = describe.call(service);
    if (!Array.isArray(result)) return undefined;
    rows = result;
  } catch {
    return undefined;
  }
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    if (row.ns !== LOCALE_SETTINGS_NAMESPACE) continue;
    const value = row.value;
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[LOCALE_PREFERENCE_FIELD];
  }
  return undefined;
}

/**
 * The resolved model-facing language for this process. Read once at apply,
 * like every other volatile setting (ADR-0005): a language flip applies from
 * the next session, never mid-session.
 */
export function resolveHostPolicyLanguage(
  get: ((name: string) => unknown) | undefined,
): PolicyLanguage {
  return resolvePolicyLanguage(readLocalePreference(get));
}
