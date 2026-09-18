/**
 * Dispatcher tool surface: five dsh-native tools mapped 1:1 onto
 * existing Multitask methods (and an injectable user-send for deliver).
 * Handlers stay core-side; the adapter registers them on ctx.tools.
 * FakeDshHost stays green — handlers only call existing core methods.
 */

import type { Multitask } from "./multitask.js";
import {
  assembleTurnReminder,
} from "./policy/assembler.js";
import {
  CHECK_WORKERS_TOOL,
  DELIVER_RESULT_TOOL,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
  TOOL_DESCRIPTIONS,
} from "./policy/prompts.js";
import {
  formatCheckSummary,
  formatSpawnAck,
  formatSteerNote,
  formatStopNote,
  toCheckRow,
  type CheckWorkersToolResult,
  type DeliverResultToolResult,
  type SpawnWorkerToolResult,
  type SteerWorkerToolResult,
  type StopWorkerToolResult,
  type WorkerCheckRow,
} from "./tool-results.js";

/** Structural JSON-Schema-ish parameter node (host-agnostic). */
export interface ToolParameterNode {
  readonly type: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly enum?: readonly string[];
  readonly items?: ToolParameterNode;
  readonly properties?: Readonly<Record<string, ToolParameterNode>>;
  readonly additionalProperties?: boolean;
}

/** One dispatcher tool: name, description, parameters, handler. */
export interface DispatcherToolDef {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterNode;
  readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Serialize a ToolParameterNode tree into a provider-valid JSON Schema
 * (ticket 45). Authoring keeps the ergonomic per-field `required` boolean;
 * at the serialization boundary it becomes the PARENT object's
 * `required: ["field", ...]` array. A boolean `required` inside a property
 * schema is invalid JSON Schema and the provider's strict function-schema
 * validator rejects the whole request ("false is not of type \"array\""),
 * so `required` never appears on a property node. Optional (or absent)
 * flags are equivalent to being absent from the array; an object with no
 * mandatory fields emits no `required` key at all.
 */
export function toToolParametersSchema(
  node: ToolParameterNode,
): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: node.type };
  if (node.description !== undefined) {
    schema.description = node.description;
  }
  if (node.enum !== undefined) {
    schema.enum = [...node.enum];
  }
  if (node.additionalProperties !== undefined) {
    schema.additionalProperties = node.additionalProperties;
  }
  if (node.items !== undefined) {
    schema.items = toToolParametersSchema(node.items);
  }
  if (node.properties !== undefined) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, child] of Object.entries(node.properties)) {
      properties[name] = toToolParametersSchema(child);
      if (child.required === true) required.push(name);
    }
    schema.properties = properties;
    if (required.length > 0) schema.required = required;
  }
  return schema;
}

/** Optional user-facing send used by deliver_result (wake turns). */
export type DeliverToUserFn = (
  text: string,
  attachmentPaths?: readonly string[],
) => Promise<boolean>;

/** Optional live activity line for one worker (host jobs / step). */
export type RecentActivityFn = (workerId: string) => string | null;

export interface DispatcherToolDeps {
  readonly multitask: Multitask;
  /** Dispatcher parent session id. */
  readonly getSessionId: () => string | null;
  /**
   * User-facing send. When omitted, deliver_result still marks the todo
   * delivered and returns ok — the wake turn itself is already user-visible
   * via the host followup path.
   */
  readonly deliverToUser?: DeliverToUserFn;
  /** Optional recent-activity resolver for check rows. */
  readonly recentActivity?: RecentActivityFn;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string when provided`);
  }
  return value;
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array of strings when provided`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${key}[${index}] must be a string`);
    }
    return item;
  });
}

const STREAM_KEY_PARAM: ToolParameterNode = {
  type: "string",
  required: true,
  description:
    "Stable id for the logical stream. One live worker per key. Reuse the todo id when a todo exists.",
};

const TITLE_PARAM: ToolParameterNode = {
  type: "string",
  required: true,
  description: "Short human title (3–8 words). Shown on wake and in check.",
};

const PROMPT_PARAM: ToolParameterNode = {
  type: "string",
  required: true,
  description:
    "Self-contained work instruction: goal, constraints, relevant context, success criteria, report format. The worker does not see this chat.",
};

const WORKER_ID_PARAM: ToolParameterNode = {
  type: "string",
  required: true,
  description: "Target worker id.",
};

/**
 * Create the five dispatcher tool definitions bound to a Multitask core.
 * Pure enough for unit tests: no ctx, no host types.
 */
export function createDispatcherTools(
  deps: DispatcherToolDeps,
): DispatcherToolDef[] {
  const { multitask, getSessionId } = deps;

  function requireSessionId(): string {
    const sessionId = getSessionId();
    if (sessionId === null) {
      throw new Error("no dispatcher session bound");
    }
    return sessionId;
  }

  const spawnWorker: DispatcherToolDef = {
    name: SPAWN_WORKER_TOOL,
    description: TOOL_DESCRIPTIONS[SPAWN_WORKER_TOOL],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        stream_key: STREAM_KEY_PARAM,
        title: TITLE_PARAM,
        prompt: PROMPT_PARAM,
        todo_id: {
          type: "string",
          required: false,
          description:
            "Links the worker to a ledger entry. Prefer always setting it.",
        },
      },
    },
    async execute(args): Promise<SpawnWorkerToolResult> {
      const parentSessionId = requireSessionId();
      const streamKey = requireString(args, "stream_key");
      const title = requireString(args, "title");
      const prompt = requireString(args, "prompt");
      const todoId = optionalString(args, "todo_id");

      const request = {
        parentSessionId,
        streamKey,
        title,
        prompt,
        ...(todoId !== undefined ? { todoId } : {}),
      };
      const result = await multitask.spawnWorker(request);
      if (!result.ok) {
        return {
          ok: false,
          reason: "duplicate-stream-key",
          detail: result.detail,
        };
      }
      return {
        ok: true,
        worker_id: result.workerId,
        stream_key: streamKey,
        title,
        ack: formatSpawnAck({
          title,
          workerId: result.workerId,
          streamKey,
          prompt,
        }),
      };
    },
  };

  const checkWorkers: DispatcherToolDef = {
    name: CHECK_WORKERS_TOOL,
    description: TOOL_DESCRIPTIONS[CHECK_WORKERS_TOOL],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        worker_id: {
          type: "string",
          required: false,
          description:
            "When set, return one worker; when omitted, return the roster.",
        },
      },
    },
    async execute(args): Promise<CheckWorkersToolResult> {
      const parentSessionId = requireSessionId();
      const workerId = optionalString(args, "worker_id");
      const activity = deps.recentActivity;

      if (workerId !== undefined) {
        const record = multitask.getWorker(workerId);
        if (
          record === undefined ||
          record.parentSessionId !== parentSessionId
        ) {
          return {
            ok: false,
            reason: "unknown-worker",
            detail: `unknown worker: ${workerId}`,
          };
        }
        const summaries = multitask.listWorkers(parentSessionId);
        const summary = summaries.find((row) => row.workerId === workerId);
        if (summary === undefined) {
          return {
            ok: false,
            reason: "unknown-worker",
            detail: `unknown worker: ${workerId}`,
          };
        }
        const row = toCheckRow(
          summary,
          activity?.(workerId) ?? null,
        );
        return {
          ok: true,
          rows: [row],
          summary: formatCheckSummary([row]),
        };
      }

      const summaries = multitask.listWorkers(parentSessionId);
      const rows: WorkerCheckRow[] = summaries.map((summary) =>
        toCheckRow(summary, activity?.(summary.workerId) ?? null),
      );
      return {
        ok: true,
        rows,
        summary: formatCheckSummary(rows),
      };
    },
  };

  const steerWorker: DispatcherToolDef = {
    name: STEER_WORKER_TOOL,
    description: TOOL_DESCRIPTIONS[STEER_WORKER_TOOL],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        worker_id: WORKER_ID_PARAM,
        message: {
          type: "string",
          required: true,
          description: "The correction itself, not a meta-sentence.",
        },
      },
    },
    async execute(args): Promise<SteerWorkerToolResult> {
      const workerId = requireString(args, "worker_id");
      const message = requireString(args, "message");
      const result = await multitask.steerWorker(workerId, message);
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason,
          detail: result.detail,
        };
      }
      const title = multitask.getWorker(workerId)?.title ?? workerId;
      return { ok: true, note: formatSteerNote(title) };
    },
  };

  const stopWorker: DispatcherToolDef = {
    name: STOP_WORKER_TOOL,
    description: TOOL_DESCRIPTIONS[STOP_WORKER_TOOL],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        worker_id: WORKER_ID_PARAM,
      },
    },
    async execute(args): Promise<StopWorkerToolResult> {
      const workerId = requireString(args, "worker_id");
      const record = multitask.getWorker(workerId);
      if (record === undefined) {
        // abortWorker throws on unknown; map to already-settled-shaped refusal
        // so the model gets a clean tool result rather than an exception.
        return {
          ok: false,
          reason: "already-settled",
          detail: `unknown worker: ${workerId}`,
        };
      }
      const result = await multitask.abortWorker(workerId);
      if (!result.ok) {
        return {
          ok: false,
          reason: "already-settled",
          detail: result.detail,
        };
      }
      return { ok: true, note: formatStopNote() };
    },
  };

  const deliverResult: DispatcherToolDef = {
    name: DELIVER_RESULT_TOOL,
    description: TOOL_DESCRIPTIONS[DELIVER_RESULT_TOOL],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          required: true,
          description:
            "What the user sees. Lead with the concrete finished thing.",
        },
        todo_id: {
          type: "string",
          required: false,
          description:
            "Ledger entry to mark completed after this send succeeds.",
        },
        attachment_paths: {
          type: "array",
          required: false,
          description:
            "Optional local paths the dispatcher chooses to attach. Never auto-attached from a worker report.",
          items: { type: "string" },
        },
      },
    },
    async execute(args): Promise<DeliverResultToolResult> {
      const text = requireString(args, "text");
      const todoId = optionalString(args, "todo_id");
      const attachmentPaths = optionalStringArray(args, "attachment_paths");

      let delivered = true;
      let detail: string | undefined;
      if (deps.deliverToUser !== undefined) {
        try {
          delivered = await deps.deliverToUser(
            text,
            attachmentPaths === undefined ? undefined : attachmentPaths,
          );
        } catch (error) {
          delivered = false;
          detail = error instanceof Error ? error.message : String(error);
        }
      }

      if (!delivered) {
        return {
          ok: false,
          delivered: false,
          todo_completed: null,
          ...(detail !== undefined ? { detail } : {}),
        };
      }

      let todoCompleted: string | null = null;
      if (todoId !== undefined) {
        const marked = multitask.markDelivered(todoId);
        todoCompleted = marked ? todoId : null;
        if (!marked) {
          detail = `todo ${todoId} could not be marked delivered`;
        }
      }

      return {
        ok: true,
        delivered: true,
        todo_completed: todoCompleted,
        ...(detail !== undefined ? { detail } : {}),
      };
    },
  };

  return [spawnWorker, checkWorkers, steerWorker, stopWorker, deliverResult];
}

/**
 * Per-turn reminder text for this session's ledger.
 * Convenience for adapter middleware — pure.
 */
export function buildTurnReminderForSession(
  multitask: Multitask,
  sessionId: string,
): string {
  return assembleTurnReminder(multitask.listTodos(sessionId));
}
