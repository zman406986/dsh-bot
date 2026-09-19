/**
 * Adapter registration of the six dispatcher tools (design-16 §3.8; sixth
 * tool `send_peer` per ticket 70 §2).
 * ADR-0019: registration addresses a tool surface — the plugin passes the
 * ACTIVATED agent's own scoped `ctx.tools` (per-agent visibility: the model
 * only ever sees its own dispatcher's tools) or, when the agent carries no
 * scoped context, the plugin-level surface (documented fallback, the shipped
 * single-dispatcher shape). Handlers close over their own session id, so an
 * execution always routes to the session that registered the tool; there is
 * no execute-time gate — an out-of-scope caller cannot see the tool at all
 * (host `UNKNOWN_TOOL`).
 * Structural — no import of `@deepseek-ai/dsh-tools` (peer surface).
 * FakeDshHost / unit tests exercise core handlers without this module.
 */

import type { Multitask } from "../core/multitask.js";
import {
  createDispatcherTools,
  toToolParametersSchema,
  type DeliverToUserFn,
  type DispatcherToolDef,
  type RecentActivityFn,
} from "../core/tools.js";
import type { ToolsLike } from "./cordis-dsh-host.js";

/** Structural tool registration shape (mirrors dsh ToolRuntime.register). */
export interface RegisterableTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly output: {
    readonly schema: unknown;
    readonly render: (args: unknown, value: unknown) => Array<{
      readonly type: string;
      readonly text?: string;
    }>;
  };
  readonly execute: (args: unknown, exec?: unknown) => Promise<unknown>;
}

/** Render a structured tool result as a single model-facing text block. */
function renderStructured(_args: unknown, value: unknown): Array<{
  type: string;
  text?: string;
}> {
  if (value === null || value === undefined) {
    return [{ type: "text", text: "" }];
  }
  // Prefer the human summary / ack / note the formatters already produced.
  const record = value as Record<string, unknown>;
  if (typeof record.summary === "string") {
    return [{ type: "text", text: record.summary }];
  }
  if (typeof record.ack === "string") {
    return [{ type: "text", text: record.ack }];
  }
  if (typeof record.note === "string") {
    return [{ type: "text", text: record.note }];
  }
  if (typeof record.detail === "string" && record.ok === false) {
    return [{ type: "text", text: record.detail }];
  }
  if (typeof record.delivered === "boolean") {
    const todo =
      typeof record.todo_completed === "string" ? record.todo_completed : "none";
    return [
      {
        type: "text",
        text: record.delivered
          ? `Delivered to the user. Todo completed: ${todo}.`
          : `Not delivered.${typeof record.detail === "string" ? ` ${record.detail}` : ""}`,
      },
    ];
  }
  return [{ type: "text", text: JSON.stringify(value) }];
}

/**
 * Resolve the calling session id from common tool-exec shapes (structural
 * idiom, design-16 §3.8). Returns null when the exec carries no session.
 */
export function resolveExecSessionId(exec: unknown): string | null {
  const record = exec as {
    agent?: { session?: { id?: unknown } };
    session?: { id?: unknown };
    sessionId?: unknown;
  } | null | undefined;
  if (record == null || typeof record !== "object") return null;
  const raw =
    record.agent?.session?.id ??
    record.session?.id ??
    record.sessionId;
  if (raw === undefined || raw === null) return null;
  return String(raw);
}

/** Wrap a core tool def into a registry-ready structural definition. */
export function toRegisterableTool(
  def: DispatcherToolDef,
  executeOverride?: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>,
): RegisterableTool {
  return {
    name: def.name,
    description: def.description,
    // Serialize the authored node tree into provider-valid JSON Schema
    // (ticket 45): per-field required booleans become the parent object's
    // required array; the provider rejects boolean `required` outright.
    parameters: toToolParametersSchema(def.parameters),
    output: {
      // Loose schema: the registry validates shape; we return JSON objects.
      schema: { type: "object" },
      render: renderStructured,
    },
    execute(args: unknown, exec?: unknown): Promise<unknown> {
      const record =
        args !== null && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      if (executeOverride !== undefined) {
        return executeOverride(record, exec);
      }
      return def.execute(record);
    },
  };
}

export interface RegisterDispatcherToolsOptions {
  /**
   * The tool surface to register on: the activated agent's scoped
   * `agent.ctx.tools` (ADR-0019 per-agent visibility) or the plugin-level
   * `ctx.tools` (fallback). Only `tools` is read.
   */
  readonly ctx: {
    readonly tools?: ToolsLike;
  };
  readonly multitask: Multitask;
  /**
   * The dispatcher session this registration serves. Handlers route to it
   * unconditionally (ADR-0019: per-session routing replaced the execute-time
   * gate — visibility is the fence, not a refusal copy).
   */
  readonly getSessionId: () => string | null;
  readonly deliverToUser?: DeliverToUserFn;
  readonly recentActivity?: RecentActivityFn;
  /** Ticket 61: activity observation moments for the check-row liveness verdict. */
  readonly lastActivityAtMs?: (workerId: string) => number | null;
}

/**
 * Register the six dispatcher tools on the given surface. Returns disposers.
 * No-op (empty list) when `tools` or `register` is unavailable.
 */
export function registerDispatcherTools(
  options: RegisterDispatcherToolsOptions,
): Array<() => void> {
  const tools = options.ctx.tools;
  if (tools === undefined || typeof tools.register !== "function") {
    return [];
  }
  const defs = createDispatcherTools({
    multitask: options.multitask,
    getSessionId: options.getSessionId,
    ...(options.deliverToUser !== undefined
      ? { deliverToUser: options.deliverToUser }
      : {}),
    ...(options.recentActivity !== undefined
      ? { recentActivity: options.recentActivity }
      : {}),
    ...(options.lastActivityAtMs !== undefined
      ? { lastActivityAtMs: options.lastActivityAtMs }
      : {}),
  });
  const disposers: Array<() => void> = [];
  for (const def of defs) {
    const dispose = tools.register(toRegisterableTool(def));
    disposers.push(dispose);
  }
  return disposers;
}
