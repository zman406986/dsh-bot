/**
 * Worker-dispatch card component (ticket 81, ADR-0020 slice 5) — the
 * wrapper's inline rendering of the ticket-69 §3.2 projection.
 *
 * Presentation only: a card renders what the projection carries from the
 * conversation's own spawn record and acts on nothing.
 *
 * Readable-status anatomy (the same three levels as every custom tool row):
 * 1. one sentence — `Started "Rewrite auth docs"` or
 *    `Couldn't start "Rewrite auth docs" — that stream key is already in use`;
 * 2. no facts (a card has nothing worth a second line);
 * 3. a nested Details area with the full worker id, stream key and call id.
 *
 * The `ungated` gate value is NEVER shown: there is no review gate any more,
 * so a row repeating `ungated` was noise. The value stays on `data-gating`
 * for the record contract. The tool-call id is never the title.
 *
 * Styles follow the shell's contract (ticket 49): namespaced classes, every
 * colour a host `--dsw-alias-*` token, opacity-based hierarchy, no animation.
 */
import { Fragment, type JSX } from "react";
import type { TranslateFn } from "./overlay.js";
import { APPROVAL_CARD_CLASS, APPROVAL_CARD_CSS } from "./approval-styles.js";
import type { WorkerDispatchCard } from "./dispatch-card.js";
import { refusalCauseKey, TOOLVIEW_DETAIL_KEYS } from "./toolviews.js";
import { SPAWN_WORKER_TOOL } from "../core/policy/prompts.js";
import { formatTemplate, shortRef } from "./status-format.js";

/** Locale keys for the dispatch card's own chrome. */
export const DISPATCH_CARD_KEYS = {
  started: "shell.dispatch.started",
  startedGeneric: "shell.dispatch.started-generic",
  refused: "shell.dispatch.refused",
  refusedGeneric: "shell.dispatch.refused-generic",
  details: "toolview.details",
} as const;

/**
 * The card's visible subject: the title, else the worker's short ref. The
 * call id is deliberately absent — it belongs to details only.
 */
function cardSubject(card: WorkerDispatchCard): string | null {
  if (card.title !== null && card.title.trim().length > 0) {
    return card.title.trim();
  }
  if (card.outcome.kind === "spawned") {
    return shortRef(card.outcome.workerId, "worker");
  }
  return null;
}

/** One presentation-time worker-dispatch card (C15 holds). */
export function DispatchCardView(props: {
  t: TranslateFn;
  card: WorkerDispatchCard;
}): JSX.Element {
  const { t, card } = props;
  const subject = cardSubject(card);
  const titled = subject !== null && subject === card.title?.trim();

  const primary =
    card.outcome.kind === "spawned"
      ? formatTemplate(
          t(
            titled
              ? DISPATCH_CARD_KEYS.started
              : DISPATCH_CARD_KEYS.startedGeneric,
          ),
          titled
            ? { title: subject ?? "" }
            : { subject: subject ?? t("toolview.subject.worker") },
        )
      : formatTemplate(
          t(
            titled
              ? DISPATCH_CARD_KEYS.refused
              : DISPATCH_CARD_KEYS.refusedGeneric,
          ),
          {
            ...(titled ? { title: subject ?? "" } : {}),
            cause: t(
              refusalCauseKey(SPAWN_WORKER_TOOL, card.outcome.reason) ??
                "toolview.cause.failed",
            ),
          },
        );

  const details: Array<readonly [string, string | null]> = [
    [
      TOOLVIEW_DETAIL_KEYS.worker,
      card.outcome.kind === "spawned" ? card.outcome.workerId : null,
    ],
    [TOOLVIEW_DETAIL_KEYS.stream, card.streamKey],
    [TOOLVIEW_DETAIL_KEYS.call, card.toolCallId],
  ];

  return (
    <div
      className={`${APPROVAL_CARD_CLASS}__dispatch`}
      data-card-kind={card.cardKind}
      data-gating={card.gating}
      data-tool-call-id={card.toolCallId}
    >
      <style>{APPROVAL_CARD_CSS}</style>
      <span className={`${APPROVAL_CARD_CLASS}__dispatch-primary`}>
        {primary}
      </span>
      <details className={`${APPROVAL_CARD_CLASS}__dispatch-details`}>
        <summary>{t(DISPATCH_CARD_KEYS.details)}</summary>
        <dl>
          {details.map(([labelKey, value], index) =>
            value === null ? null : (
              <Fragment key={`${labelKey}-${index}`}>
                <dt>{t(labelKey)}</dt>
                <dd>{value}</dd>
              </Fragment>
            ),
          )}
        </dl>
      </details>
    </div>
  );
}
