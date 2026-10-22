/**
 * Adapter registration of the dispatcher tools (design-16 §3.8; the
 * eight-tool shape after ticket 116 retired `send_peer` in favour of
 * `message_agent`, ticket 117 added `await_agent`, and ticket 118 added
 * `spawn_dispatcher` — every one of them flows through this same path and
 * needs no per-tool wiring, the shared `presentationMeta` projection already
 * covers them).
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
import type {
  DispatcherSpawnOptions,
  DispatcherSpawnResult,
} from "../core/types.js";
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
    /**
     * Ticket 81 (live-pass 5 Session B-2 FINDING 2): the durable
     * `tool/result` session event carries the tool's RENDERED text blocks
     * (`render`) plus this OPTIONAL presentation projection — the structured
     * `value` itself is never serialized into the event
     * (`dsh-agent-loop/lib/index.js:697-712` `appendToolResult` spreads only
     * `result.meta`; `dsh-tools/lib/index.js:3428` builds it from
     * `output.presentationMeta` when the executing context is a top-level
     * call). The client's conversation reduction reads `data.meta` FIRST
     * (`conversation-store.ts` `toolResultRecord`) — without this callback
     * the durable record carries only the prose ack, so the worker-dispatch
     * card and the toolview parsers degrade to nothing live even though the
     * offline fixtures (which inlined the structured result as JSON text)
     * passed. Must be losslessly JSON-serializable (the host snapshots it).
     */
    readonly presentationMeta?: (args: unknown, value: unknown) => unknown;
  };
  readonly execute: (args: unknown, exec?: unknown) => Promise<unknown>;
}

/**
 * The presentation projection attached to every registered dispatcher tool
 * (ticket 81 FINDING 2): the structured result minus the model-facing prose
 * fields. `ack` embeds the entire worker prompt and `summary` embeds the
 * rendered roster table — both already durable in the tool/call arguments or
 * derivable from `rows`, so the meta record stays compact; `note` likewise.
 * A non-record value passes through unchanged (the host rejects an undefined
 * projection outright, so there is no "absent" answer here).
 */
export function structuredPresentationMeta(
  _args: unknown,
  value: unknown,
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = { ...(value as Record<string, unknown>) };
  delete record.ack;
  delete record.summary;
  delete record.note;
  return record;
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
      // Ticket 81 FINDING 2: the structured result rides the durable record
      // as `meta` (the reducer's preferred input); see RegisterableTool.
      presentationMeta: structuredPresentationMeta,
    },
    execute(args: unknown, exec?: unknown): Promise<unknown> {
      const record =
        args !== null && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      if (executeOverride !== undefined) {
        return executeOverride(record, exec);
      }
      // Ticket 117: the host invokes a registered tool as
      // `tool.execute(exec.arguments, exec)` (`dsh-tools/lib/index.js:3406`,
      // `dispatchToolBody`), where `exec.signal` is the turn's fused
      // cancellation signal. The default path MUST forward that second
      // argument: `await_agent` reads it via `readExecSignal` to release its
      // wait on a stopped turn, and `spawn_dispatcher` forwards it into the
      // host spawn. Every other handler ignores the parameter, so forwarding
      // is inert for them.
      return def.execute(record, exec);
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
  /**
   * Ticket 118 (chunk 2, seam only): the host's dispatcher-spawn port,
   * forwarded verbatim into `createDispatcherTools` for `spawn_dispatcher`.
   *
   * Wiring status: the LIVE call site (`src/plugin.ts`, chunk 3's file) must
   * pass `(opts) => host.spawnDispatcher(opts)`. Until it does, the tool is
   * still registered but throws on execute rather than reporting a host
   * refusal that never happened — a missing seam is a wiring bug, never a
   * spawn refusal.
   */
  readonly spawnDispatcher?: (
    opts: DispatcherSpawnOptions,
  ) => Promise<DispatcherSpawnResult>;
}

/**
 * Register the dispatcher tools on the given surface. Returns disposers.
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
    ...(options.spawnDispatcher !== undefined
      ? { spawnDispatcher: options.spawnDispatcher }
      : {}),
  });
  const disposers: Array<() => void> = [];
  for (const def of defs) {
    const dispose = tools.register(toRegisterableTool(def));
    disposers.push(dispose);
  }
  return disposers;
}
