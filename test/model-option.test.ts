import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import type {
  ModelFallbackNotice,
  ModelOptionPurpose,
  ModelOptionResolution,
  ModelRoute,
} from "../src/index.js";
import {
  MODEL_OPTION_VALUE_MAX_CHARS,
  resolveModelOption,
  type ModelCatalogLike,
  type ResolveModelOptionInput,
} from "../src/adapter/model-option.js";
import { sanitizeModelOptionValue } from "../src/core/model-option-value.js";

/**
 * Contract and behaviour tests for the optional spawn model
 * (`.scratch/model-arg/PLAN.md`, Tasks 2-3).
 *
 * The first three tests are the compile-only contract pins from Task 2. The
 * rest exercise the pure resolver with offline fake catalogs: no network, no
 * live dsh context, no model calls.
 */

const SUMMONER_FALLBACK = "the summoner's current route";
const WORKER_FALLBACK = "the team leader's default worker route or its own route";
const WORKER_DEFAULT_FALLBACK = "the team leader's own route";

interface CatalogModel {
  readonly id: string;
  readonly name?: string;
}

const PROVIDERS: readonly CatalogModel[] = [
  { id: "alpha", name: "Alpha" },
  { id: "beta", name: "Beta" },
];

const ALPHA_MODELS: readonly CatalogModel[] = [
  { id: "shared", name: "Shared" },
  { id: "alpha-only", name: "Alpha Only" },
  { id: "slash/inside", name: "Slash Inside" },
];

const BETA_MODELS: readonly CatalogModel[] = [
  { id: "shared", name: "Shared" },
  { id: "beta-only", name: "Beta Only" },
];

/**
 * The fake catalog from the plan's Task 3. Only alpha and beta exist; an
 * unknown provider answers an empty list, exactly like a catalog that knows
 * every registered provider.
 */
function standardCatalog(
  listModels: (
    provider: string,
  ) => Promise<readonly CatalogModel[]> = async (provider) => {
    if (provider === "alpha") return ALPHA_MODELS;
    if (provider === "beta") return BETA_MODELS;
    return [];
  },
): ModelCatalogLike {
  return {
    listProviders: () => PROVIDERS,
    listModels,
  };
}

interface ResolveOverrides {
  readonly catalog?: ModelCatalogLike | undefined;
  readonly preferredProvider?: string;
  readonly purpose?: ModelOptionPurpose;
  readonly sessionId?: string;
  readonly fallbackDescription?: string;
}

/** Call the resolver with a warning collector; defaults are the worker path. */
async function resolve(
  raw: string,
  overrides: ResolveOverrides = {},
): Promise<{ readonly result: ModelOptionResolution; readonly warnings: string[] }> {
  const warnings: string[] = [];
  const input: ResolveModelOptionInput = {
    raw,
    purpose: overrides.purpose ?? "worker",
    sessionId: overrides.sessionId ?? "session-1",
    fallbackDescription: overrides.fallbackDescription ?? WORKER_FALLBACK,
    warn: (message) => {
      warnings.push(message);
    },
    ...(overrides.catalog === undefined
      ? {}
      : { catalog: overrides.catalog }),
    ...(overrides.preferredProvider === undefined
      ? {}
      : { preferredProvider: overrides.preferredProvider }),
  };
  const result = await resolveModelOption(input);
  return { result, warnings };
}

function firstWarning(warnings: readonly string[]): string {
  const warning = warnings[0];
  assert.ok(warning !== undefined, "expected one warning");
  return warning;
}

test("ModelRoute is constructible from the public package surface", () => {
  const route: ModelRoute = { provider: "p", model: "m" };
  assert.deepEqual(route, { provider: "p", model: "m" });
});

test("ModelOptionResolution has absent, resolved, and fallback arms", () => {
  const absent: ModelOptionResolution = { kind: "absent" };
  const resolved: ModelOptionResolution = {
    kind: "resolved",
    route: { provider: "p", model: "m" },
  };
  const fallback: ModelOptionResolution = {
    kind: "fallback",
    requested: "p/missing",
    reason: "unknown-model",
  };

  assert.equal(absent.kind, "absent");
  assert.equal(resolved.kind, "resolved");
  assert.deepEqual(fallback, {
    kind: "fallback",
    requested: "p/missing",
    reason: "unknown-model",
  });
});

test("ModelFallbackNotice names the option and the failure reason", () => {
  const leaderNotice: ModelFallbackNotice = {
    option: "model",
    requested: "p/missing",
    reason: "ambiguous-model",
  };
  const workerNotice: ModelFallbackNotice = {
    option: "worker_model",
    requested: "p/missing",
    reason: "catalog-unavailable",
  };

  assert.equal(leaderNotice.option, "model");
  assert.equal(workerNotice.option, "worker_model");
});

describe("resolveModelOption", () => {
  describe("absent values", () => {
    for (const raw of ["", " ", "   ", "\n\t "]) {
      it(`treats ${JSON.stringify(raw)} as absent and never warns`, async () => {
        const { result, warnings } = await resolve(raw, {
          catalog: standardCatalog(),
        });
        assert.deepEqual(result, { kind: "absent" });
        assert.equal(warnings.length, 0);
      });
    }
  });

  interface StandardCase {
    readonly name: string;
    readonly raw: string;
    readonly preferredProvider?: string;
    readonly expected: ModelOptionResolution;
    readonly warnCount: number;
  }

  const STANDARD_CASES: readonly StandardCase[] = [
    {
      name: "resolves an exact provider/model route canonically",
      raw: "alpha/alpha-only",
      expected: {
        kind: "resolved",
        route: { provider: "alpha", model: "alpha-only" },
      },
      warnCount: 0,
    },
    {
      name: "resolves a case-insensitive provider and model to canonical spelling",
      raw: "ALPHA/ALPHA-ONLY",
      expected: {
        kind: "resolved",
        route: { provider: "alpha", model: "alpha-only" },
      },
      warnCount: 0,
    },
    {
      name: "resolves a unique bare model id",
      raw: "alpha-only",
      expected: {
        kind: "resolved",
        route: { provider: "alpha", model: "alpha-only" },
      },
      warnCount: 0,
    },
    {
      name: "resolves a bare model id case-insensitively",
      raw: "Alpha-Only",
      expected: {
        kind: "resolved",
        route: { provider: "alpha", model: "alpha-only" },
      },
      warnCount: 0,
    },
    {
      name: "resolves a shared bare id to the preferred provider",
      raw: "shared",
      preferredProvider: "beta",
      expected: {
        kind: "resolved",
        route: { provider: "beta", model: "shared" },
      },
      warnCount: 0,
    },
    {
      name: "resolves a shared bare id to a case-insensitive preferred provider",
      raw: "shared",
      preferredProvider: "BETA",
      expected: {
        kind: "resolved",
        route: { provider: "beta", model: "shared" },
      },
      warnCount: 0,
    },
    {
      name: "falls back with ambiguous-model for a shared bare id",
      raw: "shared",
      expected: {
        kind: "fallback",
        requested: "shared",
        reason: "ambiguous-model",
      },
      warnCount: 1,
    },
    {
      name: "falls back with ambiguous-model when the preferred provider owns no match",
      raw: "shared",
      preferredProvider: "gamma",
      expected: {
        kind: "fallback",
        requested: "shared",
        reason: "ambiguous-model",
      },
      warnCount: 1,
    },
    {
      name: "falls back with unknown-model for a missing model under a known provider",
      raw: "alpha/nope",
      expected: {
        kind: "fallback",
        requested: "alpha/nope",
        reason: "unknown-model",
      },
      warnCount: 1,
    },
    {
      name: "falls back with unknown-model for an unknown provider",
      raw: "nope/nope",
      expected: {
        kind: "fallback",
        requested: "nope/nope",
        reason: "unknown-model",
      },
      warnCount: 1,
    },
    {
      name: "resolves a model id that contains slashes behind an explicit provider",
      raw: "alpha/slash/inside",
      expected: {
        kind: "resolved",
        route: { provider: "alpha", model: "slash/inside" },
      },
      warnCount: 0,
    },
    {
      name: "resolves a slashed model id through the bare-id pass",
      raw: "slash/inside",
      expected: {
        kind: "resolved",
        route: { provider: "alpha", model: "slash/inside" },
      },
      warnCount: 0,
    },
    {
      name: "trims outer whitespace before resolving",
      raw: " alpha/alpha-only ",
      expected: {
        kind: "resolved",
        route: { provider: "alpha", model: "alpha-only" },
      },
      warnCount: 0,
    },
    {
      name: "treats internal spaces as literal and falls back",
      raw: "alpha / alpha-only",
      expected: {
        kind: "fallback",
        requested: "alpha / alpha-only",
        reason: "unknown-model",
      },
      warnCount: 1,
    },
  ];

  describe("standard catalog", () => {
    for (const item of STANDARD_CASES) {
      it(item.name, async () => {
        const { result, warnings } = await resolve(item.raw, {
          catalog: standardCatalog(),
          ...(item.preferredProvider === undefined
            ? {}
            : { preferredProvider: item.preferredProvider }),
        });
        assert.deepEqual(result, item.expected);
        assert.equal(warnings.length, item.warnCount);
      });
    }
  });

  describe("provider prefix matching", () => {
    it("tries the longest registered provider prefix first", async () => {
      const calls: string[] = [];
      const catalog: ModelCatalogLike = {
        listProviders: () => [{ id: "alpha" }, { id: "alpha/nested" }],
        listModels: async (provider) => {
          calls.push(provider);
          if (provider === "alpha/nested") return [{ id: "model" }];
          return [{ id: "other" }];
        },
      };

      const { result, warnings } = await resolve("alpha/nested/model", {
        catalog,
      });
      assert.deepEqual(result, {
        kind: "resolved",
        route: { provider: "alpha/nested", model: "model" },
      });
      assert.deepEqual(calls, ["alpha/nested"]);
      assert.equal(warnings.length, 0);
    });
  });

  describe("catalog failures", () => {
    it("falls back with catalog-unavailable when no catalog is wired", async () => {
      const { result, warnings } = await resolve("alpha/alpha-only");
      assert.deepEqual(result, {
        kind: "fallback",
        requested: "alpha/alpha-only",
        reason: "catalog-unavailable",
      });
      assert.equal(warnings.length, 1);
      assert.match(firstWarning(warnings), /the model catalog is unavailable/);
    });

    it("falls back with catalog-error when listProviders throws", async () => {
      const catalog: ModelCatalogLike = {
        listProviders: () => {
          throw new Error("catalog down");
        },
        listModels: async () => [],
      };

      const { result, warnings } = await resolve("alpha/alpha-only", {
        catalog,
      });
      assert.deepEqual(result, {
        kind: "fallback",
        requested: "alpha/alpha-only",
        reason: "catalog-error",
      });
      assert.equal(warnings.length, 1);
      assert.match(firstWarning(warnings), /the model catalog could not be read/);
    });

    it("does not reinterpret an explicitly named provider's throwing catalog as a bare id", async () => {
      const calls: string[] = [];
      const catalog = standardCatalog(async (provider) => {
        calls.push(provider);
        if (provider === "alpha") throw new Error("alpha down");
        return BETA_MODELS;
      });

      const { result, warnings } = await resolve("alpha/alpha-only", {
        catalog,
      });
      assert.deepEqual(result, {
        kind: "fallback",
        requested: "alpha/alpha-only",
        reason: "catalog-error",
      });
      assert.deepEqual(calls, ["alpha"]);
      assert.equal(warnings.length, 1);
    });

    it("skips a throwing provider in the bare-id pass when another provider resolves", async () => {
      const catalog = standardCatalog(async (provider) => {
        if (provider === "alpha") throw new Error("alpha down");
        if (provider === "beta") return BETA_MODELS;
        return [];
      });

      const { result, warnings } = await resolve("beta-only", { catalog });
      assert.deepEqual(result, {
        kind: "resolved",
        route: { provider: "beta", model: "beta-only" },
      });
      assert.equal(warnings.length, 0);
    });

    it("falls back with catalog-unavailable when every provider read throws", async () => {
      const catalog = standardCatalog(async () => {
        throw new Error("all down");
      });

      const { result, warnings } = await resolve("alpha-only", { catalog });
      assert.deepEqual(result, {
        kind: "fallback",
        requested: "alpha-only",
        reason: "catalog-unavailable",
      });
      assert.equal(warnings.length, 1);
    });

    it("falls back with catalog-error when listProviders returns a non-array", async () => {
      const catalog = {
        listProviders: () => 42 as unknown as readonly CatalogModel[],
        listModels: async () => [],
      };

      const { result, warnings } = await resolve("alpha/alpha-only", {
        catalog,
      });
      assert.deepEqual(result, {
        kind: "fallback",
        requested: "alpha/alpha-only",
        reason: "catalog-error",
      });
      assert.equal(warnings.length, 1);
    });

    it("falls back with catalog-error when a provider id is not a string", async () => {
      const catalog: ModelCatalogLike = {
        listProviders: () => [{ id: 7 as unknown as string }],
        listModels: async () => [],
      };

      const { result, warnings } = await resolve("alpha/alpha-only", {
        catalog,
      });
      assert.deepEqual(result, {
        kind: "fallback",
        requested: "alpha/alpha-only",
        reason: "catalog-error",
      });
      assert.equal(warnings.length, 1);
    });

    it("falls back with catalog-error when an explicitly named provider's listModels returns a non-array", async () => {
      const catalog: ModelCatalogLike = {
        listProviders: () => [{ id: "alpha" }],
        listModels: async () =>
          ({ nope: true }) as unknown as readonly CatalogModel[],
      };

      const { result, warnings } = await resolve("alpha/alpha-only", {
        catalog,
      });
      assert.deepEqual(result, {
        kind: "fallback",
        requested: "alpha/alpha-only",
        reason: "catalog-error",
      });
      assert.equal(warnings.length, 1);
    });

    it("falls back with catalog-error when an explicitly named provider returns a non-string model id", async () => {
      const catalog = standardCatalog(async () => [
        { id: 9 as unknown as string },
      ]);

      const { result, warnings } = await resolve("alpha/alpha-only", {
        catalog,
      });
      assert.deepEqual(result, {
        kind: "fallback",
        requested: "alpha/alpha-only",
        reason: "catalog-error",
      });
      assert.equal(warnings.length, 1);
    });

    it("skips a provider whose model list has the wrong shape when another provider resolves", async () => {
      const catalog: ModelCatalogLike = {
        listProviders: () => [{ id: "alpha" }, { id: "beta" }],
        listModels: async (provider) =>
          provider === "alpha"
            ? ([{ id: 9 as unknown as string }] as readonly CatalogModel[])
            : BETA_MODELS,
      };

      const { result, warnings } = await resolve("beta-only", { catalog });
      assert.deepEqual(result, {
        kind: "resolved",
        route: { provider: "beta", model: "beta-only" },
      });
      assert.equal(warnings.length, 0);
    });

    it("reports catalog-error with the failed provider count when part of the catalog was unreadable", async () => {
      const catalog = standardCatalog(async (provider) => {
        if (provider === "alpha") throw new Error("alpha down");
        return BETA_MODELS;
      });

      const { result, warnings } = await resolve("alpha-only", { catalog });
      assert.deepEqual(result, {
        kind: "fallback",
        requested: "alpha-only",
        reason: "catalog-error",
        detail: "1 of 2 providers failed",
      });
      assert.equal(warnings.length, 1);
      assert.match(firstWarning(warnings), /1 of 2 providers failed/);
    });

    it("keeps unknown-model when every provider was readable", async () => {
      const { result, warnings } = await resolve("missing", {
        catalog: standardCatalog(),
      });
      assert.deepEqual(result, {
        kind: "fallback",
        requested: "missing",
        reason: "unknown-model",
      });
      assert.equal(warnings.length, 1);
    });
  });

  describe("warning text", () => {
    it("names the option, raw value, reason, session, and fallback for a leader", async () => {
      const { result, warnings } = await resolve("alpha/nope", {
        catalog: standardCatalog(),
        purpose: "leader",
        sessionId: "disp-1",
        fallbackDescription: SUMMONER_FALLBACK,
      });
      assert.equal(result.kind, "fallback");
      assert.deepEqual(warnings, [
        'model option "alpha/nope" from session disp-1 was ignored (unknown model); using the summoner\'s current route.',
      ]);
    });

    it("uses the worker_model label for a worker-default purpose", async () => {
      const { result, warnings } = await resolve("alpha/nope", {
        catalog: standardCatalog(),
        purpose: "worker-default",
        sessionId: "disp-2",
        fallbackDescription: WORKER_DEFAULT_FALLBACK,
      });
      assert.equal(result.kind, "fallback");
      assert.deepEqual(warnings, [
        'worker_model option "alpha/nope" from session disp-2 was ignored (unknown model); using the team leader\'s own route.',
      ]);
    });

    it("warns exactly once per rejected non-empty value", async () => {
      const { result, warnings } = await resolve("shared", {
        catalog: standardCatalog(),
      });
      assert.equal(result.kind, "fallback");
      assert.equal(warnings.length, 1);
    });

    it("strips control characters so a value cannot forge log lines", async () => {
      const { result, warnings } = await resolve("bad\nvalue\twith\rcontrols", {
        catalog: standardCatalog(),
      });
      assert.equal(result.kind, "fallback");
      const warning = firstWarning(warnings);
      assert.ok(!warning.includes("\n"));
      assert.ok(!warning.includes("\t"));
      assert.ok(!warning.includes("\r"));
      assert.ok(warning.includes('"bad value with controls"'));
    });

    it("sanitizes and truncates a 200-character value to 120 characters", async () => {
      const raw = "x".repeat(100) + "\n" + "y".repeat(99);
      assert.equal(raw.length, 200);

      const { result, warnings } = await resolve(raw, {
        catalog: standardCatalog(),
      });
      assert.equal(result.kind, "fallback");
      assert.equal(result.kind === "fallback" ? result.requested : "", raw);

      const warning = firstWarning(warnings);
      const quoted = /"([^"]*)"/.exec(warning);
      assert.ok(quoted !== null, "expected the value to be quoted in the warning");
      const value = quoted[1] ?? "";
      assert.equal(value.length, MODEL_OPTION_VALUE_MAX_CHARS);
      assert.equal(value, "x".repeat(100) + " " + "y".repeat(19));
      assert.ok(!value.includes("\n"));
      assert.ok(!value.includes("\t"));
      assert.ok(!warning.includes("\n"));
      assert.ok(!warning.includes("\t"));
    });

    it("never warns for a resolved value", async () => {
      const { result, warnings } = await resolve("alpha/alpha-only", {
        catalog: standardCatalog(),
      });
      assert.equal(result.kind, "resolved");
      assert.deepEqual(warnings, []);
    });
  });

  describe("shared display value", () => {
    it("sanitizes control characters and truncates to the display bound", () => {
      const raw = "x".repeat(100) + "\n" + "y".repeat(99);
      const display = sanitizeModelOptionValue(raw);
      assert.equal(display, "x".repeat(100) + " " + "y".repeat(19));
      assert.equal(
        Array.from(display).length,
        MODEL_OPTION_VALUE_MAX_CHARS,
      );
      assert.ok(!display.includes("\n"));
    });
  });
});
