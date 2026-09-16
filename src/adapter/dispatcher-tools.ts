/**
 * Adapter registration of the five dispatcher tools on `ctx.tools`.
 * Structural — no import of `@deepseek-ai/dsh-tools` (peer surface).
 * FakeDshHost / unit tests exercise core handlers without this module.
 */

import type { Multitask } from "../core/multitask.js";
import {
  createDispatcherTools,
  type DeliverToUserFn,
  type DispatcherToolDef,
  type RecentActivityFn,
} from "../core/tools.js";
import type { AdapterContext } from "./cordis-dsh-host.js";
import { DISPATCHER_TOOL_GATE_REFUSAL } from "./activation-command.js";

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
    parameters: def.parameters,
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

/**
 * Structured refusal for a session that is not the activated dispatcher
 * (ticket 19). Renders as model-facing text via the shared formatter.
 */
function toolGateRefusal(): unknown {
  return { ok: false, reason: "not-activated", detail: DISPATCHER_TOOL_GATE_REFUSAL };
}

/**
 * Activation gate (design-16 §3.8, primary): resolve the calling session
 * from the exec shape and refuse anything that is not the activated
 * dispatcher chat. When the exec shape cannot be resolved, fall back to the
 * weaker "an activation exists" gate and document it — a shaped but
 * different session id still refuses, so the gate only opens for callers
 * we cannot see at all.
 */
function gatedExecute(
  def: DispatcherToolDef,
  getSessionId: () => string | null,
  resolveCallerSessionId: (exec: unknown) => string | null,
): (args: unknown, exec?: unknown) => Promise<unknown> {
  return async (args: unknown, exec?: unknown) => {
    const record =
      args !== null && typeof args === "object"
        ? (args as Record<string, unknown>)
        : {};
    const active = getSessionId();
    const caller = resolveCallerSessionId(exec);
    if (caller !== null) {
      if (caller === active) return def.execute(record);
      return toolGateRefusal();
    }
    // Unresolvable exec → weaker documented guarantee (ticket 19).
    if (active !== null) return def.execute(record);
    return toolGateRefusal();
  };
}

export interface RegisterDispatcherToolsOptions {
  readonly ctx: AdapterContext;
  readonly multitask: Multitask;
  readonly getSessionId: () => string | null;
  readonly deliverToUser?: DeliverToUserFn;
  readonly recentActivity?: RecentActivityFn;
  /**
   * Activation gate (ticket 19): resolve the calling session from the tool
   * exec context. When provided, every handler refuses sessions other than
   * the activated dispatcher chat with structured copy.
   */
  readonly resolveCallerSessionId?: (exec: unknown) => string | null;
}

/**
 * Register the five dispatcher tools. Returns disposers.
 * No-op (empty list) when `ctx.tools` or `register` is unavailable.
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
  });
  const resolve = options.resolveCallerSessionId;
  const disposers: Array<() => void> = [];
  for (const def of defs) {
    const registerable = toRegisterableTool(
      def,
      resolve !== undefined
        ? gatedExecute(def, options.getSessionId, resolve)
        : undefined,
    );
    const dispose = tools.register(registerable);
    disposers.push(dispose);
  }
  return disposers;
}
