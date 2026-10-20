/**
 * Dispatcher tool surface: six dsh-native tools mapped 1:1 onto
 * existing Multitask methods (and an injectable user-send for deliver).
 * Handlers stay core-side; the adapter registers them on ctx.tools.
 * FakeDshHost stays green — handlers only call existing core methods.
 */

import type { Multitask } from "./multitask.js";
import {
  deriveWorkerLiveness,
  type WorkerLiveness,
} from "./liveness.js";
import {
  assembleTurnReminder,
} from "./policy/assembler.js";
import {
  CHECK_WORKERS_TOOL,
  DELIVER_RESULT_TOOL,
  SEND_PEER_TOOL,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
  TOOL_DESCRIPTIONS,
} from "./policy/prompts.js";
import {
  isWorkerReplyStatus,
  workerReplySenderLabel,
  type PeerEnvelope,
  type PeerSendAck,
  type WorkerReplyOrigin,
  type WorkerReplyStatus,
} from "./peer-types.js";
import {
  formatCheckSummary,
  formatPeerSendAck,
  formatPeerSendRefusal,
  formatSpawnAck,
  formatSteerNote,
  formatStopNote,
  formatStopUnknownStateNote,
  toCheckRow,
  type CheckWorkersToolResult,
  type DeliverResultToolResult,
  type SendPeerToolResult,
  type SpawnWorkerToolResult,
  type SteerWorkerToolResult,
  type StopWorkerToolResult,
  type WorkerCheckRow,
} from "./tool-results.js";
import type { WorkerSummary } from "./types.js";

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

/**
 * Ticket 69 (chunk A, design §4): outcome of the host approval seam for a
 * posture-gated dispatch. Same outcome vocabulary as the dsh approval
 * contract (`docs/research/dsh-adapter-api-notes.md:220`); anything that is
 * not `allowed-once` refuses the spawn (fail-closed).
 */
export type DispatchApprovalOutcome =
  | "allowed-once"
  | "rejected"
  | "cancelled"
  | "unavailable";

/** What the approval answerer sees. Names only — never the prompt body. */
export interface DispatchApprovalRequest {
  readonly title: string;
  readonly streamKey: string;
}

/**
 * Injected host approval seam for a gated dispatch. Core stays host-agnostic:
 * the live wiring raises `ctx.approval.request` in the plugin (that wiring is
 * live-lane work, design L3); absent in tests unless a fake is injected.
 */
export type DispatchApprovalFn = (
  request: DispatchApprovalRequest,
) => Promise<DispatchApprovalOutcome>;

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
  /**
   * Ticket 61 (register A-8, ADR-0018 exception D22): host-clock ms of the
   * last firehose-observed activity per worker — the observation moment of
   * `recentActivity`'s phrase, from the same `session/event` projection (no
   * new seam, no polling). Optional: absent → check rows carry
   * `liveness: null` rather than a guessed verdict.
   */
  readonly lastActivityAtMs?: (workerId: string) => number | null;
  /**
   * Ticket 69 (chunk A, A6): host approval seam consulted only when the
   * review posture gates this dispatch (a posture row hit). Absent seam +
   * posture hit → the spawn is refused (fail-closed): an un-answerable gate
   * must never silently become an allow. Posture miss → never called.
   */
  readonly requestDispatchApproval?: DispatchApprovalFn;
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
 * Ticket 70 §2: inline ceiling on one peer message's text (U-F — refuse
 * inline, never spill; the reference clamps peer text to 8000 chars,
 * `docs/research/reference-behavior-notes.md:156`). Adapted bound, same
 * number: an over-max text refuses the send before it is accepted.
 */
export const SEND_PEER_TEXT_MAX_CHARS = 8000;

/**
 * Ticket 70 §3: the fenced, default-minted conversation slot. The tool
 * never takes one from the model — threading is U-B-excluded — so every
 * tool-borne peer message carries this constant opaquely.
 */
export const PEER_DIRECT_CONVERSATION_ID = "direct";

/**
 * Ticket 122 / ADR-0028: the worker's mid-task reply verb.
 *
 * It is deliberately NOT part of `createDispatcherTools()` — the dispatcher
 * never sees it. Workers inherit it from the global layer (the same
 * registration shape `request_access` uses), and the handler refuses every
 * caller that is not a worker in core truth. The address is never an
 * argument: the parent dispatcher id comes from the worker's own roster
 * record, so the channel is structurally single-parent and no
 * worker→worker or worker→other-dispatcher path exists.
 */
export const REPLY_TO_DISPATCHER_TOOL = "reply_to_dispatcher";

/**
 * Inline ceiling on one mid-task reply. 8,000 characters, the same bound
 * the peer lane already enforces (`SEND_PEER_TEXT_MAX_CHARS`) and the
 * reference's peer-text clamp. Reusing it keeps one documented number for
 * every peer-borne text: a reply cannot arrive through the peer envelope
 * larger than an ordinary peer message, and the bound is an order of
 * magnitude below ZCode's 65,536-character context-message cap, which is
 * not a per-message peer bound. An over-max reply refuses before accept.
 */
export const WORKER_REPLY_TEXT_MAX_CHARS = SEND_PEER_TEXT_MAX_CHARS;

/** Declared status words (closed set; see `WorkerReplyStatus`). */
export const WORKER_REPLY_STATUSES: readonly WorkerReplyStatus[] = [
  "progress",
  "blocked",
  "note",
];

/**
 * Rate bound: 8 accepted replies per worker per rolling 60 s — the same
 * agent-message budget ticket 116 settles for peer traffic. Refusals do not
 * count. The inbox cap (64 undelivered) is the second, independent bound.
 */
export const WORKER_REPLY_RATE_LIMIT = 8;
export const WORKER_REPLY_RATE_WINDOW_MS = 60_000;

/** Model-facing description (new copy). */
export const REPLY_TO_DISPATCHER_TOOL_DESCRIPTION = [
  "Report something to the dispatcher that spawned you without ending your turn.",
  "Use it when the parent should know about a finding, a changed assumption, or a blocker before you finish.",
  "It reaches only your parent dispatcher — never the user and never another worker.",
  "It does not finish the task: keep working, and still end with your final answer.",
  "text is capped at 8000 characters; status is one of progress, blocked, note.",
].join(" ");

/** One worker-side tool: name, description, parameters, handler. */
export interface WorkerToolDef {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterNode;
  readonly execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<unknown>;
}

/** Result shape returned to the worker model. */
export interface WorkerReplyToolResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly message_id?: string;
  readonly status?: WorkerReplyStatus;
}

export interface WorkerReplyToolDeps {
  /**
   * Core truth for the worker record: the handler derives the parent
   * dispatcher session id from here, never from a tool argument. `getWorker`
   * is also the worker-only gate — a caller with no roster record is refused.
   */
  readonly multitask: Pick<Multitask, "getWorker" | "sendPeer">;
  /**
   * Resolve the calling worker id from the tool exec context. The adapter
   * wires this from the exec's session id + `host.owns` (the request_access
   * shape); returning null means "not a worker this plugin owns".
   */
  readonly resolveWorkerId: (exec: unknown) => string | null;
  /** Injectable id factory + clock for tests. */
  readonly newMessageId?: () => string;
  readonly now?: () => number;
}

/**
 * Build the worker-facing `reply_to_dispatcher` tool.
 *
 * Side-effect contract: it only accepts a peer envelope. It never calls the
 * worker FSM, the todo ledger, or a completion path — so a reply cannot
 * settle the worker, complete a todo, or produce a completion-kind wake.
 */
export function createWorkerReplyTool(
  deps: WorkerReplyToolDeps,
): WorkerToolDef {
  const now = deps.now ?? (() => Date.now());
  const newMessageId =
    deps.newMessageId ?? (() => `worker-reply-${crypto.randomUUID()}`);
  /** workerId → accepted-at timestamps inside the rolling window. */
  const acceptedAt = new Map<string, number[]>();

  function refuse(summary: string): WorkerReplyToolResult {
    return { ok: false, summary };
  }

  return {
    name: REPLY_TO_DISPATCHER_TOOL,
    description: REPLY_TO_DISPATCHER_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          required: true,
          description:
            "The update itself. Short and concrete: what changed, what you found, or what blocks you.",
        },
        status: {
          type: "string",
          required: false,
          enum: [...WORKER_REPLY_STATUSES],
          description:
            "Optional status word: progress, blocked, or note. It is metadata, not a completion signal.",
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      exec?: unknown,
    ): Promise<WorkerReplyToolResult> {
      const workerId = deps.resolveWorkerId(exec);
      if (workerId === null) {
        return refuse(
          "reply_to_dispatcher is only available to workers; no reply was sent.",
        );
      }
      const record = deps.multitask.getWorker(workerId);
      if (record === undefined) {
        return refuse(
          "reply_to_dispatcher is only available to workers; no reply was sent.",
        );
      }

      const textRaw = args.text;
      if (typeof textRaw !== "string") {
        return refuse("text is required and must be a non-empty string.");
      }
      const text = textRaw.trim();
      if (text.length === 0) {
        return refuse("text is required and must be a non-empty string.");
      }
      if (text.length > WORKER_REPLY_TEXT_MAX_CHARS) {
        return refuse(
          `text is ${text.length} characters; a mid-task reply is capped at ` +
            `${WORKER_REPLY_TEXT_MAX_CHARS} — shorten it and try again.`,
        );
      }

      const statusRaw = args.status;
      let status: WorkerReplyStatus | undefined;
      if (statusRaw !== undefined && statusRaw !== null) {
        if (!isWorkerReplyStatus(statusRaw)) {
          return refuse(
            `status must be one of ${WORKER_REPLY_STATUSES.join(", ")} when provided.`,
          );
        }
        status = statusRaw;
      }

      const at = now();
      const recent = (acceptedAt.get(workerId) ?? []).filter(
        (accepted) => at - accepted < WORKER_REPLY_RATE_WINDOW_MS,
      );
      if (recent.length >= WORKER_REPLY_RATE_LIMIT) {
        acceptedAt.set(workerId, recent);
        return refuse(
          `rate limit reached: at most ${WORKER_REPLY_RATE_LIMIT} replies per ` +
            `${WORKER_REPLY_RATE_WINDOW_MS / 1000} seconds. Nothing was sent; ` +
            `batch your next update.`,
        );
      }

      const origin: WorkerReplyOrigin = {
        kind: "worker-reply",
        workerId,
        ...(status !== undefined ? { status } : {}),
      };
      const envelope: PeerEnvelope = {
        messageId: newMessageId(),
        fromAgentId: workerId,
        fromName: workerReplySenderLabel(record.title, status),
        to: { kind: "agent", agentId: record.parentSessionId },
        conversationId: PEER_DIRECT_CONVERSATION_ID,
        text,
        // A mid-task report must never preempt the dispatcher's user turn.
        // `enqueuePeer` queues non-priority notices during a user turn.
        priority: false,
        createdAtMs: at,
        origin,
      };

      const ack: PeerSendAck = deps.multitask.sendPeer(
        record.parentSessionId,
        envelope,
      );
      if (!ack.ok) {
        return refuse(
          `the reply was not delivered (${ack.reason}): ${ack.detail}`,
        );
      }

      recent.push(at);
      acceptedAt.set(workerId, recent);
      return {
        ok: true,
        message_id: ack.messageId,
        ...(status !== undefined ? { status } : {}),
        summary:
          "Reply sent to your dispatcher. Keep working — this did not end your turn; " +
          "your final answer is still required.",
      };
    },
  };
}

/**
 * Structural registration shape for a worker-local tool (mirrors the host's
 * `ToolDefinition`, same idiom as `toRegisterableTool` in the adapter). Kept
 * here so the worker composition can register the tool on the CHILD's scoped
 * surface without importing the adapter's dispatcher registration path.
 */
export interface RegisterableWorkerTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly output: {
    readonly schema: unknown;
    readonly render: (
      args: unknown,
      value: unknown,
    ) => Array<{ readonly type: string; readonly text?: string }>;
  };
  readonly execute: (args: unknown, exec?: unknown) => Promise<unknown>;
}

/** Wrap a worker tool definition into the registry-ready shape. */
export function toRegisterableWorkerTool(
  def: WorkerToolDef,
): RegisterableWorkerTool {
  return {
    name: def.name,
    description: def.description,
    // Ticket 45 rule applies to every registered tool: serialize the
    // authored tree so per-field `required` becomes the parent's array.
    parameters: toToolParametersSchema(def.parameters),
    output: {
      schema: { type: "object" },
      render: (_args, value) => {
        const record = value as { summary?: unknown } | null | undefined;
        return [
          {
            type: "text",
            text:
              record != null && typeof record.summary === "string"
                ? record.summary
                : "",
          },
        ];
      },
    },
    execute(args: unknown, exec?: unknown): Promise<unknown> {
      const record =
        args !== null && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      return def.execute(record, exec);
    },
  };
}

/** Scoped surface a worker-local tool registers on (the host's `agent.ctx.tools`). */
export interface WorkerToolSurface {
  register(definition: unknown): () => void;
}

/**
 * Build the worker-local tool definitions for ONE child, ready to register on
 * its scoped surface (ticket 122 / ADR-0028). The caller supplies the
 * registries; this module stays free of host types.
 */
export function createWorkerLocalToolDefs(
  deps: WorkerReplyToolDeps,
): readonly RegisterableWorkerTool[] {
  return [toRegisterableWorkerTool(createWorkerReplyTool(deps))];
}

/**
 * Register the worker-only tool set on ONE child's scoped surface
 * (ticket 122 / ADR-0028). This is the inverse of the dispatcher
 * registration: dispatcher tools land on the activated dispatcher agent's
 * scope, worker tools land on the child's scope, and neither surface lists
 * the other's tools. Returns the exact disposers.
 */
export function registerWorkerLocalTools(
  surface: WorkerToolSurface,
  deps: WorkerReplyToolDeps,
): Array<() => void> {
  return [surface.register(toRegisterableWorkerTool(createWorkerReplyTool(deps)))];
}

/**
 * Create the six dispatcher tool definitions bound to a Multitask core.
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

      // Ticket 69 (chunk A, design §4): worker-dispatch posture gate.
      // Miss → spawn proceeds exactly as shipped, no approval-seam call.
      // An allow row marks the dispatch as gated: the host approval seam
      // decides (allowed-once proceeds; anything else refuses). A deny row
      // auto-denies without the seam — policy already decided. Absent seam
      // on a gated dispatch refuses (fail-closed). Gating happens inside
      // the already-running dispatcher turn — no activation step, spawns
      // stay the single wake kind (C15).
      let postureGated = false;
      const posture = multitask.reviewPosture.lookupDispatch(title, {
        parentSessionId,
      });
      if (posture !== undefined) {
        if (posture.kind === "deny") {
          return {
            ok: false,
            reason: "auto-review-refused",
            detail: posture.detail,
          };
        }
        const seam = deps.requestDispatchApproval;
        if (seam === undefined) {
          return {
            ok: false,
            reason: "auto-review-refused",
            detail:
              `dispatch "${title}" is gated by the auto-review posture, ` +
              `but no approval answerer is available; refusing (fail-closed)`,
          };
        }
        const outcome = await seam({ title, streamKey });
        if (outcome !== "allowed-once") {
          return {
            ok: false,
            reason: "auto-review-refused",
            detail:
              `dispatch "${title}" was not approved ` +
              `(approval outcome: ${outcome}); re-plan without this dispatch`,
          };
        }
        // Chunk B marker: the durable tool-result record carries the gating
        // provenance so the client's dispatch card derives `approval-allowed`
        // at presentation time (never from client-side state).
        postureGated = true;
      }

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
        ...(postureGated ? { gated: true as const } : {}),
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
      const lastActivityAtMs = deps.lastActivityAtMs;
      // Ticket 61 (R3): a worker parked on a pending access ask is blocked
      // by design and must never read `stalled` — the same join the roster
      // projection's blocked marker uses.
      const blockedWorkerIds = new Set(
        multitask
          .listPendingAccess(parentSessionId)
          .map((ticket) => ticket.workerId),
      );
      /**
       * Ticket 61: liveness verdict over the row's own fields. Only when
       * the activity-time seam exists; otherwise `null` (honest absence).
       * The one `Date.now()` here is the check boundary — the derivation
       * itself is pure and takes the clock as an argument.
       */
      const livenessOf = (summary: WorkerSummary): WorkerLiveness | null => {
        if (lastActivityAtMs === undefined) return null;
        return deriveWorkerLiveness(
          {
            status: summary.status,
            startedAtMs: summary.startedAtMs,
            toolCallCount: summary.toolCallCount,
            lastActivityAtMs: lastActivityAtMs(summary.workerId) ?? null,
            blocked: blockedWorkerIds.has(summary.workerId),
          },
          Date.now(),
        );
      };

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
          livenessOf(summary),
        );
        return {
          ok: true,
          rows: [row],
          summary: formatCheckSummary([row]),
        };
      }

      const summaries = multitask.listWorkers(parentSessionId);
      const rows: WorkerCheckRow[] = summaries.map((summary) =>
        toCheckRow(
          summary,
          activity?.(summary.workerId) ?? null,
          livenessOf(summary),
        ),
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
        // Ticket 59: a worker that was live at crash time is deliberately not
        // on the roster, but it still holds its stream key. Stopping it is the
        // dispatcher's way of abandoning that stream — the hold's documented
        // escape hatch, and the only action the restart notice points at.
        // Session-scoped, so one session can never release another's stream.
        const sessionId = getSessionId();
        const hold =
          sessionId === null
            ? undefined
            : multitask
                .listUnknownStateHolds(sessionId)
                .find((held) => held.workerId === workerId);
        if (hold !== undefined) {
          const released = await multitask.releaseUnknownStateHold(workerId);
          if (released) {
            return {
              ok: true,
              note: formatStopUnknownStateNote(workerId, hold.streamKey),
            };
          }
        }
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
        // Ticket 113: the delivered text rides to the core so an inbox-origin
        // item's reply writer can land it in the job dir (reply.md).
        const marked = multitask.markDelivered(todoId, text);
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

  /**
   * Ticket 70 §2: point-to-point peer send. The registration closure IS the
   * session: the sender's identity (`fromAgentId`/`fromName`) is the
   * dispatcher's OWN session id — there is no `from` argument, so a
   * dispatcher cannot spoof a sibling. `messageId` is minted here (the
   * dedupe index stays an internal guarantee, not a model burden) and
   * `conversationId` defaults to the fenced constant. Fire-and-forget: the
   * mapped ack reports acceptance into the peer's inbox and lane, nothing
   * more; failures carry honest refusal copy with no retry affordance.
   */
  const sendPeer: DispatcherToolDef = {
    name: SEND_PEER_TOOL,
    description: TOOL_DESCRIPTIONS[SEND_PEER_TOOL],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        to_session: {
          type: "string",
          required: true,
          description:
            "The peer dispatcher's session id — from a peer message you received, or supplied by the user.",
        },
        text: {
          type: "string",
          required: true,
          description:
            "The message body. Self-contained: the peer does not see this conversation either.",
        },
        priority: {
          type: "boolean",
          required: false,
          description:
            "Request the peer's attention now. Interrupts only the peer's background work — never a turn their user is driving. Default false.",
        },
      },
    },
    async execute(args): Promise<SendPeerToolResult> {
      const senderSessionId = requireSessionId();
      const toSession = requireString(args, "to_session");
      const text = requireString(args, "text");
      const priority = args.priority === undefined ? false : args.priority;
      if (typeof priority !== "boolean") {
        return {
          ok: false,
          reason: "invalid-envelope",
          detail: "priority must be a boolean when provided",
        };
      }
      if (text.length > SEND_PEER_TEXT_MAX_CHARS) {
        // U-F inline refusal: name the bound, deliver nothing, queue nothing.
        return {
          ok: false,
          reason: "invalid-envelope",
          detail: `text is ${text.length} characters; a peer message is capped at ${SEND_PEER_TEXT_MAX_CHARS} — send a shorter message`,
        };
      }

      const messageId = `peer-${crypto.randomUUID()}`;
      const ack = multitask.sendPeer(toSession, {
        messageId,
        fromAgentId: senderSessionId,
        fromName: senderSessionId,
        to: { kind: "agent", agentId: toSession },
        conversationId: PEER_DIRECT_CONVERSATION_ID,
        text,
        priority,
        createdAtMs: Date.now(),
      });

      if (ack.ok) {
        return {
          ok: true,
          message_id: ack.messageId,
          to_session: toSession,
          summary: formatPeerSendAck({
            toSession,
            messageId: ack.messageId,
            priority,
          }),
        };
      }
      return {
        ok: false,
        reason: ack.reason,
        detail:
          ack.reason === "invalid-envelope"
            ? ack.detail
            : formatPeerSendRefusal(ack.reason, toSession),
      };
    },
  };

  return [
    spawnWorker,
    checkWorkers,
    steerWorker,
    stopWorker,
    deliverResult,
    sendPeer,
  ];
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
