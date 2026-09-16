/**
 * Permission / secret relay message shapes (ticket 13).
 * Names are ours; none come from the reconstruction.
 * Hard rule: no secret *values* appear on any type here — only names.
 */

/** Why a worker is blocked. Stable class string; unknown strings are fine. */
export type AccessClass =
  | "tool" // a named work tool needs a one-shot yes/no
  | "credential" // needs a secret (values never ride this shape)
  | "network" // e.g. a host the sandbox would not allow
  | "filesystem" // e.g. a path outside the workspace
  | "other";

/** All access classes, for validation and default policy seeds. */
export const ACCESS_CLASSES: readonly AccessClass[] = [
  "tool",
  "credential",
  "network",
  "filesystem",
  "other",
] as const;

/** What the worker is asking for. Never contains a secret value. */
export interface AccessRequestBody {
  readonly class: AccessClass;
  /** Tool or resource name, when known. */
  readonly target: string;
  /** Free-text reason, short. */
  readonly reason: string;
  /**
   * For class "credential": the env/credential *name* only
   * (e.g. "API_TOKEN"). Never the value.
   */
  readonly credentialName?: string;
}

/** Worker → core request event (host delivers after the worker tool runs). */
export interface AccessRequestEvent {
  readonly workerId: string;
  /** Host-unique id for this ask. */
  readonly requestId: string;
  readonly body: AccessRequestBody;
  /** ms since epoch when the ask was created (host clock). */
  readonly createdAtMs: number;
}

/**
 * Decision steered back into the worker.
 * Deliberately has no value field — secrets never ride a decision.
 */
export type AccessDecision =
  | { readonly kind: "allow"; readonly note?: string }
  | {
      readonly kind: "deny";
      readonly reason: "user-denied" | "policy-denied" | "timeout" | "aborted";
      readonly detail: string;
    };

/** Live ticket held by the core (in-memory — ADR-0006 same rule as steers). */
export interface AccessTicket {
  readonly workerId: string;
  readonly requestId: string;
  readonly body: AccessRequestBody;
  readonly createdAtMs: number;
  readonly parentSessionId: string;
  readonly status: "pending" | "resolved";
}

/** Pending ask carried on a wake so the dispatcher can answer. */
export interface AccessRequestNotice {
  readonly workerId: string;
  readonly requestId: string;
  readonly title: string;
  readonly body: AccessRequestBody;
}

/**
 * Resolved-access notice for honest user reporting (mostly denials).
 * Names the action; never carries a secret.
 */
export interface AccessNotice {
  readonly kind: "access-resolved";
  readonly workerId: string;
  readonly title: string;
  readonly decision: AccessDecision;
  readonly body: AccessRequestBody;
}

/** Stored policy row (session or profile scope). */
export interface PolicyEntry {
  /** Match on class + optional tool/target fingerprint. */
  readonly class: AccessClass;
  /** Exact or prefix match on target; `*` = any target in class. */
  readonly targetPattern: string;
  readonly decision: "allow" | "deny";
  /** "session" = this dispatcher session only; "profile" = durable profile default. */
  readonly scope: "session" | "profile";
}

/** Context passed to policy lookup. */
export type PolicyLookupCtx = {
  readonly parentSessionId: string;
};

/** True when the decision is a deny (any reason). */
export function isDenyDecision(
  decision: AccessDecision,
): decision is Extract<AccessDecision, { kind: "deny" }> {
  return decision.kind === "deny";
}

/** Narrow a string to AccessClass; returns undefined when unknown. */
export function toAccessClass(value: string): AccessClass | undefined {
  return (ACCESS_CLASSES as readonly string[]).includes(value)
    ? (value as AccessClass)
    : undefined;
}
