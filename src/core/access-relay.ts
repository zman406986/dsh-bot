/**
 * Access relay: structured worker asks → policy / user → answer via sendMessage.
 * Pure-ish core module. Host I/O only through injected callbacks.
 * Tickets are in-memory (same durability rule as SteerTicket — ADR-0006).
 */

import type {
  AccessDecision,
  AccessNotice,
  AccessRequestBody,
  AccessRequestEvent,
  AccessTicket,
  PolicyEntry,
  PolicyLookupCtx,
} from "./access-types.js";
import { isDenyDecision } from "./access-types.js";

/** Default unanswered-ask timeout. Plugin Config overrides; tests inject. */
export const DEFAULT_ACCESS_TIMEOUT_MS = 120_000;

/**
 * Shipped profile seed: empty. Every class asks (lookup returns "ask"
 * whenever no allow/deny row hits). No `allow *` in the shipped seed.
 */
export function defaultProfileAskSeed(): readonly PolicyEntry[] {
  return [];
}

/** Match a target against a policy pattern: `*`, exact, or prefix with trailing `*`. */
export function matchTargetPattern(pattern: string, target: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return target.startsWith(pattern.slice(0, -1));
  }
  return pattern === target;
}

/** Session/profile policy table. No hit → "ask". */
export interface AccessPolicyTable {
  lookup(req: AccessRequestBody, ctx: PolicyLookupCtx): AccessDecision | "ask";
  /** Insert or replace a row (same class+pattern+scope, and owning session). */
  set(entry: PolicyEntry): void;
  list(): readonly PolicyEntry[];
  /**
   * Drop session-scope rows (ticket 30: "always allow (this session)"
   * clearance on deactivation/unload). Profile rows are untouched.
   * ADR-0019: WITH a session id, only that session's rows are dropped
   * (plus un-owned legacy rows, which belong to whichever session clears) —
   * a sibling dispatcher's remembered "always allow" must survive. Without
   * an id, every session-scope row is dropped (the shipped whole-table
   * clearance, used at plugin unload).
   */
  clearSession(sessionId?: string): void;
}

function rowKey(entry: PolicyEntry): string {
  // The owning session joins the key (ADR-0019): two dispatcher sessions may
  // each remember a row for the same class+pattern without evicting the
  // other's. Un-owned rows keep the legacy single-slot key.
  return `${entry.scope}\u0000${entry.session ?? ""}\u0000${entry.class}\u0000${entry.targetPattern}`;
}

/**
 * Whether a session-scope row applies to `parentSessionId`. Attributed rows
 * answer only their own session; un-owned (legacy) rows apply to any.
 */
function sessionRowApplies(
  entry: PolicyEntry,
  parentSessionId: string,
): boolean {
  return entry.session === undefined || entry.session === parentSessionId;
}

/**
 * Create a policy table. Session rows win over profile rows.
 * Default seed is empty → every ask escalates to the user.
 */
export function createAccessPolicyTable(
  seed: readonly PolicyEntry[] = defaultProfileAskSeed(),
): AccessPolicyTable {
  const rows = new Map<string, PolicyEntry>();
  for (const entry of seed) {
    rows.set(rowKey(entry), entry);
  }

  function hit(
    req: AccessRequestBody,
    scope: PolicyEntry["scope"],
    parentSessionId: string,
  ): AccessDecision | undefined {
    for (const entry of rows.values()) {
      if (entry.scope !== scope) continue;
      if (entry.class !== req.class) continue;
      if (
        scope === "session" &&
        !sessionRowApplies(entry, parentSessionId)
      ) {
        continue;
      }
      if (!matchTargetPattern(entry.targetPattern, req.target)) continue;
      if (entry.decision === "allow") return { kind: "allow" };
      return {
        kind: "deny",
        reason: "policy-denied",
        detail: `policy denied ${req.class} "${req.target}"`,
      };
    }
    return undefined;
  }

  return {
    lookup(req, ctx): AccessDecision | "ask" {
      return (
        hit(req, "session", ctx.parentSessionId) ??
        hit(req, "profile", ctx.parentSessionId) ??
        "ask"
      );
    },
    set(entry: PolicyEntry): void {
      rows.set(rowKey(entry), entry);
    },
    list(): readonly PolicyEntry[] {
      return [...rows.values()];
    },
    clearSession(sessionId?: string): void {
      for (const [key, entry] of [...rows]) {
        if (entry.scope !== "session") continue;
        // No id: the shipped whole-table clearance. With an id: only the
        // clearing session's rows (un-owned legacy rows go too — they never
        // outlive a session-scope clear, ticket 30's leak rule).
        if (sessionId === undefined || sessionRowApplies(entry, sessionId)) {
          rows.delete(key);
        }
      }
    },
  };
}

export interface AccessRelayOptions {
  /** Default 120_000. Tests pass a tiny value or a fake clock. */
  timeoutMs?: number;
  /** Injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Schedule a one-shot timeout. Returns a cancel function.
   * Default uses setTimeout. Tests inject a manual scheduler.
   */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Stored policy lookup (permission presets / session table). */
  lookupPolicy: (req: AccessRequestBody, ctx: PolicyLookupCtx) => AccessDecision | "ask";
  /** Deliver answer text into the worker (host.sendMessage). */
  deliver: (workerId: string, message: string) => void | Promise<void>;
  /** Ask the dispatcher to open a turn for a pending user decision. */
  wakeForAsk: (notice: {
    parentSessionId: string;
    workerId: string;
    requestId: string;
    title: string;
    body: AccessRequestBody;
  }) => void;
  /** Surface a resolved access notice (mostly denials) for honest user reporting. */
  onResolved: (notice: AccessNotice, parentSessionId: string) => void;
  /** Resolve a worker title for notices. Falls back to workerId. */
  getWorkerTitle?: (workerId: string) => string;
  /**
   * Whether the worker is still live. When omitted, all workers are live
   * until clear() is called.
   */
  isWorkerLive?: (workerId: string) => boolean;
}

export interface AccessRelay {
  /**
   * Called from host.onAccessRequest inside createMultitask.
   * One outstanding ask per worker: a second pending ask is refused.
   */
  noteRequest(event: AccessRequestEvent, parentSessionId: string): void;
  /**
   * Resolve a pending ticket. Idempotent: second resolve is a no-op.
   * Returns false when unknown/already resolved/worker terminal.
   */
  resolve(workerId: string, decision: AccessDecision): boolean;
  /** Drop tickets for a worker (stop/settle). Cancels any armed timeout. */
  clear(workerId: string): void;
  listPending(parentSessionId?: string): readonly AccessTicket[];
  /**
   * Release every parked ask (plugin unload/HMR teardown, ticket 137):
   * cancels all armed deny timers and closes the relay. After this call
   * `noteRequest`, `resolve` and `clear` are no-ops — no timer is armed,
   * nothing is delivered, and `onResolved` is never called again. Idempotent.
   */
  dispose(): void;
}

interface LiveTicket {
  ticket: AccessTicket;
  cancelTimeout: () => void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

/**
 * Wrap a decision as a short parent note the worker folds in and continues.
 * Deny always names the target and instructs a re-plan or final report.
 * New copy only.
 */
export function wrapAccessDecision(
  decision: AccessDecision,
  body: AccessRequestBody,
): string {
  const target = body.target.length > 0 ? body.target : "(unnamed)";
  if (decision.kind === "allow") {
    const note =
      decision.note !== undefined && decision.note.length > 0
        ? ` ${decision.note}`
        : "";
    return [
      "[Parent: access allowed]",
      `Allowed: ${body.class} "${target}".${note}`,
      "Continue from here; do not restart.",
    ].join("\n");
  }
  const reasonLabel =
    decision.reason === "user-denied"
      ? "denied by the user"
      : decision.reason === "policy-denied"
        ? "denied by policy"
        : decision.reason === "timeout"
          ? "denied — the wait for an answer timed out"
          : "denied — the request was aborted";
  return [
    "[Parent: access denied]",
    `Denied: ${body.class} "${target}" — ${reasonLabel}.`,
    decision.detail.length > 0 ? `Detail: ${decision.detail}` : "",
    "Do not retry this ask. Adjust the plan without this action, or end with a final report explaining what was blocked.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Create the in-memory access relay. */
export function createAccessRelay(options: AccessRelayOptions): AccessRelay {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACCESS_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? defaultSchedule;
  const getWorkerTitle = options.getWorkerTitle ?? ((id: string) => id);
  const isWorkerLive = options.isWorkerLive ?? (() => true);

  /** workerId → live pending ticket. One slot per worker. */
  const byWorker = new Map<string, LiveTicket>();
  /**
   * Ticket 137: set by dispose(). Once closed, nothing arms a timer, delivers
   * a decision, or surfaces a notice — a scheduled callback that still fires
   * (a host scheduler that ignores its cancel) checks this first, the same
   * stale-generation discipline the wake bus uses.
   */
  let closed = false;

  async function deliverDecision(
    workerId: string,
    decision: AccessDecision,
    body: AccessRequestBody,
  ): Promise<void> {
    try {
      await options.deliver(workerId, wrapAccessDecision(decision, body));
    } catch {
      // Delivery is best-effort: the host may legitimately throw here — e.g.
      // the parent session unbound while a timeout deny was still armed — and
      // these calls are fire-and-forget (`void`). The decision is already
      // recorded and deny notices still reach the user through onResolved, so
      // a failed delivery must never surface as an unhandled rejection.
    }
  }

  function finish(
    workerId: string,
    decision: AccessDecision,
  ): boolean {
    // Ticket 137: a closed relay never delivers or notifies. Every ticket was
    // dropped by dispose(), so this is mostly belt-and-braces for a scheduler
    // whose cancel was ignored.
    if (closed) return false;
    const live = byWorker.get(workerId);
    if (live === undefined) return false;
    byWorker.delete(workerId);
    live.cancelTimeout();
    const { ticket } = live;
    if (ticket.status === "resolved") return false;
    void deliverDecision(workerId, decision, ticket.body);
    if (isDenyDecision(decision)) {
      options.onResolved(
        {
          kind: "access-resolved",
          workerId,
          title: getWorkerTitle(workerId),
          decision,
          body: ticket.body,
        },
        ticket.parentSessionId,
      );
    }
    return true;
  }

  return {
    noteRequest(event: AccessRequestEvent, parentSessionId: string): void {
      // Ticket 137: a closed relay is inert — teardown already dropped every
      // parked ask, so a late host event must not park a new one.
      if (closed) return;
      // One outstanding ask per worker — refuse / ignore a second.
      if (byWorker.has(event.workerId)) return;
      if (!isWorkerLive(event.workerId)) return;

      const policy = options.lookupPolicy(event.body, { parentSessionId });
      if (policy !== "ask") {
        // Auto-answer from stored policy: no user wake, no pending ticket.
        void deliverDecision(event.workerId, policy, event.body);
        if (isDenyDecision(policy)) {
          options.onResolved(
            {
              kind: "access-resolved",
              workerId: event.workerId,
              title: getWorkerTitle(event.workerId),
              decision: policy,
              body: event.body,
            },
            parentSessionId,
          );
        }
        return;
      }

      const ticket: AccessTicket = {
        workerId: event.workerId,
        requestId: event.requestId,
        body: event.body,
        createdAtMs: event.createdAtMs > 0 ? event.createdAtMs : now(),
        parentSessionId,
        status: "pending",
      };

      const cancelTimeout = schedule(() => {
        // Default deny: unanswered request is denied after the timeout.
        // Stop wins: if the worker was cleared, this is a no-op.
        finish(event.workerId, {
          kind: "deny",
          reason: "timeout",
          detail: "stopped waiting for an answer",
        });
      }, timeoutMs);

      byWorker.set(event.workerId, { ticket, cancelTimeout });

      options.wakeForAsk({
        parentSessionId,
        workerId: event.workerId,
        requestId: event.requestId,
        title: getWorkerTitle(event.workerId),
        body: event.body,
      });
    },

    resolve(workerId: string, decision: AccessDecision): boolean {
      return finish(workerId, decision);
    },

    clear(workerId: string): void {
      const live = byWorker.get(workerId);
      if (live === undefined) return;
      byWorker.delete(workerId);
      live.cancelTimeout();
      // Cleared (abort/settle): no sendMessage, no notice. Late resolve is a no-op.
    },

    listPending(parentSessionId?: string): readonly AccessTicket[] {
      const all = [...byWorker.values()].map((live) => live.ticket);
      if (parentSessionId === undefined) return all;
      return all.filter((t) => t.parentSessionId === parentSessionId);
    },

    dispose(): void {
      // Ticket 137: plugin unload/HMR. Cancel every parked deny timer and drop
      // the tickets; the `closed` flag makes a timer that still fires (a
      // scheduler ignoring its cancel) a no-op, so no `onResolved` reaches a
      // disposed wake bus and no delivery lands on a disposed host.
      // Idempotent: the second call finds an empty map and re-sets the flag.
      closed = true;
      for (const live of byWorker.values()) {
        live.cancelTimeout();
      }
      byWorker.clear();
    },
  };
}
