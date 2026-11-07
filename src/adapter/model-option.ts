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
 *     model-id             unique, or shared but owned by the caller's provider
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
 * The module is deliberately dependency-free (core types and one pure
 * display helper): no live cordis context, no dsh package import, and no
 * logging side effect of its own. The caller supplies both the catalog and the warning sink, which keeps
 * this unit-testable offline. The host wrapper adds the required
 * `[multitask-dispatcher]` prefix to the warning text.
 */

import type {
  ModelOptionPurpose,
  ModelOptionResolution,
  ModelResolutionFailure,
  ModelRoute,
} from "../core/types.js";
import { sanitizeModelOptionValue } from "../core/model-option-value.js";

export { MODEL_OPTION_VALUE_MAX_CHARS } from "../core/model-option-value.js";

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
  /** Optional display detail for the reason (a partial catalog read). */
  readonly detail?: string;
  readonly fallbackDescription: string;
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
  const reason =
    input.detail === undefined
      ? REASON_TEXT[input.reason]
      : `${REASON_TEXT[input.reason]}: ${input.detail}`;
  return (
    `${option} "${sanitizeModelOptionValue(input.raw)}" from session ${input.sessionId} ` +
    `was ignored (${reason}); ` +
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

/** One tuple from the catalog: a plain object with a string id. */
function isCatalogEntry(value: unknown): value is CatalogEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/**
 * Guard the declared provider-list shape. A host/catalog contract violation
 * (a non-array, or an entry without a string id) must become a fallback, not
 * a thrown TypeError from the later spread or the id sort.
 */
function readProviders(catalog: ModelCatalogLike): readonly CatalogEntry[] {
  const providers: unknown = catalog.listProviders();
  if (!Array.isArray(providers)) {
    throw new TypeError("the model catalog returned a non-array provider list");
  }
  for (const provider of providers as readonly unknown[]) {
    if (!isCatalogEntry(provider)) {
      throw new TypeError("the model catalog returned a malformed provider");
    }
  }
  return providers as readonly CatalogEntry[];
}

/**
 * Guard the declared model-list shape. Undefined means this provider's
 * catalog is unusable (threw or returned the wrong shape); the caller decides
 * whether that is fatal (explicit route) or just one unreadable provider
 * (bare-id pass).
 */
function readModels(models: unknown): readonly CatalogEntry[] | undefined {
  if (!Array.isArray(models)) return undefined;
  for (const model of models as readonly unknown[]) {
    if (!isCatalogEntry(model)) return undefined;
  }
  return models as readonly CatalogEntry[];
}

/** One rejection inside a resolver pass: warn once, describe the fallback. */
type RejectModelOption = (
  reason: ModelResolutionFailure,
  detail?: string,
) => ModelOptionResolution;

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
  reject: RejectModelOption,
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

    let models: readonly CatalogEntry[] | undefined;
    try {
      models = readModels(await catalog.listModels(provider.id));
    } catch {
      models = undefined;
    }
    if (models === undefined) {
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
 * provider throwing is `catalog-unavailable`; a partial read with no match
 * is `catalog-error` (the model may exist in an unreadable provider); only a
 * fully readable catalog with no match is `unknown-model`.
 */
async function resolveBareId(
  input: ResolveModelOptionInput,
  catalog: ModelCatalogLike,
  providers: readonly CatalogEntry[],
  value: string,
  reject: RejectModelOption,
): Promise<ModelOptionResolution> {
  const matches: ModelRoute[] = [];
  const seen = new Set<string>();
  let failedProviders = 0;
  let malformedProviders = 0;

  for (const provider of providers) {
    let models: readonly CatalogEntry[] | undefined;
    try {
      models = readModels(await catalog.listModels(provider.id));
    } catch {
      failedProviders += 1;
      continue;
    }
    if (models === undefined) {
      malformedProviders += 1;
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
  const unreadable = failedProviders + malformedProviders;
  if (unreadable > 0) {
    // A partial read is not proof that the model does not exist. The warning
    // carries the count so the fallback does not read as a confident
    // unknown-model.
    return reject(
      "catalog-error",
      `${unreadable} of ${providers.length} providers failed`,
    );
  }
  return reject("unknown-model");
}

/**
 * Answer to "is this STORED route still in the live catalog?" — the restore
 * re-check for a route that was resolved when an earlier process summoned the
 * leader, so the catalog has had time to change underneath it.
 */
export type StoredModelRouteCatalogAnswer = "resolved" | "absent" | "unknown";

/**
 * Re-check one route that was already resolved against the catalog — the
 * leader's durable `worker_model` on the restore path.
 *
 * Three answers, because "cannot see it" is not "it is gone":
 *
 * - `resolved` — a readable catalog lists both the provider and the model;
 * - `absent` — the catalog was readable and lists neither, so the route is
 *   genuinely stale and may be dropped;
 * - `unknown` — no catalog is mounted, or one throws / violates the declared
 *   shape, so a transient failure must not erase a default that may still be
 *   valid.
 */
export async function checkModelRouteInCatalog(
  catalog: ModelCatalogLike | undefined,
  route: ModelRoute,
): Promise<StoredModelRouteCatalogAnswer> {
  if (catalog === undefined) return "unknown";
  try {
    const providers = catalog.listProviders();
    const provider =
      providers.find((entry) => entry.id === route.provider) ??
      providers.find(
        (entry) => entry.id.toLowerCase() === route.provider.toLowerCase(),
      );
    if (provider === undefined) return "absent";
    const models = await catalog.listModels(provider.id);
    return findModel(models, route.model) === undefined ? "absent" : "resolved";
  } catch {
    // A throwing provider, or a catalog whose shape breaks the declared
    // interface, proves nothing about the stored route.
    return "unknown";
  }
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

  const reject: RejectModelOption = (reason, detail) => {
    input.warn(
      formatModelOptionWarning({
        raw: input.raw,
        purpose: input.purpose,
        sessionId: input.sessionId,
        reason,
        fallbackDescription: input.fallbackDescription,
        ...(detail === undefined ? {} : { detail }),
      }),
    );
    return {
      kind: "fallback",
      requested: value,
      reason,
      ...(detail === undefined ? {} : { detail }),
    };
  };

  const catalog = input.catalog;
  if (catalog === undefined) return reject("catalog-unavailable");

  let providers: readonly CatalogEntry[];
  try {
    providers = readProviders(catalog);
  } catch {
    return reject("catalog-error");
  }

  try {
    const explicit = await resolveExplicitRoute(catalog, providers, value, reject);
    if (explicit !== undefined) return explicit;
    return await resolveBareId(input, catalog, providers, value, reject);
  } catch {
    // The resolver contract says it never throws for a bad value. Any
    // remaining contract violation (a catalog that fails in a way the shape
    // guards cannot see) still becomes one catalog-error fallback, never a
    // refused spawn.
    return reject(
      "catalog-error",
      "the model catalog returned an unexpected shape",
    );
  }
}
