/**
 * Review-posture table (ticket 69, chunk A; ADR-0018 in-scope area
 * "classifier-gated auto-review"). Session-scoped deterministic posture over
 * relay asks and worker dispatches — NOT an LLM classifier layer (U-D
 * fidelity stop, design 2026-09-19 §2): no persistence beyond session scope,
 * no settings-managed store, no silent allow outside the ask pathway, no
 * approve tool.
 *
 * The table is composed AFTER the consent policy table at the `lookupPolicy`
 * wiring (`multitask.ts`): a consent decision (allow or deny) always wins;
 * only a consent "ask" miss falls through here; a posture miss is still
 * "ask", which lands on the shipped park/wake/timeout path. The relay's
 * auto-answer branch and ADR-0008 armed timeout are reused verbatim — this
 * table only feeds them. Shipped posture is EMPTY: with no rows every ask
 * escalates exactly as before, so un-configured behavior is byte-identical.
 *
 * `src/core/access-relay.ts` and `access-types.ts` are untouched by design.
 */

import type {
  AccessClass,
  AccessDecision,
  AccessRequestBody,
  PolicyLookupCtx,
} from "./access-types.js";
import { matchTargetPattern } from "./access-relay.js";

/**
 * Ask kinds a posture row can answer. An `AccessClass` gates worker access
 * asks (same classes the consent table matches); the literal
 * `"worker-dispatch"` producer kind gates spawn dispatches (design §4).
 */
export type ReviewPostureClass = AccessClass | "worker-dispatch";

/** One review-posture row. Consent-table shape, one more ask kind. */
export interface ReviewPostureEntry {
  readonly class: ReviewPostureClass;
  /**
   * Exact or prefix match on the ask target (worker dispatch: the spawn
   * title), using the consent table's `matchTargetPattern` semantics.
   * `set()` refuses `*`-bearing patterns (wildcard fence below), so through
   * the write path only exact targets are remembered.
   */
  readonly targetPattern: string;
  readonly decision: "allow" | "deny";
  /** "session" = this dispatcher session only; "profile" = install-wide default. */
  readonly scope: "session" | "profile";
  /**
   * Owning dispatcher session id (ADR-0019 keying, mirroring
   * `PolicyEntry.session`): a row answers only asks from its own session,
   * and a session-scope clear drops only that session's rows — never a
   * sibling's. Optional: an un-owned row behaves as the shipped legacy row
   * (applies to any session, cleared by any session-scope clear).
   */
  readonly session?: string;
}

/**
 * The posture deny detail names the auto-review posture itself (design §2:
 * "policy-denied, deny detail names the auto-review posture — new copy").
 * New copy, ours; rendered through the shipped `wrapAccessDecision` deny
 * path and `AccessDecision.reason` label "policy-denied".
 */
export function reviewPostureDenyDetail(
  askClass: ReviewPostureClass,
  target: string,
): string {
  const named = target.length > 0 ? target : "(unnamed)";
  return `auto-review posture denied ${askClass} "${named}"`;
}

/** Wildcard fence (ticket 69 §2, extends ticket 30's sink fence): `*` is the only metacharacter the target matching treats specially, so a posture write with a `*`-bearing target is refused — defense-in-depth at the sink, mirroring the consent sink's fence. A posture row must never remember a whole class or prefix of targets. */
function isWildcardPattern(pattern: string): boolean {
  return pattern.includes("*");
}

/** Same keying rules as the consent table (ADR-0019): the owning session joins the key so sibling dispatchers never evict each other's rows; un-owned rows keep the legacy single-slot key. */
function rowKey(entry: ReviewPostureEntry): string {
  return `${entry.scope}\u0000${entry.session ?? ""}\u0000${entry.class}\u0000${entry.targetPattern}`;
}

/** Attributed session rows answer only their own session (un-owned rows apply to any). */
function sessionRowApplies(
  entry: ReviewPostureEntry,
  parentSessionId: string,
): boolean {
  return entry.session === undefined || entry.session === parentSessionId;
}

/** Posture decision for one ask kind, or undefined when no row hits. */
type PostureHit = AccessDecision | undefined;

export interface ReviewPostureTable {
  /**
   * Worker access-ask posture. Consulted ONLY after the consent table
   * returned "ask". Returns "ask" on a posture miss (escalate-to-human:
   * the shipped park/prompt/timeout path, ADR-0008 timeout intact).
   */
  lookup(req: AccessRequestBody, ctx: PolicyLookupCtx): AccessDecision | "ask";
  /**
   * Worker-dispatch posture for a spawn title (design §4). Returns the row
   * decision, or undefined when no dispatch row hits — undefined means the
   * spawn proceeds exactly as shipped with no approval-seam call. An allow
   * row marks the dispatch class as gated (the host approval seam decides);
   * a deny row refuses outright (auto-deny: policy already decided).
   */
  lookupDispatch(
    title: string,
    ctx: PolicyLookupCtx,
  ): AccessDecision | undefined;
  /**
   * Insert or replace a row (same scope+session+class+pattern key).
   * Returns false WITHOUT writing when the target pattern carries a `*`
   * (wildcard fence) — deny stays the default on any ambiguity.
   */
  set(entry: ReviewPostureEntry): boolean;
  /** Stored rows (status/tests). */
  list(): readonly ReviewPostureEntry[];
  /**
   * Drop session-scope posture rows, same attribution rules as the consent
   * table's clearance (ticket 30 + ADR-0019): WITH a session id only that
   * session's rows go (un-owned legacy rows go too); without one, every
   * session-scope row goes (plugin unload). Profile rows are untouched.
   * Wired through `Multitask.clearSessionAccessPolicy` — a posture row
   * never outlives its session.
   */
  clearSession(sessionId?: string): void;
}

/**
 * Create the review-posture table. No seed parameter by design (ticket 69
 * §2): posture rows enter only through `set()` — via Multitask APIs (tests
 * now; any real seeder is a human decision) — and the shipped posture is
 * EMPTY, so un-configured behavior is byte-identical.
 *
 * The empty default is DELIBERATE, ruled 2026-09-19 on ticket 69 Q1
 * (overnight dispatched ruling, subject to human reversal): a non-empty
 * shipped default or a Config/settings-seeded posture would auto-answer
 * access prompts without an explicit user act. That contradicts ADR-0018's
 * exception U-D (no persisted rules, no settings-managed controller) and
 * ADR-0011's "consent can never silently widen"; it is also invented policy,
 * since the reference's classifier decision inputs were never recovered
 * (research depth limit). Posture content therefore enters only through an
 * explicit in-session act (session-scope rows, wildcard-fenced, cleared with
 * the session). Any future non-empty default or Config seeder is a U-D
 * amendment and needs a human signature first. The `profile` scope slot
 * exists for consent-table shape parity and is cross-session by nature —
 * seeding it is the same U-D amendment.
 */
export function createReviewPostureTable(): ReviewPostureTable {
  const rows = new Map<string, ReviewPostureEntry>();

  function hit(
    target: string,
    askClass: ReviewPostureClass,
    scope: ReviewPostureEntry["scope"],
    parentSessionId: string,
  ): PostureHit {
    for (const entry of rows.values()) {
      if (entry.scope !== scope) continue;
      if (entry.class !== askClass) continue;
      if (
        scope === "session" &&
        !sessionRowApplies(entry, parentSessionId)
      ) {
        continue;
      }
      if (!matchTargetPattern(entry.targetPattern, target)) continue;
      if (entry.decision === "allow") return { kind: "allow" };
      return {
        kind: "deny",
        reason: "policy-denied",
        detail: reviewPostureDenyDetail(askClass, target),
      };
    }
    return undefined;
  }

  return {
    lookup(req, ctx): AccessDecision | "ask" {
      return (
        hit(req.target, req.class, "session", ctx.parentSessionId) ??
        hit(req.target, req.class, "profile", ctx.parentSessionId) ??
        "ask"
      );
    },

    lookupDispatch(title, ctx): AccessDecision | undefined {
      return (
        hit(title, "worker-dispatch", "session", ctx.parentSessionId) ??
        hit(title, "worker-dispatch", "profile", ctx.parentSessionId)
      );
    },

    set(entry: ReviewPostureEntry): boolean {
      // Wildcard fence: a posture write never remembers a pattern.
      if (isWildcardPattern(entry.targetPattern)) return false;
      rows.set(rowKey(entry), entry);
      return true;
    },

    list(): readonly ReviewPostureEntry[] {
      return [...rows.values()];
    },

    clearSession(sessionId?: string): void {
      for (const [key, entry] of [...rows]) {
        if (entry.scope !== "session") continue;
        if (sessionId === undefined || sessionRowApplies(entry, sessionId)) {
          rows.delete(key);
        }
      }
    },
  };
}
