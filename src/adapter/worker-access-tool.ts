/**
 * Worker-side `request_access` tool (ticket 13).
 * Core-adjacent handler + adapter registration.
 * New copy only. Never invents a user channel; the parent answers.
 *
 * Ticket 69 (live FINDING 4, ticket 33 Session B-4 record): the W19
 * stop-and-wait contract and dsh settlement semantics conflict when the
 * tool resolves at park time — the worker ends its turn, the host settles
 * it, and the core's settle path drops the pending ticket
 * (`multitask.ts` "Settle wins over a pending access ask"), so the ask is
 * lost while the dispatcher narrates a parked worker. The fix parks the
 * TOOL CALL, not the turn-end: with the `awaitSettled` dep wired, execute
 * stays pending until the ask leaves core truth, the worker's turn cannot
 * finish, and settlement cannot eat the ask. The host tool model supports
 * this — per-tool call limits are opt-in
 * (`@deepseek-ai/dsh-tool-call-timeout-policy`: tools without a configured
 * limit are never cut off), and the wait itself is bounded by core truth:
 * the relay ends every ticket (explicit resolve, the armed ADR-0008
 * timeout deny, or a stop/settle clear).
 */

import type { AccessClass, AccessRequestBody } from "../core/access-types.js";
import { toAccessClass } from "../core/access-types.js";
import type { AdapterContext } from "./cordis-dsh-host.js";

/** Stable worker tool name. */
export const REQUEST_ACCESS_TOOL = "request_access";

/** Model-facing description (new copy). */
export const REQUEST_ACCESS_DESCRIPTION = [
  "Ask your parent for one-shot access to a gated action or a named credential.",
  "This is the only way to ask the parent; never invent a user channel.",
  "After calling, stop and wait for a parent message.",
  "Denied means do not retry the same ask — adjust the plan or end with a final report.",
  "Pass only the credential *name* (e.g. API_TOKEN), never a secret value.",
].join(" ");

export interface RequestAccessArgs {
  readonly class: string;
  readonly target: string;
  readonly reason: string;
  readonly credentialName?: string;
}

export interface RequestAccessResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly requestId?: string;
}

/**
 * The result summary when the tool call was parked until the ask settled
 * (the `awaitSettled` shape). The decision itself arrives as the worker's
 * next message — the relay's deliver path; the deny copy is
 * `wrapAccessDecision`'s. This summary covers the settle AND the clear
 * (stop/timeout) cases honestly: a cleared ask delivers no message.
 */
export const ASK_SETTLED_SUMMARY =
  "Your access ask is settled. The parent's decision arrives as your next " +
  "message — continue from it. If no message comes, the ask was cancelled " +
  "(the worker was stopped or the wait expired): do not retry the same ask; " +
  "adjust the plan or end with a final report explaining what was blocked.";

/** Validate args into an AccessRequestBody. Throws on bad input. */
export function toAccessRequestBody(args: {
  class?: unknown;
  target?: unknown;
  reason?: unknown;
  credential_name?: unknown;
  credentialName?: unknown;
}): AccessRequestBody {
  const classRaw = args.class;
  if (typeof classRaw !== "string") {
    throw new Error("class is required and must be a string");
  }
  const accessClass: AccessClass | undefined = toAccessClass(classRaw);
  if (accessClass === undefined) {
    throw new Error(`class must be one of tool, credential, network, filesystem, other`);
  }
  const target = args.target;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("target is required and must be a non-empty string");
  }
  const reason = args.reason;
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error("reason is required and must be a non-empty string");
  }
  const credentialName =
    typeof args.credential_name === "string" && args.credential_name.length > 0
      ? args.credential_name
      : typeof args.credentialName === "string" && args.credentialName.length > 0
        ? args.credentialName
        : undefined;
  return {
    class: accessClass,
    target,
    reason,
    ...(credentialName !== undefined ? { credentialName } : {}),
  };
}

export interface WorkerAccessToolDeps {
  /**
   * Resolve the calling worker session id from the tool exec context.
   * Return null when the caller is not a known worker.
   */
  readonly resolveWorkerId: (exec: unknown) => string | null;
  /** Whether the worker already has a pending ask. */
  readonly hasPendingAsk: (workerId: string) => boolean;
  /** Emit the structured access request into the core. */
  readonly emit: (event: {
    workerId: string;
    requestId: string;
    body: AccessRequestBody;
    createdAtMs: number;
  }) => void;
  /**
   * Ticket 69 (FINDING 4): when provided, execute AWAITS this after
   * emitting and resolves only once the emitted ask is no longer pending
   * in core truth — the ask parks the TOOL CALL, not the turn-end, so the
   * worker's turn stays open and host settlement cannot mark the worker
   * completed+delivered while a decision is owed. The promise MUST
   * terminate: every relay ticket ends (explicit resolve, the armed
   * ADR-0008 timeout deny, or a stop/settle clear). Absent, the legacy
   * park-ack shape is kept (pure-handler callers with no core truth to
   * watch — the tests that exercise this handler directly).
   */
  readonly awaitSettled?: (workerId: string, requestId: string) => Promise<void>;
  /** Injectable id factory + clock for tests. */
  readonly newRequestId?: () => string;
  readonly now?: () => number;
}

/**
 * Build the pure execute handler for request_access.
 * One outstanding ask per worker: a second call while pending is refused.
 */
export function createRequestAccessHandler(deps: WorkerAccessToolDeps) {
  let seq = 0;
  const newRequestId =
    deps.newRequestId ??
    (() => {
      seq += 1;
      return `access-${Date.now()}-${seq}`;
    });
  const now = deps.now ?? (() => Date.now());

  return async function executeRequestAccess(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<RequestAccessResult> {
    const workerId = deps.resolveWorkerId(exec);
    if (workerId === null) {
      return {
        ok: false,
        summary: "request_access is only available to workers.",
      };
    }
    if (deps.hasPendingAsk(workerId)) {
      return {
        ok: false,
        summary: "Already waiting on an answer. Stop and wait for a parent message.",
      };
    }
    const body = toAccessRequestBody(args);
    const requestId = newRequestId();
    deps.emit({
      workerId,
      requestId,
      body,
      createdAtMs: now(),
    });
    if (deps.awaitSettled !== undefined) {
      // FINDING 4: hold the tool call open while the ask is parked. The
      // model's turn cannot end mid-tool-call, so dsh settlement never
      // fires here — the ask survives until a real decision (or its
      // timeout/stop clear) lands.
      await deps.awaitSettled(workerId, requestId);
      return {
        ok: true,
        requestId,
        summary: ASK_SETTLED_SUMMARY,
      };
    }
    return {
      ok: true,
      requestId,
      summary:
        "Access request sent to the parent. Stop and wait for a parent message; do not retry the same ask.",
    };
  };
}

export interface PendingAskSettleWaiterOptions {
  /**
   * Core truth: whether the worker still has a pending ask. Backed by the
   * relay's pending list (`Multitask.listPendingAccess`) — the same read
   * the `hasPendingAsk` refusal uses.
   */
  readonly isPending: (workerId: string) => boolean;
  /** Poll interval in ms. Default 100 (a tiny array scan; no LLM cost). */
  readonly pollMs?: number;
  /** Injectable delay for tests. Default a real setTimeout promise. */
  readonly delay?: (ms: number) => Promise<void>;
}

/**
 * The plugin's `awaitSettled` implementation (FINDING 4): watch core truth
 * until the ask leaves the relay's pending set. Polling — deliberately: the
 * relay ends every ticket through resolve, the armed ADR-0008 timeout deny,
 * or a stop/settle clear, and each of those flips this predicate without a
 * plugin-visible event, so watching the truth directly is the only
 * no-new-core-seam way to cover every unblock path (including the parent
 * session deactivating mid-ask). The wait therefore always terminates.
 */
export function createPendingAskSettleWaiter(
  options: PendingAskSettleWaiterOptions,
): (workerId: string, requestId: string) => Promise<void> {
  const pollMs = options.pollMs ?? 100;
  const delay =
    options.delay ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  return async (workerId: string) => {
    while (options.isPending(workerId)) {
      await delay(pollMs);
    }
  };
}

export interface RegisterWorkerAccessToolOptions {
  readonly ctx: AdapterContext;
  readonly deps: WorkerAccessToolDeps;
}

/** Structural tool registration shape (reuses dispatcher registerable pattern). */
export function toRegisterableAccessTool(execute: (
  args: Record<string, unknown>,
  exec?: unknown,
) => Promise<RequestAccessResult>): {
  name: string;
  description: string;
  parameters: unknown;
  output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text?: string }> };
  execute: (args: unknown, exec?: unknown) => Promise<unknown>;
} {
  return {
    name: REQUEST_ACCESS_TOOL,
    description: REQUEST_ACCESS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        class: {
          type: "string",
          enum: ["tool", "credential", "network", "filesystem", "other"],
          description: "Why access is needed.",
        },
        target: {
          type: "string",
          description: "Tool or resource name.",
        },
        reason: {
          type: "string",
          description: "Short why.",
        },
        credential_name: {
          type: "string",
          description:
            "For class credential: the env/credential name only. Never a value.",
        },
      },
      required: ["class", "target", "reason"],
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => {
        const record = value as RequestAccessResult | null | undefined;
        if (record == null) return [{ type: "text", text: "" }];
        return [{ type: "text", text: record.summary }];
      },
    },
    execute(args: unknown, exec?: unknown): Promise<unknown> {
      const record =
        args !== null && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      return execute(record, exec);
    },
  };
}

/**
 * Register the worker-only request_access tool on ctx.tools.
 * Returns a disposer, or a no-op when the registry is unavailable.
 */
export function registerWorkerAccessTool(
  options: RegisterWorkerAccessToolOptions,
): () => void {
  const tools = options.ctx.tools;
  if (tools === undefined || typeof tools.register !== "function") {
    return () => {};
  }
  const execute = createRequestAccessHandler(options.deps);
  return tools.register(toRegisterableAccessTool(execute));
}
