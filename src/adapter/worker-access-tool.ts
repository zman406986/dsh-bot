/**
 * Worker-side `request_access` tool (ticket 13).
 * Core-adjacent handler + adapter registration.
 * New copy only. Never invents a user channel; the parent answers.
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
    return {
      ok: true,
      requestId,
      summary:
        "Access request sent to the parent. Stop and wait for a parent message; do not retry the same ask.",
    };
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
