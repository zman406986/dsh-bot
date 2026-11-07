/**
 * Per-tool call view components (ticket 24; readable-status anatomy).
 *
 * Two exports, one body:
 * - `createToolviewComponent(toolName, t)` — the keyed `tool.call.toolview`
 *   entry the host renders in the shipped chat.
 * - `ToolviewBody` — the same three-level body, re-hosted by the shell's
 *   conversation pane. One body means the two renderers cannot drift.
 *
 * The body is:
 * 1. one primary sentence (localized template, no field label);
 * 2. at most two facts joined by the shared ` · ` separator;
 * 3. a nested `<details><summary>Details</summary><dl>` with full ids,
 *    stream keys, transcript refs, message ids, raw reason codes and times.
 *
 * `check_workers` additionally renders one readable row per worker inside
 * the same body: title first, one localized status word (raw status stays in
 * `data-status`), facts, optional activity line, short ref last.
 *
 * All copy resolves through the `t` seat; this file contains no user-facing
 * sentence and no inline English. Rendering is covered by build + typecheck
 * + the static-markup pins in `test/client-toolviews.test.ts` (S8: no DOM
 * harness).
 */
import { Fragment, type JSX } from "react";
import type { TranslateFn } from "./overlay.js";
import {
  TOOLVIEW_DEGRADED_KEY,
  TOOLVIEW_DETAILS_KEY,
  describeToolview,
  type ToolviewDetail,
  type ToolviewFact,
  type ToolviewStatusRow,
} from "./toolviews.js";
import {
  FACT_SEPARATOR,
  formatCount,
  formatTemplate,
} from "./status-format.js";
import { TOOLVIEW_CLASS as VIEW_CLASS, TOOLVIEW_CSS } from "./toolview-styles.js";

/** Resolve one localized fact through the translate seat. */
function factText(t: TranslateFn, fact: ToolviewFact): string {
  switch (fact.kind) {
    case "text":
      return fact.text;
    case "copy":
      return formatTemplate(t(fact.key), fact.values);
    case "count":
      return formatCount(t, fact.keyBase, fact.count);
  }
}

/**
 * Resolve the primary sentence. A cause (refusal) and a generic subject noun
 * are locale keys, so they are translated here rather than baked into the
 * parser's values.
 */
function primaryText(
  t: TranslateFn,
  view: Extract<ReturnType<typeof describeToolview>, { kind: "detail" }>,
): string {
  const values: Record<string, string> = { ...view.primaryValues };
  if (view.causeKey !== null) values["cause"] = t(view.causeKey);
  if (view.subject === null && view.subjectKey !== null) {
    values["subject"] = t(view.subjectKey);
  }
  return formatTemplate(t(view.primaryKey), values);
}

/** The nested Details area; omitted entirely when there is nothing to show. */
function Details(props: {
  t: TranslateFn;
  details: readonly ToolviewDetail[];
}): JSX.Element | null {
  const { t, details } = props;
  if (details.length === 0) return null;
  return (
    <details className={`${VIEW_CLASS}__details`}>
      <summary>{t(TOOLVIEW_DETAILS_KEY)}</summary>
      <dl>
        {details.map((detail, index) => (
          <Fragment key={`${detail.labelKey}-${index}`}>
            <dt>{t(detail.labelKey)}</dt>
            <dd>{detail.value}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}

/** One `check_workers` row, ordered the readable way. */
function StatusRow(props: {
  t: TranslateFn;
  row: ToolviewStatusRow;
  index: number;
}): JSX.Element {
  const { t, row, index } = props;
  const facts = row.facts.map((fact) => factText(t, fact)).join(FACT_SEPARATOR);
  return (
    <li
      key={`${row.workerId}-${index}`}
      className={`${VIEW_CLASS}__row`}
      data-status={row.statusLabel ?? undefined}
      data-worker-id={row.workerId}
    >
      <span className={`${VIEW_CLASS}__row-title`}>{row.title}</span>
      {row.statusWordKey !== null ? (
        <span className={`${VIEW_CLASS}__row-status`}>
          {t(row.statusWordKey)}
        </span>
      ) : null}
      {facts.length > 0 ? (
        <span className={`${VIEW_CLASS}__row-facts`}>{facts}</span>
      ) : null}
      {row.activity !== null ? (
        <span className={`${VIEW_CLASS}__row-activity`}>{row.activity}</span>
      ) : null}
      {row.title === row.shortRef ? null : (
        <span className={`${VIEW_CLASS}__row-ref`}>{row.shortRef}</span>
      )}
    </li>
  );
}

/**
 * The shared tool-call body. Pure and props-driven: same props in, same
 * element out; no hooks, no store, no actions.
 */
export function ToolviewBody(props: {
  t: TranslateFn;
  view: ReturnType<typeof describeToolview>;
}): JSX.Element {
  const { t, view } = props;
  if (view.kind === "degraded") {
    return (
      <>
        <style>{TOOLVIEW_CSS}</style>
        <span className={`${VIEW_CLASS}__degraded`}>
          {t(TOOLVIEW_DEGRADED_KEY)}
        </span>
      </>
    );
  }

  const facts = view.facts.map((fact) => factText(t, fact)).join(FACT_SEPARATOR);
  return (
    <div className={`${VIEW_CLASS}__body`} data-status={view.state}>
      <style>{TOOLVIEW_CSS}</style>
      <div className={`${VIEW_CLASS}__primary`}>
        {primaryText(t, view)}
      </div>
      {facts.length > 0 ? (
        <div className={`${VIEW_CLASS}__facts`}>{facts}</div>
      ) : null}
      {view.statusRows.length > 0 ? (
        <ul className={`${VIEW_CLASS}__rows`}>
          {view.statusRows.map((row, index) => (
            <StatusRow key={`${row.workerId}-${index}`} t={t} row={row} index={index} />
          ))}
        </ul>
      ) : null}
      <Details t={t} details={view.details} />
    </div>
  );
}

/**
 * Create the toolview component for one wire tool name. Pure and
 * props-driven: same props in, same element out; no hooks, no store.
 */
export function createToolviewComponent(
  toolName: string,
  t: TranslateFn,
): (props: unknown) => JSX.Element {
  return (props: unknown) => {
    const view = describeToolview(toolName, props);
    return (
      <div className={VIEW_CLASS} data-tool={toolName}>
        <ToolviewBody t={t} view={view} />
      </div>
    );
  };
}
