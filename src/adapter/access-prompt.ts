/**
 * Access-request prompt surface (ticket 23, design-16 §4.4).
 *
 * Surfaces ticket-13's pending access asks to the user through dsh's
 * EXISTING host prompt seam — `ctx.userQuestions.ask` (research Finding 3,
 * `dsh-user-questions` contract: `{questions: [{id, question, detail?,
 * options?: [{label}], ...}], agent?, signal?}` → `{answers: [{id,
 * selected}]}`) — and routes each explicit answer into the UNCHANGED core
 * relay via `Multitask.resolveAccess` (the same entry point a conversational
 * answer uses). This module is presentation only: it never re-implements the
 * relay's timeout, decision, or delivery plumbing, and it never claims the
 * shipped-owned `conversation.approval.detail` slot (design-16 §4.4
 * forbidden list). No new prompt pathway is invented.
 *
 * ADR-0008 is preserved exactly: the core relay arms the deny-by-default
 * timeout when the ticket parks; an unanswered (or dismissed, or unknown)
 * prompt resolves nothing here, so the ticket falls to the existing timeout.
 * A deactivation aborts outstanding prompts; their tickets still time out.
 *
 * Dedupe rule (one presentation per ask at a time):
 * - While a dispatcher session is activated AND the prompt seam is present,
 *   every pending ask of that session is prompt-presented and suppressed
 *   from conversational wake rendering (plugin's composeWakeText filters by
 *   `suppressesConversational`).
 * - While dormant (or when the seam is absent entirely) the shipped
 *   conversational relay is the presentation — nothing is suppressed and no
 *   prompt is emitted.
 * - If the seam fails for one ask (throws / contract drift), that ask is
 *   released: suppression turns off for it and it is re-queued through the
 *   core wake bus (`enqueueAccessRequest` — the same conversational enqueue
 *   the relay itself uses) so the shipped fallback renders it. A released
 *   ask is never re-prompted.
 *
 * Secrets rule (ticket 13): payloads carry class/action metadata only —
 * names, never values; `AccessRequestBody` / `AccessDecision` have no value
 * field.
 *
 * Ticket 30 (design-17 §4.5) upgrades the prompt's copy and options without
 * touching relay semantics:
 * - Option set Allow / **Always allow (this session)** / Deny. "Always"
 *   inserts a SESSION-scope allow row (class + exact target fingerprint)
 *   through the relay's existing policy table, then routes the same allow
 *   decision as "Allow". A later matching ask auto-answers on the shipped
 *   policy no-op path (no prompt, no wake). Boundary: profile/preset writes
 *   are OUT OF SCOPE — mutating stored user presets from a prompt is a
 *   consent trap; session rows are cleared on deactivation/unload via
 *   `Multitask.clearSessionAccessPolicy` so "always" never outlives the
 *   session (ADR-0011).
 * - Wildcard fence: a worker-supplied target containing `*` (the policy
 *   pattern metacharacter — `matchTargetPattern`: a bare `*` matches every
 *   target in the class, a trailing `*` a prefix) is never offered the
 *   "Always allow" option; the ask degrades to Allow / Deny, and an
 *   always-shaped answer that still arrives (constructed or queued) resolves
 *   as a plain one-shot allow without ever being recorded as a row. Consent
 *   always covers the exact target shown, never a class or prefix pattern.
 * - Location line: workers are local dsh child sessions, so every prompt
 *   detail carries the constant honest line "Runs on your computer.".
 * - Clamped detail: the reason text is hard-cut at `APPROVAL_DETAIL_CLAMP_CHARS`
 *   with an explicit omission marker (report-clamp pattern). The target name
 *   is never truncated.
 * - Expired answers: an explicit answer for a ticket that already left the
 *   relay (ADR-0008 timeout deny, or cleared) surfaces honest
 *   `approval.expired` copy through the wake bus and resolves nothing.
 * - Secret copy: an ALLOWED credential ask surfaces the "stored securely,
 *   never shown" reassurance as its post-decision notice — name only, never
 *   a value.
 *
 * Structural only — no import of `@deepseek-ai/dsh-user-questions` (peer
 * surface). All copy is original clean-room text (design-16 §6, design-17 §7).
 */

import type {
  AccessDecision,
  AccessNotice,
  AccessRequestBody,
  AccessTicket,
} from "../core/access-types.js";

/** Option label for approving the ask (design-16 §6). */
export const ACCESS_PROMPT_ALLOW = "Allow";

/**
 * Option label for the session-scope always-allow (ticket 30, design-17 §7
 * `approval.option.always-session`). Session scope only — never a profile
 * or preset write.
 */
export const ACCESS_PROMPT_ALWAYS_ALLOW = "Always allow (this session)";

/** Option label for refusing the ask (design-16 §6). */
export const ACCESS_PROMPT_DENY = "Deny";

/**
 * Worker-facing detail recorded on a prompt denial. Rendered inside the
 * relay's deny wrapper ("Detail: …") and kept deliberately plain.
 */
export const ACCESS_PROMPT_DENY_DETAIL = "denied from the access prompt";

/**
 * Constant location line on every prompt detail (ticket 30, design-17 §7
 * `approval.location.local`): workers are local dsh child sessions, so the
 * line is constant until a non-local producer kind ever lands (design-17
 * conflict 6).
 */
export const APPROVAL_LOCATION_LOCAL = "Runs on your computer.";

/**
 * Copy surfaced when an explicit answer arrives for a ticket the relay has
 * already resolved (ADR-0008 timeout deny) or dropped (ticket 30,
 * design-17 §7 `approval.expired`). Nothing is resolved a second time.
 */
export const APPROVAL_EXPIRED_COPY =
  "This request already expired and was denied by default.";

/**
 * Post-decision reassurance for an ALLOWED credential ask (ticket 30,
 * design-17 §7 `approval.secret.stored`). Names-never-values invariant
 * untouched: the notice names the credential, never a value.
 */
export const APPROVAL_SECRET_STORED_COPY =
  "Saved. The value is stored securely and is never shown to workers or in this chat.";

/**
 * Max characters of an ask's reason text rendered in the prompt detail
 * (ticket 30; design-17 §4.5 "a few hundred chars").
 */
export const APPROVAL_DETAIL_CLAMP_CHARS = 240;

/** Omission marker appended after a hard detail cut (design-17 §7). */
export function approvalDetailOmissionMarker(omittedChars: number): string {
  return `… [+${omittedChars} more characters]`;
}

/**
 * Hard character cut for rendered reason text (report-clamp pattern).
 * Empty string stays empty; over-limit text is cut at `limit` and closed
 * with the omission marker carrying the omitted count. The ask's target
 * name is never routed through this — it is rendered whole or not at all.
 */
export function clampApprovalDetail(
  raw: string,
  limit: number = APPROVAL_DETAIL_CLAMP_CHARS,
): string {
  const text = raw.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}${approvalDetailOmissionMarker(text.length - limit)}`;
}

/** One selectable answer offered to the user (shipped contract shape). */
export interface AccessPromptOptionLike {
  readonly label: string;
  readonly description?: string;
}

/** One question in a user-questions request (shipped contract shape). */
export interface AccessPromptQuestionLike {
  /** Stable caller-provided question id, echoed in the answer. */
  readonly id: string;
  /** The question to display. */
  readonly question: string;
  /** Optional supporting detail rendered with the question. */
  readonly detail?: string;
  /** Optional choices the UI can render as a menu. */
  readonly options?: readonly AccessPromptOptionLike[];
}

/** Request passed to the host prompt seam (shipped contract shape). */
export interface AccessPromptRequestLike {
  readonly questions: readonly AccessPromptQuestionLike[];
  /** Agent identity scoping the ask (the activated dispatcher chat). */
  readonly agent?: unknown;
  /** Cancellation lifetime of the pending request. */
  readonly signal?: AbortSignal;
}

/** Answer to one question (shipped contract shape). */
export interface AccessPromptAnswerItemLike {
  readonly id: string;
  readonly selected: readonly string[];
  readonly custom?: string;
}

/** The human's answer (shipped contract shape). */
export interface AccessPromptAnswerLike {
  readonly answers: readonly AccessPromptAnswerItemLike[];
}

/** Structural view of `ctx.userQuestions` (dsh-user-questions service). */
export interface UserQuestionsLike {
  ask(request: AccessPromptRequestLike): Promise<AccessPromptAnswerLike>;
}

/** Stable question id for an access ask (echoed in the answer). */
export function accessPromptQuestionId(requestId: string): string {
  return `access:${requestId}`;
}

/**
 * Human phrase for what the worker needs approval to do. Class + target
 * metadata only — for credentials this is the credential NAME, never a
 * value (ticket 13 invariant).
 */
export function describeAccessAction(body: AccessRequestBody): string {
  const target = body.target.length > 0 ? body.target : "(unnamed)";
  switch (body.class) {
    case "tool":
      return `use the tool "${target}"`;
    case "credential":
      return `use the credential "${body.credentialName ?? target}"`;
    case "network":
      return `reach the network target "${target}"`;
    case "filesystem":
      return `access the path "${target}"`;
    default:
      return `perform "${target}"`;
  }
}

/**
 * Wildcard fence (ticket 30): `*` is the only metacharacter
 * `matchTargetPattern` treats specially — a bare `*` matches every target in
 * the class, a trailing `*` a prefix. Targets arrive from workers untrusted,
 * so a target containing `*` anywhere is never eligible for "Always allow":
 * consent always covers the exact target shown, never a class or prefix
 * pattern.
 */
export function isWildcardAccessTarget(target: string): boolean {
  return target.includes("*");
}

/**
 * Build the structured user question for a pending access ask.
 * Question copy is the design-16 §6 template; the detail carries the
 * (clamped) reason plus the constant location line on every prompt
 * (ticket 30). Options: Allow / Always allow (this session) / Deny —
 * minus the always option when the target carries a pattern wildcard
 * (wildcard fence, ticket 30).
 */
export function accessPromptQuestion(ticket: {
  workerId: string;
  requestId: string;
  body: AccessRequestBody;
}): AccessPromptQuestionLike {
  const reason = clampApprovalDetail(ticket.body.reason);
  const detail =
    reason.length > 0
      ? `${reason}\n\n${APPROVAL_LOCATION_LOCAL}`
      : APPROVAL_LOCATION_LOCAL;
  return {
    id: accessPromptQuestionId(ticket.requestId),
    question: `Worker ${ticket.workerId} needs approval to ${describeAccessAction(ticket.body)}.`,
    detail,
    options: isWildcardAccessTarget(ticket.body.target)
      ? [{ label: ACCESS_PROMPT_ALLOW }, { label: ACCESS_PROMPT_DENY }]
      : [
          { label: ACCESS_PROMPT_ALLOW },
          { label: ACCESS_PROMPT_ALWAYS_ALLOW },
          { label: ACCESS_PROMPT_DENY },
        ],
  };
}

/**
 * Parse a seam answer into an explicit choice. Returns "allow" /
 * "always-allow" / "deny" only for an answer item whose id matches and
 * whose selected labels name one of our options; anything else (dismissed,
 * custom text, unknown labels, missing answers) returns null so the relay's
 * armed timeout keeps the deny-by-default decision (ADR-0008) — a missing
 * answer is never invented into a decision here.
 */
export function parseAccessPromptAnswer(
  answer: AccessPromptAnswerLike | undefined,
  questionId: string,
): "allow" | "always-allow" | "deny" | null {
  if (answer === undefined) return null;
  const answers = answer.answers;
  if (!Array.isArray(answers)) return null;
  for (const item of answers) {
    if (item === null || typeof item !== "object") continue;
    if (item.id !== questionId) continue;
    const selected = Array.isArray(item.selected) ? item.selected : [];
    const allow = selected.includes(ACCESS_PROMPT_ALLOW);
    const always = selected.includes(ACCESS_PROMPT_ALWAYS_ALLOW);
    const deny = selected.includes(ACCESS_PROMPT_DENY);
    // Single-select in practice; if a UI ever returns several, fail closed:
    // deny wins over any allow shape (ADR-0008 spirit — never allow on
    // ambiguity), and "always" wins over plain allow (the stronger consent).
    if (deny) return "deny";
    if (always) return "always-allow";
    if (allow) return "allow";
    return null;
  }
  return null;
}

/**
 * Honest post-expiry notice (ticket 30): the ticket already timed out and
 * was denied by default (ADR-0008), so the notice carries the expired copy
 * as a timeout deny's detail. The wake bus renders it in the Resolved
 * section; nothing is resolved a second time.
 */
export function accessExpiredNotice(
  ticket: AccessTicket,
  title?: string,
): AccessNotice {
  return {
    kind: "access-resolved",
    workerId: ticket.workerId,
    title: title !== undefined && title.length > 0 ? title : ticket.workerId,
    decision: { kind: "deny", reason: "timeout", detail: APPROVAL_EXPIRED_COPY },
    body: ticket.body,
  };
}

/**
 * Post-decision notice for an ALLOWED credential ask (ticket 30): carries
 * the stored-securely reassurance as the allow note. The body carries the
 * credential NAME only — never a value (ticket 13 invariant).
 */
export function secretStoredAccessNotice(
  ticket: AccessTicket,
  title?: string,
): AccessNotice {
  return {
    kind: "access-resolved",
    workerId: ticket.workerId,
    title: title !== undefined && title.length > 0 ? title : ticket.workerId,
    decision: { kind: "allow", note: APPROVAL_SECRET_STORED_COPY },
    body: ticket.body,
  };
}

export interface AccessPromptPumpOptions {
  /**
   * Host prompt seam (`ctx.userQuestions`). Absent → the pump is inert and
   * the shipped conversational relay remains the only presentation
   * (ticket 23 fallback clause).
   */
  readonly userQuestions?: UserQuestionsLike;
  /** Whether a dispatcher session is currently activated. */
  readonly isActive: () => boolean;
  /** Pending asks of the activated dispatcher session (may be empty). */
  readonly listPending: () => readonly AccessTicket[];
  /**
   * Route an explicit answer into the core relay — `Multitask.resolveAccess`,
   * the same entry point a conversational answer uses. Idempotent in the
   * core: a late answer after a timeout deny is a no-op there.
   */
  readonly resolve: (workerId: string, decision: AccessDecision) => boolean;
  /**
   * Ticket 30: insert a session-scope allow row (class + exact target) into
   * the relay's existing policy table so future matching asks auto-answer
   * on the shipped policy no-op path. Session scope ONLY — profile/preset
   * writes are a consent trap and are deliberately not plumbed here. The
   * pump never calls this for a wildcard-bearing target (wildcard fence,
   * ticket 30), so `targetPattern` is always an exact target.
   */
  readonly alwaysAllow?: (ticket: AccessTicket) => void;
  /**
   * Ticket 30: an explicit answer arrived for a ticket that already left
   * the relay (timeout deny / cleared). Surface honest expired copy
   * conversationally; the pump resolves nothing for it.
   */
  readonly notifyExpired?: (ticket: AccessTicket) => void;
  /**
   * Ticket 30: an ALLOW decision was routed for a credential ask. Surface
   * the names-never-values "stored securely" reassurance as the
   * post-decision notice.
   */
  readonly notifySecretStored?: (ticket: AccessTicket) => void;
  /**
   * Live agent scoping the ask (the activated dispatcher chat), or
   * undefined to omit scoping.
   */
  readonly getAgent?: () => unknown;
  /**
   * Conversational fallback for a released ask: re-queue it through the
   * core wake bus (the same `enqueueAccessRequest` call the relay makes).
   * Optional; without it a released ask simply falls to the timeout.
   */
  readonly requeueConversational?: (ticket: AccessTicket) => void;
}

export interface AccessPromptPump {
  /**
   * Present any not-yet-presented pending asks as prompts. Idempotent and
   * safe to call often: one prompt per ask at a time, no re-prompts.
   */
  sync(): void;
  /** Whether this ask is currently presented as a prompt. */
  isPrompted(requestId: string): boolean;
  /**
   * Conversational-suppression predicate (dedupe rule — see module doc).
   * True while the prompt surface owns this ask for an activated session
   * with a present seam; false for released asks, dormant sessions, or a
   * seam-less plugin.
   */
  suppressesConversational(requestId: string): boolean;
  /**
   * Abandon every outstanding prompt (deactivation / unload): aborts the
   * seam requests and clears state. Tickets are untouched — their armed
   * relay timeouts still deny by default (ADR-0008). A later sync() may
   * re-present an ask that is still pending.
   */
  reset(): void;
}

interface OutstandingPrompt {
  readonly ticket: AccessTicket;
  readonly controller: AbortController;
}

/**
 * Create the prompt pump. All decisions still live in the core relay; the
 * pump only chooses the presentation and forwards explicit user answers.
 */
export function createAccessPromptPump(
  options: AccessPromptPumpOptions,
): AccessPromptPump {
  /** requestId → outstanding prompt (currently presented). */
  const outstanding = new Map<string, OutstandingPrompt>();
  /** Released asks (seam failed): never re-prompted; conversational again. */
  const released = new Set<string>();

  const seam = options.userQuestions;

  function dropState(requestId: string): void {
    outstanding.delete(requestId);
  }

  async function askOne(
    ticket: AccessTicket,
    controller: AbortController,
  ): Promise<void> {
    try {
      if (seam === undefined) return;
      const agent = options.getAgent?.();
      const answer = await seam.ask({
        questions: [accessPromptQuestion(ticket)],
        ...(agent === undefined ? {} : { agent }),
        signal: controller.signal,
      });
      const choice = parseAccessPromptAnswer(
        answer,
        accessPromptQuestionId(ticket.requestId),
      );
      if (choice === null) {
        // Dismissed / unanswered / unknown — no decision here; the relay's
        // armed timeout keeps ADR-0008 deny-by-default.
        return;
      }
      // Ticket 30 expired-answer fence: the ticket must still be pending in
      // the core before an answer routes anywhere. An answer for a ticket
      // the relay already resolved (timeout deny) or dropped surfaces the
      // honest expired copy and resolves nothing (not even a no-op resolve
      // that could land on a newer ask of the same worker).
      const stillPending = options
        .listPending()
        .some((live) => live.requestId === ticket.requestId);
      if (!stillPending) {
        options.notifyExpired?.(ticket);
        return;
      }
      if (
        choice === "always-allow" &&
        !isWildcardAccessTarget(ticket.body.target)
      ) {
        // Record the session-scope row first, then route this ask's allow —
        // identical decision to plain Allow, plus the remembered row.
        // Wildcard fence (ticket 30): the option set above never offers
        // "Always allow" for a metacharacter target, and a constructed (or
        // queued) always-shaped answer for one is NOT forwarded to the row
        // insert — it degrades to this ask's plain one-shot allow, so no
        // class-wildcard session row can ever be created.
        options.alwaysAllow?.(ticket);
      }
      const allowed =
        choice === "allow" || choice === "always-allow"
          ? options.resolve(ticket.workerId, { kind: "allow" })
          : options.resolve(ticket.workerId, {
              kind: "deny",
              reason: "user-denied",
              detail: ACCESS_PROMPT_DENY_DETAIL,
            });
      if (!allowed) {
        options.notifyExpired?.(ticket);
      } else if (
        (choice === "allow" || choice === "always-allow") &&
        ticket.body.class === "credential"
      ) {
        options.notifySecretStored?.(ticket);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        // Abandoned by reset()/prune (deactivation or the ticket resolving
        // elsewhere): nothing to present, nothing to re-queue.
        return;
      }
      // Prompt surface failed for this ask: release it to the shipped
      // conversational relay instead. The armed timeout still bounds it.
      released.add(ticket.requestId);
      options.requeueConversational?.(ticket);
      // Surface nothing — a seam failure must never break the host.
      void error;
    } finally {
      dropState(ticket.requestId);
    }
  }

  return {
    sync(): void {
      if (seam === undefined) return;
      const pending = options.listPending();
      const live = new Set(pending.map((ticket) => ticket.requestId));
      // Prune state for tickets that resolved, cleared, or timed out while
      // their prompt was outstanding — abort the dead seam request too.
      for (const [requestId, entry] of [...outstanding]) {
        if (live.has(requestId)) continue;
        entry.controller.abort();
        dropState(requestId);
      }
      if (!options.isActive()) return;
      for (const ticket of pending) {
        if (outstanding.has(ticket.requestId)) continue;
        if (released.has(ticket.requestId)) continue;
        const controller = new AbortController();
        outstanding.set(ticket.requestId, { ticket, controller });
        void askOne(ticket, controller);
      }
    },

    isPrompted(requestId: string): boolean {
      return outstanding.has(requestId);
    },

    suppressesConversational(requestId: string): boolean {
      return (
        seam !== undefined && options.isActive() && !released.has(requestId)
      );
    },

    reset(): void {
      for (const entry of outstanding.values()) {
        entry.controller.abort();
      }
      outstanding.clear();
    },
  };
}
