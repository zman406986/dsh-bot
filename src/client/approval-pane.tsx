/**
 * Approval-card components (ticket 81, ADR-0020 slice 5): the wrapper's
 * inline rendering of the ticket-69 chunk-B projections — access-ask /
 * secret-ask cards (the "Needs you" area of the conversation surface,
 * re-hosting ticket 30's prompt anatomy) and the presentation-time
 * worker-dispatch cards that ride the conversation's own spawn records.
 *
 * Presentation only: a card renders what the projection carries — relay
 * truth and the tool-call record — and acts only through the injected
 * resolve seat. The seat is the composition's to wire (the live transport
 * into `Multitask.resolveAccess` is ticket 69's L1 lane); without a seat a
 * pending card says so honestly instead of offering dead buttons. There is
 * deliberately no retry affordance on a failed submit — one honest line,
 * nothing was changed (ADR-0018 U-A) — and no success fanfare: a routed
 * answer shows only the muted submitted line and the card settles when the
 * feed delivers the relay's decision.
 *
 * Ticket 30's copy is REUSED, not re-keyed: the option labels, the clamped
 * detail with its omission marker, the location line (resolved per card
 * through the 71 AC-4 `locationFor` hook — never hard-coded here), the
 * expired copy, and the secret-stored reassurance all arrive as projected
 * strings and render verbatim. Decision provenance renders from the shipped
 * `AccessDecision.reason` labels verbatim (core vocabulary, the roster's
 * rule) — a posture deny therefore reads "policy-denied" with the
 * self-naming auto-review detail, exactly as chunk A emitted it.
 *
 * Honest states: the section renders NOTHING while its store is `unfed` (no
 * feed is wired — unknown is not "nothing needs you") and renders nothing
 * over a ready-but-empty feed (the roster's empty-section rule). Secrets:
 * names only — a secret-ask card names the credential and carries the
 * never-shown promise; no value can exist on any shape (access-types hard
 * rule).
 *
 * Styles follow the shell's contract (ticket 49): namespaced classes, every
 * colour a host `--dsw-alias-*` token, opacity-based hierarchy, no
 * animation, no text colour beyond the state tokens.
 */
import { useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { TranslateFn } from "./overlay.js";
import { formatTemplate, rosterBlockedKey } from "./roster-store.js";
import type {
  AccessAskCard,
  AccessAskOptionChoice,
  ApprovalCardsStore,
  WorkerDispatchCard,
} from "./approval-cards.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
export const APPROVAL_CARD_CLASS = "multitask-dispatcher-approval";

/**
 * Card styles (ticket 81). Tokens referenced — all already evidenced by our
 * shipped surfaces: `border-l3` (hairlines, settled cards, the dispatch
 * card), `label-tertiary` (muted field labels), `interactive-bg-hover`
 * (action buttons, the capsule's own button vocabulary),
 * `state-warn-primary` (a pending card's border — the blocked-marker role),
 * `state-error-primary` (failed submit lines).
 */
export const APPROVAL_CARD_CSS = `
.${APPROVAL_CARD_CLASS}{display:flex;flex-direction:column;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l3)}
.${APPROVAL_CARD_CLASS}__heading{font-weight:600;opacity:.75;font-size:12px}
.${APPROVAL_CARD_CLASS}__list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.${APPROVAL_CARD_CLASS}__card{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;min-width:0}
.${APPROVAL_CARD_CLASS}__card[data-settled="true"]{border-color:var(--dsw-alias-border-l3);opacity:.7}
.${APPROVAL_CARD_CLASS}__title{font-weight:600;overflow-wrap:anywhere}
.${APPROVAL_CARD_CLASS}__worker{font-weight:400;opacity:.55;font-size:11px}
.${APPROVAL_CARD_CLASS}__phrase{overflow-wrap:anywhere}
.${APPROVAL_CARD_CLASS}__detail{opacity:.7;white-space:pre-wrap;overflow-wrap:anywhere}
.${APPROVAL_CARD_CLASS}__field{display:flex;gap:6px;min-width:0}
.${APPROVAL_CARD_CLASS}__field-label{flex:none;color:var(--dsw-alias-label-tertiary)}
.${APPROVAL_CARD_CLASS}__field-value{overflow-wrap:anywhere}
.${APPROVAL_CARD_CLASS}__line{opacity:.55;font-size:11px}
.${APPROVAL_CARD_CLASS}__status{font-size:11px;opacity:.75;overflow-wrap:anywhere}
.${APPROVAL_CARD_CLASS}__status[data-tone="error"]{opacity:1;color:var(--dsw-alias-state-error-primary)}
.${APPROVAL_CARD_CLASS}__actions{display:flex;gap:6px;flex-wrap:wrap}
.${APPROVAL_CARD_CLASS}__action{padding:2px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover);color:inherit;font:inherit;font-size:12px;cursor:pointer}
.${APPROVAL_CARD_CLASS}__dispatch{display:flex;flex-direction:column;gap:2px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;font-size:12px;min-width:0}
.${APPROVAL_CARD_CLASS}__dispatch-title{font-weight:600;overflow-wrap:anywhere}
`;

/** Locale keys for the cards' own chrome (ticket 30 copy rides projections). */
export const APPROVAL_CARD_KEYS = {
  target: "shell.approval.target",
  secretPromise: "shell.approval.secret-promise",
  unavailable: "shell.approval.unavailable",
  noChannel: "shell.approval.no-channel",
  failed: "shell.approval.failed",
  submitted: "shell.approval.submitted",
  gating: "shell.dispatch.gating",
} as const;

/** The resolve seat: the composition's transport into the relay (L1 wires it). */
export type ApprovalResolveOutcome =
  | { readonly kind: "routed" }
  | { readonly kind: "no-channel" }
  | { readonly kind: "failed" };

export interface ApprovalCardActions {
  readonly onResolve: (
    requestId: string,
    choice: AccessAskOptionChoice,
  ) => Promise<ApprovalResolveOutcome>;
}

/** What the conversation pane mounts: the fed-or-unfed card store + seat. */
export interface ApprovalCardsSeat {
  readonly cards: ApprovalCardsStore;
  readonly actions?: ApprovalCardActions;
}

/**
 * The card title: ticket 30's ask phrase via the SHARED roster blocked
 * vocabulary (the same template the sidebar row and panel marker use — one
 * copy vocabulary, never a second), names only.
 */
export function accessAskCardTitle(t: TranslateFn, card: AccessAskCard): string {
  const template = t(rosterBlockedKey(card.body.class));
  const safe =
    template === rosterBlockedKey(card.body.class)
      ? t("roster.blocked.other")
      : template;
  return formatTemplate(safe, { target: card.body.target });
}

/** Localize a settled decision's one-line provenance (verbatim vocabulary). */
export function decisionStatusLabel(card: AccessAskCard): string | null {
  const decision = card.decision;
  if (card.status === "pending" || decision === undefined) return null;
  return decision.kind === "allow" ? "allow" : decision.reason;
}

/** The decision's detail text (expired copy / self-naming deny / allow note). */
export function decisionDetailText(card: AccessAskCard): string | null {
  const decision = card.decision;
  if (card.status === "pending" || decision === undefined) return null;
  if (decision.kind === "allow") return decision.note ?? null;
  return decision.detail;
}

/**
 * One access-ask / secret-ask card. Submit outcomes are component state
 * (the composer's discipline): `routed` collapses the actions behind the
 * muted submitted line; `no-channel` / `failed` show the honest line and
 * keep the card — no retry control (U-A). Without a seat the pending card
 * carries the honest unavailable line instead of dead buttons.
 */
function AccessAskCardView(props: {
  t: TranslateFn;
  card: AccessAskCard;
  actions: ApprovalCardActions | undefined;
}): JSX.Element {
  const { t, card, actions } = props;
  const [outcome, setOutcome] = useState<ApprovalResolveOutcome | null>(null);
  const settled = card.status !== "pending";
  const decision = card.decision;

  const submit = (choice: AccessAskOptionChoice): void => {
    if (actions === undefined || outcome !== null) return;
    void actions.onResolve(card.requestId, choice).then(setOutcome);
  };

  return (
    <li
      className={`${APPROVAL_CARD_CLASS}__card`}
      data-card-kind={card.cardKind}
      data-status={card.status}
      data-settled={settled ? "true" : "false"}
      data-request-id={card.requestId.length > 0 ? card.requestId : undefined}
    >
      <span className={`${APPROVAL_CARD_CLASS}__title`}>
        {card.workerTitle}{" "}
        <span className={`${APPROVAL_CARD_CLASS}__worker`}>
          {card.workerId}
        </span>
      </span>
      <span className={`${APPROVAL_CARD_CLASS}__phrase`}>
        {accessAskCardTitle(t, card)}
      </span>
      {card.cardKind === "secret-ask" && card.body.credentialName ? (
        <span className={`${APPROVAL_CARD_CLASS}__field`} data-field="target">
          <span className={`${APPROVAL_CARD_CLASS}__field-label`}>
            {t(APPROVAL_CARD_KEYS.target)}
          </span>
          <span className={`${APPROVAL_CARD_CLASS}__field-value`}>
            {card.body.credentialName}
          </span>
        </span>
      ) : null}
      {card.detail.length > 0 ? (
        <span className={`${APPROVAL_CARD_CLASS}__detail`}>{card.detail}</span>
      ) : null}
      <span className={`${APPROVAL_CARD_CLASS}__line`}>{card.locationLine}</span>
      {card.cardKind === "secret-ask" ? (
        <span className={`${APPROVAL_CARD_CLASS}__line`}>
          {t(APPROVAL_CARD_KEYS.secretPromise)}
        </span>
      ) : null}
      {settled && decision !== undefined ? (
        <span className={`${APPROVAL_CARD_CLASS}__status`} data-tone="settled">
          {[
            decisionStatusLabel(card),
            decisionDetailText(card),
          ]
            .filter((part) => part !== null)
            .join(" — ")}
        </span>
      ) : null}
      {!settled ? (
        actions !== undefined ? (
          outcome === null ? (
            <span className={`${APPROVAL_CARD_CLASS}__actions`}>
              {card.optionSet.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  className={`${APPROVAL_CARD_CLASS}__action`}
                  data-choice={option.kind}
                  disabled={card.requestId.length === 0}
                  onClick={() => submit(option.kind)}
                >
                  {option.label}
                </button>
              ))}
            </span>
          ) : (
            <span className={`${APPROVAL_CARD_CLASS}__status`}>
              {t(
                outcome.kind === "routed"
                  ? APPROVAL_CARD_KEYS.submitted
                  : outcome.kind === "no-channel"
                    ? APPROVAL_CARD_KEYS.noChannel
                    : APPROVAL_CARD_KEYS.failed,
              )}
            </span>
          )
        ) : (
          <span className={`${APPROVAL_CARD_CLASS}__status`} data-tone="error">
            {t(APPROVAL_CARD_KEYS.unavailable)}
          </span>
        )
      ) : null}
    </li>
  );
}

/**
 * One presentation-time worker-dispatch card (ticket 69 §3.2 / §4, C15
 * holds): re-hosted from the conversation's own spawn record — no relay, no
 * wake, no ledger entry. Field labels reuse the toolview vocabulary; the
 * gating value renders verbatim (the projection's frozen vocabulary).
 */
export function DispatchCardView(props: {
  t: TranslateFn;
  card: WorkerDispatchCard;
}): JSX.Element {
  const { t, card } = props;
  const outcome =
    card.outcome.kind === "spawned"
      ? card.outcome.workerId
      : `refused: ${card.outcome.reason}`;
  return (
    <div
      className={`${APPROVAL_CARD_CLASS}__dispatch`}
      data-card-kind={card.cardKind}
      data-gating={card.gating}
      data-tool-call-id={card.toolCallId}
    >
      <span className={`${APPROVAL_CARD_CLASS}__dispatch-title`}>
        {card.title ?? card.toolCallId}
      </span>
      {card.streamKey !== null ? (
        <span className={`${APPROVAL_CARD_CLASS}__field`} data-field="stream">
          <span className={`${APPROVAL_CARD_CLASS}__field-label`}>
            {t("toolview.field.stream")}
          </span>
          <span className={`${APPROVAL_CARD_CLASS}__field-value`}>
            {card.streamKey}
          </span>
        </span>
      ) : null}
      <span className={`${APPROVAL_CARD_CLASS}__field`} data-field="outcome">
        <span className={`${APPROVAL_CARD_CLASS}__field-label`}>
          {t("toolview.field.outcome")}
        </span>
        <span className={`${APPROVAL_CARD_CLASS}__field-value`}>{outcome}</span>
      </span>
      <span className={`${APPROVAL_CARD_CLASS}__field`} data-field="gating">
        <span className={`${APPROVAL_CARD_CLASS}__field-label`}>
          {t(APPROVAL_CARD_KEYS.gating)}
        </span>
        <span className={`${APPROVAL_CARD_CLASS}__field-value`}>
          {card.gating}
        </span>
      </span>
    </div>
  );
}

/**
 * The conversation surface's "Needs you" area: the pending (and honestly
 * settled) access-ask cards. Renders NOTHING while no feed is wired
 * (`unfed` — unknown is not "nothing needs you") and nothing over a
 * ready-but-empty feed (the roster's empty-section rule). The heading
 * reuses the roster's "Needs you" key — one copy vocabulary.
 */
export function createApprovalCardsSection(
  t: TranslateFn,
  seat: ApprovalCardsSeat,
): () => JSX.Element | null {
  return () => {
    const box = useSyncExternalStore(seat.cards.subscribe, seat.cards.getBox);
    if (box.state.kind !== "ready") return null;
    if (box.state.cards.length === 0) return null;
    return (
      <section className={APPROVAL_CARD_CLASS} data-pane="approval-cards">
        <style>{APPROVAL_CARD_CSS}</style>
        <div className={`${APPROVAL_CARD_CLASS}__heading`}>
          {t("roster.section.needs-you")}
        </div>
        <ul className={`${APPROVAL_CARD_CLASS}__list`}>
          {box.state.cards.map((card) => (
            <AccessAskCardView
              key={`${card.status}:${card.workerId}:${card.requestId}`}
              t={t}
              card={card}
              actions={seat.actions}
            />
          ))}
        </ul>
      </section>
    );
  };
}
