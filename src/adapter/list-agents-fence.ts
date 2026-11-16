/**
 * Same-name `list_agents` fence (defense-in-depth for the legacy
 * parented-dispatcher shape).
 *
 * The stock `list_agents` tool is registered GLOBALLY by the host's
 * tool-subagent-control plugin. The host's layered registry lets a scoped
 * own-layer tool shadow a global one
 * (`dsh-tools/lib/index.js` `ToolsService.register`: "Scoped tools shadow
 * globals"), so a dispatcher's OWN scope can register a same-name wrapper and
 * its disposer restores the stock definition. Nothing global is replaced.
 *
 * Why: a summoned team leader is a TOP-LEVEL session (ADR-0032) and has no
 * catalog entry under its summoner, so `descendants` on a new-style tree
 * already ends at the caller. The legacy parented-dispatcher shape is not that
 * lucky — a dispatcher spawned as a subagent sits inside its parent's catalog
 * tree, and stock `list_agents({ scope: "descendants" })` would hand it the
 * whole branch below its summoner. This wrapper answers only the caller's
 * DIRECT children (`parentId === sessionId && depth === 1`) for `descendants`
 * and leaves `children` untouched.
 *
 * Stock fidelity is the contract: same name, same description bytes, the same
 * compiled parameter shape, the same output schema, the same render text, and
 * no `presentationMeta`. The helper is structural — it imports neither the
 * host package nor its tool runtime.
 */

import { toToolParametersSchema } from "../core/tools.js";
import type { SubagentListEntryLike } from "./cordis-dsh-host.js";

/** The stock global tool's name; the shadow must match it exactly. */
export const LIST_AGENTS_TOOL_NAME = "list_agents";

/**
 * Stock description, verbatim (`dsh-tool-subagent-control/lib/index.js`).
 * A changed byte here would change the model-facing surface, so it is a
 * constant rather than prose written twice.
 */
export const LIST_AGENTS_DESCRIPTION =
  "List subagents you started, with their ids, labels, and status. running means it is working; inactive means it is not currently working. You will be notified when a subagent finishes; there is no need to keep checking its status. Use send_message to continue the conversation.";

/** Stock `scope` parameter description, verbatim. */
export const LIST_AGENTS_SCOPE_DESCRIPTION =
  "children (default) lists direct children, which accept send_message in any status. descendants lists the whole tree below you with each entry's parent session id and depth; entries deeper than 1 accept only interrupt_agent.";

/** Stock render text for a listing with no rows. */
export const LIST_AGENTS_EMPTY_TEXT = "(no subagents)";

/** One projected row, exactly as the stock tool serializes it. */
export type ListAgentsProjectedEntry =
  | {
      readonly kind: "child";
      readonly id: string;
      readonly label: string | undefined;
      readonly status: "running" | "inactive";
      readonly parent?: string;
      readonly depth?: number;
    }
  | {
      readonly kind: "diagnostic";
      readonly id: string;
      readonly reason: string | undefined;
      readonly parent?: string;
      readonly depth?: number;
    };

/**
 * The scoped surface this helper registers on. Structural `ToolsLike`: the
 * helper only reads `schemas(scope)` (to prove the stock name is visible) and
 * calls `register(def)`.
 */
export interface ListAgentsFenceToolSurface {
  schemas(scope?: unknown): ReadonlyArray<{ readonly name: string }>;
  register(definition: unknown): () => void;
}

/** One live-agent view: only the turn status the stock statusOf reads. */
export interface ListAgentsFenceAgentStatus {
  readonly status?: string;
}

export interface ListAgentsFenceOptions {
  /** The activated dispatcher's own scoped tool surface. */
  readonly tools: ListAgentsFenceToolSurface;
  /** The agent whose scope is read by `tools.schemas(scope)`. */
  readonly scope: unknown;
  /** The dispatcher session id; the caller whose children are listed. */
  readonly sessionId: string;
  /** Live agent registry (`ctx.agents`). */
  readonly agents: {
    get(id: unknown): ListAgentsFenceAgentStatus | undefined;
  };
  /** Host seam `ctx.subagents.listChildren`, bound to its service. */
  readonly listChildren?: (
    parentSessionId: string,
    signal?: AbortSignal,
  ) => Promise<readonly SubagentListEntryLike[]>;
  /** Host seam `ctx.subagents.listDescendants`, bound to its service. */
  readonly listDescendants?: (
    rootSessionId: string,
    signal?: AbortSignal,
  ) => Promise<readonly SubagentListEntryLike[]>;
}

/** The stock output schema, projected into the raw supported JSON-Schema subset. */
function stockOutputSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["child"] },
            id: { type: "string" },
            label: { type: "string" },
            status: { type: "string", enum: ["running", "inactive"] },
            parent: { type: "string" },
            depth: { type: "number" },
          },
          required: ["kind", "id", "label", "status"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["diagnostic"] },
            id: { type: "string" },
            reason: {
              type: "string",
              enum: ["corrupt", "unsupported", "unavailable"],
            },
            parent: { type: "string" },
            depth: { type: "number" },
          },
          required: ["kind", "id", "reason"],
        },
      ],
    },
  };
}

/** The stock parameter schema, compiled provider-valid by the shared helper. */
function stockParameters(): unknown {
  return toToolParametersSchema({
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["children", "descendants"],
        description: LIST_AGENTS_SCOPE_DESCRIPTION,
      },
    },
  });
}

/** Resolve the requested scope for RENDER only (stock defaults to children). */
function renderScopeOf(args: unknown): "children" | "descendants" {
  if (args !== null && typeof args === "object") {
    if ((args as { readonly scope?: unknown }).scope === "descendants") {
      return "descendants";
    }
  }
  return "children";
}

/** The dispatched turn's cancellation signal, when the host supplied one. */
function execSignalOf(exec: unknown): AbortSignal | undefined {
  if (exec === null || typeof exec !== "object") return undefined;
  return (exec as { readonly signal?: AbortSignal }).signal;
}

/**
 * Install the same-name `list_agents` shadow on ONE dispatcher's scoped
 * surface.
 *
 * The gate is the whole safety property: a surface that cannot be read, does
 * not show stock `list_agents`, or lacks either host listing seam returns
 * `null` and nothing is registered. Never register a tool whose `execute`
 * would throw on a host that cannot answer.
 *
 * @returns the exact disposer (restores the stock definition), or `null`
 * when the surface does not qualify.
 */
export function registerListAgentsFence(
  options: ListAgentsFenceOptions,
): (() => void) | null {
  const { tools, agents, sessionId } = options;
  const listChildren = options.listChildren;
  const listDescendants = options.listDescendants;

  // A surface you cannot read is not proof the stock tool is visible.
  let stockVisible = false;
  try {
    stockVisible = tools
      .schemas(options.scope)
      .some((schema) => schema.name === LIST_AGENTS_TOOL_NAME);
  } catch {
    return null;
  }
  if (!stockVisible) return null;
  // Without both seams the wrapper could not answer either scope.
  if (typeof listChildren !== "function") return null;
  if (typeof listDescendants !== "function") return null;

  /** Stock `statusOf`: turn activity only, never whether the child is loaded. */
  const statusOf = (id: string): "running" | "inactive" =>
    agents.get(id)?.status === "running" ? "running" : "inactive";

  /** The descendant-only position prefix; children carry no position. */
  const positionOf = (
    entry: SubagentListEntryLike,
  ): { parent?: string; depth?: number } => ({
    ...(entry.parentId === undefined ? {} : { parent: entry.parentId }),
    ...(entry.depth === undefined ? {} : { depth: entry.depth }),
  });

  /**
   * Stock `project`: diagnostic first (its kind/id/reason), then drop any
   * non-continuable entry, then the continuable child with its live status.
   * `position` is supplied ONLY for the descendants scope.
   */
  const project = (
    entry: SubagentListEntryLike,
    position?: SubagentListEntryLike,
  ): ListAgentsProjectedEntry | undefined => {
    const at = position === undefined ? {} : positionOf(position);
    if (entry.kind === "diagnostic") {
      return {
        kind: "diagnostic",
        id: entry.id,
        reason: entry.reason,
        ...at,
      };
    }
    if (entry.mode !== "continuable") return undefined;
    return {
      kind: "child",
      id: entry.id,
      label: entry.label,
      status: statusOf(entry.id),
      ...at,
    };
  };

  return tools.register({
    name: LIST_AGENTS_TOOL_NAME,
    description: LIST_AGENTS_DESCRIPTION,
    parameters: stockParameters(),
    output: {
      schema: stockOutputSchema(),
      render(args: unknown, value: unknown): Array<{ type: string; text: string }> {
        const scope = renderScopeOf(args);
        const entries: readonly ListAgentsProjectedEntry[] = Array.isArray(value)
          ? (value as readonly ListAgentsProjectedEntry[])
          : [];
        if (entries.length === 0) {
          return [{ type: "text", text: LIST_AGENTS_EMPTY_TEXT }];
        }
        const lines = entries.map((entry) => {
          const at =
            scope === "descendants"
              ? ` parent=${String(entry.parent)} depth=${String(entry.depth)}`
              : "";
          return entry.kind === "child"
            ? `${entry.id} [${entry.status}]${at} — ${entry.label}`
            : `${entry.id} [diagnostic: ${entry.reason}]${at}`;
        });
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args: unknown, exec?: unknown): Promise<unknown> {
      const record =
        args !== null && typeof args === "object"
          ? (args as { readonly scope?: unknown })
          : {};
      const scope = record.scope ?? "children";
      if (scope !== "children" && scope !== "descendants") {
        throw new Error(
          `list_agents received unsupported scope ${JSON.stringify(scope)}; expected "children" or "descendants"`,
        );
      }
      const signal = execSignalOf(exec);
      if (scope === "children") {
        const entries = await listChildren(sessionId, signal);
        return entries
          .map((entry) => project(entry))
          .filter(
            (entry): entry is ListAgentsProjectedEntry => entry !== undefined,
          );
      }
      const entries = await listDescendants(sessionId, signal);
      return entries
        // The fence: only the caller's DIRECT children survive. Stock would
        // return every branch below the root.
        .filter(
          (entry) => entry.parentId === sessionId && entry.depth === 1,
        )
        .map((entry) => project(entry, entry))
        .filter(
          (entry): entry is ListAgentsProjectedEntry => entry !== undefined,
        );
    },
  });
}
