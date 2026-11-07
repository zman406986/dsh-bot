/**
 * Pure resolver for the opt-in spawn model option (ticket 285,
 * `.scratch/model-arg/PLAN.md` §§3.2/3.4).
 *
 * The tool layer passes the raw argument; this module trims it, matches it
 * against the live model catalog, and answers one of:
 *
 * - `absent` — the value was empty or whitespace-only. The caller behaves as
 *   if the argument were omitted and no warning is emitted.
 * - `resolved` — the catalog's canonical provider/model spelling.
 * - `fallback` — a non-empty value that did not resolve. A fallback is NOT a
 *   refusal: the spawn proceeds on the inherited route and the caller reports
 *   the note. The resolver calls `warn` exactly once for such a value and
 *   never calls it for a resolved or absent one.
 *
 * Syntax (plan §0.2):
 *
 *     provider/model-id    preferred, unambiguous
 *     model-id             accepted only when it resolves to exactly one model
 *
 * Lookup order (plan §3.2):
 *
 * 1. Explicit route: provider ids are matched case-insensitively, the longest
 *    registered provider prefix wins, and the model id may itself contain
 *    slashes. A throwing catalog for a provider the caller named explicitly is
 *    a `catalog-error` — the whole string is never silently reinterpreted as a
 *    bare model id.
 * 2. Bare model id: exact id first, then case-insensitive. A match shared by
 *    several providers resolves only when the spawning session's
 *    `preferredProvider` owns exactly one of them; otherwise it is
 *    `ambiguous-model`.
 *
 * The module is deliberately dependency-free (core types only): no live
 * cordis context, no dsh package import, and no logging side effect of its
 * own. The caller supplies both the catalog and the warning sink, which keeps
 * this unit-testable offline. The host wrapper adds the required
 * `[multitask-dispatcher]` prefix to the warning text.
 */

import type {
  ModelOptionPurpose,
  ModelOptionResolution,
  ModelResolutionFailure,
  ModelRoute,
} from "../core/types.js";

/** Structural view of the live model catalog (`ctx.llm`); no host import. */
export interface ModelCatalogLike {
  listProviders(): readonly { id: string; name?: string }[];
  listModels(provider: string): Promise<readonly { id: string; name?: string }[]>;
}

/** One provider or provider-owned model entry from the catalog. */
interface CatalogEntry {
  readonly id: string;
  readonly name?: string;
}

/** Longest log-safe slice of the model-authored value (plan §3.4). */
export const MODEL_OPTION_VALUE_MAX_CHARS = 120;

/** Control characters, including line separators, become spaces in a log. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Human-readable reason phrases used inside the warning parentheses. */
const REASON_TEXT: Readonly<Record<ModelResolutionFailure, string>> = {
  "unknown-model": "unknown model",
  "ambiguous-model": "ambiguous model",
  "catalog-unavailable": "the model catalog is unavailable",
  "catalog-error": "the model catalog could not be read",
};

/**
 * The pieces of one fallback warning. Separate from
 * `ResolveModelOptionInput` so the host and the resolver's tests can build
 * the same sentence without duplicating the wording.
 */
export interface ModelOptionWarningInput {
  readonly raw: string;
  readonly purpose: ModelOptionPurpose;
  readonly sessionId: string;
  readonly reason: ModelResolutionFailure;
  readonly fallbackDescription: string;
}

/** Replace control characters with spaces and truncate the log-safe value. */
function sanitizeValue(raw: string): string {
  const replaced = raw.replace(CONTROL_CHARS, " ");
  return Array.from(replaced).slice(0, MODEL_OPTION_VALUE_MAX_CHARS).join("");
}

/**
 * The resolver's warning sentence, without the host's log prefix. The option
 * label follows the purpose: `worker-default` is the `worker_model` argument
 * on spawn_dispatcher, everything else is that tool's `model` argument.
 */
export function formatModelOptionWarning(
  input: ModelOptionWarningInput,
): string {
  const option =
    input.purpose === "worker-default" ? "worker_model option" : "model option";
  return (
    `${option} "${sanitizeValue(input.raw)}" from session ${input.sessionId} ` +
    `was ignored (${REASON_TEXT[input.reason]}); ` +
    `using ${input.fallbackDescription}.`
  );
}

/** Everything the resolver needs; the caller owns catalog and logging. */
export interface ResolveModelOptionInput {
  readonly raw: string;
  readonly purpose: ModelOptionPurpose;
  readonly sessionId: string;
  readonly preferredProvider?: string;
  readonly catalog?: ModelCatalogLike;
  readonly fallbackDescription: string;
  readonly warn: (message: string) => void;
}

/** Exact id first, then case-insensitive, as the plan requires. */
function findModel(
  models: readonly CatalogEntry[],
  requested: string,
): CatalogEntry | undefined {
  const exact = models.find((model) => model.id === requested);
  if (exact !== undefined) return exact;
  const lowered = requested.toLowerCase();
  return models.find((model) => model.id.toLowerCase() === lowered);
}

/**
 * Explicit `provider/model` pass. Returns undefined when no registered
 * provider prefix matched (the caller then tries the bare-id pass) and a
 * complete fallback when the named provider's catalog threw or no model
 * matched.
 */
async function resolveExplicitRoute(
  catalog: ModelCatalogLike,
  providers: readonly CatalogEntry[],
  value: string,
  reject: (reason: ModelResolutionFailure) => ModelOptionResolution,
): Promise<ModelOptionResolution | undefined> {
  const loweredValue = value.toLowerCase();
  const longestFirst = [...providers].sort(
    (left, right) => right.id.length - left.id.length,
  );

  for (const provider of longestFirst) {
    const prefix = provider.id.toLowerCase() + "/";
    if (!loweredValue.startsWith(prefix)) continue;

    const remainder = value.slice(provider.id.length + 1);
    if (remainder === "") continue;

    let models: readonly CatalogEntry[];
    try {
      models = await catalog.listModels(provider.id);
    } catch {
      // The caller named this provider explicitly. Do not reinterpret the
      // whole string as a bare model id behind its back.
      return reject("catalog-error");
    }

    const model = findModel(models, remainder);
    if (model !== undefined) {
      return {
        kind: "resolved",
        route: { provider: provider.id, model: model.id },
      };
    }
  }

  return undefined;
}

/**
 * Bare-id pass. Throwing provider catalogs are skipped, so one broken
 * provider cannot hide a model that another provider resolves. Every
 * provider throwing is `catalog-unavailable`; no match at all is
 * `unknown-model`.
 */
async function resolveBareId(
  input: ResolveModelOptionInput,
  catalog: ModelCatalogLike,
  providers: readonly CatalogEntry[],
  value: string,
  reject: (reason: ModelResolutionFailure) => ModelOptionResolution,
): Promise<ModelOptionResolution> {
  const matches: ModelRoute[] = [];
  const seen = new Set<string>();
  let failedProviders = 0;

  for (const provider of providers) {
    let models: readonly CatalogEntry[];
    try {
      models = await catalog.listModels(provider.id);
    } catch {
      failedProviders += 1;
      continue;
    }

    const model = findModel(models, value);
    if (model === undefined) continue;

    const key = provider.id + "/" + model.id;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ provider: provider.id, model: model.id });
  }

  const only = matches.length === 1 ? matches[0] : undefined;
  if (only !== undefined) return { kind: "resolved", route: only };

  if (matches.length > 1) {
    const preferredProvider = input.preferredProvider;
    if (preferredProvider !== undefined) {
      const loweredPreferred = preferredProvider.toLowerCase();
      const preferred = matches.filter(
        (match) => match.provider.toLowerCase() === loweredPreferred,
      );
      const preferredOnly = preferred.length === 1 ? preferred[0] : undefined;
      if (preferredOnly !== undefined) {
        return { kind: "resolved", route: preferredOnly };
      }
    }
    return reject("ambiguous-model");
  }

  if (providers.length > 0 && failedProviders === providers.length) {
    return reject("catalog-unavailable");
  }
  return reject("unknown-model");
}

/**
 * Validate one model option against the catalog. Never throws for a bad
 * value: an unknown, ambiguous, or unreadable route is a `fallback` with one
 * warning, so the spawn can proceed on the inherited route.
 */
export async function resolveModelOption(
  input: ResolveModelOptionInput,
): Promise<ModelOptionResolution> {
  const value = input.raw.trim();
  if (value === "") return { kind: "absent" };

  const reject = (reason: ModelResolutionFailure): ModelOptionResolution => {
    input.warn(
      formatModelOptionWarning({
        raw: input.raw,
        purpose: input.purpose,
        sessionId: input.sessionId,
        reason,
        fallbackDescription: input.fallbackDescription,
      }),
    );
    return { kind: "fallback", requested: value, reason };
  };

  const catalog = input.catalog;
  if (catalog === undefined) return reject("catalog-unavailable");

  let providers: readonly CatalogEntry[];
  try {
    providers = catalog.listProviders();
  } catch {
    return reject("catalog-error");
  }

  const explicit = await resolveExplicitRoute(catalog, providers, value, reject);
  if (explicit !== undefined) return explicit;

  return resolveBareId(input, catalog, providers, value, reject);
}
