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
}

const APPROVAL_OUTCOMES: readonly string[] = [
  "allowed-once",
  "rejected",
  "cancelled",
  "unavailable",
];

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
      const outcome = await (
        service as HostApprovalServiceLike
      ).request({
        agent,
        toolName,
        reason:
          `auto-review gate: dispatch "${request.title}" ` +
          `(${request.streamKey}) needs approval before it can spawn`,
      });
      return APPROVAL_OUTCOMES.includes(outcome as string)
        ? (outcome as DispatchApprovalOutcome)
        : "unavailable";
    } catch {
      // A throwing answerer is an absent answerer (fail-closed).
      return "unavailable";
    }
  };
}
