/**
 * The dispatch approval seam's live face (ticket 69, L3 offline half).
 *
 * Chunk A left `requestDispatchApproval` an INJECTED dep of the spawn tool,
 * deliberately absent live: the seam must be raised against the host's
 * approval answerer — `ctx.approval` (`@deepseek-ai/dsh-user-approval`,
 * `ApprovalService.request`; the face is documented at
 * `docs/research/dsh-adapter-api-notes.md:220-247` and the inject note at
 * `:390`; the service declares itself on the Cordis Context as
 * `approval` — `dsh-user-approval/lib/types/index.d.ts`). This module is
 * that wiring, factored as a pure builder so the OFFLINE half is testable:
 * the seam reads the service lazily (it may materialize after apply),
 * scopes the ask to the activated dispatcher's own Agent (a UI answerer
 * only answers for agents it owns — the service's routing rule), and
 * degrades to `unavailable` — the fail-closed outcome — whenever the
 * answerer face is absent, not a function, throws, or returns anything
 * outside the outcome vocabulary. Chunk A's gate turns a non-`allowed-once`
 * outcome into an honest `auto-review-refused` spawn result, so a gated
 * dispatch with NO live answerer refuses and the dispatcher re-plans — it
 * never wedges the turn (design §6 Q2's offline half).
 *
 * The Q2 pins originally assumed the answerer RETURNS an outcome. Live
 * pass 5 Session B-3 (FINDING 3) showed it can be absent-AND-SILENT: an
 * unanswered `ctx.approval.request` wedged a dispatcher turn, because the
 * await above had no time bound (dispatch approvals ride the seam's own
 * cancellation — no core timer). The request is therefore wrapped in a
 * bounded wait with the relay's ADR-0008 deadline semantics: an ask
 * unanswered at the deadline collapses to this seam's existing fail-closed
 * `unavailable` refusal, so the turn settles exactly as for any other
 * refusal (the gate's `auto-review-refused` spawn result is the durable
 * record — dispatch approvals have no approval-feed entry; the relay feed
 * carries access asks only).
 *
 * The client-side half of the answerer waterfall is the shipped
 * `dsh-client-ui-approval` composer (it consumes the forwarded
 * `approval/request` Remote waterfall event — `dsh-api-remotes`
 * `API_REMOTE_FORWARDED_EVENTS`); whether that composer still mounts under
 * the wrapper's root frame is the LIVE lane's verification (L3), not
 * decided here.
 *
 * Structural only — no import of `@deepseek-ai/dsh-user-approval` (peer
 * surface). All copy original.
 */

import type {
  DispatchApprovalFn,
  DispatchApprovalOutcome,
} from "../core/tools.js";
import { DEFAULT_ACCESS_TIMEOUT_MS } from "../core/access-relay.js";

/** Re-exported so the adapter barrel can surface the seam's own type. */
export type { DispatchApprovalFn };

/**
 * Structural view of the host approval service (`ctx.approval`): only the
 * one verb the seam needs. The full service also carries `setPolicy` /
 * `overrideOf` — deliberately unread here (no policy mutation from this
 * path; the delegation pin and session policy are not ours to touch).
 */
export interface HostApprovalServiceLike {
  request(request: {
    /** The agent on whose behalf the question is asked (routes the ask). */
    agent: unknown;
    /** The tool the question is about (presentation and audit). */
    toolName: string;
    /** The asker's human-readable explanation of WHY it is asking. */
    reason?: string;
  }): Promise<unknown>;
}

/** The spawn tool name the seam presents to the answerer. */
export const DISPATCH_APPROVAL_TOOL_NAME = "spawn_worker";

export interface DispatchApprovalSeamOptions {
  /**
   * Lazy read of the host approval service (`ctx.approval`). Lazy because
   * host services can materialize after the plugin applies; an absent or
   * malformed service degrades every ask to `unavailable` (fail-closed).
   */
  readonly getApproval: () => unknown;
  /**
   * Lazy read of the activated dispatcher's live Agent — the ask is scoped
   * to it so only an answerer for that agent's session may answer.
   */
  readonly getAgent: () => unknown;
  /** Override the presented tool name; defaults to {@link DISPATCH_APPROVAL_TOOL_NAME}. */
  readonly toolName?: string;
  /**
   * Deadline for the host answerer, in ms (FINDING 3). Same semantics as
   * the relay's armed ADR-0008 timeout: an ask unanswered at the deadline
   * fails closed — the seam returns its existing `unavailable` refusal.
   * Default `DEFAULT_ACCESS_TIMEOUT_MS` (120_000, the ADR-0008 constant in
   * `src/core/access-relay.ts` — reused, not a new policy; no new Config
   * surface). Tests inject a tiny value.
   */
  readonly timeoutMs?: number;
}

const APPROVAL_OUTCOMES: readonly string[] = [
  "allowed-once",
  "rejected",
  "cancelled",
  "unavailable",
];

/** Guard the injectable deadline: a malformed value falls back to the ADR-0008 default (fail-closed). */
function resolveTimeoutMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_ACCESS_TIMEOUT_MS;
}

/**
 * Await the host answerer, but never longer than `timeoutMs` — the seam's
 * mirror of the relay's armed ADR-0008 timeout (`access-relay.ts` schedules
 * the same shape: unanswered → deny at the deadline). Deadline rejection
 * propagates to the caller's fail-closed catch. The loser of the race is
 * harmless: `Promise.race` holds handlers on both promises, so a late
 * rejection of the underlying ask can never surface as unhandled, and the
 * timer is cleared the moment either side settles (no lingering handle).
 */
function boundedAsk(
  asked: Promise<unknown>,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("dispatch approval ask: deadline reached")),
      timeoutMs,
    );
  });
  return Promise.race([asked, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Build the `requestDispatchApproval` seam over the host approval service
 * (ticket 69 design §4). Never throws: every failure mode below the caller
 * (the spawned dispatcher's turn, which must keep re-planning) collapses to
 * the `unavailable` outcome, which the chunk-A gate refuses on.
 */
export function createDispatchApprovalSeam(
  options: DispatchApprovalSeamOptions,
): DispatchApprovalFn {
  const toolName = options.toolName ?? DISPATCH_APPROVAL_TOOL_NAME;
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  return async (request) => {
    let service: unknown;
    try {
      service = options.getApproval();
    } catch {
      return "unavailable";
    }
    if (
      typeof service !== "object" ||
      service === null ||
      typeof (service as HostApprovalServiceLike).request !== "function"
    ) {
      return "unavailable";
    }
    let agent: unknown;
    try {
      agent = options.getAgent();
    } catch {
      return "unavailable";
    }
    if (agent === undefined || agent === null) return "unavailable";
    try {
      const asked = (service as HostApprovalServiceLike).request({
        agent,
        toolName,
        reason:
          `auto-review gate: dispatch "${request.title}" ` +
          `(${request.streamKey}) needs approval before it can spawn`,
      });
      // FINDING 3: bounded wait — a silent answerer cannot wedge the turn;
      // the deadline lands in the catch below as the fail-closed refusal.
      const outcome = await boundedAsk(asked, timeoutMs);
      return APPROVAL_OUTCOMES.includes(outcome as string)
        ? (outcome as DispatchApprovalOutcome)
        : "unavailable";
    } catch {
      // A throwing answerer is an absent answerer (fail-closed) — and so is
      // one that never answers: the ADR-0008-shaped deadline lands here too.
      return "unavailable";
    }
  };
}
