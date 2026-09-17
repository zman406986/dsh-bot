/**
 * Per-tool call view components (ticket 24).
 *
 * Presentation only, like the roster panel: views parse their props through
 * `describeToolview` (pure, never throws) and render a compact detail row —
 * worker id, title, outcome, steer text, or the check roster's status rows
 * with the core FSM vocabulary verbatim. No actions, no fetches, no authority
 * (design-16 §3.4).
 *
 * Zero-hook function components created through a factory so the translate
 * seat and tool name are captured at registration time; the renderer
 * controls the props face, which the parser treats defensively. Rendering is
 * covered by build success + typecheck only (S8: no DOM harness).
 */
import type { JSX } from "react";
import type { TranslateFn } from "./overlay.js";
import {
  TOOLVIEW_DEGRADED_KEY,
  describeToolview,
} from "./toolviews.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
const VIEW_CLASS = "multitask-dispatcher-toolview";

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
        {view.kind === "degraded" ? (
          <span className={`${VIEW_CLASS}__degraded`}>
            {t(TOOLVIEW_DEGRADED_KEY)}
          </span>
        ) : (
          <>
            {view.fields.map((field) => (
              <span
                key={field.labelKey}
                className={`${VIEW_CLASS}__field`}
                data-field={field.labelKey}
              >
                <span className={`${VIEW_CLASS}__field-label`}>
                  {t(field.labelKey)}
                </span>
                <span className={`${VIEW_CLASS}__field-value`}>
                  {field.value}
                </span>
              </span>
            ))}
            {view.statusRows.length > 0 ? (
              <ul className={`${VIEW_CLASS}__rows`}>
                {view.statusRows.map((row, index) => (
                  <li
                    key={`${row.workerId}-${index}`}
                    className={`${VIEW_CLASS}__row`}
                    data-status={row.statusLabel ?? undefined}
                  >
                    <span className={`${VIEW_CLASS}__row-id`}>
                      {row.workerId}
                    </span>
                    <span className={`${VIEW_CLASS}__row-title`}>
                      {row.title}
                    </span>
                    {row.statusLabel !== null ? (
                      <span className={`${VIEW_CLASS}__row-status`}>
                        {row.statusLabel}
                      </span>
                    ) : null}
                    {row.activity !== null ? (
                      <span className={`${VIEW_CLASS}__row-activity`}>
                        {row.activity}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    );
  };
}
