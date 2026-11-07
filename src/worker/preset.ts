import { buildWorkerSystemPrompt } from "./prompt.js";
import { buildWorkerToolFilter } from "./tool-barrier.js";
import type { WorkerAgentDef } from "./agent-def.js";

/**
 * Route-independent worker composition.
 *
 * 0.2.1 removed per-spawn `persona` and `toolFilter`, and a named Agent Preset
 * would require a registry row that only one of our two boot routes loads.
 * Instead the composition is registered on the child's OWN scoped context
 * after the host created it (`agent/created`), which is where a preset's rows
 * would land anyway:
 *
 * - the contract registers as a scoped `deployment:persona-prefix` section,
 *   shadowing the deployment persona for that agent only and recomputed every
 *   turn, so compaction cannot drop it;
 * - the barrier restricts the scope's inherited global tools. The deny list is
 *   the candidate set intersected with live global names, because
 *   `tools.restrict()` throws on a name it does not know.
 *
 * Both registrations are effects on the child's scope: the agent's disposal
 * lifts them, so nothing has to be tracked here.
 */

/** Section name the deployment persona uses; a scoped one shadows it. */
export const WORKER_PERSONA_SECTION = "deployment:persona-prefix";

/** Section-placement name to look up in the host's section-order table. */
export const WORKER_PERSONA_SECTION_ORDER = "DEPLOYMENT_PERSONA_PREFIX";

/** Scoped context surface the composition needs. */
export interface WorkerCompositionContext {
  systemPrompt?: {
    section(section: {
      readonly name: string;
      readonly order: number;
      readonly text: string;
      readonly interpolate?: boolean;
    }): () => void;
    getSectionOrder(name: string): number;
  };
  tools?: {
    schemas(scope?: unknown): ReadonlyArray<{ readonly name: string }>;
    restrict(filter: {
      readonly allow?: readonly string[];
      readonly deny?: readonly string[];
    }): () => void;
    /**
     * Scoped registration on THIS child's surface (ticket 122). The child's
     * own scope holds only its tools, so a worker-local tool registered here
     * never appears on the dispatcher's surface.
     */
    register?(definition: unknown): () => void;
  };
}

/**
 * Live tool names visible to one scope (empty when unavailable).
 *
 * The scope argument is load-bearing: `tools.schemas()` with no scope answers
 * for the CONTEXT-GLOBAL layer only, which on 0.2.1 is two bookkeeping tools,
 * while a preset's model-facing tools live on the agent plane. Passing the
 * child agent reads the surface it actually inherits. Restriction names are
 * validated against that same set, so an unscoped read would deny nothing.
 *
 * This helper deliberately degrades to an empty set: it is a read-only
 * convenience. The SPAWN path uses {@link readScopedToolNames}, which keeps
 * the failure mode distinguishable so an unreadable surface can fail closed.
 */
export function globalToolNames(
  ctx: WorkerCompositionContext,
  scope?: unknown,
): ReadonlySet<string> {
  try {
    return new Set((ctx.tools?.schemas(scope) ?? []).map((schema) => schema.name));
  } catch {
    return new Set();
  }
}

type ScopedToolsRead =
  | { readonly ok: true; readonly names: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: "unavailable" | "threw" | "empty" };

/**
 * Strict read of the scoped tool set. Unlike {@link globalToolNames}, an
 * absent surface, a throwing `schemas()`, or an empty answer is reported as a
 * failure instead of silently becoming "nothing to deny".
 */
function readScopedToolNames(
  ctx: WorkerCompositionContext,
  scope: unknown,
): ScopedToolsRead {
  const tools = ctx.tools;
  if (tools === undefined) return { ok: false, reason: "unavailable" };
  let schemas: ReadonlyArray<{ readonly name: string }>;
  try {
    schemas = tools.schemas(scope);
  } catch {
    return { ok: false, reason: "threw" };
  }
  if (!Array.isArray(schemas) || schemas.length === 0) {
    return { ok: false, reason: "empty" };
  }
  const names = new Set<string>();
  for (const schema of schemas) {
    if (schema !== null && typeof schema === "object" && typeof schema.name === "string") {
      names.add(schema.name);
    }
  }
  return names.size > 0
    ? { ok: true, names }
    : { ok: false, reason: "empty" };
}

/** The failure text for an unreadable scoped surface. */
function unreadableSurfaceError(
  reason: "unavailable" | "threw" | "empty",
): Error {
  if (reason === "threw") {
    return new Error(
      "worker composition: tools.schemas() failed; refusing to spawn a worker without the tool barrier",
    );
  }
  if (reason === "unavailable") {
    return new Error(
      "worker composition: the context exposes no scoped tools surface; refusing to spawn an unrestricted worker",
    );
  }
  return new Error(
    "worker composition: the scoped tool set is empty; refusing to spawn a worker whose barrier cannot be applied",
  );
}

/**
 * Register the worker contract and tool barrier on one child's scoped context.
 * `scope` must be the child agent itself, for the reason on `globalToolNames`.
 * Returns the number of registrations made.
 *
 * FAIL-CLOSED (second-round audit): the old code intersected the deny
 * candidates with `schemas()`, and a throwing/empty read produced an EMPTY
 * deny list — `restrict` was then skipped and the worker kept the dispatcher
 * surface. Now an unreadable surface, an empty surface on a context that CAN
 * restrict, or a deny list that would deny nothing throws, so the spawn fails
 * instead of shipping an unrestricted worker.
 *
 * Stub-host carve-out: a context that exposes `schemas()` but NO `restrict()`
 * cannot enforce a barrier at all (the live dsh host always has one). Those
 * minimal test stubs keep the historical "nothing to apply" behavior rather
 * than failing a host that has no restriction capability to apply; the real
 * defect (a host that CAN restrict while the read yields nothing) throws.
 */
export function applyWorkerComposition(
  ctx: WorkerCompositionContext,
  def: WorkerAgentDef,
  scope?: unknown,
  workerTools?: readonly unknown[],
): number {
  let applied = 0;
  const prompt = ctx.systemPrompt;
  if (prompt !== undefined) {
    prompt.section({
      name: WORKER_PERSONA_SECTION,
      order: prompt.getSectionOrder(WORKER_PERSONA_SECTION_ORDER),
      text: def.persona,
      // The contract is literal prose, not a `{{variable}}` template.
      interpolate: false,
    });
    applied += 1;
  }
  const tools = ctx.tools;
  if (tools === undefined) {
    throw unreadableSurfaceError("unavailable");
  }
  const read = readScopedToolNames(ctx, scope);
  if (!read.ok) {
    if (read.reason === "empty" && typeof tools.restrict !== "function") {
      // No restriction capability to apply on this context (a minimal stub).
      // Nothing is silently half-applied: there is no barrier seam at all.
    } else {
      throw unreadableSurfaceError(read.reason);
    }
  } else {
    const deny = def.resolveToolFilter(read.names).deny;
    if (deny.length === 0) {
      throw new Error(
        "worker composition: no denied verb is present on the scoped tool surface; refusing to spawn without a tool barrier",
      );
    }
    if (typeof tools.restrict !== "function") {
      throw new Error(
        "worker composition: tools.restrict() is unavailable; refusing to spawn a worker without the tool barrier",
      );
    }
    tools.restrict({ deny });
    applied += 1;
  }
  // Worker-local tools land on the child's scope only, so the dispatcher's
  // surface never lists them (ticket 122).
  if (tools.register !== undefined) {
    for (const definition of workerTools ?? []) {
      tools.register(definition);
      applied += 1;
    }
  }
  return applied;
}
