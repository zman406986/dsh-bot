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

/**
 * Register the worker contract and tool barrier on one child's scoped context.
 * `scope` must be the child agent itself, for the reason on `globalToolNames`.
 * Returns the number of registrations made: 0 when the context exposes
 * neither surface (a stub host), so callers never treat absence as success.
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
  if (tools !== undefined) {
    const known = globalToolNames(ctx, scope);
    const deny = def.resolveToolFilter(known).deny;
    // `tools.restrict({})` is a no-op that throws; an empty deny needs none.
    if (deny.length > 0) {
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
  }
  return applied;
}
