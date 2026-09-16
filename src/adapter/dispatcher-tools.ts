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

/** Wrap a core tool def into a registry-ready structural definition. */
export function toRegisterableTool(def: DispatcherToolDef): RegisterableTool {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      // Loose schema: the registry validates shape; we return JSON objects.
      schema: { type: "object" },
      render: renderStructured,
    },
    execute(args: unknown): Promise<unknown> {
      const record =
        args !== null && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      return def.execute(record);
    },
  };
}

export interface RegisterDispatcherToolsOptions {
  readonly ctx: AdapterContext;
  readonly multitask: Multitask;
  readonly getSessionId: () => string | null;
  readonly deliverToUser?: DeliverToUserFn;
  readonly recentActivity?: RecentActivityFn;
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
  const disposers: Array<() => void> = [];
  for (const def of defs) {
    const dispose = tools.register(toRegisterableTool(def));
    disposers.push(dispose);
  }
  return disposers;
}
