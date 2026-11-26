/**
 * Dispatcher tool surface: the three verbs stock DSH does not cover — user
 * delivery (`deliver_result`), peer-dispatcher messaging (`message_agent`)
 * and mitosis (`spawn_dispatcher`, the one tool that does NOT go through
 * `Multitask`, because a dispatcher is a peer, not a work stream). Workers,
 * status, steering and stopping are the host's stock `subagent` /
 * `list_agents` / `send_message` / `interrupt_agent` tools, and a stock
 * completion notice — not a wait tool — starts the dispatcher's next turn.
 * The peer inbox, envelope, dedupe, cap, and `Multitask.sendPeer` machinery
 * stay, because `message_agent` rides them.
 * Handlers stay core-side; the adapter registers them on ctx.tools.
 * FakeDshHost stays green — handlers only call existing core methods and the
 * injected host seam.
 */

import type { Multitask } from "./multitask.js";
import { assembleTurnReminder } from "./policy/assembler.js";
import {
  DELIVER_RESULT_TOOL,
  MESSAGE_AGENT_TOOL,
  SPAWN_DISPATCHER_TOOL,
  toolDescriptionsFor,
  type DispatcherOrigin,
  type PolicyLanguage,
} from "./policy/prompts.js";
import { sanitizeModelOptionValue } from "./model-option-value.js";
import {
  formatDeliverResultRecorded,
  formatDeliverResultUnknownTarget,
  formatMessageAgentRateLimited,
  formatMessageAgentRefusal,
  formatMessageAgentSteerNote,
  formatMessageAgentDormantSteerNote,
  formatPeerSendAck,
  formatSpawnDispatcherNote,
  type DeliverResultToolResult,
  type MessageAgentToolResult,
  type SpawnDispatcherToolResult,
} from "./tool-results.js";
import type {
  DispatcherSpawnOptions,
  DispatcherSpawnResult,
  ModelFallbackNotice,
  ModelOptionPurpose,
  ModelOptionResolution,
  ModelRoute,
} from "./types.js";

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
  /**
   * `exec` is the host tool-exec context (structural). Only `spawn_dispatcher`
   * reads it — for `exec.signal`, forwarded into the host spawn so a stopped
   * turn cancels the summon. Every other handler ignores the second argument.
   *
   * The adapter (`toRegisterableTool`) forwards the host's second argument
   * (`tool.execute(exec.arguments, exec)`, `dsh-tools/lib/index.js:3406`),
   * so on live hosts `exec.signal` really is the turn's cancellation signal.
   */
  readonly execute: (
    args: Record<string, unknown>,
    exec?: unknown,
  ) => Promise<unknown>;
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
   * User-facing send. When omitted, delivery is conversational (ADR-0009):
   * the dispatcher's own reply is the channel, so `deliver_result` marks the
   * todo delivered and returns `channel: "reply"` telling the model to state
   * the result in that reply. It never claims the user already saw it.
   */
  readonly deliverToUser?: DeliverToUserFn;
  /**
   * No dispatcher tool reads this since the roster moved to the stock
   * `list_agents`; kept because `src/plugin.ts` still forwards it through
   * `registerDispatcherTools`.
   */
  readonly recentActivity?: RecentActivityFn;
  /** Same wiring-compatibility status as {@link recentActivity}. */
  readonly lastActivityAtMs?: (workerId: string) => number | null;
  /**
   * Ticket 118 / ADR-0025 mitosis: the host's dispatcher-spawn seam. Only
   * `spawn_dispatcher` reads it; every other handler ignores it.
   *
   * Seam status: chunk 2 (this tool) defines the port; the LIVE wiring is
   * chunk 3's. The plugin must pass
   * `spawnDispatcher: (opts) => host.spawnDispatcher(opts)` into
   * `registerDispatcherTools` (the adapter forwards it). Absent → the tool
   * THROWS, loudly: a registered spawn_dispatcher with no seam would
   * otherwise report a host refusal that never happened. Visibility stays
   * the fence (ADR-0019) — this is not a refusal class.
   */
  readonly spawnDispatcher?: (
    opts: DispatcherSpawnOptions,
  ) => Promise<DispatcherSpawnResult>;
  /**
   * Ticket 285: validate one non-empty model option against the live model
   * catalog. The tool layer trims the value and treats an empty string as
   * omitted; this seam resolves the rest. A `fallback` result means the
   * spawn still runs on the inherited route and the calling model gets a
   * note — never a refusal. A missing resolver for a non-empty value is a
   * wiring bug and the handler throws before any ledger work. A resolver
   * that rejects or returns `absent` for a non-empty value is a
   * catalog-error fallback, not a silent drop.
   */
  readonly resolveModel?: (
    raw: string,
    purpose: ModelOptionPurpose,
  ) => Promise<ModelOptionResolution>;
  /**
   * Ticket 116: injectable clock for the message_agent rate budget (tests).
   * Default `Date.now`. The other tools' timestamps are unaffected.
   */
  readonly now?: () => number;
  /**
   * Model-facing language of the tool descriptions (ticket 153). Omitted
   * means EN — the byte-stable text every pre-153 caller produced.
   */
  readonly language?: PolicyLanguage;
  /**
   * Which dispatcher CLASS this surface serves (owner ruling 2026-11-03,
   * ticket 176). Omitted means `user`.
   *
   * `spawned` — a dispatcher another dispatcher summoned — must NOT be able
   * to summon further dispatchers, so `spawn_dispatcher` is not registered at
   * all for that class. Visibility is the fence (ADR-0019): the team leader
   * gets host `UNKNOWN_TOOL`, not a refusal copy. The host refuses the same
   * call as a backstop (`CordisDshHost.spawnDispatcher`).
   */
  readonly origin?: DispatcherOrigin;
}

/**
 * Read the turn's abort signal out of the host's tool-exec context,
 * structurally (no host types, same idiom as `resolveExecSessionId` in the
 * adapter). Returns `undefined` when the exec carries no usable signal — the
 * host spawn then simply has no cancellation signal.
 */
export function readExecSignal(exec: unknown): AbortSignal | undefined {
  if (exec === null || typeof exec !== "object") return undefined;
  const raw = (exec as { signal?: unknown }).signal;
  if (raw === null || typeof raw !== "object") return undefined;
  const candidate = raw as { aborted?: unknown; addEventListener?: unknown };
  if (
    typeof candidate.aborted !== "boolean" ||
    typeof candidate.addEventListener !== "function"
  ) {
    return undefined;
  }
  return raw as AbortSignal;
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

/**
 * Ticket 285: optional model choices on `spawn_dispatcher`. The value is
 * validated by the wired resolver against the live catalog; a rejected value
 * falls back with a note and never refuses the spawn. Omission means
 * inheritance, and the per-field `required` stays false so the serialized
 * parent-level `required` array is unchanged.
 */
const SPAWN_DISPATCHER_MODEL_PARAM: ToolParameterNode = {
  type: "string",
  required: false,
  description:
    "Optional model for the summoned team leader. Use provider/model-id. A " +
    "bare model id is accepted when it is unique, or when it is shared but " +
    "owned by your provider; otherwise it is ambiguous and falls back. Omit " +
    "to inherit your current route.",
};

const SPAWN_DISPATCHER_WORKER_MODEL_PARAM: ToolParameterNode = {
  type: "string",
  required: false,
  description:
    "Optional default model for every worker this team leader later spawns. " +
    "Use provider/model-id. Omit to let workers inherit the team leader's " +
    "own route. An explicit model on a worker spawn still wins for that worker.",
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
 * Ticket 116: the shared agent-message budget — 8 accepted messages per
 * SENDER session per rolling 60 s, counted on accept; refusals do not count.
 * `message_agent` draws on it via {@link createAgentMessageBudget}, keyed by
 * the sending dispatcher's own session id. The inbox cap (64 undelivered) is
 * the second, independent bound.
 */
export const MESSAGE_AGENT_RATE_LIMIT = 8;
export const MESSAGE_AGENT_RATE_WINDOW_MS = 60_000;

/**
 * The one agent-message rate-budget mechanism (ticket 116).
 * Counting happens ONLY on accept: a caller checks {@link hasCapacity}
 * before sending and calls {@link record} only after the send was accepted —
 * a refusal therefore never consumes budget. Keys are sender identities
 * (the dispatcher session id); each key holds its own rolling window of
 * accepted-at timestamps.
 */
export interface AgentMessageBudget {
  /** Whether one more accept fits `senderId`'s rolling window at `atMs`. */
  hasCapacity(senderId: string, atMs: number): boolean;
  /** Count one ACCEPTED message at `atMs`. Never call for a refusal. */
  record(senderId: string, atMs: number): void;
}

/** Build the shared agent-message rate budget (8 per rolling 60 s). */
export function createAgentMessageBudget(): AgentMessageBudget {
  const acceptedAt = new Map<string, number[]>();
  return {
    hasCapacity(senderId: string, atMs: number): boolean {
      const recent = (acceptedAt.get(senderId) ?? []).filter(
        (accepted) => atMs - accepted < MESSAGE_AGENT_RATE_WINDOW_MS,
      );
      acceptedAt.set(senderId, recent);
      return recent.length < MESSAGE_AGENT_RATE_LIMIT;
    },
    record(senderId: string, atMs: number): void {
      const recent = acceptedAt.get(senderId) ?? [];
      recent.push(atMs);
      acceptedAt.set(senderId, recent);
    },
  };
}

/**
 * Ticket 179, narrowed by the stock-subagent refactor: the ONLY host verb a
 * dispatcher surface withholds is `subagent_fork`.
 *
 * Fork is the one stock spawn a dispatcher must not use: a forked child
 * inherits its parent's context, and workers are required to start blank
 * (ADR-0003). Plain `subagent` is now the supported way to start a worker, and
 * `list_agents` / `send_message` / `interrupt_agent` / `list_subagent_models`
 * stay visible.
 */
export const DISPATCHER_WITHHELD_HOST_TOOLS: readonly string[] = [
  "subagent_fork",
];

/**
 * The worker barrier's candidate list: every host spawn verb a WORKER may
 * never reach. Separate from {@link DISPATCHER_WITHHELD_HOST_TOOLS} — the
 * worker barrier keeps denying `subagent` and `list_subagent_models` while
 * the dispatcher surface now allows them.
 */
export const HOST_SPAWN_TOOL_CANDIDATES: readonly string[] = [
  "subagent",
  "subagent_fork",
  "list_subagent_models",
];

/**
 * The one method this module needs from a dispatcher's scoped tool surface
 * (the host's `agent.ctx.tools`). Structural.
 */
export interface DispatcherScopedToolSurface {
  /** Live tool names as this scope sees them (host: `tools.schemas(scope)`). */
  schemas(scope?: unknown): ReadonlyArray<{ readonly name: string }>;
  /**
   * Restrict inherited tools for this scope; returns the disposer that lifts
   * the restriction. Absent on stub contexts.
   */
  restrict?(filter: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  }): () => void;
}

/**
 * The dispatcher withhold list: candidates that are ACTUALLY on this surface.
 *
 * Same rule as the worker barrier (`src/worker/tool-barrier.ts:1-7`): the host
 * throws on a restriction naming a tool it does not know, so never hand it a
 * hard-coded list. A preset-free session (`minimal`) carries none of these and
 * the answer is empty.
 */
export function withheldHostSpawnTools(
  knownToolNames: ReadonlySet<string>,
): string[] {
  return DISPATCHER_WITHHELD_HOST_TOOLS.filter((name) =>
    knownToolNames.has(name),
  );
}

/**
 * Ticket 179: take the host's raw FORK verb off ONE dispatcher's surface.
 *
 * Why a restriction and not "build fewer definitions" (ticket 176's mechanism
 * for `spawn_dispatcher`): these verbs are registered by a preset ANCESTOR
 * layer, not by us, so not registering them is not an option. `restrict`
 * filters what a scope inherits and never what it registers itself
 * (`dsh-tools/lib/index.js:3040-3072`), which is exactly the split needed —
 * the preset's fork verb disappears, our three tools and stock `subagent`
 * stay.
 *
 * Two host behaviours follow for free, which is why no copy moves:
 * `tools.get(name, scope)` resolves through the restriction, so
 * `dsh-tool-subagent`'s own prompt section and depth reminder hide themselves
 * (`if (visible[0] !== toolName) return ""`), and the model is never told
 * about a verb it cannot call.
 *
 * Returns the exact disposer, or `null` when nothing was applied: no
 * `restrict` on the surface (stub hosts), no `schemas` answer, or an empty
 * intersection — the host rejects an empty filter outright.
 */
export function withholdHostSpawnTools(
  surface: DispatcherScopedToolSurface,
  scope?: unknown,
): (() => void) | null {
  if (typeof surface.restrict !== "function") return null;
  let known: ReadonlySet<string>;
  try {
    known = new Set(surface.schemas(scope).map((schema) => schema.name));
  } catch {
    // A surface that cannot be read is not proof a verb is there; refuse to
    // guess a deny list, exactly like `globalToolNames`.
    return null;
  }
  const deny = withheldHostSpawnTools(known);
  if (deny.length === 0) return null;
  return surface.restrict({ deny });
}

/**
 * Ticket 59 / register B-1: release the stream a crash-time worker still
 * holds, dropping its durable marker with it.
 *
 * This is the non-tool half of the retired worker-stop command, and it must
 * stay callable: after a restart a worker that was live is not on the roster,
 * yet its stream key is still held, and `interrupt_agent` has no live child to
 * target. The plugin's restart sweep is the intended caller (next lane); it
 * passes its own dispatcher session id so one session can never release
 * another's stream. A structured outcome instead of model-facing copy keeps
 * this usable outside a tool call.
 *
 * `releaseUnknownStateHoldOutcome` drops the durable marker, so a released
 * hold cannot come back on the next activation. When the store refuses that
 * drop, the hold (and its key) stays in place and `kind:
 * "hold-release-failed"` says so. `kind: "not-held"` covers both "this id
 * never held a stream" and a concurrent release.
 */
export type StaleWorkerHoldReleaseOutcome =
  | { readonly kind: "not-held" }
  | { readonly kind: "released"; readonly streamKey: string }
  | { readonly kind: "hold-release-failed"; readonly detail: string };

export async function releaseStaleWorkerHold(
  multitask: Pick<
    Multitask,
    "listUnknownStateHolds" | "releaseUnknownStateHoldOutcome"
  >,
  sessionId: string,
  workerId: string,
): Promise<StaleWorkerHoldReleaseOutcome> {
  const hold = multitask
    .listUnknownStateHolds(sessionId)
    .find((held) => held.workerId === workerId);
  if (hold === undefined) return { kind: "not-held" };
  const release = await multitask.releaseUnknownStateHoldOutcome(workerId);
  if (release.ok) return { kind: "released", streamKey: hold.streamKey };
  if (release.reason === "hold-release-failed") {
    return { kind: "hold-release-failed", detail: release.detail };
  }
  // `not-held`: the hold disappeared between the listing and the release.
  // Nothing was released by this call.
  return { kind: "not-held" };
}

/**
 * Create the dispatcher tool definitions bound to a Multitask core — the
 * three-tool shape stock DSH does not cover: `deliver_result`,
 * `message_agent` and `spawn_dispatcher`. Pure enough for unit tests: no
 * ctx, no host types.
 *
 * Ticket 176: `deps.origin` selects the CLASS. The user-started chief of staff
 * gets all three; a spawned team leader gets two and NO `spawn_dispatcher`
 * (owner ruling 2026-11-03 — a summoned dispatcher may not summon further
 * dispatchers). Omitted means `user`.
 */
export function createDispatcherTools(
  deps: DispatcherToolDeps,
): DispatcherToolDef[] {
  const { multitask, getSessionId } = deps;
  const nowMs = deps.now ?? (() => Date.now());
  /** Ticket 153: the selected description face; EN unless exactly "zh". */
  const descriptions = toolDescriptionsFor(deps.language ?? "en");
  /**
   * Ticket 176 (owner ruling 2026-11-03): a SPAWNED dispatcher — a team leader
   * another dispatcher summoned — may not summon further dispatchers. The
   * fence is the tool surface itself (ADR-0019), so the definition is never
   * built for that class and the model never sees the name. The host refuses
   * the same call as a backstop for any other route to `spawnDispatcher`.
   */
  const maySummonDispatchers = (deps.origin ?? "user") !== "spawned";
  /**
   * Ticket 116: this registration's draw on the shared agent-message
   * budget, keyed by the sender's own session id (the registration closure
   * IS the session). Both message_agent branches count here; refusals do
   * not.
   */
  const budget = createAgentMessageBudget();

  function requireSessionId(): string {
    const sessionId = getSessionId();
    if (sessionId === null) {
      throw new Error("no dispatcher session bound");
    }
    return sessionId;
  }

  /**
   * Ticket 285: normalize one optional model argument. Absent, empty, and
   * whitespace-only values all mean "not provided" (no resolver call, no
   * note). A non-empty value with no wired resolver is a WIRING bug and
   * throws: reporting a fallback would claim a validation that never ran.
   * `spawn_dispatcher` calls this before the host call, so a wiring error
   * refuses the summon before anything starts.
   *
   * The seam is total in the other direction: a resolver that rejects, or
   * one that breaks its contract by answering `absent` for a non-empty
   * value, becomes a catalog-error fallback. The spawn proceeds and the
   * caller gets a model_fallbacks note — a model choice is never silently
   * dropped.
   */
  async function resolveModelArg(
    value: string | undefined,
    option: "model" | "worker_model",
    purpose: ModelOptionPurpose,
  ): Promise<{
    route?: ModelRoute;
    fallback?: ModelFallbackNotice;
  }> {
    if (value === undefined) return {};
    const trimmed = value.trim();
    if (trimmed === "") return {};
    const resolve = deps.resolveModel;
    if (resolve === undefined) {
      throw new Error(
        "a model option was provided but no model resolver is wired (host wiring bug)",
      );
    }
    let result: ModelOptionResolution | undefined;
    try {
      result = await resolve(trimmed, purpose);
    } catch {
      result = undefined;
    }
    if (result?.kind === "resolved") return { route: result.route };
    if (result?.kind === "fallback") {
      const requested =
        typeof result.requested === "string" ? result.requested : trimmed;
      return {
        fallback: {
          option,
          requested: sanitizeModelOptionValue(requested),
          reason: result.reason,
        },
      };
    }
    // A wired resolver answering absent (or any other unexpected arm) for a
    // non-empty value is a contract violation, not "not provided". Never drop
    // the choice silently.
    return {
      fallback: {
        option,
        requested: sanitizeModelOptionValue(trimmed),
        reason: "catalog-error",
      },
    };
  }

  // Workers, status, steering and stopping are the host's stock `subagent`,
  // `list_agents`, `send_message` and `interrupt_agent` tools. Nothing on this
  // surface creates a child, steers it, stops it, or waits for it.

  const deliverResult: DispatcherToolDef = {
    name: DELIVER_RESULT_TOOL,
    description: descriptions[DELIVER_RESULT_TOOL],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          required: true,
          description:
            "What the user sees. Start with the specific outcome.",
        },
        todo_id: {
          type: "string",
          required: false,
          description:
            "Todo entry to mark completed once this result is recorded for the user.",
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
      const sessionId = requireSessionId();
      const text = requireString(args, "text");
      const todoId = optionalString(args, "todo_id");
      const attachmentPaths = optionalStringArray(args, "attachment_paths");

      // Ledger fence (same silent shape as `message_agent`): a todo owned by
      // another dispatcher must read exactly like a typo, and must never be
      // marked delivered by this session. Checked before any send so a foreign
      // id cannot close another session's obligation.
      let todoTitle: string | undefined;
      if (todoId !== undefined) {
        const entry = multitask.todos.get(todoId);
        if (entry === undefined || entry.sessionId !== sessionId) {
          return {
            ok: false,
            delivered: false,
            todo_completed: null,
            reason: "unknown-target",
            detail: formatDeliverResultUnknownTarget(todoId),
          };
        }
        todoTitle = entry.title;
      }

      // ADR-0009: delivery is conversational. The shipped plugin wires no
      // separate user-facing send, so the dispatcher's own reply IS the
      // channel: the obligation closes here (markDelivered, which also fires
      // the inbox `replied` hook), and the result tells the model to state it
      // in that reply. It never claims the user has already seen it.
      if (deps.deliverToUser === undefined) {
        let todoCompleted: string | null = null;
        if (todoId !== undefined) {
          // Ticket 113: the delivered text rides to the core so an
          // inbox-origin item's reply writer can land it in the job dir
          // (reply.md) — the dispatcher's reply is the channel.
          const marked = multitask.markDelivered(todoId, text);
          if (!marked) {
            return {
              ok: false,
              delivered: false,
              todo_completed: null,
              reason: "send-failed",
              detail: `todo ${todoId} could not be marked delivered, so the obligation is still open; state the result in your reply anyway.`,
            };
          }
          todoCompleted = todoId;
        }
        const attachmentsNotSent =
          attachmentPaths === undefined ? 0 : attachmentPaths.length;
        return {
          ok: true,
          delivered: true,
          channel: "reply",
          todo_completed: todoCompleted,
          ...(todoTitle !== undefined ? { todo_title: todoTitle } : {}),
          ...(attachmentsNotSent > 0
            ? { attachments_not_sent: attachmentsNotSent }
            : {}),
          detail: formatDeliverResultRecorded({
            ...(todoCompleted !== null ? { todoId: todoCompleted } : {}),
            ...(todoTitle !== undefined ? { todoTitle } : {}),
            ...(attachmentsNotSent > 0 ? { attachmentsNotSent } : {}),
          }),
        };
      }

      let delivered = false;
      let detail: string | undefined;
      try {
        delivered = await deps.deliverToUser(
          text,
          attachmentPaths === undefined ? undefined : attachmentPaths,
        );
      } catch (error) {
        delivered = false;
        detail = error instanceof Error ? error.message : String(error);
      }

      if (!delivered) {
        return {
          ok: false,
          delivered: false,
          todo_completed: null,
          reason: "send-failed",
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
        channel: "send",
        todo_completed: todoCompleted,
        ...(todoTitle !== undefined ? { todo_title: todoTitle } : {}),
        ...(detail !== undefined ? { detail } : {}),
      };
    },
  };

  /**
   * The peer-dispatcher messaging verb. Its model-facing job is the peer lane
   * (`multitask.sendPeer`), whose own fences produce `self-target` /
   * `unknown-target` / `inbox-full`; `priority` may reclaim a non-user turn
   * and never interrupts a user turn.
   *
   * The worker-id branch is retained for compatibility: a worker id owned by
   * THIS session still rides the EXISTING steer path
   * (`multitask.steerWorker`: single-slot last-wins park, interrupt, wrapped
   * send at the next step boundary) — no second queue. Policy points the model
   * at the stock `send_message` for workers.
   *
   * A worker id owned by ANOTHER session refuses `unknown-target` — this
   * session cannot see that worker, and the refusal must not leak that it
   * exists. Sender identity is the registration closure's session id; there
   * is no `from` argument. Every accepted send draws on the shared
   * agent-message budget, checked BEFORE any accept and counted only after
   * one (refusals never consume budget).
   */
  const messageAgent: DispatcherToolDef = {
    name: MESSAGE_AGENT_TOOL,
    description: descriptions[MESSAGE_AGENT_TOOL],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "string",
          required: true,
          description:
            "Another dispatcher's session id (from a message you received). For one of your own workers use send_message, addressed to its id.",
        },
        text: {
          type: "string",
          required: true,
          description:
            "The message itself. Self-contained — the target does not see this conversation.",
        },
        priority: {
          type: "boolean",
          required: false,
          description:
            "Ask for attention now. May interrupt only the peer's background work — never a turn their user is driving. Default false.",
        },
      },
    },
    async execute(args): Promise<MessageAgentToolResult> {
      const senderSessionId = requireSessionId();
      const target = requireString(args, "target");
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
        // Ticket 116 reuses the peer lane's inline text cap (U-F): refuse
        // inline, name the bound, deliver nothing, queue nothing.
        return {
          ok: false,
          reason: "invalid-envelope",
          detail: `text is ${text.length} characters; an agent message is capped at ${SEND_PEER_TEXT_MAX_CHARS} — send a shorter message`,
        };
      }

      const workerRecord = multitask.getWorker(target);
      if (
        workerRecord !== undefined &&
        workerRecord.parentSessionId !== senderSessionId
      ) {
        return {
          ok: false,
          reason: "unknown-target",
          detail: formatMessageAgentRefusal({
            reason: "unknown-target",
            target,
          }),
        };
      }

      /**
       * Ticket 142 (owner ruling 2026-10-22 — children half): an id with no
       * roster record that carries our own durable worker row is a DORMANT
       * worker of this session, not an unknown peer. It routes to the steer
       * branch (the same `steerWorker` call) so the wake path can resume it.
       * The session fence is the same rule the roster branch uses: another
       * session's worker must refuse `unknown-target` without leaking that it
       * exists.
       */
      const durableParent =
        workerRecord === undefined
          ? multitask.durableWorkerParent(target)
          : undefined;
      if (durableParent !== undefined && durableParent !== senderSessionId) {
        return {
          ok: false,
          reason: "unknown-target",
          detail: formatMessageAgentRefusal({
            reason: "unknown-target",
            target,
          }),
        };
      }

      // The budget gates acceptance: past the limit nothing may be parked or
      // appended, so this check precedes both sends. Identity fences above
      // run first so a wrong-target refusal never reads as a rate refusal.
      const at = nowMs();
      if (!budget.hasCapacity(senderSessionId, at)) {
        return {
          ok: false,
          reason: "rate-limited",
          detail: formatMessageAgentRateLimited({
            limit: MESSAGE_AGENT_RATE_LIMIT,
            windowSeconds: MESSAGE_AGENT_RATE_WINDOW_MS / 1000,
          }),
        };
      }

      const messageId = `agent-${crypto.randomUUID()}`;

      if (workerRecord !== undefined || durableParent !== undefined) {
        // Worker target: the existing steer path, unchanged — a dormant
        // worker is accepted there through the durable mark (ticket 142).
        const result = await multitask.steerWorker(target, text);
        if (!result.ok) {
          // steerWorker refuses not-running for terminal or never-started
          // workers. unknown-worker here can only be a concurrent removal —
          // not-running is the honest mapping either way, and nothing was
          // parked or interrupted.
          return {
            ok: false,
            reason: "not-running",
            detail: formatMessageAgentRefusal({
              reason: "not-running",
              target,
            }),
          };
        }
        budget.record(senderSessionId, at);
        return {
          ok: true,
          target,
          delivered_as: "steer",
          message_id: messageId,
          ...(result.dormant === true ? { dormant: true as const } : {}),
          // Ticket 142: a dormant worker gets honest copy — its session is
          // being resumed and the text arrives as its next message, so the
          // "next step boundary" promise a live steer makes would be false.
          note:
            result.dormant === true
              ? formatMessageAgentDormantSteerNote(workerRecord?.title ?? target)
              : formatMessageAgentSteerNote(workerRecord?.title ?? target),
        };
      }

      // Dispatcher target: the existing peer inbox and wake lane.
      const ack = multitask.sendPeer(target, {
        messageId,
        fromAgentId: senderSessionId,
        fromName: senderSessionId,
        to: { kind: "agent", agentId: target },
        conversationId: PEER_DIRECT_CONVERSATION_ID,
        text,
        priority,
        createdAtMs: at,
      });
      if (!ack.ok) {
        // Fresh-minted uuid: message-id-reuse cannot occur; if it somehow
        // did, the envelope itself is the problem — invalid-envelope.
        if (
          ack.reason === "invalid-envelope" ||
          ack.reason === "message-id-reuse"
        ) {
          return { ok: false, reason: "invalid-envelope", detail: ack.detail };
        }
        return {
          ok: false,
          reason: ack.reason,
          detail: formatMessageAgentRefusal({ reason: ack.reason, target }),
        };
      }
      budget.record(senderSessionId, at);
      return {
        ok: true,
        target,
        delivered_as: "peer",
        message_id: ack.messageId,
        note: formatPeerSendAck({
          toSession: target,
          messageId: ack.messageId,
          priority,
        }),
      };
    },
  };

  /**
   * Ticket 118 / ADR-0025 mitosis: `spawn_dispatcher`.
   *
   * Visibility is the fence (ADR-0019): it is registered on the dispatcher
   * surface only, so workers never see it and no extra execute-time gate is
   * needed. The parent is the REGISTRATION CLOSURE's session id — there is no
   * parent argument on the wire.
   *
   * It is NOT routed through `Multitask.spawnWorker`: a dispatcher is not a
   * work stream. Nothing here touches the worker roster, the stream-key
   * reservation, the todo ledger, the steer queue, or the durability marker
   * store. The handler calls the host's `spawnDispatcher` seam and reports
   * the child session id.
   *
   * Refusals are limited to what is real (ADR-0025 forbids any cap of ours):
   * - `invalid-args` — an empty/whitespace-only title or prompt. Nothing was
   *   attempted and no host call happened.
   * - `host-refused` — the host's own spawn error, passed through verbatim in
   *   `detail`; nothing is reclassified, re-worded, or capped here. ADR-0032
   *   makes the summon a top-level `ctx.agents.create` session, so the
   *   subagent runtime's `ACTIVATION_LIMIT_REACHED` live-child pool and its
   *   `maxDepth` refusal cannot arise on this path. What the host can still
   *   refuse is its own state: no bound parent for the summoning session, and
   *   ticket 176's one-level rule (a dispatched team leader cannot summon).
   */
  const spawnDispatcher: DispatcherToolDef = {
    name: SPAWN_DISPATCHER_TOOL,
    description: descriptions[SPAWN_DISPATCHER_TOOL],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: {
          type: "string",
          required: true,
          description:
            "Short human title for the summoned dispatcher (3–8 words). The host shows it on the child session.",
        },
        prompt: {
          type: "string",
          required: true,
          description:
            "Problem and outcome handoff: what to own, what done looks like, and what to report back. Self-contained — the new dispatcher does not see this conversation.",
        },
        model: SPAWN_DISPATCHER_MODEL_PARAM,
        worker_model: SPAWN_DISPATCHER_WORKER_MODEL_PARAM,
      },
    },
    async execute(
      args: Record<string, unknown>,
      exec?: unknown,
    ): Promise<SpawnDispatcherToolResult> {
      // Input refusals are tool results, not throws: the model gets a clean
      // "nothing was attempted" answer for an empty title or prompt.
      const titleRaw = args.title;
      if (typeof titleRaw !== "string" || titleRaw.trim().length === 0) {
        return {
          ok: false,
          reason: "invalid-args",
          detail: "title is required and must be a non-empty string.",
        };
      }
      const promptRaw = args.prompt;
      if (typeof promptRaw !== "string" || promptRaw.trim().length === 0) {
        return {
          ok: false,
          reason: "invalid-args",
          detail: "prompt is required and must be a non-empty string.",
        };
      }
      const title = titleRaw.trim();
      const prompt = promptRaw.trim();
      const parentSessionId = requireSessionId();

      const seam = deps.spawnDispatcher;
      if (seam === undefined) {
        // A missing seam is a WIRING bug, not a spawn refusal: reporting a
        // host refusal would claim an attempt that never happened. Chunk 3
        // wires this from `CordisDshHost.spawnDispatcher`.
        throw new Error(
          "spawn_dispatcher is registered but no dispatcher-spawn seam is wired",
        );
      }
      // Ticket 285: both optional model values are resolved before the
      // host call. A fallback is a note on a successful spawn, never a
      // refusal: the child starts on today's inherited route.
      const resolvedLeader = await resolveModelArg(
        optionalString(args, "model"),
        "model",
        "leader",
      );
      const resolvedWorkerDefault = await resolveModelArg(
        optionalString(args, "worker_model"),
        "worker_model",
        "worker-default",
      );
      const modelNotices: ModelFallbackNotice[] = [];
      if (resolvedLeader.fallback !== undefined) {
        modelNotices.push(resolvedLeader.fallback);
      }
      if (resolvedWorkerDefault.fallback !== undefined) {
        modelNotices.push(resolvedWorkerDefault.fallback);
      }
      const signal = readExecSignal(exec);
      let dispatcherId: string;
      try {
        const result = await seam({
          parentSessionId,
          title,
          prompt,
          ...(resolvedLeader.route !== undefined
            ? { model: resolvedLeader.route }
            : {}),
          ...(resolvedWorkerDefault.route !== undefined
            ? { workerModel: resolvedWorkerDefault.route }
            : {}),
          ...(signal !== undefined ? { signal } : {}),
        });
        dispatcherId = result.dispatcherId;
      } catch (error) {
        // Honest surfacing: the host's own text, unchanged. No refusal class
        // is invented and no cap is applied; a host error means the child
        // was not started.
        return {
          ok: false,
          reason: "host-refused",
          detail: `the host refused the dispatcher spawn: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      return {
        ok: true,
        dispatcher_id: dispatcherId,
        title,
        note: formatSpawnDispatcherNote({
          title,
          dispatcherId,
          ...(modelNotices.length > 0
            ? { modelFallbacks: modelNotices }
            : {}),
        }),
        ...(modelNotices.length > 0
          ? { model_fallbacks: modelNotices }
          : {}),
      };
    },
  };

  // Ticket 176: the spawned class stops here. Both classes get the same kept
  // tools — only the summon verb is withheld.
  const tools: DispatcherToolDef[] = [deliverResult, messageAgent];
  if (maySummonDispatchers) tools.push(spawnDispatcher);
  return tools;
}

/**
 * Per-turn reminder text for this session's ledger.
 * Convenience for adapter middleware. Shares the process-wide per-session
 * delta store, so the first call in a session renders the full ledger and
 * later calls render the compact delta.
 */
export function buildTurnReminderForSession(
  multitask: Multitask,
  sessionId: string,
): string {
  return assembleTurnReminder(
    multitask.listTodos(sessionId),
    undefined,
    "en",
    "user",
    sessionId,
  );
}
