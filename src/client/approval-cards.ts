/**
 * Approval-card projections (ticket 69 chunk B, design 2026-09-19 §3) — the
 * FROZEN shapes ticket 81 renders. Pure data: no React, no DOM, no Cordis;
 * asserted directly by offline tests (S8).
 *
 * Two card families, both presentation-time projections of existing truth —
 * never a second source of it:
 *
 * 1. **Access-ask cards** (`projectAccessAskCards`): projected from relay
 *    truth only — `Multitask.listPendingAccess` (the pending tickets) plus
 *    the wake bus's `access-resolved` notices. Posture denies (ticket 69
 *    chunk A) surface as `policy-denied` with the self-naming detail the
 *    core already put on the decision — decision provenance renders from the
 *    shipped `AccessDecision.reason` labels; no new reason kind exists.
 *    Ticket 30's anatomy is re-hosted as-is (its supersession record): the
 *    Allow / Always allow (this session) / Deny option set minus the
 *    wildcard-fenced always (`isWildcardAccessTarget`), clamped detail with
 *    the omission marker (`clampApprovalDetail`; the target name is never
 *    routed through the clamp), and the secret cardKind for credential asks.
 *    No `access-types.ts` shape is changed (chunk B invariant B3).
 *
 * 2. **Worker-dispatch cards** (`projectDispatchCard`): PRESENTATION-TIME
 *    ONLY (design §4, C15 holds) — projected from the dispatcher
 *    conversation's own `spawn_worker` tool-call record (the parsed call
 *    arguments and structured result), never from the relay or the wake bus.
 *    Replay-safe: the projection is a pure function of the durable record,
 *    so a replayed history window yields the identical card. The `gated`
 *    marker the spawn tool writes on a posture-gated approval (chunk A) and
 *    the `auto-review-refused` refusal reason give the honest `gating`
 *    provenance; no new wake kind, no ledger entry, no activation step.
 *
 * Location lines ride the ticket-71 AC-4 per-producer-kind label map through
 * the injectable {@link AccessAskCardLocationInput.locationFor} hook — the
 * documented re-base point (B2); the default resolves the dispatched-worker
 * kind, i.e. the local line. 81 must not hard-code a location constant.
 */

import {
  ACCESS_PROMPT_ALLOW,
  ACCESS_PROMPT_ALWAYS_ALLOW,
  ACCESS_PROMPT_DENY,
  APPROVAL_PRODUCER_KINDS,
  approvalLocationLineFor,
  clampApprovalDetail,
  isWildcardAccessTarget,
} from "../adapter/access-prompt.js";
import type {
  AccessDecision,
  AccessNotice,
  AccessRequestBody,
  AccessTicket,
} from "../core/access-types.js";

/** Frozen card kinds (design §3): the secret variant is the credential ask. */
export type AccessAskCardKind = "access-ask" | "secret-ask";

/** One selectable answer on an access-ask card. */
export type AccessAskOptionChoice = "allow" | "always-allow" | "deny";

export interface AccessAskOption {
  readonly kind: AccessAskOptionChoice;
  /**
   * Ticket 30's option copy, reused verbatim (the shipped host-side
   * constants — one copy vocabulary, never a second). En-only by the same
   * ticket-30 precedent; the card chrome around it localizes.
   */
  readonly label: string;
}

/** Frozen ask-card statuses: pending, honestly settled, or timed out. */
export type AccessAskCardStatus = "pending" | "resolved" | "expired";

/**
 * The frozen access-ask card shape (design §3.1). Everything here is relay
 * truth or ticket-30 presentation; nothing is invented client-side.
 */
export interface AccessAskCard {
  readonly cardKind: AccessAskCardKind;
  readonly requestId: string;
  readonly workerId: string;
  /** Worker display title, or the workerId when no title is known. */
  readonly workerTitle: string;
  /** Names only — never a credential value (access-types hard rule). */
  readonly body: AccessRequestBody;
  readonly parentSessionId: string;
  readonly createdAtMs: number;
  readonly status: AccessAskCardStatus;
  /** Present exactly when the card is settled (resolved or expired). */
  readonly decision?: AccessDecision;
  /**
   * Ticket 30's option set minus the wildcard-fenced always — exactly three
   * for an exact target, Allow/Deny only when the target carries `*`.
   */
  readonly optionSet: readonly AccessAskOption[];
  /** Resolved through the 71 AC-4 `locationFor` hook (never hard-coded). */
  readonly locationLine: string;
  /** Ticket 30's clamped reason + omission marker; target never clamped. */
  readonly detail: string;
}

/** The card minus the location line — the hook's input. */
export type AccessAskCardLocationInput = Omit<AccessAskCard, "locationLine">;

/**
 * Ticket 30's option set (same labels, same order, same fence), projected as
 * data: Allow / Always allow (this session) / Deny — degrading to Allow/Deny
 * for a wildcard-bearing target so consent can never cover a pattern.
 */
export function accessAskOptionSet(
  target: string,
): readonly AccessAskOption[] {
  if (isWildcardAccessTarget(target)) {
    return [
      { kind: "allow", label: ACCESS_PROMPT_ALLOW },
      { kind: "deny", label: ACCESS_PROMPT_DENY },
    ];
  }
  return [
    { kind: "allow", label: ACCESS_PROMPT_ALLOW },
    { kind: "always-allow", label: ACCESS_PROMPT_ALWAYS_ALLOW },
    { kind: "deny", label: ACCESS_PROMPT_DENY },
  ];
}

/**
 * Default {@link locationFor}: the ticket-71 AC-4 label map resolved for the
 * dispatched-worker producer kind — the local line today. 81 (or a future
 * feed that knows a richer producer kind) injects its own hook here; the
 * card contract never hard-codes the constant.
 */
export function defaultLocationFor(): string {
  return approvalLocationLineFor(APPROVAL_PRODUCER_KINDS.worker);
}

function asSecretAsk(body: AccessRequestBody): AccessAskCardKind {
  return body.class === "credential" ? "secret-ask" : "access-ask";
}

/**
 * Project the pending tickets + resolved notices into access-ask cards
 * (pure; the B1 frozen shape).
 *
 * - One card per pending ticket, status `pending` — relay truth outranks a
 *   possibly-skewed notice for the same worker (the relay parks at most one
 *   ask per worker, so workerId is the join).
 * - Each notice whose worker has no pending card settles a card: `expired`
 *   when the decision is the ADR-0008 timeout deny (the ticket is gone from
 *   the relay — it denied by default), `resolved` otherwise. `requestId` /
 *   `parentSessionId` / `createdAtMs` are joined from `remembered` (tickets
 *   a feed showed earlier); an unjoinable notice carries `""` / `""` / `0`
 *   as honest unknowns — it is informational only and renders no actions.
 */
export function projectAccessAskCards(
  pending: readonly AccessTicket[],
  notices: readonly AccessNotice[] = [],
  options: {
    /** Earlier pending tickets, kept so notices can join back to requestIds. */
    readonly remembered?: readonly AccessTicket[];
    /** Ticket 71 AC-4 hook — the documented re-base point (B2). */
    readonly locationFor?: (card: AccessAskCardLocationInput) => string;
    /** Worker display titles; absent → the workerId is the title. */
    readonly workerTitleOf?: (workerId: string) => string | null;
  } = {},
): readonly AccessAskCard[] {
  const locationFor = options.locationFor ?? defaultLocationFor;
  const cards: AccessAskCard[] = pending.map((ticket) => {
    const base: AccessAskCardLocationInput = {
      cardKind: asSecretAsk(ticket.body),
      requestId: ticket.requestId,
      workerId: ticket.workerId,
      workerTitle: options.workerTitleOf?.(ticket.workerId) ?? ticket.workerId,
      body: ticket.body,
      parentSessionId: ticket.parentSessionId,
      createdAtMs: ticket.createdAtMs,
      status: "pending",
      optionSet: accessAskOptionSet(ticket.body.target),
      detail: clampApprovalDetail(ticket.body.reason),
    };
    return { ...base, locationLine: locationFor(base) };
  });

  const pendingWorkers = new Set(pending.map((ticket) => ticket.workerId));
  for (const notice of notices) {
    if (pendingWorkers.has(notice.workerId)) continue;
    const rememberedTicket = options.remembered?.find(
      (ticket) => ticket.workerId === notice.workerId,
    );
    const expired =
      notice.decision.kind === "deny" &&
      notice.decision.reason === "timeout";
    const base: AccessAskCardLocationInput = {
      cardKind: asSecretAsk(notice.body),
      requestId: rememberedTicket?.requestId ?? "",
      workerId: notice.workerId,
      workerTitle:
        options.workerTitleOf?.(notice.workerId) ??
        (notice.title.length > 0 ? notice.title : notice.workerId),
      body: notice.body,
      parentSessionId: rememberedTicket?.parentSessionId ?? "",
      createdAtMs: rememberedTicket?.createdAtMs ?? 0,
      status: expired ? "expired" : "resolved",
      decision: notice.decision,
      optionSet: [],
      detail: clampApprovalDetail(notice.body.reason),
    };
    cards.push({ ...base, locationLine: locationFor(base) });
  }
  return cards;
}

// ── Worker-dispatch cards (design §3.2) — presentation-time only ──

/** Frozen gating provenance for a dispatch card. */
export type WorkerDispatchGating =
  | "ungated"
  | "approval-allowed"
  | "approval-refused";

/**
 * The frozen worker-dispatch card shape (design §3.2): `outcome` carries the
 * spawned worker id or the refusal reason; `gating` is the posture-gate
 * provenance derived from the record's own fields (`gated` marker /
 * `auto-review-refused` reason).
 */
export interface WorkerDispatchCard {
  readonly cardKind: "worker-dispatch";
  readonly toolCallId: string;
  readonly streamKey: string | null;
  readonly title: string | null;
  readonly outcome:
    | { readonly kind: "spawned"; readonly workerId: string }
    | { readonly kind: "refused"; readonly reason: string };
  readonly gating: WorkerDispatchGating;
}

/** One `spawn_worker` tool-call record from the conversation window. */
export interface SpawnToolCallRecord {
  readonly callId: string;
  /** Parsed raw arguments JSON (any shape — junk possible). */
  readonly args: unknown;
  /** Parsed structured result payload; `null` until the result lands. */
  readonly result: unknown;
}

/** Narrow `value` to a plain object record (arrays are not records here). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Project one `spawn_worker` tool-call record into the frozen dispatch card,
 * or `null` when no card may honestly render yet: an UNSETTLED call (no
 * result — the tool row's own running state is the pending presentation) or
 * a record too malformed to name a spawn (never a fabricated card). Pure in
 * the record → replay-safe by construction.
 */
export function projectDispatchCard(
  record: SpawnToolCallRecord,
): WorkerDispatchCard | null {
  const args = asRecord(record.args);
  const result = asRecord(record.result);
  if (result === null) return null; // unsettled: no outcome to present

  let outcome: WorkerDispatchCard["outcome"];
  const ok = result.ok;
  if (ok === true) {
    const workerId = asString(result.worker_id);
    if (workerId === null) return null; // malformed success: no card
    outcome = { kind: "spawned", workerId };
  } else if (ok === false) {
    outcome = {
      kind: "refused",
      reason: asString(result.reason) ?? "failed",
    };
  } else {
    return null; // no readable result shape: the generic row covers it
  }

  const refusedByReview =
    ok === false && result.reason === "auto-review-refused";
  const gating: WorkerDispatchGating = refusedByReview
    ? "approval-refused"
    : ok === true && result.gated === true
      ? "approval-allowed"
      : "ungated";

  return {
    cardKind: "worker-dispatch",
    toolCallId: record.callId,
    streamKey: asString(result.stream_key) ?? asString(args?.stream_key),
    title: asString(result.title) ?? asString(args?.title),
    outcome,
    gating,
  };
}

// ── The card store (81's data seam) ──

/**
 * The approval-cards store state. `unfed` — no relay-truth feed is wired
 * into this surface yet — is the honest UNKNOWN: the section renders
 * nothing, never a fabricated "nothing needs you" (only a live feed may say
 * that, by carrying zero pending asks). `ready` — a feed delivered relay
 * truth; zero cards then genuinely means nothing is waiting.
 */
export type ApprovalCardsState =
  | { readonly kind: "unfed" }
  | { readonly kind: "ready"; readonly cards: readonly AccessAskCard[] };

export interface ApprovalCardsStoreBox {
  readonly state: ApprovalCardsState;
  readonly version: number;
}

/**
 * The store the conversation surface's approval-cards section binds. Pure
 * data + the projection: the feed calls `applyRelayTruth` with relay truth
 * (`Multitask.listPendingAccess` + the resolved-access notices); the store
 * keeps the tickets it has seen so a later notice can join back to its
 * requestId (AccessNotice carries workerId only), and re-projects. No
 * resolution transport lives here — answering is the host seat 81's
 * composition injects (the live wiring is ticket 69's L1 lane).
 */
export interface ApprovalCardsStore {
  subscribe(listener: () => void): () => void;
  getBox(): ApprovalCardsStoreBox;
  /** Feed: one relay-truth snapshot (pending tickets + resolved notices). */
  applyRelayTruth(
    pending: readonly AccessTicket[],
    notices?: readonly AccessNotice[],
  ): void;
}

export function createApprovalCardsStore(options: {
  /** Ticket 71 AC-4 hook; default resolves the dispatched-worker kind. */
  readonly locationFor?: (card: AccessAskCardLocationInput) => string;
  readonly workerTitleOf?: (workerId: string) => string | null;
} = {}): ApprovalCardsStore {
  let state: ApprovalCardsState = { kind: "unfed" };
  let version = 0;
  let box: ApprovalCardsStoreBox = { state, version };
  const listeners = new Set<() => void>();
  /** Every pending ticket the feed ever showed — the notice join memory. */
  const remembered: AccessTicket[] = [];

  function emit(next: ApprovalCardsState): void {
    state = next;
    version += 1;
    box = { state, version };
    for (const listener of [...listeners]) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getBox() {
      return box;
    },
    applyRelayTruth(pending, notices = []) {
      for (const ticket of pending) {
        if (!remembered.some((row) => row.requestId === ticket.requestId)) {
          remembered.push(ticket);
        }
      }
      emit({
        kind: "ready",
        // Conditional spreads (not bare `options.X`): with
        // exactOptionalPropertyTypes an optional-prop read is `T | undefined`
        // and may not be assigned to the projection's optional `locationFor?`/
        // `workerTitleOf?` props. Runtime behavior unchanged — undefined was
        // already the "absent" value inside the projection's defaults.
        // (2026-09-19, ticket 85 agent: HEAD 9bcdd4d shipped this call and
        // `npm run typecheck` went red for every agent in the tree.)
        cards: projectAccessAskCards(pending, notices, {
          remembered,
          ...(options.locationFor !== undefined && {
            locationFor: options.locationFor,
          }),
          ...(options.workerTitleOf !== undefined && {
            workerTitleOf: options.workerTitleOf,
          }),
        }),
      });
    },
  };
}
