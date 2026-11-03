/**
 * Worker-dispatch card component (ticket 81, ADR-0020 slice 5) — the
 * wrapper's inline rendering of the ticket-69 §3.2 projection.
 *
 * Presentation only: a card renders what the projection carries from the
 * conversation's own spawn record and acts on nothing — no relay, no wake, no
 * ledger entry, no resolve seat (C15 holds). Field labels reuse the toolview
 * vocabulary; the gating value renders verbatim (the projection's frozen
 * vocabulary).
 *
 * This component used to live beside the access-ask card family in
 * `approval-pane.tsx`. Ticket 174 / ADR-0033 removed that family with the
 * worker access-ask feature; the dispatch card has no dependency on it and
 * survives with the ticket-30 copy it always rendered verbatim.
 *
 * Styles follow the shell's contract (ticket 49): namespaced classes, every
 * colour a host `--dsw-alias-*` token, opacity-based hierarchy, no animation,
 * no text colour beyond the state tokens.
 */
import type { JSX } from "react";
import type { TranslateFn } from "./overlay.js";
import { APPROVAL_CARD_CLASS, APPROVAL_CARD_CSS } from "./approval-styles.js";
import type { WorkerDispatchCard } from "./dispatch-card.js";

/** Locale keys for the dispatch card's own chrome. */
export const DISPATCH_CARD_KEYS = {
  gating: "shell.dispatch.gating",
} as const;

/**
 * One presentation-time worker-dispatch card (ticket 69 §3.2 / §4, C15
 * holds): re-hosted from the conversation's own spawn record — no relay, no
 * wake, no ledger entry.
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
      <style>{APPROVAL_CARD_CSS}</style>
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
          {t(DISPATCH_CARD_KEYS.gating)}
        </span>
        <span className={`${APPROVAL_CARD_CLASS}__field-value`}>
          {card.gating}
        </span>
      </span>
    </div>
  );
}
