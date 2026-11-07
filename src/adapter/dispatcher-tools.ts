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
  ModelOptionPurpose,
  ModelOptionResolution,
} from "../core/types.js";
import { formatDeliverResultRecorded } from "../core/tool-results.js";
import {
  createDispatcherTools,
  toToolParametersSchema,
  type DeliverToUserFn,
  type DispatcherToolDef,
  type RecentActivityFn,
} from "../core/tools.js";
import type { ToolsLike } from "./cordis-dsh-host.js";
import type {
  DispatcherOrigin,
  PolicyLanguage,
} from "../core/policy/prompts.js";
import {
  AWAIT_AGENT_TOOL,
  CHECK_WORKERS_TOOL,
  DELIVER_RESULT_TOOL,
  MESSAGE_AGENT_TOOL,
  SEND_PEER_TOOL,
  SPAWN_DISPATCHER_TOOL,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
} from "../core/policy/prompts.js";

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

/** One display subject on the durable record. JSON-only (no prompt/report text). */
export interface ToolviewDisplaySubject {
  readonly kind: "worker" | "dispatcher" | "todo" | "agent";
  readonly id: string;
  readonly title?: string;
}

/** Narrow to a plain object record. */
function displayRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Non-empty string. */
function displayString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Build one JSON-serializable `display.subject` for a tool result.
 *
 * Only identity the multittask core already holds is read: a worker's title
 * and kind, a todo entry's title, or (for a dispatcher target) the title the
 * call itself carried. Never a prompt, a report, or transcript text.
 *
 * The client parser treats a missing projection as "old transcript" and
 * degrades to a short ref, so an absent answer is safe.
 */
export function projectDisplaySubject(
  toolName: string,
  args: unknown,
  value: unknown,
  multitask: Multitask,
): ToolviewDisplaySubject | null {
  const argRecord = displayRecord(args);
  const resultRecord = displayRecord(value);
  const workerSubject = (
    id: string | null,
    title?: string | null,
  ): ToolviewDisplaySubject | null => {
    if (id === null) return null;
    const workerTitle = multitask.getWorker(id)?.title ?? title ?? null;
    return withTitle("worker", id, workerTitle);
  };
  switch (toolName) {
    case SPAWN_WORKER_TOOL:
      return workerSubject(
        displayString(resultRecord?.worker_id),
        displayString(resultRecord?.title),
      );
    case CHECK_WORKERS_TOOL:
      return workerSubject(displayString(argRecord?.worker_id));
    case STEER_WORKER_TOOL:
    case STOP_WORKER_TOOL:
      return workerSubject(
        displayString(resultRecord?.worker_id) ??
          displayString(argRecord?.worker_id),
        displayString(resultRecord?.title),
      );
    case DELIVER_RESULT_TOOL: {
      const todoId =
        displayString(resultRecord?.todo_completed) ??
        displayString(argRecord?.todo_id);
      if (todoId === null) return null;
      const title = multitask.todos.get(todoId)?.title ?? null;
      return withTitle("todo", todoId, title);
    }
    case MESSAGE_AGENT_TOOL: {
      const target =
        displayString(resultRecord?.target) ??
        displayString(argRecord?.target);
      if (target === null) return null;
      const worker = multitask.getWorker(target);
      if (worker !== undefined) {
        return withTitle("worker", target, worker.title);
      }
      return withTitle(
        resultRecord?.delivered_as === "peer" ? "dispatcher" : "agent",
        target,
        displayString(resultRecord?.title),
      );
    }
    case AWAIT_AGENT_TOOL:
      return workerSubject(
        displayString(resultRecord?.target) ??
          displayString(argRecord?.target),
      );
    case SPAWN_DISPATCHER_TOOL: {
      const dispatcherId = displayString(resultRecord?.dispatcher_id);
      if (dispatcherId === null) return null;
      return withTitle(
        "dispatcher",
        dispatcherId,
        displayString(resultRecord?.title) ??
          displayString(argRecord?.title),
      );
    }
    case SEND_PEER_TOOL: {
      const target =
        displayString(resultRecord?.to_session) ??
        displayString(argRecord?.to_session);
      return target === null ? null : withTitle("dispatcher", target, null);
    }
    default:
      return null;
  }
}

/** Attach a title only when it is a non-empty string (JSON-serializable). */
function withTitle(
  kind: ToolviewDisplaySubject["kind"],
  id: string,
  title: string | null | undefined,
): ToolviewDisplaySubject {
  return typeof title === "string" && title.length > 0
    ? { kind, id, title }
    : { kind, id };
}

/**
 * Compose the prose-stripped meta with the optional `display` projection.
 * The projection is tiny (kind/id/title) and losslessly JSON-serializable,
 * so it survives the host's durable `tool/result` event unchanged.
 */
export function composePresentationMeta(
  args: unknown,
  value: unknown,
  display: ((args: unknown, value: unknown) => ToolviewDisplaySubject | null) | undefined,
): unknown {
  const meta = structuredPresentationMeta(args, value);
  if (display === undefined) return meta;
  if (
    meta === null ||
    typeof meta !== "object" ||
    Array.isArray(meta)
  ) {
    return meta;
  }
  let subject: ToolviewDisplaySubject | null;
  try {
    subject = display(args, value);
  } catch {
    // A projection failure must never break the tool result the model reads.
    return meta;
  }
  if (subject === null) return meta;
  return { ...(meta as Record<string, unknown>), display: { subject } };
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
  // `deliver_result` is checked before the generic failure-detail branch: its
  // honest no-delivery result carries both `ok: false` and a detail, and the
  // delivery-specific copy must win.
  if (typeof record.delivered === "boolean") {
    if (!record.delivered) {
      // A `delivered: false` result is always a refusal: the text did not
      // reach the user. The old `no-delivery-channel` prefix is kept for
      // historical rows; new results carry `reason: "send-failed"`.
      const prefix =
        record.reason === "no-delivery-channel"
          ? "Not delivered — recorded only for your reply."
          : "Not delivered to the user.";
      return [
        {
          type: "text",
          text: `${prefix}${typeof record.detail === "string" ? ` ${record.detail}` : ""}`,
        },
      ];
    }
    if (record.channel === "reply") {
      // Delivery is conversational (ADR-0009): the obligation is recorded and
      // the dispatcher's own reply is the channel. Never render this as
      // "Delivered to the user" — they have not read anything yet.
      return [
        {
          type: "text",
          text: formatDeliverResultRecorded({
            ...(typeof record.todo_completed === "string"
              ? { todoId: record.todo_completed }
              : {}),
            ...(typeof record.todo_title === "string"
              ? { todoTitle: record.todo_title }
              : {}),
            ...(typeof record.attachments_not_sent === "number"
              ? { attachmentsNotSent: record.attachments_not_sent }
              : {}),
          }),
        },
      ];
    }
    const todo =
      typeof record.todo_completed === "string" ? record.todo_completed : "none";
    return [
      {
        type: "text",
        text: `Delivered to the user. Todo completed: ${todo}.`,
      },
    ];
  }
  if (typeof record.detail === "string" && record.ok === false) {
    return [{ type: "text", text: record.detail }];
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
  display?: (args: unknown, value: unknown) => ToolviewDisplaySubject | null,
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
      // Readable-status display: the same record also carries the compact
      // `display.subject` (kind/id/title) when a projection is supplied.
      presentationMeta: (args: unknown, value: unknown): unknown =>
        composePresentationMeta(args, value, display),
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
  /**
   * Ticket 285 (PLAN §5, Task 6): the host's model-option resolver, forwarded
   * verbatim into `createDispatcherTools` for `spawn_dispatcher`'s optional
   * `model` / `worker_model` arguments. The LIVE call site (`src/plugin.ts`)
   * binds it to the activated session, so the resolver sees the spawning
   * dispatcher's catalog preference and session id.
   *
   * Optional here for the same reason `spawnDispatcher` is: a registration
   * without it is still valid while no model option is passed. A non-empty
   * value with no resolver is a wiring bug, and the core handler throws —
   * silently spawning on the default would hide which side dropped it.
   */
  readonly resolveModel?: (
    raw: string,
    purpose: ModelOptionPurpose,
  ) => Promise<ModelOptionResolution>;
  /**
   * Ticket 153: model-facing copy language. Omitted means EN, so every
   * pre-153 caller keeps byte-identical descriptions.
   */
  readonly language?: PolicyLanguage;
  /**
   * Ticket 176: which dispatcher CLASS this surface serves. `spawned` — a
   * team leader another dispatcher summoned — gets NO `spawn_dispatcher`
   * definition (owner ruling 2026-11-03). Omitted means `user`, so the
   * eight-tool surface is unchanged for every pre-176 caller.
   */
  readonly origin?: DispatcherOrigin;
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
    ...(options.resolveModel !== undefined
      ? { resolveModel: options.resolveModel }
      : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.origin !== undefined ? { origin: options.origin } : {}),
  });
  const disposers: Array<() => void> = [];
  for (const def of defs) {
    const dispose = tools.register(
      toRegisterableTool(def, undefined, (args, value) =>
        projectDisplaySubject(def.name, args, value, options.multitask),
      ),
    );
    disposers.push(dispose);
  }
  return disposers;
}
